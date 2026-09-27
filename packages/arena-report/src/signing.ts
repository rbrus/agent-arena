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
/** (contracts 2.11.0, signing.md §5.2) The PAE type of a signed digest statement (`digest_statement.schema.json`). */
export const DIGEST_STATEMENT_PAYLOAD_TYPE = 'application/vnd.sixi.arena-digest-statement+json';
/**
 * (contracts 2.11.0, signing.md §5.2) The largest DSSE PAE message a Sixi key signs directly (the Cloud KMS
 * raw-data limit for Ed25519, measured in production). A raw signature over a longer message is refused even
 * when it verifies; above it the digest-statement form is mandatory.
 */
export const ARENA_SIGN_MAX_MESSAGE_BYTES = 65536;

/** `signing.signed_form` (2.11.0): absent means `raw`. */
export type SignedForm = 'raw' | 'digest_statement';
/** The reason tokens of signing.md §5.2 (every one is `signature_invalid`, errors.md). */
export type SignatureReason =
  | 'payload_type'
  | 'raw_over_threshold'
  | 'payload_mismatch'
  | 'statement_malformed'
  | 'subject_type'
  | 'length_mismatch'
  | 'digest_mismatch'
  | 'binding'
  | 'form_mismatch'
  | 'key'
  | 'signature';
export const SIGNATURE_REASONS: readonly SignatureReason[] = ['payload_type', 'raw_over_threshold', 'payload_mismatch', 'statement_malformed', 'subject_type', 'length_mismatch', 'digest_mismatch', 'binding', 'form_mismatch', 'key', 'signature'];

/** A §5.2 refusal: `reason` is the token, the message never quotes document content. */
export class SignatureRefusal extends Error {
  constructor(
    readonly reason: SignatureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SignatureRefusal';
  }
}

/** The signed digest statement of signing.md §5.2 without its signature (the object whose JCS is signed). */
export interface UnsignedDigestStatement {
  statement_version: '1.0';
  subject: { payload_type: string; sha256: string; bytes: number };
  run_id?: string;
  run_manifest_digest?: string;
  signing: { algorithm: 'ed25519'; signing_key_id: string; canonicalization: 'jcs-rfc8785'; payload_type: typeof DIGEST_STATEMENT_PAYLOAD_TYPE; excluded: ['/signing/signature']; sealed_at: string };
}

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

/** The embedded signatures that may take the digest-statement form (signing.md §5.2 scope; the rest always stay raw). */
const STATEMENT_EMBEDDED_TYPES = new Set([REPORT_PAYLOAD_TYPE, CROSSCHECK_PAYLOAD_TYPE]);

/**
 * signing.md §5.2 E2: the statement a document in the digest form is signed through, derived from the document
 * (never stored beside it). `subject` = the document's payload type, the sha256 and length of its JCS body; a
 * report binds `run_id` and `run_manifest_digest`; `sealed_at` is the report's `signing.sealed_at` or a
 * cross-check record's `finished_at`.
 */
export function deriveDigestStatement(doc: unknown, payloadType: string): UnsignedDigestStatement {
  if (!isObj(doc) || !isObj(doc.signing)) throw new SignatureRefusal('signature', 'the document has no signing block');
  const body = Buffer.from(canonicalizeForSigning(doc), 'utf8');
  const s = doc.signing;
  const report = payloadType === REPORT_PAYLOAD_TYPE;
  const sealedAt = report ? s.sealed_at : doc.finished_at;
  if (typeof s.signing_key_id !== 'string' || typeof sealedAt !== 'string') throw new SignatureRefusal('binding', `the ${report ? 'report' : 'document'} lacks the signing key id or ${report ? 'signing.sealed_at' : 'finished_at'} the statement binds`);
  const run = report && isObj(doc.run) ? doc.run : undefined;
  if (report && (typeof run?.run_id !== 'string' || typeof s.run_manifest_digest !== 'string')) throw new SignatureRefusal('binding', 'the report lacks run.run_id or signing.run_manifest_digest, which a statement over a report binds');
  return {
    statement_version: '1.0',
    subject: { payload_type: payloadType, sha256: `sha256:${sha256Hex(body)}`, bytes: body.length },
    ...(report ? { run_id: run!.run_id as string, run_manifest_digest: s.run_manifest_digest as string } : {}),
    signing: { algorithm: 'ed25519', signing_key_id: s.signing_key_id, canonicalization: 'jcs-rfc8785', payload_type: DIGEST_STATEMENT_PAYLOAD_TYPE, excluded: [SIGNATURE_POINTER], sealed_at: sealedAt },
  };
}

/** The signed message of an embedded signature (signing.md §2, §5.2 E1-E2). */
export interface EmbeddedMessage {
  form: SignedForm;
  /** The PAE type the key signed: the document's own type (raw) or the statement type. */
  paeType: string;
  /** The PAE body: the document's JCS body (raw) or the derived statement's JCS (digest form). This is the `report.json.dsse.json` payload. */
  body: Buffer;
  message: Buffer;
  /** The document's own JCS body (the covered bytes) and its length. */
  covered: Buffer;
}

/**
 * signing.md §5.2 E1-E2 for an embedded signature: the form (`signing.signed_form`, absent = raw) and the exact
 * message the key signed. Throws a SignatureRefusal: `raw_over_threshold` for a raw message longer than
 * ARENA_SIGN_MAX_MESSAGE_BYTES, `form_mismatch` for a form this document type cannot take.
 */
export function embeddedSignedMessage(doc: unknown, payloadType: string): EmbeddedMessage {
  if (!isObj(doc) || !isObj(doc.signing)) throw new SignatureRefusal('signature', 'the document has no signing block');
  const f = doc.signing.signed_form;
  if (f !== undefined && f !== 'raw' && f !== 'digest_statement') throw new SignatureRefusal('form_mismatch', 'signing.signed_form is neither raw nor digest_statement');
  const form: SignedForm = f === 'digest_statement' ? 'digest_statement' : 'raw';
  let covered: Buffer;
  try {
    covered = Buffer.from(canonicalizeForSigning(doc), 'utf8');
  } catch (e) {
    throw new SignatureRefusal('signature', (e as Error).message);
  }
  if (form === 'raw') {
    const message = pae(payloadType, covered);
    if (message.length > ARENA_SIGN_MAX_MESSAGE_BYTES) throw new SignatureRefusal('raw_over_threshold', `the raw signed message is ${message.length} bytes, over ARENA_SIGN_MAX_MESSAGE_BYTES (${ARENA_SIGN_MAX_MESSAGE_BYTES}); a document this large is signed through a digest statement (signing.md §5.2)`);
    return { form, paeType: payloadType, body: covered, message, covered };
  }
  if (!STATEMENT_EMBEDDED_TYPES.has(payloadType)) throw new SignatureRefusal('form_mismatch', `a document of type ${payloadType} is always signed raw (signing.md §5.2 scope)`);
  const body = Buffer.from(jcs(deriveDigestStatement(doc, payloadType), { strict: true }), 'utf8');
  return { form, paeType: DIGEST_STATEMENT_PAYLOAD_TYPE, body, message: pae(DIGEST_STATEMENT_PAYLOAD_TYPE, body), covered };
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
  /** (2.11.0) On a refusal: the signing.md §5.2 reason token of the first error (each error also starts with its token). */
  reason?: SignatureReason;
  errors: string[];
}

/**
 * Verify any signed contract document against one public key under the expected payload type (domain separation).
 * (2.11.0) Either form of signing.md §5.2: raw (only while the PAE message is at most ARENA_SIGN_MAX_MESSAGE_BYTES)
 * or, with `signing.signed_form: digest_statement` on a report or cross-check record, the derived statement.
 * Every error starts with its reason token (`signature: …`), and `reason` is the first one.
 */
export function verifyDocumentSignature(doc: unknown, publicKey: Ed25519KeyInput, payloadType: string): SignatureCheck {
  if (!isObj(doc) || doc.signing === undefined) return { ok: false, status: 'unsigned', errors: ['the document carries no signing block'] };
  const s = doc.signing as Partial<SigningBlock>;
  const errors: [SignatureReason, string][] = [];
  if (!isObj(s)) return { ok: false, status: 'invalid', reason: 'signature', errors: ['signature: signing is not an object'] };
  const kid = typeof s.signing_key_id === 'string' ? s.signing_key_id : undefined;
  if (s.algorithm !== 'ed25519') errors.push(['signature', 'signing.algorithm is not ed25519']);
  if (s.canonicalization !== 'jcs-rfc8785') errors.push(['signature', 'signing.canonicalization is not jcs-rfc8785']);
  if (s.payload_type !== payloadType) errors.push(['payload_type', `signing.payload_type is ${JSON.stringify(s.payload_type)?.slice(0, 80)}, expected ${payloadType}`]);
  if (!kid || !KID_RE.test(kid)) errors.push(['signature', 'signing.signing_key_id is missing or malformed']);
  if (typeof s.signature !== 'string' || !SIGNATURE_RE.test(s.signature)) errors.push(['signature', 'signing.signature is not base64 of 64 bytes']);
  const refuse = (list: [SignatureReason, string][]): SignatureCheck => ({ ok: false, status: 'invalid', ...(kid ? { kid } : {}), reason: list[0]![0], errors: list.map(([r, m]) => `${r}: ${m}`) });
  let signed: EmbeddedMessage | undefined;
  try {
    signed = embeddedSignedMessage(doc, payloadType);
  } catch (e) {
    errors.push(e instanceof SignatureRefusal ? [e.reason, e.message] : ['signature', (e as Error).message]);
  }
  if (errors.length || signed === undefined) return refuse(errors);
  let key: KeyObject;
  try {
    key = toPublicKey(publicKey);
  } catch (e) {
    return refuse([['key', `the public key is unusable: ${(e as Error).message}`]]);
  }
  const good = edVerify(null, signed.message, key, Buffer.from(s.signature as string, 'base64'));
  if (good) return { ok: true, status: 'valid', kid, errors: [] };
  return refuse([['signature', signed.form === 'raw' ? 'the Ed25519 signature does not verify over PAE(payload_type, JCS(document without /signing/signature))' : 'the Ed25519 signature does not verify over PAE(digest statement type, JCS(the statement derived from the document))']]);
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
  if (!hosted) errs.push('binding: a signed report must carry run.hosted');
  else {
    if (hosted.signing_key_id !== rep.signing?.signing_key_id) errs.push('binding: signing.signing_key_id differs from run.hosted.signing_key_id');
    if (hosted.run_manifest?.digest !== rep.signing?.run_manifest_digest) errs.push('binding: signing.run_manifest_digest differs from run.hosted.run_manifest.digest');
  }
  return errs.length ? { ok: false, status: 'invalid', ...(r.kid ? { kid: r.kid } : {}), reason: r.reason ?? 'binding', errors: errs } : r;
}

/** Sign any contract document in place of its `signing.signature` (the rest of `signing` must already be set). */
export function signDocument<T extends { signing?: unknown }>(doc: T, privateKey: Ed25519KeyInput, payloadType: string): T {
  const out = JSON.parse(JSON.stringify(doc)) as T & { signing: Record<string, unknown> };
  if (!isObj(out.signing)) throw new Error('the document has no signing block to complete');
  if (out.signing.payload_type !== payloadType) throw new Error(`signing.payload_type must be ${payloadType}`);
  // (2.11.0) The form named by signing.signed_form; a raw message over the threshold throws (a conforming sealer cannot produce one).
  const { message } = embeddedSignedMessage(out, payloadType);
  out.signing.signature = edSign(null, message, toPrivateKey(privateKey)).toString('base64');
  return out;
}

export interface SignReportOptions {
  /** RFC 3339 instant of the seal (the package has no clock). Default: the report's existing `signing.sealed_at`. */
  sealedAt?: string;
  /**
   * (2.11.0, signing.md §5.2) `raw` (no `signed_form` member, byte-identical to 2.2.0), `digest_statement`, or
   * `auto` (the default: the statement form exactly when the raw message would exceed ARENA_SIGN_MAX_MESSAGE_BYTES,
   * the recommended sealer policy).
   */
  signedForm?: SignedForm | 'auto';
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
  let form = opts.signedForm ?? 'auto';
  if (form === 'auto') {
    const raw = pae(REPORT_PAYLOAD_TYPE, Buffer.from(canonicalizeForSigning({ ...report, signing }), 'utf8'));
    form = raw.length > ARENA_SIGN_MAX_MESSAGE_BYTES ? 'digest_statement' : 'raw';
  }
  if (form === 'digest_statement') signing.signed_form = 'digest_statement';
  const signed = signDocument({ ...report, signing }, privateKey, REPORT_PAYLOAD_TYPE);
  if (!validateReportSchema(signed)) throw new Error(`the sealed report does not validate: ${formatErrors(validateReportSchema.errors).join('; ')}`);
  return signed;
}
