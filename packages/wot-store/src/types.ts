/**
 * Storage record types + store interfaces.
 *
 * Interface-first (ADR-000): local runs use the in-memory impls in memory.ts.
 * The open core ships no cloud-database impl (ADR-003 §1); hosted persistence
 * is a Phase 9 concern on the Sixi side, behind these same interfaces.
 * Secrets are stored ONLY as their peppered HMAC hash (agent-passports.md §1, §3).
 */

import type { Ed25519PublicJwk, League } from 'wot-auth';
import type { NegotiationStore } from './negotiations.ts';
import type { DelegationStore } from './delegations.ts';
import type { MatchEventStore } from './matchevents.ts';

export type { League };

// ---------------------------------------------------------------------------
// Owners (the human-plane identity; agent-passports.md §1)
// ---------------------------------------------------------------------------

export type OwnerStatus = 'active' | 'banned';

/**
 * `owners/{owner_id}` (agent-passports.md §1, §1.1). The ONLY place the
 * Architect's identity-provider subject (`iss` + `sub` of a verified Architect
 * token) is stored — passports and access tokens carry the opaque `owner_id`,
 * never the subject. One human at one issuer ⇒ one stable owner_id, so
 * per-owner quota and ban lineage (§5.3) group every passport a human creates
 * under one record. (ADR-003 §3: the issuer is configured, not hard-wired.)
 */
export interface OwnerRecord {
  ownerId: string;
  /** The `iss` the Architect token was verified against. Never leaves the store. */
  architectIssuer: string;
  /** The verified `sub` (Architect id at that issuer). Never leaves the store. */
  architectId: string;
  status: OwnerStatus;
  createdAt: string;
}

export interface OwnerStore {
  /**
   * Resolve the stable owner for a verified Architect (`issuer`, `architectId`
   * = token `sub`), minting one on first sight (get-or-create). The same pair
   * ALWAYS returns the same `owner_id`; the same `sub` at a different issuer is
   * a different owner. Idempotent and safe to call on every authenticated request.
   */
  resolveByArchitect(issuer: string, architectId: string): Promise<OwnerRecord>;
  /** Read an owner by its opaque id (e.g. for a status/ban check). */
  getByOwnerId(ownerId: string): Promise<OwnerRecord | null>;
}

// ---------------------------------------------------------------------------
// Passports
// ---------------------------------------------------------------------------

export type PassportStatus = 'active' | 'suspended' | 'revoked';

export interface PassportRecord {
  clientId: string;
  agentId: string;
  ownerId: string;
  /** Keyed hash only; never the plaintext secret. */
  secretHash: string;
  secretVersion: number;
  status: PassportStatus;
  league: League;
  scopes: string[];
  parentAgentId: string | null;
  /**
   * Sanitized public Avatar name (untrusted-text pipeline, threat-model §0).
   * Surfaced in match summaries and webhook payloads. Optional so
   * pre-Phase-2 fixtures/tests that create a passport without a name still work.
   */
  displayName?: string;
  /**
   * (Phase 8 B3c, G-11) The passport's Ed25519 signing key for negotiation moves:
   * the PUBLIC half and its RFC 7638 thumbprint `kid` only. The private half is
   * minted by the passports service, returned to the caller once and never
   * reaches the store. Absent/null: the passport has no signing key.
   */
  signingKey?: PassportSigningKeyRecord | null;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
}

/** A passport's public signing key (never a private scalar). */
export interface PassportSigningKeyRecord {
  /** RFC 7638 thumbprint of `publicJwk`; also `publicJwk.kid`. */
  kid: string;
  publicJwk: Ed25519PublicJwk;
  createdAt: string;
  /** Set when the key is revoked (secret rotation, passport revoke, owner ban). A revoked key never resolves. */
  revokedAt: string | null;
}

export interface CreatePassportInput {
  ownerId: string;
  scopes: string[];
  league: League;
  /** Sanitized public Avatar name (see PassportRecord.displayName). */
  displayName?: string;
  /**
   * PUBLIC Ed25519 JWK to bind as the passport's signing key. The store refuses
   * anything that is not a public Ed25519 JWK (a private `d` included).
   */
  signingPublicJwk?: Ed25519PublicJwk;
}

/** Registration result — the plaintext secret is returned exactly once. */
export interface CreatePassportResult {
  clientId: string;
  agentId: string;
  secret: string;
}

export interface PassportStore {
  createPassport(input: CreatePassportInput): Promise<CreatePassportResult>;
  getByClientId(clientId: string): Promise<PassportRecord | null>;
  getByAgentId(agentId: string): Promise<PassportRecord | null>;
  /**
   * Rotate the secret; returns the new plaintext once, or null if not found. The
   * current signing key is always revoked; `signingPublicJwk`, if given, becomes
   * the new one.
   */
  rotateSecret(clientId: string, opts?: { signingPublicJwk?: Ed25519PublicJwk }): Promise<{ secret: string } | null>;
  /** Revoke a single passport (and its signing key); returns false if not found. */
  revoke(clientId: string): Promise<boolean>;
  /** Owner-level ban: voids every passport (and signing key) under the owner. Returns the count. */
  banOwner(ownerId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Tickets (matchmaking)
// ---------------------------------------------------------------------------

export type TicketStatus = 'pending' | 'assigned' | 'active' | 'closed';

export interface TicketRecord {
  ticketId: string;
  ownerId: string;
  agentId: string;
  mode: string;
  league: League;
  status: TicketStatus;
  arenaUrl: string;
  matchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTicketInput {
  ownerId: string;
  agentId: string;
  mode: string;
  league: League;
}

export interface TicketStore {
  createTicket(input: CreateTicketInput): Promise<TicketRecord>;
  getTicket(ticketId: string): Promise<TicketRecord | null>;
  /** Bind a resolved match to the ticket (and flip status to assigned). */
  bindMatch(ticketId: string, matchId: string): Promise<TicketRecord | null>;
  setStatus(ticketId: string, status: TicketStatus): Promise<TicketRecord | null>;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export type MatchLifecycle = 'pending' | 'live' | 'completed' | 'aborted';

/** Public identity + (post-match) result of one side, for the match summary. */
export interface MatchSummaryPlayer {
  player_id: 'A' | 'B';
  agent_id: string;
  display_name: string;
  result?: 'win' | 'loss' | 'draw';
}

/**
 * Match record. Written `live` at match start and merged to `completed` (or
 * `aborted`) at match end; read by `GET /v1/matches/{match_id}`. Kept OPEN
 * (index signature) so the arena's terminal write type-checks; the named fields
 * are the public summary projection (grid-tactics §7.4, §9).
 */
export interface MatchSummary {
  matchId: string;
  mode?: 'duel';
  league?: League;
  status?: MatchLifecycle;
  players?: MatchSummaryPlayer[];
  /** Current sim tick (live matches). */
  tick?: number;
  ticks_remaining?: number;
  /** Both Ascension scores (the 30-second readout). */
  scores?: { A: number; B: number };
  started_at?: string;
  ended_at?: string;
  winner?: 'A' | 'B' | 'draw';
  reason?: string;
  final_scores?: { A: number; B: number };
  tokens_remaining?: { A: number; B: number };
  ticks_played?: number;
  seed?: number;
  replay_id?: string;
  replay_hash?: string;
  resim_ok?: boolean;
  [key: string]: unknown;
}

export interface MatchStore {
  /** Full upsert of a summary keyed by matchId. */
  saveSummary(summary: MatchSummary): Promise<void>;
  /** Shallow-merge a patch into an existing summary (no-op if absent). */
  updateSummary(matchId: string, patch: Partial<MatchSummary>): Promise<void>;
  getSummary(matchId: string): Promise<MatchSummary | null>;
}

// ---------------------------------------------------------------------------
// Webhooks (Phase 2 — Architect-side event notifications, contracts/webhooks.md)
// ---------------------------------------------------------------------------

export type WebhookEventType = 'match.found' | 'match.end';
export type WebhookStatus = 'active' | 'disabled';

export interface WebhookRecord {
  webhookId: string;
  ownerId: string;
  url: string;
  events: WebhookEventType[];
  /**
   * The HMAC signing key (`whsec_…`). The platform MUST retain it to sign
   * deliveries (`WoT-Signature`), so — unlike a passport secret — it cannot be a
   * one-way hash: consumer-side verification recomputes HMAC with the SAME key.
   * A production impl would keep it encrypted at rest (KMS). It is NEVER returned
   * by any read API and NEVER logged (webhooks.md §4; the log helpers redact it).
   */
  signingSecret: string;
  secretVersion: number;
  status: WebhookStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookInput {
  ownerId: string;
  url: string;
  events: WebhookEventType[];
}

/** Registration result — the plaintext signing secret is returned exactly once. */
export interface CreateWebhookResult {
  record: WebhookRecord;
  signingSecret: string;
}

export interface WebhookStore {
  create(input: CreateWebhookInput): Promise<CreateWebhookResult>;
  getById(webhookId: string): Promise<WebhookRecord | null>;
  /** The caller-facing list for one owner (never includes the secret upstream). */
  listByOwner(ownerId: string): Promise<WebhookRecord[]>;
  /** Active registrations for one owner subscribed to `event` (delivery fan-out). */
  listForDelivery(ownerId: string, event: WebhookEventType): Promise<WebhookRecord[]>;
  /** Delete; returns false if not found. */
  delete(webhookId: string): Promise<boolean>;
  /** Rotate the signing secret; returns the new plaintext once, or null. */
  rotate(webhookId: string): Promise<{ signingSecret: string } | null>;
  /** Flip status (e.g. auto-disable after a sustained delivery-failure streak). */
  setStatus(webhookId: string, status: WebhookStatus): Promise<WebhookRecord | null>;
}

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------

export interface SaveReplayInput {
  seed: number;
  inputs: unknown;
  tickLog: unknown;
  hash: string;
  matchId?: string;
}

export interface ReplayRecord {
  replayId: string;
  matchId: string | null;
  seed: number;
  inputs: unknown;
  tickLog: unknown;
  hash: string;
  createdAt: string;
}

export interface ReplayStore {
  saveReplay(input: SaveReplayInput): Promise<ReplayRecord>;
  getReplay(replayId: string): Promise<ReplayRecord | null>;
}

// ---------------------------------------------------------------------------
// Budget ledger (ADR-001: the Token ledger survives ONLY as budget accounting)
// ---------------------------------------------------------------------------
// Storage records + interface only; the budget operations live in `wot-ledger`,
// which posts BALANCED journals here. Balances are DERIVED by folding legs —
// never a stored mutable integer. Every leg carries a signed integer amount
// (credit +, debit −); Σ over a journal's legs == 0. A seat's allowance is
// granted ONLY from the budget faucet and consumed ONLY into the consumption
// sink, and every journal references the episode (and tick) it accounts for.

/** Journal-entry category: an allowance grant, or per-tick consumption. */
export type LedgerEntryType = 'grant' | 'consume';

/** The domain object a journal references: always an episode. */
export type LedgerRefKind = 'episode';

export interface LedgerRef {
  kind: LedgerRefKind;
  /** The episode this journal accounts for (a duel's `mat_…`, a raid's `rad_…`, an eval `epi_…`). */
  episode_id: string;
  /** The tick the charge was incurred on (0 for the start-of-episode grant). */
  tick: number;
  /** The seat (`A`/`B`, `m0`..`m4`) whose allowance moved. */
  seat?: string;
}

/**
 * Account taxonomy. The account-id grammar is `<kind>:<local>`:
 *   budget:<episode_id>/<seat> — one seat's remaining allowance in one episode;
 *                                never negative (an overspend is refused).
 *   faucet:<class>             — the only grant source (`faucet:budget`); ≤ 0.
 *   sink:<class>               — the only consumption destination (`sink:consumed`); ≥ 0.
 */
export type LedgerAccountKind = 'budget' | 'faucet' | 'sink';

/** One unposted leg of a journal (signed integer units; Pillar 9 — integers only). */
export interface JournalLegInput {
  account: string;
  amount: number;
  type: LedgerEntryType;
  memo?: string;
}

/** A balanced journal to post atomically. `ts` is passed in (no Date.now in pure paths). */
export interface PostJournalInput {
  /** ISO-8601 timestamp, passed in by the caller. Store stamps `now()` only if absent. */
  ts?: string;
  ref: LedgerRef;
  /** Dedup key — a re-post with the same key applies ONCE (exactly-once). */
  idempotencyKey: string;
  legs: JournalLegInput[];
  memo?: string;
}

/** A committed leg, with its assigned ids and derived running balance. */
export interface PostedLeg {
  entryId: string;
  journalId: string;
  ts: string;
  account: string;
  amount: number;
  type: LedgerEntryType;
  /** DERIVED running balance of `account` after this leg (never stored authoritatively). */
  balanceAfter: number;
  ref: LedgerRef;
  memo?: string;
}

/** A committed journal transaction (its legs share `journalId`; Σ amount == 0). */
export interface PostedJournal {
  journalId: string;
  ts: string;
  ref: LedgerRef;
  idempotencyKey: string;
  legs: PostedLeg[];
  memo?: string;
  /** True when this call was an idempotent replay (returned the original, applied nothing). */
  deduped: boolean;
}

export interface LedgerQuery {
  cursor?: string;
  limit?: number;
  type?: LedgerEntryType;
}

/**
 * Accounts + append-only journal. In-memory for the sandbox; a durable impl
 * (transactions + idempotency-key doc) slots behind the SAME interface later
 * (ADR-000). `post` is atomic + exactly-once; all balances are derived folds.
 */
export interface LedgerStore {
  /** Post a balanced journal atomically. Re-posting the same key returns the original (deduped). */
  post(input: PostJournalInput): Promise<PostedJournal>;
  /** Derived balance of any account = Σ its legs. Never a stored mutable integer. */
  balanceOf(account: string): Promise<number>;
  /** Raw committed legs for an account, newest-first, paginated. */
  entriesFor(
    account: string,
    query?: LedgerQuery,
  ): Promise<{ entries: PostedLeg[]; nextCursor: string | null }>;
  /** Audit: the whole append-only journal (oldest-first). */
  allJournals(): Promise<PostedJournal[]>;
  /** Audit: every account that has ever had a leg. */
  accounts(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Match finish record — what the arena hands its finish hooks at match end.
// Everything here is derivable from the hash-committed match record. (Moved
// here from the cut quests module, Phase 7 B0-11.)
// ---------------------------------------------------------------------------

/** One agent side's per-frame reliability tally (from committed decision frames). */
export interface MatchSideReliability {
  frames: number;
  onTime: number;
  softMisses: number;
  hardMisses: number;
  forfeit: boolean;
  latencyMs?: number[];
}

/** One AGENT side of a finished match (house-bot sides are omitted — no owner). */
export interface MatchAgentSide {
  playerId: 'A' | 'B';
  agentId: string;
  ownerId: string;
  displayName?: string;
  result: 'win' | 'loss' | 'draw';
  /** Action tokens spent (league allowance − remaining). */
  tokensSpent: number;
  /** True if this side's opponent was a house bot. */
  opponentIsHouseBot: boolean;
  /** Enemy units this agent eliminated this match. */
  kills: number;
  /** Ticks this agent held the Nexus this match. */
  nexusTicksHeld: number;
  reliability?: MatchSideReliability;
}

/** A finished, hash-committed match record, handed to match-finish hooks. */
export interface MatchFinishRecord {
  matchId: string;
  league: League;
  mode: 'duel';
  /** Result integrity verdict (re-sim ok). */
  verified: boolean;
  winner: 'A' | 'B' | 'draw';
  reason: string;
  ticksPlayed: number;
  endedAt: string;
  replayId?: string;
  /** Agent sides only (bot sides carry no owner / quests). */
  sides: MatchAgentSide[];
}

// ---------------------------------------------------------------------------
// Factory bundle
// ---------------------------------------------------------------------------

export interface Stores {
  owners: OwnerStore;
  passports: PassportStore;
  tickets: TicketStore;
  matches: MatchStore;
  replays: ReplayStore;
  webhooks: WebhookStore;
  ledger: LedgerStore;
  negotiations: NegotiationStore; // Phase 4 B3 — Negotiation Chambers (the Pact)
  delegations: DelegationStore; // Phase 4 B1 — delegated squad-token grants + jti denylist
  matchEvents: MatchEventStore; // Phase 5 B5 — durable per-tick log + lifecycle manifest (recoverable match state)
}

export interface CreateStoresOptions {
  /** Base WSS URL used to build ticket `arenaUrl`s. */
  arenaBaseUrl?: string;
}
