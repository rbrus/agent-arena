/**
 * Negotiation Chambers — two agents open a private chamber and exchange SIGNED
 * offers with the `offer` / `counter` / `accept` / `withdraw` moves.
 *
 * Contracts 2.0.0 (ADR-001): an offer carries scenario-scoped COMMITMENTS
 * (`give`/`want` = `{ terms: [{ term, args, until_tick }] }`), not Tokens or
 * items. A valid signed `accept` BINDS the agreement: the accepted offer gets
 * `status: 'bound'` and an `agreement { bound_at, agreement_hash }`, where the
 * hash commits to the canonical accepted-offer bytes plus both parties'
 * signatures. Nothing moves on accept — there is no escrow, no ledger leg and
 * no market fill. Binding is EXACTLY-ONCE: a replayed accept of a bound offer
 * returns the chamber unchanged. All `note` text is untrusted → sanitized
 * (threat-model §0).
 *
 * The chambers are kept (decoupled from the cut Bazaar) as the base of the
 * Phase 8 B3 press layer.
 *
 * Signatures (Phase 8 B3a, closes threat-model-arena G-11 / decision S5):
 * `offer`, `counter` and `accept` carry a detached compact JWS (alg EdDSA) made
 * with the caller's PASSPORT Ed25519 key (public half resolved by agent id
 * through `NegotiationDeps.signingKeys`) over the RFC 8785 canonical form of
 * `chamberSigningPayload` (below): the chamber id binds it to one chamber, the
 * action and `respond_to` to one move, `terms_hash` to the exact give/want
 * (and, for an accept, to the exact terms of the offer being accepted). A
 * signature is verified before anything is stored; a caller with no registered
 * key cannot sign; a signature already used in the chamber cannot be replayed.
 * There is no `session` mode on this surface.
 */

import { createHash } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { jcs, sha256Tagged, verifyDetachedJws, type PassportKeyResolver } from 'wot-auth';
import { newId } from 'wot-store';
import type {
  NegotiationCommitment,
  NegotiationOfferRecord,
  NegotiationRecord,
  NegotiationStore,
  NegotiationTopic,
  Stores,
} from 'wot-store';
import { requireAgentScope } from './agent-auth.ts';
import { log, sendError } from './lib.ts';

/** Injected dependencies of the negotiation routes. */
export interface NegotiationDeps {
  stores: Stores;
  /**
   * Passport → public Ed25519 signing key (G-11). Absent: no caller has a key,
   * so every signed move is refused (fail closed).
   */
  signingKeys?: PassportKeyResolver;
}

/** A route-level failure carrying the contract error code + optional detail. */
export class NegotiationError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(description);
    this.name = 'NegotiationError';
  }
}

// ---------------------------------------------------------------------------
// Edge validation (AJV 2020-12, strict) — self-contained for the negotiation
// surface. Mirrors contracts/openapi.yaml OpenNegotiationRequest +
// NegotiationOfferRequest + Commitment/CommitmentTerm. Every agent-supplied
// field is validated here; nothing downstream trusts the raw body.
// ---------------------------------------------------------------------------

/** contracts/openapi.yaml #/components/schemas/CommitmentTerm */
const COMMITMENT_TERM = {
  type: 'object',
  additionalProperties: false,
  required: ['term'],
  properties: {
    term: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
    args: {
      type: 'object',
      maxProperties: 8,
      propertyNames: { pattern: '^[a-z][a-z0-9_]{0,31}$' },
      additionalProperties: {
        oneOf: [{ type: 'string', maxLength: 64 }, { type: 'integer' }, { type: 'boolean' }],
      },
    },
    until_tick: { type: 'integer', minimum: 0 },
  },
} as const;

/** contracts/openapi.yaml #/components/schemas/Commitment */
const COMMITMENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    terms: { type: 'array', maxItems: 20, items: COMMITMENT_TERM },
  },
} as const;

/** contracts/openapi.yaml #/components/schemas/OpenNegotiationRequest */
const openNegotiationSchema = {
  $id: 'wot:req:open_negotiation',
  type: 'object',
  additionalProperties: false,
  required: ['counterparty_agent_id'],
  properties: {
    counterparty_agent_id: { type: 'string', pattern: '^agt_[0-9A-HJKMNP-TV-Z]{26}$' },
    topic: { enum: ['trade', 'alliance', 'truce', 'custom'] },
    note: { type: 'string', maxLength: 200 },
  },
} as const;

/** contracts/openapi.yaml #/components/schemas/NegotiationOfferRequest */
const postNegotiationOfferSchema = {
  $id: 'wot:req:post_negotiation_offer',
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { enum: ['offer', 'counter', 'accept', 'withdraw'] },
    give: COMMITMENT,
    want: COMMITMENT,
    respond_to: { type: 'string', pattern: '^ngo_[0-9A-HJKMNP-TV-Z]{26}$' },
    expires_at: { type: 'string', format: 'date-time' },
    note: { type: 'string', maxLength: 200 },
    signature: { type: 'string', minLength: 16, maxLength: 512 },
  },
} as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat('date-time', (v: string) => !Number.isNaN(Date.parse(v)));
const validateOpenNegotiation: ValidateFunction = ajv.compile(openNegotiationSchema);
const validatePostNegotiationOffer: ValidateFunction = ajv.compile(postNegotiationOfferSchema);

function firstError(v: ValidateFunction): string {
  const e = v.errors?.[0];
  if (!e) return 'Invalid request body.';
  const where = e.instancePath
    ? e.instancePath.replace(/^\//, '')
    : (e.params as { missingProperty?: string })?.missingProperty ?? 'body';
  return `${where}: ${e.message ?? 'invalid'}.`;
}

// ---------------------------------------------------------------------------
// Untrusted-text pipeline + wire projections
// ---------------------------------------------------------------------------

interface OfferBody {
  action: 'offer' | 'counter' | 'accept' | 'withdraw';
  give?: NegotiationCommitment;
  want?: NegotiationCommitment;
  respond_to?: string;
  expires_at?: string;
  note?: string;
  signature?: string;
}

/** Normalize a commitment side (absent → no terms); copies, never mutates the body. */
const commitmentOf = (c?: NegotiationCommitment): NegotiationCommitment => ({
  terms: (c?.terms ?? []).map((t) => ({ ...t, ...(t.args ? { args: { ...t.args } } : {}) })),
});

/** Deterministic JSON (sorted keys) — the canonical bytes the agreement hash commits to. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * `agreement_hash` = sha256 over the canonical accepted offer (who, what, when
 * it expires) plus the offer signature and the acceptance signature. A holder
 * of the chamber record can recompute it and see exactly what was agreed.
 */
export function agreementHash(input: {
  negotiationId: string;
  offer: Pick<NegotiationOfferRecord, 'offerId' | 'fromAgentId' | 'give' | 'want' | 'expiresAt' | 'signature'>;
  acceptorAgentId: string;
  acceptSignature: string;
}): string {
  const bytes = canonicalJson({
    negotiation_id: input.negotiationId,
    offer_id: input.offer.offerId,
    from_agent_id: input.offer.fromAgentId,
    acceptor_agent_id: input.acceptorAgentId,
    give: commitmentOf(input.offer.give),
    want: commitmentOf(input.offer.want),
    expires_at: input.offer.expiresAt,
    offer_signature: input.offer.signature,
    accept_signature: input.acceptSignature,
  });
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** `sha256:` over JCS({give, want}) of a normalised commitment pair (absent side = `{terms: []}`). */
export function chamberTermsHash(give?: NegotiationCommitment, want?: NegotiationCommitment): string {
  return sha256Tagged(jcs({ give: commitmentOf(give), want: commitmentOf(want) }));
}

/**
 * The signed statement of a chamber move (JCS-canonicalised, then signed as a
 * detached EdDSA JWS by the caller's passport key):
 *   { scenario: "negotiation_chamber", negotiation_id, action, from_agent_id,
 *     respond_to, terms_hash, expires_at }
 * `terms_hash` is over the move's own give/want (offer, counter) or over the
 * accepted offer's give/want (accept). `respond_to` / `expires_at` are null when absent.
 */
export function chamberSigningPayload(input: {
  negotiationId: string;
  action: 'offer' | 'counter' | 'accept';
  fromAgentId: string;
  respondTo: string | null;
  termsHash: string;
  expiresAt: string | null;
}): Record<string, unknown> {
  return {
    scenario: 'negotiation_chamber',
    negotiation_id: input.negotiationId,
    action: input.action,
    from_agent_id: input.fromAgentId,
    respond_to: input.respondTo,
    terms_hash: input.termsHash,
    expires_at: input.expiresAt,
  };
}

/** NFKC + strip control/bidi + collapse + 200-cap (untrusted-text pipeline, threat-model §0). */
function sanitizeNote(raw: string): string {
  let out = '';
  for (const ch of raw.normalize('NFKC')) {
    const cp = ch.codePointAt(0) ?? 0;
    const stripped =
      (cp >= 0x00 && cp <= 0x1f) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0xfeff;
    if (!stripped) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function toWireOffer(o: NegotiationOfferRecord): Record<string, unknown> {
  const w: Record<string, unknown> = {
    offer_id: o.offerId,
    from_agent_id: o.fromAgentId,
    action: o.action,
    status: o.status,
    created_at: o.createdAt,
  };
  if (o.respondTo) w.respond_to = o.respondTo;
  if (o.give) w.give = o.give;
  if (o.want) w.want = o.want;
  if (o.expiresAt) w.expires_at = o.expiresAt;
  if (o.note) w.note = o.note;
  if (o.signature) w.signature = o.signature;
  if (o.agreement) {
    w.agreement = { bound_at: o.agreement.boundAt, agreement_hash: o.agreement.agreementHash };
  }
  return w;
}

function toWireNegotiation(n: NegotiationRecord): Record<string, unknown> {
  return {
    negotiation_id: n.negotiationId,
    topic: n.topic,
    parties: n.parties,
    status: n.status,
    offers: n.offers.map(toWireOffer),
    created_at: n.createdAt,
    ...(n.expiresAt ? { expires_at: n.expiresAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function attachNegotiationRoutes(app: Express, deps: NegotiationDeps): void {
  const store: NegotiationStore = deps.stores.negotiations;
  const jsonBody = express.json({ limit: '16kb' });

  // --- POST /v1/negotiations --------------------------------------------
  app.post('/v1/negotiations', requireAgentScope('negotiate:a2a'), jsonBody, async (req: Request, res: Response) => {
    const claims = res.locals.claims!;
    if (!validateOpenNegotiation(req.body)) return void sendError(res, 'invalid_request', firstError(validateOpenNegotiation));
    const body = req.body as { counterparty_agent_id: string; topic?: NegotiationTopic; note?: string };
    if (body.counterparty_agent_id === claims.agent_id) {
      return void sendError(res, 'invalid_request', 'Cannot open a Negotiation Chamber with yourself.');
    }
    const counterparty = await deps.stores.passports.getByAgentId(body.counterparty_agent_id);
    if (!counterparty) return void sendError(res, 'agent_not_found', 'No agent with that id.');

    const record = await store.create({
      parties: [claims.agent_id, body.counterparty_agent_id],
      ownerByAgent: { [claims.agent_id]: claims.owner_id, [body.counterparty_agent_id]: counterparty.ownerId },
      ...(body.topic ? { topic: body.topic } : {}),
    });
    log('info', 'negotiation_opened', {
      request_id: res.locals.requestId,
      negotiation_id: record.negotiationId,
      agent_id: claims.agent_id,
    });
    res.status(201).json(toWireNegotiation(record));
  });

  // --- GET /v1/negotiations/{id} ----------------------------------------
  app.get('/v1/negotiations/:negotiation_id', requireAgentScope('negotiate:a2a'), async (req: Request, res: Response) => {
    const claims = res.locals.claims!;
    const record = await store.get(String(req.params.negotiation_id));
    if (!record || !record.parties.includes(claims.agent_id)) {
      return void sendError(res, 'negotiation_not_found', 'No negotiation with that id.');
    }
    res.status(200).json(toWireNegotiation(record));
  });

  // --- POST /v1/negotiations/{id}/offers --------------------------------
  app.post('/v1/negotiations/:negotiation_id/offers', requireAgentScope('negotiate:a2a'), jsonBody, async (req: Request, res: Response) => {
    const claims = res.locals.claims!;
    const negotiationId = String(req.params.negotiation_id);
    const record = await store.get(negotiationId);
    if (!record || !record.parties.includes(claims.agent_id)) {
      return void sendError(res, 'negotiation_not_found', 'No negotiation with that id.');
    }
    if (!validatePostNegotiationOffer(req.body)) return void sendError(res, 'invalid_request', firstError(validatePostNegotiationOffer));
    const body = req.body as OfferBody;

    try {
      let updated: NegotiationRecord | null = null;
      const keys = deps.signingKeys ?? (() => null);
      if (body.action === 'offer') updated = await handleOffer(store, record, claims.agent_id, body, keys);
      else if (body.action === 'counter') updated = await handleCounter(store, record, claims.agent_id, body, keys);
      else if (body.action === 'withdraw') updated = await handleWithdraw(store, record, claims.agent_id, body);
      else updated = await handleAccept(store, record, claims.agent_id, body, res, keys);
      if (updated) res.status(200).json(toWireNegotiation(updated));
    } catch (err) {
      if (err instanceof NegotiationError) return void sendError(res, err.code, err.description, err.detail ? { detail: err.detail } : {});
      throw err;
    }
  });
}

// --- offer lifecycle ---------------------------------------------------------

/**
 * Real verification (G-11): the detached EdDSA JWS must verify against the
 * caller's registered passport key over `chamberSigningPayload`. Every failure
 * is the same `signature_invalid` (no oracle on which check failed).
 */
async function requireValidSignature(
  keys: PassportKeyResolver,
  record: NegotiationRecord,
  agentId: string,
  sig: string | undefined,
  what: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const fail = (): never => {
    throw new NegotiationError('signature_invalid', `A signed ${what} requires a valid passport signature.`);
  };
  if (!sig) return fail();
  // One signature, one move: a signature already used in this chamber is a replay.
  // Compared on the DECODED signature bytes (G-34): base64url has several
  // spellings of one byte string (unused low bits of the last character,
  // padding, the standard alphabet), so string equality is bypassable.
  const key64 = signatureReplayKey(sig);
  if (key64 === null) return fail();
  if (record.offers.some((o) => typeof o.signature === 'string' && signatureReplayKey(o.signature) === key64)) return fail();
  const key = await keys(agentId);
  if (!key) return fail();
  if (!verifyDetachedJws(key, sig, payload).ok) return fail();
  return sig;
}

/**
 * The replay identity of a detached JWS (`<header>..<signature>`): the
 * signature segment's bytes, re-encoded as canonical base64url without
 * padding. Standard-alphabet (`+`, `/`) and padded (`=`) spellings map to the
 * same key, and so do the non-canonical last characters Node's lenient decoder
 * accepts. `null` when the segment is not base64 at all (the caller refuses).
 * Exported for tests.
 */
export function signatureReplayKey(jws: string): string | null {
  const seg = jws.slice(jws.lastIndexOf('.') + 1).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!seg || !/^[A-Za-z0-9_-]+$/.test(seg) || seg.length % 4 === 1) return null;
  return Buffer.from(seg, 'base64url').toString('base64url');
}

/** A live (still-pending, not-expired) offer, or throw offer_conflict. */
function liveOffer(record: NegotiationRecord, offerId: string): NegotiationOfferRecord {
  const offer = record.offers.find((o) => o.offerId === offerId);
  if (!offer || offer.status !== 'pending') {
    throw new NegotiationError('offer_conflict', 'That offer is no longer live (countered, withdrawn, expired, or bound).');
  }
  return offer;
}

async function handleOffer(
  store: NegotiationStore,
  record: NegotiationRecord,
  fromAgentId: string,
  body: OfferBody,
  keys: PassportKeyResolver,
): Promise<NegotiationRecord> {
  if (record.status !== 'open') throw new NegotiationError('offer_conflict', 'The chamber is no longer open.');
  const signature = await requireValidSignature(keys, record, fromAgentId, body.signature, 'offer', chamberSigningPayload({
    negotiationId: record.negotiationId,
    action: 'offer',
    fromAgentId,
    respondTo: null,
    termsHash: chamberTermsHash(body.give, body.want),
    expiresAt: body.expires_at ?? null,
  }));
  const offer: NegotiationOfferRecord = {
    offerId: newId('ngo'),
    fromAgentId,
    action: 'offer',
    give: commitmentOf(body.give),
    want: commitmentOf(body.want),
    status: 'pending',
    ...(body.expires_at ? { expiresAt: body.expires_at } : {}),
    ...(body.note ? { note: sanitizeNote(body.note) } : {}),
    signature,
    createdAt: new Date().toISOString(),
  };
  const updated = await store.addOffer(record.negotiationId, offer);
  return updated ?? record;
}

async function handleCounter(
  store: NegotiationStore,
  record: NegotiationRecord,
  fromAgentId: string,
  body: OfferBody,
  keys: PassportKeyResolver,
): Promise<NegotiationRecord> {
  if (record.status !== 'open') throw new NegotiationError('offer_conflict', 'The chamber is no longer open.');
  if (!body.respond_to) throw new NegotiationError('invalid_request', 'counter requires respond_to.');
  const signature = await requireValidSignature(keys, record, fromAgentId, body.signature, 'counter', chamberSigningPayload({
    negotiationId: record.negotiationId,
    action: 'counter',
    fromAgentId,
    respondTo: body.respond_to,
    termsHash: chamberTermsHash(body.give, body.want),
    expiresAt: body.expires_at ?? null,
  }));
  const prior = liveOffer(record, body.respond_to);
  // You can only counter the OTHER party's live offer (not your own).
  if (prior.fromAgentId === fromAgentId) {
    throw new NegotiationError('offer_conflict', 'You cannot counter your own offer; withdraw it and post a new one.');
  }
  // Supersede the offer being answered, then append the counter (a fresh live offer).
  await store.updateOffer(record.negotiationId, prior.offerId, { status: 'countered' });
  const counter: NegotiationOfferRecord = {
    offerId: newId('ngo'),
    fromAgentId,
    action: 'counter',
    respondTo: prior.offerId,
    give: commitmentOf(body.give),
    want: commitmentOf(body.want),
    status: 'pending',
    ...(body.expires_at ? { expiresAt: body.expires_at } : {}),
    ...(body.note ? { note: sanitizeNote(body.note) } : {}),
    signature,
    createdAt: new Date().toISOString(),
  };
  const updated = await store.addOffer(record.negotiationId, counter);
  return updated ?? record;
}

async function handleWithdraw(
  store: NegotiationStore,
  record: NegotiationRecord,
  agentId: string,
  body: OfferBody,
): Promise<NegotiationRecord> {
  if (!body.respond_to) throw new NegotiationError('invalid_request', 'withdraw requires respond_to.');
  const offer = record.offers.find((o) => o.offerId === body.respond_to);
  if (!offer || offer.status !== 'pending') throw new NegotiationError('offer_conflict', 'That offer is no longer live.');
  if (offer.fromAgentId !== agentId) throw new NegotiationError('offer_conflict', 'You can only withdraw your own offer.');
  const updated = await store.updateOffer(record.negotiationId, offer.offerId, { status: 'withdrawn' });
  return updated ?? record;
}

async function handleAccept(
  store: NegotiationStore,
  record: NegotiationRecord,
  acceptorAgent: string,
  body: OfferBody,
  res: Response,
  keys: PassportKeyResolver,
): Promise<NegotiationRecord | null> {
  if (!body.respond_to) throw new NegotiationError('invalid_request', 'accept requires respond_to.');
  if (!body.signature) throw new NegotiationError('signature_invalid', 'A signed acceptance requires a valid passport signature.');
  const offer = record.offers.find((o) => o.offerId === body.respond_to);
  if (!offer) throw new NegotiationError('offer_conflict', 'No such offer.');
  // Idempotent replay: an already-bound offer just returns the current chamber
  // (nothing is stored or re-bound, so no signature is needed to observe it).
  if (offer.status === 'bound') return record;
  const acceptSignature = await requireValidSignature(keys, record, acceptorAgent, body.signature, 'acceptance', chamberSigningPayload({
    negotiationId: record.negotiationId,
    action: 'accept',
    fromAgentId: acceptorAgent,
    respondTo: offer.offerId,
    termsHash: chamberTermsHash(offer.give, offer.want),
    expiresAt: null,
  }));
  if (offer.status !== 'pending') throw new NegotiationError('offer_conflict', 'That offer is no longer live (countered, withdrawn, expired, or bound).');
  if (offer.fromAgentId === acceptorAgent) throw new NegotiationError('offer_conflict', 'You cannot accept your own offer.');
  if (offer.expiresAt && Date.parse(offer.expiresAt) <= Date.now()) {
    await store.updateOffer(record.negotiationId, offer.offerId, { status: 'expired' });
    throw new NegotiationError('offer_conflict', 'That offer has expired.');
  }

  // Bind: stamp the accepted offer with the agreement receipt and close the
  // chamber. Nothing else moves (contracts 2.0.0: no escrow, no ledger leg).
  const boundAt = new Date().toISOString();
  const hash = agreementHash({
    negotiationId: record.negotiationId,
    offer,
    acceptorAgentId: acceptorAgent,
    acceptSignature,
  });
  await store.updateOffer(record.negotiationId, offer.offerId, {
    status: 'bound',
    agreement: { boundAt, agreementHash: hash },
  });
  const updated = await store.setStatus(record.negotiationId, 'bound');

  log('info', 'negotiation_bound', {
    request_id: res.locals.requestId,
    negotiation_id: record.negotiationId,
    offer_id: offer.offerId,
    agreement_hash: hash,
  });
  return updated ?? record;
}
