/**
 * The cost meter: per-game hard stop (recorded as an episode abort), broken counters, and the
 * monthly cap accumulator (admission, alerts, reservation release, month rollover).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReportSchema } from 'arena-report';
import { brokenMeterPeer, CapExhaustedError, definePeer, fakePeer, MonthlyCostCap, runTable, verifyTableReport, type CapAlert } from '../src/index.ts';
import { detOpts, table, threeModelTable } from './helpers.ts';

test('the per-game budget is a hard stop: budget_exceeded, recorded as an aborted episode, still verifiable', async () => {
  const full = await threeModelTable();
  const perTick = full.cost.total_chf / full.reports[0].report.episodes[0].terminal_tick;
  const budget = perTick * 4.5; // runs out during the fifth tick
  const run = await threeModelTable(20261115, { gameBudgetChf: budget });
  assert.equal(run.outcome, 'budget_exceeded');
  assert.deepEqual(run.record.abort, { tick: run.record.abort!.tick, reason: 'budget_exceeded' });
  assert.ok(run.record.abort!.tick >= 3 && run.record.abort!.tick <= 6, `abort tick ${run.record.abort!.tick}`);
  assert.ok(run.cost.total_chf > budget, 'the stop happens once the total is above the budget');
  const maxTick = Math.max(...Object.values(run.record.log).flatMap((l) => l!.map((e) => e.cost.chf))) * 3;
  assert.ok(run.cost.total_chf - budget <= maxTick + 1e-12, 'overshoot is at most one tick of decisions');
  for (const s of run.reports) {
    const e = s.report.episodes[0];
    assert.ok(validateReportSchema(s.report));
    assert.equal(e.status, 'aborted');
    assert.equal(e.abort_reason, 'harness_error');
    assert.equal(e.outcome, 'aborted');
    assert.equal(e.outcome_reason, 'budget_exceeded');
    assert.equal(e.terminal_tick, run.record.abort!.tick);
    assert.ok(e.oracles.every((o) => o.verdict === 'not_assessed' && o.reason_code === 'episode_aborted'));
    assert.equal(s.report.summary.episodes_aborted, 1);
    assert.ok(s.report.not_assessed?.some((n) => n.kind === 'scenario' && n.reason_code === 'no_episode_completed'));
    const v = verifyTableReport(s.report, run.record);
    assert.equal(v.status, 'verified', JSON.stringify([v.errors, v.episodes[0].diffs.slice(0, 3)]));
  }
  // The decisions of the aborting tick were paid for but never applied.
  assert.ok(Object.values(run.record.log).every((l) => l!.every((e) => e.tick < run.record.abort!.tick)));
});

test('a cost counter that goes backwards stops the game: cost_meter_invalid', async () => {
  const t = table('t-meter', 4, [
    { power: 'germany', peer: brokenMeterPeer(fakePeer('robust', { provider_id: 'alpha', model_id: 'a-1' }), 3) },
    { power: 'italy', peer: fakePeer('house') },
  ]);
  const run = await runTable(t.spec, t.peers, detOpts());
  assert.equal(run.outcome, 'cost_meter_invalid');
  assert.equal(run.record.abort!.tick, 2);
  assert.equal(run.reports[0].report.episodes[0].outcome_reason, 'cost_meter_invalid');
});

test('monthly cap: admission reserves the per-game budget; a game that does not fit calls no peer', async () => {
  let calls = 0;
  const inner = fakePeer('robust');
  const counting = definePeer(inner.meta, async (o, c) => {
    calls++;
    return inner(o, c);
  });
  const cap = new MonthlyCostCap({ capChf: 300, now: () => new Date('2026-10-20T00:00:00Z'), state: { month: '2026-10', spent_chf: 295, alerted: [0.5, 0.8] } });
  const t = table('t-cap', 1, [{ power: 'germany', peer: counting }]);
  await assert.rejects(runTable(t.spec, t.peers, detOpts({ gameBudgetChf: 6, cap })), (e: unknown) => e instanceof CapExhaustedError && e.detail.requested_chf === 6);
  assert.equal(calls, 0);
  const ok = await runTable(t.spec, t.peers, detOpts({ gameBudgetChf: 5, cap }));
  assert.equal(ok.outcome, 'completed');
  assert.ok(calls > 0);
  const snap = cap.snapshot();
  assert.equal(snap.reserved_chf, 0, 'the reservation is released when the game ends');
  assert.ok(Math.abs(snap.spent_chf - (295 + ok.cost.total_chf)) < 1e-9);
});

test('monthly cap: alerts at 50/80/100% fire once per month; open reservations count; a new month starts from zero', () => {
  let now = new Date('2026-10-01T00:00:00Z');
  const alerts: CapAlert[] = [];
  const cap = new MonthlyCostCap({ now: () => now, onAlert: (a) => alerts.push(a) });
  assert.equal(cap.capChf, 300);
  const r1 = cap.admit('g1', 200);
  assert.throws(() => cap.admit('g2', 150), CapExhaustedError, 'spent + reserved + requested must fit');
  r1.spend(120);
  r1.spend(60);
  assert.deepEqual(alerts.map((a) => a.threshold), [0.5]);
  r1.spend(20);
  assert.deepEqual(alerts.map((a) => a.threshold), [0.5]);
  r1.close();
  const r2 = cap.admit('g2', 100);
  r2.spend(40);
  assert.deepEqual(alerts.map((a) => [a.threshold, a.table_id]), [[0.5, 'g1'], [0.8, 'g2']]);
  r2.spend(60);
  assert.deepEqual(alerts.map((a) => a.threshold), [0.5, 0.8, 1]);
  r2.close();
  assert.throws(() => cap.admit('g3', 1), CapExhaustedError, 'at 100% no new game starts');
  now = new Date('2026-11-01T00:00:00Z');
  const r3 = cap.admit('g3', 1);
  r3.close();
  assert.deepEqual(cap.snapshot(), { month: '2026-11', spent_chf: 0, alerted: [], reserved_chf: 0, cap_chf: 300 });
});

test('the meter reads deltas: a peer object reused across games is metered per game', async () => {
  const shared = fakePeer('robust', { provider_id: 'alpha', model_id: 'a-1' });
  const t1 = table('t-r1', 2, [{ power: 'germany', peer: shared }], { horizon_year: 1901 });
  const a = await runTable(t1.spec, t1.peers, detOpts());
  const before = shared.meta.cost.chf;
  const b = await runTable({ ...t1.spec, table_id: 't-r2' }, t1.peers, detOpts());
  assert.ok(Math.abs(a.cost.total_chf - b.cost.total_chf) < 1e-12, 'same game, same metered cost');
  assert.ok(Math.abs(shared.meta.cost.chf - before - b.cost.total_chf) < 1e-12);
  assert.equal(a.cost.by_power.germany!.decisions, a.record.log.germany!.length);
});
