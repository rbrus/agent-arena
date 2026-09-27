/**
 * Signed digest statements (contracts 2.11.0, signing.md §5.2): what `verify --hosted` and
 * `verify --hosted-seal` accept in place of a raw signature, and the raw-form threshold.
 *
 * Sixi keys live in Cloud KMS, whose Ed25519 `asymmetricSign` takes at most 65536 bytes of raw data. A
 * payload whose DSSE PAE message is longer is signed through a small statement naming its payload type,
 * sha256 and length (and, for the seal outputs, its run), and the raw form is refused above the threshold.
 *
 *   - Detached files (`report.sarif`, `bundle-manifest.json`): `verifyDetachedEnvelope`, steps D1 to D9,
 *     in the contract's order.
 *   - Embedded signatures (`report.json`, and its `report.json.dsse.json`): `verifyEmbeddedSignature`,
 *     steps E1 to E4 (the statement is derived from the document, never read from beside it).
 *
 * Every refusal is `signature_invalid` (exit 2) with exactly one reason token, raised as a
 * `SignatureRefusal`; messages name the file and never quote the envelope or the document.
 */

import { createHash, verify as edVerify, type KeyObject } from 'node:crypto';
import {
  ARENA_SIGN_MAX_MESSAGE_BYTES,
  CROSSCHECK_PAYLOAD_TYPE,
  DIGEST_STATEMENT_PAYLOAD_TYPE,
  embeddedSignedMessage,
  jcs,
  pae,
  REPORT_PAYLOAD_TYPE,
  SignatureRefusal,
  type SignatureReason,
  type SignedForm,
} from 'arena-report';
import { keysForKid, type PinnedKey } from '../keys.ts';
import { DIGEST_STATEMENT_MAX_BYTES, schemaErrors, validateDigestStatement } from './schemas.ts';

export { ARENA_SIGN_MAX_MESSAGE_BYTES, DIGEST_STATEMENT_PAYLOAD_TYPE, SignatureRefusal, type SignatureReason, type SignedForm };

export const SARIF_PAYLOAD_TYPE = 'application/vnd.sixi.arena-sarif+json';
export const BUNDLE_PAYLOAD_TYPE = 'application/vnd.sixi.arena-bundle+json';

/** The report a bundle's signatures bind to (signing.md §2 key id equality, §5.2 D7). */
export interface BindingContext {
  signing_key_id: string;
  /** The report's `signing.sealed_at`: the signing time `t` of every seal output (§3.3 rule 3). */
  sealed_at: string;
  run_id?: string;
  run_manifest_digest?: string;
}

/** A signature that verified: its form, the covered bytes' length and digest, and the key id. */
export interface VerifiedSignature {
  file: string;
  form: SignedForm;
  bytes: number;
  sha256: string;
  kid: string;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** G-52: standard base64 in its one canonical spelling (padded, no dangling character, unused bits zero), as Go StdEncoding and `base64 -d` read it. */
const isCanonicalB64 = (s: string): boolean => B64.test(s) && Buffer.from(s, 'base64').toString('base64') === s;
/** contracts report.schema.json `signing.signing_key_id` (and pinned-keys.ts KID_PATTERN). */
const KID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** RFC 3339 date-time (report.schema.json `signing.sealed_at`, format date-time). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Report values quoted in a refusal are cut to this many characters (G-63; the key messages already cut kids to 64). */
const QUOTE = 64;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b: Buffer): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const refuse = (reason: SignatureReason, file: string, message: string): never => {
  throw new SignatureRefusal(reason, `${file}: ${message}`);
};

/** `signature_invalid: <reason>: <file>: <detail>`, the one line every §5.2 refusal prints. */
export function refusalLine(e: SignatureRefusal): string {
  return `signature_invalid: ${e.reason}: ${e.message}`;
}

interface Envelope {
  payloadType: unknown;
  payload: Buffer | null;
  keyid: unknown;
  sig: string;
}

/**
 * The single signature of a DSSE envelope (§5.1 rule 8: exactly one). A structurally unusable envelope
 * (not an object, not exactly one signature, a signature that is not base64 of 64 bytes) carries no
 * signature that could verify: `signature`. `payload` is null when it is not standard base64.
 */
function readEnvelope(env: unknown, file: string): Envelope {
  if (!isObj(env)) refuse('signature', file, 'the envelope is not a DSSE envelope (a JSON object)');
  const e = env as Record<string, unknown>;
  if (!Array.isArray(e.signatures) || e.signatures.length !== 1) refuse('signature', file, 'the envelope must carry exactly one signature (signing.md §5.1 rule 8)');
  const s = (e.signatures as unknown[])[0];
  if (!isObj(s) || typeof s.sig !== 'string' || !isCanonicalB64(s.sig) || Buffer.from(s.sig, 'base64').length !== 64) refuse('signature', file, 'the envelope signature is not canonical standard base64 of 64 bytes');
  const payload = typeof e.payload === 'string' && isCanonicalB64(e.payload) ? Buffer.from(e.payload, 'base64') : null;
  return { payloadType: e.payloadType, payload, keyid: (s as Record<string, unknown>).keyid, sig: (s as Record<string, unknown>).sig as string };
}

const isRfc3339 = (v: unknown): v is string => typeof v === 'string' && RFC3339.test(v) && !Number.isNaN(Date.parse(v));

/**
 * G-63: the report values a bundle's refusals may quote (`signing_key_id`, `sealed_at`), checked before the
 * report is schema-validated: outside the contract they are refused and never quoted. Undefined when they hold.
 */
export function bindingContextProblem(ctx: { signing_key_id?: unknown; sealed_at?: unknown }): string | undefined {
  if (typeof ctx.signing_key_id !== 'string' || !KID_RE.test(ctx.signing_key_id)) return `the report's signing.signing_key_id does not match ${KID_RE.source}`;
  if (!isRfc3339(ctx.sealed_at)) return "the report's signing.sealed_at is not an RFC 3339 date-time";
  return undefined;
}

/** D8 / E4 (first half): the key named by `kid`, inside its window at `t` (a key passed with --key has none). */
function keyFor(keys: readonly PinnedKey[], kid: string, t: string, file: string): KeyObject[] {
  const sel = keysForKid(keys, kid, Date.parse(t));
  if (sel.problem === 'unpinned') refuse('key', file, `no key for kid ${kid.slice(0, 64)} (pinned or --key: ${keys.map((k) => k.kid ?? '(no kid)').join(', ').slice(0, 200)})`);
  if (sel.problem) refuse('key', file, `the key ${kid.slice(0, 64)} does not cover the signing time (${sel.problem})`);
  return sel.keys.map((k) => k.key);
}

/** D9 / E4 (second half). */
function checkSignature(keys: KeyObject[], message: Buffer, sig: string, file: string, what: string): void {
  const s = Buffer.from(sig, 'base64');
  if (!keys.some((k) => edVerify(null, message, k, s))) refuse('signature', file, `the Ed25519 signature does not verify over ${what}`);
}

/**
 * signing.md §5.2 D1 to D9: a detached envelope (`<file>.dsse.json`) over the served bytes `served` of a file
 * whose payload type is `T`, bound to the report `ctx`, checked with `keys` (pinned: by kid, inside the window
 * at `ctx.sealed_at`; from --key: no window). Returns the form on success; throws a SignatureRefusal otherwise.
 */
export function verifyDetachedEnvelope(env: unknown, served: Buffer, T: string, ctx: BindingContext, keys: readonly PinnedKey[], file: string): VerifiedSignature {
  const bad = bindingContextProblem(ctx);
  if (bad) refuse('signature', file, bad);
  const e = readEnvelope(env, file);
  // D1: the form is chosen by the envelope's payload type; anything else is refused.
  if (e.payloadType === T) {
    // D2: raw form.
    if (e.payload === null) refuse('payload_mismatch', file, 'the envelope payload is not standard base64, so it cannot be the file');
    const message = pae(T, e.payload!);
    if (message.length > ARENA_SIGN_MAX_MESSAGE_BYTES) refuse('raw_over_threshold', file, `the raw signed message is ${message.length} bytes, over ARENA_SIGN_MAX_MESSAGE_BYTES (${ARENA_SIGN_MAX_MESSAGE_BYTES}); above it only the digest-statement form is valid`);
    if (!e.payload!.equals(served)) refuse('payload_mismatch', file, 'the envelope payload is not byte-equal to the file it signs');
    // §2 key id equality (§5.1 rule 7) holds for the raw form too.
    if (e.keyid !== ctx.signing_key_id) refuse('binding', file, `the envelope keyid differs from the report's signing key id ${ctx.signing_key_id.slice(0, QUOTE)}`);
    // D8, D9.
    checkSignature(keyFor(keys, ctx.signing_key_id, ctx.sealed_at, file), message, e.sig, file, `PAE(${T}, the file)`);
    return { file, form: 'raw', bytes: served.length, sha256: sha256(served), kid: ctx.signing_key_id };
  }
  if (e.payloadType !== DIGEST_STATEMENT_PAYLOAD_TYPE) refuse('payload_type', file, `the envelope payloadType is neither ${T} nor the digest-statement type`);
  // D3: the payload parses, is exactly its JCS form, and (with the signature added) validates against the schema.
  if (e.payload === null) refuse('statement_malformed', file, 'the statement payload is not standard base64');
  const payload = e.payload!;
  if (payload.length > DIGEST_STATEMENT_MAX_BYTES) refuse('statement_malformed', file, `the statement is ${payload.length} bytes (cap ${DIGEST_STATEMENT_MAX_BYTES})`);
  let st: unknown;
  let canonical = '';
  try {
    const text = payload.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(payload)) throw new Error('not UTF-8');
    st = JSON.parse(text);
    canonical = jcs(st, { strict: true });
  } catch {
    refuse('statement_malformed', file, 'the statement is not JSON');
  }
  if (canonical !== payload.toString('utf8')) refuse('statement_malformed', file, 'the statement payload is not exactly its JCS form (RFC 8785)');
  if (!isObj(st) || !isObj(st.signing) || 'signature' in st.signing) refuse('statement_malformed', file, 'the statement has no signing block, or signs its own signature');
  const s = st as { subject: { payload_type: string; sha256: string; bytes: number }; run_id?: string; run_manifest_digest?: string; signing: Record<string, unknown> };
  const withSig = { ...s, signing: { ...s.signing, signature: e.sig } };
  if (!validateDigestStatement(withSig)) refuse('statement_malformed', file, `the statement fails digest_statement.schema.json: ${schemaErrors(validateDigestStatement.errors)}`);
  // D4-D6: the subject names this file's type, then its exact length, then its digest.
  if (s.subject.payload_type !== T) refuse('subject_type', file, `the statement covers a document of type ${s.subject.payload_type}, not ${T}`);
  if (s.subject.bytes !== served.length) refuse('length_mismatch', file, `the statement names ${s.subject.bytes} bytes; the file has ${served.length}`);
  const got = sha256(served);
  if (s.subject.sha256 !== got) refuse('digest_mismatch', file, `the statement names ${s.subject.sha256}; the file digests to ${got}`);
  // D7: the binding to the report.
  const kid = s.signing.signing_key_id as string;
  if (kid !== e.keyid || kid !== ctx.signing_key_id) refuse('binding', file, `the statement's signing key id, the envelope keyid and the report's signing key id ${ctx.signing_key_id.slice(0, QUOTE)} are not all equal`);
  if (s.signing.sealed_at !== ctx.sealed_at) refuse('binding', file, `the statement's sealed_at differs from the report's signing.sealed_at ${ctx.sealed_at.slice(0, QUOTE)}`);
  if (s.run_id !== ctx.run_id) refuse('binding', file, 'the statement names another run_id than the report');
  if (s.run_manifest_digest !== ctx.run_manifest_digest) refuse('binding', file, 'the statement names another run_manifest_digest than the report');
  // D8, D9.
  checkSignature(keyFor(keys, kid, ctx.sealed_at, file), pae(DIGEST_STATEMENT_PAYLOAD_TYPE, payload), e.sig, file, 'PAE(digest statement type, the statement)');
  return { file, form: 'digest_statement', bytes: served.length, sha256: got, kid };
}

/**
 * signing.md §5.2 E1 to E4: the embedded signature of a report (`REPORT_PAYLOAD_TYPE`) or cross-check record
 * (`CROSSCHECK_PAYLOAD_TYPE`), and, when `envelope` is given (`verify --hosted-seal`), E3 on its
 * `report.json.dsse.json`. The key is chosen by `signing.signing_key_id` at `t` = the report's
 * `signing.sealed_at` or the record's `finished_at`.
 */
export function verifyEmbeddedSignature(doc: unknown, T: string, keys: readonly PinnedKey[], file: string, envelope?: unknown): VerifiedSignature {
  const signing = isObj(doc) && isObj(doc.signing) ? doc.signing : undefined;
  if (!signing) refuse('signature', file, 'the document carries no signing block');
  const s = signing!;
  if (s.payload_type !== T) refuse('payload_type', file, `signing.payload_type is not ${T}`);
  const kid = typeof s.signing_key_id === 'string' ? s.signing_key_id : '';
  const sig = typeof s.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(s.signature) ? s.signature : '';
  if (!kid || !sig) refuse('signature', file, 'signing.signing_key_id or signing.signature is missing or malformed');
  // G-63: the report is not schema-checked yet; a kid or sealed_at outside the contract is refused before either is used or quoted.
  if (!KID_RE.test(kid)) refuse('signature', file, `signing.signing_key_id does not match ${KID_RE.source}`);
  if (T === REPORT_PAYLOAD_TYPE && !isRfc3339(s.sealed_at)) refuse('signature', file, 'signing.sealed_at is not an RFC 3339 date-time');
  // E1, E2 (raw over the threshold and an unknown form are refused here).
  let m;
  try {
    m = embeddedSignedMessage(doc, T);
  } catch (e) {
    // G-63: the JCS error names the offending member's JSON pointer (any key name): cut, as seal.ts does.
    if (e instanceof SignatureRefusal) refuse(e.reason, file, e.message.slice(0, 120));
    throw e;
  }
  // E3: the envelope the seal step derived from the document.
  if (envelope !== undefined) {
    const env = readEnvelope(envelope, `${file}.dsse.json`);
    if (env.payloadType !== m.paeType) refuse('form_mismatch', `${file}.dsse.json`, `the envelope payloadType is not ${m.paeType}, which signing.signed_form (${m.form}) implies`);
    if (env.payload === null || !env.payload.equals(m.body)) refuse('payload_mismatch', `${file}.dsse.json`, `the envelope payload is not byte-equal to ${m.form === 'raw' ? 'the JCS body of the report' : 'the JCS of the statement derived from the report'}`);
    if (env.sig !== sig || env.keyid !== kid) refuse('binding', `${file}.dsse.json`, 'the envelope sig and keyid are not byte-identical to signing.signature and signing.signing_key_id');
  }
  // E4.
  const t = T === CROSSCHECK_PAYLOAD_TYPE ? (isObj(doc) ? doc.finished_at : undefined) : s.sealed_at;
  checkSignature(keyFor(keys, kid, typeof t === 'string' ? t : '', file), m.message, sig, file, m.form === 'raw' ? `PAE(${T}, JCS(document without /signing/signature))` : 'PAE(digest statement type, JCS(the statement derived from the document))');
  return { file, form: m.form, bytes: m.covered.length, sha256: sha256(m.covered), kid };
}

/** The verified line of one signed file (signing.md §5.2 "Reporting the form"). */
export function signedFormLine(v: VerifiedSignature): string {
  return v.form === 'raw' ? `${v.file}: raw signature (${v.bytes} bytes) verified with ${v.kid}` : `${v.file}: digest statement (${v.bytes} bytes, ${v.sha256}) verified with ${v.kid}`;
}

export { REPORT_PAYLOAD_TYPE, CROSSCHECK_PAYLOAD_TYPE };
