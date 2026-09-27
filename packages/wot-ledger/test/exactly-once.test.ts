/**
 * EXACTLY-ONCE: re-posting the same natural key applies ONCE — the replay
 * returns the original journal and mutates nothing. Covers a retried grant and
 * a re-posted tick (a resumed episode replaying its log must not double-charge).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStores } from 'wot-store';
import { BudgetLedger } from '../src/index.ts';
import { makeEpisodes, ts } from './harness.ts';

test('a retried grant issues the allowance exactly once', async () => {
  const { ledger: store } = createStores();
  const led = new BudgetLedger(store);
  const [ep] = makeEpisodes(1);
  const first = await led.grant({ episodeId: ep, seat: 'A', amount: 240, at: ts(0) });
  const retry = await led.grant({ episodeId: ep, seat: 'A', amount: 240, at: ts(1) });
  assert.equal(first.deduped, false);
  assert.equal(retry.deduped, true);
  assert.equal(retry.journalId, first.journalId);
  assert.equal((await led.usage(ep, 'A')).granted, 240);
  assert.equal((await store.allJournals()).length, 1);
});

test('a re-posted tick is charged exactly once; distinct ticks and seats are independent', async () => {
  const { ledger: store } = createStores();
  const led = new BudgetLedger(store);
  const [ep] = makeEpisodes(1);
  await led.grant({ episodeId: ep, seat: 'A', amount: 100, at: ts(0) });
  await led.grant({ episodeId: ep, seat: 'B', amount: 100, at: ts(0) });

  const t3 = await led.consume({ episodeId: ep, seat: 'A', tick: 3, amount: 7, at: ts(1) });
  const again = await led.consume({ episodeId: ep, seat: 'A', tick: 3, amount: 7, at: ts(2) });
  assert.equal(again.deduped, true);
  assert.equal(again.journalId, t3.journalId);
  await led.consume({ episodeId: ep, seat: 'A', tick: 4, amount: 7, at: ts(3) });
  await led.consume({ episodeId: ep, seat: 'B', tick: 3, amount: 7, at: ts(3) });

  const a = await led.usage(ep, 'A');
  assert.equal(a.consumed, 14, 'tick 3 must not be double-charged');
  assert.deepEqual(a.ticks, [3, 4]);
  assert.equal((await led.usage(ep, 'B')).consumed, 7);
});
