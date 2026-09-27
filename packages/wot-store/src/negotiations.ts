/**
 * NegotiationStore — the durable state of the Negotiation Chambers. A chamber
 * is a two-party A2A thread of signed offers/counters over scenario-scoped
 * commitments; a valid signed ACCEPT binds the agreement (contracts 2.0.0).
 *
 * This module is a DUMB data holder — it never decides who may act (that is
 * the gateway's auth + validation edge). It keeps the offer thread, each
 * offer's lifecycle status, and the agreement receipt of a bound offer.
 *
 * All reads return DEEP COPIES so the only way to change a chamber is through
 * the explicit mutators (interface-honest: a persistent impl — transaction per
 * mutation — slots behind the same interface later, ADR-000). In-memory Maps for
 * the demo.
 */

import { newId } from './ids.ts';

/** Organizational label only — never affects binding or any oracle. */
export type NegotiationTopic = 'trade' | 'alliance' | 'truce' | 'custom';

/** Chamber lifecycle (contracts/openapi.yaml `Negotiation.status`). */
export type NegotiationStatus = 'open' | 'bound' | 'withdrawn' | 'expired';

/** A move in the thread (contracts/openapi.yaml `NegotiationOffer.action`). */
export type NegotiationOfferAction = 'offer' | 'counter' | 'accept' | 'withdraw';

/** Per-offer lifecycle (contracts/openapi.yaml `NegotiationOffer.status`). */
export type NegotiationOfferStatus =
  | 'pending'
  | 'countered'
  | 'accepted'
  | 'bound'
  | 'withdrawn'
  | 'expired';

/** One machine-checkable term (contracts/openapi.yaml `CommitmentTerm`). */
export interface NegotiationCommitmentTerm {
  /** Scenario-defined term key (data, not an enum). */
  term: string;
  args?: Record<string, string | number | boolean>;
  /** Optional expiry of this term in episode ticks. */
  until_tick?: number;
}

/** One side (give or want) of an offer (contracts/openapi.yaml `Commitment`). */
export interface NegotiationCommitment {
  terms: NegotiationCommitmentTerm[];
}

/** The receipt stamped once an accept binds an offer (`NegotiationOffer.agreement`). */
export interface NegotiationAgreement {
  boundAt: string;
  /** `sha256:<hex>` over the canonical accepted offer + both signatures. */
  agreementHash: string;
}

export interface NegotiationOfferRecord {
  offerId: string;
  fromAgentId: string;
  action: NegotiationOfferAction;
  /** The offer/counter this move answers or retracts (`ngo_…`). */
  respondTo?: string;
  /** proposer → the accepting party. */
  give?: NegotiationCommitment;
  /** the accepting party → proposer. */
  want?: NegotiationCommitment;
  status: NegotiationOfferStatus;
  expiresAt?: string;
  note?: string;
  signature?: string;
  createdAt: string;
  agreement?: NegotiationAgreement;
}

export interface NegotiationRecord {
  negotiationId: string;
  topic: NegotiationTopic;
  parties: [string, string];
  /** agent_id → owner_id (attribution; never wire-projected). */
  ownerByAgent: Record<string, string>;
  status: NegotiationStatus;
  offers: NegotiationOfferRecord[];
  createdAt: string;
  expiresAt?: string;
}

export interface CreateNegotiationInput {
  parties: [string, string];
  ownerByAgent: Record<string, string>;
  topic?: NegotiationTopic;
  at?: string;
  expiresAt?: string;
}

export interface NegotiationStore {
  /** Open a fresh two-party chamber. */
  create(input: CreateNegotiationInput): Promise<NegotiationRecord>;
  /** Read a chamber (deep copy), or null. */
  get(negotiationId: string): Promise<NegotiationRecord | null>;
  /** Append an offer/counter/accept/withdraw move; returns the updated chamber, or null. */
  addOffer(
    negotiationId: string,
    offer: NegotiationOfferRecord,
  ): Promise<NegotiationRecord | null>;
  /** Patch a single offer in the thread (status / agreement); returns the chamber, or null. */
  updateOffer(
    negotiationId: string,
    offerId: string,
    patch: Partial<Pick<NegotiationOfferRecord, 'status' | 'agreement'>>,
  ): Promise<NegotiationRecord | null>;
  /** Flip the chamber status (open → bound/withdrawn/expired); returns the chamber, or null. */
  setStatus(negotiationId: string, status: NegotiationStatus): Promise<NegotiationRecord | null>;
}

// ---------------------------------------------------------------------------
// In-memory impl
// ---------------------------------------------------------------------------

const now = (): string => new Date().toISOString();

function cloneCommitment(c?: NegotiationCommitment): NegotiationCommitment | undefined {
  return c
    ? { terms: c.terms.map((t) => ({ ...t, ...(t.args ? { args: { ...t.args } } : {}) })) }
    : undefined;
}

function cloneOffer(o: NegotiationOfferRecord): NegotiationOfferRecord {
  return {
    ...o,
    ...(o.give ? { give: cloneCommitment(o.give) } : {}),
    ...(o.want ? { want: cloneCommitment(o.want) } : {}),
    ...(o.agreement ? { agreement: { ...o.agreement } } : {}),
  };
}

function cloneRecord(r: NegotiationRecord): NegotiationRecord {
  return {
    ...r,
    parties: [r.parties[0], r.parties[1]],
    ownerByAgent: { ...r.ownerByAgent },
    offers: r.offers.map(cloneOffer),
  };
}

export class InMemoryNegotiationStore implements NegotiationStore {
  private byId = new Map<string, NegotiationRecord>();

  async create(input: CreateNegotiationInput): Promise<NegotiationRecord> {
    const record: NegotiationRecord = {
      negotiationId: newId('neg'),
      topic: input.topic ?? 'custom',
      parties: [input.parties[0], input.parties[1]],
      ownerByAgent: { ...input.ownerByAgent },
      status: 'open',
      offers: [],
      createdAt: input.at ?? now(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.byId.set(record.negotiationId, record);
    return cloneRecord(record);
  }

  async get(negotiationId: string): Promise<NegotiationRecord | null> {
    const r = this.byId.get(negotiationId);
    return r ? cloneRecord(r) : null;
  }

  async addOffer(
    negotiationId: string,
    offer: NegotiationOfferRecord,
  ): Promise<NegotiationRecord | null> {
    const r = this.byId.get(negotiationId);
    if (!r) return null;
    r.offers.push(cloneOffer(offer));
    return cloneRecord(r);
  }

  async updateOffer(
    negotiationId: string,
    offerId: string,
    patch: Partial<Pick<NegotiationOfferRecord, 'status' | 'agreement'>>,
  ): Promise<NegotiationRecord | null> {
    const r = this.byId.get(negotiationId);
    if (!r) return null;
    const offer = r.offers.find((o) => o.offerId === offerId);
    if (!offer) return null;
    if (patch.status !== undefined) offer.status = patch.status;
    if (patch.agreement !== undefined) offer.agreement = { ...patch.agreement };
    return cloneRecord(r);
  }

  async setStatus(
    negotiationId: string,
    status: NegotiationStatus,
  ): Promise<NegotiationRecord | null> {
    const r = this.byId.get(negotiationId);
    if (!r) return null;
    r.status = status;
    return cloneRecord(r);
  }
}
