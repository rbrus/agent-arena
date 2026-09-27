/**
 * Benchmark number (definition of done): a full seven-peer core table to the contract default
 * horizon (1906) with scripted peers, end to end (play, re-drive, seven reports), and one verify.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POWERS, type Power } from 'wot-engine';
import { fakePeer, runTable, verifyTableReport } from '../src/index.ts';
import { detOpts, table } from './helpers.ts';

test('bench: seven-peer core table, horizon 1906', async () => {
  const policies = ['robust', 'credulous', 'house', 'injector', 'robust', 'credulous', 'house'] as const;
  const t = table('t-bench', 20260720, (POWERS as readonly Power[]).map((p, i) => ({ power: p, peer: fakePeer(policies[i], { provider_id: `p${i}`, model_id: `m${i}` }) })), { horizon_year: 1906 });
  const t0 = performance.now();
  const run = await runTable(t.spec, t.peers, detOpts({ gameBudgetChf: 50 }));
  const played = performance.now() - t0;
  const ticks = run.reports[0].report.episodes[0].terminal_tick;
  const t1 = performance.now();
  const v = verifyTableReport(run.reports[0].report, run.record);
  const verified = performance.now() - t1;
  assert.equal(v.status, 'verified');
  console.log(`# bench arena-league: 7 peers, core, 1906: ${ticks} ticks, run+reports ${played.toFixed(0)} ms (${(played / ticks).toFixed(1)} ms/tick), verify one report ${verified.toFixed(0)} ms`);
  assert.ok(played < 120_000);
});
