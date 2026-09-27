/**
 * Phase 8 B3a: the Diplomacy session on /v1/arena, and G-11 over the wire.
 *
 *  - hello: bad shape, bad token, missing scope, not seated → refused; seated → session ack;
 *    (2.4.0) the hello is `wot:hello:diplomacy:1` (2048-byte cap, no `dpop`) and the session ack
 *    `wot:ack:diplomacy:1`, both checked against the contract schemas;
 *  - signatures verified BEFORE the engine: a valid passport JWS → `sig_mode: key`; forged,
 *    replayed from another episode, tampered clause, wrong position → `signature_invalid` in
 *    the sender's next `press_rejects` and never delivered; `session` refused when the table
 *    (or the environment) does not allow it;
 *  - echo checks (nonce, power, turn) → generic reject frames, nothing applied;
 *  - privacy: no observation carries another power's codeword or intent;
 *  - deadlines: an answer after Ds is a soft miss; silence to Dh a hard miss; three in a row
 *    forfeit (civil disorder) and the episode still ends with `diplomacy_episode_end`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPressMove, verifyPressSignature, type PassportSigningKey } from 'wot-auth';
import { POWERS, type Power } from 'wot-engine';
import { signaturePolicy } from '../src/diplomacy/signatures.ts';
import { dipMaxBytes, dipValidators } from '../src/diplomacy/validators.ts';
import type { DipSeatSpec } from '../src/diplomacy/table.ts';
import { dipHello, dipPassport, DipWireAgent, setupDip, type DipHarness } from './diplomacy-helpers.ts';

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

const nextObs = (a: DipWireAgent, turn: number): Promise<Frame> => a.waitFor((f) => f.t === 'diplomacy_observation' && f.turn_id === turn, 15_000);

async function seatTwo(h: DipHarness, over: { allowSessionSignatures?: boolean } = {}) {
  const fr = await dipPassport(h);
  const ge = await dipPassport(h);
  const table = h.arena.diplomacy.createTable({ seed: 7, cls: 'core', horizonYear: 1901, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }), ...over });
  const A = new DipWireAgent(h.url, 'france', null);
  const B = new DipWireAgent(h.url, 'germany', null);
  await Promise.all([A.open(), B.open()]);
  A.send(dipHello(fr.token, table.tableId));
  B.send(dipHello(ge.token, table.tableId));
  const [a0, b0] = await Promise.all([nextObs(A, 0), nextObs(B, 0)]);
  return { fr, ge, table, A, B, a0, b0 };
}

const DMZ = { give: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: 'S1901M', provinces: ['bur'] }], want: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: 'S1901M', provinces: ['bur'] }] };
const toGermany = { kind: 'private', power: 'germany' };

function signOffer(key: PassportSigningKey, episodeId: string, seq: number, terms: unknown = DMZ, round = 1): string {
  return signPressMove(key, { episodeId, msgIdExpected: `prs:S1901M:r${round}:france:${seq}`, from: 'france', to: toGermany, move: 'offer', respondTo: null, terms });
}

test('hello: shape, token, scope and seat are enforced; a seated passport gets a session ack', async () => {
  const h = await setupDip();
  try {
    const seated = await dipPassport(h);
    const stranger = await dipPassport(h);
    const noScope = await dipPassport(h, { scopes: ['play:duel'] });
    const table = h.arena.diplomacy.createTable({ seed: 1, horizonYear: 1901, seats: seatsWith({ france: seated.agentId, italy: noScope.agentId }) });

    const bad = new DipWireAgent(h.url, 'france', null);
    await bad.open();
    bad.send({ ...dipHello(seated.token, table.tableId), power: 'france' }); // a client may not name its power
    assert.equal((await bad.waitFor((f) => f.t === 'reject')).reason, 'schema_invalid');
    bad.close();

    const forged = new DipWireAgent(h.url, 'france', null);
    await forged.open();
    forged.send(dipHello('eyJhbGciOiJFZERTQSJ9.e30.' + 'A'.repeat(40), table.tableId));
    assert.equal((await forged.waitClose()).code, 4401);

    const scope = new DipWireAgent(h.url, 'italy', null);
    await scope.open();
    scope.send(dipHello(noScope.token, table.tableId));
    assert.equal((await scope.waitClose()).code, 4403);

    const notSeated = new DipWireAgent(h.url, 'france', null);
    await notSeated.open();
    notSeated.send(dipHello(stranger.token, table.tableId));
    assert.equal((await notSeated.waitClose()).code, 4403);

    const unknownTable = new DipWireAgent(h.url, 'france', null);
    await unknownTable.open();
    unknownTable.send(dipHello(seated.token, 'dtb_01J9ZZZZZZZZZZZZZZZZZZZZZZ'));
    assert.equal((await unknownTable.waitClose()).code, 4403);

    const ok = new DipWireAgent(h.url, 'france', null);
    await ok.open();
    ok.send(dipHello(seated.token, table.tableId));
    const ack = await ok.waitFor((f) => f.t === 'ack');
    assert.equal(ack.ack_type, 'session');
    assert.equal(ack.power, 'france');
    assert.equal(ack.episode_id, table.episodeId);
    assert.match(String(ack.episode_id), /^epi_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(ack.signature_modes, ['key', 'session']);
    ok.close();
  } finally {
    await h.close();
  }
});

test('hello and session ack are the 2.4.0 contract frames: 2048-byte cap, no dpop, schema-valid ack', async () => {
  // Wire-frame level: the helper's hello and the contract examples are valid; dpop, a power, a mode are not.
  const hello = dipHello('x'.repeat(40), 'dtb_01J9D1PX0MACY0EXAMP1E00000');
  assert.equal(dipMaxBytes('diplomacy_hello'), 2048);
  assert.equal(dipValidators.diplomacy_hello(hello), true);
  for (const extra of [{ dpop: 'eyJhbGciOiJFUzI1NiJ9.e30.sig' }, { power: 'france' }, { mode: 'duel' }, { seed: 1 }]) {
    assert.equal(dipValidators.diplomacy_hello({ ...hello, ...extra }), false, `hello with ${Object.keys(extra)[0]} is refused`);
  }
  assert.equal(dipValidators.diplomacy_hello({ ...hello, table_id: 'dtb_short' }), false);
  assert.equal(dipValidators.diplomacy_hello({ ...hello, scenario_id: 'diplomacy' }), false);

  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    const ge = await dipPassport(h, { signingKey: false });
    const table = h.arena.diplomacy.createTable({ seed: 3, horizonYear: 1901, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }) });

    // dpop is not in the contract (additionalProperties false): schema_invalid, not retryable, no seat bound.
    const dp = new DipWireAgent(h.url, 'france', null);
    await dp.open();
    dp.send({ ...dipHello(fr.token, table.tableId), dpop: 'eyJhbGciOiJFUzI1NiJ9.e30.sig' });
    const r1 = await dp.waitFor((f) => f.t === 'reject');
    assert.deepEqual([r1.reason, r1.retryable], ['schema_invalid', false]);
    assert.ok(!dp.frames.some((f) => f.t === 'ack'));
    dp.close();

    // 2049 bytes: refused on size before anything else (a schema-valid hello padded with JSON whitespace).
    const body = JSON.stringify(dipHello(fr.token, table.tableId));
    const pad = (n: number): string => body.slice(0, -1) + ' '.repeat(n - Buffer.byteLength(body)) + '}';
    const big = new DipWireAgent(h.url, 'france', null);
    await big.open();
    big.sendRaw(pad(2049));
    const r2 = await big.waitFor((f) => f.t === 'reject');
    assert.deepEqual([r2.reason, r2.retryable], ['too_large', false]);
    assert.ok(!big.frames.some((f) => f.t === 'ack'));
    big.close();

    // contracts 2.5.0: an unauthenticated frame of 8193..16384 bytes is answered by the generic guard
    // (it is over every pre-auth cap) with too_large, retryable FALSE, turn_id null; the socket stays
    // open (the hello timer closes it 4401). Above 16384 the ws layer closes 1009.
    const huge = new DipWireAgent(h.url, 'france', null);
    await huge.open();
    for (const n of [8193, 16384]) {
      huge.sendRaw(pad(n));
      const r = await huge.waitFor((f) => f.t === 'reject');
      assert.deepEqual([r.reason, r.retryable, r.turn_id], ['too_large', false, null], `${n} bytes`);
      huge.frames.splice(0); // next wait sees only the next reply
    }
    assert.equal(huge.closeInfo, null);
    huge.sendRaw(pad(16385));
    assert.equal((await huge.waitClose(10_000)).code, 1009);
    assert.ok(!huge.frames.some((f) => f.t === 'ack'));

    // Exactly 2048 bytes is accepted; the session ack validates against wot:ack:diplomacy:1.
    const A = new DipWireAgent(h.url, 'france', null);
    const B = new DipWireAgent(h.url, 'germany', null);
    await Promise.all([A.open(), B.open()]);
    A.sendRaw(pad(2048));
    B.send(dipHello(ge.token, table.tableId));
    const [ackA, ackB] = await Promise.all([A.waitFor((f) => f.t === 'ack'), B.waitFor((f) => f.t === 'ack')]);
    for (const ack of [ackA, ackB]) assert.equal(dipValidators.diplomacy_session_ack(ack), true, JSON.stringify(dipValidators.diplomacy_session_ack.errors));
    assert.deepEqual([ackA.mode, ackA.scenario_id, ackA.table_id, ackA.power], ['diplomacy', 'diplomacy_standard', table.tableId, 'france']);
    assert.deepEqual(ackA.signature_modes, ['key', 'session']);
    assert.deepEqual(ackB.signature_modes, ['session'], 'no registered key: session only (WOT_ENV=test)');
    assert.deepEqual([...A.schemaErrors, ...B.schemaErrors], []);
    // A negative control: the ack schema is strict (a duel-only field is refused).
    assert.equal(dipValidators.diplomacy_session_ack({ ...ackA, tokens_remaining: 0 }), false);
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('G-11 over the wire: valid passport signature → key; forged, cross-episode replay, tampered clause, wrong position → signature_invalid', async () => {
  const h = await setupDip();
  try {
    const { fr, ge, table, A, B, a0, b0 } = await seatTwo(h);
    const ep = table.episodeId;
    // intent step: nothing
    A.send(echo(a0, 'france'));
    B.send(echo(b0, 'germany'));
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    assert.equal((a1.step as Frame).kind, 'press');

    const stranger = (await dipPassport(h)).signing!;
    const tampered = { ...DMZ, give: [{ ...DMZ.give[0], provinces: ['pic'] }] };
    const batch = [
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(fr.signing!, ep, 1) }, // 0: valid
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(stranger, ep, 2) }, // 1: forged (another key)
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(fr.signing!, 'epi_01J9OTHEREP1S0DE000000000Z', 3) }, // 2: captured in another episode
      { move: 'offer', to: toGermany, terms: tampered, signature: signOffer(fr.signing!, ep, 4) }, // 3: signed DMZ bur, sent DMZ pic
      { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(fr.signing!, ep, 1) }, // 4: valid bytes of position 1, replayed at 5
    ];
    A.send(echo(a1, 'france', { press: batch }));
    B.send(echo(b1, 'germany'));
    const [a2, b2] = await Promise.all([nextObs(A, 2), nextObs(B, 2)]);

    const rejects = a2.press_rejects as Frame[];
    assert.deepEqual(
      rejects.map((r) => [r.msg_index, r.code, r.move, r.round]),
      [1, 2, 3, 4].map((i) => [i, 'signature_invalid', 'offer', 1]),
    );
    const sent = a2.sent as Frame[];
    assert.deepEqual(sent.map((m) => [m.msg_id, m.sig_mode]), [['prs:S1901M:r1:france:1', 'key']]);
    const offers = (b2.inbox as Frame[]).filter((m) => m.from === 'france');
    assert.deepEqual(offers.map((m) => m.msg_id), ['prs:S1901M:r1:france:1'], 'only the verified offer is delivered');
    assert.equal((b2.offers as Frame[]).find((o) => o.offer_id === 'prs:S1901M:r1:france:1')?.sig_mode, 'key');

    const ev = table.signatures.filter((s) => s.power === 'france');
    assert.deepEqual(ev.map((s) => [s.index, s.mode, s.reason ?? null]), [
      [0, 'key', null],
      [1, 'rejected', 'kid_mismatch'], // signed by a key that is not this passport's
      [2, 'rejected', 'bad_signature'],
      [3, 'rejected', 'bad_signature'],
      [4, 'rejected', 'bad_signature'],
    ]);
    // The engine only ever saw the attested modes (never the JWS bytes).
    const r1 = table.episode.inputs[1].actions.france as { press: { signature: string }[] };
    assert.deepEqual(r1.press.map((m) => m.signature), ['key', 'unverified', 'unverified', 'unverified', 'unverified']);

    // Germany accepts with its own passport key: the commitment binds in key mode.
    const accept = {
      move: 'accept',
      to: { kind: 'private', power: 'france' },
      respond_to: 'prs:S1901M:r1:france:1',
      signature: signPressMove(ge.signing!, { episodeId: ep, msgIdExpected: 'prs:S1901M:r2:germany:1', from: 'germany', to: { kind: 'private', power: 'france' }, move: 'accept', respondTo: 'prs:S1901M:r1:france:1', terms: null }),
    };
    A.send(echo(a2, 'france'));
    B.send(echo(b2, 'germany', { press: [accept] }));
    const [a3, b3] = await Promise.all([nextObs(A, 3), nextObs(B, 3)]);
    for (const o of [a3, b3]) {
      const c = (o.commitments as Frame[]).find((x) => x.cmt_id === 'cmt:prs:S1901M:r1:france:1');
      assert.ok(c, 'both parties see the commitment in the same observation');
      assert.equal(c.sig_mode, 'key');
      assert.equal(c.state, 'active');
    }
    assert.equal((b3.press_rejects as Frame[]).length, 0);
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('G-11: `session` signatures are refused when the table disallows them, and never allowed outside development|test', async () => {
  assert.equal(signaturePolicy({ WOT_ENV: 'test' }, true).allowSession, true);
  assert.equal(signaturePolicy({ WOT_ENV: 'development' }, true).allowSession, true);
  assert.equal(signaturePolicy({ WOT_ENV: 'production' }, true).allowSession, false);
  assert.equal(signaturePolicy({}, true).allowSession, false);
  assert.equal(signaturePolicy({ WOT_ENV: 'staging' }, true).allowSession, false);
  assert.equal(signaturePolicy({ WOT_ENV: 'test' }, false).allowSession, false);

  const h = await setupDip();
  try {
    const { fr, table, A, B, a0, b0 } = await seatTwo(h, { allowSessionSignatures: false });
    A.send(echo(a0, 'france'));
    B.send(echo(b0, 'germany'));
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    A.send(echo(a1, 'france', { press: [{ move: 'offer', to: toGermany, terms: DMZ, signature: 'session' }, { move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(fr.signing!, table.episodeId, 2) }] }));
    B.send(echo(b1, 'germany'));
    const a2 = await nextObs(A, 2);
    assert.deepEqual((a2.press_rejects as Frame[]).map((r) => [r.msg_index, r.code]), [[0, 'signature_invalid']]);
    assert.deepEqual((a2.sent as Frame[]).map((m) => m.sig_mode), ['key']);
    assert.equal(table.signatures[0].reason, 'session_not_allowed');
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('a seat without a registered passport key can sign only in session mode', async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h, { signingKey: false });
    const ge = await dipPassport(h);
    const table = h.arena.diplomacy.createTable({ seed: 3, horizonYear: 1901, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }) });
    const A = new DipWireAgent(h.url, 'france', null);
    const B = new DipWireAgent(h.url, 'germany', null);
    await Promise.all([A.open(), B.open()]);
    A.send(dipHello(fr.token, table.tableId));
    B.send(dipHello(ge.token, table.tableId));
    assert.deepEqual((await A.waitFor((f) => f.t === 'ack')).signature_modes, ['session']);
    const [a0, b0] = await Promise.all([nextObs(A, 0), nextObs(B, 0)]);
    A.send(echo(a0, 'france'));
    B.send(echo(b0, 'germany'));
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    // A JWS from a key the passport never registered is not a signature of this seat.
    const rogue = (await dipPassport(h)).signing!;
    A.send(echo(a1, 'france', { press: [{ move: 'offer', to: toGermany, terms: DMZ, signature: signOffer(rogue, table.episodeId, 1) }, { move: 'offer', to: toGermany, terms: DMZ, signature: 'session' }] }));
    B.send(echo(b1, 'germany'));
    const a2 = await nextObs(A, 2);
    assert.deepEqual((a2.press_rejects as Frame[]).map((r) => [r.msg_index, r.code]), [[0, 'signature_invalid']]);
    assert.deepEqual((a2.sent as Frame[]).map((m) => [m.seq, m.sig_mode]), [[2, 'session']]);
    assert.equal(table.signatures[0].reason, 'no_passport_key');
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('echo checks: wrong nonce, wrong power, stale turn and schema violations are refused and nothing is applied', async () => {
  const h = await setupDip();
  try {
    const { table, A, B, a0, b0 } = await seatTwo(h);
    A.send(echo(a0, 'france', { nonce: 'n_000000000000000000000000' }));
    assert.equal((await A.waitFor((f) => f.t === 'reject' && f.reason === 'bad_echo')).retryable, true);
    A.send(echo(a0, 'france', { power: 'germany' }));
    await A.waitFor((f) => f.t === 'reject' && f.reason === 'not_your_seat');
    A.send(echo(a0, 'france', { turn_id: 5 }));
    await A.waitFor((f) => f.t === 'reject' && f.reason === 'stale_turn');
    A.send(echo(a0, 'france', { press: [{ move: 'press', to: { kind: 'private', power: 'france' }, body: 'self' }] }));
    await A.waitFor((f) => f.t === 'reject' && f.reason === 'schema_invalid');
    A.send(echo(a0, 'france', { press: [{ move: 'offer', to: toGermany, terms: DMZ, signature: 'key' }] })); // `key` is an engine mode, never a wire signature
    await A.waitFor((f) => f.t === 'reject' && f.reason === 'schema_invalid' && A.frames.filter((x) => x.reason === 'schema_invalid').length >= 2);
    assert.equal(table.episode.tick, 0, 'nothing resolved');
    // the real answers
    A.send(echo(a0, 'france', { intent: { phase: 'S1901M', orders: ['A par - bur'] } }));
    await A.waitFor((f) => f.t === 'ack' && f.ack_type === 'action');
    B.send(echo(b0, 'germany', { intent: { phase: 'F1901M', orders: [] } })); // wrong phase: transport feedback
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    assert.ok((((a1.private as Frame).intent as Frame).orders as string[]).includes('A par - bur'));
    assert.deepEqual(b1.order_feedback, [{ source: 'intent', index: 0, code: 'intent_wrong_phase' }]);
    assert.equal((b1.private as Frame).intent, null);
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('privacy: no observation over the wire carries another power\'s codeword or intent', async () => {
  const h = await setupDip();
  try {
    const { table, A, B, a0, b0 } = await seatTwo(h);
    A.send(echo(a0, 'france', { intent: { phase: 'S1901M', orders: ['A par - bur'], notes: 'secret french plan alpha' } }));
    B.send(echo(b0, 'germany', { intent: { phase: 'S1901M', orders: ['A mun - bur'], notes: 'secret german plan beta' } }));
    const [a1, b1] = await Promise.all([nextObs(A, 1), nextObs(B, 1)]);
    const briefs = table.episode.briefs;
    const aj = JSON.stringify(A.frames);
    const bj = JSON.stringify(B.frames);
    assert.ok(aj.includes(briefs.france.codeword) && !aj.includes(briefs.germany.codeword));
    assert.ok(bj.includes(briefs.germany.codeword) && !bj.includes(briefs.france.codeword));
    for (const p of POWERS) if (p !== 'france') assert.ok(!aj.includes(briefs[p].codeword), p);
    assert.ok(aj.includes('french plan') && !aj.includes('german plan'));
    assert.ok(bj.includes('german plan') && !bj.includes('french plan'));
    assert.ok(!aj.includes(table.episode.config.secret) && !bj.includes(table.episode.config.secret));
    assert.equal(((a1.private as Frame).intent as Frame).notes, 'secret french plan alpha');
    assert.equal(((b1.private as Frame).intent as Frame).notes, 'secret german plan beta');
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('deadlines: late answer = soft miss; silence to Dh = hard miss; three in a row forfeit, the episode still ends', async () => {
  const h = await setupDip({ softMs: 60, hardMs: 250 });
  try {
    const fr = await dipPassport(h);
    const table = h.arena.diplomacy.createTable({ seed: 11, horizonYear: 1901, seats: seatsWith({ france: fr.agentId }) });
    const A = new DipWireAgent(h.url, 'france', null);
    await A.open();
    A.send(dipHello(fr.token, table.tableId));
    const a0 = await nextObs(A, 0);
    await new Promise((r) => setTimeout(r, 120)); // after Ds, before Dh
    A.send(echo(a0, 'france'));
    await nextObs(A, 1); // then silence: ticks 1, 2, 3 are hard misses → forfeit
    const end = await A.waitFor((f) => f.t === 'diplomacy_episode_end', 20_000);
    assert.deepEqual(
      table.episode.misses.slice(0, 4).map((m) => [m.tick, m.power, m.severity]),
      [
        [0, 'france', 'soft'],
        [1, 'france', 'hard'],
        [2, 'france', 'hard'],
        [3, 'france', 'hard'],
      ],
    );
    assert.deepEqual(table.episode.forfeited, [{ power: 'france', tick: 3 }]);
    assert.equal(end.outcome, 'forfeit');
    assert.deepEqual(end.civil_disorder, ['france']);
    assert.equal(end.replay_hash, table.episode.chain);
    assert.equal((await A.waitClose()).code, 1000);
  } finally {
    await h.close();
  }
});

test('the reference verifier and the arena agree on the payload (a signature minted for the wire verifies in wot-auth)', () => {
  // Guards the one place both sides must agree: the wire id (full power name) and the wire terms.
  const k = { privateJwk: { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A' } } as unknown as PassportSigningKey;
  const f = { episodeId: 'epi_01J9ZZZZZZZZZZZZZZZZZZZZZZ', msgIdExpected: 'prs:S1901M:r1:france:1', from: 'france', to: toGermany, move: 'offer', respondTo: null, terms: DMZ };
  const sig = signPressMove(k, f);
  assert.equal(verifyPressSignature({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }, sig, f).ok, true);
});
