/**
 * Raid v1 dials (docs/design/raids-v1.md §3.3, §3.5 — all `[DIAL]`). Values are
 * the Core / 5-squad defaults, tuned so the two golden anchors land: a
 * coordinated squad CLEARS around tick 55–75 and a naive squad WIPES in P2–P3.
 * "B2 tunes to the sim, not to this table" — these are the sim-frozen numbers.
 */

import type { Cell, UnitType } from '../types.ts';
import type { BossId, RaidConfig, SquadSpec } from './types.ts';

/** The three midline cells, repurposed as Lucid Anchors (§2.8). Canonical order. */
export const ANCHORS: { id: 'nexus' | 'relay_w' | 'relay_e'; cell: Cell }[] = [
  { id: 'nexus', cell: [4, 4] },
  { id: 'relay_w', cell: [2, 4] },
  { id: 'relay_e', cell: [6, 4] },
];

/** The boss body: a 3-cell horizontal bar in the north (§2.2). */
export const BOSS_FOOTPRINT: Cell[] = [
  [3, 7],
  [4, 7],
  [5, 7],
];

/** Squad spawn cells on the south edge, m0..m4 (§1). */
export const SQUAD_SPAWNS: Cell[] = [
  [4, 0],
  [2, 0],
  [6, 0],
  [3, 1],
  [5, 1],
];

/** Corroboration super-majority: a REAL reading is seen by ≥ ceil(2/3·alive). */
export const realMin = (squadAlive: number): number => Math.ceil((2 * squadAlive) / 3);

/** Core / 5-squad defaults for The Hallucinator. */
export const HALLUCINATOR_CONFIG: RaidConfig = {
  bossHp: 260,
  hazardDamage: 3,
  bossStrikeDmg: 1,
  threatPerDmg: 1,
  meleePresence: 2,
  tankThreatMult: 4,
  threatDecayNum: 9,
  threatDecayDen: 10,
  reviveCost: 3,
  reviveTicks: 2,
  reviveHp: 8,
  reviveWindow: 6,
  allowance: 240,
  p2HpThreshold: 172, // 66%
  p2TickFloor: 35,
  p3HpThreshold: 86, // 33%
  p3TickFloor: 65,
  enrageTick: 90,
  tickCap: 120,
};

/** The Overfit reuses the whole scaffolding with a lower HP pool (§4). */
export const OVERFIT_CONFIG: RaidConfig = {
  ...HALLUCINATOR_CONFIG,
  bossHp: 300,
};

/**
 * The Byzantine (§3). Three CONSENSUS NODES sit on row 6, each melee-adjacent to
 * a boss body cell, so a quorum ringing the true node also DPSes the boss — the
 * geometry that makes grounding-while-attacking possible (the Lucid-Anchor concept
 * of §3.3, placed to be winnable). Quorum `q = ceil(2n/3)`; faulty `f=floor((n-1)/3)`.
 */
export const BYZANTINE_NODES: { id: 'nexus' | 'relay_w' | 'relay_e'; cell: Cell }[] = [
  { id: 'nexus', cell: [4, 6] },
  { id: 'relay_w', cell: [2, 6] },
  { id: 'relay_e', cell: [6, 6] },
];
/** Byzantine BFT quorum + fault tolerance (pure functions of alive `n`). */
export const bftQuorum = (alive: number): number => Math.ceil((2 * alive) / 3);
export const bftFaultCount = (alive: number): number => Math.floor((alive - 1) / 3);

export const BYZANTINE_CONFIG: RaidConfig = {
  ...HALLUCINATOR_CONFIG,
  bossHp: 280,
  bossStrikeDmg: 3, // ungrounded conviction strike bites (grounded suppresses it)
};
/** Ground-shield mitigation when UNGROUNDED: 9/10 of squad damage is absorbed. */
export const BYZANTINE_SHIELD = { num: 9, den: 10 };

/**
 * Deadlock (§4). K=3 ranked lock nodes on row 6 (melee-adjacent to the boss).
 * Ranks are the trap: the CENTRE lock (nearest every spawn) is the HIGHEST rank,
 * so greedy nearest-grab seats out of order (warded); an ordered squad seats the
 * flanks (ranks 1,2) before the centre (rank 3). Seal drains the boss while
 * locks `1..M` are held ascending; `M` rises per phase.
 */
export const DEADLOCK_LOCKS: { rank: number; cell: Cell }[] = [
  { rank: 1, cell: [2, 6] }, // west flank — seat first
  { rank: 2, cell: [6, 6] }, // east flank — seat second
  { rank: 3, cell: [4, 6] }, // centre (nearest → greedy grabs it first, out of order)
];
export const DEADLOCK_CONFIG: RaidConfig = {
  ...HALLUCINATOR_CONFIG,
  bossHp: 260,
};
export const DEADLOCK_DIALS = {
  wardHeal: 8, // boss heal per out-of-order hold per tick
  deadlockHeal: 12, // extra heal when an out-of-order hold persists ≥ persist ticks
  wardChip: 2, // offender chip on a warded hold
  persist: 2, // ticks an out-of-order hold must last to register a deadlock
  sealDrain: 7, // boss damage per tick while the window (locks 1..M) is open
  mPerPhase: [1, 2, 3, 3] as const, // locks required open, by phase (P1..enrage)
};

/**
 * Split-Brain (§5). Scripted, TICK-based partition windows (stateless, pure of
 * `tick`). During a window the squad splits into a strict-majority A / minority B
 * whose `squad` views are filtered; the boss bares a contended CORE cell.
 */
export const SPLITBRAIN_CONFIG: RaidConfig = {
  ...HALLUCINATOR_CONFIG,
  bossHp: 340, // tuned so quorumPrimarySquad CLEARS + dualPrimarySquad WIPES on a seed sweep
};
export const SPLITBRAIN_DIALS = {
  windows: [
    [20, 30],
    [46, 56],
  ] as const, // [openTick, closeTick) partition windows
  coreDamage: 20, // clean write (one group hits the core) → heavy hit
  splitBrainHeal: 20, // both groups hit the core → boss heals
  aoe: 2, // split-brain self-inflicted AoE on every unit
};

/**
 * The Latency (§12 → shipped). The boss bar bares a single EXPOSED cell that
 * sweeps across the three body columns every tick (a deterministic period-3
 * sweep); members' telemetry of it lags `LATENCY_DELAY[phase]` ticks. Only a hit
 * on the true current cell damages the boss — a hit on the stale cell is absorbed.
 * Stationary bar (no body move), so a fixed melee ring stays in range of every
 * sweep position; the discipline being tested is TIMING (lead), not footwork.
 */
export const LATENCY_LIVE_CELLS: Cell[] = [
  [3, 7],
  [4, 7],
  [5, 7],
];
/** Staleness (ticks of lag) by phase (P1..enrage) — grows to escalate the lead. */
export const LATENCY_DELAY = [1, 2, 2, 2] as const;
export const LATENCY_CONFIG: RaidConfig = {
  ...HALLUCINATOR_CONFIG,
  bossHp: 210, // tuned so leadingSquad CLEARS ~tick 40 + staleReactSquad WIPES on a seed sweep
};

export const RAID_CONFIGS: Record<BossId, RaidConfig> = {
  the_hallucinator: HALLUCINATOR_CONFIG,
  the_overfit: OVERFIT_CONFIG,
  the_byzantine: BYZANTINE_CONFIG,
  deadlock: DEADLOCK_CONFIG,
  split_brain: SPLITBRAIN_CONFIG,
  the_latency: LATENCY_CONFIG,
};

/** Token costs mirror the duel (grid-tactics §4.1) + the co-op revive verb. */
export const COST_MOVE_PER_STEP = 1;
export const COST_ATTACK = 2;
export const COST_REVIVE = 3;
export const COST_HOLD = 0;
export const COST_PING = 0;

/**
 * The reference squad composition used by BOTH golden anchors (§3.4). The
 * consensus and naive runs share this comp so the anchors isolate the ONE
 * variable that matters — coordination — exactly as the gate's regression wants.
 * 1 Guard (threat anchor — the taunt keeps it top of the table) · 2 Lancer
 * (sturdy melee DPS) · 1 Archer (ranged reach) · 1 Scout (eyes + peel reviver).
 */
export const REFERENCE_COMP: UnitType[] = ['guard', 'lancer', 'lancer', 'archer', 'scout'];

/** Build the canonical 5-member reference squad spec. */
export function referenceSquadSpec(comp: UnitType[] = REFERENCE_COMP): SquadSpec {
  return { members: comp.map((type, i) => ({ memberId: `m${i}`, type })) };
}

/** Faucet-honest reward dials (§5.1). Total minted = pot regardless of split. */
export const RAID_CLEAR_POT = 250;
export const RAID_FIRST_CLEAR = 150;
/** Deterministic contribution weights (integer). */
export const CONTRIB_W = { dmg: 3, rev: 20, surv: 1, down: 10 };
