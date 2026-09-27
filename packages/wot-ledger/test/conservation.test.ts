/**
 * CONSERVATION of budget accounting (ADR-001; the ledger's surviving invariant):
 *   Over ANY sequence of grants and per-tick consumptions —
 *   (a) every journal's legs sum to 0,
 *   (b) Σ over ALL accounts == 0 (closed double-entry system),
 *   (c) outstanding allowance (Σ budget accounts) changes ONLY through the
 *       budget faucet and the consumption sink, and reconciles exactly to
 *       (granted − consumed),
 *   (d) every journal references an episode and a tick,
 *   (e) no seat's budget ever goes negative (an overspend is refused whole).
 *   Fuzzed over random sequences and seeds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStores, ledgerAccountKind, type PostedJournal } from 'wot-store';
import {
  BudgetLedger,
  BUDGET_TIERS,
  InsufficientBalanceError,
  budget,
  budgetTierLimits,
  ledgerConserves,
} from '../src/index.ts';
import { classify, makeEpisodes, mulberry32, pick, randInt, ts } from './harness.ts';

const SEATS = ['A', 'B', 'm0', 'm1'];

async function sumWhere(
  store: ReturnType<typeof createStores>['ledger'],
  keep: (kind: string | null) => boolean,
): Promise<number> {
  let s = 0;
  for (const acct of await store.accounts()) {
    if (keep(ledgerAccountKind(acct))) s += await store.balanceOf(acct);
  }
  return s;
}

test('conservation: balanced journals, zero-sum, allowance moves only via faucet → budget → sink', async () => {
  for (const seed of [1, 2, 7, 42, 99, 2718, 31415]) {
    const rng = mulberry32(seed);
    const { ledger: store } = createStores();
    const led = new BudgetLedger(store);
    const episodes = makeEpisodes(4);
    let clock = 0;
    let refused = 0;

    // Grant every seat its tier allowance.
    for (const ep of episodes) {
      const allowance = budgetTierLimits(pick(rng, BUDGET_TIERS)).token_allowance;
      for (const seat of SEATS) await led.grant({ episodeId: ep, seat, amount: allowance, at: ts(clock++) });
    }

    const tick: Record<string, number> = {};
    for (let step = 0; step < 200; step++) {
      const ep = pick(rng, episodes);
      const seat = pick(rng, SEATS);
      const key = `${ep}/${seat}`;
      tick[key] = (tick[key] ?? 0) + randInt(rng, 1, 3);
      const amount = randInt(rng, 1, 12);
      const before = await store.balanceOf(budget(ep, seat));
      try {
        await led.consume({ episodeId: ep, seat, tick: tick[key], amount, at: ts(clock++) });
        assert.ok(before >= amount, `seed ${seed}: an overspend was accepted`);
      } catch (e) {
        assert.ok(e instanceof InsufficientBalanceError, `seed ${seed}: unexpected ${String(e)}`);
        assert.ok(before < amount);
        assert.equal(await store.balanceOf(budget(ep, seat)), before, `seed ${seed}: a refused consume mutated state`);
        refused += 1;
      }
    }

    const journals: PostedJournal[] = await store.allJournals();
    let granted = 0;
    let consumed = 0;
    for (const j of journals) {
      const c = classify(j);
      assert.equal(c.total, 0, `seed ${seed}: journal ${j.journalId} legs sum ${c.total} ≠ 0`);
      assert.ok(c.touchesFaucetSink, `seed ${seed}: a journal moved allowance without the faucet or sink`);
      assert.equal(c.budgetDelta, c.granted - c.consumed, `seed ${seed}: outstanding delta mismatch`);
      assert.equal(j.ref.kind, 'episode');
      assert.ok(j.ref.episode_id.length > 0 && Number.isInteger(j.ref.tick) && j.ref.tick >= 0, `seed ${seed}: journal without episode+tick`);
      granted += c.granted;
      consumed += c.consumed;
    }

    assert.equal(await sumWhere(store, () => true), 0, `seed ${seed}: Σ over ALL accounts ≠ 0`);
    assert.equal(await ledgerConserves(store), true);
    const outstanding = await sumWhere(store, (k) => k === 'budget');
    assert.equal(-(await sumWhere(store, (k) => k === 'faucet')), granted, `seed ${seed}: faucet ≠ granted`);
    assert.equal(await sumWhere(store, (k) => k === 'sink'), consumed, `seed ${seed}: sink ≠ consumed`);
    assert.equal(outstanding, granted - consumed, `seed ${seed}: outstanding ≠ granted − consumed`);

    for (const ep of episodes) {
      for (const seat of SEATS) assert.ok((await store.balanceOf(budget(ep, seat))) >= 0, `seed ${seed}: negative budget`);
    }
    void refused;
  }
});

test('journals without an episode+tick reference, unbalanced or non-integer journals are refused', async () => {
  const { ledger: store } = createStores();
  const legs = [
    { account: 'faucet:budget', amount: -10, type: 'grant' as const },
    { account: budget('mat_x', 'A'), amount: 10, type: 'grant' as const },
  ];
  // No tick.
  await assert.rejects(store.post({ ref: { kind: 'episode', episode_id: 'mat_x' } as never, idempotencyKey: 'r1', legs, ts: ts(0) }));
  // Negative tick.
  await assert.rejects(store.post({ ref: { kind: 'episode', episode_id: 'mat_x', tick: -1 }, idempotencyKey: 'r2', legs, ts: ts(0) }));
  // Not an episode.
  await assert.rejects(store.post({ ref: { kind: 'match', match_id: 'mat_x' } as never, idempotencyKey: 'r3', legs, ts: ts(0) }));
  // Unbalanced.
  await assert.rejects(
    store.post({
      ref: { kind: 'episode', episode_id: 'mat_x', tick: 0 },
      idempotencyKey: 'r4',
      legs: [legs[0], { ...legs[1], amount: 9 }],
      ts: ts(0),
    }),
  );
  // Non-integer.
  await assert.rejects(
    store.post({
      ref: { kind: 'episode', episode_id: 'mat_x', tick: 0 },
      idempotencyKey: 'r5',
      legs: [{ ...legs[0], amount: -1.5 }, { ...legs[1], amount: 1.5 }],
      ts: ts(0),
    }),
  );
  // Unknown account kind (the economy-era wallet/escrow accounts are gone).
  await assert.rejects(
    store.post({
      ref: { kind: 'episode', episode_id: 'mat_x', tick: 0 },
      idempotencyKey: 'r6',
      legs: [legs[0], { account: 'wallet:agt_x', amount: 10, type: 'grant' }],
      ts: ts(0),
    }),
  );
  assert.equal((await store.accounts()).length, 0, 'no partial state from rejected posts');
});
