/**
 * Delegated-child verification for the raid channel (Phase 4 B1; the security
 * spine of gate item 1 — docs/security/delegated-squad-tokens.md §5).
 *
 * This is the INTEGRATION SEAM the raid engine (B2) calls at `raid_hello`. It is
 * the child-token analogue of the duel `handleHello` connect check, factored out
 * so it is pure enough to unit-test without spinning up the raid engine. It does
 * the full "is this child valid RIGHT NOW" gate (§5.5 connect row):
 *
 *   token verifies (EdDSA/at+jwt)                         → else 4401
 *   ∧ it IS a delegated child (delegation != null)        → else 4403
 *   ∧ depth === 1 (belt-and-suspenders no-re-delegation)  → else 4403
 *   ∧ scope ⊆ DELEGABLE_SCOPES ∧ has play:raid            → else 4403
 *   ∧ parent passport active (shared client_id → owner-ban/parent-revoke free) → else 4410
 *   ∧ grant active ∧ not past expiresAt                   → else 4410
 *   ∧ child jti not denylisted                            → else 4410
 *   ∧ raid/squad binding matches the hello                → else 4403
 *
 * The CASCADE (§5.2) is authoritative because the same set is re-read on the
 * arena's rolling 30 s loop (see arena.ts) for every LIVE child session.
 */

import {
  hasScope,
  verifyAccessToken,
  DELEGABLE_SCOPES,
  MAX_DELEGATION_DEPTH,
  TokenExpired,
  type AccessClaims,
  type DelegationClaim,
} from 'wot-auth';
import type { Stores } from 'wot-store';
import { CLOSE } from './config.ts';

/** The stores a child check needs — a narrow slice so callers can pass a subset. */
export type DelegationStores = Pick<Stores, 'passports' | 'delegations'>;

/** What the `raid_hello` frame asserts about the binding it wants. */
export interface RaidHelloBinding {
  /** The child at+jwt from `raid_hello.token`. */
  token: string;
  /** `raid_hello.squad_id` — MUST equal the token's delegation.squad_id. */
  squadId?: string;
  /** `raid_hello.member_id` (optional) — when present MUST equal delegation.member_id. */
  memberId?: string;
  /** `raid_hello.raid_id` (optional) — when the child is raid-bound it MUST match. */
  raidId?: string;
}

export type DelegatedChildDenyReason =
  | 'token_expired'
  | 'token_invalid'
  | 'not_delegated'
  | 'redelegation'
  | 'insufficient_scope'
  | 'passport_or_owner_revoked'
  | 'grant_revoked'
  | 'jti_revoked'
  | 'squad_binding'
  | 'raid_binding'
  | 'member_binding';

export type DelegatedChildResult =
  | { ok: true; claims: AccessClaims; delegation: DelegationClaim; registryKey: string }
  | { ok: false; code: number; reason: DelegatedChildDenyReason };

/**
 * One live session per child, keyed by (squad_id, slot) — NOT by client_id, since
 * all 5 children (and the parent) share `cid_PARENT` (§5.1). Roots stay keyed by
 * client_id. B2 uses this for the raid registry so a squad member supersedes only
 * its OWN slot (close 4409), never a sibling.
 */
export function registryKeyFor(claims: Pick<AccessClaims, 'client_id' | 'delegation'>): string {
  return claims.delegation
    ? `${claims.delegation.squad_id}:${claims.delegation.slot}`
    : claims.client_id;
}

/**
 * Verify a delegated child presented at `raid_hello`. B2 should call this, then
 * on `ok` open the raid session keyed by `registryKey`; on `!ok` close with
 * `code` (reusing the existing duel close codes — no new codes). This function
 * NEVER trusts the parent's authority — it authorizes strictly on the CHILD's
 * narrowed claims (confused-deputy defense, T-D5).
 */
export async function verifyDelegatedChild(
  stores: DelegationStores,
  hello: RaidHelloBinding,
  nowMs: number = Date.now(),
): Promise<DelegatedChildResult> {
  let claims: AccessClaims;
  try {
    claims = await verifyAccessToken(hello.token);
  } catch (err) {
    const reason = err instanceof TokenExpired ? 'token_expired' : 'token_invalid';
    return { ok: false, code: CLOSE.UNAUTHENTICATED, reason };
  }

  const d = claims.delegation;
  // A parent/root token is NOT valid on the raid channel — only a bound child.
  if (!d) return { ok: false, code: CLOSE.FORBIDDEN, reason: 'not_delegated' };
  // Depth cap (belt-and-suspenders): a well-formed child is always depth 1; a
  // nested act or depth>1 is proof of an illegal chain.
  if (d.depth !== MAX_DELEGATION_DEPTH || (claims.act as { act?: unknown } | null)?.act != null) {
    return { ok: false, code: CLOSE.FORBIDDEN, reason: 'redelegation' };
  }
  // Scope: must hold play:raid AND carry ONLY delegable scopes (a resource server
  // never re-expands to parent scope; a child bearing negotiate:a2a/play:duel is
  // rejected here even though mint should never have produced one — T-D1).
  const onlyDelegable = claims.scopes.every((s) => DELEGABLE_SCOPES.includes(s));
  if (!onlyDelegable || !hasScope(claims, 'play:raid')) {
    return { ok: false, code: CLOSE.FORBIDDEN, reason: 'insufficient_scope' };
  }

  // Parent passport active. Because the child's client_id IS cid_PARENT, this ONE
  // read cascades owner-ban (banOwner flips the passport) and parent-revoke for
  // free — the shared-client_id win (§5.4).
  const passport = await stores.passports.getByClientId(claims.client_id);
  if (!passport || passport.status !== 'active') {
    return { ok: false, code: CLOSE.REVOKED, reason: 'passport_or_owner_revoked' };
  }

  // Grant active + not expired (the net-new gates §5.4).
  const grant = await stores.delegations.getGrant(d.grant_id);
  if (!grant || grant.status !== 'active' || Date.parse(grant.expiresAt) <= nowMs) {
    return { ok: false, code: CLOSE.REVOKED, reason: 'grant_revoked' };
  }
  if (await stores.delegations.isJtiRevoked(claims.jti)) {
    return { ok: false, code: CLOSE.REVOKED, reason: 'jti_revoked' };
  }

  // Binding: the child is bound to exactly one (squad_id[, raid_id]); reuse in a
  // different squad/raid is rejected (§5.1, T-D4). member_id, when the hello names
  // it, must match the token.
  if (hello.squadId !== undefined && hello.squadId !== d.squad_id) {
    return { ok: false, code: CLOSE.FORBIDDEN, reason: 'squad_binding' };
  }
  if (hello.memberId !== undefined && hello.memberId !== d.member_id) {
    return { ok: false, code: CLOSE.FORBIDDEN, reason: 'member_binding' };
  }
  // If the child is raid-bound, a hello for a DIFFERENT raid is rejected. A child
  // not yet raid-bound (raid_id null) may enter the raid its squad queues into.
  if (hello.raidId !== undefined && d.raid_id !== null && hello.raidId !== d.raid_id) {
    return { ok: false, code: CLOSE.FORBIDDEN, reason: 'raid_binding' };
  }

  return { ok: true, claims, delegation: d, registryKey: registryKeyFor(claims) };
}
