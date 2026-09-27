/**
 * Deadlock (failure-modes-pillar.md §4) — greedy resource acquisition → circular
 * wait. K=3 ranked lock nodes; the seal's damage window opens only while locks
 * `1..M` are held in ASCENDING rank (M rises per phase). Stepping onto a lock out
 * of order (rank r held while some rank < r is unheld) WARDS: the boss heals and
 * the offender is chipped; an out-of-order hold that persists ≥ D ticks registers
 * a DEADLOCK (extra heal). The escape is textbook: acquire in a global order, and
 * yield a lock grabbed out of turn.
 *
 * DETERMINISM DISCIPLINE (§4.6): this is the LOCK-STRUCTURE channel — everything
 * is honest, hashed mechanics (lock cells are seed-fixed fixtures; holds are real
 * positions; wards/heals/seal-drain are pure functions of real state). The only
 * cross-tick memory is the out-of-order hold age, kept in the hashed
 * `channel.lockOutOfOrderAge`. There is NO projection to keep out of the hash.
 */

import { cheb } from '../../board.ts';
import { DEADLOCK_DIALS, DEADLOCK_LOCKS } from '../constants.ts';
import type { BossAction, MemberId, RaidState } from '../types.ts';
import { aliveMembers } from '../util.ts';
import { enrageBonus } from './hallucinator.ts';
import type { BossModule, ChannelCtx, ChannelOutcome, ObservationProjection } from './registry.ts';

/** Locks in ascending rank (seed-fixed fixtures). */
export const deadlockLocks = (): { rank: number; cell: [number, number] }[] =>
  [...DEADLOCK_LOCKS].sort((a, b) => a.rank - b.rank).map((l) => ({ rank: l.rank, cell: [l.cell[0], l.cell[1]] }));

/** Locks required open (held ascending) by phase — P1..enrage. */
export const locksRequired = (phase: number): number =>
  DEADLOCK_DIALS.mPerPhase[Math.min(phase, DEADLOCK_DIALS.mPerPhase.length - 1)];

/** rank → the alive member standing on that lock's cell (the unique holder), or null. */
export function lockHolds(state: RaidState): Map<number, MemberId | null> {
  const holds = new Map<number, MemberId | null>();
  const alive = aliveMembers(state);
  for (const lock of deadlockLocks()) {
    const holder = alive.find((u) => u.x === lock.cell[0] && u.y === lock.cell[1]);
    holds.set(lock.rank, holder ? holder.memberId : null);
  }
  return holds;
}

/** The lowest unheld rank — the next lock to acquire in order (null when all held). */
export function nextLockRank(holds: Map<number, MemberId | null>): number | null {
  for (const lock of deadlockLocks()) if (!holds.get(lock.rank)) return lock.rank;
  return null;
}

/** The public lock structure (derivable from ranks + holds → projection or hashed). */
function deadlockProjection(state: RaidState): ObservationProjection {
  const holds = lockHolds(state);
  return {
    locks: deadlockLocks().map((l) => ({ rank: l.rank, cell: [l.cell[0], l.cell[1]], held_by: holds.get(l.rank) ?? null })),
    nextLockRank: nextLockRank(holds),
  };
}

/** Boss policy: a periodic strike on the threat target (pressure while sealed). */
export function deadlockPolicy(state: RaidState): BossAction {
  const cfg = state.config;
  const bonus = enrageBonus(state);
  const periodic = bonus > 0 || state.tick % 2 === 0;
  const strikeTarget =
    periodic && state.currentTarget && (state.threat[state.currentTarget] ?? 0) > 0 ? state.currentTarget : null;
  return { bodyMove: null, strikeTarget, strikeDmg: cfg.bossStrikeDmg + bonus, hazards: [], spawnAdds: [] };
}

/** Ward / deadlock / seal-drain mechanic, all pure over real post-move holds. */
export function deadlockChannelMechanics(ctx: ChannelCtx): ChannelOutcome {
  const s = ctx.state;
  const holds = lockHolds(s);
  const held = new Set([...holds.entries()].filter(([, m]) => m).map(([r]) => r));
  const ranks = deadlockLocks().map((l) => l.rank);
  const ages = s.channel.lockOutOfOrderAge;

  let bossHeal = 0;
  const unitDamage: { unitId: string; amount: number }[] = [];
  const unitByMember = new Map<MemberId, string>();
  for (const u of aliveMembers(s)) unitByMember.set(u.memberId, u.unitId);

  // Wards: any lock held while a LOWER rank is unheld is out of order.
  for (const r of ranks) {
    const holder = holds.get(r);
    const outOfOrder = !!holder && ranks.some((lo) => lo < r && !held.has(lo));
    if (outOfOrder) {
      bossHeal += DEADLOCK_DIALS.wardHeal;
      const uid = holder ? unitByMember.get(holder) : undefined;
      if (uid) unitDamage.push({ unitId: uid, amount: DEADLOCK_DIALS.wardChip });
      ages[r] = (ages[r] ?? 0) + 1;
      ctx.emit('ward_triggered', { rank: r, by: holder, heal: DEADLOCK_DIALS.wardHeal });
      if (ages[r] >= DEADLOCK_DIALS.persist) {
        bossHeal += DEADLOCK_DIALS.deadlockHeal;
        ctx.emit('deadlock_detected', { rank: r, heal: DEADLOCK_DIALS.deadlockHeal });
      }
    } else {
      ages[r] = 0;
    }
  }

  // Seal window: locks 1..M all held ascending → the seal drains the boss + DPS lands.
  const m = locksRequired(s.boss.phase);
  const windowOpen = ranks.filter((r) => r <= m).every((r) => held.has(r));
  if (windowOpen) {
    ctx.emit('seal_open', { m, tick: s.tick });
    return { bossHeal, bossExtraDamage: DEADLOCK_DIALS.sealDrain, unitDamage };
  }
  // Sealed → the boss mitigates squad damage (only an OPEN window lets DPS through).
  return { bossHeal, unitDamage, bossDamageScale: { num: 1, den: 10 } };
}

export const deadlockModule: BossModule = {
  descriptor: {
    boss_id: 'deadlock',
    failure_mode_id: 'resource-deadlock',
    name: 'Deadlock',
    title: 'The Circular Wait',
    failure_mode: 'greedy resource acquisition with no global order → a circular wait that seizes the whole system',
    robust_pattern: 'lock ordering + yield/back-off: acquire resources in a fixed global order; release a lock grabbed out of turn',
    lesson: 'Seat the locks in ascending rank — flanks (1,2) before the centre (3); never step on a warded lock, and yield one held out of turn.',
    channels: ['lock_structure'],
    squad_size: { min: 3, max: 5 },
    recommended_league: 'core',
    phases: [
      { phase: 0, name: 'First Lock', hp_pct_start: 100, summary: 'Open the seal with rank 1.' },
      { phase: 1, name: 'Two in Order', hp_pct_start: 66, summary: 'Ranks 1→2 ascending; greed wards.' },
      { phase: 2, name: 'Full Ring', hp_pct_start: 33, summary: 'All three in order; a wait-cycle deadlocks.' },
      { phase: 3, name: 'Collapse', summary: 'Fog-Collapse enrage + strike ramp.' },
    ],
    mechanics:
      'Three ranked locks (ranks 1,2 on the flanks, 3 in the centre). Hold locks 1..M in ascending rank to open the seal (it drains the boss); a lock held out of order heals the boss and chips the offender; an out-of-order hold persisting ≥2 ticks deadlocks (extra heal).',
    deterministic: true,
    sigil_seed: 'deadlock',
  },
  policy: deadlockPolicy,
  projectObservation: (state) => deadlockProjection(state),
  applyChannelMechanics: deadlockChannelMechanics,
};
