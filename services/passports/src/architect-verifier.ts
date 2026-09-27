/**
 * Architect (human-plane) token verification — ADR-003 §3, agent-passports §1.1.
 *
 * The open core does not run an identity provider. It verifies a bearer JWT that
 * some issuer minted for a human Architect, against that issuer's public JWKS:
 *
 *   - `LocalJwtArchitectVerifier` (default): EdDSA/Ed25519 JWT, JWKS from
 *     `WOT_ARCHITECT_JWKS` (inline JSON), `WOT_ARCHITECT_JWKS_FILE` (path) or
 *     `WOT_ARCHITECT_JWKS_URL` (https). A self-hosted operator mints its own
 *     tokens with a local key; Sixi's hosted identity plugs in by JWKS URL.
 *   - `DevArchitectVerifier`: accepts `dev:<architect_id>` and exists ONLY when
 *     `WOT_ENV=development|test`. It refuses to construct (and to verify) in
 *     any other environment, so it can never become a production bypass.
 *
 * Claims contract (what an issuer MUST put in the token; see agent-passports §1.1):
 *   header  alg = "EdDSA" (Ed25519 key), typ = "architect+jwt", kid = a JWKS kid
 *   iss     exactly the configured issuer (`WOT_ARCHITECT_ISS`)
 *   aud     contains the configured audience (`WOT_ARCHITECT_AUD`, default
 *           `agent-arena:architect`; must differ from the agent-token audience)
 *   sub     the Architect id: opaque, stable per human, 1-128 chars of
 *           [A-Za-z0-9._:@|+-]. It is never put in an agent token or a log.
 *   iat,exp required; the token must be at most 1 h old (30 s clock skew).
 *
 * The verifier's only output is `{ issuer, architectId }`. Mapping that pair to
 * the opaque `owner_id` is the OwnerStore's job (get-or-create), so one human
 * always groups under one owner (quota and ban lineage). Every failure THROWS;
 * the caller maps a throw to 401 (fail closed).
 */

import { readFileSync } from 'node:fs';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { AUDIENCE as AGENT_TOKEN_AUDIENCE, resolveDeployEnv } from 'wot-auth';

/** What a successful verification yields. Nothing else leaves the verifier. */
export interface VerifiedArchitect {
  /** The `iss` the token was verified against. */
  issuer: string;
  /** The token's `sub`: the Architect id at that issuer. */
  architectId: string;
}

/** The pluggable human-plane verifier seam. `verify` THROWS on any failure. */
export interface ArchitectVerifier {
  readonly kind: 'jwt' | 'dev';
  /** The issuer this verifier trusts (for the startup banner; not a secret). */
  readonly issuer: string;
  verify(token: string): Promise<VerifiedArchitect>;
}

/** The explicit JWT type an Architect token must carry (RFC 8725 §3.11). */
export const ARCHITECT_TOKEN_TYP = 'architect+jwt';
export const DEFAULT_ARCHITECT_AUDIENCE = 'agent-arena:architect';
export const ARCHITECT_TOKEN_MAX_AGE_SECONDS = 3600;
export const ARCHITECT_CLOCK_TOLERANCE_SECONDS = 30;
/** The `sub` shape we accept: opaque, bounded, no whitespace or control chars. */
export const ARCHITECT_ID_RE = /^[A-Za-z0-9._:@|+-]{1,128}$/;
/** Issuer label the dev verifier reports; never accepted by the JWT verifier. */
export const DEV_ARCHITECT_ISSUER = 'urn:agent-arena:dev';
const MAX_JWKS_KEYS = 16;
const MAX_TOKEN_LENGTH = 8192;

export class ArchitectVerifierConfigError extends Error {}

// ---------------------------------------------------------------------------
// JWKS loading and validation
// ---------------------------------------------------------------------------

/**
 * Validate a JWKS for Architect verification: 1-16 keys, every key an Ed25519
 * PUBLIC key (`kty: OKP`, `crv: Ed25519`, `x`, no `d`). A private key in the
 * trust set is refused outright: it means a signing secret was put in config.
 */
export function assertArchitectJwks(value: unknown): JSONWebKeySet {
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_JWKS_KEYS) {
    throw new ArchitectVerifierConfigError(`Architect JWKS must be {"keys":[...]} with 1-${MAX_JWKS_KEYS} keys.`);
  }
  for (const k of keys) {
    const key = k as Record<string, unknown>;
    if (key === null || typeof key !== 'object') throw new ArchitectVerifierConfigError('Architect JWKS key is not an object.');
    if ('d' in key) {
      throw new ArchitectVerifierConfigError('Architect JWKS contains a PRIVATE key (has "d"). Only public keys belong in the trust set.');
    }
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string') {
      throw new ArchitectVerifierConfigError('Architect JWKS keys must be Ed25519 public keys (kty OKP, crv Ed25519).');
    }
    if (key.alg !== undefined && key.alg !== 'EdDSA') {
      throw new ArchitectVerifierConfigError('Architect JWKS key alg must be EdDSA when present.');
    }
  }
  return value as JSONWebKeySet;
}

export interface LocalJwtArchitectVerifierOptions {
  /** Exact `iss` to require. */
  issuer: string;
  /** Audience the token's `aud` must contain. Default `agent-arena:architect`. */
  audience?: string;
  /** A static JWKS (inline/file), or an https URL to fetch it from (Sixi). */
  jwks: JSONWebKeySet | URL;
  /** Allow a non-https JWKS URL (tests / local only; refused in production). */
  allowInsecureJwksUrl?: boolean;
}

/** Default verifier: EdDSA JWT against a configured issuer + JWKS. */
export class LocalJwtArchitectVerifier implements ArchitectVerifier {
  readonly kind = 'jwt' as const;
  readonly issuer: string;
  readonly audience: string;
  private readonly getKey: JWTVerifyGetKey;

  constructor(opts: LocalJwtArchitectVerifierOptions) {
    if (!opts.issuer || typeof opts.issuer !== 'string') {
      throw new ArchitectVerifierConfigError('Architect verifier needs an issuer (WOT_ARCHITECT_ISS).');
    }
    if (opts.issuer === DEV_ARCHITECT_ISSUER) {
      throw new ArchitectVerifierConfigError(`Issuer ${DEV_ARCHITECT_ISSUER} is reserved for the dev verifier.`);
    }
    const audience = opts.audience ?? DEFAULT_ARCHITECT_AUDIENCE;
    // An Architect token must never be interchangeable with an agent access token.
    if (audience === AGENT_TOKEN_AUDIENCE) {
      throw new ArchitectVerifierConfigError(
        `WOT_ARCHITECT_AUD must differ from the agent-token audience (${AGENT_TOKEN_AUDIENCE}).`,
      );
    }
    this.issuer = opts.issuer;
    this.audience = audience;
    if (opts.jwks instanceof URL) {
      const insecureOk = opts.allowInsecureJwksUrl === true && resolveDeployEnv(process.env.WOT_ENV) !== 'production';
      if (opts.jwks.protocol !== 'https:' && !insecureOk) {
        throw new ArchitectVerifierConfigError('WOT_ARCHITECT_JWKS_URL must be https.');
      }
      this.getKey = createRemoteJWKSet(opts.jwks, { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    } else {
      this.getKey = createLocalJWKSet(assertArchitectJwks(opts.jwks));
    }
  }

  async verify(token: string): Promise<VerifiedArchitect> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new Error('missing or oversized Architect token');
    }
    const { payload } = await jwtVerify(token, this.getKey, {
      algorithms: ['EdDSA'],
      typ: ARCHITECT_TOKEN_TYP,
      issuer: this.issuer,
      audience: this.audience,
      requiredClaims: ['sub', 'iat', 'exp'],
      maxTokenAge: ARCHITECT_TOKEN_MAX_AGE_SECONDS,
      clockTolerance: ARCHITECT_CLOCK_TOLERANCE_SECONDS,
    });
    const sub = payload.sub;
    if (typeof sub !== 'string' || !ARCHITECT_ID_RE.test(sub)) {
      throw new Error('Architect token sub is not a valid architect id');
    }
    return { issuer: this.issuer, architectId: sub };
  }
}

// ---------------------------------------------------------------------------
// Dev verifier (WOT_ENV=development|test only)
// ---------------------------------------------------------------------------

function assertDevEnv(env: NodeJS.ProcessEnv): void {
  if (resolveDeployEnv(env.WOT_ENV) === 'production') {
    throw new ArchitectVerifierConfigError(
      'DevArchitectVerifier is only available with WOT_ENV=development|test ' +
        `(WOT_ENV=${env.WOT_ENV ?? '<unset>'}). Refusing to start with a dev human-auth verifier.`,
    );
  }
}

/**
 * Dev-only verifier: `Authorization: Bearer dev:<architect_id>`. No signature;
 * it exists so the local sandbox and tests can exercise the real verifier seam.
 * Refuses to construct outside development|test, and re-checks the environment
 * on every call so a flipped WOT_ENV cannot keep it alive.
 */
export class DevArchitectVerifier implements ArchitectVerifier {
  readonly kind = 'dev' as const;
  readonly issuer = DEV_ARCHITECT_ISSUER;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    assertDevEnv(env);
  }

  async verify(token: string): Promise<VerifiedArchitect> {
    assertDevEnv(process.env);
    if (typeof token !== 'string' || !token.startsWith('dev:')) throw new Error('not a dev Architect token');
    const architectId = token.slice('dev:'.length);
    if (!ARCHITECT_ID_RE.test(architectId)) throw new Error('dev Architect token has an invalid architect id');
    return { issuer: DEV_ARCHITECT_ISSUER, architectId };
  }
}

// ---------------------------------------------------------------------------
// Environment wiring
// ---------------------------------------------------------------------------

/**
 * Build the Architect verifier from the environment. Fail-closed:
 *
 *   WOT_ARCHITECT_VERIFIER  `jwt` (default) | `dev`; anything else throws.
 *   jwt: exactly one of WOT_ARCHITECT_JWKS / WOT_ARCHITECT_JWKS_FILE /
 *        WOT_ARCHITECT_JWKS_URL, plus WOT_ARCHITECT_ISS (required) and
 *        WOT_ARCHITECT_AUD (optional). No JWKS source → `undefined`, so the
 *        management routes answer 401 (no human auth configured).
 *   dev: DevArchitectVerifier; throws unless WOT_ENV=development|test.
 *
 * A malformed configuration THROWS at startup rather than degrading to "open".
 */
export function architectVerifierFromEnv(env: NodeJS.ProcessEnv = process.env): ArchitectVerifier | undefined {
  const mode = env.WOT_ARCHITECT_VERIFIER ?? 'jwt';
  if (mode === 'dev') return new DevArchitectVerifier(env);
  if (mode !== 'jwt') {
    throw new ArchitectVerifierConfigError(`WOT_ARCHITECT_VERIFIER must be "jwt" or "dev" (got "${mode}").`);
  }
  const sources = (['WOT_ARCHITECT_JWKS', 'WOT_ARCHITECT_JWKS_FILE', 'WOT_ARCHITECT_JWKS_URL'] as const).filter(
    (k) => env[k] !== undefined && env[k] !== '',
  );
  if (sources.length === 0) return undefined;
  if (sources.length > 1) {
    throw new ArchitectVerifierConfigError(`Set exactly one Architect JWKS source (got ${sources.join(', ')}).`);
  }
  const issuer = env.WOT_ARCHITECT_ISS;
  if (!issuer) throw new ArchitectVerifierConfigError('WOT_ARCHITECT_ISS is required when an Architect JWKS is configured.');
  const audience = env.WOT_ARCHITECT_AUD || undefined;

  let jwks: JSONWebKeySet | URL;
  const source = sources[0];
  if (source === 'WOT_ARCHITECT_JWKS_URL') {
    jwks = new URL(env.WOT_ARCHITECT_JWKS_URL as string);
  } else {
    const raw = source === 'WOT_ARCHITECT_JWKS' ? (env.WOT_ARCHITECT_JWKS as string) : readFileSync(env.WOT_ARCHITECT_JWKS_FILE as string, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ArchitectVerifierConfigError(`${source} is not valid JSON.`);
    }
    jwks = assertArchitectJwks(parsed);
  }
  return new LocalJwtArchitectVerifier({ issuer, audience, jwks });
}
