/**
 * `verify --hosted-seal` checks of a hosted run bundle (HOSTED-PROFILE §2.7,
 * §3.1; contracts signing.md §2, §5; SIXI-INTEGRATION §1.10).
 *
 * Two uses, one code path:
 *  - PRE-SEAL (the seal step's verifier job, the report has no `signing` yet):
 *    hosted invariants, run-manifest.json beside the report, SARIF re-render
 *    byte equality, Diplomacy commit-then-reveal. The caller then re-simulates.
 *  - SEALED (a customer or leg V with the downloaded bundle): all of the above,
 *    plus the three DSSE envelopes (`report.json.dsse.json` over the JCS body,
 *    `report.sarif.dsse.json` and `bundle-manifest.json.dsse.json` over the exact
 *    file bytes), key-id equality everywhere, and every file digest listed in
 *    `bundle-manifest.json`.
 *
 * Errors are split by what they mean: `seal` (exit 2, the evidence cannot be
 * trusted as sealed) and `mismatch` (exit 1, the report does not match its own
 * inputs or commitments).
 */

import { createHash, verify as edVerify } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalizeForSigning, pae, REPORT_PAYLOAD_TYPE, toFileJson, toSarif, type Report } from 'arena-report';
import { HostileFileError, readHostileBytes, readHostileJson, resolveInside } from '../files.ts';
import { inertJson } from '../inert.ts';
import { redact } from '../redact.ts';
import type { PinnedKey } from '../keys.ts';
import { schemaErrors, validateBundleManifest, BUNDLE_MANIFEST_MAX_BYTES } from './schemas.ts';

export const SARIF_PAYLOAD_TYPE = 'application/vnd.sixi.arena-sarif+json';
export const BUNDLE_PAYLOAD_TYPE = 'application/vnd.sixi.arena-bundle+json';
export const BUNDLE_MANIFEST_FILE = 'bundle-manifest.json';
/** Files `bundle-manifest.json` must always list (signing.md §5.1 rule 9; bundle_manifest.schema.json `files`). */
export const BUNDLE_REQUIRED_FILES = ['report.json', 'report.sarif', 'run-manifest.json'] as const;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_SARIF_BYTES = 64 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

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

/** Verify one DSSE envelope whose payload must be exactly `expected`; returns the problem, or null. */
function envelopeProblem(path: string, expected: Buffer, payloadType: string, kid: string, keys: readonly PinnedKey[], expectedSig?: string): string | null {
  let env: unknown;
  try {
    env = readHostileJson(path, 2 * expected.length + 64 * 1024, 'DSSE envelope');
  } catch (e) {
    return e instanceof HostileFileError ? e.message : 'the envelope cannot be read';
  }
  if (!isObj(env) || env.payloadType !== payloadType || typeof env.payload !== 'string' || !B64.test(env.payload) || !Array.isArray(env.signatures) || env.signatures.length !== 1) {
    return `${path.split('/').pop()} is not a single-signature DSSE envelope of type ${payloadType}`;
  }
  const payload = Buffer.from(env.payload, 'base64');
  if (!payload.equals(expected)) return `${path.split('/').pop()}: the envelope payload is not byte-equal to the file it signs`;
  const s = env.signatures[0] as unknown;
  if (!isObj(s) || s.keyid !== kid || typeof s.sig !== 'string' || !B64.test(s.sig)) return `${path.split('/').pop()}: keyid differs from ${kid} or the signature is malformed`;
  if (expectedSig !== undefined && s.sig !== expectedSig) return `${path.split('/').pop()}: the envelope signature is not byte-identical to signing.signature`;
  const sig = Buffer.from(s.sig, 'base64');
  const cands = keys.filter((k) => k.kid === undefined || k.kid === kid);
  if (sig.length !== 64 || !cands.some((k) => edVerify(null, pae(payloadType, payload), k.key, sig))) return `${path.split('/').pop()}: the Ed25519 signature does not verify against --key (kid ${kid})`;
  return null;
}

/**
 * The bundle checks that need the report key (sealed bundles): envelopes and the
 * bundle manifest. `reportPath` is the bundle's report.json.
 */
export function sealedBundleProblems(report: Report, reportPath: string, keys: readonly PinnedKey[]): { errors: string[]; files: number } {
  const dir = dirname(reportPath);
  const errs: string[] = [];
  const kid = report.signing!.signing_key_id;
  let body: Buffer;
  try {
    body = Buffer.from(canonicalizeForSigning(report), 'utf8');
  } catch (e) {
    return { errors: [`report.json cannot be canonicalised (${(e as Error).message.slice(0, 120)})`], files: 0 };
  }
  const p1 = envelopeProblem(join(dir, 'report.json.dsse.json'), body, REPORT_PAYLOAD_TYPE, kid, keys, report.signing!.signature);
  if (p1) errs.push(p1);
  let sarif: Buffer | undefined;
  try {
    sarif = readHostileBytes(join(dir, 'report.sarif'), MAX_SARIF_BYTES, 'SARIF log');
  } catch (e) {
    errs.push(e instanceof HostileFileError ? e.message : 'report.sarif cannot be read');
  }
  if (sarif) {
    const p2 = envelopeProblem(join(dir, 'report.sarif.dsse.json'), sarif, SARIF_PAYLOAD_TYPE, kid, keys);
    if (p2) errs.push(p2);
  }
  let bmBytes: Buffer;
  try {
    bmBytes = readHostileBytes(join(dir, BUNDLE_MANIFEST_FILE), BUNDLE_MANIFEST_MAX_BYTES, 'bundle manifest');
  } catch (e) {
    errs.push(e instanceof HostileFileError ? e.message : `${BUNDLE_MANIFEST_FILE} cannot be read`);
    return { errors: errs, files: 0 };
  }
  const p3 = envelopeProblem(join(dir, `${BUNDLE_MANIFEST_FILE}.dsse.json`), bmBytes, BUNDLE_PAYLOAD_TYPE, kid, keys);
  if (p3) errs.push(p3);
  let bm: unknown;
  try {
    bm = JSON.parse(bmBytes.toString('utf8'));
  } catch {
    errs.push(`${BUNDLE_MANIFEST_FILE} is not JSON`);
    return { errors: errs, files: 0 };
  }
  if (!validateBundleManifest(bm)) {
    errs.push(`${BUNDLE_MANIFEST_FILE} fails bundle_manifest.schema.json: ${schemaErrors(validateBundleManifest.errors)}`);
    return { errors: errs, files: 0 };
  }
  const m = bm as { run_id: string; signing_key_id: string; files: { path: string; sha256: string; bytes: number }[] };
  if (m.run_id !== report.run.run_id) errs.push(`${BUNDLE_MANIFEST_FILE}: run_id differs from the report`);
  if (m.signing_key_id !== kid) errs.push(`${BUNDLE_MANIFEST_FILE}: signing_key_id differs from the report seal`);
  const paths = m.files.map((f) => f.path);
  if (paths.join('\n') !== [...paths].sort().join('\n') || new Set(paths).size !== paths.length) errs.push(`${BUNDLE_MANIFEST_FILE}: files must be unique and sorted by path`);
  for (const f of m.files) {
    try {
      const b = readHostileBytes(resolveInside(dir, f.path), MAX_FILE_BYTES, `bundle file ${f.path}`);
      const got = `sha256:${createSha(b)}`;
      if (got !== f.sha256 || b.length !== f.bytes) errs.push(`bundle file ${f.path} does not match ${BUNDLE_MANIFEST_FILE} (sha256 or size)`);
    } catch (e) {
      errs.push(e instanceof HostileFileError ? e.message : `bundle file ${f.path} cannot be read`);
    }
  }
  // signing.md §5.1 rule 9 (contracts 2.6.0): the three core files are always listed.
  for (const p of BUNDLE_REQUIRED_FILES) if (!paths.includes(p)) errs.push(`${p} is not listed in ${BUNDLE_MANIFEST_FILE} (the bundle list always includes ${BUNDLE_REQUIRED_FILES.join(', ')})`);
  // Every episode file the report points at must be covered by the signature.
  for (const ep of report.episodes) {
    const ref = ep.replay_ref;
    if (!ref) continue;
    for (const p of [ref, ref.replace(/\.replay\.json$/, '.record.json')]) if (!paths.includes(p)) errs.push(`${p} is referenced by the report but not listed in ${BUNDLE_MANIFEST_FILE}`);
  }
  return { errors: errs, files: m.files.length };
}

function createSha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Hosted invariants the report alone must satisfy (seal step §1.10): mode, ownership source, the standing not-assessed entry. */
export function hostedInvariantProblems(report: Report): string[] {
  const errs: string[] = [];
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
