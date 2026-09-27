/**
 * Arena WSS + match-runner integration tests (Stage B1 acceptance):
 *  - a full scripted match between two in-process clients reaches match_end with
 *    a valid replay_hash, and the stored replay re-simulates to the same hash;
 *  - anti-replay: a wrong-nonce action is rejected (bad_echo), not a forfeit;
 *  - one-session-per-passport supersession (second connect → first gets
 *    session_superseded + close 4409);
 *  - oversized / malformed frames are rejected at the edge before any engine work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resimulate, type TickActions } from 'wot-engine';
import { newId } from 'wot-store';
import { BudgetLedger } from 'wot-ledger';
import { validators } from 'wot-contracts';
import { houseBotPolicy } from '../src/housebot.ts';
import { Client, helloFrame, makePassport, makeTicket, setup } from './helpers.ts';

test('full match between two agents reaches match_end; the replay re-simulates to the same hash', async () => {
  const h = await setup({ softMs: 60, hardMs: 250, backfillMs: 5000 });
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);

    const a = new Client(h.url);
    const b = new Client(h.url);
    await a.open();
    await b.open();
    a.autoplay(houseBotPolicy);
    b.autoplay(houseBotPolicy);
    a.send(helloFrame(pa.token));
    b.send(helloFrame(pb.token));

    // Both get a session ack.
    const ackA = await a.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
    assert.equal(ackA.mode, 'duel');

    // Play out the whole match.
    const endA = (await a.waitFor((f) => f.t === 'match_end', 30_000)) as Record<string, unknown>;
    const endB = (await b.waitFor((f) => f.t === 'match_end', 30_000)) as Record<string, unknown>;

    // A valid committed replay hash.
    assert.match(endA.replay_hash as string, /^sha256:[0-9a-f]{64}$/);
    assert.equal(endA.replay_hash, endB.replay_hash);
    assert.equal(endA.match_id, endB.match_id);
    // Each client sees its own side. Matchmaking seats by whichever `hello` is
    // processed first, and the two WSS frames can race — so assert the clients
    // got OPPOSITE sides rather than assuming `a` always lands on seat A.
    assert.ok(endA.you === 'A' || endA.you === 'B');
    assert.equal(endB.you, endA.you === 'A' ? 'B' : 'A');
    assert.ok(['ascension', 'elimination', 'timeout', 'forfeit'].includes(endA.reason as string));
    assert.equal(typeof endA.seed, 'number');

    // The seed was withheld during play and revealed only at match_end: no
    // observation frame carried a `seed` field.
    for (const f of a.frames) {
      if (f.t === 'observation') assert.equal((f as { seed?: unknown }).seed, undefined);
    }

    // Re-simulate the stored replay → must reproduce the committed hash bit-for-bit.
    const rec = await h.stores.replays.getReplay(endA.replay_id as string);
    assert.ok(rec, 'replay persisted');
    assert.equal(rec!.hash, endA.replay_hash);
    assert.equal(rec!.seed, endA.seed);
    const resim = resimulate(rec!.seed, rec!.inputs as TickActions[]);
    assert.equal(resim.replayHash, endA.replay_hash);

    // A match summary was persisted.
    const summary = await h.stores.matches.getSummary(endA.match_id as string);
    assert.ok(summary, 'match summary persisted');
    assert.equal(summary!.replay_hash, endA.replay_hash);
    assert.equal(summary!.resim_ok, true);

    // match_end conforms to the 2.0.0 contract (no refund/payout/rating fields).
    assert.equal(validators.match_end(endA), true, JSON.stringify(validators.match_end.errors));
    assert.equal('payout' in endA || 'refund' in endA || 'rating_delta' in endA, false);

    // Budget accounting: each seat was granted its allowance once and every
    // tick's spend was charged against (episode, tick); totals are derived.
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget posts land
    const led = new BudgetLedger(h.stores.ledger);
    const remaining = endA.tokens_remaining as Record<'A' | 'B', number>;
    for (const seat of ['A', 'B'] as const) {
      const u = await led.usage(endA.match_id as string, seat);
      assert.equal(u.remaining, remaining[seat], `seat ${seat}: derived remaining ≠ match_end.tokens_remaining`);
      assert.equal(u.granted - u.consumed, remaining[seat]);
      assert.ok(u.ticks.every((t) => Number.isInteger(t) && t >= 0 && t < (endA.ticks_played as number)));
    }
    for (const j of await h.stores.ledger.allJournals()) {
      assert.equal(j.ref.kind, 'episode');
      assert.equal(j.ref.episode_id, endA.match_id);
      assert.ok(Number.isInteger(j.ref.tick));
    }
  } finally {
    await h.close();
  }
});

test('no spurious misses: two always-immediately-responding agents produce ZERO soft/hard misses across a full match', async () => {
  // Regression for the rate-limiter defect: a fast match runs far more than 5
  // ticks/s, so a fixed 5/s inbound cap used to reject legitimate one-per-tick
  // action frames, stalling ~1 in every 8-9 ticks to the soft deadline. The
  // server-cadence credit must let a prompt-and-answer agent run un-throttled.
  // Uses the Core-league default deadlines so the failure mode (period ~8-9)
  // would be unmistakable if it regressed.
  const h = await setup({ softMs: 1500, hardMs: 3000, backfillMs: 5000 });
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);
    const a = new Client(h.url);
    const b = new Client(h.url);
    await a.open();
    await b.open();
    a.autoplay(houseBotPolicy);
    b.autoplay(houseBotPolicy);
    a.send(helloFrame(pa.token));
    b.send(helloFrame(pb.token));

    const end = (await a.waitFor((f) => f.t === 'match_end', 30_000)) as Record<string, unknown>;
    assert.ok((end.ticks_played as number) > 20, 'a real, multi-tick match was played');

    const softMisses = h.events.filter((e) => e.event === 'soft_miss');
    const hardMisses = h.events.filter((e) => e.event === 'hard_miss');
    const rateLimited = h.events.filter((e) => e.event === 'frame_rejected' && e.reason === 'rate_limited');
    assert.equal(softMisses.length, 0, `expected 0 soft_miss, got ${softMisses.length} at turns ${softMisses.map((m) => m.turn_id).join(',')}`);
    assert.equal(hardMisses.length, 0, `expected 0 hard_miss, got ${hardMisses.length}`);
    assert.equal(rateLimited.length, 0, `a legit one-per-tick agent must never be rate_limited (got ${rateLimited.length})`);
  } finally {
    await h.close();
  }
});

test('anti-replay: an action with the wrong nonce is rejected (bad_echo), not a forfeit', async () => {
  // Lone client backfilled onto a house bot; a long soft deadline keeps the tick
  // open long enough to observe the reject.
  const h = await setup({ backfillMs: 30, softMs: 2000, hardMs: 4000 });
  try {
    const p = await makePassport(h.stores);
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(p.token));
    await c.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');

    const obs = (await c.waitFor((f) => f.t === 'observation')) as Record<string, unknown>;
    c.send({
      t: 'action',
      protocol_version: '1.0',
      match_id: obs.match_id,
      turn_id: obs.turn_id,
      nonce: 'n_wrong_nonce_value',
      units: [],
    });
    const rej = (await c.waitFor((f) => f.t === 'reject')) as Record<string, unknown>;
    assert.equal(rej.reason, 'bad_echo');
    // The connection stays open (soft, retryable — not a forfeit / close).
    assert.equal(c.closeInfo, null);
  } finally {
    await h.close();
  }
});

test('anti-replay: exactly one action-set per (turn_id, nonce); a duplicate is rejected', async () => {
  // Two real agents (no autoplay) so the tick stays open after A submits: B has
  // not acted, so A's duplicate frame lands on the still-current turn.
  const h = await setup({ backfillMs: 5000, softMs: 2000, hardMs: 4000 });
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);
    const a = new Client(h.url);
    const b = new Client(h.url);
    await a.open();
    await b.open();
    a.send(helloFrame(pa.token));
    b.send(helloFrame(pb.token));
    await a.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
    await b.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');

    const obs = (await a.waitFor((f) => f.t === 'observation')) as Record<string, unknown>;
    const action = {
      t: 'action',
      protocol_version: '1.0',
      match_id: obs.match_id,
      turn_id: obs.turn_id,
      nonce: obs.nonce,
      units: [],
    };
    a.send(action);
    await a.waitFor((f) => f.t === 'ack' && f.ack_type === 'action');
    a.send(action); // replay the exact same accepted frame (B still hasn't acted)
    const rej = (await a.waitFor((f) => f.t === 'reject')) as Record<string, unknown>;
    assert.equal(rej.reason, 'duplicate_submission');
  } finally {
    await h.close();
  }
});

test('one-session-per-passport: a second connect supersedes the first (session_superseded + 4409)', async () => {
  const h = await setup({ backfillMs: 5000 });
  try {
    const p = await makePassport(h.stores); // ONE passport, shared by both connects

    const c1 = new Client(h.url);
    await c1.open();
    c1.send(helloFrame(p.token));
    await c1.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');

    const c2 = new Client(h.url);
    await c2.open();
    c2.send(helloFrame(p.token));
    await c2.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');

    const superseded = await c1.waitFor((f) => f.t === 'session_superseded');
    assert.equal(superseded.reason, 'another connection authenticated with this passport');
    const closed = await c1.waitClose();
    assert.equal(closed.code, 4409);
  } finally {
    await h.close();
  }
});

test('edge validation: an oversized frame is rejected (too_large) before any processing', async () => {
  const h = await setup();
  try {
    const c = new Client(h.url);
    await c.open();
    // > 8 KB (the largest inbound cap). Rejected at the edge, pre-parse.
    c.sendRaw(JSON.stringify({ t: 'hello', pad: 'x'.repeat(9000) }));
    const rej = (await c.waitFor((f) => f.t === 'reject')) as Record<string, unknown>;
    assert.equal(rej.reason, 'too_large');
    // contracts 2.5.0: no accepted hello yet, so it can only be a hello: never retryable.
    assert.deepEqual([rej.retryable, rej.turn_id], [false, null]);
  } finally {
    await h.close();
  }
});

test('edge validation (contracts 2.5.0): an oversize frame after the hello stays retryable', async () => {
  const h = await setup({ backfillMs: 30, softMs: 2000, hardMs: 4000 });
  try {
    const p = await makePassport(h.stores);
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(p.token));
    await c.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
    c.sendRaw(JSON.stringify({ t: 'action', pad: 'x'.repeat(9000) }));
    const rej = (await c.waitFor((f) => f.t === 'reject' && f.reason === 'too_large')) as Record<string, unknown>;
    assert.equal(rej.retryable, true);
    assert.equal(c.closeInfo, null);
  } finally {
    await h.close();
  }
});

test('edge validation: an unparseable frame is rejected and the socket closes 4400', async () => {
  const h = await setup();
  try {
    const c = new Client(h.url);
    await c.open();
    c.sendRaw('{ this is not valid json ');
    const rej = (await c.waitFor((f) => f.t === 'reject')) as Record<string, unknown>;
    assert.equal(rej.reason, 'unparseable');
    const closed = await c.waitClose();
    assert.equal(closed.code, 4400);
  } finally {
    await h.close();
  }
});

test('auth: a token without play:duel scope is closed 4403 at connect', async () => {
  const h = await setup();
  try {
    const p = await makePassport(h.stores, ['spectate:read']);
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(p.token));
    const closed = await c.waitClose();
    assert.equal(closed.code, 4403);
  } finally {
    await h.close();
  }
});

test('auth: a revoked passport is closed 4403 at connect', async () => {
  const h = await setup();
  try {
    const p = await makePassport(h.stores);
    await h.stores.passports.revoke(p.clientId);
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(p.token));
    const closed = await c.waitClose();
    assert.equal(closed.code, 4403);
  } finally {
    await h.close();
  }
});

// ── Ticket resolution (SR / sim-qa FINDING-1) ────────────────────────────────

test('ticket routing: a hello with a valid ticket is admitted and the ticket binds to the match', async () => {
  const h = await setup({ softMs: 60, hardMs: 250, backfillMs: 5000 });
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);
    const ta = await makeTicket(h.stores, pa);
    const tb = await makeTicket(h.stores, pb);

    const a = new Client(h.url);
    const b = new Client(h.url);
    await a.open();
    await b.open();
    a.autoplay(houseBotPolicy);
    b.autoplay(houseBotPolicy);
    a.send(helloFrame(pa.token, ta));
    b.send(helloFrame(pb.token, tb));

    const ackA = await a.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
    assert.equal(ackA.mode, 'duel');
    const end = await a.waitFor((f) => f.t === 'match_end', 30_000);
    assert.match(end.replay_hash as string, /^sha256:[0-9a-f]{64}$/);

    // Admission flowed through the ticket → the arena bound it to the match.
    const rec = await h.stores.tickets.getTicket(ta);
    assert.ok(rec, 'ticket exists');
    assert.equal(rec!.matchId, end.match_id);
    assert.equal(rec!.status, 'assigned');
  } finally {
    await h.close();
  }
});

test('ticket routing: an unknown ticket_id is refused (close 4403), no enumeration oracle', async () => {
  const h = await setup();
  try {
    const p = await makePassport(h.stores);
    const bogus = newId('tkt'); // valid format, never issued
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(p.token, bogus));
    const closed = await c.waitClose();
    assert.equal(closed.code, 4403);
  } finally {
    await h.close();
  }
});

test('ticket routing: a foreign ticket (owned by another passport) is refused (close 4403)', async () => {
  const h = await setup();
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);
    const foreign = await makeTicket(h.stores, pb); // minted for B
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(pa.token, foreign)); // presented by A
    const closed = await c.waitClose();
    assert.equal(closed.code, 4403);
  } finally {
    await h.close();
  }
});

// ── Connect-storm caps (SR-2 MEDIUM/LOW) ─────────────────────────────────────

test('connect-storm: per-IP concurrency cap refuses upgrades beyond the limit (pre-auth)', async () => {
  const h = await setup(undefined, { limits: { maxSocketsPerIp: 2, connectBurst: 100 } });
  try {
    const c1 = new Client(h.url);
    const c2 = new Client(h.url);
    await c1.open();
    await c2.open(); // two slots taken (both un-authenticated, idle)

    const c3 = new Client(h.url);
    await assert.rejects(c3.open(), 'the 3rd concurrent socket from the same IP is refused');
    assert.ok(
      h.events.some((e) => e.event === 'connect_refused' && e.reason === 'per_ip_concurrency'),
      'a per_ip_concurrency refusal was logged',
    );

    // Closing one frees a slot → a new upgrade is admitted again.
    c1.close();
    await c1.waitClose().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    const c4 = new Client(h.url);
    await c4.open();
    c1.close();
    c2.close();
    c4.close();
  } finally {
    await h.close();
  }
});

test('connect-storm: per-IP connect-RATE bucket refuses churn beyond the burst (pre-auth)', async () => {
  const h = await setup(undefined, { limits: { connectRatePerSec: 1, connectBurst: 2, maxSocketsPerIp: 100 } });
  try {
    const c1 = new Client(h.url);
    const c2 = new Client(h.url);
    await c1.open(); // consumes token 1 of the burst
    await c2.open(); // consumes token 2 of the burst
    const c3 = new Client(h.url);
    await assert.rejects(c3.open(), 'the 3rd connect within the burst window is rate-refused');
    assert.ok(
      h.events.some((e) => e.event === 'connect_refused' && e.reason === 'connect_rate'),
      'a connect_rate refusal was logged',
    );
    c1.close();
    c2.close();
  } finally {
    await h.close();
  }
});

// ── Revocation mid-match + zero-window supersession (SR-2 LOW coverage) ───────

test('rolling revocation: revoking a passport mid-match closes that session (session_revoked + 4410)', async () => {
  // Fast rolling check; long soft deadline so the match is still live when we revoke.
  const h = await setup({ softMs: 3000, hardMs: 6000, backfillMs: 5000, revocationIntervalMs: 50 });
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);
    const a = new Client(h.url);
    const b = new Client(h.url);
    await a.open();
    await b.open();
    a.send(helloFrame(pa.token));
    b.send(helloFrame(pb.token));
    // Both matched and mid-match (each received tick-0 observation).
    await a.waitFor((f) => f.t === 'observation');
    await b.waitFor((f) => f.t === 'observation');

    // Admin revokes A's passport; the rolling check must kill A within the interval.
    await h.stores.passports.revoke(pa.clientId);
    const revoked = await a.waitFor((f) => f.t === 'session_revoked', 5000);
    assert.equal(revoked.reason, 'passport_or_owner_revoked');
    const closed = await a.waitClose();
    assert.equal(closed.code, 4410);
  } finally {
    await h.close();
  }
});

test('supersession transfers a LIVE match binding with no zero-session window', async () => {
  const h = await setup({ softMs: 5000, hardMs: 10_000, backfillMs: 5000 });
  try {
    const pa = await makePassport(h.stores);
    const pb = await makePassport(h.stores);
    const a1 = new Client(h.url);
    const b = new Client(h.url);
    await a1.open();
    await b.open();
    a1.send(helloFrame(pa.token));
    b.send(helloFrame(pb.token));
    // A is in a live match (received the tick-0 observation).
    const obs0 = await a1.waitFor((f) => f.t === 'observation');
    const matchId = obs0.match_id as string;

    // A reconnects with the SAME passport → supersede + transfer the binding.
    const a2 = new Client(h.url);
    await a2.open();
    a2.send(helloFrame(pa.token, undefined)); // resume via same client_id

    // Old socket: superseded + 4409.
    const sup = await a1.waitFor((f) => f.t === 'session_superseded');
    assert.equal(sup.reason, 'another connection authenticated with this passport');
    assert.equal(typeof sup.superseded_by, 'string');
    const closedOld = await a1.waitClose();
    assert.equal(closedOld.code, 4409);

    // New socket: admitted straight INTO the same match (match_id on the ack) and
    // re-sent the current observation — proving the binding transferred with no
    // tick where side A had no agent (no zero-session window / no forfeit).
    const ack2 = await a2.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
    assert.equal(ack2.match_id, matchId);
    const obsResent = await a2.waitFor((f) => f.t === 'observation', 5000);
    assert.equal(obsResent.match_id, matchId);
    assert.ok(!h.events.some((e) => e.event === 'hard_miss'), 'no hard-miss forfeit during the handoff');
  } finally {
    await h.close();
  }
});
