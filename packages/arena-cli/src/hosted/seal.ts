/**
 * `verify --hosted-seal` checks of a hosted run bundle (HOSTED-PROFILE §2.7,
 * §3.1; contracts signing.md §2, §5; SIXI-INTEGRATION §1.10).
 *
 * Two uses, one code path:
 *  - PRE-SEAL (the seal step's verifier job, the report has no `signing` yet):
 *    hosted invariants, run-manifest.json beside the report, SARIF re-render
 *    byte equality, Diplomacy commit-then-reveal. The caller then re-simulates.
 *  - SEALED (a customer or leg V with the downloaded bundle): all of the above,
 *    plus the report's embedded signature and the three DSSE envelopes
 *    (`report.json.dsse.json` over the JCS body, `report.sarif.dsse.json` and
 *    `bundle-manifest.json.dsse.json` over the exact file bytes), each raw or
 *    (contracts 2.11.0) through a signed digest statement (digest-statement.ts,
 *    signing.md §5.2 D1-D9 / E1-E4), key-id equality everywhere, and every file
 *    digest listed in `bundle-manifest.json`.
 *
 * Errors are split by what they mean: `seal` (exit 2, the evidence cannot be
 * trusted as sealed) and `mismatch` (exit 1, the report does not match its own
 * inputs or commitments).
 */

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalizeForSigning, REPORT_PAYLOAD_TYPE, toFileJson, toSarif, type Report } from 'arena-report';
import { HostileFileError, readHostileBytes, readHostileJson, resolveInside } from '../files.ts';
import { inertJson } from '../inert.ts';
import { redact } from '../redact.ts';
import type { PinnedKey } from '../keys.ts';
import { schemaErrors, validateBundleManifest, BUNDLE_MANIFEST_MAX_BYTES } from './schemas.ts';
import { bindingContextProblem, BUNDLE_PAYLOAD_TYPE, refusalLine, SARIF_PAYLOAD_TYPE, SignatureRefusal, verifyDetachedEnvelope, verifyEmbeddedSignature, type BindingContext, type VerifiedSignature } from './digest-statement.ts';

export { BUNDLE_PAYLOAD_TYPE, SARIF_PAYLOAD_TYPE };
export const BUNDLE_MANIFEST_FILE = 'bundle-manifest.json';
/** Files `bundle-manifest.json` must always list (signing.md §5.1 rule 9; bundle_manifest.schema.json `files`). */
export const BUNDLE_REQUIRED_FILES = ['report.json', 'report.sarif', 'run-manifest.json'] as const;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_SARIF_BYTES = 64 * 1024 * 1024;
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);


export interface SealCheck {
  sealed: boolean;
  sarif_equal: boolean;
  /** Bundle files whose sha256 and size were checked (sealed bundles only). */
  bundle_files: number;
  seal: string[];
  mismatch: string[];
}

/** The SARIF exactly as the runner writes it from this report (run.ts specPath; files.ts writeOutput: redact, then inertJson). */
export function renderSarif(report: Report): string {
  return inertJson(redact(toFileJson(toSarif(report, { specPath: `.agent-arena/${report.scenario.scenario_id}.run.json` }))));
}

/** Read `<file>.dsse.json` beside the report (capped: at most twice the covered bytes plus 65536, §5.1 rule 8). */
function readEnvelopeFile(dir: string, file: string, covered: number): unknown {
  try {
    return readHostileJson(join(dir, `${file}.dsse.json`), 2 * covered + 64 * 1024, 'DSSE envelope');
  } catch (e) {
    throw new SignatureRefusal('signature', `${file}.dsse.json: ${e instanceof HostileFileError ? e.message : 'the envelope cannot be read'}`);
  }
}

/** Run one §5.2 check; a refusal becomes its `signature_invalid: <reason>: …` line (the caller prefixes nothing). */
function attempt(errs: string[], forms: VerifiedSignature[], f: () => VerifiedSignature): void {
  try {
    forms.push(f());
  } catch (e) {
    if (!(e instanceof SignatureRefusal)) throw e;
    errs.push(refusalLine(e));
  }
}

/**
 * The bundle checks that need the report key (sealed bundles): the report's embedded signature and its
 * `report.json.dsse.json` (§5.2 E1-E4), the two detached envelopes (§5.2 D1-D9, either form), and the bundle
 * manifest. `keys` is the report key set (pinned: by kid inside the window at `signing.sealed_at`; --key: no
 * window). `reportPath` is the bundle's report.json. Every error line starts with `signature_invalid:`.
 */
export function sealedBundleProblems(report: Report, reportPath: string, keys: readonly PinnedKey[]): { errors: string[]; files: number; forms: VerifiedSignature[] } {
  const dir = dirname(reportPath);
  const errs: string[] = [];
  const forms: VerifiedSignature[] = [];
  // G-62: a report without a signing object (or run) is refused, not dereferenced.
  if (!isObj(report) || !isObj(report.signing) || !isObj(report.run)) return { errors: ['signature_invalid: signature: report.json: the report carries no signing block'], files: 0, forms };
  const signing = report.signing;
  // G-63: kid and sealed_at are quoted by the envelope checks below; outside the contract they are refused here, unquoted.
  const badCtx = bindingContextProblem(signing);
  if (badCtx) return { errors: [`signature_invalid: signature: report.json: ${badCtx}`], files: 0, forms };
  const kid = signing.signing_key_id;
  const ctx: BindingContext = { signing_key_id: kid, sealed_at: signing.sealed_at, run_id: report.run.run_id, run_manifest_digest: signing.run_manifest_digest };
  let covered = 0;
  try {
    covered = Buffer.byteLength(canonicalizeForSigning(report), 'utf8');
  } catch (e) {
    return { errors: [`signature_invalid: signature: report.json cannot be canonicalised (${(e as Error).message.slice(0, 120)})`], files: 0, forms };
  }
  attempt(errs, forms, () => verifyEmbeddedSignature(report, REPORT_PAYLOAD_TYPE, keys, 'report.json', readEnvelopeFile(dir, 'report.json', covered)));
  let sarif: Buffer | undefined;
  try {
    sarif = readHostileBytes(join(dir, 'report.sarif'), MAX_SARIF_BYTES, 'SARIF log');
  } catch (e) {
    errs.push(`signature_invalid: ${e instanceof HostileFileError ? e.message : 'report.sarif cannot be read'}`);
  }
  if (sarif) attempt(errs, forms, () => verifyDetachedEnvelope(readEnvelopeFile(dir, 'report.sarif', sarif!.length), sarif!, SARIF_PAYLOAD_TYPE, ctx, keys, 'report.sarif'));
  let bmBytes: Buffer;
  try {
    bmBytes = readHostileBytes(join(dir, BUNDLE_MANIFEST_FILE), BUNDLE_MANIFEST_MAX_BYTES, 'bundle manifest');
  } catch (e) {
    errs.push(`signature_invalid: ${e instanceof HostileFileError ? e.message : `${BUNDLE_MANIFEST_FILE} cannot be read`}`);
    return { errors: errs, files: 0, forms };
  }
  attempt(errs, forms, () => verifyDetachedEnvelope(readEnvelopeFile(dir, BUNDLE_MANIFEST_FILE, bmBytes.length), bmBytes, BUNDLE_PAYLOAD_TYPE, ctx, keys, BUNDLE_MANIFEST_FILE));
  const bundleErr = (m: string) => errs.push(`signature_invalid: ${m}`);
  let bm: unknown;
  try {
    bm = JSON.parse(bmBytes.toString('utf8'));
  } catch {
    bundleErr(`${BUNDLE_MANIFEST_FILE} is not JSON`);
    return { errors: errs, files: 0, forms };
  }
  if (!validateBundleManifest(bm)) {
    bundleErr(`${BUNDLE_MANIFEST_FILE} fails bundle_manifest.schema.json: ${schemaErrors(validateBundleManifest.errors)}`);
    return { errors: errs, files: 0, forms };
  }
  const m = bm as { run_id: string; signing_key_id: string; files: { path: string; sha256: string; bytes: number }[] };
  if (m.run_id !== report.run.run_id) bundleErr(`${BUNDLE_MANIFEST_FILE}: run_id differs from the report`);
  if (m.signing_key_id !== kid) bundleErr(`${BUNDLE_MANIFEST_FILE}: signing_key_id differs from the report seal`);
  const paths = m.files.map((f) => f.path);
  if (paths.join('\n') !== [...paths].sort().join('\n') || new Set(paths).size !== paths.length) bundleErr(`${BUNDLE_MANIFEST_FILE}: files must be unique and sorted by path`);
  for (const f of m.files) {
    try {
      const b = readHostileBytes(resolveInside(dir, f.path), MAX_FILE_BYTES, `bundle file ${f.path}`);
      const got = `sha256:${createSha(b)}`;
      if (got !== f.sha256 || b.length !== f.bytes) bundleErr(`bundle file ${f.path} does not match ${BUNDLE_MANIFEST_FILE} (sha256 or size)`);
    } catch (e) {
      bundleErr(e instanceof HostileFileError ? e.message : `bundle file ${f.path} cannot be read`);
    }
  }
  // signing.md §5.1 rule 9 (contracts 2.6.0): the three core files are always listed.
  for (const p of BUNDLE_REQUIRED_FILES) if (!paths.includes(p)) bundleErr(`${p} is not listed in ${BUNDLE_MANIFEST_FILE} (the bundle list always includes ${BUNDLE_REQUIRED_FILES.join(', ')})`);
  // Every episode file the report points at must be covered by the signature.
  for (const ep of Array.isArray(report.episodes) ? report.episodes : []) {
    const ref = isObj(ep) ? ep.replay_ref : undefined;
    if (typeof ref !== 'string' || !ref) continue;
    for (const p of [ref, ref.replace(/\.replay\.json$/, '.record.json')]) if (!paths.includes(p)) bundleErr(`${p} is referenced by the report but not listed in ${BUNDLE_MANIFEST_FILE}`);
  }
  return { errors: errs, files: m.files.length, forms };
}

function createSha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Hosted invariants the report alone must satisfy (seal step §1.10): mode, ownership source, the standing not-assessed entry. */
export function hostedInvariantProblems(report: Report): string[] {
  const errs: string[] = [];
  if (!isObj(report) || !isObj(report.run)) return ['report.json has no run object'];
  if (report.run.mode !== 'hosted' || !report.run.hosted) errs.push('run.mode is not hosted, or run.hosted is missing');
  if (report.run.target_ownership?.source !== 'sixi_verified') errs.push('run.target_ownership.source is not sixi_verified');
  if (!report.not_assessed?.some((e) => e.kind === 'property' && e.id === 'robustness.seed_recovery' && e.reason_code === 'seed_recovery_not_modelled')) {
    errs.push('not_assessed lacks robustness.seed_recovery (threat-model-hosted §2.5: scripted adversaries are seed functions)');
  }
  return errs;
}

/** SARIF re-render equality (HOSTED-PROFILE §2.7 step 3): report.sarif must be byte-equal to the SARIF rendered from report.json. */
export function sarifEqual(report: Report, reportPath: string): { equal: boolean; error?: string } {
  let file: Buffer;
  try {
    file = readHostileBytes(join(dirname(reportPath), 'report.sarif'), MAX_SARIF_BYTES, 'SARIF log');
  } catch (e) {
    return { equal: false, error: e instanceof HostileFileError ? e.message : 'report.sarif cannot be read' };
  }
  let rendered: string;
  try {
    rendered = renderSarif(report);
  } catch (e) {
    return { equal: false, error: `the SARIF cannot be re-rendered from report.json (${(e as Error).message.slice(0, 160)})` };
  }
  return file.equals(Buffer.from(rendered, 'utf8')) ? { equal: true } : { equal: false, error: 'report.sarif is not byte-equal to the SARIF re-rendered from report.json' };
}
