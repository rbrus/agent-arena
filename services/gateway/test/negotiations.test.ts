/**
 * Negotiation Chambers (contracts 2.0.0) — offers carry scenario-scoped
 * commitments; a signed accept BINDS the agreement. The cases:
 *   - a signed offer + signed accept binds: the offer is `bound`, the chamber is
 *     `bound`, and `agreement.agreement_hash` recomputes from the canonical
 *     accepted offer + both signatures (and changes if either signature does);
 *   - a `counter` supersedes the offer it answers and binds; the superseded
 *     (stale) offer id can NO LONGER bind;
 *   - a double-accept / replay binds EXACTLY ONCE (same receipt, one bind);
 *   - a WITHDRAWN offer cannot bind; an EXPIRED offer cannot bind;
 *   - the removed 1.x OfferBundle shape (tokens/items) is rejected at the edge;
 *   - accepting your own offer, or an unsigned accept, is rejected.
 * G-11 (Phase 8 B3a): signatures are detached EdDSA JWS by the caller's passport
 * key over `chamberSigningPayload`; forged, replayed (across chambers and within
 * one), tampered-terms and key-less signatures are refused; the old length check
 * is gone (a long random string is no signature).
 * Nothing on this surface touches a ledger (the Bazaar escrow was cut, B0-16).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NegotiationCommitment } from 'wot-store';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-neg-keys-'));

const { createStores } = await import('wot-store');
const { mintAccessToken, mintPassportSigningKey, PassportKeyRegistry, signDetachedJws } = await import('wot-auth');
const { attachNegotiationRoutes, agreementHash, chamberSigningPayload, chamberTermsHash, signatureReplayKey } = await import('../src/negotiations.ts');
const { requestContext, notFound, errorHandler } = await import('../src/lib.ts');

type Stores = Awaited<ReturnType<typeof createStores>>;
type SigningKey = ReturnType<typeof mintPassportSigningKey>;
type Commitment = NegotiationCommitment;

let server: http.Server;
let base: string;
let stores: Stores;
let keys: InstanceType<typeof PassportKeyRegistry>;

interface Party {
  agentId: string;
  ownerId: string;
  token: string;
  signing: SigningKey;
}

/** Build a party with a real passport (so counterparty lookup works), a token and a registered signing key. */
async function party(scope = ['negotiate:a2a'], register = true): Promise<Party> {
  const created = await stores.passports.createPassport({ ownerId: `own_${Math.random().toString(36).slice(2, 8)}`, scopes: scope, league: 'core' });
  const passport = await stores.passports.getByAgentId(created.agentId);
  const token = await mintAccessToken({
    ownerId: passport!.ownerId,
    agentId: created.agentId,
    clientId: created.clientId,
    league: 'core',
    scope,
  });
  const signing = mintPassportSigningKey();
  if (register) keys.register(created.agentId, signing.publicJwk);
  return { agentId: created.agentId, ownerId: passport!.ownerId, token, signing };
}

async function startServer() {
  const app = express();
  app.use(requestContext);
  attachNegotiationRoutes(app, { stores, signingKeys: keys.resolver });
  app.use(notFound);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
}

beforeEach(() => {
  stores = createStores();
  keys = new PassportKeyRegistry();
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

async function openNegotiation(token: string, counterparty: string, topic?: string) {
  const res = await fetch(`${base}/v1/negotiations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ counterparty_agent_id: counterparty, ...(topic ? { topic } : {}), note: 'Truce until tick 40?' }),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

async function postOffer(token: string, negId: string, body: unknown) {
  const res = await fetch(`${base}/v1/negotiations/${negId}/offers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

interface MoveBody {
  action: 'offer' | 'counter' | 'accept';
  give?: Commitment;
  want?: Commitment;
  respond_to?: string;
  expires_at?: string;
  note?: string;
}

/** The caller's detached EdDSA JWS over the chamber payload (`accepted` = the terms being accepted). */
function sign(p: Party, negId: string, body: MoveBody, accepted?: { give?: Commitment; want?: Commitment }, key: SigningKey = p.signing): string {
  const termsHash = body.action === 'accept' ? chamberTermsHash(accepted?.give, accepted?.want) : chamberTermsHash(body.give, body.want);
  return signDetachedJws(
    key.privateJwk,
    chamberSigningPayload({
      negotiationId: negId,
      action: body.action,
      fromAgentId: p.agentId,
      respondTo: body.action === 'offer' ? null : (body.respond_to ?? null),
      termsHash,
      expiresAt: body.action === 'accept' ? null : (body.expires_at ?? null),
    }),
    { kid: key.privateJwk.kid },
  );
}

/** Post a correctly signed move and return the response plus the signature used. */
async function signed(p: Party, negId: string, body: MoveBody, accepted?: { give?: Commitment; want?: Commitment }) {
  const signature = sign(p, negId, body, accepted);
  return { ...(await postOffer(p.token, negId, { ...body, signature })), signature };
}

type WireOffer = Record<string, unknown>;
const offersOf = (chamber: Record<string, unknown>) => chamber.offers as WireOffer[];

const GIVE = { terms: [{ term: 'non_aggression', args: { toward: 'B' }, until_tick: 40 }] };
const WANT = { terms: [{ term: 'non_aggression', args: { toward: 'A' }, until_tick: 40 }, { term: 'share_observation' }] };

test('offer + accept binds the agreement with a recomputable agreement_hash', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();

  const opened = await openNegotiation(alice.token, bob.agentId, 'truce');
  assert.equal(opened.res.status, 201);
  assert.equal(opened.json.topic, 'truce');
  const negId = opened.json.negotiation_id as string;

  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const offered = await signed(alice, negId, { action: 'offer', give: GIVE, want: WANT, expires_at: expiresAt });
  assert.equal(offered.res.status, 200);
  const offer = offersOf(offered.json)[0];
  const offerId = offer.offer_id as string;
  assert.match(offerId, /^ngo_/);
  assert.deepEqual(offer.give, GIVE);
  assert.deepEqual(offer.want, WANT);
  assert.equal(offer.signature, offered.signature);

  const accepted = await signed(bob, negId, { action: 'accept', respond_to: offerId }, { give: GIVE, want: WANT });
  assert.equal(accepted.res.status, 200);
  assert.equal(accepted.json.status, 'bound');
  const bound = offersOf(accepted.json).find((o) => o.offer_id === offerId)!;
  assert.equal(bound.status, 'bound');
  const agreement = bound.agreement as { bound_at: string; agreement_hash: string };
  assert.match(agreement.agreement_hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(agreement.bound_at)));
  assert.equal('settlement' in bound, false, 'the 1.x ledger settlement object is gone');

  // The receipt recomputes from the canonical accepted offer + both signatures.
  const recomputed = agreementHash({
    negotiationId: negId,
    offer: { offerId, fromAgentId: alice.agentId, give: GIVE, want: WANT, expiresAt, signature: offered.signature },
    acceptorAgentId: bob.agentId,
    acceptSignature: accepted.signature,
  });
  assert.equal(agreement.agreement_hash, recomputed);
  const otherSig = agreementHash({
    negotiationId: negId,
    offer: { offerId, fromAgentId: alice.agentId, give: GIVE, want: WANT, expiresAt, signature: offered.signature },
    acceptorAgentId: bob.agentId,
    acceptSignature: 'sig_forged_0123456789',
  });
  assert.notEqual(otherSig, recomputed, 'the hash commits to the acceptance signature');

  // A bound chamber accepts no further offers.
  const late = await signed(alice, negId, { action: 'offer', give: GIVE });
  assert.equal(late.res.status, 409);
  assert.equal(late.json.error, 'offer_conflict');
});

test('topic defaults to custom', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const opened = await openNegotiation(alice.token, bob.agentId);
  assert.equal(opened.json.topic, 'custom');
});

test('a counter supersedes the offer it answers; the stale offer can no longer bind', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const negId = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;

  const offered = await signed(alice, negId, { action: 'offer', give: GIVE, want: WANT });
  const offer1 = offersOf(offered.json)[0].offer_id as string;

  // Bob counters with a narrower ask.
  const counterGive = { terms: [{ term: 'non_aggression', args: { toward: 'A' }, until_tick: 20 }] };
  const counterWant = { terms: [{ term: 'non_aggression', args: { toward: 'B' }, until_tick: 20 }] };
  const countered = await signed(bob, negId, { action: 'counter', respond_to: offer1, give: counterGive, want: counterWant });
  assert.equal(countered.res.status, 200);
  const wire1 = offersOf(countered.json).find((o) => o.offer_id === offer1)!;
  assert.equal(wire1.status, 'countered', 'the answered offer must be superseded');
  const counterId = offersOf(countered.json).find((o) => o.action === 'counter')!.offer_id as string;

  // The STALE (superseded) offer cannot bind.
  const staleAccept = await signed(bob, negId, { action: 'accept', respond_to: offer1 }, { give: GIVE, want: WANT });
  assert.equal(staleAccept.res.status, 409);
  assert.equal(staleAccept.json.error, 'offer_conflict');

  // You cannot counter your own offer.
  const selfCounter = await signed(bob, negId, { action: 'counter', respond_to: counterId, give: GIVE });
  assert.equal(selfCounter.res.status, 409);

  // Alice accepts Bob's live counter → bound.
  const accepted = await signed(alice, negId, { action: 'accept', respond_to: counterId }, { give: counterGive, want: counterWant });
  assert.equal(accepted.res.status, 200);
  assert.equal(accepted.json.status, 'bound');
  assert.equal(offersOf(accepted.json).find((o) => o.offer_id === counterId)!.status, 'bound');
});

test('a double-accept / replay binds EXACTLY ONCE (idempotent receipt)', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const negId = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;
  const offered = await signed(alice, negId, { action: 'offer', give: GIVE, want: WANT });
  const offerId = offersOf(offered.json)[0].offer_id as string;

  const first = await signed(bob, negId, { action: 'accept', respond_to: offerId }, { give: GIVE, want: WANT });
  assert.equal(first.res.status, 200);
  const second = await postOffer(bob.token, negId, { action: 'accept', respond_to: offerId, signature: first.signature });
  assert.equal(second.res.status, 200);
  assert.equal(second.json.status, 'bound');

  const h1 = (offersOf(first.json).find((o) => o.offer_id === offerId)!.agreement as { agreement_hash: string }).agreement_hash;
  const h2 = (offersOf(second.json).find((o) => o.offer_id === offerId)!.agreement as { agreement_hash: string }).agreement_hash;
  assert.equal(h2, h1, 'a replayed accept must not re-bind or rewrite the receipt');
});

test('a withdrawn offer cannot bind; an expired offer cannot bind', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const negId = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;

  const offered = await signed(alice, negId, { action: 'offer', give: GIVE, want: WANT });
  const offerId = offersOf(offered.json)[0].offer_id as string;

  // Bob cannot withdraw Alice's offer; Alice can.
  const notMine = await postOffer(bob.token, negId, { action: 'withdraw', respond_to: offerId });
  assert.equal(notMine.res.status, 409);
  const withdrawn = await postOffer(alice.token, negId, { action: 'withdraw', respond_to: offerId });
  assert.equal(withdrawn.res.status, 200);
  assert.equal(offersOf(withdrawn.json).find((o) => o.offer_id === offerId)!.status, 'withdrawn');

  const accepted = await signed(bob, negId, { action: 'accept', respond_to: offerId }, { give: GIVE, want: WANT });
  assert.equal(accepted.res.status, 409);
  assert.equal(accepted.json.error, 'offer_conflict');

  // An offer whose expires_at has passed flips to expired on accept.
  const stale = await signed(alice, negId, { action: 'offer', give: GIVE, expires_at: new Date(Date.now() - 1000).toISOString() });
  const staleId = offersOf(stale.json).find((o) => o.status === 'pending')!.offer_id as string;
  const lateAccept = await signed(bob, negId, { action: 'accept', respond_to: staleId }, { give: GIVE });
  assert.equal(lateAccept.res.status, 409);
  const chamber = (await (await fetch(`${base}/v1/negotiations/${negId}`, { headers: { authorization: `Bearer ${bob.token}` } })).json()) as Record<string, unknown>;
  assert.equal(offersOf(chamber).find((o) => o.offer_id === staleId)!.status, 'expired');
  assert.equal(chamber.status, 'open');
});

test('the removed 1.x OfferBundle shape, self-accept and unsigned moves are rejected', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const negId = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;

  // Tokens + items (OfferBundle) no longer validate.
  const legacy = await postOffer(alice.token, negId, {
    action: 'offer',
    give: { tokens: 0, items: [{ instrument: 'adapter:oracle_lens', quantity: 1 }] },
    want: { tokens: 100, items: [] },
    signature: 'x'.repeat(40),
  });
  assert.equal(legacy.res.status, 400);
  assert.equal(legacy.json.error, 'invalid_request');

  // A malformed term key is rejected at the edge.
  const badTerm = await postOffer(alice.token, negId, { action: 'offer', give: { terms: [{ term: 'Not A Key' }] }, signature: 'x'.repeat(40) });
  assert.equal(badTerm.res.status, 400);

  // Unsigned offer → signature_invalid.
  const unsigned = await postOffer(alice.token, negId, { action: 'offer', give: GIVE });
  assert.equal(unsigned.res.status, 422);
  assert.equal(unsigned.json.error, 'signature_invalid');

  const offered = await signed(alice, negId, { action: 'offer', give: GIVE });
  const offerId = offersOf(offered.json)[0].offer_id as string;
  const selfAccept = await signed(alice, negId, { action: 'accept', respond_to: offerId }, { give: GIVE });
  assert.equal(selfAccept.res.status, 409);
  const unsignedAccept = await postOffer(bob.token, negId, { action: 'accept', respond_to: offerId });
  assert.equal(unsignedAccept.res.status, 422);
});

test('G-11: forged, cross-chamber replay, in-chamber replay, tampered terms, length-only and key-less signatures are refused; valid is accepted', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const mallory = await party();
  const keyless = await party(['negotiate:a2a'], false);
  const neg1 = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;
  const neg2 = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;

  const refuse = async (token: string, negId: string, body: unknown, why: string) => {
    const r = await postOffer(token, negId, body);
    assert.equal(r.res.status, 422, why);
    assert.equal(r.json.error, 'signature_invalid', why);
  };
  const offer: MoveBody = { action: 'offer', give: GIVE, want: WANT };

  // The old structural check accepted any ≥ 16-char string; it is gone.
  await refuse(alice.token, neg1, { ...offer, signature: 'sig_alice_0123456789abcdef' }, 'length-only string');
  // Forged: Mallory's key signing Alice's statement.
  await refuse(alice.token, neg1, { ...offer, signature: sign(alice, neg1, offer, undefined, mallory.signing) }, 'forged by another key');
  // Tampered terms: signed GIVE, sent a different give.
  await refuse(alice.token, neg1, { ...offer, give: { terms: [{ term: 'non_aggression', args: { toward: 'B' }, until_tick: 400 }] }, signature: sign(alice, neg1, offer) }, 'tampered clause');
  // Re-attributed: Bob posts Alice's valid signature as his own.
  await refuse(bob.token, neg1, { ...offer, signature: sign(alice, neg1, offer) }, 're-attributed');
  // A passport with no registered signing key cannot sign at all.
  const neg3 = (await openNegotiation(keyless.token, bob.agentId)).json.negotiation_id as string;
  await refuse(keyless.token, neg3, { ...offer, signature: sign(keyless, neg3, offer) }, 'no registered key');

  // Valid → accepted.
  const valid = await signed(alice, neg1, offer);
  assert.equal(valid.res.status, 200);
  // Replayed into another chamber (the chamber id is in the signed payload).
  await refuse(alice.token, neg2, { ...offer, signature: valid.signature }, 'cross-chamber replay');
  // Replayed within the same chamber (one signature, one move).
  await refuse(alice.token, neg1, { ...offer, signature: valid.signature }, 'in-chamber replay');

  // The acceptor signs the exact terms it accepts: an accept over other terms does not verify.
  const offerId = offersOf(valid.json)[0].offer_id as string;
  await refuse(bob.token, neg1, { action: 'accept', respond_to: offerId, signature: sign(bob, neg1, { action: 'accept', respond_to: offerId }, { give: GIVE }) }, 'accept over other terms');
  // An accept signature minted for another offer id does not bind this one.
  await refuse(bob.token, neg1, { action: 'accept', respond_to: offerId, signature: sign(bob, neg1, { action: 'accept', respond_to: 'ngo_01J9ZZZZZZZZZZZZZZZZZZZZZZ' }, { give: GIVE, want: WANT }) }, 'accept for another offer');
  const ok = await signed(bob, neg1, { action: 'accept', respond_to: offerId }, { give: GIVE, want: WANT });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.json.status, 'bound');
});

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Every other spelling of the same signature bytes: flipped unused low bits, padding, the standard alphabet. */
function reEncodings(jws: string): { label: string; sig: string }[] {
  const dot = jws.lastIndexOf('.');
  const head = jws.slice(0, dot + 1);
  const seg = jws.slice(dot + 1);
  const i = B64URL.indexOf(seg.at(-1)!);
  const lowBits = [0, 1, 2, 3].map((b) => B64URL[(i & ~3) | b]).filter((c) => c !== seg.at(-1)).map((c, k) => ({ label: `unused low bits #${k}`, sig: head + seg.slice(0, -1) + c }));
  const std = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (seg.length % 4)) % 4);
  return [...lowBits, { label: 'padded', sig: head + seg + pad }, { label: 'standard alphabet, padded', sig: head + std + pad }];
}

test('G-34: signatureReplayKey maps every spelling of one signature to the same bytes', () => {
  const alice = mintPassportSigningKey();
  const jws = signDetachedJws(alice.privateJwk, { scenario: 'negotiation_chamber', probe: 1 }, { kid: alice.privateJwk.kid });
  const k = signatureReplayKey(jws);
  assert.ok(k && k.length === 86, 'an Ed25519 signature is 64 bytes (86 base64url chars)');
  for (const v of reEncodings(jws)) assert.equal(signatureReplayKey(v.sig), k, v.label);
  assert.equal(signatureReplayKey('eyJhbGciOiJFZERTQSJ9..!!!not-base64'), null);
  assert.equal(signatureReplayKey('eyJhbGciOiJFZERTQSJ9..'), null);
});

test('G-34: a re-encoded copy of a used signature cannot revive a withdrawn offer (replay guard compares decoded bytes)', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const negId = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;
  const offer: MoveBody = { action: 'offer', give: GIVE, want: WANT };
  const first = await signed(alice, negId, offer);
  assert.equal(first.res.status, 200);
  const offerId = offersOf(first.json)[0].offer_id as string;
  const withdrawn = await postOffer(alice.token, negId, { action: 'withdraw', respond_to: offerId });
  assert.equal(withdrawn.res.status, 200);
  for (const v of reEncodings(first.signature)) {
    const r = await postOffer(alice.token, negId, { ...offer, signature: v.sig });
    assert.equal(r.res.status, 422, `${v.label}: a re-encoded copy of a used signature was accepted`);
    assert.equal(r.json.error, 'signature_invalid', v.label);
  }
});

test('self-negotiation and non-party access are rejected', async () => {
  await startServer();
  const alice = await party();
  const bob = await party();
  const carol = await party(); // not a party to Alice↔Bob

  // Self-chamber → 400.
  const selfRes = await fetch(`${base}/v1/negotiations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ counterparty_agent_id: alice.agentId }),
  });
  assert.equal(selfRes.status, 400);

  // A third party cannot read the chamber (404, not an enumeration oracle).
  const negId = (await openNegotiation(alice.token, bob.agentId)).json.negotiation_id as string;
  const readRes = await fetch(`${base}/v1/negotiations/${negId}`, {
    headers: { authorization: `Bearer ${carol.token}` },
  });
  assert.equal(readRes.status, 404);
});
