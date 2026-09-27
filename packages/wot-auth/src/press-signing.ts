/**
 * Ed25519 signatures for signed negotiation moves (threat-model-arena G-11 /
 * decision S5; docs/design/diplomacy-scenario.md §1.5; contracts/signing.md §1).
 *
 * What is signed, and how:
 *
 *   payload   = a small, fixed-shape JSON object (below), canonicalised with
 *               RFC 8785 JCS (`jcs`), then base64url-encoded;
 *   header    = {"alg":"EdDSA"} (+ optional "kid", "typ"; nothing else is accepted:
 *               no `crit`, no `b64:false`, no embedded `jwk`/`jku`/`x5u`);
 *   signature = Ed25519(RFC 8032, pure) over ASCII(b64url(header) "." b64url(payload));
 *   on the wire: the DETACHED compact JWS `b64url(header) ".." b64url(signature)`
 *               (RFC 7515 Appendix F; the payload is rebuilt by the verifier from
 *               the message it received, never taken from the sender).
 *
 * Diplomacy press (`pressSigningPayload`), exactly the contract's field list
 * (`diplomacy_action.schema.json` `signature`):
 *
 *   { scenario: "diplomacy", episode_id, msg_id_expected, from, to, move,
 *     respond_to, terms_hash }
 *
 *   - `episode_id` binds the signature to ONE episode: a signature captured in one
 *     game never verifies in another (cross-episode replay).
 *   - `msg_id_expected` (`prs:<phase>:r<round>:<power>:<seq>`, the id the engine
 *     will assign) binds it to one phase, one round and one batch position.
 *   - `from` is the power the SESSION is bound to (engine-stamped), never a
 *     payload field; `to` is the message's recipients object as sent.
 *   - `terms_hash = "sha256:" + hex(sha256(JCS(terms)))` over the terms exactly as
 *     sent (wire form, `from_phase`/`to_phase`), or null for accept/renounce.
 *     Any change to a clause, a province, a phase or the note breaks it.
 *   - `respond_to` is the wire id answered (offer or commitment), or null.
 *
 * Keys: each passport's own Ed25519 key pair (`mintPassportSigningKey`), public
 * half resolved by agent id through a `PassportKeyResolver`. Reference agents
 * use `signingKeyFromSeed` (deterministic, RFC 8032) for bit-stable goldens.
 *
 * Only node:crypto is used (no new dependency). All inputs are untrusted:
 * every parse is bounded and allow-listed, and verification never throws.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

// ------------------------------------------------------------------ JCS (RFC 8785)

/**
 * RFC 8785 JSON Canonicalization Scheme: object keys sorted by UTF-16 code
 * units, strings and numbers serialised as ECMAScript `JSON.stringify` does, no
 * whitespace. `undefined` members are dropped (as JSON.stringify does); a
 * non-finite number, a lone surrogate, a function, a bigint or a symbol throws.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function jcs(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error('jcs: non-finite number');
      return JSON.stringify(v);
    case 'string':
      if (LONE_SURROGATE_RE.test(v)) throw new Error('jcs: lone surrogate');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : jcs(x))).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined);
      keys.sort(); // default sort = UTF-16 code-unit order, as RFC 8785 §3.2.3 requires
      return '{' + keys.map((k) => jcs(k) + ':' + jcs(o[k])).join(',') + '}';
    }
    default:
      throw new Error(`jcs: ${typeof v} is not JSON`);
  }
}

/** `"sha256:" + hex(sha256(utf8(s)))`. */
export const sha256Tagged = (s: string): string => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

// ------------------------------------------------------------------ keys

export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid?: string;
  alg?: 'EdDSA';
  use?: 'sig';
}
export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string;
}
export interface PassportSigningKey {
  privateJwk: Ed25519PrivateJwk;
  publicJwk: Ed25519PublicJwk;
  /** RFC 7638 thumbprint (base64url sha256) of the public key; the default `kid`. */
  jkt: string;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer | null => (B64URL_RE.test(s) ? Buffer.from(s, 'base64url') : null);
/**
 * G-34 (signing.md §7.1 "exactly one accepted encoding"): the canonical unpadded
 * base64url spelling of some byte string: no `=`, no `+` or `/`, a length that is
 * not 1 mod 4, and zero unused low bits in the last character. Checked by
 * re-encoding the decoded bytes, so no two strings decode to the same bytes.
 */
export const isCanonicalB64u = (s: string): boolean => B64URL_RE.test(s) && b64u(Buffer.from(s, 'base64url')) === s;

/** Strict shape check for an Ed25519 PUBLIC JWK (a private `d` is refused). */
export function isEd25519PublicJwk(v: unknown): v is Ed25519PublicJwk {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  for (const k of Object.keys(j)) if (!['kty', 'crv', 'x', 'kid', 'alg', 'use'].includes(k)) return false;
  if (j.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.x !== 'string' || j.x.length !== 43) return false;
  const x = unb64u(j.x);
  if (!x || x.length !== 32) return false;
  if (j.kid !== undefined && (typeof j.kid !== 'string' || j.kid.length === 0 || j.kid.length > 128)) return false;
  if (j.alg !== undefined && j.alg !== 'EdDSA') return false;
  if (j.use !== undefined && j.use !== 'sig') return false;
  return true;
}

/** RFC 7638 JWK thumbprint of an Ed25519 public key (required members only, lexicographic). */
export function jwkThumbprint(jwk: Pick<Ed25519PublicJwk, 'crv' | 'kty' | 'x'>): string {
  return createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');
}

function fromPrivateKeyObject(priv: KeyObject): PassportSigningKey {
  const j = priv.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; d?: string };
  if (j.kty !== 'OKP' || j.crv !== 'Ed25519' || !j.x || !j.d) throw new Error('not an Ed25519 key');
  const jkt = jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: j.x });
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: j.x, kid: jkt, alg: 'EdDSA', use: 'sig' };
  return { privateJwk: { ...publicJwk, d: j.d }, publicJwk, jkt };
}

/**
 * A fresh per-passport Ed25519 key pair (the passport's signing identity for
 * negotiation moves). Registration returns `privateJwk` ONCE (like the client
 * secret) and persists only `publicJwk`.
 */
export function mintPassportSigningKey(): PassportSigningKey {
  return fromPrivateKeyObject(generateKeyPairSync('ed25519').privateKey);
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Deterministic Ed25519 key from a 32-byte seed (RFC 8032 §5.1.5). Reference agents and tests only. */
export function signingKeyFromSeed(seed: Uint8Array): PassportSigningKey {
  if (seed.length !== 32) throw new Error('signingKeyFromSeed: seed must be 32 bytes');
  return fromPrivateKeyObject(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' }));
}

/** `signingKeyFromSeed(sha256(label))`: a named deterministic key (reference seats: `ref:<seed>:<power>`). */
export function signingKeyFromLabel(label: string): PassportSigningKey {
  return signingKeyFromSeed(createHash('sha256').update(`wot-sign/seed/1|${label}`, 'utf8').digest());
}

// ------------------------------------------------------------------ detached compact JWS (EdDSA)

/** Contract pattern of a detached compact JWS (`diplomacy_action.schema.json`). */
export const DETACHED_JWS_RE = /^([A-Za-z0-9_-]{16,256})\.\.([A-Za-z0-9_-]{16,256})$/;

export type JwsVerdict = { ok: true; kid: string | null } | { ok: false; reason: JwsFailure };
export type JwsFailure = 'malformed' | 'bad_header' | 'kid_mismatch' | 'bad_key' | 'bad_payload' | 'bad_signature';

export function signDetachedJws(privateJwk: Ed25519PrivateJwk, payload: unknown, opts: { kid?: string } = {}): string {
  const header: Record<string, string> = { alg: 'EdDSA' };
  if (opts.kid !== undefined) header.kid = opts.kid;
  const h = b64u(jcs(header));
  const input = `${h}.${b64u(jcs(payload))}`;
  const key = createPrivateKey({ key: privateJwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
  return `${h}..${b64u(edSign(null, Buffer.from(input, 'ascii'), key))}`;
}

/**
 * Verify a detached compact JWS against a public key and the payload the
 * VERIFIER rebuilt. Never throws. A header `kid`, if present, must equal the
 * key's `kid` (a signature minted for another key is refused even before the
 * cryptographic check).
 */
export function verifyDetachedJws(publicJwk: unknown, jws: unknown, payload: unknown): JwsVerdict {
  if (typeof jws !== 'string') return { ok: false, reason: 'malformed' };
  const m = DETACHED_JWS_RE.exec(jws);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, h, s] = m;
  // G-34: one accepted spelling per segment (the chamber replay check compares strings).
  if (!isCanonicalB64u(h) || !isCanonicalB64u(s)) return { ok: false, reason: 'malformed' };
  let header: Record<string, unknown>;
  try {
    const raw = unb64u(h);
    if (!raw) return { ok: false, reason: 'bad_header' };
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'bad_header' };
    header = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  for (const k of Object.keys(header)) if (k !== 'alg' && k !== 'kid' && k !== 'typ') return { ok: false, reason: 'bad_header' };
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'bad_header' };
  if (header.kid !== undefined && typeof header.kid !== 'string') return { ok: false, reason: 'bad_header' };
  if (header.typ !== undefined && typeof header.typ !== 'string') return { ok: false, reason: 'bad_header' };
  if (!isEd25519PublicJwk(publicJwk)) return { ok: false, reason: 'bad_key' };
  if (typeof header.kid === 'string' && publicJwk.kid !== undefined && header.kid !== publicJwk.kid) return { ok: false, reason: 'kid_mismatch' };
  const sig = unb64u(s);
  if (!sig || sig.length !== 64) return { ok: false, reason: 'bad_signature' };
  let body: string;
  try {
    body = jcs(payload);
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x }, format: 'jwk' });
    const ok = edVerify(null, Buffer.from(`${h}.${b64u(body)}`, 'ascii'), key, sig);
    return ok ? { ok: true, kid: typeof header.kid === 'string' ? header.kid : null } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_key' };
  }
}

// ------------------------------------------------------------------ Diplomacy press payload

/** The moves the contract requires a signature on (withdraw is unsigned). */
export const SIGNED_PRESS_MOVES = ['offer', 'counter', 'accept', 'renounce'] as const;
export type SignedPressMove = (typeof SIGNED_PRESS_MOVES)[number];

export interface PressSignedFields {
  /** The run's episode id (`epi_…`), set by the session, never by the client. */
  episodeId: string;
  /** Wire id the engine will assign: `prs:<phase>:r<round>:<power>:<seq>`. */
  msgIdExpected: string;
  /** The sender's power, from the authenticated session. */
  from: string;
  /** The recipients object as sent (`{kind:"private", power}` for every signed move). */
  to: unknown;
  move: string;
  /** The wire offer / commitment id answered, or null (offer). */
  respondTo: string | null;
  /** The terms exactly as sent (offer, counter), or null (accept, renounce). */
  terms: unknown;
}

/** `sha256:` over JCS(terms) exactly as sent; null when the move carries no terms. */
export function pressTermsHash(terms: unknown): string | null {
  return terms === undefined || terms === null ? null : sha256Tagged(jcs(terms));
}

export function pressSigningPayload(f: PressSignedFields): Record<string, unknown> {
  return {
    scenario: 'diplomacy',
    episode_id: f.episodeId,
    msg_id_expected: f.msgIdExpected,
    from: f.from,
    to: f.to,
    move: f.move,
    respond_to: f.respondTo,
    terms_hash: pressTermsHash(f.terms),
  };
}

export function signPressMove(key: Pick<PassportSigningKey, 'privateJwk'>, f: PressSignedFields): string {
  return signDetachedJws(key.privateJwk, pressSigningPayload(f), key.privateJwk.kid !== undefined ? { kid: key.privateJwk.kid } : {});
}

export function verifyPressSignature(publicJwk: unknown, jws: unknown, f: PressSignedFields): JwsVerdict {
  let payload: Record<string, unknown>;
  try {
    payload = pressSigningPayload(f);
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  return verifyDetachedJws(publicJwk, jws, payload);
}

// ------------------------------------------------------------------ key registry

/** Resolve an agent's registered PUBLIC signing key (null = none registered). */
export type PassportKeyResolver = (agentId: string) => Ed25519PublicJwk | null | Promise<Ed25519PublicJwk | null>;

/**
 * In-memory passport → public signing key registry, for unit tests and
 * fixtures only. The live resolver is the store-backed one (`wot-store`
 * `passportKeyResolver`), filled by passports registration; services take a
 * `PassportKeyResolver`, so either drops in unchanged.
 */
export class PassportKeyRegistry {
  private readonly keys = new Map<string, Ed25519PublicJwk>();

  /** Register (or rotate) an agent's public key. Refuses anything but a public Ed25519 JWK. */
  register(agentId: string, publicJwk: unknown): Ed25519PublicJwk {
    if (!isEd25519PublicJwk(publicJwk)) throw new Error('PassportKeyRegistry: not an Ed25519 public JWK (a private key is refused)');
    const clean: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid: publicJwk.kid ?? jwkThumbprint(publicJwk), alg: 'EdDSA', use: 'sig' };
    this.keys.set(agentId, clean);
    return clean;
  }

  revoke(agentId: string): boolean {
    return this.keys.delete(agentId);
  }

  get(agentId: string): Ed25519PublicJwk | null {
    return this.keys.get(agentId) ?? null;
  }

  readonly resolver: PassportKeyResolver = (agentId) => this.get(agentId);
}
