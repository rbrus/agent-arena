/**
 * Report signing (contracts/signing.md, contracts 2.2.0):
 *
 *   body    = UTF-8( JCS( D without /signing/signature ) )
 *   message = PAE(payload_type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
 *   sig     = Ed25519(key, message)            (RFC 8032 pure Ed25519, no pre-hash)
 *   signing.signature = base64(sig)
 *
 * The open core needs only verification; `signReport` exists for the sandbox
 * and the tests (the hosted seal step signs with a KMS key). Everything is
 * node:crypto, no dependency. Pure: no clock (`sealedAt` is an argument).
 */

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { jcs, sha256Hex } from './canonical.ts';
import { formatErrors, validateReportSchema } from './schemas.ts';
import type { Report, SigningBlock } from './types.ts';

export const REPORT_PAYLOAD_TYPE = 'application/vnd.sixi.arena-report+json';
export const RUN_MANIFEST_PAYLOAD_TYPE = 'application/vnd.sixi.arena-run-manifest+json';
export const CROSSCHECK_PAYLOAD_TYPE = 'application/vnd.sixi.arena-crosscheck+json';
export const SIGNATURE_POINTER = '/signing/signature';

const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
const KID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** A key as accepted here: a KeyObject, a PEM string, an OKP/Ed25519 JWK, or raw 32 bytes (public key, or private seed). */
export type Ed25519KeyInput = KeyObject | string | { kty: 'OKP'; crv: 'Ed25519'; x: string; d?: string } | Uint8Array;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function isKeyObject(k: unknown): k is KeyObject {
  return typeof k === 'object' && k !== null && 'asymmetricKeyType' in k && typeof (k as KeyObject).export === 'function';
}

export function toPublicKey(k: Ed25519KeyInput): KeyObject {
  let key: KeyObject;
  if (isKeyObject(k)) key = k.type === 'private' ? createPublicKey(k) : k;
  else if (typeof k === 'string') key = createPublicKey(k);
  else if (k instanceof Uint8Array) {
    if (k.length !== 32) throw new Error('a raw Ed25519 public key is 32 bytes');
    key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(k)]), format: 'der', type: 'spki' });
  } else key = createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`not an Ed25519 key (${key.asymmetricKeyType})`);
  return key;
}

export function toPrivateKey(k: Ed25519KeyInput): KeyObject {
  let key: KeyObject;
  if (isKeyObject(k)) key = k;
  else if (typeof k === 'string') key = createPrivateKey(k);
  else if (k instanceof Uint8Array) {
    if (k.length !== 32) throw new Error('a raw Ed25519 private key is the 32-byte seed');
    key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(k)]), format: 'der', type: 'pkcs8' });
  } else {
    if (!k.d) throw new Error('the JWK has no private part (d)');
    key = createPrivateKey({ key: k, format: 'jwk' });
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
  return key;
}

/** DSSE v1 pre-authentication encoding. LEN = decimal byte length. */
export function pae(payloadType: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, 'utf8')} ${payloadType} ${body.length} `, 'utf8'), Buffer.from(body)]);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The signed body of a signed contract document (report, run manifest,
 * cross-check record): strict JCS of the document with the one member
 * `/signing/signature` removed. Refuses a document whose `signing.excluded`
 * is not exactly `["/signing/signature"]` (signing.md §2: a signature can
 * never sign itself, and nothing else may be left out).
 */
export function canonicalizeForSigning(doc: unknown): string {
  if (!isObj(doc) || !isObj(doc.signing)) throw new Error('the document has no signing block');
  const ex = doc.signing.excluded;
  if (!Array.isArray(ex) || ex.length !== 1 || ex[0] !== SIGNATURE_POINTER) throw new Error(`signing.excluded must be exactly ["${SIGNATURE_POINTER}"]`);
  const { signature: _omit, ...signing } = doc.signing;
  return jcs({ ...doc, signing }, { strict: true });
}

/** sha256 of the signed body, `sha256:<hex>` (the run-manifest digest formula, signing.md §3). */
export function signedBodyDigest(doc: unknown): string {
  return `sha256:${sha256Hex(Buffer.from(canonicalizeForSigning(doc), 'utf8'))}`;
}

export interface SignatureCheck {
  ok: boolean;
  /** valid | invalid (present, does not verify or breaks an invariant) | unsigned (no signing block). */
  status: 'valid' | 'invalid' | 'unsigned';
  kid?: string;
  errors: string[];
}

/** Verify any signed contract document against one public key under the expected payload type (domain separation). */
export function verifyDocumentSignature(doc: unknown, publicKey: Ed25519KeyInput, payloadType: string): SignatureCheck {
  if (!isObj(doc) || doc.signing === undefined) return { ok: false, status: 'unsigned', errors: ['the document carries no signing block'] };
  const s = doc.signing as Partial<SigningBlock>;
  const errors: string[] = [];
  if (!isObj(s)) return { ok: false, status: 'invalid', errors: ['signing is not an object'] };
  const kid = typeof s.signing_key_id === 'string' ? s.signing_key_id : undefined;
  if (s.algorithm !== 'ed25519') errors.push('signing.algorithm is not ed25519');
  if (s.canonicalization !== 'jcs-rfc8785') errors.push('signing.canonicalization is not jcs-rfc8785');
  if (s.payload_type !== payloadType) errors.push(`signing.payload_type is ${JSON.stringify(s.payload_type)?.slice(0, 80)}, expected ${payloadType}`);
  if (!kid || !KID_RE.test(kid)) errors.push('signing.signing_key_id is missing or malformed');
  if (typeof s.signature !== 'string' || !SIGNATURE_RE.test(s.signature)) errors.push('signing.signature is not base64 of 64 bytes');
  let body: string | undefined;
  try {
    body = canonicalizeForSigning(doc);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (errors.length || body === undefined) return { ok: false, status: 'invalid', ...(kid ? { kid } : {}), errors };
  let key: KeyObject;
  try {
    key = toPublicKey(publicKey);
  } catch (e) {
    return { ok: false, status: 'invalid', ...(kid ? { kid } : {}), errors: [`the public key is unusable: ${(e as Error).message}`] };
  }
  const good = edVerify(null, pae(payloadType, Buffer.from(body, 'utf8')), key, Buffer.from(s.signature as string, 'base64'));
  return good ? { ok: true, status: 'valid', kid, errors: [] } : { ok: false, status: 'invalid', kid, errors: ['the Ed25519 signature does not verify over PAE(payload_type, JCS(report without /signing/signature))'] };
}

/**
 * Verify a report's `signing` seal: the Ed25519 signature under the report
 * payload type, plus the in-document invariants of signing.md §2-§3
 * (kid equality with `run.hosted.signing_key_id`, `run_manifest_digest`
 * equality with `run.hosted.run_manifest.digest`). Schema validity is not
 * checked here (verifyReport does that first).
 */
export function verifyReportSignature(report: unknown, publicKey: Ed25519KeyInput): SignatureCheck {
  const r = verifyDocumentSignature(report, publicKey, REPORT_PAYLOAD_TYPE);
  if (r.status === 'unsigned') return r;
  const rep = report as Partial<Report>;
  const hosted = rep.run?.hosted;
  const errs = [...r.errors];
  if (!hosted) errs.push('a signed report must carry run.hosted');
  else {
    if (hosted.signing_key_id !== rep.signing?.signing_key_id) errs.push('signing.signing_key_id differs from run.hosted.signing_key_id');
    if (hosted.run_manifest?.digest !== rep.signing?.run_manifest_digest) errs.push('signing.run_manifest_digest differs from run.hosted.run_manifest.digest');
  }
  return errs.length ? { ok: false, status: 'invalid', ...(r.kid ? { kid: r.kid } : {}), errors: errs } : r;
}

/** Sign any contract document in place of its `signing.signature` (the rest of `signing` must already be set). */
export function signDocument<T extends { signing?: unknown }>(doc: T, privateKey: Ed25519KeyInput, payloadType: string): T {
  const out = JSON.parse(JSON.stringify(doc)) as T & { signing: Record<string, unknown> };
  if (!isObj(out.signing)) throw new Error('the document has no signing block to complete');
  if (out.signing.payload_type !== payloadType) throw new Error(`signing.payload_type must be ${payloadType}`);
  const body = Buffer.from(canonicalizeForSigning(out), 'utf8');
  out.signing.signature = edSign(null, pae(payloadType, body), toPrivateKey(privateKey)).toString('base64');
  return out;
}

export interface SignReportOptions {
  /** RFC 3339 instant of the seal (the package has no clock). Default: the report's existing `signing.sealed_at`. */
  sealedAt?: string;
}

/**
 * Seal a hosted report (signing.md §2-§3): writes the whole `signing` block
 * (`kid` must equal `run.hosted.signing_key_id`; the manifest digest is copied
 * from `run.hosted.run_manifest.digest`) and signs it. The result validates
 * against report.schema.json or this throws. Does not mutate its input.
 */
export function signReport(report: Report, privateKey: Ed25519KeyInput, kid: string, opts: SignReportOptions = {}): Report {
  const hosted = report.run.hosted;
  if (!hosted) throw new Error('only a hosted report (run.hosted) can be sealed');
  if (!report.not_assessed) throw new Error('a sealed report must carry its not_assessed section');
  if (!KID_RE.test(kid)) throw new Error('kid must match ^[a-z0-9][a-z0-9._-]{2,63}$');
  if (hosted.signing_key_id !== kid) throw new Error(`kid ${kid} differs from run.hosted.signing_key_id ${hosted.signing_key_id}`);
  const sealedAt = opts.sealedAt ?? report.signing?.sealed_at;
  if (!sealedAt) throw new Error('sealedAt is required');
  const signing: SigningBlock = {
    algorithm: 'ed25519',
    signing_key_id: kid,
    canonicalization: 'jcs-rfc8785',
    payload_type: REPORT_PAYLOAD_TYPE,
    excluded: [SIGNATURE_POINTER],
    run_manifest_digest: hosted.run_manifest.digest,
    sealed_at: sealedAt,
    signature: `${'A'.repeat(86)}==`,
  };
  const signed = signDocument({ ...report, signing }, privateKey, REPORT_PAYLOAD_TYPE);
  if (!validateReportSchema(signed)) throw new Error(`the sealed report does not validate: ${formatErrors(validateReportSchema.errors).join('; ')}`);
  return signed;
}
