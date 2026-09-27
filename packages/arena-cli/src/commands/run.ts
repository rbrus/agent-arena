/**
 * `agent-arena run`: validate everything (spec, credentials, misuse guard)
 * BEFORE any network I/O, then play N seeded episodes in-process against the
 * target and write report.json + report.sarif (+ per-episode replay and record
 * files) to --out. Exit code per EXIT_CODES / exitCodeForReport.
 */

import { join, resolve } from 'node:path';
import { anchorFor as frozenAnchorFor, GATE_SEEDS_BYZANTINE, SCENARIO_IDS, scenarioModule, type DipFill, type EpisodeRecord, type ScenarioId, type SeatId, type TargetDriver } from 'arena-scenarios';
import { engineBuildFor, ENGINE_VERSION, USER_AGENT, VERSION } from '../build-info.ts';
import { validateReportSchema, type HostedRecord, type NotAssessedEntry } from 'arena-report';
import { assertNoLiteralSecrets, loadCredential, parseAuthFlags, redactUrl, type AuthSpec } from '../credentials.ts';
import { DIP_FILL_LABEL, DIP_IN_PROCESS, DIPLOMACY, dipValidity, parseDipFlags, profileOfFill, type DipRunOptions } from '../diplomacy.ts';
import { CliError, describeError, misconfig, runError } from '../errors.ts';
import { writeOutput, writeRaw } from '../files.ts';
import { newRunId } from '../ids.ts';
import { effectiveRps, isLoopbackLiteral, NetContext, networkPolicyLabel, policyFor, checkUrl, NetBlockedError, type Credential, type NetPolicy, type Resolver } from '../net/index.ts';
import { requireOwnership, targetOwnership } from '../ownership.ts';
import { isPackScenarioId, openCliPackRefusal } from '../hosted/packs.ts';
import { addHostedPeerAddress } from '../hosted/log-filter.ts';
import { buildReplayFile } from '../replay-file.ts';
import {
  buildReport,
  exitCodeForReport,
  primarySeats,
  recordedInputsDigest,
  toFileJson,
  toSarif,
  validateRunSpecSchema,
  type EpisodeResult,
  type ExitCode,
  type ContractRunSpec,
  type RunSpec,
  type SeatProvenanceInput,
  type Severity,
} from '../report.ts';
import { inProcessDriver, recordedActionsOf } from '../rerun.ts';
import type { RunSpecContract } from '../generated/contracts.ts';
import { DEFAULT_MAX_RETRY_AFTER_S, MAX_RETRY_AFTER_CAP_S, newTargetRunState, playEpisode, REPORT_BASE, requestCeiling, type EpisodePlan } from '../runner.ts';
import { createTransport, TRANSPORTS, type Transport, type TransportName } from '../transports/index.ts';
import { info, isJson, out, outJson, warn } from '../ui.ts';
import { credentialShapeHits, registeredVariants } from '../redact.ts';

export interface RunFlags {
  scenario?: string;
  seat?: string;
  position?: string;
  fill?: string;
  tier?: string;
  seeds?: string;
  episodes?: string;
  target?: string;
  transport?: string;
  auth?: string;
  authHeader?: string;
  out?: string;
  allowPrivate?: boolean;
  allowLinkLocal?: boolean;
  ownTarget?: boolean;
  followRedirects?: boolean;
  allowQuerySecret?: boolean;
  allowInsecureTransport?: boolean;
  maxRps?: string;
  failOn?: string;
  label?: string;
  hosted?: boolean;
  ci?: string;
  /** Seconds of `Retry-After` the run honours before it aborts (default 30, max 3600). */
  maxRetryAfter?: string;
  /** diplomacy_standard: last game year played (1901..1908, default 1906). */
  horizon?: string;
  /** diplomacy_standard: `--secret` was given (hosted only; refused locally). The value is never read. */
  secret?: boolean;
  /** Tests only: an injected resolver for the rebinding tests. */
  resolver?: Resolver;
  /** `--spec`: the attestation came from the file's `target.ownership_attested` (recorded as `source: run_spec`). */
  ownershipSource?: 'run_spec';
  /** `--spec`: the file's own labels (the CLI's `arena.*` labels are written over them). */
  specLabels?: Record<string, string>;
  /** `--spec`: the file as a repo-relative path, the SARIF location (sarif-mapping.md §4); undefined = write .agent-arena/. */
  specFileLocation?: string;
}

/** The RunSpec `budget_tier` enum (contracts 2.10.0 adds `extended`; `league` was never a tier). */
export const TIERS = ['edge', 'core', 'frontier', 'extended'] as const;
/** G-55 feature check: does this build's report schema carry the additive `run.hosted.observed_truncated` marker? */
export const OBSERVED_TRUNCATED_IN_CONTRACT = reportSchemaHasHostedMember('observed_truncated');
/** Where a hosted run writes the manifest it ran from (contracts `run.hosted.run_manifest.path`). */
export const HOSTED_MANIFEST_FILE = 'run-manifest.json';
/** Where a flag-driven local run records its RunSpec for the SARIF location (sarif-mapping.md §4), under the working directory. */
export const RUN_SPEC_DIR = '.agent-arena';
const IN_PROCESS: Record<string, TargetDriver> = {
  'ref:coordinated': 'ref:coordinated',
  'ref:naive': 'ref:naive',
  'ref:reflex': 'ref:reflex',
  'ref:null': 'ref:null',
  'ref:silver': 'ref:silver',
};

/**
 * The SARIF location of a local run (sarif-mapping.md §4: "the RunSpec file, repo-relative (CLI
 * `--spec`); when the run was given by flags, the CLI writes `.agent-arena/<scenario_id>.run.json`
 * and uses that path"). The file is the RunSpec as run, written under the working directory with the
 * same no-follow, redact-then-inert writer as every output. A directory that cannot be written costs
 * a warning, not the run: the report and SARIF are still written.
 */
function sarifSpecLocation(p: Pick<ExecutePlan, 'specFileLocation'>, scenario: ScenarioId, spec: ContractRunSpec): string {
  if (p.specFileLocation) return p.specFileLocation;
  const rel = `${RUN_SPEC_DIR}/${scenario}.run.json`;
  try {
    writeOutput(resolve(rel), toFileJson(spec));
  } catch (e) {
    warn(`could not write ${rel} (${describeError(e).message}); the SARIF location names it but the file is missing. Next: run from a writable directory (your repository root in CI).`);
  }
  return rel;
}

/** Does report.schema.json (as bundled) declare `run.hosted.<member>`? A feature check for additive contract fields. */
export function reportSchemaHasHostedMember(member: string): boolean {
  const schema = validateReportSchema.schema as { properties?: { run?: { properties?: { hosted?: { properties?: Record<string, unknown> } } } } } | undefined;
  return Object.hasOwn(schema?.properties?.run?.properties?.hosted?.properties ?? {}, member);
}

function parseSeeds(s: string | undefined): number[] {
  if (s === undefined) return [...GATE_SEEDS_BYZANTINE];
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 1000) throw misconfig('--seeds takes 1..1000 comma-separated integers, e.g. --seeds 20260720,1,2,3,5.');
  return parts.map((p) => {
    if (!/^\d{1,10}$/.test(p) || Number(p) > 0xffffffff) throw misconfig(`--seeds: "${p.slice(0, 20)}" is not a uint32.`);
    return Number(p);
  });
}

function inferTransport(u: URL): TransportName {
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return 'ws';
  if (/\/\.well-known\/agent(-card)?\.json$/.test(u.pathname)) return 'a2a';
  if (/\/mcp\/?$/.test(u.pathname)) return 'mcp';
  return 'rest';
}

export function resolveSeat(scenario: ScenarioId, f: Pick<RunFlags, 'seat' | 'position' | 'fill'>): RunSpec['seat'] {
  const isDuel = scenario === 'grid_tactics';
  let mode = f.seat;
  let position = f.position;
  if (mode && /^m[0-4]$/.test(mode)) [mode, position] = ['member', mode];
  if (mode && /^[AB]$/.test(mode)) [mode, position] = ['duel', mode];
  mode ??= isDuel ? 'duel' : 'member';
  if (isDuel && mode !== 'duel') throw misconfig(`grid_tactics is a duel: use --seat duel (optionally --position A|B).`);
  if (!isDuel && mode === 'duel') throw misconfig(`${scenario} is an encounter: use --seat squad (the target plays all five members) or --seat member.`);
  if (mode !== 'duel' && mode !== 'squad' && mode !== 'member') throw misconfig(`--seat must be duel, squad or member (or m0..m4 / A / B).`);
  if (mode === 'squad') {
    if (position || f.fill) throw misconfig('--seat squad takes no --position or --fill (the target controls every member).');
    return { mode };
  }
  if (mode === 'duel') {
    if (f.fill) throw misconfig('--fill applies to --seat member only.');
    if (position && position !== 'A' && position !== 'B') throw misconfig('--position for a duel is A or B (absent = A on even episodes, B on odd).');
    return { mode, ...(position ? { position: position as 'A' | 'B' } : {}) };
  }
  if (position && !/^m[0-4]$/.test(position)) throw misconfig('--position for --seat member is m0..m4 (default m1).');
  if (f.fill && f.fill !== 'coordinated' && f.fill !== 'naive') throw misconfig('--fill is coordinated or naive.');
  return { mode, ...(position ? { position: position as 'm1' } : {}), ...(f.fill ? { fill: f.fill as 'naive' } : {}) };
}

/** The reference policies a frozen anchor can be keyed by, per scenario family. */
const ANCHOR_POLICIES: Record<'duel' | 'raid', readonly string[]> = { duel: ['reflex', 'null', 'silver'], raid: ['coordinated', 'naive'] };

/**
 * Which frozen anchor (if any) an episode's hash reproduces: the quickstart's
 * "is it working?" signal. Keyed lookup (arena-scenarios `anchorFor`) by
 * scenario, seat, tier, seed and member fill; the target's policy is unknown
 * (it may be any agent), so each reference policy is tried and the anchor
 * counts only when its replay hash equals the episode's.
 */
export function anchorFor(ep: EpisodeResult, tier: string, fill?: 'coordinated' | 'naive' | DipFill, horizonYear?: number): string | undefined {
  if (!SCENARIO_IDS.includes(ep.scenario_id as ScenarioId)) return undefined;
  if (ep.scenario_id === DIPLOMACY) {
    // Engine golden tables (seed 20261115, germany, core, horizon 1904): a match needs the replay,
    // transcript AND engine evaluation hashes to agree.
    for (const policy of ['robust', 'credulous']) {
      const a = frozenAnchorFor({ scenario: DIPLOMACY, seat: ep.seat as SeatId, tier: tier as 'core', seed: ep.seed, policy, fill: fill as DipFill, horizonYear });
      const d = ep.diplomacy as { engine_evaluation_hash?: string } | undefined;
      if (a && 'transcriptHash' in a && a.replayHash === ep.replay_hash && a.transcriptHash === ep.transcript_hash && a.engineEvaluationHash === d?.engine_evaluation_hash) return a.name;
    }
    return undefined;
  }
  const policies = ANCHOR_POLICIES[ep.scenario_id === 'grid_tactics' ? 'duel' : 'raid'];
  for (const policy of policies) {
    const a = frozenAnchorFor({
      scenario: ep.scenario_id as ScenarioId,
      seat: ep.seat as SeatId,
      tier: tier as 'core',
      seed: ep.seed,
      policy,
      ...(ep.mode === 'member' ? { fill: (fill as 'coordinated' | 'naive' | undefined) ?? 'coordinated' } : {}),
    });
    if (a && a.replayHash === ep.replay_hash) return a.name;
  }
  return undefined;
}

/**
 * contracts 2.2.0 seat provenance for one episode: every seat the target
 * plays is `recorded`, committed to by the digest of its action array
 * (`inputs[t][seat] ?? null`, decision order). Engine seats are completed by
 * the report builder as `seed_regenerated`.
 */
export function targetSeatInputs(rec: EpisodeRecord, ep: EpisodeResult): SeatProvenanceInput[] {
  return primarySeats(ep.mode, ep.seat as never).map((seat) => {
    const actions = recordedActionsOf(rec, seat);
    return { seat, recorded_inputs: { decisions: actions.length, digest: recordedInputsDigest(actions) } };
  });
}

/** GitHub workflow-command data escaping (`%`, CR, LF), so a mask value is taken literally. */
function escapeCommandData(v: string): string {
  return v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export interface RunResult {
  exitCode: ExitCode;
  outDir: string;
}

export async function runCommand(f: RunFlags, argv: readonly string[]): Promise<RunResult> {
  // `--hosted` is its own entry point (commands/run-hosted.ts, dispatched by main.ts): a manifest-only mode.
  if (f.hosted) throw misconfig('--hosted runs are driven by a signed run manifest: agent-arena run --hosted --manifest <path> --manifest-key <key> [--out <dir>] [--json].', 'drop --hosted for a local run; local runs need no server.');
  // ── 1. Validate everything before any I/O ──
  const scenario = f.scenario as ScenarioId;
  if (!scenario) throw misconfig('--scenario is required.', `pick one of: ${SCENARIO_IDS.join(', ')} (agent-arena list-scenarios).`);
  // RESERVED.md (K5): a pack id is refused before any I/O; nothing is fetched or looked up.
  if (isPackScenarioId(scenario)) throw openCliPackRefusal(scenario);
  if (!SCENARIO_IDS.includes(scenario)) throw misconfig(`unknown scenario "${String(f.scenario).slice(0, 40)}".`, `pick one of: ${SCENARIO_IDS.join(', ')}.`);
  const isDip = scenario === DIPLOMACY;
  if (!isDip && f.horizon !== undefined) throw misconfig('--horizon applies to diplomacy_standard only.', `drop --horizon (${scenario} episodes end at their own terminal or the 120-tick cap).`);
  const tier = (f.tier ?? 'core') as (typeof TIERS)[number];
  if (!TIERS.includes(tier)) throw misconfig('--tier must be edge, core, frontier or extended.');
  const seeds = parseSeeds(f.seeds);
  const episodes = f.episodes === undefined ? seeds.length : Number(f.episodes);
  if (!Number.isInteger(episodes) || episodes < 1 || episodes > 1000) throw misconfig('--episodes must be an integer 1..1000.');
  if (episodes < seeds.length) throw misconfig(`--episodes ${episodes} is smaller than the ${seeds.length} seeds given; a seed would be silently unused.`, `pass --episodes ${seeds.length} or fewer seeds.`);
  const failOn = (f.failOn ?? 'error') as Severity;
  if (!['error', 'warning', 'note'].includes(failOn)) throw misconfig('--fail-on must be error, warning or note.');
  const maxRetryAfterS = f.maxRetryAfter === undefined ? DEFAULT_MAX_RETRY_AFTER_S : Number(f.maxRetryAfter);
  if (!Number.isFinite(maxRetryAfterS) || maxRetryAfterS < 0 || maxRetryAfterS > MAX_RETRY_AFTER_CAP_S) {
    throw misconfig(`--max-retry-after takes seconds, 0..${MAX_RETRY_AFTER_CAP_S}.`, `e.g. --max-retry-after ${DEFAULT_MAX_RETRY_AFTER_S}`);
  }
  // Diplomacy flags are checked before the generic literal-secret guard, so `--secret` gets its own message.
  const dip: DipRunOptions | undefined = isDip ? parseDipFlags({ seat: f.seat, position: f.position, fill: f.fill, horizon: f.horizon, secret: f.secret }, seeds) : undefined;
  const seat = dip ? undefined : resolveSeat(scenario, f);
  if (!f.target) {
    throw misconfig('--target is required.', 'start the included reference agent with `npm run target:reference -- --port 8080` and pass --target http://localhost:8080, or use --target ref:coordinated for an in-process run.');
  }

  const inProcess = isDip ? (f.target.startsWith('ref:') ? f.target : undefined) : IN_PROCESS[f.target];
  let url: URL | null = null;
  let transport: TransportName = 'rest';
  let auth: AuthSpec | undefined;
  if (!inProcess) {
    try {
      url = new URL(f.target);
    } catch {
      throw misconfig(`--target "${f.target.slice(0, 80)}" is not a URL.`, 'use http(s)://host:port/path, ws(s)://…, or ref:coordinated for an in-process reference.');
    }
    assertNoLiteralSecrets(argv, url, !!f.allowQuerySecret);
    if (f.transport !== undefined && !TRANSPORTS.includes(f.transport as TransportName)) throw misconfig('--transport must be rest, ws, mcp or a2a.');
    transport = (f.transport as TransportName | undefined) ?? inferTransport(url);
    if (transport === 'ws' ? !/^wss?:$/.test(url.protocol) : !/^https?:$/.test(url.protocol)) {
      throw misconfig(`--transport ${transport} needs a ${transport === 'ws' ? 'ws:// or wss://' : 'http:// or https://'} URL, got ${url.protocol}//.`);
    }
    auth = parseAuthFlags(f.auth, f.authHeader);
  } else {
    assertNoLiteralSecrets(argv, null, false);
    if (f.auth) throw misconfig('--auth makes no sense for an in-process reference target.');
    if (isDip) {
      if (!DIP_IN_PROCESS[f.target]) throw misconfig(`${f.target.slice(0, 40)} is not a reference for ${scenario}.`, 'use ref:robust, ref:credulous or ref:house (ref:coordinated / ref:naive are aliases of the pair).');
    } else if (scenario === 'grid_tactics' ? !['ref:coordinated', 'ref:naive', 'ref:reflex', 'ref:null', 'ref:silver'].includes(f.target) : !['ref:coordinated', 'ref:naive'].includes(f.target)) {
      throw misconfig(`${f.target} is not a reference for ${scenario}.`, scenario === 'grid_tactics' ? 'use ref:reflex, ref:null or ref:silver.' : 'use ref:coordinated or ref:naive.');
    }
  }
  // The same alias resolution verify applies to the RunSpec target (G-33).
  const driver: TargetDriver | undefined = inProcess ? inProcessDriver(scenario, inProcess) : undefined;

  const policy = url ? policyFor(url, { allowPrivate: f.allowPrivate, allowLinkLocal: f.allowLinkLocal }) : null;
  const loopback = url ? isLoopbackLiteral(url) : true;
  // Misuse guard (threat model §8.1): non-loopback targets need an explicit ownership attestation.
  requireOwnership({ inProcess: !!inProcess, loopback, attested: !!f.ownTarget, url });
  if (url && policy) {
    try {
      checkUrl(url, policy);
    } catch (e) {
      if (e instanceof NetBlockedError) throw misconfig(e.message);
      throw e;
    }
    if (auth && !loopback && (url.protocol === 'http:' || url.protocol === 'ws:') && !f.allowInsecureTransport) {
      throw misconfig('refusing to send a credential over plain http/ws to a non-loopback host.', 'use https/wss, or pass --allow-insecure-transport if you accept the token crossing the network in clear text.');
    }
  }
  const rps = effectiveRps(f.maxRps === undefined ? undefined : Number(f.maxRps), loopback);

  const ownership = targetOwnership({ inProcess: !!inProcess, loopback, attested: !!f.ownTarget, ...(f.ownTarget && f.ownershipSource ? { source: f.ownershipSource } : {}) });
  // The network policy has no contract field yet: carried as a RunSpec label (copied verbatim into the report).
  // A --spec file's own labels come first; the CLI's arena.* labels are written over them.
  const labels: Record<string, string> = { ...(f.specLabels ?? {}), 'arena.network_policy': policy ? networkPolicyLabel(policy) : 'in-process' };
  // contracts 2.4.0: the fill is `diplomacy.fill`. DEPRECATED: the `arena.diplomacy_fill` label is still
  // written for one version, so a verifier from before 2.4.0 keeps checking it; removed in the next release.
  if (dip) labels[DIP_FILL_LABEL] = dip.fill;
  // Typed against the GENERATED contract type (codegen.mjs), then handed to the report builder.
  const specContract = {
    scenario_id: scenario,
    scenario_version: scenarioModule(scenario).describe().version,
    seeds: seeds as [number, ...number[]],
    episodes,
    budget_tier: tier,
    ...(dip ? { seat: { mode: 'power' as const, position: dip.seat }, diplomacy: { profile: profileOfFill(dip.fill), horizon_year: dip.horizonYear, fill: dip.fill } } : { seat }),
    target: url
      ? { transport, url: redactUrl(url), ...(auth ? { auth } : {}), ...(f.label ? { label: f.label.slice(0, 64) } : {}), ...(f.ownTarget ? { ownership_attested: true } : {}) }
      : { transport: 'rest' as const, url: `http://in-process.invalid/${inProcess}`, label: `in-process reference ${inProcess}` },
    labels,
  } satisfies RunSpecContract;
  const spec: ContractRunSpec = specContract;
  if (!validateRunSpecSchema(spec)) {
    const e = (validateRunSpecSchema.errors ?? []).slice(0, 3).map((x) => `${x.instancePath || '/'} ${x.message}`).join('; ');
    throw misconfig(`the run spec is invalid against run_spec.schema.json: ${e}.`);
  }

  // Credentials last among the checks (the value is registered with the redactor on load).
  const loaded = auth ? loadCredential(auth) : undefined;
  // G-24: mask every registered form (bare token, `Bearer <tok>`, base64/base64url, URL-encoded, …)
  // before anything else is printed; on stderr in --json mode so stdout stays one JSON document.
  if (loaded && f.ci === 'github' && process.env.GITHUB_ACTIONS === 'true') {
    const sink = isJson() ? process.stderr : process.stdout;
    for (const v of registeredVariants()) sink.write(`::add-mask::${escapeCommandData(v)}\n`);
  }

  if (dip) {
    info(
      f.fill === undefined
        ? `diplomacy_standard: fill ${dip.fill} (profile ${profileOfFill(dip.fill)}, the RunSpec default); pass --fill house for the clean profile.`
        : `diplomacy_standard: fill ${dip.fill} (profile ${profileOfFill(dip.fill)}).`,
    );
  }
  return executeRun({
    scenario,
    tier,
    seeds,
    episodes,
    seat,
    dip,
    url,
    transport,
    inProcess,
    driver,
    policy,
    credential: loaded?.credential,
    authRef: auth?.ref,
    loopback,
    rps,
    maxRetryAfterS,
    failOn,
    followRedirects: !!f.followRedirects,
    spec,
    labels,
    ownership,
    outDir: resolve(f.out ?? 'arena-report'),
    runId: newRunId(),
    userAgent: USER_AGENT,
    resolver: f.resolver,
    ...(f.specFileLocation ? { specFileLocation: f.specFileLocation } : {}),
  });
}

/**
 * Everything a validated run needs. The local path (`runCommand`) and the hosted
 * path (`commands/run-hosted.ts`) both end in `executeRun`: ONE implementation of
 * connect, play, report (HOSTED-PROFILE §2.4: "a stricter mode of the same code
 * path"), so the hosted runner cannot score differently.
 */
export interface ExecutePlan {
  scenario: ScenarioId;
  tier: (typeof TIERS)[number];
  seeds: number[];
  episodes: number;
  /** Non-Diplomacy seating (undefined for diplomacy_standard). */
  seat?: RunSpec['seat'];
  dip?: DipRunOptions;
  /** Hosted Diplomacy: the per-episode secret (index = episode index); locally every episode plays with ''. */
  dipSecrets?: readonly string[];
  url: URL | null;
  transport: TransportName;
  inProcess?: string;
  driver?: TargetDriver;
  policy: NetPolicy | null;
  credential?: Credential;
  /** The auth REFERENCE (printed; never the value). */
  authRef?: string;
  loopback: boolean;
  rps: number;
  maxRetryAfterS: number;
  failOn: Severity;
  followRedirects: boolean;
  /** The RunSpec recorded in the report (hosted: byte-for-byte the manifest-bound one). */
  spec: ContractRunSpec;
  /** The spec's labels object, mutated after the run (press redaction count); null = the spec is frozen (hosted). */
  labels: Record<string, string> | null;
  ownership: { loopback: boolean; attested: boolean; source?: 'cli_flag' | 'run_spec' | 'sixi_verified' };
  outDir: string;
  runId: string;
  userAgent: string;
  hosted?: HostedExecution;
  resolver?: Resolver;
  /** Local `--spec` run: the spec file, repo-relative, used as the SARIF location instead of writing .agent-arena/. */
  specFileLocation?: string;
}

/** The hosted additions to a run (commands/run-hosted.ts). */
export interface HostedExecution {
  /** `run.hosted` without `observed_connections` (added from the NetContext after the run). */
  record: HostedRecord & { verified_origin: { origin: string; method: string } };
  /** Recorded `not_assessed` entries (packs, standing hosted exclusions). */
  notAssessed: (episodes: readonly EpisodeResult[]) => NotAssessedEntry[];
  /** The run manifest exactly as received, written to `<out>/run-manifest.json`. */
  manifestText: string;
  /**
   * `performance.now()` instant of the manifest's wall_clock_deadline: no episode starts after it,
   * and (G-54) no decision runs past it: the in-flight decision is cut there as a hard miss and the
   * run is aborted (`deadline_exceeded`, exit 2, nothing written: the seal step records seal_failed).
   */
  deadline: number;
  /** The manifest's wall_clock_deadline as written (for the refusal text). */
  deadlineIso?: string;
  /**
   * Tests only (programmatic; no flag or variable reaches it): build the transport
   * from the hosted NetContext. Production always uses `createTransport`.
   */
  transportFactory?: (ctx: NetContext, url: URL, name: TransportName) => Transport;
}

export async function executeRun(p: ExecutePlan): Promise<RunResult> {
  const { scenario, tier, seeds, episodes, seat, dip, url, transport, inProcess, driver, policy, loopback, rps, maxRetryAfterS, failOn, spec, labels, outDir, runId } = p;
  const hosted = p.hosted;
  const { scope: engineScope, digest, manifestDigest } = engineBuildFor(scenario);
  // threat-model-hosted §2.4: hosted logs name the run (X-Agent-Arena-Run / run_id), never the customer's origin.
  const where = (u: URL) => (hosted ? 'the verified origin' : redactUrl(u));

  // ── 2. Connect ──
  info(
    dip
      ? `agent-arena ${VERSION}: ${scenario} · power ${dip.seat} · fill ${dip.fill} · horizon ${dip.horizonYear} · ${tier} tier · ${episodes} episode(s) · seeds ${seeds.join(',')}`
      : `agent-arena ${VERSION}: ${scenario} · ${seat?.mode ?? 'default'} seating · ${tier} tier · ${episodes} episode(s) · seeds ${seeds.join(',')}`,
  );
  if (url) {
    // Threat model §8.1: the per-run request ceiling, printed before the first request.
    const c = requestCeiling(transport, tier, episodes);
    info(`request ceiling: at most ${c.requests} requests to ${where(url)} (${episodes} episode(s) × ≤ ${c.decisionsPerEpisode} decisions${c.extra ? `, ${c.extra}` : ''}); rate ${rps > 0 ? `${rps}/s` : 'unlimited (loopback)'}; Retry-After honoured up to ${maxRetryAfterS} s`);
  }
  let target: Transport | null = null;
  let ctx: NetContext | null = null;
  if (url && policy) {
    if (policy.loopbackLiteral) info(`network: loopback-literal opt-in for ${url.host} (you typed a loopback address; only loopback addresses will be dialed)`);
    if (policy.allowPrivate) info('network: --allow-private is on; every private-address connection is logged');
    if (policy.allowLinkLocal) warn('network: --allow-link-local is on: link-local and cloud-metadata addresses can be dialed');
    if (hosted) info(`network: hosted-v1 (allowlist: the verified origin only; public addresses only; no redirects); ownership: sixi_verified (${hosted.record.verified_origin.method}); rate limit ${rps} requests/s; run ${runId}`);
    else if (!loopback) info(`ownership: self-attested (--i-own-this-target); rate limit ${rps} requests/s`);
    ctx = new NetContext({
      policy,
      target: url,
      credential: p.credential,
      userAgent: p.userAgent,
      runId,
      rps,
      followRedirects: p.followRedirects,
      onOptIn: (line) => info(`network: ${line}`),
      resolver: p.resolver,
      // G-45: every address resolved or dialed for the verified origin is filtered out of the log lines too.
      ...(hosted ? { onPeerAddress: addHostedPeerAddress } : {}),
    });
    target = hosted?.transportFactory ? hosted.transportFactory(ctx, url, transport) : createTransport(transport, ctx, url);
    info(`target: ${transport} ${where(url)}${p.authRef ? ` (auth ${p.authRef})` : ''}`);
    try {
      await target.connect(performance.now() + 10_000);
    } catch (e) {
      await target.close();
      if (e instanceof CliError) throw e;
      throw new CliError(`could not connect to the target over ${transport} at ${where(url)}: ${describeError(e).message}.`, 2, hosted ? 'the verified origin did not answer from the Sixi egress; check that it is up and reachable from the published egress IPs.' : 'check that the agent is running and that --transport matches what it serves.');
    }
  } else info(`target: in-process reference ${inProcess} (no network)`);

  // ── 3. Play ──
  const startedAt = new Date().toISOString();
  const results: EpisodeResult[] = [];
  const records: EpisodeRecord[] = [];
  /** diplomacy_standard: episodes a reference seat invalidated (every target verdict not_assessed / episode_invalid). */
  const invalid: { index: number; by: string[] }[] = [];
  const state = newTargetRunState({ maxRetryAfterMs: maxRetryAfterS * 1000 });
  try {
    for (let i = 0; i < episodes; i++) {
      if (hosted && performance.now() > hosted.deadline) {
        throw runError(`the run reached its wall-clock deadline (manifest wall_clock_deadline) after ${i} of ${episodes} episode(s); no further episode was started.`, 'the plan cap bounds hosted runs; start a new run with fewer episodes or a faster target.');
      }
      const s = seeds[i % seeds.length];
      const mode = dip ? 'power' : (seat?.mode ?? (scenario === 'grid_tactics' ? 'duel' : 'member'));
      const plan: EpisodePlan = {
        index: i,
        scenarioId: scenario,
        seed: s,
        tier,
        mode,
        seat: dip ? dip.seat : mode === 'squad' ? 'squad' : mode === 'duel' ? (seat?.position ?? (i % 2 === 0 ? 'A' : 'B')) : (seat?.position ?? 'm1'),
        ...(mode === 'member' ? { fill: seat?.fill ?? 'coordinated' } : {}),
        ...(dip ? { diplomacy: { ...dip, secret: p.dipSecrets?.[i] ?? dip.secret } } : {}),
        engineCommit: digest,
        // HOSTED-PROFILE §2.4 step 9 / bundle_manifest paths: episodes/<i>.{record,replay}.json.
        ...(hosted ? { replayRef: `episodes/${i}.replay.json` } : {}),
      };
      const redactionsBefore = state.pressRedactions;
      const { result, record } = await playEpisode(plan, {
        transport: target,
        inProcess: driver,
        transportName: inProcess ? 'in-process' : transport,
        targetLabel: url ? where(url) : String(inProcess),
        state,
        ...(hosted ? { unreachableHint: 'the verified origin did not answer from the Sixi egress: check that it resolves to public addresses, is up, and admits the published egress IPs (nothing further was sent).', runDeadline: { at: hosted.deadline, iso: hosted.deadlineIso ?? 'wall_clock_deadline' } } : {}),
      });
      // contracts 2.5.0 `budget.press.redactions` (G-40): per Diplomacy episode driven over a transport, 0 included.
      if (dip && url && result.budget && typeof result.budget === 'object') {
        const b = result.budget as { press?: Record<string, number> };
        b.press = { ...(b.press ?? {}), redactions: state.pressRedactions - redactionsBefore };
      }
      results.push(result);
      records.push(record);
      const anchor = hosted ? undefined : anchorFor(result, tier, dip ? dip.fill : plan.fill, dip?.horizonYear);
      const validity = dipValidity(record);
      if (!validity.valid) invalid.push({ index: i, by: validity.invalidBy });
      info(
        `episode ${i} seed ${s} ${result.seat}: ${result.outcome} at tick ${result.terminal_tick}  ${result.replay_hash.slice(0, 23)}…${result.transcript_hash ? `  transcript ${result.transcript_hash.slice(0, 23)}…` : ''}${anchor ? `  anchor: match (${anchor})` : ''}${validity.valid ? '' : `  episode_invalid (${validity.invalidBy.slice(0, 3).join(', ')})`}`,
      );
    }
  } finally {
    await target?.close();
  }
  const finishedAt = new Date().toISOString();
  // G-40: press redacted at the edge is counted per episode in `budget.press.redactions` (contracts 2.5.0).
  // The per-run RunSpec label `arena.press_redactions` is withdrawn at contracts 2.6.0 (RESERVED.md) and no longer written.
  if (dip && state.pressRedactions > 0) warn(`${state.pressRedactions} span(s) of credential-shaped target press were redacted at the edge (counted per episode in budget.press.redactions)`);

  // ── 4. Report ──
  const observed = ctx?.observedConnections() ?? [];
  // G-55: a cut list is never silent. The contract has no marker field yet (report.schema.json run.hosted is closed);
  // the marker is written as `observed_truncated: true` as soon as the schema accepts it, and always logged and put in --json.
  const observedTruncated = !!hosted && !!ctx?.observedTruncated();
  if (observedTruncated) warn('observed_connections is truncated: the target presented more than 16 origin/leaf-key pairs or 8 addresses per pair; the attribution list in run.hosted is incomplete');
  const hostedRecord: HostedRecord | undefined = hosted
    ? { ...hosted.record, ...(observed.length ? { observed_connections: observed } : {}), ...(observedTruncated && OBSERVED_TRUNCATED_IN_CONTRACT ? ({ observed_truncated: true } as object) : {}) }
    : undefined;
  const report = buildReport({
    runSpec: spec,
    episodes: results,
    engineBuild: digest,
    engineBuildScope: engineScope,
    engineSourceManifestDigest: manifestDigest,
    scenarioVersion: scenarioModule(scenario).describe().version,
    startedAt,
    finishedAt,
    runId,
    engineVersion: ENGINE_VERSION,
    tool: { name: '@rbrus/agent-arena', version: VERSION },
    targetOwnership: p.ownership,
    seats: results.map((ep, i) => targetSeatInputs(records[i], ep)),
    ...(hosted ? { mode: 'hosted' as const, hosted: hostedRecord, notAssessed: hosted.notAssessed(results) } : {}),
  });
  const sarif = toSarif(report, { specPath: hosted ? `.agent-arena/${scenario}.run.json` : sarifSpecLocation(p, scenario, spec) });
  writeOutput(join(outDir, `${REPORT_BASE}.json`), toFileJson(report));
  writeOutput(join(outDir, `${REPORT_BASE}.sarif`), toFileJson(sarif));
  // Hosted: the RunSpec is inside the report and in the control plane's input folder; the bundle lists no extra copy.
  if (hosted) writeRaw(join(outDir, HOSTED_MANIFEST_FILE), hosted.manifestText);
  else writeOutput(join(outDir, `${REPORT_BASE}.run-spec.json`), toFileJson(spec));
  for (let i = 0; i < records.length; i++) {
    const ep = results[i];
    writeOutput(join(outDir, ep.replay_ref!.replace(/\.replay\.json$/, '.record.json')), toFileJson(records[i]));
    writeOutput(join(outDir, ep.replay_ref!), `${JSON.stringify(buildReplayFile(records[i], ep))}\n`);
  }
  if (credentialShapeHits() > 0) warn('credential_shape_in_output: something credential-shaped was redacted from the output; your target may be echoing secrets.');

  const exitCode = exitCodeForReport(report, { failOn });
  const anchors = results.map((r) => (hosted ? undefined : anchorFor(r, tier, dip ? dip.fill : seat && 'fill' in seat ? seat.fill : undefined, dip?.horizonYear)) ?? null);
  if (isJson()) {
    outJson({
      exit_code: exitCode,
      report: join(outDir, `${REPORT_BASE}.json`),
      sarif: join(outDir, `${REPORT_BASE}.sarif`),
      ...(hosted ? { run_manifest: join(outDir, HOSTED_MANIFEST_FILE), run_manifest_digest: hosted.record.run_manifest.digest, ...(observedTruncated ? { observed_connections_truncated: true } : {}) } : {}),
      summary: report.summary,
      episodes: results.map((r, i) => ({
        index: r.episode_index,
        seed: r.seed,
        seat: r.seat,
        outcome: r.outcome,
        terminal_tick: r.terminal_tick,
        replay_hash: r.replay_hash,
        ...(r.transcript_hash ? { transcript_hash: r.transcript_hash, evaluation_hash: r.evaluation_hash, engine_evaluation_hash: (r.diplomacy as { engine_evaluation_hash?: string } | undefined)?.engine_evaluation_hash ?? null } : {}),
        ...(dip ? { episode_invalid: invalid.some((x) => x.index === i) } : {}),
        anchor: anchors[i],
      })),
      ...(dip ? { episodes_invalid: invalid.length } : {}),
    });
  } else {
    out(`verdict: ${report.summary.verdict}  (${report.summary.episodes_completed}/${report.summary.episodes_total} episodes, ${report.summary.effective_episodes} distinct trajectories, ${report.summary.within_budget_episodes} within budget)`);
    if (invalid.length) {
      out(`  ${invalid.length} episode(s) episode_invalid (a reference seat failed an oracle): every target verdict there is not_assessed and counts toward neither pass nor fail (episodes ${invalid.map((x) => x.index).join(', ')})`);
    }
    const fails = report.summary.oracles.filter((o) => o.fail > 0);
    for (const o of fails) out(`  fail  ${o.oracle_id}  x${o.fail}`);
    out(`report: ${join(outDir, `${REPORT_BASE}.json`)}`);
    out(`sarif:  ${join(outDir, `${REPORT_BASE}.sarif`)}`);
    if (hosted) out(`manifest: ${join(outDir, HOSTED_MANIFEST_FILE)} (${hosted.record.run_manifest.digest}); unsigned: the seal step verifies and signs`);
    out(`exit ${exitCode} (${exitCode === 0 ? 'no findings' : exitCode === 1 ? `findings at or above --fail-on ${failOn}` : 'error'}); verify with: agent-arena verify ${join(outDir, `${REPORT_BASE}.json`)}`);
  }
  return { exitCode, outDir };
}
