/**
 * The control-plane keys this open release pins (SIXI-INTEGRATION §1.5 "Pinning the
 * manifest key in the runner", OQ-3; SECURITY-REVIEW-HOSTED S-1; SECURITY-REVIEW-SIXI A8).
 * Sixi never rebuilds the image, so the key `run --hosted` checks a manifest against ships
 * IN the release: `pinned-keys.json`, next to this file, bundled into the CLI.
 *
 *   - `manifest`: the `?purpose=manifest` JWKS. Run manifests (signing.md §3, rule M3) and
 *     scenario packs (§11) verify against it and nothing else.
 *   - `report`: the `?purpose=report` JWKS. `verify --key pinned` (and
 *     `verify --hosted-seal --key pinned`) checks a sealed report against it.
 *   - The run-token key is NOT bundled: the CLI verifies a run token only in
 *     `serve-reference --hosted`, which takes `--run-token-key` (signing.md §10).
 *
 * Each key carries its window `[not_before, not_after)` (and `revoked_at`, when revoked). A
 * key is tried only for a document signed inside its window: a manifest's `issued_at`, a
 * sealed report's `signing.sealed_at`. Rotation: a new key ships in an open release (with a
 * green cross-check) before the control plane first signs with it; windows are 90 days, so at
 * least one open release per quarter. No network fetch, ever: the file is the trust root.
 *
 * G-47 trust-anchor rule (docs/phase-9/SECURITY-REVIEW-HOSTED.md, signing.md §3.2 M6):
 *   - pinned set NOT empty (this release) → `--manifest-key` is refused outright (the job
 *     arguments can never replace the release's trust root);
 *   - pinned set empty (only a programmatic test seam can make it so) → `--manifest-key`
 *     is accepted only when EVERY key is bound to a `kid`, with a warning;
 *   - neither → refused.
 */

import { createHash, createPublicKey } from 'node:crypto';
import { misconfig } from '../errors.ts';
import { loadPublicKeySet, type PinnedKey } from '../keys.ts';
import { warn } from '../ui.ts';
import { invalid } from './manifest.ts';
import BUNDLED from './pinned-keys.json' with { type: 'json' };

export const PINNED_KEY_FILE_FORMAT = 'agent-arena-pinned-keys/1';
/** contracts hosted_context.schema.json `signing.signing_key_id` / `signing_key_id`. */
export const KID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** A key window is at most 90 days of use plus 30 days of overlap (HOSTED-PROFILE §3.2). */
export const MAX_KEY_WINDOW_MS = 120 * 86_400_000;
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const KEY_MEMBERS = new Set(['kty', 'crv', 'x', 'kid', 'alg', 'use', 'sixi_purpose', 'status', 'not_before', 'not_after', 'revoked_at', 'sixi_thumbprint']);
const FILE_MEMBERS = new Set(['format', 'source', 'fetched_at', 'source_etag', 'source_sha256', 'note', 'manifest', 'report']);
const SET_MEMBERS = new Set(['source', 'source_sha256', 'keys']);
const STATUS = new Set(['next', 'current', 'valid', 'retired']);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
/** signing.md §3.3 rule 1: the file is at most 65536 bytes (pinned_keys.schema.json x-max-frame-bytes). */
export const MAX_PINNED_KEY_FILE_BYTES = 65536;
/** signing.md §3.3 rule 1: the kid namespace of each set (the run-token namespace, sixi-arena-runtoken, is never pinned). */
export const KID_NAMESPACE: Readonly<Record<'manifest' | 'report', string>> = { manifest: 'sixi-arena-manifest', report: 'sixi-arena' };

/** The RFC 7638 SHA-256 thumbprint of an Ed25519 OKP key: sha256 over {"crv":"Ed25519","kty":"OKP","x":"<x>"}. */
export function jwkThumbprint(x: string): Buffer {
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":${JSON.stringify(x)}}`).digest();
}

/** signing.md §3.3 rule 1 kid derivation: `<namespace>-ed25519-` + the first 80 bits of the thumbprint, lower-case hex. */
export function deriveKid(purpose: 'manifest' | 'report', x: string): string {
  return `${KID_NAMESPACE[purpose]}-ed25519-${jwkThumbprint(x).subarray(0, 10).toString('hex')}`;
}

export type KeyPurpose = 'manifest' | 'report';

export interface PinnedJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg?: 'EdDSA';
  sixi_purpose?: string;
  status?: string;
  not_before: string;
  not_after: string;
  revoked_at?: string;
  sixi_thumbprint?: string;
}

export interface PinnedKeyFile {
  format: typeof PINNED_KEY_FILE_FORMAT;
  source: string;
  fetched_at: string;
  manifest: { keys: readonly PinnedJwk[] };
  report: { keys: readonly PinnedJwk[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * An RFC 3339 UTC time (`…Z`, whole seconds) as epoch ms, or NaN. G-65: the value must round-trip, so an
 * impossible date that V8 would shift silently (`2026-11-31`, `T24:00:00Z`) is refused, not pinned a day off.
 */
const time = (v: unknown): number => {
  if (typeof v !== 'string' || !RFC3339_Z.test(v)) return NaN;
  const ms = Date.parse(v);
  return !Number.isNaN(ms) && new Date(ms).toISOString().replace('.000Z', 'Z') === v ? ms : NaN;
};

function checkKey(k: unknown, where: string, purpose: KeyPurpose): string[] {
  if (!isObj(k)) return [`${where}: not an object`];
  const p: string[] = [];
  const extra = Object.keys(k).filter((m) => !KEY_MEMBERS.has(m));
  if ('d' in k) p.push(`${where}: holds private key material ("d")`);
  else if (extra.length) p.push(`${where}: unknown member(s) ${extra.slice(0, 4).join(', ')}`);
  if (k.kty !== 'OKP' || k.crv !== 'Ed25519') p.push(`${where}: not an OKP Ed25519 key`);
  if (typeof k.x !== 'string' || !B64URL_32.test(k.x) || Buffer.from(k.x, 'base64url').length !== 32 || Buffer.from(k.x, 'base64url').toString('base64url') !== k.x) p.push(`${where}: x is not a canonical base64url 32-byte Ed25519 public key`);
  if (typeof k.kid !== 'string' || !KID_PATTERN.test(k.kid)) p.push(`${where}: kid does not match ${KID_PATTERN.source}`);
  if (k.use !== 'sig') p.push(`${where}: use must be "sig"`);
  if (k.alg !== undefined && k.alg !== 'EdDSA') p.push(`${where}: alg must be "EdDSA" when present`);
  if (k.sixi_purpose !== undefined && k.sixi_purpose !== purpose) p.push(`${where}: sixi_purpose ${String(k.sixi_purpose).slice(0, 20)} is not ${purpose}`);
  const nb = time(k.not_before);
  const na = time(k.not_after);
  if (Number.isNaN(nb) || Number.isNaN(na)) p.push(`${where}: not_before and not_after must be RFC 3339 UTC times (…Z)`);
  else if (!(na > nb)) p.push(`${where}: not_after is not after not_before`);
  else if (na - nb > MAX_KEY_WINDOW_MS) p.push(`${where}: the window is longer than 120 days (90-day rotation plus 30 days of overlap)`);
  if (k.revoked_at !== undefined) {
    const ra = time(k.revoked_at);
    if (Number.isNaN(ra)) p.push(`${where}: revoked_at must be an RFC 3339 UTC time`);
    else if (!Number.isNaN(nb) && ra < nb) p.push(`${where}: revoked_at is before not_before`);
  }
  if (k.status !== undefined && !STATUS.has(k.status as string)) p.push(`${where}: status must be next, current, valid or retired when present`);
  if (typeof k.x === 'string' && B64URL_32.test(k.x)) {
    if (k.sixi_thumbprint !== undefined && jwkThumbprint(k.x).toString('base64url') !== k.sixi_thumbprint) p.push(`${where}: sixi_thumbprint is not the RFC 7638 thumbprint of the key`);
    // Rule 1: every pinned kid is derived from its key, in its set's namespace.
    if (typeof k.kid === 'string' && k.kid !== deriveKid(purpose, k.x)) p.push(`${where}: kid is not ${KID_NAMESPACE[purpose]}-ed25519- followed by the first 80 bits of the key's RFC 7638 thumbprint in hex`);
  }
  return p;
}

/**
 * The shape of a bundled key file: format, source, fetch date, 1..16 manifest keys and 1..16
 * report keys, each an OKP Ed25519 public JWK with a contract-pattern kid, `use: sig` and a
 * window of at most 120 days; kids unique across both sets (separate namespaces, signing.md §2).
 * Returns the problems (empty = valid).
 */
export function pinnedKeyFileProblems(doc: unknown, fileBytes?: Uint8Array): string[] {
  if (!isObj(doc)) return ['the pinned key file is not a JSON object'];
  const p: string[] = [];
  // G-65: the limit is on the file's bytes where they exist (build time, tests); the bundle holds only the parsed
  // document, so at run time it is measured on the 2-space form the file is written in.
  const size = fileBytes ? fileBytes.byteLength : Buffer.byteLength(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  if (size > MAX_PINNED_KEY_FILE_BYTES) p.push(`the file is over ${MAX_PINNED_KEY_FILE_BYTES} bytes`);
  if (doc.format !== PINNED_KEY_FILE_FORMAT) p.push(`format must be ${PINNED_KEY_FILE_FORMAT}`);
  if (isObj(doc.runtoken) || Object.keys(doc).some((k) => /run.?token/i.test(k))) p.push('the run-token key is not bundled');
  else {
    const extra = Object.keys(doc).filter((m) => !FILE_MEMBERS.has(m));
    if (extra.length) p.push(`unknown top-level member(s) ${extra.slice(0, 4).map((m) => m.slice(0, 32)).join(', ')} (a file with a third set is invalid)`);
  }
  const source = typeof doc.source === 'string' && /^https:\/\/[^\s?#]+$/.test(doc.source) && doc.source.length <= 200 ? doc.source : undefined;
  if (!source) p.push('source must be the https URL the keys were fetched from, without a query');
  if (Number.isNaN(time(doc.fetched_at))) p.push('fetched_at must be an RFC 3339 UTC time');
  if (doc.source_sha256 !== undefined && (typeof doc.source_sha256 !== 'string' || !SHA256.test(doc.source_sha256))) p.push('source_sha256 must be sha256:<64 hex> when present');
  const kids: string[] = [];
  const xs = new Map<string, string>();
  for (const purpose of ['manifest', 'report'] as const) {
    const set = doc[purpose];
    const keys = isObj(set) ? set.keys : undefined;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 16) {
      p.push(`${purpose}.keys must hold 1..16 keys`);
      continue;
    }
    const s = set as Record<string, unknown>;
    const extra = Object.keys(s).filter((m) => !SET_MEMBERS.has(m));
    if (extra.length) p.push(`${purpose}: unknown member(s) ${extra.slice(0, 4).map((m) => m.slice(0, 32)).join(', ')}`);
    // Rule 1, stored as served: the set's source is the file's plus ?purpose=<set>, and its keys reproduce the served body.
    if (source && s.source !== `${source}?purpose=${purpose}`) p.push(`${purpose}.source must be the file's source followed by ?purpose=${purpose}`);
    if (typeof s.source_sha256 !== 'string' || !SHA256.test(s.source_sha256)) p.push(`${purpose}.source_sha256 must be sha256:<64 hex> of the served body`);
    else {
      const served = `sha256:${createHash('sha256').update(`${JSON.stringify({ keys })}\n`, 'utf8').digest('hex')}`;
      if (served !== s.source_sha256) p.push(`${purpose}.keys do not reproduce the served body: JSON.stringify({keys}) + LF does not hash to ${purpose}.source_sha256 (a key, a member or their order was changed)`);
    }
    keys.forEach((k, i) => {
      p.push(...checkKey(k, `${purpose}.keys[${i}]`, purpose));
      if (isObj(k) && typeof k.kid === 'string') kids.push(k.kid);
      if (isObj(k) && typeof k.x === 'string') {
        const other = xs.get(k.x);
        if (other !== undefined && other !== purpose) p.push(`${purpose}.keys[${i}]: the same public key is also in the ${other} set (one key per purpose)`);
        xs.set(k.x, purpose);
      }
    });
  }
  if (new Set(kids).size !== kids.length) p.push('a kid appears twice (manifest and report keys are separate kid namespaces)');
  return p;
}

/** G-65: a pinned key file checked as its bytes (build.ts checks the file it bundles this way). */
export function pinnedKeyFileBytesProblems(bytes: Uint8Array): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return ['the pinned key file is not JSON'];
  }
  return pinnedKeyFileProblems(doc, bytes);
}

let cache: PinnedKeyFile | undefined;
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The release's bundled key file, validated once (a malformed file refuses every hosted verification). */
export function pinnedKeyFile(): PinnedKeyFile {
  if (cache) return cache;
  const problems = pinnedKeyFileProblems(BUNDLED);
  if (problems.length) {
    throw misconfig(`the pinned control-plane key file of this release is malformed (${problems.slice(0, 3).join('; ')}).`, 'use an official agent-arena release; the bundled key file cannot be replaced at run time.');
  }
  cache = deepFreeze(structuredClone(BUNDLED) as PinnedKeyFile);
  return cache;
}

/** One validated JWK as a PinnedKey with its window in epoch ms. */
export function toPinnedKey(k: PinnedJwk): PinnedKey {
  return {
    kid: k.kid,
    key: createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' }),
    not_before: Date.parse(k.not_before),
    not_after: Date.parse(k.not_after),
    ...(k.revoked_at !== undefined ? { revoked_at: Date.parse(k.revoked_at) } : {}),
  };
}

export { keysForKid, keyWindowProblem } from '../keys.ts';

/** Kept for callers and reviews that name it: the manifest JWKS this release pins. */
export const PINNED_MANIFEST_JWKS: { readonly keys: readonly PinnedJwk[] } = { get keys() { return pinnedKeyFile().manifest.keys; } };

export function pinnedManifestKeys(): PinnedKey[] {
  return pinnedKeyFile().manifest.keys.map(toPinnedKey);
}

export function pinnedReportKeys(): PinnedKey[] {
  return pinnedKeyFile().report.keys.map(toPinnedKey);
}

/** `--key pinned`: the report keys of this release instead of a key file. */
export const PINNED_KEY_ARG = 'pinned';

export const NO_PINNED_KEY_WARNING =
  'no control-plane manifest key is pinned in this build; the manifest is checked against --manifest-key from the job template (kid-bound). Official releases bundle the Sixi manifest JWKS (hosted/pinned-keys.json).';

/**
 * The control-plane manifest key set for a hosted run or a pre-seal verification, under
 * the G-47 rule above. `pinned` defaults to this release's set (tests pass their own).
 * Returns [] only when `required` is false and no key is available.
 */
export function resolveManifestKeys(flag: string | undefined, o: { required: boolean; pinned?: readonly PinnedKey[]; flagName?: string }): PinnedKey[] {
  const F = o.flagName ?? '--manifest-key';
  const pinned = o.pinned ?? pinnedManifestKeys();
  if (pinned.length) {
    if (flag !== undefined) {
      throw invalid(F, `this release pins the control-plane manifest key set (${pinned.map((k) => k.kid ?? '?').join(', ')}); ${F} cannot replace or extend it.`, `remove ${F} from the job template; a new manifest key ships in a new release (SIXI-INTEGRATION §1.5).`);
    }
    return [...pinned];
  }
  if (flag === undefined) {
    if (!o.required) return [];
    throw invalid(F, 'this release pins no control-plane manifest key, and --manifest-key was not given.', 'use a release that bundles the Sixi manifest JWKS, or pass the pinned key (OKP JWK with kid, or JWKS) in the job template; never a key supplied by the customer.');
  }
  const keys = loadPublicKeySet(flag, F);
  if (keys.some((k) => k.kid === undefined)) {
    throw invalid(F, 'hosted mode needs a kid-bound manifest key: an OKP JWK with "kid", or a JWKS whose keys all carry one. A PEM (or a JWK without kid) would be tried for every kid and is refused.', 'pass the control-plane manifest key as {"kty":"OKP","crv":"Ed25519","x":"…","kid":"sixi-arena-manifest-ed25519-…"}.');
  }
  warn(NO_PINNED_KEY_WARNING);
  return keys;
}
