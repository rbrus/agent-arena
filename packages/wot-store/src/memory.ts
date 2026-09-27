/**
 * In-memory store implementations (Maps). Zero external dependencies so the
 * local demo runs from a clean clone. Every method is async so a persistent
 * impl can slot behind the same interfaces.
 */

import { randomBytes } from 'node:crypto';
import { generateClientSecret, hashSecret, type Ed25519PublicJwk } from 'wot-auth';
import { newId } from './ids.ts';
import { InMemoryLedgerStore } from './ledger.ts';
import { InMemoryNegotiationStore } from './negotiations.ts';
import { InMemoryDelegationStore } from './delegations.ts';
import { InMemoryMatchEventStore } from './matchevents.ts';
import { toSigningKeyRecord } from './signing-keys.ts';

/** `whsec_…` HMAC signing key (webhooks.md §2; pattern ^whsec_[A-Za-z0-9_-]{32,}$). */
function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
import type {
  CreatePassportInput,
  CreatePassportResult,
  CreateStoresOptions,
  CreateTicketInput,
  CreateWebhookInput,
  CreateWebhookResult,
  MatchStore,
  MatchSummary,
  OwnerRecord,
  OwnerStore,
  PassportRecord,
  PassportStore,
  ReplayRecord,
  ReplayStore,
  SaveReplayInput,
  Stores,
  TicketRecord,
  TicketStatus,
  TicketStore,
  WebhookEventType,
  WebhookRecord,
  WebhookStatus,
  WebhookStore,
} from './types.ts';

const now = (): string => new Date().toISOString();

/** Mark a passport's current signing key revoked (idempotent; the first revocation time is kept). */
function revokeSigningKey(record: PassportRecord, ts: string): void {
  if (record.signingKey && record.signingKey.revokedAt === null) record.signingKey = { ...record.signingKey, revokedAt: ts };
}

/**
 * Owners keyed by verified Architect subject (`iss` + `sub`; agent-passports.md
 * §1.1). Get-or-create so the same verified Architect always resolves to the
 * same opaque `owner_id` — the anchor for per-owner quota and ban lineage.
 */
export class InMemoryOwnerStore implements OwnerStore {
  private bySubject = new Map<string, OwnerRecord>();
  private byOwnerId = new Map<string, OwnerRecord>();

  async resolveByArchitect(issuer: string, architectId: string): Promise<OwnerRecord> {
    if (!issuer || !architectId) throw new Error('resolveByArchitect: issuer and architectId are required');
    // JSON-encoded pair: no separator an issuer or sub could forge a collision with.
    const key = JSON.stringify([issuer, architectId]);
    const existing = this.bySubject.get(key);
    if (existing) return { ...existing };
    const record: OwnerRecord = {
      ownerId: newId('own'),
      architectIssuer: issuer,
      architectId,
      status: 'active',
      createdAt: now(),
    };
    this.bySubject.set(key, record);
    this.byOwnerId.set(record.ownerId, record);
    return { ...record };
  }

  /** @deprecated M8 transitional alias; see OwnerStore. */

  async getByOwnerId(ownerId: string): Promise<OwnerRecord | null> {
    const r = this.byOwnerId.get(ownerId);
    return r ? { ...r } : null;
  }
}

export class InMemoryPassportStore implements PassportStore {
  private byClientId = new Map<string, PassportRecord>();
  private agentToClient = new Map<string, string>();

  async createPassport(input: CreatePassportInput): Promise<CreatePassportResult> {
    const clientId = newId('cid');
    const agentId = newId('agt');
    const secret = generateClientSecret();
    const ts = now();
    // Validate the public signing key BEFORE any id is bound (a refused key creates nothing).
    const signingKey = input.signingPublicJwk !== undefined ? toSigningKeyRecord(input.signingPublicJwk, ts) : null;
    const record: PassportRecord = {
      clientId,
      agentId,
      ownerId: input.ownerId,
      secretHash: hashSecret(secret),
      secretVersion: 1,
      status: 'active',
      league: input.league,
      scopes: [...input.scopes],
      parentAgentId: null,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      signingKey,
      createdAt: ts,
      updatedAt: ts,
      rotatedAt: null,
    };
    this.byClientId.set(clientId, record);
    this.agentToClient.set(agentId, clientId);
    return { clientId, agentId, secret };
  }

  async getByClientId(clientId: string): Promise<PassportRecord | null> {
    return this.byClientId.get(clientId) ?? null;
  }

  async getByAgentId(agentId: string): Promise<PassportRecord | null> {
    const clientId = this.agentToClient.get(agentId);
    return clientId ? (this.byClientId.get(clientId) ?? null) : null;
  }

  async rotateSecret(clientId: string, opts: { signingPublicJwk?: Ed25519PublicJwk } = {}): Promise<{ secret: string } | null> {
    const record = this.byClientId.get(clientId);
    if (!record) return null;
    const ts = now();
    // Validate the replacement key first: a refused key leaves the passport untouched.
    const next = opts.signingPublicJwk !== undefined ? toSigningKeyRecord(opts.signingPublicJwk, ts) : null;
    const secret = generateClientSecret();
    record.secretHash = hashSecret(secret);
    record.secretVersion += 1;
    record.rotatedAt = ts;
    record.updatedAt = ts;
    // A rotation is a credential-compromise response: the old signing key dies with the old secret.
    revokeSigningKey(record, ts);
    record.signingKey = next;
    return { secret };
  }

  async revoke(clientId: string): Promise<boolean> {
    const record = this.byClientId.get(clientId);
    if (!record) return false;
    record.status = 'revoked';
    record.updatedAt = now();
    revokeSigningKey(record, record.updatedAt);
    return true;
  }

  async banOwner(ownerId: string): Promise<number> {
    let count = 0;
    for (const record of this.byClientId.values()) {
      if (record.ownerId === ownerId && record.status !== 'revoked') {
        record.status = 'revoked';
        record.updatedAt = now();
        revokeSigningKey(record, record.updatedAt);
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryTicketStore implements TicketStore {
  private byTicketId = new Map<string, TicketRecord>();

  constructor(private arenaBaseUrl = 'ws://127.0.0.1:8787/v1/arena') {}

  async createTicket(input: CreateTicketInput): Promise<TicketRecord> {
    const ticketId = newId('tkt');
    const ts = now();
    const record: TicketRecord = {
      ticketId,
      ownerId: input.ownerId,
      agentId: input.agentId,
      mode: input.mode,
      league: input.league,
      status: 'pending',
      arenaUrl: `${this.arenaBaseUrl}?ticket_id=${ticketId}`,
      matchId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.byTicketId.set(ticketId, record);
    return record;
  }

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    return this.byTicketId.get(ticketId) ?? null;
  }

  async bindMatch(ticketId: string, matchId: string): Promise<TicketRecord | null> {
    const record = this.byTicketId.get(ticketId);
    if (!record) return null;
    record.matchId = matchId;
    record.status = 'assigned';
    record.updatedAt = now();
    return record;
  }

  async setStatus(ticketId: string, status: TicketStatus): Promise<TicketRecord | null> {
    const record = this.byTicketId.get(ticketId);
    if (!record) return null;
    record.status = status;
    record.updatedAt = now();
    return record;
  }
}

export class InMemoryMatchStore implements MatchStore {
  private byMatchId = new Map<string, MatchSummary>();

  async saveSummary(summary: MatchSummary): Promise<void> {
    this.byMatchId.set(summary.matchId, { ...summary });
  }

  async updateSummary(matchId: string, patch: Partial<MatchSummary>): Promise<void> {
    const existing = this.byMatchId.get(matchId);
    if (!existing) return;
    this.byMatchId.set(matchId, { ...existing, ...patch, matchId });
  }

  async getSummary(matchId: string): Promise<MatchSummary | null> {
    const found = this.byMatchId.get(matchId);
    return found ? { ...found } : null;
  }
}

export class InMemoryWebhookStore implements WebhookStore {
  private byId = new Map<string, WebhookRecord>();

  async create(input: CreateWebhookInput): Promise<CreateWebhookResult> {
    const webhookId = newId('whk');
    const signingSecret = generateWebhookSecret();
    const ts = now();
    const record: WebhookRecord = {
      webhookId,
      ownerId: input.ownerId,
      url: input.url,
      events: [...input.events],
      signingSecret,
      secretVersion: 1,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    };
    this.byId.set(webhookId, record);
    return { record: { ...record }, signingSecret };
  }

  async getById(webhookId: string): Promise<WebhookRecord | null> {
    const r = this.byId.get(webhookId);
    return r ? { ...r } : null;
  }

  async listByOwner(ownerId: string): Promise<WebhookRecord[]> {
    return [...this.byId.values()].filter((r) => r.ownerId === ownerId).map((r) => ({ ...r }));
  }

  async listForDelivery(ownerId: string, event: WebhookEventType): Promise<WebhookRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.ownerId === ownerId && r.status === 'active' && r.events.includes(event))
      .map((r) => ({ ...r }));
  }

  async delete(webhookId: string): Promise<boolean> {
    return this.byId.delete(webhookId);
  }

  async rotate(webhookId: string): Promise<{ signingSecret: string } | null> {
    const r = this.byId.get(webhookId);
    if (!r) return null;
    r.signingSecret = generateWebhookSecret();
    r.secretVersion += 1;
    r.updatedAt = now();
    return { signingSecret: r.signingSecret };
  }

  async setStatus(webhookId: string, status: WebhookStatus): Promise<WebhookRecord | null> {
    const r = this.byId.get(webhookId);
    if (!r) return null;
    r.status = status;
    r.updatedAt = now();
    return { ...r };
  }
}

export class InMemoryReplayStore implements ReplayStore {
  private byReplayId = new Map<string, ReplayRecord>();

  async saveReplay(input: SaveReplayInput): Promise<ReplayRecord> {
    const replayId = newId('rpl');
    const record: ReplayRecord = {
      replayId,
      matchId: input.matchId ?? null,
      seed: input.seed,
      inputs: input.inputs,
      tickLog: input.tickLog,
      hash: input.hash,
      createdAt: now(),
    };
    this.byReplayId.set(replayId, record);
    return record;
  }

  async getReplay(replayId: string): Promise<ReplayRecord | null> {
    return this.byReplayId.get(replayId) ?? null;
  }
}

/** Build a fresh set of in-memory stores (the demo's zero-DB backing). */
export function createStores(opts: CreateStoresOptions = {}): Stores {
  return {
    owners: new InMemoryOwnerStore(),
    passports: new InMemoryPassportStore(),
    tickets: new InMemoryTicketStore(opts.arenaBaseUrl),
    matches: new InMemoryMatchStore(),
    replays: new InMemoryReplayStore(),
    webhooks: new InMemoryWebhookStore(),
    ledger: new InMemoryLedgerStore(),
    negotiations: new InMemoryNegotiationStore(),
    delegations: new InMemoryDelegationStore(),
    matchEvents: new InMemoryMatchEventStore(),
  };
}
