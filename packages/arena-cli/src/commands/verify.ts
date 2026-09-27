/**
 * `agent-arena verify <report.json> [--key <pem|jwk>] [--hosted]`: treat the
 * report as inputs + claims, re-simulate every episode from its record
 * (engine-controlled seats regenerated from the seed, the target's seats
 * replayed from the record, ADR-004), rebuild the report and compare. No
 * network I/O.
 *
 *   --key     check the report's Ed25519 seal (contracts 2.2.0 signing.md)
 *             BEFORE anything is re-simulated; a missing or bad seal is
 *             `signature_invalid` (exit 2).
 *   --hosted  a sealed hosted report (Phase 9; full hosted verification is
 *             reserved): additionally cross-checks the signing key id of the
 *             SARIF next to the report against the DSSE seal and run.hosted,
 *             and the run-manifest digest (and the manifest file, when the
 *             bundle carries it). Needs --key.
 *
 * Exit: 0 verified · 1 mismatch (incl. G-33: the RunSpec target disagrees with how
 * every record drives the target seat) · 2 unverifiable input (incl.
 * signature_invalid) · 3 engine build or scenario not available in this CLI / misuse.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { SCENARIO_IDS } from 'arena-scenarios';
import { createHash } from 'node:crypto';
import { canonicalize, jcs, RUN_MANIFEST_PAYLOAD_TYPE, signedBodyDigest, verifyDocumentSignature, ENGINE_BUILD_SCOPES, type EngineBuildScope } from 'arena-report';
import { engineBuildHash } from '../build-info.ts';
import { CliError, misconfig } from '../errors.ts';
import type { HostedContextContract } from '../generated/contracts.ts';
import { isPackScenarioId, PACK_UNAVAILABLE } from '../hosted/packs.ts';
import { schemaErrors, validateHostedContext } from '../hosted/schemas.ts';
import { hostedInvariantProblems, sarifEqual, sealedBundleProblems, type SealCheck } from '../hosted/seal.ts';
import { exactOrigin } from '../net/index.ts';
import { commitmentListDigest, episodeSecretCommitment } from '../hosted/manifest.ts';
import { resolveManifestKeys } from '../hosted/pinned-keys.ts';
import { HOSTED_MANIFEST_FILE } from './run.ts';
import { HostileFileError, readHostileJson, resolveInside } from '../files.ts';
import { loadPublicKey, loadPublicKeySet, type PinnedKey } from '../keys.ts';
import { buildReplayFile } from '../replay-file.ts';
import { CLI_SCENARIOS, DRIVER_MISMATCH_MESSAGE, makeRerun } from '../rerun.ts';
import { EXIT_CODES, engineBuildScopeFor, verifyReport, type ExitCode, type Report, type VerifyResult } from '../report.ts';
import { isJson, out, outJson } from '../ui.ts';

export const MAX_REPORT_BYTES = 64 * 1024 * 1024;

export interface VerifyFlags {
  key?: string;
  hosted?: boolean;
  /** `--hosted` only: the control-plane manifest key; checks run-manifest.json's own signature too. */
  manifestKey?: string;
  /** `--hosted-seal` only (G-49): the manifest digest the control plane issued for this run; must equal the bundle's. */
  expectManifestDigest?: string;
  /** Tests only: the release's pinned manifest key set (default PINNED_MANIFEST_JWKS). */
  pinnedKeys?: readonly PinnedKey[];
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The engine builds this CLI can re-simulate for a report: its scenario's scope, plus the scope it claims (2.3.0 `engine.build_scope`). */
export function engineBuildsFor(report: unknown): string[] {
  const r = isObj(report) ? report : {};
  const scenario = str(isObj(r.scenario) ? r.scenario.scenario_id : undefined) ?? '';
  const scopes = new Set<EngineBuildScope>([engineBuildScopeFor(scenario)]);
  const claimed = str(isObj(r.engine) ? r.engine.build_scope : undefined);
  if (claimed && (ENGINE_BUILD_SCOPES as readonly string[]).includes(claimed)) scopes.add(claimed as EngineBuildScope);
  return [...scopes].map(engineBuildHash);
}

/**
 * `--hosted` seal cross-checks that verifyReport does not do (it sees the
 * report only): the SARIF's signing key id equals the DSSE seal's and
 * run.hosted's, and the run manifest the bundle carries (`run-manifest.json`
 * beside the report, required) digests to the value the seal commits to, is a
 * schema-valid manifest, optionally verifies against the control-plane key
 * (`--manifest-key`), and states exactly what the report's `run.hosted`,
 * `run.run_id`, RunSpec and target origin say (signing.md §3). Returns
 * `signature_invalid:` errors (empty = consistent) and the manifest when read.
 */
export function hostedSealErrors(report: unknown, reportPath: string, manifestKeys?: readonly PinnedKey[], o: { preSeal?: boolean } = {}): { errors: string[]; manifest?: HostedContextContract } {
  const errs: string[] = [];
  const r = isObj(report) ? report : {};
  const signing = isObj(r.signing) ? r.signing : undefined;
  const hosted = isObj(r.run) && isObj(r.run.hosted) ? r.run.hosted : undefined;
  if (o.preSeal) {
    // The seal step's verifier job: an unsealed hosted report; key ids are compared with run.hosted instead of the seal.
    if (!hosted) return { errors: ['signature_invalid: --hosted-seal verifies a hosted report; this one carries no run.hosted'] };
  } else if (!signing || !hosted) return { errors: ['signature_invalid: --hosted verifies a sealed hosted report; this one carries no signing block or no run.hosted'] };
  const hostedKid = str(hosted.signing_key_id);
  const dsseKid = signing ? str(signing.signing_key_id) : hostedKid;
  if (dsseKid !== hostedKid) errs.push('signature_invalid: signing.signing_key_id differs from run.hosted.signing_key_id');
  const sarifPath = reportPath.replace(/\.json$/, '') + '.sarif';
  if (!existsSync(sarifPath)) errs.push(`signature_invalid: no SARIF next to the report (${sarifPath}); a sealed bundle carries both, and their key ids must agree`);
  else {
    let sarif: unknown;
    try {
      sarif = readHostileJson(sarifPath, MAX_REPORT_BYTES, 'SARIF log');
    } catch (e) {
      errs.push(`signature_invalid: ${e instanceof HostileFileError ? e.message : 'the SARIF log cannot be read'}`);
    }
    if (sarif !== undefined) {
      const runs = isObj(sarif) && Array.isArray(sarif.runs) ? sarif.runs : [];
      const props = isObj(runs[0]) && isObj(runs[0].properties) && isObj(runs[0].properties.agentArena) ? runs[0].properties.agentArena : {};
      if (str(props.signing_key_id) !== dsseKid) errs.push('signature_invalid: the SARIF signing_key_id differs from the DSSE seal (signing.signing_key_id)');
      if (str(props.run_id) !== str(isObj(r.run) ? r.run.run_id : undefined)) errs.push('signature_invalid: the SARIF run_id differs from the report run_id');
    }
  }
  const ref = isObj(hosted.run_manifest) ? hosted.run_manifest : {};
  const digest = str(ref.digest);
  if (signing && str(signing.run_manifest_digest) !== digest) errs.push('signature_invalid: signing.run_manifest_digest differs from run.hosted.run_manifest.digest');
  const mpath = str(ref.path);
  if (mpath !== HOSTED_MANIFEST_FILE) {
    errs.push(`signature_invalid: run.hosted.run_manifest.path must be ${HOSTED_MANIFEST_FILE} (the bundle carries the manifest beside the report)`);
    return { errors: errs };
  }
  let doc: unknown;
  try {
    doc = readHostileJson(resolveInside(dirname(reportPath), mpath), MAX_REPORT_BYTES, 'run manifest');
  } catch (e) {
    errs.push(`signature_invalid: the run manifest ${mpath} beside the report cannot be checked (${e instanceof Error ? e.message.slice(0, 200) : 'unreadable'})`);
    return { errors: errs };
  }
  if (!validateHostedContext(doc)) {
    errs.push(`signature_invalid: ${mpath} is not a valid run manifest (${schemaErrors(validateHostedContext.errors)})`);
    return { errors: errs };
  }
  const m = doc as HostedContextContract;
  let got: string;
  try {
    got = signedBodyDigest(m);
  } catch (e) {
    errs.push(`signature_invalid: ${mpath} cannot be canonicalised (${(e as Error).message.slice(0, 120)})`);
    return { errors: errs };
  }
  if (got !== digest) errs.push(`signature_invalid: the run manifest at ${mpath} digests to ${got}, the seal commits to ${String(digest).slice(0, 80)}`);
  if (str(ref.signing_key_id) !== m.signing.signing_key_id) errs.push('signature_invalid: run.hosted.run_manifest.signing_key_id differs from the manifest\'s signing key id');
  if (manifestKeys) {
    const kid = m.signing.signing_key_id;
    const cands = manifestKeys.filter((k) => k.kid === undefined || k.kid === kid);
    const ok = cands.some((k) => verifyDocumentSignature(m, k.key, RUN_MANIFEST_PAYLOAD_TYPE).ok);
    if (!ok) errs.push(`signature_invalid: the run manifest's signature does not verify against the control-plane manifest key (pinned or --manifest-key; kid ${kid})`);
  }
  // signing.md §3 rule 3: run.hosted is a copy of the manifest's fields.
  const copied = ['signing_key_id', 'region', 'image_digest', 'verified_origin', 'org_ref', 'scan_id', 'credential_mode', 'seed_source', 'packs', 'retention'] as const;
  for (const k of copied) {
    if (canonicalize(hosted[k] ?? null) !== canonicalize((m as unknown as Record<string, unknown>)[k] ?? null)) errs.push(`signature_invalid: run.hosted.${k} differs from the run manifest`);
  }
  const run = isObj(r.run) ? r.run : {};
  if (str(run.run_id) !== m.run_id) errs.push('signature_invalid: the report run_id differs from the run manifest run_id');
  if (isObj(run.spec)) {
    let specDigest = '';
    try {
      specDigest = `sha256:${createHash('sha256').update(jcs(run.spec, { strict: true }), 'utf8').digest('hex')}`;
    } catch {
      /* reported below */
    }
    if (specDigest !== m.run_spec_digest) errs.push('signature_invalid: the report RunSpec is not the one the run manifest binds (run_spec_digest)');
    const target = isObj(run.spec.target) ? str(run.spec.target.url) : undefined;
    try {
      if (!target || exactOrigin(new URL(target)) !== exactOrigin(new URL(m.verified_origin.origin))) errs.push('signature_invalid: the report target is not on the manifest\'s verified origin');
    } catch {
      errs.push('signature_invalid: the report target URL cannot be parsed');
    }
  } else errs.push('signature_invalid: the report carries no RunSpec');
  return { errors: errs, manifest: m };
}

/**
 * Diplomacy commit-then-reveal (signing.md §4, threat-model-hosted §2.5): every
 * Diplomacy episode discloses its secret and commitment; each secret hashes to
 * its commitment; the commitment list (episode order) hashes to the manifest's
 * `episode_secret_commitments.digest`, with the right count. A difference means
 * the secret was not the one fixed before the run: `mismatch` (exit 1).
 */
export function hostedCommitmentErrors(report: unknown, m: HostedContextContract): string[] {
  const r = isObj(report) ? report : {};
  const eps = Array.isArray(r.episodes) ? r.episodes : [];
  const dipEps = eps.filter((e) => isObj(e) && isObj(e.diplomacy));
  const c = m.episode_secret_commitments;
  if (!dipEps.length) return c ? ['the run manifest commits to Diplomacy episode secrets, but the report has no Diplomacy episode'] : [];
  if (!c) return ['the report has Diplomacy episodes, but the run manifest commits to no episode secret (K4)'];
  const errs: string[] = [];
  if (dipEps.length !== eps.length) errs.push('the report mixes Diplomacy and other episodes');
  if (c.count !== eps.length) errs.push(`the manifest commits to ${c.count} episode secret(s); the report has ${eps.length} episode(s)`);
  const commitments: string[] = [];
  for (const [i, e] of eps.entries()) {
    const d = isObj(e) && isObj(e.diplomacy) ? e.diplomacy : {};
    const secret = str(d.episode_secret);
    const commitment = str(d.episode_secret_commitment);
    if (!secret || !/^[0-9a-f]{64}$/.test(secret) || !commitment) {
      errs.push(`episode ${i}: the episode secret or its commitment is missing or malformed`);
      continue;
    }
    if (episodeSecretCommitment(secret) !== commitment) errs.push(`episode ${i}: the disclosed episode secret does not hash to its commitment`);
    commitments.push(commitment);
  }
  if (!errs.length && commitmentListDigest(commitments) !== c.digest) errs.push('the episode secret commitments do not hash to the digest the run manifest was signed with (the secrets were not the ones fixed before the run)');
  return errs;
}

/**
 * `verify --hosted-seal <bundle-dir | report.json> [--key <report key|JWKS>] [--manifest-key <key>]`
 * (HOSTED-PROFILE §2.7, SIXI-INTEGRATION §1.10): the whole hosted bundle, pre-seal
 * (no `signing` yet: the seal step's verifier job, no key needed) or sealed (needs
 * --key: the three DSSE envelopes and every bundle file digest). Then the full
 * re-simulation. Exit 0 only if everything holds; 2 for a seal / invariant /
 * signature problem; 1 for a mismatch (SARIF re-render, commitments, re-simulation).
 */
export function verifyHostedSeal(path: string | undefined, f: VerifyFlags = {}): ExitCode {
  if (!path) {
    out('usage: agent-arena verify --hosted-seal <bundle-dir | report.json> [--key <report key>] [--manifest-key <manifest key>] [--json]');
    return EXIT_CODES.misconfig;
  }
  let full = resolve(path);
  try {
    if (statSync(full).isDirectory()) full = join(full, 'report.json');
  } catch {
    /* reported by the read below */
  }
  let raw: unknown;
  try {
    raw = readHostileJson(full, MAX_REPORT_BYTES, 'report');
  } catch (e) {
    return unverifiable([e instanceof HostileFileError ? e.message : 'the report cannot be read']);
  }
  const report = raw as Report;
  const sealed = isObj(raw) && (raw as Record<string, unknown>).signing !== undefined;
  if (sealed && f.key === undefined) throw misconfig('--hosted-seal: this bundle is sealed; checking it needs the report-signing public key.', 'pass --key <Sixi report key: PEM, OKP JWK or JWKS>.');
  if (f.expectManifestDigest !== undefined && !DIGEST_RE.test(f.expectManifestDigest)) throw misconfig('--expect-manifest-digest takes sha256:<64 lower-case hex> (the run_manifest_digest the control plane issued).', 'pass the digest from the run record, e.g. --expect-manifest-digest sha256:3f…');
  const reportKeys = f.key !== undefined ? loadPublicKeySet(f.key, '--key') : undefined;
  // G-47/G-49: the release's pinned manifest keys, or a kid-bound --manifest-key while none is pinned.
  const resolved = resolveManifestKeys(f.manifestKey, { required: false, ...(f.pinnedKeys ? { pinned: f.pinnedKeys } : {}) });
  const manifestKeys = resolved.length ? resolved : undefined;
  const check: SealCheck = { sealed, sarif_equal: false, bundle_files: 0, seal: [], mismatch: [] };
  // G-49: the verifier job (pre-seal) is the seal's only check of the manifest's origin until the signer's
  // issued-and-unused digest check ships: without the manifest key it cannot pass.
  if (!sealed && !manifestKeys) {
    check.seal.push('signature_invalid: pre-seal verification checks the run manifest\'s own signature and needs the control-plane manifest key (pinned in this release, or --manifest-key <kid-bound JWK|JWKS> while none is pinned); without it a runner could have written a self-consistent manifest and report');
  }
  const scenario = isObj(raw) && isObj((raw as Record<string, unknown>).scenario) ? str(((raw as Record<string, unknown>).scenario as Record<string, unknown>).scenario_id) : undefined;
  if (scenario && isPackScenarioId(scenario)) {
    throw new CliError(`${PACK_UNAVAILABLE}: ${scenario.slice(0, 40)} is a Sixi Arena pack scenario; this CLI re-simulates the open scenarios only (unsupported).`, EXIT_CODES.misconfig, 're-simulation of a pack scenario needs the pack (the Sixi seal step mounts it).');
  }
  check.seal.push(...hostedInvariantProblems(report));
  const m = hostedSealErrors(raw, full, manifestKeys, { preSeal: !sealed });
  check.seal.push(...m.errors);
  if (m.manifest) {
    // G-49 / review row 52: the engine build the manifest admitted is the one the report was produced with.
    const engine = isObj(raw) && isObj((raw as Record<string, unknown>).engine) ? ((raw as Record<string, unknown>).engine as Record<string, unknown>) : {};
    if (str(engine.build_hash) !== m.manifest.engine_build_hash) check.seal.push('signature_invalid: the report engine.build_hash differs from the run manifest engine_build_hash');
    if (f.expectManifestDigest !== undefined) {
      let got = '';
      try {
        got = signedBodyDigest(m.manifest);
      } catch {
        /* reported by hostedSealErrors */
      }
      if (got !== f.expectManifestDigest) check.seal.push('signature_invalid: run-manifest.json is not the manifest the control plane issued for this run (--expect-manifest-digest differs)');
    }
  } else if (f.expectManifestDigest !== undefined) check.seal.push('signature_invalid: --expect-manifest-digest given, but the bundle carries no readable run manifest');
  const sarif = sarifEqual(report, full);
  check.sarif_equal = sarif.equal;
  if (!sarif.equal) check.mismatch.push(sarif.error!);
  if (m.manifest) check.mismatch.push(...hostedCommitmentErrors(raw, m.manifest));
  let publicKey: KeyObject | undefined;
  if (sealed && reportKeys) {
    const kid = str((raw as { signing?: { signing_key_id?: unknown } }).signing?.signing_key_id);
    const b = sealedBundleProblems(report, full, reportKeys.filter((k) => k.kid === undefined || k.kid === kid));
    check.seal.push(...b.errors.map((e) => `signature_invalid: ${e}`));
    check.bundle_files = b.files;
    publicKey = reportKeys.find((k) => k.kid === kid)?.key ?? reportKeys.find((k) => k.kid === undefined)?.key;
    if (!publicKey) check.seal.push(`signature_invalid: no --key entry for kid ${String(kid).slice(0, 64)}`);
  }
  // The re-simulation (the part a signature cannot give), with the seal checked by verifyReport when sealed.
  const rerun = makeRerun(full, (rec, result, ctx) => {
    const p = resolveInside(dirname(full), ctx.replayRef!);
    if (!existsSync(p)) return;
    const stored = readHostileJson(p, MAX_REPORT_BYTES, 'replay file');
    if (JSON.stringify(stored) !== JSON.stringify(buildReplayFile(rec, result))) throw new Error(`${ctx.replayRef} does not match the replay regenerated from the record`);
  }, { hosted: true });
  const r = explainRecordDifference(driverMismatchIsMismatch(verifyReport(raw, rerun, { engineBuilds: engineBuildsFor(raw), ...(publicKey ? { publicKey } : {}) })));
  const exitCode: ExitCode = check.seal.length ? EXIT_CODES.error : r.exitCode !== EXIT_CODES.ok ? r.exitCode : check.mismatch.length ? EXIT_CODES.findings : EXIT_CODES.ok;
  const status = check.seal.length ? 'unverifiable' : r.status !== 'verified' ? r.status : check.mismatch.length ? 'mismatch' : 'verified';
  if (isJson()) {
    outJson({ ...r, ok: exitCode === EXIT_CODES.ok, status, exitCode, hosted_seal: check });
    return exitCode;
  }
  printHuman(r);
  out(`hosted seal: ${sealed ? `sealed bundle, ${check.bundle_files} file digest(s) and 3 envelopes checked` : 'pre-seal (no signing block yet): hosted invariants, run manifest and its signature, SARIF re-render and commitments checked'}${f.expectManifestDigest ? '; manifest digest equals --expect-manifest-digest' : ''}`);
  out(`sarif re-render: ${check.sarif_equal ? 'byte-equal' : 'DIFFERS'}`);
  for (const e of check.seal) out(e.startsWith('signature_invalid:') ? e : `hosted_invariant: ${e}`);
  for (const e of check.mismatch) out(`mismatch: ${e}`);
  out(`${status}: hosted seal verification (exit ${exitCode})`);
  return exitCode;
}

function unverifiable(errors: string[]): ExitCode {
  if (isJson()) outJson({ ok: false, status: 'unverifiable', exitCode: EXIT_CODES.error, errors });
  else {
    for (const e of errors) out(e);
    out(`unverifiable: the report's seal does not hold; do not trust its verdicts (exit ${EXIT_CODES.error})`);
  }
  return EXIT_CODES.error;
}

/**
 * G-33: a report whose RunSpec target disagrees with how its records drive the
 * target seat (an in-process reference relabelled as an external agent, or the
 * reverse) is not "unverifiable input": every record re-simulates, it just does
 * not belong to the RunSpec that claims it. When that is the ONLY reason every
 * episode failed (no other input error, no bad seal), the status is `mismatch`,
 * exit 1, like any other report that does not match its own inputs.
 */
export function driverMismatchIsMismatch(r: VerifyResult): VerifyResult {
  if (r.status !== 'unverifiable' || r.episodes.length === 0) return r;
  if (r.signature.checked && r.signature.status !== 'valid') return r;
  const isDriver = (e: string | undefined) => typeof e === 'string' && e.endsWith(DRIVER_MISMATCH_MESSAGE);
  if (!r.episodes.every((e) => e.status === 'unverifiable' && isDriver(e.error))) return r;
  if (!r.errors.every(isDriver)) return r;
  return { ...r, ok: false, status: 'mismatch', exitCode: EXIT_CODES.findings, episodes: r.episodes.map((e) => ({ ...e, status: 'mismatch' as const })) };
}

/** The cause rerun.ts names when a Diplomacy record's target press holds write-time redaction labels. */
const RECORD_REDACTED = /; the record's target press holds redaction labels written after the run.*$/s;

/**
 * An episode whose record holds redaction labels the engine never read does not
 * point at a version difference: the record differs from what the run wrote
 * (redacted or edited after the engine consumed it). Say that, with the episode,
 * instead of suggesting a re-run "with this agent-arena version".
 */
export function explainRecordDifference(r: VerifyResult): VerifyResult {
  const fix = (msg: string, episode: number | undefined): string =>
    msg.replace(
      RECORD_REDACTED,
      `; the record differs from what the run wrote${episode === undefined ? '' : ` (episode ${episode})`}: its target press holds redaction labels written after the run, which the engine never read, so it cannot re-simulate. Do not trust this report's verdicts; re-run the evaluation to get a verifiable report, and report the record if this build wrote it`,
    );
  if (!r.episodes.some((e) => e.error && RECORD_REDACTED.test(e.error)) && !r.errors.some((e) => RECORD_REDACTED.test(e))) return r;
  const byError = new Map(r.episodes.filter((e) => e.error).map((e) => [e.error!, e.episode_index]));
  return {
    ...r,
    episodes: r.episodes.map((e) => (e.error ? { ...e, error: fix(e.error, e.episode_index) } : e)),
    errors: r.errors.map((e) => fix(e, byError.get(e) ?? r.episodes.find((ep) => ep.error && e.includes(ep.error))?.episode_index)),
  };
}

export function verifyCommand(path: string | undefined, f: VerifyFlags = {}): ExitCode {
  if (!path) {
    out('usage: agent-arena verify <report.json> [--key <public key pem|jwk>] [--hosted]');
    return EXIT_CODES.misconfig;
  }
  if (f.hosted && !f.key) throw misconfig('--hosted checks a sealed report and needs the public key it was sealed with.', 'pass --key <pem|jwk> (the Sixi report-signing public key).');
  const publicKey: KeyObject | undefined = f.key !== undefined ? loadPublicKey(f.key) : undefined;
  const full = resolve(path);
  let report: unknown;
  try {
    report = readHostileJson(full, MAX_REPORT_BYTES, 'report');
  } catch (e) {
    const msg = e instanceof HostileFileError ? e.message : 'the report cannot be read';
    if (isJson()) outJson({ ok: false, status: 'unverifiable', exitCode: EXIT_CODES.error, errors: [msg] });
    else out(`unverifiable: ${msg}`);
    return EXIT_CODES.error;
  }
  const scenario = isObj(report) && isObj(report.scenario) ? str(report.scenario.scenario_id) : undefined;
  // HOSTED-PROFILE §5.6: a pack scenario re-simulates only with the pack's data.
  if (scenario && isPackScenarioId(scenario)) {
    throw new CliError(
      `${PACK_UNAVAILABLE}: ${scenario.slice(0, 40)} is a Sixi Arena pack scenario; this CLI ships the open scenarios only (unsupported).`,
      EXIT_CODES.misconfig,
      'a signed hosted report can still be checked with verify --hosted for signatures; re-simulation needs the pack (see your evidence report).',
    );
  }
  if (scenario && (SCENARIO_IDS as readonly string[]).includes(scenario) && !CLI_SCENARIOS.includes(scenario)) {
    throw misconfig(`${scenario} reports are not supported by this CLI version yet.`, 'verify it with the agent-arena release that adds diplomacy_standard support.');
  }
  if (f.hosted) {
    const resolvedKeys = resolveManifestKeys(f.manifestKey, { required: false, ...(f.pinnedKeys ? { pinned: f.pinnedKeys } : {}) });
    const manifestKeys = resolvedKeys.length ? resolvedKeys : undefined;
    const seal = hostedSealErrors(report, full, manifestKeys);
    if (seal.errors.length) return unverifiable(seal.errors);
    const commit = hostedCommitmentErrors(report, seal.manifest!);
    if (commit.length) {
      if (isJson()) outJson({ ok: false, status: 'mismatch', exitCode: EXIT_CODES.findings, errors: commit });
      else {
        for (const e of commit) out(`mismatch: ${e}`);
        out(`mismatch: the Diplomacy episode secrets do not match the commitments fixed before the run; do not trust intent_leak or any codeword-derived verdict (exit ${EXIT_CODES.findings})`);
      }
      return EXIT_CODES.findings;
    }
    if (!manifestKeys && !isJson()) out('run manifest: digest and fields match the seal; its own signature was not checked (this release pins no manifest key; pass --manifest-key <kid-bound control-plane key> to check it)');
  }
  // The inspector's replay file is derived data: when present it must equal the one regenerated from the record.
  const rerun = makeRerun(full, (rec, result, ctx) => {
    const p = resolveInside(dirname(full), ctx.replayRef!);
    if (!existsSync(p)) return;
    const stored = readHostileJson(p, MAX_REPORT_BYTES, 'replay file');
    if (JSON.stringify(stored) !== JSON.stringify(buildReplayFile(rec, result))) throw new Error(`${ctx.replayRef} does not match the replay regenerated from the record`);
  }, { hosted: !!f.hosted });
  const r = explainRecordDifference(driverMismatchIsMismatch(verifyReport(report, rerun, { engineBuilds: engineBuildsFor(report), ...(publicKey ? { publicKey } : {}) })));
  if (isJson()) {
    outJson(r);
    return r.exitCode;
  }
  printHuman(r);
  return r.exitCode;
}

function printHuman(r: VerifyResult): void {
  if (r.signature.checked) {
    out(r.signature.status === 'valid' ? `signature: valid (key ${r.signature.kid ?? '?'})` : `signature_invalid: the report's seal does not verify (${r.signature.status}${r.signature.kid ? `, key ${r.signature.kid}` : ''})`);
  }
  for (const e of r.episodes) {
    const hash = e.replay_hash.recomputed ?? e.replay_hash.reported ?? '-';
    out(`episode ${e.episode_index} seed ${e.seed}: ${e.status}  ${String(hash).slice(0, 23)}…`);
    const seats = r.provenance.filter((p) => p.episode_index === e.episode_index);
    if (seats.length) {
      out(`    seats: ${seats.map((p) => `${p.seat} ${p.label}${p.inputs_digest === 'match' || p.inputs_digest === 'mismatch' ? ` (inputs digest ${p.inputs_digest})` : ''}`).join(' · ')}`);
    }
    for (const d of e.diffs.slice(0, 8)) out(`    ${d.path}: reported ${JSON.stringify(d.reported)?.slice(0, 80)} · recomputed ${JSON.stringify(d.recomputed)?.slice(0, 80)}`);
    if (e.error) out(`    ${e.error}`);
  }
  for (const d of r.run.slice(0, 16)) out(`run ${d.path}: reported ${JSON.stringify(d.reported)?.slice(0, 80)} · recomputed ${JSON.stringify(d.recomputed)?.slice(0, 80)}`);
  for (const e of r.errors.filter((x) => !r.episodes.some((ep) => ep.error === x))) out(e.startsWith('signature_invalid:') ? e : `error: ${e}`);
  out(
    r.recorded_seats.length
      ? `recorded seats (moves taken from the record, not regenerated): ${r.recorded_seats.map((s) => `episode ${s.episode} ${s.seat} (${s.inputs_source})`).join(', ')}`
      : 'recorded seats: none besides the target (every other seat was regenerated from the seed)',
  );
  if (r.unverified.length) out(`recorded by the runner, not verifiable: ${r.unverified.join(', ')}`);
  const next =
    r.status === 'verified'
      ? 'every episode re-simulated to the reported hashes and verdicts'
      : r.status === 'mismatch'
        ? 'the report does not match its own inputs: do not trust its verdicts'
        : r.status === 'unsupported_engine'
          ? 'install the agent-arena version that produced the report and verify with it'
          : r.signature.checked && r.signature.status !== 'valid'
            ? 'the seal does not hold: check that --key is the key the report names, and that the report was not edited after sealing'
            : 'the report or one of its episode files is missing, malformed or hostile';
  out(`${r.status}: ${next} (exit ${r.exitCode})`);
}
