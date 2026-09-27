/**
 * Access-token mint + verify (RFC 9068 `at+jwt`, EdDSA), JWKS, and scope check.
 * Claim set follows agent-passports.md §2.3 exactly, including the reserved
 * (present-but-null in Phase 1) `parent_agent_id` and `act` delegation claims.
 */

import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  type JWK,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import {
  AUDIENCE,
  DEFAULT_TTL_SECONDS,
  DELEGABLE_SCOPES,
  ISSUER,
  JWKS_URI,
} from './config.ts';
import { getKeyMaterial } from './keys.ts';
import { TokenExpired, TokenInvalid } from './errors.ts';

export type League = 'edge' | 'core' | 'frontier';

/**
 * The `delegation` claim carried by every delegated child `at+jwt` (Phase 4 B1;
 * docs/security/delegated-squad-tokens.md §2.1). A verifier tells "this is a
 * delegated child" by `delegation != null`; it reads what the child is bound to
 * off `squad_id`/`raid_id`, who it derives from off `parent_agent_id`, and that
 * it is depth-capped off `depth === 1`. This is the ENFORCEMENT payload inside
 * the token — richer than the summary `DelegationClaim` projected into the
 * exchange HTTP response (contracts/openapi.yaml).
 */
export interface DelegationClaim {
  /** The `dlg_…` grant this child hangs off — the cascade + revocation handle. */
  grant_id: string;
  parent_client_id: string;
  parent_agent_id: string;
  /** The exact parent token that authorized this exchange (audit trail). */
  parent_jti: string;
  /** Ordered root → child agent-id chain; length 2 for a direct child. */
  chain: string[];
  /** MUST be exactly 1 for any child (depth cap; no re-delegation). */
  depth: number;
  squad_id: string;
  /** 1-based squad slot; one live session per (squad_id, slot). */
  slot: number;
  /** The squad-member slot identity (`mem_…`). */
  member_id: string;
  /** Bound raid instance; null until the squad enters a raid. */
  raid_id: string | null;
}

/** Input to mint an access token. */
export interface MintAccessTokenInput {
  ownerId: string;
  agentId: string;
  clientId: string;
  league: League;
  scope: string[];
  parentAgentId?: string | null;
  ttlSeconds?: number;
  /**
   * Delegation binding (Phase 4 B1). When present the minted token is a squad
   * CHILD: it emits the `delegation` claim, a FLAT `act:{sub:parent_agent_id}`,
   * and `parent_agent_id`. When absent the token is a root and behaves exactly
   * as Phase 1 (act:null, parent_agent_id:null, no delegation key).
   */
  delegation?: DelegationClaim | null;
}

/** Verified access-token claims (agent-passports.md §2.3), with parsed scopes. */
export interface AccessClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
  owner_id: string;
  agent_id: string;
  league: League;
  /** Space-delimited scope string (RFC 9068 §2.2.3). */
  scope: string;
  /** Convenience: `scope` split on whitespace. */
  scopes: string[];
  /** Reserved delegation claims (null on a root token). */
  parent_agent_id: string | null;
  act: { sub: string } | null;
  /**
   * The delegation binding (Phase 4 B1) — non-null IFF this is a squad child.
   * A root token parses this as `null` and authorizes exactly as before.
   */
  delegation: DelegationClaim | null;
  // No `cnf` / DPoP confirmation: contracts 2.2.0 deprecates device binding as
  // "ignored, not a security control" (G-10), so no such claim is minted or read.
}

/** Mint an RFC 9068 `at+jwt` access token (EdDSA, `kid` header). */
export async function mintAccessToken(input: MintAccessTokenInput): Promise<string> {
  const { privateKey, kid } = await getKeyMaterial();
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const delegation = input.delegation ?? null;
  const payload: JWTPayload = {
    client_id: input.clientId,
    owner_id: input.ownerId,
    agent_id: input.agentId,
    league: input.league,
    scope: input.scope.join(' '),
    // Delegation claims. Root (no delegation): parent_agent_id/act stay null and
    // no `delegation` key is emitted — byte-identical to the Phase-1 shape. Child
    // (delegation present): `act` is FLAT {sub:parent} (never nested — a nested
    // act is itself proof of illegal depth), and parent_agent_id mirrors it.
    parent_agent_id: delegation ? delegation.parent_agent_id : (input.parentAgentId ?? null),
    act: delegation ? { sub: delegation.parent_agent_id } : null,
  };
  if (delegation) payload.delegation = delegation;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
    .setIssuer(ISSUER)
    .setSubject(input.agentId)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(randomUUID())
    .sign(privateKey);
}

type Verifier = KeyLike | ReturnType<typeof createRemoteJWKSet>;

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getVerifier(): Promise<Verifier> {
  if (JWKS_URI) {
    if (!remoteJwks) {
      // Explicit cooldown/cache so an unknown-kid flood can't turn verification
      // into a JWKS-fetch DoS — do not rely on jose's implicit defaults (SR-1 N-2).
      remoteJwks = createRemoteJWKSet(new URL(JWKS_URI), {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
    }
    return remoteJwks;
  }
  const { publicKey } = await getKeyMaterial();
  return publicKey;
}

/**
 * Verify an access token: signature (local key or configured JWKS), `typ`,
 * `iss`, `aud`, `exp`. Returns typed claims; throws `TokenExpired`/`TokenInvalid`.
 */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const key = await getVerifier();
  const opts = { issuer: ISSUER, audience: AUDIENCE, typ: 'at+jwt', algorithms: ['EdDSA'] };
  let payload: JWTPayload;
  try {
    // The split narrows `key` to each jose overload (static key vs JWKS getter).
    const result =
      typeof key === 'function'
        ? await jwtVerify(token, key, opts)
        : await jwtVerify(token, key, opts);
    payload = result.payload;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ERR_JWT_EXPIRED') {
      throw new TokenExpired((err as Error).message);
    }
    throw new TokenInvalid((err as Error)?.message ?? 'token verification failed');
  }

  const scopeStr = typeof payload.scope === 'string' ? payload.scope : '';
  return {
    iss: String(payload.iss),
    sub: String(payload.sub),
    aud: Array.isArray(payload.aud) ? String(payload.aud[0]) : String(payload.aud),
    exp: Number(payload.exp),
    iat: Number(payload.iat),
    jti: String(payload.jti),
    client_id: String(payload.client_id ?? ''),
    owner_id: String(payload.owner_id ?? ''),
    agent_id: String(payload.agent_id ?? payload.sub ?? ''),
    league: (payload.league as League) ?? 'core',
    scope: scopeStr,
    scopes: scopeStr.split(/\s+/).filter(Boolean),
    // A legacy retired claim on an old token is ignored: only the fields above are read.
    parent_agent_id: (payload.parent_agent_id as string | null) ?? null,
    act: (payload.act as { sub: string } | null) ?? null,
    delegation: parseDelegationClaim(payload.delegation),
  };
}

/**
 * Tolerantly parse the `delegation` claim off a verified payload. Returns null
 * for a root token (absent/null) and for any malformed shape — a delegated child
 * ALWAYS carries a well-formed claim, so a garbled one is treated as "not a
 * child" and (because it also lacks a legit binding) will fail the binding gates
 * downstream rather than being trusted. The signature was already checked by
 * jose, so this only shapes fields — it never re-establishes trust.
 */
function parseDelegationClaim(raw: unknown): DelegationClaim | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (
    typeof d.grant_id !== 'string' ||
    typeof d.parent_agent_id !== 'string' ||
    typeof d.squad_id !== 'string' ||
    typeof d.depth !== 'number'
  ) {
    return null;
  }
  return {
    grant_id: d.grant_id,
    parent_client_id: typeof d.parent_client_id === 'string' ? d.parent_client_id : '',
    parent_agent_id: d.parent_agent_id,
    parent_jti: typeof d.parent_jti === 'string' ? d.parent_jti : '',
    chain: Array.isArray(d.chain) ? (d.chain as unknown[]).map(String) : [],
    depth: d.depth,
    squad_id: d.squad_id,
    slot: typeof d.slot === 'number' ? d.slot : -1,
    member_id: typeof d.member_id === 'string' ? d.member_id : '',
    raid_id: typeof d.raid_id === 'string' ? d.raid_id : null,
  };
}

/**
 * A token is a ROOT (delegation source) IFF it carries none of the delegation
 * markers. The token-exchange handler accepts a `subject_token` ONLY if this is
 * true — presenting a child as a subject is a re-delegation attempt (§1.4 step 4,
 * §4). A nested `act` (act.act) is itself proof of illegal depth and fails here.
 */
export function isRootToken(
  claims: Pick<AccessClaims, 'delegation' | 'act' | 'parent_agent_id'> & { act?: unknown },
): boolean {
  if (claims.delegation != null) return false;
  if (claims.parent_agent_id != null) return false;
  const act = claims.act as { act?: unknown } | null;
  if (act != null) return false;
  return true;
}

/** The outcome of narrowing a requested child scope against the parent + allowlist. */
export type ScopeNarrowing =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: 'invalid_scope' };

/**
 * Compute the child scope (§3.1): `child ⊆ subject.scope ∩ DELEGABLE_SCOPES`.
 * Two gates, both required — the child can never hold a scope the PARENT lacks
 * (RFC 8693 down-scoping) AND can only hold scopes that are delegable at all.
 * Requesting anything outside that set — even a scope the parent legitimately
 * holds, e.g. `eval:run` — fails `invalid_scope`. An omitted request
 * defaults to the full delegable subset the parent holds.
 */
export function narrowChildScope(requested: string[] | null, subjectScopes: string[]): ScopeNarrowing {
  const delegableSubset = subjectScopes.filter((s) => DELEGABLE_SCOPES.includes(s));
  if (!requested || requested.length === 0) {
    if (delegableSubset.length === 0) return { ok: false, reason: 'invalid_scope' };
    return { ok: true, scopes: delegableSubset };
  }
  const disallowed = requested.filter((s) => !delegableSubset.includes(s));
  if (disallowed.length > 0) return { ok: false, reason: 'invalid_scope' };
  return { ok: true, scopes: [...requested] };
}

/** True if the claims carry the given scope. */
export function hasScope(claims: Pick<AccessClaims, 'scopes'>, scope: string): boolean {
  return claims.scopes.includes(scope);
}

/** A privileged affordance's authorization requirement (agent-passports §3.3). */
export interface AffordanceRequirement {
  /** The scope the affordance needs. */
  scope: string;
}

/** The decision an affordance check yields — an allow, or a typed denial reason. */
export type AffordanceDecision =
  | { ok: true }
  | { ok: false; reason: 'insufficient_scope'; scope: string };

/**
 * The canonical passport-authorization rule (agent-passports.md §3.3): a gated
 * affordance is authorized IFF its required scope ∈ token `scope`. Pure and
 * transport-agnostic so every resource server enforces one rule the same way.
 * The caller maps `insufficient_scope` → 403 insufficient_scope.
 */
export function authorizeAffordance(
  claims: Pick<AccessClaims, 'scopes'>,
  req: AffordanceRequirement,
): AffordanceDecision {
  if (!hasScope(claims, req.scope)) {
    return { ok: false, reason: 'insufficient_scope', scope: req.scope };
  }
  return { ok: true };
}

/** Public JWKS for GET /.well-known/jwks.json (kid, use:sig, alg:EdDSA). */
export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk } = await getKeyMaterial();
  return { keys: [publicJwk] };
}
