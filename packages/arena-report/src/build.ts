/**
 * `buildReport`: RunSpec + EpisodeResults → Report (contracts/schemas/report.schema.json).
 *
 * Everything that is not an input is DERIVED here, deterministically:
 * the run id (from the start time + a digest of the inputs), the oracle
 * catalog and budget limits (from the build's scenario descriptors and tier
 * table), the run-level oracles (recomputed from the episode outcomes), and
 * the summary. The same inputs always yield the same bytes, which is what the
 * golden fixture and `verifyReport` rely on.
 *
 * The builder refuses (throws `ReportBuildError`) rather than emitting a
 * report that contradicts its own RunSpec: wrong seed for an index, wrong
 * seat, wrong tier, missing episodes, verdicts out of catalog order, or a seat
 * provenance the RunSpec does not allow (ADR-004).
 *
 * Contracts 2.1.0/2.2.0 fields: `run.target_ownership` and `run.hosted`
 * (passthrough, schema-validated), per-episode `seats[]` provenance (completed
 * from the RunSpec, recorded inputs from the caller), the `not_assessed`
 * section (computed `resim` entries plus caller-supplied `recorded` ones),
 * Diplomacy `transcript_hash` / `evaluation_hash` (passthrough). `signing` is
 * never written here: `signReport` seals a finished hosted report.
 */

import { effectiveEpisodes, gridWinRate, tierOf, toContractVerdict } from 'arena-scenarios';
import { CONFLICT_OF_INTEREST, DEFAULT_ENGINE_VERSION, DETERMINISM_NOTE, DIPLOMACY_SCENARIO_ID, TOOL_NAME, TOOL_VERSION, failureModeId, isScenarioId, oracleCatalog, referencePolicy, type ReportScenarioId } from './catalog.ts';
import { canonicalize, sha256Hex } from './canonical.ts';
import { allowedEngineBuildScopes, engineBuildDigestOf, engineBuildScopeFor, engineSourceManifestDigest, type EngineBuildScope, type EngineSourceManifest } from './engine-digest.ts';
import { formatErrors, validateEpisodeResultSchema, validateReportSchema, validateRunSpecSchema } from './schemas.ts';
import type {
  CatalogOracle,
  EpisodeResult,
  EpisodeSeat,
  HostedRecord,
  InputsSource,
  NotAssessedEntry,
  NotAssessedKind,
  OracleSummary,
  ContractRunSpec,
  PlayerSeat,
  Power,
  Report,
  SeatDriver,
  SeatMode,
  Severity,
  TargetOwnership,
  Verdict,
  VerdictSeat,
} from './types.ts';

/** What the runner knows about one seat of one episode (EpisodeResult `seats[]` minus what the RunSpec fixes). */
export interface SeatProvenanceInput {
  seat: PlayerSeat;
  /** Checked against the RunSpec; defaults from it. */
  driver?: SeatDriver;
  /** Checked against the RunSpec; defaults: engine seats seed_regenerated, target seats recorded, recorded peers llm_peer when `peer` is given, else recorded. */
  inputs_source?: InputsSource;
  agent?: string;
  recorded_inputs?: EpisodeSeat['recorded_inputs'];
  peer?: EpisodeSeat['peer'];
}

export interface BuildReportInput {
  runSpec: ContractRunSpec;
  episodes: EpisodeResult[];
  /** Content hash of the engine build that played the episodes: `sha256:<64 hex>`. */
  engineBuild: string;
  /** The scenario version actually run (e.g. arena-scenarios RAID_SCENARIO_VERSION). */
  scenarioVersion: string;
  startedAt: string;
  finishedAt: string;
  /* Optional; defaults in brackets. */
  /** [derived] `run_<26 Crockford base32>`; derived from startedAt + a digest of the inputs when absent. */
  runId?: string;
  /** ['local'] */
  mode?: 'local' | 'hosted';
  /** [@rbrus/agent-arena 0.1.0] */
  tool?: { name: string; version: string };
  /** [arena@2.0.0] */
  engineVersion?: string;
  engineCommit?: string;
  /**
   * The engine build scope the caller hashed `engineBuild` with. When given it
   * is recorded as `engine.build_scope` (contracts 2.3.0) and must be the
   * scenario's scope (`engineBuildScopeFor`) or `all`, so a mis-scoped hash is
   * refused here instead of failing `verify` later. When absent, nothing is
   * recorded and readers assume the scenario's scope (a 2.2.0-shaped Report).
   */
  engineBuildScope?: EngineBuildScope;
  /**
   * The source manifest `engineBuild` was derived from (the bundle's embedded
   * one, or `engineSourceManifest(root)`). Recorded as
   * `engine.source_manifest_digest` = `engineSourceManifestDigest(manifest)`,
   * and `engineBuild` is checked to be its digest under the recorded scope.
   */
  engineSourceManifest?: EngineSourceManifest;
  /**
   * `engine.source_manifest_digest` when only the digest is at hand (verify
   * rebuilding a Report, `EngineBuildDigest.manifestDigest`). Must agree with
   * `engineSourceManifest` when both are given.
   */
  engineSourceManifestDigest?: string;
  /** [engineCommit] The commit pinning the reference agents in `scenario.reference_policy`. */
  referencePolicyPin?: string;
  /** 2.1.0 `run.target_ownership`: the runner's record of the ownership check. */
  targetOwnership?: TargetOwnership;
  /** 2.2.0 `run.hosted`: copied from the signed run manifest by the hosted runner. Opaque here (schema-validated). Implies mode `hosted`. */
  hosted?: HostedRecord;
  /**
   * 2.2.0 seat provenance, indexed by episode index. Given for an episode, the
   * builder writes that episode's `seats[]` with every player seat, completing
   * driver and inputs_source from the RunSpec. Episodes that already carry
   * `seats[]` are checked against the RunSpec instead.
   */
  seats?: ReadonlyArray<ReadonlyArray<SeatProvenanceInput> | undefined>;
  /**
   * 2.2.0 `not_assessed` entries the runner adds from the scenario catalog, a
   * mounted pack or the hosted profile (clauses, standing exclusions). Must
   * have basis `recorded`: every `resim` entry is computed here, so that
   * `verify` can recompute it.
   */
  notAssessed?: readonly NotAssessedEntry[];
  /** [true] Write the `not_assessed` section (verify turns it off to rebuild a 2.1.0 report). */
  emitNotAssessed?: boolean;
}

export class ReportBuildError extends Error {
  readonly errors: string[];
  constructor(message: string, errors: string[]) {
    super(`${message}:\n  - ${errors.join('\n  - ')}`);
    this.name = 'ReportBuildError';
    this.errors = errors;
  }
}

/**
 * Reason codes that mean "not applicable by catalog design" (sarif-mapping.md §3, stated once at
 * contracts 2.5.0): the three generic codes plus the §2.1 Diplomacy codes. One set drives both the
 * SARIF kind (`notApplicable`; every other code is `open`) and `summary.verdict` (a not-assessed
 * verdict with one of these codes is no gap), so a single-target Diplomacy run is not
 * `inconclusive` only because collusion cannot apply to it. `sample_out_of_table` is deliberately
 * absent: it could apply and was not measured, so it stays `open` (§2.1).
 */
export const NOT_APPLICABLE_REASONS: ReadonlySet<string> = new Set([
  'precondition_not_reached',
  'not_applicable_to_seat',
  'not_applicable_to_tier',
  'no_request_delivered',
  'single_owner_table',
  'shared_owner',
  'no_canary_delivered',
]);

const SEVERITY_ORDER: readonly Severity[] = ['error', 'warning', 'note'];
const OUTCOME_ORDER = ['win', 'loss', 'draw', 'clear', 'wipe', 'timeout', 'forfeit', 'aborted', 'solo', 'survived', 'eliminated'] as const;

export const POWERS: readonly Power[] = ['austria', 'england', 'france', 'germany', 'italy', 'russia', 'turkey'];
const MEMBERS: readonly PlayerSeat[] = ['m0', 'm1', 'm2', 'm3', 'm4'];

export function seatModeOf(spec: ContractRunSpec): SeatMode {
  return spec.seat?.mode ?? (spec.scenario_id === 'grid_tactics' ? 'duel' : spec.scenario_id === DIPLOMACY_SCENARIO_ID ? 'power' : 'member');
}

/**
 * The seat the target controls in episode `index` (run_spec `seat`: duel
 * alternates A/B when unpinned). Power mode with position `auto` (the
 * default) returns `auto`: the power is a function of the seed that only the
 * scenario computes, and the episode's `seat` is then checked to be a power.
 */
export function resolvedSeat(spec: ContractRunSpec, index: number): VerdictSeat | 'auto' {
  const mode = seatModeOf(spec);
  if (mode === 'squad') return 'squad';
  if (mode === 'duel') return (spec.seat?.position as 'A' | 'B' | undefined) ?? (index % 2 === 0 ? 'A' : 'B');
  if (mode === 'power') return (spec.seat?.position as Power | 'auto' | undefined) ?? 'auto';
  return (spec.seat?.position as PlayerSeat | undefined) ?? 'm1';
}

/** Every player seat of an episode in canonical order (EpisodeResult `seats[]` order). */
export function playerSeats(mode: SeatMode): readonly PlayerSeat[] {
  return mode === 'duel' ? ['A', 'B'] : mode === 'power' ? POWERS : MEMBERS;
}

/** The seats the primary target plays in an episode: all five members in squad mode, else the episode seat. */
export function primarySeats(mode: SeatMode, episodeSeat: VerdictSeat): readonly PlayerSeat[] {
  return mode === 'squad' ? MEMBERS : [episodeSeat as PlayerSeat];
}

export interface ExpectedSeat {
  seat: PlayerSeat;
  driver: SeatDriver;
  /** The inputs sources the RunSpec allows for this seat (ADR-004 §2). */
  allowed: readonly InputsSource[];
}

/**
 * ADR-004 §2: which seats may be recorded is decided by the RunSpec (the
 * primary seat plus `run.spec.seats[]`), never by the episode. Every other
 * player seat is an engine seat, regenerated from the seed.
 */
export function expectedSeatProvenance(spec: ContractRunSpec, mode: SeatMode, episodeSeat: VerdictSeat): ExpectedSeat[] {
  const primary = new Set<string>(primarySeats(mode, episodeSeat));
  return playerSeats(mode).map((seat): ExpectedSeat => {
    if (primary.has(seat)) return { seat, driver: 'target', allowed: ['recorded'] };
    const decl = spec.seats?.find((d) => d.position === seat);
    if (decl?.driver === 'target') return { seat, driver: 'target', allowed: ['recorded'] };
    if (decl?.driver === 'recorded_peer') return { seat, driver: 'recorded_peer', allowed: ['llm_peer', 'recorded'] };
    return { seat, driver: 'engine', allowed: ['seed_regenerated'] };
  });
}

/** Differences between an episode's `seats[]` and what the RunSpec allows (empty when consistent). */
export function seatProvenanceErrors(spec: ContractRunSpec, e: EpisodeResult, at: string): string[] {
  if (!e.seats) return [];
  const errs: string[] = [];
  const expected = expectedSeatProvenance(spec, e.mode, e.seat);
  const listed = e.seats.map((s) => s.seat);
  const want = expected.map((x) => x.seat);
  if (listed.join() !== want.join()) errs.push(`${at}.seats lists [${listed.join(', ')}], the RunSpec implies [${want.join(', ')}] in that order`);
  e.seats.forEach((s, k) => {
    const x = expected.find((y) => y.seat === s.seat);
    if (!x) return;
    if (s.driver !== x.driver) errs.push(`${at}.seats[${k}] (${s.seat}): driver ${s.driver}, the RunSpec implies ${x.driver}`);
    if (!x.allowed.includes(s.inputs_source)) errs.push(`${at}.seats[${k}] (${s.seat}): inputs_source ${s.inputs_source}, the RunSpec allows ${x.allowed.join(' | ')}`);
  });
  return errs;
}

/** Complete one episode's `seats[]` from the RunSpec and the runner's per-seat inputs. */
export function completeSeats(spec: ContractRunSpec, e: EpisodeResult, given: readonly SeatProvenanceInput[], at: string, errs: string[]): EpisodeSeat[] {
  const expected = expectedSeatProvenance(spec, e.mode, e.seat);
  for (const g of given) if (!expected.some((x) => x.seat === g.seat)) errs.push(`${at}: seat ${String(g.seat)} is not a player seat of a ${e.mode} episode`);
  return expected.map((x) => {
    const g = given.find((y) => y.seat === x.seat);
    if (g?.driver && g.driver !== x.driver) errs.push(`${at} seat ${x.seat}: driver ${g.driver}, the RunSpec implies ${x.driver}`);
    const source: InputsSource = g?.inputs_source ?? (x.driver === 'recorded_peer' ? (g?.peer ? 'llm_peer' : 'recorded') : x.allowed[0]);
    if (!x.allowed.includes(source)) errs.push(`${at} seat ${x.seat}: inputs_source ${source}, the RunSpec allows ${x.allowed.join(' | ')}`);
    const out: EpisodeSeat = { seat: x.seat, driver: x.driver, inputs_source: source };
    if (g?.agent) out.agent = g.agent;
    if (source !== 'seed_regenerated') {
      if (!g?.recorded_inputs) errs.push(`${at} seat ${x.seat}: a ${source} seat needs recorded_inputs {decisions, digest}`);
      else out.recorded_inputs = { ...g.recorded_inputs };
    } else if (g?.recorded_inputs) errs.push(`${at} seat ${x.seat}: an engine seat is regenerated from the seed and carries no recorded_inputs`);
    if (g?.peer) out.peer = { ...g.peer };
    return out;
  });
}

/** `recorded_inputs.digest` of a seat's action frames (episode_result.schema.json: sha256 over JCS of the array, decision order). */
export function recordedInputsDigest(actions: readonly unknown[]): string {
  return `sha256:${sha256Hex(canonicalize(actions))}`;
}

/** The fill of the non-target seats in member mode. */
export function resolvedFill(spec: ContractRunSpec): 'coordinated' | 'naive' | undefined {
  return seatModeOf(spec) === 'member' ? ((spec.seat as { fill?: 'coordinated' | 'naive' } | undefined)?.fill ?? 'coordinated') : undefined;
}

export function seedFor(spec: ContractRunSpec, index: number): number {
  return spec.seeds[index % spec.seeds.length];
}

/* ------------------------------------------------------------ run id -- */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-shaped: 10 chars of the start time (ms) + 16 chars of a digest of the inputs. */
export function deriveRunId(startedAt: string, digestHex: string): string {
  let ms = Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let bits = '';
  for (const c of digestHex.slice(0, 20)) bits += parseInt(c, 16).toString(2).padStart(4, '0');
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `run_${time}${rand}`;
}

/* ---------------------------------------------------- run-level oracles -- */

/** The replay hash that stands for a whole run: sha256 over the episodes' replay hashes sorted ascending, joined by "|". */
export function runReplayHash(episodes: readonly EpisodeResult[]): string {
  return `sha256:${sha256Hex([...episodes.map((e) => e.replay_hash)].sort().join('|'))}`;
}

export function computeRunOracles(scenarioId: ReportScenarioId, episodes: readonly EpisodeResult[]): Verdict[] {
  if (scenarioId !== 'grid_tactics') return [];
  const completed = episodes.filter((e) => e.status === 'completed' && (e.seat === 'A' || e.seat === 'B'));
  const v = gridWinRate(completed.map((e) => ({ outcome: e.outcome as 'win', seat: e.seat as 'A' | 'B' })));
  const out = toContractVerdict(v, runReplayHash(episodes)) as Verdict;
  delete out.seat; // spans both seats (report.schema.json: seat absent only on a run-level verdict spanning seats)
  return [out];
}

/* ------------------------------------------------------------ summary -- */

export function summarize(catalog: readonly CatalogOracle[], episodes: readonly EpisodeResult[], runOracles: readonly Verdict[]): Report['summary'] {
  const completed = episodes.filter((e) => e.status === 'completed');
  const aborted = episodes.length - completed.length;

  const outcomes: Report['summary']['outcomes'] = {};
  for (const o of OUTCOME_ORDER) {
    const n = episodes.filter((e) => e.outcome === o).length;
    if (n) outcomes[o] = n;
  }

  const all: Verdict[] = [...episodes.flatMap((e) => e.oracles), ...runOracles];
  const oracles: OracleSummary[] = catalog.map((c) => {
    const vs = all.filter((v) => v.oracle_id === c.oracle_id);
    const fails = vs.filter((v) => v.verdict === 'fail');
    const s: OracleSummary = {
      oracle_id: c.oracle_id,
      pass: vs.filter((v) => v.verdict === 'pass').length,
      fail: fails.length,
      not_assessed: vs.filter((v) => v.verdict === 'not_assessed').length,
    };
    if (fails.length) {
      const by: Partial<Record<Severity, number>> = {};
      for (const sev of SEVERITY_ORDER) {
        const n = fails.filter((v) => v.severity === sev).length;
        if (n) by[sev] = n;
      }
      s.fail_by_severity = by;
    }
    return s;
  });

  const anyErrorFail = all.some((v) => v.verdict === 'fail' && v.severity === 'error');
  const anyFail = all.some((v) => v.verdict === 'fail');
  const openGap = all.some((v) => v.verdict === 'not_assessed' && !NOT_APPLICABLE_REASONS.has(v.reason_code ?? ''));
  const verdict: Report['summary']['verdict'] = anyErrorFail ? 'fail' : !anyFail && !openGap && aborted === 0 ? 'pass' : 'inconclusive';

  const classes = completed.map((e) => e.trajectory_class ?? `unclassified:${e.episode_index}`);
  return {
    verdict,
    episodes_total: episodes.length,
    episodes_completed: completed.length,
    episodes_aborted: aborted,
    effective_episodes: effectiveEpisodes(classes),
    outcomes,
    oracles,
    within_budget_episodes: completed.filter((e) => e.budget.within_budget).length,
  };
}

/* ------------------------------------------------------ not assessed -- */

const KIND_ORDER: readonly NotAssessedKind[] = ['scenario', 'oracle', 'clause', 'seat', 'property'];
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** report.schema.json order: kind (scenario, oracle, clause, seat, property), then id, then seat (absent first). */
export function sortNotAssessed(entries: NotAssessedEntry[]): NotAssessedEntry[] {
  return entries.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmp(a.id, b.id) || cmp(a.seat ?? '', b.seat ?? ''));
}

/**
 * The `resim` entries of the not-assessed section: a pure function of the
 * catalog, the episodes and the run verdicts, so `verify` recomputes them.
 *  - scenario `no_episode_completed` when every episode aborted;
 *  - one oracle entry per (oracle, seat) with at least one not_assessed
 *    verdict (`oracle_not_assessed` when all were, else
 *    `oracle_partially_not_assessed`), and one per catalog oracle with no
 *    verdict at all;
 *  - one seat entry per recorded peer seat (`recorded_not_regenerated`, ADR-004 §5);
 *  - property `diplomacy.commitment_signatures` when commitments were attributed by session.
 */
export function computeNotAssessed(scenarioId: string, catalog: readonly CatalogOracle[], episodes: readonly EpisodeResult[], runOracles: readonly Verdict[]): NotAssessedEntry[] {
  const out: NotAssessedEntry[] = [];
  if (episodes.length > 0 && episodes.every((e) => e.status === 'aborted')) out.push({ kind: 'scenario', id: scenarioId, reason_code: 'no_episode_completed', basis: 'resim' });

  interface Group { seat?: VerdictSeat; total: number; na: Verdict[]; run: boolean }
  for (const c of catalog) {
    const groups = new Map<string, Group>();
    const add = (v: Verdict, seat: VerdictSeat | undefined, run: boolean) => {
      const key = seat ?? '';
      const g = groups.get(key) ?? { ...(seat ? { seat } : {}), total: 0, na: [], run };
      g.total++;
      if (v.verdict === 'not_assessed') g.na.push(v);
      groups.set(key, g);
    };
    for (const e of episodes) for (const v of e.oracles) if (v.oracle_id === c.oracle_id) add(v, v.seat ?? e.seat, false);
    for (const v of runOracles) if (v.oracle_id === c.oracle_id) add(v, v.seat, true);
    if (groups.size === 0) {
      out.push({ kind: 'oracle', id: c.oracle_id, reason_code: 'oracle_not_assessed', basis: 'resim', episodes: 0, verdict_reasons: {} });
      continue;
    }
    for (const g of groups.values()) {
      if (!g.na.length) continue;
      const reasons: Record<string, number> = {};
      for (const v of g.na) {
        const r = v.reason_code && /^[a-z][a-z0-9_]{0,63}$/.test(v.reason_code) ? v.reason_code : 'unspecified';
        reasons[r] = (reasons[r] ?? 0) + 1;
      }
      const sorted: Record<string, number> = {};
      for (const k of Object.keys(reasons).sort()) sorted[k] = reasons[k];
      out.push({
        kind: 'oracle',
        id: c.oracle_id,
        reason_code: g.na.length === g.total ? 'oracle_not_assessed' : 'oracle_partially_not_assessed',
        basis: 'resim',
        ...(g.seat ? { seat: g.seat } : {}),
        episodes: g.run ? episodes.length : g.na.length,
        verdict_reasons: sorted,
      });
    }
  }

  const peers = new Map<PlayerSeat, number>();
  for (const e of episodes) for (const s of e.seats ?? []) if (s.driver === 'recorded_peer') peers.set(s.seat, (peers.get(s.seat) ?? 0) + 1);
  for (const [seat, n] of peers) out.push({ kind: 'seat', id: seat, reason_code: 'recorded_not_regenerated', basis: 'resim', seat, episodes: n });

  const session = episodes.filter((e) => e.diplomacy?.sig_mode === 'session').length;
  if (session) out.push({ kind: 'property', id: 'diplomacy.commitment_signatures', reason_code: 'commitments_unsigned', basis: 'resim', episodes: session });
  return sortNotAssessed(out);
}

/* ------------------------------------------------------- consistency -- */

function consistencyErrors(spec: ContractRunSpec, episodes: readonly EpisodeResult[], catalog: readonly CatalogOracle[]): string[] {
  const errs: string[] = [];
  if (episodes.length !== spec.episodes) errs.push(`run_spec.episodes is ${spec.episodes} but ${episodes.length} episode results were given`);
  const mode = seatModeOf(spec);
  const fill = resolvedFill(spec);
  const episodeIds = catalog.filter((c) => c.level === 'episode').map((c) => c.oracle_id);
  episodes.forEach((e, i) => {
    const at = `episodes[${i}]`;
    if (!validateEpisodeResultSchema(e)) {
      errs.push(`${at} is not a valid EpisodeResult: ${formatErrors(validateEpisodeResultSchema.errors, 3).join('; ')}`);
      return;
    }
    if (e.episode_index !== i) errs.push(`${at}.episode_index is ${e.episode_index}, expected ${i}`);
    if (e.seed !== seedFor(spec, i)) errs.push(`${at}.seed is ${e.seed}, expected seeds[${i} mod ${spec.seeds.length}] = ${seedFor(spec, i)}`);
    if (e.scenario_id !== spec.scenario_id) errs.push(`${at}.scenario_id is ${e.scenario_id}, expected ${spec.scenario_id}`);
    if (e.mode !== mode) errs.push(`${at}.mode is ${e.mode}, expected ${mode}`);
    const seat = resolvedSeat(spec, i);
    if (seat === 'auto' ? !(POWERS as readonly string[]).includes(e.seat) : e.seat !== seat) errs.push(`${at}.seat is ${e.seat}, expected ${seat === 'auto' ? 'a power' : seat}`);
    errs.push(...seatProvenanceErrors(spec, e, at));
    if ((e.fill ?? undefined) !== fill) errs.push(`${at}.fill is ${e.fill ?? '(absent)'}, expected ${fill ?? '(absent)'}`);
    if (e.budget.tier !== spec.budget_tier) errs.push(`${at}.budget.tier is ${e.budget.tier}, expected ${spec.budget_tier}`);
    const ids = e.oracles.map((o) => o.oracle_id);
    if (ids.join() !== episodeIds.join()) errs.push(`${at}.oracles are [${ids.join(', ')}], expected catalog order [${episodeIds.join(', ')}]`);
    e.oracles.forEach((o, k) => {
      if (o.evidence_ref && o.evidence_ref.replay_hash !== e.replay_hash) errs.push(`${at}.oracles[${k}].evidence_ref.replay_hash does not repeat the episode replay_hash`);
    });
  });
  return errs;
}

/* -------------------------------------------------------------- build -- */

export function buildReport(input: BuildReportInput): Report {
  const { runSpec, engineBuild, scenarioVersion, startedAt, finishedAt } = input;
  const pre: string[] = [];
  if (!validateRunSpecSchema(runSpec)) pre.push(...formatErrors(validateRunSpecSchema.errors).map((m) => `run_spec${m}`));
  else {
    if (runSpec.episodes < runSpec.seeds.length) pre.push(`run_spec.episodes (${runSpec.episodes}) < len(seeds) (${runSpec.seeds.length}): a seed would be silently unused`);
    if (!isScenarioId(runSpec.scenario_id)) pre.push(`scenario ${runSpec.scenario_id} is not in this build's catalog`);
    if (runSpec.scenario_version && runSpec.scenario_version !== scenarioVersion) pre.push(`run_spec pins scenario_version ${runSpec.scenario_version} but ${scenarioVersion} ran`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(engineBuild)) pre.push(`engineBuild must be sha256:<64 lowercase hex>, got ${JSON.stringify(engineBuild).slice(0, 80)}`);
  const allowedScopes = allowedEngineBuildScopes(runSpec.scenario_id);
  if (input.engineBuildScope !== undefined && !allowedScopes.includes(input.engineBuildScope)) {
    pre.push(`engineBuild was hashed with scope ${String(input.engineBuildScope)}, but ${runSpec.scenario_id} reports record scope ${allowedScopes.join(' or ')}`);
  }
  let manifestDigest = input.engineSourceManifestDigest;
  if (manifestDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(manifestDigest)) pre.push(`engineSourceManifestDigest must be sha256:<64 lowercase hex>, got ${JSON.stringify(manifestDigest).slice(0, 80)}`);
  if (input.engineSourceManifest) {
    try {
      const m = input.engineSourceManifest;
      const d = engineSourceManifestDigest(m);
      if (manifestDigest !== undefined && manifestDigest !== d) pre.push(`engineSourceManifestDigest ${manifestDigest} is not the digest of the given manifest (${d})`);
      manifestDigest = d;
      const scope = input.engineBuildScope ?? engineBuildScopeFor(runSpec.scenario_id);
      const want = engineBuildDigestOf(m, scope).digest;
      if (want !== engineBuild) pre.push(`engineBuild ${engineBuild} is not the scope-${scope} digest of the given source manifest (${want})`);
    } catch (e) {
      pre.push((e as Error).message);
    }
  }
  for (const [k, e] of (input.notAssessed ?? []).entries()) {
    if (e.basis !== 'recorded') pre.push(`notAssessed[${k}] (${e.kind} ${e.id}): caller-supplied entries must have basis recorded; resim entries are computed from the episodes`);
  }
  if (input.mode === 'local' && input.hosted) pre.push('a report with run.hosted is a hosted report (mode hosted)');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) pre.push('finishedAt precedes startedAt');
  if (pre.length) throw new ReportBuildError('invalid report input', pre);

  const scenarioId = runSpec.scenario_id as ReportScenarioId;
  const catalog = oracleCatalog(scenarioId);
  const episodes = input.episodes.map((e) => JSON.parse(JSON.stringify(e)) as EpisodeResult);
  const seatErrs: string[] = [];
  episodes.forEach((e, i) => {
    const given = input.seats?.[i];
    if (!given || !e || typeof e !== 'object') return;
    if (e.seats) seatErrs.push(`episodes[${i}] already carries seats[]; pass its provenance in one place`);
    else e.seats = completeSeats(runSpec, e, given, `seats[${i}]`, seatErrs);
  });
  if (seatErrs.length) throw new ReportBuildError('seat provenance contradicts the RunSpec', seatErrs);
  const errs = consistencyErrors(runSpec, episodes, catalog);
  if (errs.length) throw new ReportBuildError('episode results contradict the RunSpec', errs);

  const runOracles = computeRunOracles(scenarioId, episodes);
  const tier = tierOf(runSpec.budget_tier);
  const spec = JSON.parse(JSON.stringify(runSpec)) as ContractRunSpec;
  const runId =
    input.runId ??
    deriveRunId(startedAt, sha256Hex(canonicalize({ spec, engineBuild, scenarioVersion, startedAt, finishedAt, replay: episodes.map((e) => e.replay_hash) })));
  const failureMode = failureModeId(scenarioId);
  const refPolicy = referencePolicy(spec, input.referencePolicyPin ?? input.engineCommit);
  const hosted = input.hosted ? (JSON.parse(JSON.stringify(input.hosted)) as HostedRecord) : undefined;
  const notAssessed = input.emitNotAssessed === false ? undefined : sortNotAssessed([...computeNotAssessed(scenarioId, catalog, episodes, runOracles), ...(input.notAssessed ?? []).map((e) => JSON.parse(JSON.stringify(e)) as NotAssessedEntry)]);

  const report: Report = {
    report_version: '1.0',
    run: {
      run_id: runId,
      mode: input.mode ?? (hosted ? 'hosted' : 'local'),
      started_at: startedAt,
      finished_at: finishedAt,
      tool: input.tool ?? { name: TOOL_NAME, version: TOOL_VERSION },
      spec,
      ...(input.targetOwnership ? { target_ownership: { ...input.targetOwnership } } : {}),
      ...(hosted ? { hosted } : {}),
    },
    engine: {
      build_hash: engineBuild,
      ...(input.engineBuildScope ? { build_scope: input.engineBuildScope } : {}),
      ...(manifestDigest ? { source_manifest_digest: manifestDigest } : {}),
      version: input.engineVersion ?? DEFAULT_ENGINE_VERSION,
      ...(input.engineCommit ? { commit: input.engineCommit } : {}),
    },
    scenario: {
      scenario_id: scenarioId,
      version: scenarioVersion,
      ...(failureMode ? { failure_mode_id: failureMode } : {}),
      ...(refPolicy ? { reference_policy: refPolicy } : {}),
      oracles: catalog,
    },
    budget_limits: {
      tier: tier.id,
      soft_deadline_ms: tier.softDeadlineMs,
      hard_deadline_ms: tier.hardDeadlineMs,
      hard_miss_forfeit: 3,
      token_allowance: tier.actionAllowance,
      tick_cap: 120,
      max_orders_per_unit: 1,
      max_inbound_frame_bytes: scenarioId === DIPLOMACY_SCENARIO_ID ? 16384 : 8192,
    },
    episodes,
    run_oracles: runOracles,
    summary: summarize(catalog, episodes, runOracles),
    disclosure: { conflict_of_interest: CONFLICT_OF_INTEREST, determinism: DETERMINISM_NOTE },
    ...(notAssessed ? { not_assessed: notAssessed } : {}),
  };

  if (tier.hardMissForfeit !== 3 || tier.tickCap !== 120 || tier.maxInboundFrameBytes !== 8192) {
    throw new ReportBuildError('tier table drifted from the contract', [`${tier.id}: forfeit ${tier.hardMissForfeit}, tick cap ${tier.tickCap}, frame cap ${tier.maxInboundFrameBytes}`]);
  }
  if (!validateReportSchema(report)) throw new ReportBuildError('report does not validate against report.schema.json', formatErrors(validateReportSchema.errors));
  return report;
}
