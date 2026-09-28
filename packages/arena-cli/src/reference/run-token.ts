/**
 * `serve-reference --hosted` admission (SIXI-INTEGRATION §1.5 `sixi_run_token`,
 * §1.14 step 2; Phase 8 condition I-7; HOSTED-PROFILE §2.5 and §2.8).
 *
 * The cross-check reference origin is reached by Sixi's hosted runner with a
 * Sixi-minted run token, and by the open legs without one. In hosted mode the
 * reference server:
 *   - checks `Host` against the verified origin (421 otherwise; I-7), so the
 *     same server cannot be driven through another name;
 *   - verifies a presented `Authorization: Bearer <token>`: a compact JWS,
 *     header exactly {alg: EdDSA, typ: at+jwt, kid?} (kid, when present, must
 *     name a pinned key), Ed25519 over `header.payload` with a pinned key, and
 *     claims `aud` = the verified origin, `sub` = a run id EQUAL to the request's
 *     `X-Agent-Arena-Run` header (the token is bound to its run), `exp` in the
 *     future and at most 1 h away (G-53: `exp − now` and `exp − iat`), `nbf`/`iat` not in the future, `jti` present, `iss` equal to the
 *     configured issuer when one is configured;
 *   - refuses unauthenticated requests only with `--require-run-token`.
 * Every refusal is the same `401 invalid_token` (no verification oracle).
 * `/healthz` is exempt (liveness probes carry neither). `tokenExemptPaths` (the Sixi
 * ownership proof, `/.well-known/sixi-verify`, when --ownership-token is set) keep the Host
 * check but a plain GET/HEAD of them (not a WebSocket upgrade) never needs or checks a run
 * token: Sixi's ownership gate fetches the proof without one.
 */

import { verify as edVerify } from 'node:crypto';
import type { PinnedKey } from '../keys.ts';

const B64URL = /^[A-Za-z0-9_-]+$/;
const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Clock skew tolerated on exp / nbf / iat (seconds). */
export const RUN_TOKEN_SKEW_S = 60;
/**
 * G-53: the longest lifetime a run token may have, `exp − max(iat, now)`, in seconds. A run
 * token is per run and reusable within its life (§10), so a mis-minted long-lived token must
 * not be accepted for its whole life. One hour covers a run plus the §10 "+5 min" margin.
 */
export const RUN_TOKEN_MAX_LIFETIME_S = 3600;
const MAX_TOKEN_BYTES = 4096;

/** One accepted spelling per byte string (canonical unpadded base64url, as signing.md §7.2 requires for JWS). */
function b64url(seg: string): Buffer | null {
  if (!B64URL.test(seg)) return null;
  const b = Buffer.from(seg, 'base64url');
  return b.toString('base64url') === seg ? b : null;
}

export interface RunTokenOptions {
  keys: readonly PinnedKey[];
  /** The verified origin (`https://host[:port]`) the token must be minted for (`aud`). */
  audience: string;
  issuer?: string;
  /** Epoch seconds (default now). */
  now?: number;
}

export type RunTokenResult = { ok: true; sub: string; jti: string } | { ok: false; why: string };

export function verifyRunToken(token: string, o: RunTokenOptions): RunTokenResult {
  const bad = (why: string): RunTokenResult => ({ ok: false, why });
  if (token.length > MAX_TOKEN_BYTES) return bad('too long');
  const parts = token.split('.');
  if (parts.length !== 3) return bad('not a compact JWS');
  const [h, p, s] = parts;
  const hb = b64url(h);
  const pb = b64url(p);
  const sb = b64url(s);
  if (!hb || !pb || !sb || sb.length !== 64) return bad('malformed segment');
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(hb.toString('utf8'));
    claims = JSON.parse(pb.toString('utf8'));
  } catch {
    return bad('not JSON');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return bad('header');
  const hd = header as Record<string, unknown>;
  if (Object.keys(hd).some((k) => !['alg', 'typ', 'kid'].includes(k))) return bad('header member');
  if (hd.alg !== 'EdDSA' || hd.typ !== 'at+jwt') return bad('alg/typ');
  if (hd.kid !== undefined && typeof hd.kid !== 'string') return bad('kid');
  const kid = hd.kid as string | undefined;
  const cands = o.keys.filter((k) => k.kid === undefined || (kid !== undefined && k.kid === kid));
  if (!cands.length) return bad('unknown kid');
  const input = Buffer.from(`${h}.${p}`, 'ascii');
  if (!cands.some((k) => edVerify(null, input, k.key, sb))) return bad('signature');
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return bad('claims');
  const c = claims as Record<string, unknown>;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.audience)) return bad('aud');
  if (typeof c.sub !== 'string' || !RUN_ID.test(c.sub)) return bad('sub');
  if (typeof c.exp !== 'number' || !(c.exp + RUN_TOKEN_SKEW_S > now)) return bad('exp');
  // G-53: bounded lifetime, from issue (iat) and from now (a token without iat, or with an old iat).
  if (c.exp - now > RUN_TOKEN_MAX_LIFETIME_S + RUN_TOKEN_SKEW_S) return bad('exp');
  if (typeof c.iat === 'number' && c.exp - c.iat > RUN_TOKEN_MAX_LIFETIME_S) return bad('exp');
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf - RUN_TOKEN_SKEW_S > now)) return bad('nbf');
  if (c.iat !== undefined && (typeof c.iat !== 'number' || c.iat - RUN_TOKEN_SKEW_S > now)) return bad('iat');
  if (typeof c.jti !== 'string' || c.jti.length < 8 || c.jti.length > 128) return bad('jti');
  if (o.issuer !== undefined && c.iss !== o.issuer) return bad('iss');
  return { ok: true, sub: c.sub, jti: c.jti };
}

export interface HostedReferenceOptions {
  /** `https://host[:port]` (or wss): the verified origin of the reference target. */
  verifiedOrigin: string;
  runTokenKeys: readonly PinnedKey[];
  requireToken?: boolean;
  issuer?: string;
  now?: () => number;
}

/** The `Host` values that name the verified origin (the default port may be written or omitted). */
export function allowedHosts(origin: string): string[] {
  const u = new URL(origin);
  const port = u.port || '443';
  const host = u.hostname.toLowerCase();
  return port === '443' ? [host, `${host}:443`] : [`${host}:${port}`];
}

const INVALID = { status: 401 as const, error: 'invalid_token', headers: { 'www-authenticate': 'Bearer error="invalid_token"' } };

/** The admission function for `net/server.ts` `admit`. */
export function hostedReferenceAdmission(o: HostedReferenceOptions, tokenExemptPaths: readonly string[] = []) {
  const hosts = allowedHosts(o.verifiedOrigin);
  const audience = new URL(o.verifiedOrigin).origin.replace(/^wss:/, 'https:');
  const audiences = [o.verifiedOrigin, audience];
  return (req: { method?: string; path: string; headers: Record<string, string | undefined> }) => {
    if (req.path === '/healthz') return null;
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.includes(host)) return { status: 421 as const, error: 'misdirected_request' };
    // A plain GET/HEAD only: a WebSocket upgrade on the same path would reach the agent (ws is any path).
    if (tokenExemptPaths.includes(req.path) && (req.method === 'GET' || req.method === 'HEAD') && req.headers.upgrade === undefined) return null;
    const auth = req.headers.authorization;
    if (auth === undefined) return o.requireToken ? INVALID : null;
    const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(auth);
    if (!m) return INVALID;
    const now = o.now ? Math.floor(o.now() / 1000) : undefined;
    const r = audiences.map((a) => verifyRunToken(m[1], { keys: o.runTokenKeys, audience: a, issuer: o.issuer, now })).find((x) => x.ok) ?? { ok: false as const };
    if (!r.ok) return INVALID;
    // Bound to its run: the runner sends X-Agent-Arena-Run on every request.
    if (req.headers['x-agent-arena-run'] !== r.sub) return INVALID;
    return null;
  };
}
