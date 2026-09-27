/**
 * TypeScript shapes of the three contracts this package reads and writes
 * (contracts/schemas/{run_spec,episode_result,report}.schema.json, v2.2.0). The
 * schemas are the source of truth: every builder validates its output with AJV
 * against them, so these types only have to be no stricter than the schemas.
 * `EpisodeResult` deliberately accepts arena-scenarios' `toEpisodeResult`
 * output as-is (its `outcome` is typed `string` there).
 */

/** Budget tiers (contracts run_spec `budget_tier`; `extended` since contracts 2.10.0). */
export type TierId = 'edge' | 'core' | 'frontier' | 'extended';
export type SeatId = 'A' | 'B' | 'm0' | 'm1' | 'm2' | 'm3' | 'm4' | 'squad';
export type Power = 'austria' | 'england' | 'france' | 'germany' | 'italy' | 'russia' | 'turkey';
/** Verdict seats also admit the seven Diplomacy powers since contracts 2.1.0. */
export type VerdictSeat = SeatId | Power;
/** One player seat of an episode (EpisodeResult `seats[].seat`): never `squad`. */
export type PlayerSeat = Exclude<VerdictSeat, 'squad'>;
/** `power` (contracts 2.1.0) is the Diplomacy seating. */
export type SeatMode = 'duel' | 'squad' | 'member' | 'power';
export type Severity = 'error' | 'warning' | 'note';
export type VerdictValue = 'pass' | 'fail' | 'not_assessed';
export type Basis = 'resim' | 'attested';

export interface TargetDescriptor {
  transport: 'rest' | 'ws' | 'mcp' | 'a2a';
  url: string;
  auth?: { scheme: 'bearer' | 'header'; ref: string; header_name?: string };
  label?: string;
  /** 2.1.0: `--i-own-this-target`. */
  ownership_attested?: boolean;
}

/** 2.2.0 (K7): an additional non-engine seat of a Diplomacy table. */
export interface RunSpecSeat {
  position: Power;
  driver: 'target' | 'recorded_peer';
  target?: TargetDescriptor;
  owner?: string;
  peer?: { pack: string; agent: string };
}

/** Phase-7 seating (duel, squad, member): `RunSpec['seat']` exactly as the CLI has always consumed it. */
export interface EncounterSeat {
  mode: 'duel' | 'squad' | 'member';
  position?: Exclude<SeatId, 'squad'>;
  fill?: 'coordinated' | 'naive';
}

/** 2.1.0 Diplomacy seating: a power, or `auto` (a function of the seed). */
export interface PowerSeat {
  mode: 'power';
  position?: Power | 'auto';
}

/**
 * A RunSpec of a Phase-7 scenario. Its `seat` stays the Phase-7 seating so
 * existing callers that switch on `seat.mode` keep type-checking; every
 * contract field added since is here. `ContractRunSpec` admits power seating.
 */
export interface RunSpec {
  scenario_id: string;
  scenario_version?: string;
  seeds: number[];
  episodes: number;
  budget_tier: TierId;
  seat?: EncounterSeat;
  /** 2.1.0, diplomacy_standard only. */
  diplomacy?: { profile?: 'security' | 'clean' | 'table'; horizon_year?: number };
  /** 2.2.0 (K7; ADR-004): the ONLY source of which non-primary seats are recorded. */
  seats?: RunSpecSeat[];
  target: TargetDescriptor;
  labels?: Record<string, string>;
}

/** Any contract RunSpec (run_spec.schema.json 2.2.0), Diplomacy power seating included. What a Report records. */
export interface ContractRunSpec extends Omit<RunSpec, 'seat'> {
  seat?: EncounterSeat | PowerSeat;
}

export interface Verdict {
  oracle_id: string;
  seat?: VerdictSeat;
  verdict: VerdictValue;
  severity: Severity;
  basis: Basis;
  reason_code?: string;
  measures?: Record<string, number>;
  thresholds?: Record<string, number>;
  evidence_ref?: { replay_hash: string; ticks: number[]; code?: string; message?: string; items?: unknown[] };
  /** 2.1.0: a statistical oracle whose fail needs human review. */
  review_required?: boolean;
}

export interface BudgetBlock {
  tier: TierId;
  decisions: number;
  actions_submitted: number;
  actions_rejected: number;
  frames_too_large: number;
  soft_deadline_misses: number;
  hard_deadline_misses: number;
  coerced_orders: number;
  over_allowance_orders: number;
  tokens_allowance: number;
  tokens_spent: number;
  within_budget: boolean;
  /** 2.1.0 Diplomacy press counters. */
  press?: Record<string, number>;
  decision_ms_p50?: number;
  decision_ms_p95?: number;
  decision_ms_max?: number;
}

export type InputsSource = 'seed_regenerated' | 'recorded' | 'llm_peer';
export type SeatDriver = 'engine' | 'target' | 'recorded_peer';

/** EpisodeResult `seats[].recorded_inputs` (2.2.0): digest = sha256(JCS(A)), A = the seat's action frames in decision order. */
export interface RecordedInputs {
  decisions: number;
  digest: string;
  record_pointer?: string;
}

/** EpisodeResult `seats[]` (2.2.0, K7; ADR-004): how `verify` obtains one seat's actions. */
export interface EpisodeSeat {
  seat: PlayerSeat;
  driver: SeatDriver;
  inputs_source: InputsSource;
  agent?: string;
  recorded_inputs?: RecordedInputs;
  peer?: {
    pack: string;
    agent: string;
    provider: string;
    model_reported: string;
    inference_region: string;
    prompt_digest?: string;
    gateway_log_digest?: string;
  };
}

export interface EpisodeResult {
  episode_index: number;
  seed: number;
  scenario_id: string;
  mode: SeatMode;
  seat: VerdictSeat;
  fill?: 'coordinated' | 'naive';
  status: 'completed' | 'aborted';
  abort_reason?: 'target_unreachable' | 'target_auth_failed' | 'target_protocol_error' | 'wall_clock_exceeded' | 'harness_error';
  /** win | loss | draw | clear | wipe | timeout | forfeit | aborted (schema-enforced). */
  outcome: string;
  outcome_reason?: string;
  terminal_tick: number;
  replay_hash: string;
  /** 2.1.0, diplomacy_standard: head of the transcript chain (press and intents). Passed through. */
  transcript_hash?: string;
  /** 2.1.0, diplomacy_standard: sha256 over the canonical verdict vector. Passed through. */
  evaluation_hash?: string;
  replay_ref?: string;
  trajectory_class?: string;
  blinding_key?: string;
  budget: BudgetBlock;
  oracles: Verdict[];
  duration_ms?: number;
  /** 2.2.0 (K7). */
  seats?: EpisodeSeat[];
  /** 2.1.0 Diplomacy block (power, profile, sig_mode, roster, …); passed through, schema-validated. */
  diplomacy?: { sig_mode?: string; episode_secret?: string; episode_secret_commitment?: string } & Record<string, unknown>;
}

export interface CatalogOracle {
  oracle_id: string;
  title: string;
  primary?: boolean;
  level: 'episode' | 'run';
  basis: Basis;
  severities: Severity[];
  help_uri?: string;
  /** 2.1.0, informational: never changes a SARIF level. */
  risk?: 'critical' | 'high' | 'medium' | 'low';
  /** 2.1.0: a fail is a statistical signal that needs human review of the replay. */
  review_required?: boolean;
}

export interface OracleSummary {
  oracle_id: string;
  pass: number;
  fail: number;
  not_assessed: number;
  fail_by_severity?: Partial<Record<Severity, number>>;
}

/** `run.target_ownership` (2.1.0; `sixi_verified` 2.2.0): the runner's record of the ownership check. */
export interface TargetOwnership {
  loopback: boolean;
  attested: boolean;
  source?: 'cli_flag' | 'run_spec' | 'sixi_verified';
}

/**
 * `run.hosted` (2.2.0, K1): copied by the hosted runner from the signed run
 * manifest. Opaque to this package (validated by the schema only); the fields
 * typed here are the ones the SARIF (§1.1) and the signing invariants read.
 */
export interface HostedRecord {
  signing_key_id: string;
  region: string;
  packs: { id: string; version: string; digest: string }[];
  run_manifest: { digest: string; signing_key_id: string; path?: string };
  [k: string]: unknown;
}

export type NotAssessedKind = 'scenario' | 'oracle' | 'clause' | 'seat' | 'property';
export type NotAssessedReason =
  | 'oracle_not_assessed'
  | 'oracle_partially_not_assessed'
  | 'no_episode_completed'
  | 'recorded_not_regenerated'
  | 'commitments_unsigned'
  | 'clause_not_mapped_in_run'
  | 'clause_oracles_not_assessed'
  | 'seed_recovery_not_modelled'
  | 'pack_data_required'
  | 'out_of_scope_by_design';

/** One entry of the Report `not_assessed` section (2.2.0). */
export interface NotAssessedEntry {
  kind: NotAssessedKind;
  id: string;
  reason_code: NotAssessedReason;
  basis: 'resim' | 'recorded';
  seat?: VerdictSeat;
  episodes?: number;
  verdict_reasons?: Record<string, number>;
  pack?: string;
}

/** The `signing` seal (2.2.0, signing.md). */
export interface SigningBlock {
  algorithm: 'ed25519';
  signing_key_id: string;
  canonicalization: 'jcs-rfc8785';
  payload_type: 'application/vnd.sixi.arena-report+json';
  excluded: ['/signing/signature'];
  run_manifest_digest: string;
  sealed_at: string;
  signature: string;
}

export interface Report {
  report_version: '1.0';
  run: {
    run_id: string;
    mode: 'local' | 'hosted';
    started_at: string;
    finished_at: string;
    tool: { name: string; version: string };
    spec: ContractRunSpec;
    target_ownership?: TargetOwnership;
    hosted?: HostedRecord;
  };
  /** 2.3.0: `build_scope` (core | diplomacy | all) and `source_manifest_digest`, both optional; member order as buildReport writes it. */
  engine: { build_hash: string; build_scope?: 'core' | 'diplomacy' | 'all'; source_manifest_digest?: string; version: string; commit?: string };
  scenario: {
    scenario_id: string;
    /** 2.2.0: required iff an `sx_` pack scenario. */
    base_scenario_id?: string;
    version: string;
    failure_mode_id?: string;
    reference_policy?: string;
    oracles: CatalogOracle[];
  };
  budget_limits: {
    tier: TierId;
    soft_deadline_ms: number;
    hard_deadline_ms: number;
    hard_miss_forfeit: 3;
    token_allowance: number;
    tick_cap: 120;
    max_orders_per_unit: 1;
    /** 8192, or 16384 for diplomacy_standard (2.1.0). */
    max_inbound_frame_bytes: 8192 | 16384;
  };
  episodes: EpisodeResult[];
  run_oracles: Verdict[];
  summary: {
    verdict: 'pass' | 'fail' | 'inconclusive';
    episodes_total: number;
    episodes_completed: number;
    episodes_aborted: number;
    effective_episodes: number;
    outcomes: Partial<Record<'win' | 'loss' | 'draw' | 'clear' | 'wipe' | 'timeout' | 'forfeit' | 'aborted' | 'solo' | 'survived' | 'eliminated', number>>;
    oracles: OracleSummary[];
    within_budget_episodes: number;
  };
  disclosure: { conflict_of_interest: string; determinism?: string };
  /** 2.2.0: everything this run did not assess (required on hosted reports). */
  not_assessed?: NotAssessedEntry[];
  /** 2.2.0: the seal of a hosted report. */
  signing?: SigningBlock;
}

/* ----------------------------------------------------------------- SARIF -- */
/** The subset of SARIF 2.1.0 this emitter produces (validated against the full OASIS schema). */

export type SarifLevel = 'error' | 'warning' | 'note' | 'none';
export type SarifKind = 'fail' | 'pass' | 'open' | 'notApplicable' | 'review' | 'informational';

export interface SarifMessage {
  text: string;
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: SarifMessage;
  fullDescription?: SarifMessage;
  defaultConfiguration: { level: SarifLevel };
  properties: {
    tags: string[];
    precision: 'very-high' | 'high' | 'medium';
    /** sarif-mapping.md §2 member order: basis, level, primary, risk?, review_required?. */
    agentArena: { basis: Basis; level: 'episode' | 'run'; primary: boolean; risk?: 'critical' | 'high' | 'medium' | 'low'; review_required?: true };
  };
  helpUri?: string;
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  locations: {
    physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
    logicalLocations: { fullyQualifiedName: string; kind: 'object' }[];
  }[];
  partialFingerprints: { 'agentArena/v1': string; primaryLocationLineHash: string };
  kind: SarifKind;
  level: SarifLevel;
  message: SarifMessage;
  properties: { agentArena: Record<string, unknown> };
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      semanticVersion: string;
      informationUri: string;
      rules: SarifRule[];
      properties: { agentArena: { conflict_of_interest: string; determinism?: string } };
    };
  };
  automationDetails: { id: string };
  invocations: {
    executionSuccessful: boolean;
    toolExecutionNotifications?: { level: 'warning'; descriptor: { id: string }; message: SarifMessage }[];
  }[];
  results: SarifResult[];
  properties: { agentArena: Record<string, unknown> };
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: [SarifRun];
}
