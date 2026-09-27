/**
 * Raid engine types (docs/design/raids-v1.md §6.4). A `RaidState` is the pure,
 * deterministic authoritative state for one co-op squad-vs-boss encounter. It is
 * a DELTA on the duel `MatchState`: N squad members (owners) + 1 scripted boss,
 * threat/aggro, downed/revive, and a boss-readings observation layer whose
 * PHANTOM readings are never written to state (so the state hash stays clean).
 *
 * All coordinates are integers; (0,0) is bottom-left (South-West). Members are
 * `m0..m4` (join order); iteration is ALWAYS by ascending member id.
 */

import type { Cell, Dir, EngineEvent, UnitType } from '../types.ts';

/** Stable boss identifiers (contracts BossId `^[a-z][a-z0-9_]{1,40}$`). */
export type BossId =
  | 'the_hallucinator'
  | 'the_overfit'
  | 'the_byzantine'
  | 'deadlock'
  | 'split_brain'
  | 'the_latency';

/**
 * A tiny per-boss HASHED scratchpad for channel mechanics that legitimately need
 * cross-tick memory (Deadlock's out-of-order hold ages → the wait-cycle heal).
 * Empty `{}` for bosses that need none; included in `canonicalizeRaid` ONLY for
 * the boss that uses it, so the Hallucinator/Overfit hashes are untouched.
 */
export interface ChannelState {
  /** Deadlock: lock rank → consecutive ticks it has been held OUT OF ORDER. */
  lockOutOfOrderAge: Record<number, number>;
}

/** Internal squad-member id (`m0`..`m4`) — the arena maps these to wire `mem_…`. */
export type MemberId = string;

/** One squad member's single Avatar unit. Downed units stay on the board. */
export interface RaidUnit {
  memberId: MemberId;
  unitId: string; // `${memberId}-${type}`
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  /** Downed: hp=0, cannot act, blocks its cell, 0 threat/0 corroboration (§2.4). */
  downed: boolean;
  /** Tick this unit was downed (drives the REVIVE_WINDOW bleed-out). */
  downedSince: number | null;
  /** A forfeited (3-hard-miss / dropped-session) member is downed + never revivable. */
  forfeited: boolean;
}

/** A boss-spawned minion (a real add — an actual enemy unit you must kill). */
export interface RaidAdd {
  addId: string;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
}

/** A REAL hazard, written to hashed state: it WILL detonate at `detonateTick`. */
export interface ActiveHazard {
  readingId: string;
  cells: Cell[];
  detonateTick: number;
  /**
   * The member this hazard is aimed at, if any. The boss delivers the real
   * warning to the super-majority but NOT to the victim (§3.2) — so a squad that
   * pools corroboration warns the victim to dodge, while a trust-only-my-own-eyes
   * member never sees the incoming hit. Recorded in state (hashed).
   */
  targetMember?: MemberId | null;
}

/** The server-owned boss entity (never an agent, never an LLM). */
export interface RaidBoss {
  bossId: BossId;
  hp: number;
  maxHp: number;
  /** 0-based phase index (0=P1, 1=P2, 2=P3, 3=enrage). */
  phase: number;
  /** Body cells (impassable to squad units), sorted canonical. */
  footprint: Cell[];
}

/** The Overfit's seeded, deterministic per-member frequency counter-table (§4.2). */
export interface FeatureCounts {
  /** verb → count. */
  verb: Record<string, number>;
  /** approach lane (column bucket) → count. */
  lane: Record<number, number>;
  /** attack region (board third of the targeted cell) → count. */
  region: Record<number, number>;
  total: number;
}

/** Tunable raid dials; Core/5-squad defaults in raid/constants.ts. */
export interface RaidConfig {
  bossHp: number;
  hazardDamage: number;
  bossStrikeDmg: number;
  threatPerDmg: number;
  meleePresence: number;
  /** Guards generate this ×more threat (the tank taunt) so a Guard tops the table. */
  tankThreatMult: number;
  /** Integer threat decay applied as `threat * num / den` (default 9/10). */
  threatDecayNum: number;
  threatDecayDen: number;
  reviveCost: number;
  reviveTicks: number;
  reviveHp: number;
  reviveWindow: number;
  allowance: number;
  /** P2 enters at `hp ≤ p2HpThreshold` OR `tick ≥ p2TickFloor`. */
  p2HpThreshold: number;
  p2TickFloor: number;
  p3HpThreshold: number;
  p3TickFloor: number;
  enrageTick: number;
  tickCap: number;
}

/** One member's channelled revive (reset if the reviver moves/attacks/retargets). */
export interface ReviveChannel {
  /** The downed member being raised. */
  target: MemberId;
  /** Consecutive ticks channelled so far. */
  ticks: number;
}

/** The full authoritative raid state (server-only; never sent to an agent). */
export interface RaidState {
  raidId: string;
  seed: number;
  bossId: BossId;
  /** The tick that will be played NEXT (advances by 1 each resolveRaidTick). */
  tick: number;
  obstacles: Cell[];
  boss: RaidBoss;
  /** All member ids in canonical (join) order. */
  members: MemberId[];
  /** One unit per NON-dead member (living or downed). Dead members are absent. */
  units: RaidUnit[];
  adds: RaidAdd[];
  threat: Record<MemberId, number>;
  /** Member the boss is currently focusing (highest threat; tie → lowest id). */
  currentTarget: MemberId | null;
  remaining: Record<MemberId, number>;
  spent: Record<MemberId, number>;
  activeHazards: ActiveHazard[];
  corruptedRings: number[];
  /** Corroboration credit (from Lucid Anchors) applied to NEXT tick's readings. */
  anchorCredits: Record<MemberId, number>;
  /** Reviver member → its in-progress revive channel. */
  reviveChannels: Record<MemberId, ReviveChannel>;
  /** (Overfit only) per-member action-frequency table. */
  featureCounts: Record<MemberId, FeatureCounts>;
  /** Per-boss hashed channel-mechanics scratchpad (Deadlock lock ages). */
  channel: ChannelState;
  /** Per-member contribution tallies (drives the faucet-honest reward split, §5.1). */
  contribution: Record<MemberId, { dmg: number; revives: number; ticksAlive: number; downs: number }>;
  config: RaidConfig;
  /** Events produced by the LAST resolveRaidTick (empty initially). Not hashed. */
  events: EngineEvent[];
}

// --- Raid action vocabulary (mirrors the wire `raid_action.units[]`) ---
export interface RaidHold {
  unit_id: string;
  verb: 'hold';
}
export interface RaidMove {
  unit_id: string;
  verb: 'move';
  steps: Dir[];
}
export interface RaidAttack {
  unit_id: string;
  verb: 'attack';
  target: Cell;
}
export interface RaidRevive {
  unit_id: string;
  verb: 'revive';
  /** The downed ally member to raise (Chebyshev ≤ 1). */
  target_member: MemberId;
}
export interface RaidPing {
  unit_id?: string;
  verb: 'ping';
  cell: Cell;
  tag: 'hazard' | 'focus' | 'help' | 'regroup' | 'mark';
  /** Free-text (≤120), never parsed by the engine — sanitized at the edge. */
  text?: string;
}
export type RaidUnitAction = RaidHold | RaidMove | RaidAttack | RaidRevive | RaidPing;

/** Every squad member's submitted action-set for one tick, keyed by member id. */
export type RaidTickActions = Record<MemberId, RaidUnitAction[]>;

/** A boss's scripted action for one tick — the deterministic vocabulary (§2.2). */
export interface BossAction {
  /** Lateral body shift (the Overfit pre-dodge); null = hold position. */
  bodyMove: Dir | null;
  /** The threat-target member the `strike` hits (null = no strike this tick). */
  strikeTarget: MemberId | null;
  strikeDmg: number;
  /** REAL hazards to spawn into hashed state this tick. */
  hazards: { readingId: string; cells: Cell[]; detonateTick: number; targetMember?: MemberId | null }[];
  /** REAL adds to spawn. */
  spawnAdds: { addId: string; type: UnitType; cell: Cell }[];
  /** Damage mitigation fraction per member (Overfit): dmg *= (den-num)/den. */
  mitigation?: Record<MemberId, { num: number; den: number }>;
}

/** The terminal outcome of a raid (evaluated at each tick close). */
export interface RaidTerminal {
  over: boolean;
  outcome?: 'clear' | 'wipe' | 'timeout';
  bossDefeated?: boolean;
}

/** The lobby spec that seeds a raid: each member's chosen unit type, in order. */
export interface SquadSpec {
  members: { memberId: MemberId; type: UnitType }[];
}
