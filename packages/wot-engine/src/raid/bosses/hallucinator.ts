/**
 * The Hallucinator — the Phase-4 gate boss (raids-v1 §3). A DETERMINISTIC scripted
 * policy (Pillar 9 — no LLM): `hallucinatorPolicy(state) → BossAction` is a pure
 * function of the start-of-tick state. Its false-observation gimmick (phantom
 * readings) lives entirely in the observation layer (raid/observation.ts) — this
 * policy only ever spawns REAL, hashed hazards/adds and strikes the threat target.
 *
 * The telegraph invariant (§2.7): because this is a pure function of `state_t`,
 * the telegraph shown at tick t−1's close equals the action executed at tick t.
 */

import type { Cell, UnitType } from '../../types.ts';
import type { BossAction, RaidState } from '../types.ts';
import { aliveMembers } from '../util.ts';
import type { BossModule } from './registry.ts';

/** Enrage output ramp: 0 before ENRAGE_TICK, then +1 every 5 ticks after. */
export function enrageBonus(state: RaidState): number {
  const t = state.tick;
  const e = state.config.enrageTick;
  return t >= e ? 1 + Math.floor((t - e) / 5) : 0;
}

/** Real-hazard cadence (ticks between spawns) by phase; enrage doubles density. */
function hazardCadence(phase: number): number {
  if (phase <= 0) return 4; // P1 First Sightings
  if (phase === 1) return 3; // P2 The Flood
  if (phase === 2) return 2; // P3 Total Confidence
  return 1; // enrage
}

export function hallucinatorPolicy(state: RaidState): BossAction {
  const cfg = state.config;
  const t = state.tick;
  const phase = state.boss.phase;
  const alive = aliveMembers(state);
  const bonus = enrageBonus(state);

  // Aggro-based retaliation: a telegraphed tank-buster every OTHER tick on the
  // current threat target (set at the previous tick's close) ONLY once it holds
  // threat. Periodic (not every tick) so a tanked squad's Guard sustains between
  // strikes — the coordinated read is "keep the Guard topping the table". Under
  // enrage it ramps and fires every tick.
  const periodic = bonus > 0 || t % 2 === 0;
  const strikeTarget =
    periodic && state.currentTarget && (state.threat[state.currentTarget] ?? 0) > 0
      ? state.currentTarget
      : null;
  const strikeDmg = cfg.bossStrikeDmg + bonus;

  const hazards: BossAction['hazards'] = [];
  const spawnAdds: BossAction['spawnAdds'] = [];

  if (alive.length > 0) {
    // A real hazard aimed at a rotating alive member's cell, detonating in 2 ticks.
    const cadence = hazardCadence(phase);
    if (t > 0 && t % cadence === 0) {
      const idx = Math.floor(t / cadence) % alive.length;
      const u = alive[idx];
      hazards.push({ readingId: `hz_${t}`, cells: [[u.x, u.y] as Cell], detonateTick: t + 2, targetMember: u.memberId });
    }

    // P3 "conviction strike" every 5 ticks: a multi-cell pattern over the alive
    // squad's current cells, ignoring threat (hits by position), detonating in 2.
    if (phase >= 2 && t > 0 && t % 5 === 0) {
      const cells = alive.map((u) => [u.x, u.y] as Cell);
      hazards.push({ readingId: `cv_${t}`, cells, detonateTick: t + 2 });
    }

    // P2+ real adds: a single scout-statline mob on a flank, capped low, so the
    // squad has something to peel to — but the signature P2 trap is the PHANTOM
    // adds (observation-layer, raid/observation.ts), which lure naive whiffs.
    if (phase >= 1 && t > 0 && t % 12 === 0 && state.adds.length < 1) {
      const type: UnitType = 'scout';
      spawnAdds.push({ addId: `add_${t}`, type, cell: [7, 6] as Cell });
    }
  }

  return { bodyMove: null, strikeTarget, strikeDmg, hazards, spawnAdds };
}

export const hallucinatorModule: BossModule = {
  descriptor: {
    boss_id: 'the_hallucinator',
    failure_mode_id: 'false-information',
    name: 'The Hallucinator',
    title: 'The Confident Liar',
    failure_mode: 'seeds false observations (phantom hazards/adds) into the squad fog',
    robust_pattern: 'corroboration: believe a reading only when cross-verified (seen_by ≥ ⌈2/3·alive⌉)',
    lesson: 'Pool readings across the squad; keep a reading iff seen_by ≥ ⌈2/3·alive⌉, dodge those, ignore the rest.',
    channels: ['corrupted_observation'],
    squad_size: { min: 3, max: 5 },
    recommended_league: 'core',
    phases: [
      { phase: 0, name: 'First Sightings', hp_pct_start: 100, summary: 'Corroboration read at low lethality.' },
      { phase: 1, name: 'The Flood', hp_pct_start: 66, summary: 'Hazard cadence doubles; real + phantom adds.' },
      { phase: 2, name: 'Total Confidence', hp_pct_start: 33, summary: 'Conviction strikes; bait phantoms at REAL_MIN−1.' },
      { phase: 3, name: 'Collapse', summary: 'Fog-Collapse enrage + output ramp.' },
    ],
    mechanics:
      'Cross-check readings across the shared squad: keep a reading iff seen_by ≥ ceil(2/3·alive). Dodge kept hazards, ignore the rest; tank with a Guard and revive the downed.',
    deterministic: true,
    sigil_seed: 'the_hallucinator',
  },
  policy: hallucinatorPolicy,
  // The phantom projection IS this boss's corrupted-observation channel; it lives
  // in observation.ts `readingsFor` (byte-for-byte preserved), so no overlay hook.
};
