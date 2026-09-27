/**
 * The signed run manifest (contracts 2.2.0 `hosted_context.schema.json`,
 * signing.md §3; threat-model-hosted §2.1, §10.2): the hosted runner's only
 * trusted input. Everything security-relevant comes from here, from the RunSpec
 * the manifest binds by digest, or from the frozen `hosted-v1` policy; nothing
 * from flags or the customer.
 *
 * Every refusal is `hosted_context_invalid` (errors.md §1d, exit 3) naming the
 * field, and is raised before any network I/O.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash, verify as edVerify } from 'node:crypto';
import { canonicalizeForSigning, jcs, pae, RUN_MANIFEST_PAYLOAD_TYPE, signedBodyDigest, validateRunSpecSchema } from 'arena-report';
import { misconfig, type CliError } from '../errors.ts';
import type { HostedContextContract, RunSpecContract } from '../generated/contracts.ts';
import type { PinnedKey } from '../keys.ts';
import { HOSTED_CONTEXT_MAX_BYTES, schemaErrors, validateHostedContext } from './schemas.ts';

export const HOSTED_CONTEXT_INVALID = 'hosted_context_invalid';
/** contracts 2.5.0 signing.md §3.1: the manifest file is at most 8192 bytes (and its canonical body fits x-max-frame-bytes). */
export const MAX_MANIFEST_FILE_BYTES = 8192;
/** `x-max-frame-bytes` of run_spec.schema.json (HOSTED-PROFILE §2.3: at most 16 KiB). */
export const MAX_RUN_SPEC_BYTES = 16 * 1024;

export const invalid = (field: string, message: string, next?: string): CliError =>
  misconfig(`${HOSTED_CONTEXT_INVALID} (${field}): ${message} Nothing was sent.`, next ?? 'the run manifest comes from the Sixi control plane; start a new run from the control plane instead of editing it.');

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function hostileKey(v: unknown, depth = 0): string | null {
  if (v === null || typeof v !== 'object') return null;
  if (depth > 16) return 'nesting deeper than 16';
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) return `forbidden key ${k}`;
    const r = hostileKey((v as Record<string, unknown>)[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** Read one control-plane input file once: O_NOFOLLOW, regular file, size-capped. Never echoes content. */
function readInputFile(path: string, flag: '--manifest' | '--run-spec', cap: number): string {
  const what = flag === '--manifest' ? 'manifest' : 'RunSpec';
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    throw invalid('manifest_source', code === 'ELOOP' ? `the ${what} path is a symbolic link.` : `the ${what} file cannot be opened (${code}).`, `the job spec must mount the ${what} the control plane wrote (read-only) and pass its path to ${flag}.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw invalid('manifest_source', `the ${what} path (${flag}) is not a regular file.`);
    if (st.size > cap) throw invalid('manifest_source', `the ${what} file (${flag}) is ${st.size} bytes (cap ${cap}).`);
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > cap) throw invalid('manifest_source', `the ${what} file (${flag}) grew past its cap while it was read.`);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

export const readManifestFile = (path: string): string => readInputFile(path, '--manifest', MAX_MANIFEST_FILE_BYTES);
/** contracts 2.5.0 signing.md §3.1: the RunSpec file is at most 16384 bytes. */
export const readRunSpecFile = (path: string): string => readInputFile(path, '--run-spec', MAX_RUN_SPEC_BYTES);

export interface VerifiedManifest {
  doc: HostedContextContract;
  /** The file text exactly as received (written to the bundle as run-manifest.json). */
  text: string;
  /** `run_manifest_digest` = sha256(JCS(manifest without /signing/signature)). */
  digest: string;
  /** The control plane's manifest key id (signing.signing_key_id). */
  kid: string;
}

/**
 * Parse, schema-validate and signature-check a manifest against the pinned key
 * set. Kid rules: the manifest kid must differ from the report key id it names
 * (separate namespaces, signing.md §2); when a pinned key carries a `kid`, only a
 * key with the manifest's kid is tried, and a manifest kid no pinned key names is
 * refused; a key without a kid (PEM) is tried for any kid.
 */
export function verifyManifest(text: string, keys: readonly PinnedKey[]): VerifiedManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalid('/', 'the manifest is not JSON.');
  }
  const hk = hostileKey(doc);
  if (hk) throw invalid('/', `the manifest is hostile (${hk}).`);
  if (!validateHostedContext(doc)) throw invalid(schemaFieldOf(validateHostedContext.errors), `the manifest fails hosted_context.schema.json: ${schemaErrors(validateHostedContext.errors)}.`);
  const m = doc as HostedContextContract;
  let body: string;
  try {
    body = canonicalizeForSigning(m);
  } catch (e) {
    throw invalid('/signing', (e as Error).message);
  }
  if (Buffer.byteLength(body, 'utf8') > HOSTED_CONTEXT_MAX_BYTES) throw invalid('/', `the canonical manifest is over ${HOSTED_CONTEXT_MAX_BYTES} bytes (x-max-frame-bytes).`);
  const kid = m.signing.signing_key_id;
  if (kid === m.signing_key_id) throw invalid('/signing/signing_key_id', 'the manifest is signed with the report key id; run manifests and reports use separate keys (signing.md §2).');
  const named = keys.filter((k) => k.kid !== undefined);
  const candidates = keys.filter((k) => k.kid === undefined || k.kid === kid);
  if (!candidates.length) {
    throw invalid('/signing/signing_key_id', `the manifest is signed by key ${kid}, which is not a pinned control-plane key (pinned: ${named.map((k) => k.kid).join(', ')}).`, 'pin the current control-plane manifest key (JWKS) in the image or job spec.');
  }
  const message = pae(RUN_MANIFEST_PAYLOAD_TYPE, Buffer.from(body, 'utf8'));
  const sig = Buffer.from(m.signing.signature, 'base64');
  if (!candidates.some((k) => edVerify(null, message, k.key, sig))) {
    throw invalid('/signing/signature', `the Ed25519 signature does not verify against the pinned control-plane key${candidates.length > 1 ? 's' : ''} for kid ${kid} (payload type ${RUN_MANIFEST_PAYLOAD_TYPE}).`);
  }
  return { doc: m, text, digest: signedBodyDigest(m), kid };
}

function schemaFieldOf(errors: typeof validateHostedContext.errors): string {
  const e = errors?.[0];
  return e ? e.instancePath || '/' : '/';
}

/** `linux/amd64` | `linux/arm64` for this process, or null when this is not a hosted platform. */
export function runningPlatform(): 'linux/amd64' | 'linux/arm64' | null {
  if (process.platform !== 'linux') return null;
  return process.arch === 'x64' ? 'linux/amd64' : process.arch === 'arm64' ? 'linux/arm64' : null;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Image allowlist (threat-model-hosted §8, HOSTED-PROFILE §2.2): the job spec
 * sets ARENA_IMAGE_DIGEST to the digests this container was pulled by (comma
 * separated `sha256:<hex>`: the index digest and the platform manifest digest).
 * The manifest's `image_digest.index` AND `platform_manifest` must both be on
 * it, and `platform` must be the running platform. Unset = refused.
 */
export function checkImage(m: HostedContextContract, allowlist: string | undefined, platform: string | null): void {
  if (allowlist === undefined || allowlist.trim() === '') {
    throw invalid('/image_digest', 'ARENA_IMAGE_DIGEST is not set, so this container cannot prove which image it is.', 'the hosted job spec must set ARENA_IMAGE_DIGEST=<index digest>,<platform manifest digest> of the pulled image.');
  }
  const list = allowlist.split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length || list.length > 8 || !list.every((d) => DIGEST_RE.test(d))) {
    throw invalid('/image_digest', 'ARENA_IMAGE_DIGEST must be 1..8 comma-separated sha256:<64 hex> digests.');
  }
  const d = m.image_digest;
  if (!list.includes(d.index)) throw invalid('/image_digest/index', `the manifest names image ${d.index}, which is not the running image (${list.join(', ')}).`, 'the control plane must schedule the digest it admitted; a mismatch means the wrong image ran.');
  if (!list.includes(d.platform_manifest)) throw invalid('/image_digest/platform_manifest', `the manifest names platform manifest ${d.platform_manifest}, which is not the running image (${list.join(', ')}).`);
  if (platform !== d.platform) throw invalid('/image_digest/platform', `the manifest names platform ${d.platform}, but this process runs on ${platform ?? `${process.platform}/${process.arch}`}.`);
}

/** The engine build this runner would record for the scenario must be the manifest's. */
export function checkEngine(m: HostedContextContract, runningBuild: string): void {
  if (m.engine_build_hash !== runningBuild) {
    throw invalid('/engine_build_hash', `the manifest was admitted for engine build ${m.engine_build_hash}, but this runner is ${runningBuild}.`, 'promote the image whose engine build the control plane admitted (the cross-check record names it).');
  }
}

/** Clock skew tolerated on a manifest time that must not be in the future. */
export const MANIFEST_SKEW_MS = 5 * 60_000;
/** G-51: a manifest older than this at start is refused (an old manifest cannot be replayed against the target). */
export const MANIFEST_MAX_AGE_MS = 24 * 3_600_000;
/** G-51: `wall_clock_deadline − issued_at` may not exceed this (the largest plan cap, with margin). */
export const MANIFEST_MAX_WINDOW_MS = 48 * 3_600_000;
/** G-51: the ownership proof (`verified_origin.checked_at`) must be at most this old (threat-model-hosted §7.1 re-check). */
export const OWNERSHIP_MAX_AGE_MS = 24 * 3_600_000;

/**
 * `hosted-v1` is the only policy; an expired, stale or over-long manifest never starts
 * (G-51): issued at most 24 h ago and not in the future, a deadline in the future and at
 * most 48 h after issue, and an ownership check at most 24 h old.
 */
export function checkPolicyAndClock(m: HostedContextContract, now: number): number {
  if (m.net_policy !== 'hosted-v1') throw invalid('/net_policy', 'only the frozen hosted-v1 network policy exists.');
  const deadline = Date.parse(m.wall_clock_deadline);
  const fresh = 'the control plane must issue a fresh manifest; an old one cannot be replayed.';
  if (!(deadline > now)) throw invalid('/wall_clock_deadline', `the run's wall-clock deadline ${m.wall_clock_deadline} has passed.`, fresh);
  const issued = Date.parse(m.issued_at);
  if (issued > now + MANIFEST_SKEW_MS) throw invalid('/issued_at', 'the manifest is issued more than 5 minutes in the future (clock skew or a forged manifest).');
  if (!(now - issued <= MANIFEST_MAX_AGE_MS)) throw invalid('/issued_at', `the manifest was issued more than 24 h ago (issued_at ${m.issued_at}).`, fresh);
  if (!(deadline - issued <= MANIFEST_MAX_WINDOW_MS)) throw invalid('/wall_clock_deadline', 'the wall-clock deadline is more than 48 h after issued_at; no plan runs that long.', 'the control plane must set wall_clock_deadline from the plan cap.');
  const checked = Date.parse(m.verified_origin.checked_at);
  if (!(checked <= now + MANIFEST_SKEW_MS)) throw invalid('/verified_origin/checked_at', 'the ownership check is dated more than 5 minutes in the future.');
  if (!(now - checked <= OWNERSHIP_MAX_AGE_MS)) throw invalid('/verified_origin/checked_at', 'the ownership proof is stale: verified_origin.checked_at is more than 24 h old.', 'the control plane must re-check the origin (threat-model-hosted §7.1) and issue a new manifest.');
  return deadline;
}

/**
 * The RunSpec the manifest binds (`run_spec_digest`): the `--run-spec` file,
 * parsed, size-capped (canonical form ≤ 16 KiB), schema-validated, and its JCS
 * digest must equal the signed one. From here on every RunSpec field is a
 * Sixi-signed input.
 */
export function bindRunSpec(m: HostedContextContract, text: string): RunSpecContract {
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch {
    throw invalid('/run_spec_digest', 'the --run-spec file is not JSON.');
  }
  const hk = hostileKey(spec);
  if (hk) throw invalid('/run_spec_digest', `the --run-spec file is hostile (${hk}).`);
  let canonical: string;
  try {
    canonical = jcs(spec, { strict: true });
  } catch (e) {
    throw invalid('/run_spec_digest', `the RunSpec cannot be canonicalised (${(e as Error).message.slice(0, 120)}).`);
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_RUN_SPEC_BYTES) throw invalid('/run_spec_digest', `the canonical RunSpec is over ${MAX_RUN_SPEC_BYTES} bytes (x-max-frame-bytes).`);
  const digest = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  if (digest !== m.run_spec_digest) throw invalid('/run_spec_digest', 'the --run-spec file is not the RunSpec the manifest was signed for (run_spec_digest differs).');
  if (!validateRunSpecSchema(spec)) throw invalid('/run_spec_digest', `the bound RunSpec fails run_spec.schema.json: ${schemaErrors(validateRunSpecSchema.errors)}.`);
  return spec as RunSpecContract;
}

export const DIP_SECRET_COMMIT_PREFIX = 'wot-dip/secret-commit|';

/** signing.md §4: the commitment of one episode secret (64 lower-case hex). */
export function episodeSecretCommitment(secret: string): string {
  return `sha256:${createHash('sha256').update(`${DIP_SECRET_COMMIT_PREFIX}${secret}`, 'utf8').digest('hex')}`;
}

/** signing.md §4: `episode_secret_commitments.digest` = sha256(JCS([commitment_0, …])). */
export function commitmentListDigest(commitments: readonly string[]): string {
  return `sha256:${createHash('sha256').update(jcs([...commitments]), 'utf8').digest('hex')}`;
}
