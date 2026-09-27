/**
 * Delegation grants + child-token revocation denylist (Phase 4 B1 — delegated
 * squad tokens; docs/security/delegated-squad-tokens.md §5.4).
 *
 * This is the thin server-side state the RFC 8693 token exchange needs. A child
 * `at+jwt` is NOT persisted as a passport; only (a) the short-lived per-squad
 * `dlg_…` grant and (b) the reserved `revocations/{jti}` denylist exist. Because
 * a child's `client_id` IS the parent's `cid_…`, the owner/parent cascade falls
 * out of the arena's EXISTING passport-status check for free (§5.4) — this store
 * only adds the two net-new gates: grant status and the jti denylist.
 *
 * Interface-first (ADR-000): in-memory Maps for the demo; a persistent impl
 * (`grants/{grant_id}`, `revocations/{jti}`) slots behind the same interface.
 */

import { newId } from './ids.ts';

export type DelegationGrantStatus = 'active' | 'revoked';

/**
 * `grants/{grant_id}` — one per (parentClientId, squadId). The cascade anchor:
 * revoking it (squad dissolve) invalidates every child bound to it, while the
 * parent passport and its siblings are untouched (child independence, §5.2).
 */
export interface DelegationGrant {
  grantId: string;
  squadId: string;
  raidId: string | null;
  parentClientId: string;
  parentAgentId: string;
  ownerId: string;
  /** The narrowed child scope this grant delegates (⊆ parent ∩ delegable). */
  scopes: string[];
  /** Member slots allocated so far (never exceeds MAX_SQUAD_SIZE). */
  slots: number;
  status: DelegationGrantStatus;
  /** Set only in bind-to-session mode (§5.3); the arena revokes on its close. */
  boundSessionId?: string;
  createdAt: string;
  /** ISO-8601. A grant past this instant is treated as revoked (TTL cascade). */
  expiresAt: string;
}

export interface OpenOrGetGrantInput {
  /** Reuse an existing forming squad, or omit to mint a fresh `sqd_…`. */
  squadId?: string;
  raidId?: string | null;
  parentClientId: string;
  parentAgentId: string;
  ownerId: string;
  scopes: string[];
  /** Grant lifetime in seconds from `now`. */
  ttlSeconds: number;
  /** ms-epoch injection point for deterministic tests. Defaults to Date.now(). */
  nowMs?: number;
}

export interface DelegationStore {
  /** Mint-or-reuse the `dlg_…` grant for `(parentClientId, squadId)` (§1.4 step 7). */
  openOrGet(input: OpenOrGetGrantInput): Promise<DelegationGrant>;
  getGrant(grantId: string): Promise<DelegationGrant | null>;
  /**
   * Reserve `count` member slots on the grant. Returns the 1-based slot numbers,
   * or null if that would exceed `maxSlots` (the squad-size cap). Atomic in the
   * in-memory impl (single-threaded) so two concurrent exchanges can't oversubscribe.
   */
  reserveSlots(grantId: string, count: number, maxSlots: number): Promise<number[] | null>;
  /** Dissolve the squad → cascade to all its children. Returns false if unknown. */
  revokeGrant(grantId: string): Promise<boolean>;
  /** `revocations/{jti}` — true if this specific child token has been killed. */
  isJtiRevoked(jti: string): Promise<boolean>;
  /** Kill exactly one child token by its `jti` (siblings untouched). */
  revokeJti(jti: string): Promise<boolean>;
}

const nowIso = (ms: number): string => new Date(ms).toISOString();

export class InMemoryDelegationStore implements DelegationStore {
  private byGrantId = new Map<string, DelegationGrant>();
  /** `${parentClientId}::${squadId}` → grantId (mint-or-reuse index). */
  private bySquad = new Map<string, string>();
  private deniedJti = new Set<string>();

  async openOrGet(input: OpenOrGetGrantInput): Promise<DelegationGrant> {
    const ms = input.nowMs ?? Date.now();
    if (input.squadId) {
      const key = `${input.parentClientId}::${input.squadId}`;
      const existingId = this.bySquad.get(key);
      if (existingId) {
        const existing = this.byGrantId.get(existingId);
        // Reuse only a still-live grant for the SAME owner/parent; a revoked or
        // expired grant is not silently resurrected.
        if (
          existing &&
          existing.status === 'active' &&
          Date.parse(existing.expiresAt) > ms &&
          existing.ownerId === input.ownerId
        ) {
          if (input.raidId && !existing.raidId) existing.raidId = input.raidId;
          return { ...existing };
        }
      }
    }
    const grantId = newId('dlg');
    const squadId = input.squadId ?? newId('sqd');
    const grant: DelegationGrant = {
      grantId,
      squadId,
      raidId: input.raidId ?? null,
      parentClientId: input.parentClientId,
      parentAgentId: input.parentAgentId,
      ownerId: input.ownerId,
      scopes: [...input.scopes],
      slots: 0,
      status: 'active',
      createdAt: nowIso(ms),
      expiresAt: nowIso(ms + input.ttlSeconds * 1000),
    };
    this.byGrantId.set(grantId, grant);
    this.bySquad.set(`${input.parentClientId}::${squadId}`, grantId);
    return { ...grant };
  }

  async getGrant(grantId: string): Promise<DelegationGrant | null> {
    const g = this.byGrantId.get(grantId);
    return g ? { ...g } : null;
  }

  async reserveSlots(grantId: string, count: number, maxSlots: number): Promise<number[] | null> {
    const g = this.byGrantId.get(grantId);
    if (!g) return null;
    if (g.slots + count > maxSlots) return null;
    const start = g.slots + 1;
    const slots: number[] = [];
    for (let i = 0; i < count; i++) slots.push(start + i);
    g.slots += count;
    return slots;
  }

  async revokeGrant(grantId: string): Promise<boolean> {
    const g = this.byGrantId.get(grantId);
    if (!g) return false;
    g.status = 'revoked';
    return true;
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    return this.deniedJti.has(jti);
  }

  async revokeJti(jti: string): Promise<boolean> {
    if (this.deniedJti.has(jti)) return false;
    this.deniedJti.add(jti);
    return true;
  }
}
