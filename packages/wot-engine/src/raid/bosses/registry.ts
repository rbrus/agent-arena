/**
 * The failure-mode boss FRAMEWORK (failure-modes-pillar.md §2). A failure-mode
 * boss is DATA (a `BossDescriptor`) + up to three PURE functions:
 *
 *   - `policy(state)`              — the scripted boss action (start-of-tick;
 *                                    the telegraph invariant). Every boss has one.
 *   - `projectObservation(...)`    — the PROJECTION hook (§2.3): per-member
 *                                    observation overlay generated purely from
 *                                    `(seed, phase, member_id, salt)`. It changes
 *                                    what a member KNOWS, never what is TRUE, so
 *                                    it is NEVER written to `RaidState` and is
 *                                    excluded from the hash (Byzantine advisories,
 *                                    Split-Brain cross-group hiding, …).
 *   - `applyChannelMechanics(...)` — the CHANNEL-MECHANICS hook (§2.3): a pure
 *                                    resolve-pipeline stage computing the REAL,
 *                                    HASHED consequence of a hashed-mechanic
 *                                    channel from real positions/actions
 *                                    (Byzantine ground-shield, Deadlock ward/heal,
 *                                    Split-Brain clean-write/split-brain penalty,
 *                                    Overfit counter-table advance).
 *
 * The determinism contract the framework ENFORCES (§2.2): *changes what a member
 * KNOWS → projection (out of the hash); changes what is TRUE → hashed mechanic.*
 */

import type { Cell } from '../../types.ts';
import type { RaidExec } from '../legalize.ts';
import type { BossAction, BossId, MemberId, RaidState } from '../types.ts';

/** The four failure-mode channels + the adaptive counter (§2.2). */
export type FailureChannel =
  | 'corrupted_observation'
  | 'lock_structure'
  | 'partition'
  | 'delay'
  | 'adaptive_counter';

/** A catalog descriptor (contracts openapi.yaml BossDescriptor; §2.1). */
export interface BossDescriptor {
  boss_id: BossId;
  /** The taxonomy key (contracts BossDescriptor.failure_mode_id) — the codex groups the curriculum by this. */
  failure_mode_id: string;
  name: string;
  title: string;
  /** The distributed-systems fault, plain + precise (the codex, §8). */
  failure_mode: string;
  /** The discipline the squad must demonstrate. */
  robust_pattern: string;
  /** One-line how-to-beat drill (the reference squad's key rule). */
  lesson: string;
  /** The failure-mode channels this boss delivers through. */
  channels: FailureChannel[];
  squad_size: { min: number; max: number };
  recommended_league: 'edge' | 'core' | 'frontier';
  phases: { phase: number; name: string; hp_pct_start?: number; summary?: string }[];
  mechanics: string;
  deterministic: true;
  sigil_seed: string;
}

/**
 * The PROJECTION hook's return: per-member observation deltas (§2.3). Every field
 * is belief/observation-only and is merged onto the whitelist-built observation.
 * Nothing here is ever written to `RaidState`.
 */
export interface ObservationProjection {
  /** Byzantine consensus advisories (own + broadcasts, faulty spoof first). */
  consensusAdvisories?: { from_member: MemberId; claimed_anchor: string; real: boolean }[];
  /** Deadlock lock structure with holders (derivable from public ranks + holds). */
  locks?: { rank: number; cell: Cell; held_by: MemberId | null }[];
  /** Deadlock: the next rank to acquire (lowest unheld rank), or null when full. */
  nextLockRank?: number | null;
  /** Split-Brain partition banner for this member. */
  partition?: {
    group: 'A' | 'B';
    group_size: number;
    is_primary: boolean;
    window_ends_on_turn: number;
    core_cell: Cell | null;
  } | null;
  /** Split-Brain cross-group hiding: member ids omitted from this member's frame. */
  hiddenMembers?: MemberId[];
  /** The Latency delay banner: the STALE readout + the telegraphed current cell. */
  delay?: {
    /** Ticks of lag on the exposed-cell readout this phase. */
    ticks_stale: number;
    /** Where the weak point WAS `ticks_stale` ticks ago (the stale telemetry). */
    observed_cell: Cell;
    /** Where it IS now (the deterministic telegraph — lead here, not the stale cell). */
    lead_cell: Cell;
  } | null;
}

/**
 * The CHANNEL-MECHANICS hook's return: the real, hashed consequence deltas (§2.3).
 * All integer; applied to hashed state in a fixed order by the resolve pipeline.
 */
export interface ChannelOutcome {
  /** Scale applied to squad→boss attack damage this tick (e.g. a raised shield). */
  bossDamageScale?: { num: number; den: number };
  /** Flat boss self-heal added after squad damage (ward / deadlock / split-brain). */
  bossHeal?: number;
  /** Flat extra boss damage (Split-Brain clean-write core hit). */
  bossExtraDamage?: number;
  /** Per-unit extra damage keyed by unit id (Split-Brain AoE, Deadlock ward chip). */
  unitDamage?: { unitId: string; amount: number }[];
  /** Suppress the boss strike this tick (Byzantine grounded). */
  suppressStrike?: boolean;
}

/** Read-only context handed to `applyChannelMechanics` (post-movement positions). */
export interface ChannelCtx {
  /** The mutable in-flight clone (post-move unit positions live here). */
  state: RaidState;
  /** The immutable start-of-tick state (telegraph-consistent reads). */
  startState: RaidState;
  /** Every executed action this tick (post-legalize). */
  allExec: RaidExec[];
  execByMember: Map<MemberId, RaidExec[]>;
  /** Attacks that landed (in range) on a boss `reservedCells` cell this tick. */
  channelAttacks: { memberId: MemberId; cell: Cell }[];
  action: BossAction;
  emit: (type: string, fields?: Record<string, unknown>) => void;
}

/** A registered failure-mode boss: data + its pure hooks (§2). */
export interface BossModule {
  descriptor: BossDescriptor;
  policy: (state: RaidState) => BossAction;
  projectObservation?: (state: RaidState, memberId: MemberId, salt: number) => ObservationProjection | null;
  /**
   * Cells whose incoming squad attacks the channel-mechanics hook OWNS (their
   * normal boss damage is withheld; the hit is recorded in `channelAttacks`).
   * Split-Brain reserves the exposed core cell; other bosses reserve nothing.
   */
  reservedCells?: (state: RaidState) => Set<string>;
  applyChannelMechanics?: (ctx: ChannelCtx) => ChannelOutcome;
}

export type BossModuleMap = Record<BossId, BossModule>;
