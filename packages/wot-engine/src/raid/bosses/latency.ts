/**
 * The Latency (failure-modes-pillar.md §12 → shipped) — members act on a board
 * that is k ticks STALE (delayed telemetry): they see where things WERE, not where
 * they ARE. The boss bares a single EXPOSED cell (its weak point) that sweeps
 * deterministically across the bar every tick; only an attack landing on the
 * CURRENT exposed cell damages it (the rest of the bar is plating). A squad that
 * fires at the STALE exposed cell hits inert plating and WHIFFS; a latency-aware
 * squad reads the deterministic telegraph and LEADS — firing at the true current
 * cell — and lands.
 *
 * THE `delay` CHANNEL (projection-only, OUT of the hash; §2.2): each member's
 * `delay` block reports the exposed cell as of `tick − k(phase)` (the stale
 * readout) plus the telegraphed true-current cell to lead to. Both are PURE
 * projection over `(seed, tick, phase, salt)` — never written to `RaidState`,
 * never hashed. `salt` perturbs the projected staleness (a different delay) WITHOUT
 * touching the real live cell used to adjudicate damage — so the stale view is
 * provably out of `canonicalizeRaid`, and `resimulateRaid` re-sims bit-for-bit.
 *
 * The REAL consequence — which hits actually land — is computed in
 * `applyChannelMechanics` from the real post-move attack cells against the real
 * live cell `latencyLiveCell(seed, tick)` (honest, hashed). k GROWS across phases
 * to escalate the lead the squad must carry.
 */

import { key } from '../../board.ts';
import { hash32 } from '../../rng.ts';
import { ROSTER } from '../../constants.ts';
import { LATENCY_DELAY, LATENCY_LIVE_CELLS } from '../constants.ts';
import type { Cell } from '../../types.ts';
import type { BossAction, RaidState } from '../types.ts';
import { enrageBonus } from './hallucinator.ts';
import type { BossModule, ChannelCtx, ChannelOutcome, ObservationProjection } from './registry.ts';

/**
 * The TRUE exposed (vulnerable) cell for a tick — a deterministic period-3 sweep
 * across the boss bar, pure over `(seed, tick)`. It moves EVERY tick, so a stale
 * readout (any k ≥ 1, k ≢ 0 mod 3) never coincides with the current cell. This is
 * the boss's telegraph AND the cell the mechanics award damage on — the single
 * source of truth an aware squad leads to.
 */
export function latencyLiveCell(seed: number, tick: number): Cell {
  const start = hash32(`${seed}:latency:start`) % LATENCY_LIVE_CELLS.length;
  const idx = (start + Math.max(0, tick)) % LATENCY_LIVE_CELLS.length;
  const c = LATENCY_LIVE_CELLS[idx];
  return [c[0], c[1]];
}

/** The staleness (ticks of lag) for a phase; `salt` perturbs it (projection-only). */
export function latencyDelay(phase: number, salt = 0): number {
  const base = LATENCY_DELAY[Math.min(phase, LATENCY_DELAY.length - 1)];
  return base + (salt % 4);
}

/** The STALE exposed cell a member reads — the board as of `tick − k(phase,salt)`. */
export function latencyObservedCell(seed: number, tick: number, phase: number, salt = 0): Cell {
  return latencyLiveCell(seed, Math.max(0, tick - latencyDelay(phase, salt)));
}

/** The `delay` projection: the stale readout + the telegraphed current cell to lead. */
function latencyProjection(state: RaidState, _memberId: string, salt: number): ObservationProjection {
  const phase = state.boss.phase;
  return {
    delay: {
      ticks_stale: latencyDelay(phase, salt),
      // What the delayed telemetry shows: where the weak point WAS k ticks ago.
      observed_cell: latencyObservedCell(state.seed, state.tick, phase, salt),
      // The deterministic telegraph: where it IS now (lead here, don't chase stale).
      lead_cell: latencyLiveCell(state.seed, state.tick),
    },
  };
}

/** Boss policy: a stationary bar with a periodic strike on the threat target. */
export function latencyPolicy(state: RaidState): BossAction {
  const cfg = state.config;
  const bonus = enrageBonus(state);
  const periodic = bonus > 0 || state.tick % 2 === 0;
  const strikeTarget =
    periodic && state.currentTarget && (state.threat[state.currentTarget] ?? 0) > 0 ? state.currentTarget : null;
  return { bodyMove: null, strikeTarget, strikeDmg: cfg.bossStrikeDmg + bonus, hazards: [], spawnAdds: [] };
}

/** The whole bar is channel-owned: normal boss damage is withheld, hits recorded. */
function latencyReserved(state: RaidState): Set<string> {
  return new Set(state.boss.footprint.map((c) => key(c[0], c[1])));
}

/**
 * Damage window: award damage ONLY to attacks that landed on the REAL current live
 * cell `latencyLiveCell(seed, tick)`. Attacks on the stale/plated cells are
 * absorbed (0). Each landing hit deals its unit's normal damage, so bringing DPS
 * still matters — the discipline being tested is timing (lead), not composition.
 */
export function latencyChannelMechanics(ctx: ChannelCtx): ChannelOutcome {
  const s = ctx.state;
  const live = latencyLiveCell(s.seed, s.tick);
  let dmg = 0;
  let hits = 0;
  for (const a of ctx.channelAttacks) {
    if (a.cell[0] !== live[0] || a.cell[1] !== live[1]) continue;
    const u = s.units.find((x) => x.memberId === a.memberId && !x.downed);
    if (u) {
      dmg += ROSTER[u.type].damage;
      hits += 1;
    }
  }
  ctx.emit('latency_window', { live_cell: live, hits, ticks_stale: latencyDelay(s.boss.phase), tick: s.tick });
  return dmg > 0 ? { bossExtraDamage: dmg } : {};
}

export const latencyModule: BossModule = {
  descriptor: {
    boss_id: 'the_latency',
    failure_mode_id: 'observation-latency',
    name: 'The Latency',
    title: 'The Lagging Signal',
    failure_mode:
      'members act on telemetry that is k ticks stale — they see where the weak point WAS, not where it IS; k grows each phase',
    robust_pattern:
      'delay compensation: read the deterministic telegraph and LEAD (act on the predicted current state); hold when uncertain, never chase stale positions',
    lesson:
      'Do not fire where the board says the weak point is — that readout is k ticks old. Read the telegraph, lead to the true current cell, and land.',
    channels: ['delay'],
    squad_size: { min: 3, max: 5 },
    recommended_league: 'core',
    phases: [
      { phase: 0, name: 'First Lag', hp_pct_start: 100, summary: 'k=1 stale; lead one step to land.' },
      { phase: 1, name: 'Drift', hp_pct_start: 66, summary: 'k grows; the stale cell always misses.' },
      { phase: 2, name: 'Ghost Signal', hp_pct_start: 33, summary: 'Chasing the ghost never damages the boss.' },
      { phase: 3, name: 'Collapse', summary: 'Fog-Collapse enrage + strike ramp.' },
    ],
    mechanics:
      'The boss bares a single exposed cell that sweeps across its bar every tick. Your telemetry of it is k ticks stale (k rises per phase). Only a hit on the TRUE current cell damages the boss; a hit on the stale cell is absorbed. Read the telegraph and lead — do not chase the ghost.',
    deterministic: true,
    sigil_seed: 'the_latency',
  },
  policy: latencyPolicy,
  projectObservation: latencyProjection,
  reservedCells: latencyReserved,
  applyChannelMechanics: latencyChannelMechanics,
};
