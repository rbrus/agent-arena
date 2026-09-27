/**
 * WSS RECONNECT / RESUME ACROSS A RESTART (Phase 5 B5 — resilience-and-review.md
 * §1.5). End-to-end over real sockets:
 *   1. Arena A pairs an agent-vs-agent duel; both agents play a few ticks
 *      (manifest `live`, per-tick log durable).
 *   2. Arena A is killed WITHOUT settling (the crash) — the match stays `live`.
 *   3. Arena B boots on the SAME durable stores with `recover:true`; the boot scan
 *      re-folds the durable inputs and RESUMES the mid-match orphan.
 *   4. Both agents reconnect by PASSPORT; each receives ack{match_id} then the
 *      current-tick observation (the resume cursor), and play continues.
 *   5. The outcome is recorded EXACTLY once (manifest `settled` with the winner
 *      the agents saw in match_end).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStores } from 'wot-store';
import { attachArena } from '../src/index.ts';
import { Client, helloFrame, makePassport } from './helpers.ts';

const DEADLINES = { softMs: 200, hardMs: 2000, backfillMs: 30_000, helloTimeoutMs: 30_000, revocationIntervalMs: 100_000 };

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}
const HOLD = (): [] => [];

test('across-restart reconnect: resume, re-bind by passport, outcome recorded exactly once', async () => {
  const stores = createStores();
  const A = await makePassport(stores, ['play:duel']);
  const B = await makePassport(stores, ['play:duel']);

  // ---- arena A: pair an agent-vs-agent duel, play a few ticks ----
  const serverA = http.createServer();
  const arenaA = attachArena({ server: serverA, stores, deadlines: DEADLINES });
  const urlA = `ws://127.0.0.1:${await listen(serverA)}/v1/arena`;

  const ca = new Client(urlA);
  await ca.open();
  ca.autoplay(HOLD);
  ca.send(helloFrame(A.token));
  const cb = new Client(urlA);
  await cb.open();
  cb.autoplay(HOLD);
  cb.send(helloFrame(B.token));

  const firstObs = await ca.waitFor((f) => f.t === 'observation');
  const matchId = String(firstObs.match_id);
  await ca.waitFor((f) => f.t === 'observation' && typeof f.turn_id === 'number' && (f.turn_id as number) >= 2);

  const live = await stores.matchEvents.getManifest(matchId);
  assert.equal(live?.status, 'live', 'the match is durably live');
  assert.deepEqual(live?.sides.map((x) => x.agentId).sort(), [A.agentId, B.agentId].sort());

  // ---- the crash: kill arena A WITHOUT settling ----
  await arenaA.close();
  ca.close();
  cb.close();
  const afterKill = await stores.matchEvents.getManifest(matchId);
  assert.equal(afterKill?.status, 'live', 'the killed match is still live (never settled on crash)');

  // ---- arena B: boot with recovery on the SAME stores ----
  const serverB = http.createServer();
  const arenaB = attachArena({ server: serverB, stores, deadlines: DEADLINES, recover: true, recoveryGraceMs: 20_000 });
  const report = await arenaB.ready;
  assert.equal(report?.resumed, 1, 'the mid-match orphan was RESUMED (not aborted)');
  const urlB = `ws://127.0.0.1:${await listen(serverB)}/v1/arena`;

  // ---- reconnect both agents by passport ----
  const ra = new Client(urlB);
  await ra.open();
  ra.autoplay(HOLD);
  ra.send(helloFrame(A.token));
  const rb = new Client(urlB);
  await rb.open();
  rb.autoplay(HOLD);
  rb.send(helloFrame(B.token));

  // The contract: ack{match_id} immediately, then the current-tick observation.
  const ackA = await ra.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
  assert.equal(ackA.match_id, matchId, 'reconnect re-binds to the resumed match by passport (not match_id)');
  const resumeObs = await ra.waitFor((f) => f.t === 'observation');
  assert.equal(resumeObs.match_id, matchId, 'the resume cursor observation follows the ack');
  const ackB = await rb.waitFor((f) => f.t === 'ack' && f.ack_type === 'session');
  assert.equal(ackB.match_id, matchId);

  // ---- play to completion; assert the outcome is recorded exactly once ----
  const end = await ra.waitFor((f) => f.t === 'match_end', 20_000);
  assert.equal(end.match_id, matchId, 'the resumed match reached a terminal state');
  assert.equal('payout' in end, false, 'match_end carries no economy fields (contracts 2.0.0)');
  assert.equal('refund' in end, false);

  const settled = await stores.matchEvents.getManifest(matchId);
  assert.equal(settled?.status, 'settled', 'resumed match settled exactly once');
  assert.equal(settled?.winner, end.winner, 'the durable outcome is the one the agents saw');
  // A second CAS (a racing recovery abort) must lose.
  const late = await stores.matchEvents.casStatus(matchId, ['starting', 'live'], 'aborted');
  assert.equal(late.ok, false);

  ra.close();
  rb.close();
  await arenaB.close();
  await new Promise<void>((r) => serverB.close(() => r()));
  await new Promise<void>((r) => serverA.close(() => r()));
});
