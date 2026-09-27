/**
 * DERIVATION: balances and usage totals are DERIVED from the append-only
 * journal, never stored. balanceOf(account) equals an independent fold of the
 * account's legs; BudgetLedger.usage() equals an independent fold of the grant
 * and consume journals for that seat; an overspend is refused and leaves the
 * seat's remaining allowance unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStores } from 'wot-store';
import { BudgetLedger, InsufficientBalanceError, budget, budgetTierLimits } from '../src/index.ts';
import { makeEpisodes, mulberry32, pick, randInt, ts } from './harness.ts';

test('balanceOf and usage() equal independent folds of the journal', async () => {
  const rng = mulberry32(777);
  const { ledger: store } = createStores();
  const led = new BudgetLedger(store);
  const episodes = makeEpisodes(3);
  const seats = ['A', 'B'];
  const allowance = budgetTierLimits('core').token_allowance;
  let clock = 0;

  for (const ep of episodes) for (const seat of seats) await led.grant({ episodeId: ep, seat, amount: allowance, at: ts(clock++) });
  for (let t = 1; t <= 120; t++) {
    const ep = pick(rng, episodes);
    const seat = pick(rng, seats);
    await led.consume({ episodeId: ep, seat, tick: t, amount: randInt(rng, 1, 4), at: ts(clock++) }).catch(() => undefined);
  }

  const foldByAccount = new Map<string, number>();
  const expected = new Map<string, { granted: number; consumed: number; ticks: number[] }>();
  for (const j of await store.allJournals()) {
    for (const l of j.legs) foldByAccount.set(l.account, (foldByAccount.get(l.account) ?? 0) + l.amount);
    const key = `${j.ref.episode_id}/${j.ref.seat}`;
    const e = expected.get(key) ?? { granted: 0, consumed: 0, ticks: [] };
    for (const l of j.legs) {
      if (!l.account.startsWith('budget:')) continue;
      if (l.type === 'grant') e.granted += l.amount;
      else {
        e.consumed -= l.amount;
        e.ticks.push(j.ref.tick);
      }
    }
    expected.set(key, e);
  }
  for (const [account, sum] of foldByAccount) {
    assert.equal(await store.balanceOf(account), sum, `balanceOf(${account}) ≠ folded sum`);
  }
  for (const ep of episodes) {
    for (const seat of seats) {
      const u = await led.usage(ep, seat);
      const e = expected.get(`${ep}/${seat}`)!;
      assert.equal(u.granted, e.granted);
      assert.equal(u.consumed, e.consumed);
      assert.equal(u.remaining, e.granted - e.consumed);
      assert.equal(u.remaining, await store.balanceOf(budget(ep, seat)));
      assert.deepEqual(u.ticks, [...e.ticks].sort((a, b) => a - b));
    }
  }
});

test('an overspend is refused and the seat never goes negative', async () => {
  const { ledger: store } = createStores();
  const led = new BudgetLedger(store);
  const [ep] = makeEpisodes(1);
  await led.grant({ episodeId: ep, seat: 'A', amount: 30, at: ts(0) });
  await led.consume({ episodeId: ep, seat: 'A', tick: 1, amount: 25, at: ts(1) });
  await assert.rejects(
    led.consume({ episodeId: ep, seat: 'A', tick: 2, amount: 6, at: ts(2) }),
    (e: unknown) => e instanceof InsufficientBalanceError,
  );
  const u = await led.usage(ep, 'A');
  assert.deepEqual({ granted: u.granted, consumed: u.consumed, remaining: u.remaining }, { granted: 30, consumed: 25, remaining: 5 });
  // Consuming from a seat that was never granted is refused too.
  await assert.rejects(led.consume({ episodeId: ep, seat: 'B', tick: 1, amount: 1, at: ts(3) }));
});

test('invalid inputs are refused before anything is posted', async () => {
  const { ledger: store } = createStores();
  const led = new BudgetLedger(store);
  const [ep] = makeEpisodes(1);
  await assert.rejects(led.grant({ episodeId: ep, seat: 'A', amount: 0 }));
  await assert.rejects(led.grant({ episodeId: ep, seat: 'A/B', amount: 10 }));
  await assert.rejects(led.grant({ episodeId: 'bad:id', seat: 'A', amount: 10 }));
  await led.grant({ episodeId: ep, seat: 'A', amount: 10 });
  await assert.rejects(led.consume({ episodeId: ep, seat: 'A', tick: -1, amount: 1 }));
  await assert.rejects(led.consume({ episodeId: ep, seat: 'A', tick: 1.5, amount: 1 }));
  await assert.rejects(led.consume({ episodeId: ep, seat: 'A', tick: 1, amount: 0 }));
  assert.equal((await store.allJournals()).length, 1);
});
