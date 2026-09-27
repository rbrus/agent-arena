/**
 * Phase 8 B3c: passport signing keys end to end on the Diplomacy plane.
 *
 *  - the key a passport signs with is the one `POST /v1/agents` minted (the harness
 *    registers every seat through the real passports routes); the arena resolves
 *    it from the store, never from a test-only registry;
 *  - `POST /v1/agents/{client_id}/rotate` revokes that key and returns a new one:
 *    after the seat reconnects, a move signed with the OLD key is `signature_invalid`
 *    (kid_mismatch) and a move signed with the NEW key is delivered in key mode;
 *  - (contracts 2.4.0, signing.md §7.5) rotation DURING a live table, without a reconnect: the
 *    arena re-resolves the seat's key for every signed move, so the next move signed with the
 *    OLD key is refused `signature_invalid` and a move signed with the NEW key binds in key mode;
 *  - `DELETE /v1/agents/{client_id}` revokes it: the resolver returns nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPressMove, type Ed25519PrivateJwk, type PassportSigningKey } from 'wot-auth';
import { POWERS, type Power } from 'wot-engine';
import type { DipSeatSpec } from '../src/diplomacy/table.ts';
import { dipHello, dipPassport, DipWireAgent, setupDip, signingKeyFromRegistration } from './diplomacy-helpers.ts';

type Frame = Record<string, unknown>;
const seatsWith = (agents: Partial<Record<Power, string>>): Record<Power, DipSeatSpec> =>
  Object.fromEntries(POWERS.map((p) => [p, agents[p] ? { kind: 'agent', agentId: agents[p]! } : { kind: 'house' }])) as Record<Power, DipSeatSpec>;
const echo = (o: Frame, power: Power, extra: Frame = {}): Frame => ({
  t: 'diplomacy_action',
  protocol_version: '1.0',
  episode_id: o.episode_id,
  turn_id: o.turn_id,
  nonce: o.nonce,
  power,
  ...extra,
});
const DMZ = { give: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: 'S1901M', provinces: ['bur'] }], want: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: 'S1901M', provinces: ['bur'] }] };
const toGermany = { kind: 'private', power: 'germany' };
const signOffer = (key: PassportSigningKey, episodeId: string, seq: number, round = 1): string =>
  signPressMove(key, { episodeId, msgIdExpected: `prs:S1901M:r${round}:france:${seq}`, from: 'france', to: toGermany, move: 'offer', respondTo: null, terms: DMZ });

test('registration-minted key: the store resolver returns exactly its public half (no private member)', async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    const resolved = await h.keys(fr.agentId);
    assert.ok(resolved);
    assert.equal(resolved.kid, fr.signing!.jkt);
    assert.equal(resolved.x, fr.signing!.publicJwk.x);
    assert.ok(!('d' in resolved));
    const record = await h.stores.passports.getByAgentId(fr.agentId);
    assert.ok(!JSON.stringify(record).includes(fr.signing!.privateJwk.d), 'the private scalar never reaches the store');
  } finally {
    await h.close();
  }
});

test('rotation revokes the passport key on the arena: old-key moves are refused after reconnect, new-key moves bind in key mode', async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    const ge = await dipPassport(h);
    const oldKey = fr.signing!;

    const rot = await fetch(`${h.httpUrl}/v1/agents/${fr.clientId}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${fr.ownerBearer}` } });
    assert.equal(rot.status, 200);
    assert.equal(rot.headers.get('cache-control'), 'no-store');
    const rotated = (await rot.json()) as { client_secret: string; signing_key: Ed25519PrivateJwk };
    const newKey = signingKeyFromRegistration(rotated.signing_key);
    assert.notEqual(newKey.jkt, oldKey.jkt);
    assert.equal((await h.keys(fr.agentId))?.kid, newKey.jkt, 'the resolver serves the new key only');
    const rec = await h.stores.passports.getByAgentId(fr.agentId);
    assert.equal(rec?.signingKey?.kid, newKey.jkt);

    // A fresh token from the rotated secret (the old access token is still live until exp; either works for hello).
    const tok = await fetch(`${h.httpUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: fr.clientId, client_secret: rotated.client_secret, scope: 'negotiate:a2a' }).toString(),
    });
    assert.equal(tok.status, 200);
    const frToken = ((await tok.json()) as { access_token: string }).access_token;

    const table = h.arena.diplomacy.createTable({ seed: 11, horizonYear: 1901, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }) });
    const A = new DipWireAgent(h.url, 'france', null);
    const B = new DipWireAgent(h.url, 'germany', null);
    await Promise.all([A.open(), B.open()]);
    A.send(dipHello(frToken, table.tableId));
    B.send(dipHello(ge.token, table.tableId));
    assert.ok(((await A.waitFor((f) => f.t === 'ack')).signature_modes as string[]).includes('key'));
    const nextObs = (a: DipWireAgent, turn: number) => a.waitFor((f) => f.t === 'diplomacy_observation' && f.turn_id === turn, 15_000);
    const [a0, b0] = await Promise.all([nextObs(A, 0), nextObs(B, 0)]);
    A.send(echo(a0, 'france'));
    B.send(echo(b0, 'germany'));
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    const ep = table.episodeId;
    A.send(echo(a1, 'france', { press: [
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(oldKey, ep, 1) }, // revoked key
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(newKey, ep, 2) }, // rotated key
    ] }));
    B.send(echo(b1, 'germany'));
    const a2 = await nextObs(A, 2);
    assert.deepEqual((a2.press_rejects as Frame[]).map((r) => [r.msg_index, r.code]), [[0, 'signature_invalid']]);
    assert.deepEqual((a2.sent as Frame[]).map((m) => [m.seq, m.sig_mode]), [[2, 'key']]);
    const ev = table.signatures.filter((s) => s.power === 'france');
    assert.deepEqual(ev.map((s) => [s.index, s.mode, s.reason ?? null]), [[0, 'rejected', 'kid_mismatch'], [1, 'key', null]]);
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('rotation mid-table (signing.md §7.5): without a reconnect, the next old-key move is signature_invalid and the new key binds in key mode', async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    const ge = await dipPassport(h);
    const oldKey = fr.signing!;
    const table = h.arena.diplomacy.createTable({ seed: 11, horizonYear: 1901, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }) });
    const A = new DipWireAgent(h.url, 'france', null);
    const B = new DipWireAgent(h.url, 'germany', null);
    await Promise.all([A.open(), B.open()]);
    A.send(dipHello(fr.token, table.tableId));
    B.send(dipHello(ge.token, table.tableId));
    const ackA = await A.waitFor((f) => f.t === 'ack');
    const nextObs = (a: DipWireAgent, turn: number) => a.waitFor((f) => f.t === 'diplomacy_observation' && f.turn_id === turn, 15_000);
    const [a0, b0] = await Promise.all([nextObs(A, 0), nextObs(B, 0)]);
    A.send(echo(a0, 'france'));
    B.send(echo(b0, 'germany'));
    const ep = table.episodeId;

    // Round 1: the hello-time key verifies.
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    assert.equal((a1.step as Frame).round, 1);
    A.send(echo(a1, 'france', { press: [{ move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(oldKey, ep, 1, 1) }] }));
    B.send(echo(b1, 'germany'));
    const [a2, b2] = await Promise.all([nextObs(A, 2), nextObs(B, 2)]);
    assert.deepEqual(a2.press_rejects, []);
    assert.deepEqual((a2.sent as Frame[]).map((m) => [m.seq, m.sig_mode]), [[1, 'key']]);

    // Rotate through the passports service while the seat stays connected (no new hello).
    const rot = await fetch(`${h.httpUrl}/v1/agents/${fr.clientId}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${fr.ownerBearer}` } });
    assert.equal(rot.status, 200);
    const newKey = signingKeyFromRegistration(((await rot.json()) as { signing_key: Ed25519PrivateJwk }).signing_key);
    assert.notEqual(newKey.jkt, oldKey.jkt);

    // Round 2 on the SAME session: old key refused (the contract's single press reject), new key accepted.
    assert.equal((a2.step as Frame).round, 2);
    A.send(echo(a2, 'france', { press: [
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(oldKey, ep, 1, 2) }, // rotated away
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(newKey, ep, 2, 2) }, // the new key
    ] }));
    B.send(echo(b2, 'germany'));
    const a3 = await nextObs(A, 3);
    assert.deepEqual((a3.press_rejects as Frame[]).map((r) => [r.msg_index, r.code, r.move]), [[0, 'signature_invalid', 'offer']]);
    assert.ok(!JSON.stringify(a3.press_rejects).includes('kid'), 'the cause is never disclosed on the wire');
    assert.deepEqual((a3.sent as Frame[]).map((m) => [m.seq, m.round, m.sig_mode]), [[2, 2, 'key']]);
    // Evidence (never on the wire): the refusal is the kid mismatch against the CURRENT key.
    const ev = table.signatures.filter((s) => s.power === 'france').map((s) => [s.msg_id_expected, s.mode, s.reason ?? null, s.kid ?? null]);
    assert.deepEqual(ev, [
      ['prs:S1901M:r1:france:1', 'key', null, oldKey.jkt],
      ['prs:S1901M:r2:france:1', 'rejected', 'kid_mismatch', null],
      ['prs:S1901M:r2:france:2', 'key', null, newKey.jkt],
    ]);
    // The session was never re-bound: same ack, one ack only, socket still open.
    assert.equal(A.frames.filter((f) => f.t === 'ack' && f.ack_type === 'session').length, 1);
    assert.equal(A.closeInfo, null);
    assert.equal(ackA.session_id, A.frames.find((f) => f.t === 'ack')!.session_id);
    assert.deepEqual([...A.schemaErrors, ...B.schemaErrors], []);
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('per-frame key lookup keeps arrival order: a later unsigned frame of the same step still replaces an earlier JWS-signed one', async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    const ge = await dipPassport(h);
    const table = h.arena.diplomacy.createTable({ seed: 11, horizonYear: 1901, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }) });
    const A = new DipWireAgent(h.url, 'france', null);
    const B = new DipWireAgent(h.url, 'germany', null);
    await Promise.all([A.open(), B.open()]);
    A.send(dipHello(fr.token, table.tableId));
    B.send(dipHello(ge.token, table.tableId));
    const nextObs = (a: DipWireAgent, turn: number) => a.waitFor((f) => f.t === 'diplomacy_observation' && f.turn_id === turn, 15_000);
    const [a0, b0] = await Promise.all([nextObs(A, 0), nextObs(B, 0)]);
    A.send(echo(a0, 'france'));
    B.send(echo(b0, 'germany'));
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    // Back to back: the first frame needs the (async) key lookup, the second does not. Latest wins.
    A.send(echo(a1, 'france', { press: [{ move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(fr.signing!, table.episodeId, 1, 1) }] }));
    A.send(echo(a1, 'france', { press: [{ move: 'press', to: toGermany, body: 'hello' }] }));
    B.send(echo(b1, 'germany'));
    const a2 = await nextObs(A, 2);
    assert.deepEqual((a2.sent as Frame[]).map((m) => m.move), ['press'], 'the later frame replaced the signed one');
    assert.equal(A.frames.filter((f) => f.t === 'ack' && f.ack_type === 'action' && f.turn_id === 1).length, 2, 'both frames acked, in order');
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('revocation revokes the passport key: the resolver returns nothing for a revoked passport', async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    assert.ok(await h.keys(fr.agentId));
    const del = await fetch(`${h.httpUrl}/v1/agents/${fr.clientId}`, { method: 'DELETE', headers: { authorization: `Bearer ${fr.ownerBearer}` } });
    assert.equal(del.status, 200);
    assert.equal(await h.keys(fr.agentId), null);
    const rec = await h.stores.passports.getByAgentId(fr.agentId);
    assert.ok(rec?.signingKey?.revokedAt, 'the key record carries its revocation time');
  } finally {
    await h.close();
  }
});
