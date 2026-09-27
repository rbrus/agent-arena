/**
 * Diplomacy table lifecycle (Phase 9 hosted-beta hardening; docs/phase-9/CHAOS-DIPLOMACY.md D-2, O-1):
 *  - seat-arrival deadline: a table not fully seated within `seatTimeoutMs` closes every connected
 *    seat 4408 (CLOSE.SEAT_TIMEOUT), sends no observation, invents no result, and is released;
 *  - a table seated in time is not affected by the deadline;
 *  - end grace: an ended table stays readable in full for `endGraceMs`, then `getTable()` answers
 *    with the sink's summary;
 *  - result sink: capped ring (oldest evicted), the seal hook's detail re-simulates to the summary
 *    hashes, a throwing / rejecting hook never breaks the table's end;
 *  - arena shutdown hands an aborted summary (1012, terminal null) to the sink.
 *
 * Run: cd ascension && WOT_ENV=test node --test --import tsx services/arena/test/diplomacy-lifecycle.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POWERS, resimulateDip, type Power } from 'wot-engine';
import { CLOSE, DEFAULT_SEAT_TIMEOUT_MS, memoryResultSink, type TableResultDetail, type TableResultSummary } from '../src/index.ts';
import { defaultEndGraceMs, type TableLookup } from '../src/diplomacy/lobby.ts';
import type { DiplomacyTable } from '../src/diplomacy/table.ts';
import { dipPassport } from './diplomacy-helpers.ts';
import { ChaosSeat, chaosSetup, sleep, type ChaosHarness } from './chaos-helpers.ts';

type Seats = Parameters<ChaosHarness['arena']['diplomacy']['createTable']>[0]['seats'];
const houseOnly = Object.fromEntries(POWERS.map((p) => [p, { kind: 'house' }])) as Seats;
const isLive = (x: TableLookup | undefined): x is DiplomacyTable => x !== undefined && !('kind' in x);

async function twoAgentTable(h: ChaosHarness, over: { seatTimeoutMs?: number } = {}) {
  const fr = await dipPassport(h);
  const ge = await dipPassport(h);
  const seats = Object.fromEntries(
    POWERS.map((p): [Power, Seats[Power]] => [p, p === 'france' ? { kind: 'agent', agentId: fr.agentId } : p === 'germany' ? { kind: 'agent', agentId: ge.agentId } : { kind: 'house' }]),
  ) as Seats;
  const table = h.arena.diplomacy.createTable({ seed: 7, cls: 'core', horizonYear: 1901, seats, ...over });
  const A = new ChaosSeat(h.url, 'france', null, { token: fr.token, tableId: table.tableId });
  const B = new ChaosSeat(h.url, 'germany', null, { token: ge.token, tableId: table.tableId });
  return { table, A, B };
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await sleep(10);
  }
}

test('defaults: seat-arrival deadline 120 s; end grace 30 s outside WOT_ENV=test, 0 under it; 4408 is the seat-timeout close', () => {
  assert.equal(DEFAULT_SEAT_TIMEOUT_MS, 120_000);
  assert.equal(defaultEndGraceMs({ WOT_ENV: 'test' }), 0);
  assert.equal(defaultEndGraceMs({}), 30_000);
  assert.equal(defaultEndGraceMs({ WOT_ENV: 'production' }), 30_000);
  assert.equal(defaultEndGraceMs({ WOT_ENV: 'development' }), 30_000);
  assert.equal(CLOSE.SEAT_TIMEOUT, 4408);
});

test('seat-arrival deadline: one of two agent seats never connects → the connected seat is closed 4408 with no observation; the table is released with a seat_timeout summary', { timeout: 30_000 }, async () => {
  const got: TableResultSummary[] = [];
  const h = await chaosSetup({ quietLog: true, tables: { seatTimeoutMs: 300, results: memoryResultSink({ onResult: (s) => void got.push(s) }) } });
  try {
    const { table, A, B } = await twoAgentTable(h);
    const c = await A.connect();
    await A.waitFor((f) => f.t === 'ack' && f.ack_type === 'session', 5000);
    const closed = await c.closed;
    assert.equal(closed.code, 4408, 'the connected seat is closed with the seat-timeout code');
    assert.equal(closed.reason, 'seat_timeout');
    assert.equal(A.of('diplomacy_observation').length, 0, 'no observation before every seat connected');
    assert.equal(A.of('diplomacy_episode_end').length, 0, 'no episode_end is invented');
    assert.equal(table.isEnded, true);
    assert.equal(table.isStarted, false);
    assert.equal(table.result().terminal, null);
    assert.equal(h.arena.diplomacy.liveTables, 0, 'the table is released');
    const s = h.arena.diplomacy.getTable(table.tableId);
    assert.ok(s && !isLive(s), 'getTable answers with the summary');
    assert.equal(s.cause, 'seat_timeout');
    assert.equal(s.closeCode, 4408);
    assert.equal(s.terminal, null);
    assert.equal(s.ticks, 0);
    assert.deepEqual(got.map((x) => x.tableId), [table.tableId]);
    // The late seat is refused like an unknown table (no enumeration oracle).
    const late = await B.connect();
    assert.equal((await late.closed).code, 4403);
  } finally {
    await h.close();
  }
});

test('seat-arrival deadline: a per-table seatTimeoutMs overrides the arena default; a table with no seat connected at all is also released', { timeout: 30_000 }, async () => {
  const h = await chaosSetup({ quietLog: true, tables: { seatTimeoutMs: 600_000 } });
  try {
    const { table } = await twoAgentTable(h, { seatTimeoutMs: 150 });
    await until(() => table.isEnded, 5000);
    assert.equal(table.endCause?.cause, 'seat_timeout');
    assert.equal(h.arena.diplomacy.liveTables, 0);
    assert.equal(h.arena.diplomacy.getResult(table.tableId)?.cause, 'seat_timeout');
  } finally {
    await h.close();
  }
});

test('seat-arrival deadline: a table seated in time starts and the deadline never fires; a seat that drops mid-table does not re-arm it', { timeout: 30_000 }, async () => {
  const h = await chaosSetup({ quietLog: true, tables: { seatTimeoutMs: 400 } });
  try {
    const { table, A, B } = await twoAgentTable(h);
    const ca = await A.connect();
    const cb = await B.connect();
    await A.waitFor((f) => f.t === 'diplomacy_observation', 5000);
    await B.waitFor((f) => f.t === 'diplomacy_observation', 5000);
    assert.equal(table.isStarted, true);
    B.closeAll(); // Germany drops after the start: a miss, never a seat timeout
    await cb.closed;
    await sleep(700);
    assert.equal(table.isEnded, false, 'the started table is not aborted by the arrival deadline');
    assert.equal(ca.closeInfo, null, 'France is still connected');
    assert.equal(isLive(h.arena.diplomacy.getTable(table.tableId)), true);
  } finally {
    await h.close();
  }
});

test('end grace: an ended table stays readable in full for endGraceMs, then getTable returns the summary', { timeout: 60_000 }, async () => {
  const h = await chaosSetup({ quietLog: true, tables: { endGraceMs: 400 } });
  try {
    const t = h.arena.diplomacy.createTable({ seed: 31, horizonYear: 1901, seats: houseOnly });
    await until(() => t.isEnded, 30_000);
    const during = h.arena.diplomacy.getTable(t.tableId);
    assert.ok(isLive(during), 'inside the grace the live (ended) table is returned');
    assert.equal(h.arena.diplomacy.getResult(t.tableId)?.replayHash, t.result().replayHash, 'the sink already holds the summary');
    await until(() => h.arena.diplomacy.liveTables === 0, 5000);
    const after = h.arena.diplomacy.getTable(t.tableId);
    assert.ok(after && !isLive(after));
    assert.equal(after.replayHash, t.result().replayHash);
    assert.equal(after.transcriptHash, t.result().transcriptHash);
    assert.deepEqual(after.terminal, t.result().terminal);
    assert.equal(after.cause, 'terminal');
  } finally {
    await h.close();
  }
});

test('result sink: capped ring evicts the oldest; the seal detail re-simulates to the summary hashes; a throwing or rejecting hook never breaks the end', { timeout: 120_000 }, async () => {
  const details: TableResultDetail[] = [];
  const order: string[] = [];
  let calls = 0;
  const sink = memoryResultSink({
    cap: 3,
    onResult: (s, d) => {
      calls++;
      order.push(s.tableId);
      details.push(d);
      if (calls === 2) throw new Error('seal store down');
      if (calls === 3) return Promise.reject(new Error('seal store slow and down'));
    },
  });
  const h = await chaosSetup({ quietLog: true, tables: { results: sink } });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(h.arena.diplomacy.createTable({ seed: 50 + i, horizonYear: 1901, seats: houseOnly }).tableId);
    await until(() => h.arena.diplomacy.liveTables === 0, 60_000);
    assert.equal(calls, 5, 'every ended table reached the hook, including those after a failure');
    assert.deepEqual([...order].sort(), [...ids].sort());
    assert.equal(sink.size, 3, 'the ring holds `cap` summaries');
    // Hook order == end order == ring order: the two oldest ended tables are evicted.
    for (const id of order.slice(0, 2)) {
      assert.equal(sink.get(id), undefined);
      assert.equal(h.arena.diplomacy.getTable(id), undefined, 'an evicted, released table is unknown');
    }
    for (const [i, id] of order.entries()) {
      if (i < 2) continue;
      const s = sink.get(id);
      assert.ok(s, 'the three newest are held');
      const d = details[i];
      assert.equal(d.result.episodeId, s.episodeId);
      const re = resimulateDip(d.recording.seed, d.recording.cls, d.recording.overrides, d.recording.inputs);
      assert.equal(re.chain, s.replayHash, 'seal detail re-simulates to the summary replay_hash');
      assert.equal(re.transcript, s.transcriptHash);
      assert.deepEqual(h.arena.diplomacy.getTable(id), s);
    }
  } finally {
    await h.close();
  }
});

test('shutdown: arena close hands an aborted summary (1012, terminal null) to the sink; seats are closed 1012', { timeout: 30_000 }, async () => {
  const got: TableResultSummary[] = [];
  const h = await chaosSetup({ quietLog: true, tables: { results: memoryResultSink({ onResult: (s) => void got.push(s) }) } });
  let closedH = false;
  try {
    const { table, A, B } = await twoAgentTable(h);
    const ca = await A.connect();
    await B.connect();
    await A.waitFor((f) => f.t === 'diplomacy_observation', 5000);
    await h.close();
    closedH = true;
    assert.equal((await ca.closed).code, 1012);
    assert.equal(got.length, 1);
    assert.equal(got[0].tableId, table.tableId);
    assert.equal(got[0].cause, 'shutdown');
    assert.equal(got[0].closeCode, 1012);
    assert.equal(got[0].terminal, null, 'no result is invented for an interrupted table');
  } finally {
    if (!closedH) await h.close();
  }
});
