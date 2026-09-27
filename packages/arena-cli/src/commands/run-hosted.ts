/**
 * `agent-arena run --hosted --manifest <path> --manifest-key <pem|jwk|jwks> [--out <dir>] [--json]`
 * (Phase 9 B1; HOSTED-PROFILE §2.4, threat-model-hosted §2.1 and §10.2).
 *
 * A hosted run is driven ONLY by a control-plane-signed run manifest
 * (contracts `hosted_context.schema.json`). Every security-relevant setting
 * comes from that manifest, from the RunSpec it binds by digest
 * (the `--run-spec` file, checked against `run_spec_digest`), or from the frozen
 * `hosted-v1` network policy. No run flag other than --out and --json is
 * accepted (main.ts refuses the rest before this runs), and no variable can
 * relax anything (hosted/env.ts).
 *
 * Order, all before any network I/O:
 *   1. take + scrub every per-run secret variable (credentials registered with the Redactor)
 *   2. refuse relaxing variables and diagnostics
 *   3. pinned key set → manifest file → schema → Ed25519 over JCS (RUN_MANIFEST_PAYLOAD_TYPE) → kid
 *   4. policy + clock, image digest allowlist + platform, bound RunSpec; episode caps (contracts 2.10.0,
 *      signing.md §3.2 A6: an extended run plays 1 episode; M10: a Diplomacy-family run at most 50)
 *   5. scenario (open, or an `sx_` variant of a mounted signed pack), engine build, packs
 *   6. target: RunSpec origin == verified origin == the egress allowlist's target (scheme, host, port)
 *   7. credential per credential_mode (env:ARENA_TARGET_CREDENTIAL only; tables: ARENA_SEAT_CREDENTIAL_<POWER>)
 *   8. Diplomacy: every episode secret hashes to its commitment, and the list to the manifest digest
 * then the SAME executeRun as a local run, with run.mode hosted, run.hosted from
 * the manifest, target_ownership sixi_verified and the recorded not-assessed list.
 * The report is left unsigned: the seal step verifies it and signs it (the CLI
 * never holds Sixi's key).
 */

import { resolve } from 'node:path';
import { computeRunOracles, type EpisodeResult, type HostedRecord, type NotAssessedEntry } from 'arena-report';
import { SCENARIO_IDS, type ScenarioId } from 'arena-scenarios';
import { engineBuildFor, HOSTED_USER_AGENT } from '../build-info.ts';
import { credentialFromValue, FORBIDDEN_HEADERS, HEADER_RE, type AuthSpec } from '../credentials.ts';
import { DIPLOMACY, parseDipFlags, type DipRunOptions } from '../diplomacy.ts';
import { CliError, misconfig } from '../errors.ts';
import type { HostedContextContract, RunSpecContract } from '../generated/contracts.ts';
import { diagnosticFlags } from '../hardening.ts';
import { assertHostedEnvironment, assertNoEnvDocuments, IMAGE_DIGEST_VAR, PACKS_DIR_VAR, takeHostedSecrets, TARGET_CREDENTIAL_VAR, type HostedSecrets } from '../hosted/env.ts';
import { bindRunSpec, checkEngine, checkImage, checkPolicyAndClock, commitmentListDigest, episodeSecretCommitment, invalid, readManifestFile, readRunSpecFile, runningPlatform, verifyManifest, type VerifiedManifest } from '../hosted/manifest.ts';
import { assertHostedDiplomacyEpisodes, assertHostedTierEpisodes } from '../hosted/admission.ts';
import { installHostedLogFilter, scrubHostedError, type HostedLogFilter } from '../hosted/log-filter.ts';
import { resolveManifestKeys } from '../hosted/pinned-keys.ts';
import { checkVariantAgainstRunSpec, isPackScenarioId, loadPacks, packUnavailable, resolveVariant, type LoadedPack } from '../hosted/packs.ts';
import type { PinnedKey } from '../keys.ts';
import { checkUrl, effectiveRps, exactOrigin, hostedPolicy, NetBlockedError, type NetContext, type Resolver } from '../net/index.ts';
import type { ContractRunSpec } from '../report.ts';
import { DEFAULT_MAX_RETRY_AFTER_S } from '../runner.ts';
import type { Transport, TransportName } from '../transports/index.ts';
import { dipSpecFill } from '../verify-diplomacy.ts';
import { executeRun, HOSTED_MANIFEST_FILE, resolveSeat, TIERS, type RunResult } from './run.ts';

export interface HostedFlags {
  manifest?: string;
  runSpec?: string;
  manifestKey?: string;
  out?: string;
}

/**
 * Programmatic-only options (tests). None of them is reachable from argv or the
 * environment; production passes none.
 */
export interface HostedOptions {
  /** The environment to take secrets and settings from (default process.env; scrubbed in place). */
  env?: NodeJS.ProcessEnv;
  /** The running platform (default from process.platform/arch). */
  platform?: string | null;
  /** Epoch ms "now" (default Date.now()). */
  now?: number;
  resolver?: Resolver;
  transportFactory?: (ctx: NetContext, url: URL, name: TransportName) => Transport;
  /** The release's pinned manifest key set (default `PINNED_MANIFEST_JWKS`; tests exercise the non-empty rule). */
  pinnedKeys?: readonly PinnedKey[];
  /**
   * G-58: receives this run's hosted log filter as soon as it is installed. The filter is never
   * uninstalled by the run: it stays until process exit, so a late asynchronous error that reaches
   * `cli()`'s crash handler is still filtered. Only a caller that holds this handle (tests,
   * programmatic callers running several hosted runs in one process) may uninstall it.
   */
  onLogFilter?: (filter: HostedLogFilter) => void;
}

export const RUN_SPEC_INVALID = 'run_spec_invalid';
const specInvalid = (field: string, message: string, next?: string): CliError =>
  misconfig(`${RUN_SPEC_INVALID} (${field}): ${message} Nothing was sent.`, next ?? 'the control plane must admit a RunSpec the hosted runner accepts (HOSTED-PROFILE §1.5).');

const HEX64 = /^[0-9a-f]{64}$/;
/** The per-episode Diplomacy secrets, each checked against the manifest's commitment (commit-then-reveal). */
export function takeDipSecrets(m: HostedContextContract, episodes: number, secrets: HostedSecrets): string[] {
  const c = m.episode_secret_commitments;
  if (!c) throw invalid('episode_secret_commitments', 'a Diplomacy run needs the per-episode secret commitments in the manifest (K4).');
  if (c.count !== episodes) throw invalid('episode_secret_commitments', `the manifest commits to ${c.count} episode secret(s), the RunSpec plays ${episodes} episode(s).`);
  if (secrets.dipSecretCount() !== episodes) {
    throw invalid('episode_secret_commitments', `${secrets.dipSecretCount()} episode secret(s) were delivered for ${episodes} episode(s).`, 'deliver exactly ARENA_DIP_SECRET_0 … ARENA_DIP_SECRET_<episodes-1> through the per-run secret channel (signing.md §3.1).');
  }
  const out: string[] = [];
  for (let i = 0; i < episodes; i++) {
    const s = secrets.dipSecret(i);
    if (s === undefined) throw invalid('episode_secret_commitments', `the secret of episode ${i} is missing.`);
    // threat-model-hosted §2.5 rule 1: never '', never short; 256 bits as 64 lower-case hex.
    if (!HEX64.test(s)) throw invalid('episode_secret_commitments', `the secret of episode ${i} is not a 256-bit secret (64 lower-case hex); an empty or short secret is refused.`);
    out.push(s);
  }
  if (new Set(out).size !== out.length) throw invalid('episode_secret_commitments', 'two episodes were given the same secret; every episode needs a fresh one.');
  const digest = commitmentListDigest(out.map(episodeSecretCommitment));
  if (digest !== c.digest) {
    throw invalid('episode_secret_commitments', 'the delivered episode secrets do not hash to the commitments the manifest was signed with (commit-then-reveal).', 'deliver the secrets the control plane committed to at admission; a secret chosen later is refused.');
  }
  return out;
}

/**
 * G-46: the one refusal text for a hosted target URL with userinfo, a query or a fragment.
 * The RunSpec is signed and recorded byte-for-byte, so a credential there would be sent AND
 * sealed into the bundle; C-1 on the hosted path is therefore stricter than locally (no
 * `--allow-query-secret`): the URL carries no query at all. Fixed text: nothing is echoed.
 */
export const HOSTED_TARGET_URL_PARTS = 'the hosted target URL must not carry userinfo, a query or a fragment (a credential there would be sent to the target and recorded in the signed RunSpec, the report and the sealed bundle); credentials travel only as env:ARENA_TARGET_CREDENTIAL.';

/**
 * The RunSpec target, checked against the verified origin and the egress allowlist: exact scheme,
 * host and port. G-45: the refusals name the fields, never the origins (the text reaches the log stream).
 */
export function hostedTarget(m: HostedContextContract, spec: RunSpecContract): { url: URL; transport: TransportName; allow: string } {
  const verified = new URL(m.verified_origin.origin);
  const egress = m.egress_allowlist.find((e) => e.role === 'target')!;
  const egressUrl = new URL(egress.origin);
  if (exactOrigin(egressUrl) !== exactOrigin(verified)) throw invalid('/egress_allowlist', "the egress allowlist's target origin is not the verified origin (/verified_origin/origin; scheme, host and port must be equal).");
  let url: URL;
  try {
    url = new URL(spec.target.url);
  } catch {
    throw invalid('/verified_origin/origin', 'the RunSpec target URL is not a URL.');
  }
  const transport = spec.target.transport as TransportName;
  const wantScheme = transport === 'ws' ? 'wss:' : 'https:';
  if (url.protocol !== wantScheme) throw specInvalid('target.url', `a hosted ${transport} target must be ${wantScheme}//, got ${url.protocol === 'http:' || url.protocol === 'ws:' || url.protocol === 'https:' || url.protocol === 'wss:' ? url.protocol : 'another scheme'}//.`);
  // G-46: `URL.search`/`hash` are '' for a bare `?`/`#`, so the raw text is checked as well.
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(spec.target.url)) {
    throw specInvalid('target.url', HOSTED_TARGET_URL_PARTS, 'the control plane must admit a target URL without userinfo, query or fragment (SIXI-INTEGRATION PR 4 admission applies the same rule).');
  }
  if (exactOrigin(url) !== exactOrigin(verified)) {
    throw invalid('/verified_origin/origin', 'the RunSpec target.url origin is not the verified origin (/verified_origin/origin; scheme, host and port must be equal).', 'the control plane must build the RunSpec target from the verification record.');
  }
  return { url, transport, allow: exactOrigin(verified) };
}

/** The credential per `credential_mode` (K6): only env:ARENA_TARGET_CREDENTIAL, never a file, never a value in the RunSpec. */
export function hostedCredential(m: HostedContextContract, spec: RunSpecContract, secrets: HostedSecrets): { auth?: AuthSpec; credential?: ReturnType<typeof credentialFromValue>['credential'] } {
  const auth = spec.target.auth;
  const value = secrets.target();
  if (m.credential_mode === 'none') {
    if (auth) throw specInvalid('target.auth', 'the manifest says credential_mode none, but the RunSpec names a credential.');
    if (value !== undefined) throw invalid('/credential_mode', `credential_mode is none, but ${TARGET_CREDENTIAL_VAR} was delivered (it was removed from the environment and not used).`);
    return {};
  }
  if (!auth) throw specInvalid('target.auth', `credential_mode ${m.credential_mode} needs target.auth with ref env:${TARGET_CREDENTIAL_VAR}.`);
  if (auth.ref !== `env:${TARGET_CREDENTIAL_VAR}`) {
    throw specInvalid('target.auth.ref', `the hosted runner accepts only env:${TARGET_CREDENTIAL_VAR} for the target (secret: refs and other env: names are refused).`);
  }
  if (auth.scheme === 'header') {
    const h = auth.header_name;
    if (!h || !HEADER_RE.test(h) || FORBIDDEN_HEADERS.has(h.toLowerCase())) throw specInvalid('target.auth.header_name', 'the header name is missing, malformed or a hop-by-hop / arena header.');
  }
  if (value === undefined || value === '') throw invalid('/credential_mode', `credential_mode ${m.credential_mode}, but ${TARGET_CREDENTIAL_VAR} was not delivered.`, 'reference the per-run secret as ARENA_TARGET_CREDENTIAL in the job spec (secretKeyRef).');
  const spec2: AuthSpec = auth.scheme === 'header' && auth.header_name?.toLowerCase() !== 'authorization' ? { scheme: 'header', ref: auth.ref, header_name: auth.header_name } : { scheme: 'bearer', ref: auth.ref };
  const loaded = credentialFromValue(spec2, value, 'env');
  return { auth: spec2, credential: loaded.credential };
}

/** Table seats (K6/K7): refs are checked, then the run is refused (multi-target tables are not in this runner build). */
function refuseTables(spec: RunSpecContract, secrets: HostedSecrets): void {
  const seats = spec.seats ?? [];
  const seatVars = secrets.names().filter((n) => n.startsWith('ARENA_SEAT_CREDENTIAL_'));
  if (!seats.length) {
    if (seatVars.length) throw invalid('/credential_mode', `${seatVars.join(', ')} delivered for a run without table seats (removed from the environment and not used).`);
    return;
  }
  for (const [i, s] of seats.entries()) {
    if (s.driver === 'recorded_peer') throw specInvalid(`seats[${i}]`, 'recorded LLM peer seats (adversarial_peer packs) are blocked on K7 in this runner build.', 'run the pack without peer seats until K7 lands (HOSTED-PROFILE §5.7).');
    const ref = s.target?.auth?.ref;
    const want = `env:ARENA_SEAT_CREDENTIAL_${s.position.toUpperCase()}`;
    if (ref !== undefined && ref !== want) throw specInvalid(`seats[${i}].target.auth.ref`, `a table seat's credential must be ${want}.`);
    if (ref !== undefined && !secrets.seat(s.position.toUpperCase())) throw invalid('/credential_mode', `${want.slice(4)} was not delivered.`);
  }
  throw specInvalid('seats', 'multi-target tables (seats[] with driver target) are not supported by this runner build; the table runner is the Neutral Ground runner (Phase 9 B4).');
}

/** Standing hosted not-assessed entries plus each mounted pack's clause coverage versus what ran (recorded basis). */
export function hostedNotAssessed(scenario: ScenarioId, packs: readonly LoadedPack[]): (episodes: readonly EpisodeResult[]) => NotAssessedEntry[] {
  return (episodes) => {
    const out: NotAssessedEntry[] = [
      // threat-model-hosted §2.5: scripted adversaries are functions of a 32-bit seed.
      { kind: 'property', id: 'robustness.seed_recovery', reason_code: 'seed_recovery_not_modelled', basis: 'recorded' },
      { kind: 'property', id: 'target.model_identity', reason_code: 'out_of_scope_by_design', basis: 'recorded' },
      { kind: 'property', id: 'target.production_equivalence', reason_code: 'out_of_scope_by_design', basis: 'recorded' },
    ];
    if (!packs.length) return out;
    const verdicts = [...episodes.flatMap((e) => e.oracles), ...computeRunOracles(scenario as never, episodes as EpisodeResult[])];
    const ranOracles = new Set(verdicts.map((v) => v.oracle_id));
    const assessed = new Set(verdicts.filter((v) => v.verdict === 'pass' || v.verdict === 'fail').map((v) => v.oracle_id));
    for (const p of packs) {
      const map = p.manifest.oracles ?? [];
      for (const clause of [...p.manifest.coverage.clauses].sort()) {
        const mapped = map.filter((o) => o.clauses.includes(clause) && ranOracles.has(o.oracle_id)).map((o) => o.oracle_id);
        if (!mapped.length) out.push({ kind: 'clause', id: clause, reason_code: 'clause_not_mapped_in_run', basis: 'recorded', pack: p.id });
        else if (!mapped.some((o) => assessed.has(o))) out.push({ kind: 'clause', id: clause, reason_code: 'clause_oracles_not_assessed', basis: 'recorded', pack: p.id });
      }
    }
    return out;
  };
}

function hostedRecordOf(vm: VerifiedManifest): HostedRecord & { verified_origin: { origin: string; method: string } } {
  const m = vm.doc;
  return {
    signing_key_id: m.signing_key_id,
    region: m.region,
    image_digest: { ...m.image_digest },
    verified_origin: { ...m.verified_origin },
    org_ref: m.org_ref,
    scan_id: m.scan_id,
    credential_mode: m.credential_mode,
    ...(m.seed_source ? { seed_source: m.seed_source } : {}),
    packs: m.packs.map((p) => ({ ...p })),
    retention: { ...m.retention },
    run_manifest: { digest: vm.digest, signing_key_id: vm.kid, path: HOSTED_MANIFEST_FILE },
  };
}

export async function runHostedCommand(f: HostedFlags, o: HostedOptions = {}): Promise<RunResult> {
  const env = o.env ?? process.env;
  // ── 1. Secrets first: read once, deleted from the environment, credentials registered with the Redactor ──
  const secrets = takeHostedSecrets(env);
  // ── 2. Nothing may relax the hosted policy; the documents come from files only ──
  assertHostedEnvironment(env);
  assertNoEnvDocuments(env);
  if (secrets.arrayFormDelivered()) throw invalid('episode_secret_commitments', 'ARENA_EPISODE_SECRETS is not a contract variable (removed from the environment, not used).', 'deliver the secrets as ARENA_DIP_SECRET_<n>, one per episode (signing.md §3.1).');
  const badDip = secrets.malformedDipNames();
  if (badDip.length) throw invalid('episode_secret_commitments', `malformed episode-secret variable name(s) ${badDip.map((n) => n.slice(0, 40)).join(', ')} (n is decimal with no leading zero; removed from the environment, not used).`);
  const diag = diagnosticFlags(process.execArgv, undefined);
  if (diag.length) throw invalid('/', `Node diagnostics are enabled (${diag.join(', ')}); the hosted runner never runs with them.`, 'remove the flag from the job command.');
  // ── 3. The manifest, against the pinned control-plane key ──
  if (!f.manifest) throw invalid('--manifest', 'a hosted run needs the signed run manifest.', 'agent-arena run --hosted --manifest <path> --manifest-key <pinned control-plane key> --out /out');
  if (!f.runSpec) throw invalid('--run-spec', 'a hosted run needs the RunSpec file the manifest binds.', 'agent-arena run --hosted --manifest <path> --run-spec <path> --out /out');
  // G-47: the release's pinned JWKS; --manifest-key (kid-bound, with a warning) only while none is pinned.
  const keys = resolveManifestKeys(f.manifestKey, { required: true, ...(o.pinnedKeys ? { pinned: o.pinnedKeys } : {}) });
  const vm = verifyManifest(readManifestFile(f.manifest), keys);
  // G-45: from here on the verified origin is known; every log byte is filtered, and so is the error that ends the run.
  // G-58: no uninstall here. The filter outlives the run until process exit; only the handle's holder may remove it.
  const filter = installHostedLogFilter(vm.doc.verified_origin.origin);
  o.onLogFilter?.(filter);
  try {
    return await runVerifiedManifest(vm, keys, f, o, env, secrets);
  } catch (e) {
    throw scrubHostedError(e, filter.scrub);
  }
}

async function runVerifiedManifest(vm: VerifiedManifest, keys: readonly PinnedKey[], f: HostedFlags, o: HostedOptions, env: NodeJS.ProcessEnv, secrets: HostedSecrets): Promise<RunResult> {
  const m = vm.doc;
  // ── 4. Policy, clock, image, bound RunSpec ──
  const now = o.now ?? Date.now();
  const deadlineEpoch = checkPolicyAndClock(m, now);
  checkImage(m, env[IMAGE_DIGEST_VAR], o.platform === undefined ? runningPlatform() : o.platform);
  const spec = bindRunSpec(m, readRunSpecFile(f.runSpec!));
  assertHostedTierEpisodes(spec);
  if (m.peers?.length || m.egress_allowlist.some((e) => e.role === 'peer_gateway')) {
    throw specInvalid('seats', 'LLM peer seats (adversarial_peer packs) are blocked on K7 in this runner build.', 'run the pack without peer seats until K7 lands (HOSTED-PROFILE §5.7).');
  }
  // ── 5. Scenario, engine build, packs ──
  const requested = spec.scenario_id;
  const packVariant = isPackScenarioId(requested);
  if (!packVariant && !(SCENARIO_IDS as readonly string[]).includes(requested)) {
    throw specInvalid('scenario_id', `no scenario ${requested.slice(0, 40)} in this engine build (scenario_not_found).`);
  }
  const base = requested as ScenarioId;
  if (packVariant) {
    // Only a variant of a pack the SIGNED manifest lists, mounted and signed, resolves; otherwise refused before any I/O.
    if (!m.packs.length) throw packUnavailable(`${requested.slice(0, 40)} is a Sixi Arena pack scenario and the run manifest mounts no pack.`, 'the control plane must list the entitled pack in the run manifest and mount it under ARENA_PACKS_DIR.');
    const probe = loadPacks(m.packs, env[PACKS_DIR_VAR], keys, (s) => engineBuildFor(s).digest, null, Date.parse(m.issued_at));
    const variant = resolveVariant(requested, probe);
    assertHostedDiplomacyEpisodes(m, spec, variant.base === DIPLOMACY);
    checkVariantAgainstRunSpec(variant, spec as never);
    throw packUnavailable(
      `${requested} resolves to base ${variant.base} with parameters ${JSON.stringify(variant.params).slice(0, 200)} from pack ${variant.packId}, but this runner build cannot yet report a pack scenario (report scenario.base_scenario_id).`,
      'run the open base scenario, or use the runner release that adds pack-scenario reports.',
    );
  }
  checkEngine(m, engineBuildFor(base).digest);
  assertHostedDiplomacyEpisodes(m, spec, base === DIPLOMACY);
  const packs = loadPacks(m.packs, env[PACKS_DIR_VAR], keys, (s) => engineBuildFor(s).digest, base, Date.parse(m.issued_at));
  // ── 6. Target, 7. credential, tables ──
  refuseTables(spec, secrets);
  const { url, transport, allow } = hostedTarget(m, spec);
  const { auth, credential } = hostedCredential(m, spec, secrets);
  // ── 8. Seats and Diplomacy ──
  const tier = spec.budget_tier as (typeof TIERS)[number];
  const seeds = [...spec.seeds];
  const episodes = spec.episodes;
  if (episodes < seeds.length) throw specInvalid('episodes', `episodes (${episodes}) must be >= the number of seeds (${seeds.length}).`);
  let dip: DipRunOptions | undefined;
  let dipSecrets: string[] | undefined;
  let seat: ReturnType<typeof resolveSeat> | undefined;
  try {
    if (base === DIPLOMACY) {
      const fill = dipSpecFill(spec as ContractRunSpec);
      const pos = spec.seat?.position;
      dip = parseDipFlags({ seat: pos, fill, horizon: spec.diplomacy?.horizon_year === undefined ? undefined : String(spec.diplomacy.horizon_year) }, seeds);
      dipSecrets = takeDipSecrets(m, episodes, secrets);
    } else {
      if (m.episode_secret_commitments) throw invalid('episode_secret_commitments', `${base} is not a Diplomacy scenario; the manifest must not commit to episode secrets.`);
      if (secrets.dipSecretCount()) throw invalid('episode_secret_commitments', `episode secrets delivered for ${base}, which uses no episode secret (removed from the environment and not used).`);
      const s = spec.seat as { mode?: string; position?: string; fill?: string } | undefined;
      seat = resolveSeat(base, { seat: s?.mode, position: s?.position, fill: s?.fill });
    }
  } catch (e) {
    if (e instanceof CliError) throw e.message.startsWith('hosted_context_invalid') || e.message.startsWith(RUN_SPEC_INVALID) ? e : specInvalid('seat', e.message);
    throw specInvalid('diplomacy', (e as Error).message.slice(0, 300));
  }

  const policy = hostedPolicy([allow]);
  // Pre-flight under hosted-v1, before any socket: a typed loopback, private, link-local or metadata
  // host (or a local name) is refused here even though it is the "verified" origin (HT-2.1).
  try {
    checkUrl(url, policy);
  } catch (e) {
    if (e instanceof NetBlockedError) throw misconfig(`${e.message.startsWith('target_forbidden') ? '' : 'target_forbidden: '}${e.message} Nothing was sent.`, 'a hosted target must be a public https/wss origin; the control plane must not admit this origin.');
    throw e;
  }
  const record = hostedRecordOf(vm);
  return executeRun({
    scenario: base,
    tier,
    seeds,
    episodes,
    seat,
    dip,
    dipSecrets,
    url,
    transport,
    policy,
    credential,
    authRef: auth?.ref,
    loopback: false,
    rps: effectiveRps(m.rps_cap, false),
    maxRetryAfterS: DEFAULT_MAX_RETRY_AFTER_S,
    failOn: 'error',
    followRedirects: false,
    spec: spec as ContractRunSpec,
    labels: null,
    ownership: { loopback: false, attested: true, source: 'sixi_verified' },
    outDir: resolve(f.out ?? 'arena-report'),
    runId: m.run_id,
    userAgent: HOSTED_USER_AGENT,
    resolver: o.resolver,
    hosted: {
      record,
      notAssessed: hostedNotAssessed(base, packs),
      manifestText: vm.text,
      deadline: performance.now() + (deadlineEpoch - now),
      deadlineIso: m.wall_clock_deadline,
      ...(o.transportFactory ? { transportFactory: o.transportFactory } : {}),
    },
  });
}

