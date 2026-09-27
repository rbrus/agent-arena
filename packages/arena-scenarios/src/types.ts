/**
 * The `Scenario` interface (docs/design/arena-scenarios.md §4.1). Every
 * scenario is an adapter over the UNMODIFIED wot-engine: it owns seating,
 * budget tiers, the target-facing egress projection, submissions (wall time is
 * DATA here, never a clock read), forfeit, the episode record and the oracles.
 *
 * Nothing in this package reads `Date.now()`, `Math.random()` or does I/O on an
 * asserted path. Given `(seed, tier, opts, submissions)` an episode is fully
 * determined, and `verify(record)` recomputes it bit-for-bit.
 */

import type { DiplomacyInitOptions, DiplomacyRecord } from './diplomacy/record.ts';

export type { DiplomacyInitOptions, DiplomacyRecord };

export type ScenarioId =
  | 'grid_tactics'
  | 'hallucinator'
  | 'overfit'
  | 'byzantine'
  | 'deadlock'
  | 'split_brain'
  | 'latency'
  /** Phase 8 (contracts 2.1.0): the standard-map Diplomacy table (src/diplomacy/). */
  | 'diplomacy_standard';

export type RaidScenarioId = Exclude<ScenarioId, 'grid_tactics' | 'diplomacy_standard'>;

export type TierId = 'edge' | 'core' | 'frontier';
/** Diplomacy seats: the seven powers, full lower-case names (contracts 2.1.0 wire ids). */
export type PowerSeat = 'austria' | 'england' | 'france' | 'germany' | 'italy' | 'russia' | 'turkey';
/** `auto` is a seat REQUEST only (power mode): resolved from the seed at init, never recorded. */
export type SeatId = 'A' | 'B' | 'm0' | 'm1' | 'm2' | 'm3' | 'm4' | 'squad' | PowerSeat | 'auto';
export type MemberSeat = 'm0' | 'm1' | 'm2' | 'm3' | 'm4';
export type SeatMode = 'duel' | 'squad' | 'member' | 'power';

export interface BudgetTier {
  id: TierId;
  softDeadlineMs: number;
  hardDeadlineMs: number;
  hardMissForfeit: number;
  actionAllowance: number;
  tickCap: number;
  maxInboundFrameBytes: number;
}

export interface SeatDescriptor {
  seat: SeatId;
  /** Engine ids this seat controls: ['A'] | ['m1'] | ['m0','m1','m2','m3','m4']. */
  controls: string[];
  role: 'target' | 'reference' | 'opponent';
  /** 'house-bot:silver' | 'ref:bftQuorumSquad' | 'driver:ref:consensusSquad' | 'external'. */
  policyRef?: string;
}

/** Who drives the TARGET seat. `external` = submissions via act(); `ref:*` = in-process self-test. */
export type TargetDriver =
  | 'external'
  | 'ref:coordinated'
  | 'ref:naive'
  /** duel only */
  | 'ref:reflex'
  | 'ref:null'
  | 'ref:silver'
  /** diplomacy_standard: the reference pair (robust passes, credulous fails) and the house agent. */
  | 'ref:robust'
  | 'ref:credulous'
  | 'ref:house';

export interface ScenarioInitOptions {
  mode: SeatMode;
  /** member default 'm1'; duel default 'A'. */
  targetSeat?: SeatId;
  /** member-mode reference fill (default coordinated). */
  fill?: 'coordinated' | 'naive';
  targetDriver?: TargetDriver;
  /** 64 lowercase hex chars. Egress id blinding (L3); disclosed only after terminal. */
  blindingKey: string;
  /** power mode (diplomacy_standard) only; see src/diplomacy/tables.ts. */
  diplomacy?: DiplomacyInitOptions;
  /** Recorded verbatim in the EpisodeRecord (the runner supplies the build id). */
  engineCommit?: string;
}

/** Contract reject reasons a transport or act() can record (contracts/errors.md §3a). */
export type RejectReason =
  | 'unparseable'
  | 'schema_invalid'
  | 'wrong_protocol_version'
  | 'too_large'
  | 'stale_turn'
  | 'bad_echo'
  | 'not_your_seat'
  | 'duplicate_submission'
  | 'unknown_frame'
  | 'rate_limited';

/** What the transport hands the Scenario for one target seat on one tick. Wall time is DATA. */
export type Submission<A = unknown> =
  | { kind: 'action'; payload: A; latencyMs: number | null; frameBytes: number | null }
  | { kind: 'rejected'; reason: RejectReason; latencyMs: number | null; frameBytes?: number | null }
  | { kind: 'miss'; severity: 'soft' | 'hard' };

export interface ActReceipt {
  accepted: boolean;
  reason?: RejectReason | 'late_frame_dropped';
  /** Legalize preview (DX only; the engine re-legalizes at resolve). */
  coercions: { unitId: string; reason: string }[];
  /** true when an accepted action arrived after Ds (still applied; counted as a soft miss). */
  late?: boolean;
}

export type Outcome = 'win' | 'loss' | 'draw' | 'clear' | 'wipe' | 'timeout' | 'forfeit' | 'solo' | 'survived' | 'eliminated';

export interface EpisodeTerminal {
  outcome: Outcome;
  /** duel: ascension | elimination | timeout_<rung>; raid: boss_defeated | squad_wiped | tick_cap; diplomacy: solo | horizon | last_standing; forfeit: hard_miss_streak */
  reason?: string;
  ticks: number;
}

export interface TickResult {
  tick: number;
  stateHash: string;
  terminal: EpisodeTerminal | null;
}

export type VerdictStatus = 'pass' | 'fail' | 'not_assessed';
export type Severity = 'error' | 'warning' | 'note';

export interface OracleVerdict {
  /** '<scenario|shared|harness>.<oracle>' → SARIF ruleId. */
  oracleId: string;
  seat: SeatId;
  status: VerdictStatus;
  /** fail → band severity; pass / not_assessed → 'note'. */
  severity: Severity;
  measure: Record<string, number>;
  thresholds: Record<string, number>;
  /** ≤ 32, ascending (replay-inspector deep links). */
  evidenceTicks: number[];
  basis: 'resim' | 'attested';
  /** REQUIRED when not_assessed (contract reason_code). */
  reason?: string;
  /** Stable machine code of the finding (fail only). */
  code?: string;
  /** Oracle-templated platform text (never target text). */
  message?: string;
  /** diplomacy_standard: `oracle_evidence` items (ids and ticks only, never text). */
  evidenceItems?: Record<string, unknown>[];
  /** diplomacy_standard.collusion: a fail needs human review before it is acted on. */
  reviewRequired?: boolean;
}

/**
 * One timing-log entry (attested; never hashed). Exactly one `decision` entry
 * per (tick, target seat) is written at tick(); every refused frame adds a
 * `rejected` entry.
 */
export interface TimingEntry {
  event: 'decision' | 'rejected';
  tick: number;
  seat: SeatId;
  latencyMs: number | null;
  miss: 'none' | 'soft' | 'hard';
  frameBytes: number | null;
  reject?: RejectReason | 'late_frame_dropped';
}

export interface AdapterCoercion {
  tick: number;
  member: string;
  unitId: string;
  reason: 'over_speed';
}

export interface EpisodeRecord {
  scenarioId: ScenarioId;
  scenarioVersion: string;
  engineCommit: string;
  seed: number;
  tier: TierId;
  mode: SeatMode;
  targetSeat: SeatId;
  fill?: 'coordinated' | 'naive';
  seats: SeatDescriptor[];
  /** TickActions[] | RaidTickActions[]: the ONLY replay input (all seats, post-substitution). */
  inputs: unknown[];
  timing: TimingEntry[];
  /** Adapter-side legal-prefix truncations (moves longer than the unit's speed). */
  adapterCoercions: AdapterCoercion[];
  blindingKey: string;
  perTickHashes: string[];
  replayHash: string;
  terminal: EpisodeTerminal;
  /** sha256 over the reference-free, seed-derived parts of the episode (§1.7). */
  trajectoryClass: string;
  /** Present iff scenarioId is `diplomacy_standard` (src/diplomacy/record.ts). */
  diplomacy?: DiplomacyRecord;
}

/** An EpisodeRecord of the Diplomacy scenario (type guard: `isDiplomacyRecord`). */
export type DiplomacyEpisodeRecord = EpisodeRecord & { scenarioId: 'diplomacy_standard'; mode: 'power'; targetSeat: PowerSeat; diplomacy: DiplomacyRecord };

export interface ScenarioDescriptor {
  scenarioId: ScenarioId;
  version: string;
  modes: SeatMode[];
  capability: string;
  squadSize?: { min: number; max: number };
  oracles: {
    oracleId: string;
    primary: boolean;
    basis: 'resim' | 'attested';
    severityOnFail: Severity[];
    /** diplomacy_standard (contracts 2.1.0 catalog): SARIF risk and review flag. */
    risk?: 'critical' | 'high' | 'medium' | 'low';
    reviewRequired?: boolean;
  }[];
  channels: string[];
  /** power mode: the reference pair and fixtures of the scenario (list-scenarios). */
  references?: { pass: string; fail: string; fixtures: string[]; fills: string[] };
  /** OWASP Agentic / MITRE ATLAS ids only; never regulatory clauses (paid packs). */
  mappingHints: string[];
  /** Every open hint is a candidate until verified in Phase 9 (not a compliance claim). */
  mappingHintsStatus: 'candidate';
}

export interface SelfTestCase {
  name: string;
  seed: number;
  tier: TierId;
  opts: Omit<ScenarioInitOptions, 'blindingKey'>;
  expect: { outcome: Outcome; ticks?: number; replayHash?: string };
}

export interface Scenario<Obs = unknown, Act = unknown> {
  readonly id: ScenarioId;
  readonly version: string;
  init(seed: number, tier: TierId, opts: ScenarioInitOptions): void;
  seats(): readonly SeatDescriptor[];
  targetSeats(): readonly SeatId[];
  /** Egress frame body for a TARGET seat; pure; idempotent within a tick. */
  observe(agentId: SeatId): Obs;
  /** Buffers; the first accepted submission per tick wins. */
  act(agentId: SeatId, submission: Submission<Act>): ActReceipt;
  tick(): TickResult;
  terminal(): EpisodeTerminal | null;
  /** After terminal; pure over record() via re-sim + tap. */
  oracles(): OracleVerdict[];
  replayHash(): string;
  record(): EpisodeRecord;
  /** The tick that will be played next (= turn_id of the current observation). */
  currentTick(): number;
}

export interface ScenarioModule {
  describe(): ScenarioDescriptor;
  create(): Scenario;
  verify(rec: EpisodeRecord): { replayHash: string; verdicts: OracleVerdict[]; integrity: boolean };
  selfTests(): SelfTestCase[];
  /**
   * Re-drive a fresh Scenario from a record's target-seat inputs and timing log
   * through act()/tick() (src/redrive.ts); returns the terminal Scenario.
   */
  redrive(rec: EpisodeRecord): Scenario;
}
