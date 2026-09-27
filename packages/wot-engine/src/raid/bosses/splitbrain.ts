/**
 * Split-Brain (failure-modes-pillar.md §5) — a network PARTITION → conflicting
 * primary writes. During scripted windows the squad splits into a strict-majority
 * A / minority B whose `squad` views are filtered to their own group; the boss
 * bares a contended CORE cell. If exactly ONE group drives the core the write
 * lands clean (heavy hit); if BOTH do, their writes conflict → the boss heals +
 * an AoE lashes both groups. The robust pattern: pick a primary by a pre-agreed
 * rule (majority-primary), the minority holds, reconcile cleanly.
 *
 * DETERMINISM DISCIPLINE (§5.6): `partition(seed, window, member)` and the
 * cross-group observation-hiding are PURE PROJECTION — the full unit/boss state
 * stays whole and hashed; the partition only filters what each member SEES.
 * Clean-write / split-brain detection + the penalty are computed in
 * `applyChannelMechanics` from REAL attacks by real members whose real group is
 * `partition(seed,window,·)` — honest, hashed consequences. No split byte reaches
 * `canonicalizeRaid`; replays re-sim bit-for-bit.
 */

import { hash32 } from '../../rng.ts';
import { SPLITBRAIN_DIALS } from '../constants.ts';
import type { Cell } from '../../types.ts';
import type { BossAction, MemberId, RaidState } from '../types.ts';
import { aliveMembers } from '../util.ts';
import { enrageBonus } from './hallucinator.ts';
import { key } from '../../board.ts';
import type { BossModule, ChannelCtx, ChannelOutcome, ObservationProjection } from './registry.ts';

/** The active partition window for a tick, or null (windows are pure of `tick`). */
export function partitionWindow(tick: number): { index: number; open: number; close: number } | null {
  for (let i = 0; i < SPLITBRAIN_DIALS.windows.length; i++) {
    const [open, close] = SPLITBRAIN_DIALS.windows[i];
    if (tick >= open && tick < close) return { index: i, open, close };
  }
  return null;
}

/**
 * The partition group of `member` during window `windowIndex` — a strict majority
 * A (first ⌈n/2⌉ by a seeded rank) and minority B. Pure over `(seed, window, salt)`.
 * `salt` shifts membership WITHOUT touching state/actions (projection-out-of-hash).
 */
export function partitionGroup(
  seed: number,
  windowIndex: number,
  alive: MemberId[],
  member: MemberId,
  salt = 0,
): 'A' | 'B' {
  const ranked = [...alive].sort((a, b) => {
    const ha = hash32(`${seed}:part:${windowIndex}:${salt}:${a}`);
    const hb = hash32(`${seed}:part:${windowIndex}:${salt}:${b}`);
    return ha - hb || (a < b ? -1 : 1);
  });
  const majority = Math.ceil(ranked.length / 2);
  return ranked.indexOf(member) < majority ? 'A' : 'B';
}

/** The telegraphed exposed core cell this tick (a rotating boss body cell). */
export function coreCell(state: RaidState): Cell {
  const fp = [...state.boss.footprint].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return fp[hash32(`${state.seed}:core:${state.tick}`) % fp.length];
}

function splitBrainProjection(state: RaidState, memberId: MemberId, salt: number): ObservationProjection | null {
  const win = partitionWindow(state.tick);
  if (!win) return { partition: null };
  const alive = aliveMembers(state).map((u) => u.memberId);
  if (!alive.includes(memberId)) return { partition: null };
  const myGroup = partitionGroup(state.seed, win.index, alive, memberId, salt);
  const groupMembers = alive.filter((m) => partitionGroup(state.seed, win.index, alive, m, salt) === myGroup);
  const isPrimary = groupMembers.length > alive.length / 2;
  // Cross-group hiding: the other group's POSITIONS are absent from my frame.
  const hidden = alive.filter((m) => !groupMembers.includes(m) && m !== memberId);
  return {
    partition: {
      group: myGroup,
      group_size: groupMembers.length,
      is_primary: isPrimary,
      window_ends_on_turn: win.close,
      core_cell: coreCell(state),
    },
    hiddenMembers: hidden,
  };
}

/** Boss policy: a periodic strike on the threat target (pressure between writes). */
export function splitBrainPolicy(state: RaidState): BossAction {
  const cfg = state.config;
  const bonus = enrageBonus(state);
  const periodic = bonus > 0 || state.tick % 2 === 0;
  const strikeTarget =
    periodic && state.currentTarget && (state.threat[state.currentTarget] ?? 0) > 0 ? state.currentTarget : null;
  return { bodyMove: null, strikeTarget, strikeDmg: cfg.bossStrikeDmg + bonus, hazards: [], spawnAdds: [] };
}

/** During a window, the exposed core cell is RESERVED (its hits drive the write). */
function splitBrainReserved(state: RaidState): Set<string> {
  if (!partitionWindow(state.tick)) return new Set();
  const c = coreCell(state);
  return new Set([key(c[0], c[1])]);
}

/** Clean-write / split-brain detection over REAL core hits grouped by partition. */
export function splitBrainChannelMechanics(ctx: ChannelCtx): ChannelOutcome {
  const s = ctx.state;
  const win = partitionWindow(s.tick);
  if (!win || ctx.channelAttacks.length === 0) return {};
  const alive = aliveMembers(s).map((u) => u.memberId);
  const groups = new Set(
    ctx.channelAttacks.map((a) => partitionGroup(s.seed, win.index, alive, a.memberId)),
  );
  if (groups.size === 1) {
    // Exactly one group wrote → the write lands clean.
    ctx.emit('primary_write', { group: [...groups][0], clean: true, tick: s.tick });
    return { bossExtraDamage: SPLITBRAIN_DIALS.coreDamage };
  }
  // Both groups wrote → conflicting writes: the boss heals + an AoE lashes everyone.
  ctx.emit('split_brain_penalty', { heal: SPLITBRAIN_DIALS.splitBrainHeal, tick: s.tick });
  const unitDamage = aliveMembers(s).map((u) => ({ unitId: u.unitId, amount: SPLITBRAIN_DIALS.aoe }));
  return { bossHeal: SPLITBRAIN_DIALS.splitBrainHeal, unitDamage };
}

export const splitBrainModule: BossModule = {
  descriptor: {
    boss_id: 'split_brain',
    failure_mode_id: 'network-partition',
    name: 'Split-Brain',
    title: 'The Severed Quorum',
    failure_mode: 'a mid-fight network partition cuts the squad in two, each half blind to the other; both try to lead (CAP)',
    robust_pattern: 'quorum/primary discipline: the majority acts as primary, the minority holds read-only, reconcile cleanly',
    lesson: 'When partitioned, count your visible group: majority drives the core (clean write), minority holds; never let both groups write.',
    channels: ['partition'],
    squad_size: { min: 3, max: 5 },
    recommended_league: 'core',
    phases: [
      { phase: 0, name: 'Whole', hp_pct_start: 100, summary: 'Undivided; learn the core.' },
      { phase: 1, name: 'First Cut', hp_pct_start: 66, summary: 'Partition window — pick a primary.' },
      { phase: 2, name: 'Severed', hp_pct_start: 33, summary: 'Second window; both-write is fatal.' },
      { phase: 3, name: 'Collapse', summary: 'Fog-Collapse enrage + strike ramp.' },
    ],
    mechanics:
      'Scripted partition windows split the squad into a strict-majority A / minority B that cannot see each other. The boss bares a contended core cell: one group hitting it is a clean write (heavy hit); both groups hitting it is split-brain (the boss heals + AoE). Majority is primary; the minority holds.',
    deterministic: true,
    sigil_seed: 'split_brain',
  },
  policy: splitBrainPolicy,
  projectObservation: splitBrainProjection,
  reservedCells: splitBrainReserved,
  applyChannelMechanics: splitBrainChannelMechanics,
};
