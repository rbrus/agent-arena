/**
 * OUTCOME-DECIDED-ONCE ACROSS RESTART (Phase 5 B5 / C1 — resilience-and-review.md
 * §1.4, reduced by ADR-001: nothing is staked, so there are no Token legs).
 *
 * Simulates an engine restart mid-match by persisting ONLY the durable
 * MatchEventStore (tick log + manifest), dropping all in-memory match state, and
 * running the boot recovery scan. Asserts the recovery axioms:
 *   (a) RESUME  — a match whose durable log folds to a terminal state records its
 *                 outcome EXACTLY once (the state-hash chain is verified), with the
 *                 re-derived winner and replay hash on the summary.
 *   (b) CLEAN-FAIL — a mid-match crash with no resume window is marked `aborted`
 *                 (`aborted_conserving`), with no winner.
 *   (c) IDEMPOTENT — re-running the scan changes nothing.
 *   (d) SETTLE XOR ABORT — a finish racing an abort yields exactly ONE terminal
 *                 outcome; the CAS loser records nothing.
 *   (e) NEVER-INVENT — a durable log that does not verify is clean-failed, never
 *                 settled to a fabricated winner.
 *   (f) BRING-UP CRASH — a manifest still `starting` (no ticks) is aborted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStores, leagueBudget, type League, type Stores } from 'wot-store';
import {
  createInitialState,
  foldHash,
  isTerminal,
  resimulate,
  resolveTick,
  stateHash,
  type TickActions,
} from 'wot-engine';
import { runRecoveryScan } from '../src/recovery.ts';

const ts = (n: number): string => new Date(Date.UTC(2026, 6, 20) + n * 1000).toISOString();
const noLog = (): void => undefined;

interface SeedOpts {
  matchId: string;
  seed: number;
  league: League;
  agentA: string;
  agentB: string;
  live?: boolean;
}

/** Write the manifest (`starting`) → CAS to `live`, exactly as arena.ts does. */
async function seedMatch(stores: Stores, o: SeedOpts): Promise<void> {
  const at = ts(2);
  await stores.matchEvents.putManifest({
    matchId: o.matchId,
    mode: 'duel',
    seed: o.seed,
    league: o.league,
    status: 'starting',
    startedAt: at,
    updatedAt: at,
    sides: [
      { player: 'A', agentId: o.agentA, ownerId: `own_${o.agentA}` },
      { player: 'B', agentId: o.agentB, ownerId: `own_${o.agentB}` },
    ],
  });
  if (o.live !== false) await stores.matchEvents.casStatus(o.matchId, ['starting'], 'live');
}

/** Fold action pairs through the pure engine and append each resolved tick durably
 *  (exactly as match.ts does), stopping at terminal. Returns the tick count. */
async function buildDurableLog(
  stores: Stores,
  args: { matchId: string; seed: number; league: League; maxTicks: number },
): Promise<{ ticks: number; terminal: boolean }> {
  const allowance = leagueBudget(args.league).budgets.action_allowance;
  let state = createInitialState(args.seed, { matchId: args.matchId, config: { allowance } });
  let chain = stateHash(state);
  let ticks = 0;
  const hold: TickActions = { A: [], B: [] };
  for (let i = 0; i < args.maxTicks; i++) {
    const turnId = state.tick;
    state = resolveTick(state, hold);
    chain = foldHash(chain, stateHash(state));
    await stores.matchEvents.appendTick(args.matchId, { tick: turnId, input: hold, hash: chain });
    ticks += 1;
    if (isTerminal(state).over) break;
  }
  return { ticks, terminal: isTerminal(state).over };
}

test('(a) RESUME: a terminal durable log records its outcome EXACTLY once', async () => {
  const stores = createStores();
  const matchId = 'mat_resume';
  const seed = 12345;
  await seedMatch(stores, { matchId, seed, league: 'core', agentA: 'agt_A', agentB: 'agt_B' });
  const log = await buildDurableLog(stores, { matchId, seed, league: 'core', maxTicks: 300 });
  assert.equal(log.terminal, true, 'durable log should fold to a terminal state');

  const report = await runRecoveryScan({ stores, log: noLog, now: () => ts(500) });
  assert.equal(report.settled, 1, 'exactly one match settled');
  assert.equal(report.aborted, 0, 'no abort on the resume path');

  // The recorded outcome is the one the pure engine re-derives from the log.
  const allowance = leagueBudget('core').budgets.action_allowance;
  const ticks = await stores.matchEvents.loadTicks(matchId);
  const resim = resimulate(seed, ticks.map((t) => t.input as TickActions), { matchId, config: { allowance } });
  const manifest = await stores.matchEvents.getManifest(matchId);
  assert.equal(manifest?.status, 'settled');
  assert.equal(manifest?.winner, resim.terminal.winner ?? 'draw');
  assert.equal(manifest?.settledAt, ts(500));
  const summary = await stores.matches.getSummary(matchId);
  assert.equal(summary?.status, 'completed');
  assert.equal(summary?.replay_hash, resim.replayHash);
  assert.equal(summary?.recovered, true);
  assert.equal('payout' in (summary ?? {}), false, 'no economy fields on the summary');
});

test('(b) CLEAN-FAIL: a mid-match crash with no resume window is aborted, no winner', async () => {
  const stores = createStores();
  const matchId = 'mat_abort';
  const seed = 777;
  await seedMatch(stores, { matchId, seed, league: 'core', agentA: 'agt_A', agentB: 'agt_B' });
  // Only a few ticks resolved before the crash — NON-terminal (un-resumable here).
  const log = await buildDurableLog(stores, { matchId, seed, league: 'core', maxTicks: 3 });
  assert.equal(log.terminal, false, 'the crash is mid-match (non-terminal)');

  // No resumeLive hook → the resume grace window is unavailable → abort.
  const report = await runRecoveryScan({ stores, log: noLog, now: () => ts(500) });
  assert.equal(report.aborted, 1);
  assert.equal(report.settled, 0);
  assert.equal(report.outcomes[0].reason, 'no_resume_window');

  const manifest = await stores.matchEvents.getManifest(matchId);
  assert.equal(manifest?.status, 'aborted');
  assert.equal(manifest?.abortReason, 'aborted_conserving');
  assert.equal(manifest?.winner, undefined, 'an aborted match has no winner');
  const summary = await stores.matches.getSummary(matchId);
  assert.equal(summary?.status, 'aborted');
  assert.equal(summary?.winner, undefined);
});

test('(c) IDEMPOTENT: re-running the recovery scan changes nothing', async () => {
  const stores = createStores();
  // One resumable+terminal and one abort match in the same store.
  await seedMatch(stores, { matchId: 'mat_r', seed: 42, league: 'core', agentA: 'agt_A', agentB: 'agt_B' });
  await buildDurableLog(stores, { matchId: 'mat_r', seed: 42, league: 'core', maxTicks: 300 });
  await seedMatch(stores, { matchId: 'mat_x', seed: 43, league: 'core', agentA: 'agt_C', agentB: 'agt_D' });
  await buildDurableLog(stores, { matchId: 'mat_x', seed: 43, league: 'core', maxTicks: 3 });

  const first = await runRecoveryScan({ stores, log: noLog, now: () => ts(500) });
  assert.equal(first.settled + first.aborted, 2);
  const manifests1 = JSON.stringify(await stores.matchEvents.allManifests());

  // Re-run the ENTIRE scan (simulating a crash mid-recovery, then a re-boot).
  const second = await runRecoveryScan({ stores, log: noLog, now: () => ts(600) });
  assert.equal(second.scanned, 0, 'no open manifests remain — nothing to reconcile');
  assert.equal(JSON.stringify(await stores.matchEvents.allManifests()), manifests1, 'manifests unchanged by the second scan');
});

test('(d) SETTLE XOR ABORT: a finish racing an abort yields exactly one terminal outcome', async () => {
  const stores = createStores();
  const matchId = 'mat_race';
  await seedMatch(stores, { matchId, seed: 9, league: 'core', agentA: 'agt_A', agentB: 'agt_B' });

  // The finish wins the CAS (live → settled) and records the winner.
  const settleCas = await stores.matchEvents.casStatus(matchId, ['live'], 'settled', { winner: 'A' });
  assert.equal(settleCas.ok, true);

  // The recovery abort LOSES the CAS (status is already `settled`) → records nothing.
  const abortCas = await stores.matchEvents.casStatus(matchId, ['starting', 'live'], 'aborted', { abortReason: 'aborted_conserving' });
  assert.equal(abortCas.ok, false, 'the abort CAS must lose to the completed settle');
  const manifest = await stores.matchEvents.getManifest(matchId);
  assert.equal(manifest?.status, 'settled');
  assert.equal(manifest?.winner, 'A');
  assert.equal(manifest?.abortReason, undefined);
});

test('(d2) reverse race: abort wins the CAS, a late finish records nothing', async () => {
  const stores = createStores();
  const matchId = 'mat_race2';
  await seedMatch(stores, { matchId, seed: 9, league: 'core', agentA: 'agt_A', agentB: 'agt_B' });
  await buildDurableLog(stores, { matchId, seed: 9, league: 'core', maxTicks: 3 }); // non-terminal

  // Recovery aborts first (CAS live → aborted wins).
  const report = await runRecoveryScan({ stores, log: noLog, now: () => ts(500) });
  assert.equal(report.aborted, 1);

  // A late in-memory finish tries to record a winner — its CAS(live → settled) loses.
  const lateCas = await stores.matchEvents.casStatus(matchId, ['live'], 'settled', { winner: 'A' });
  assert.equal(lateCas.ok, false, 'the late finish CAS must lose to the completed abort');
  const manifest = await stores.matchEvents.getManifest(matchId);
  assert.equal(manifest?.status, 'aborted');
  assert.equal(manifest?.winner, undefined);
});

test('(e) NEVER-INVENT: a durable log that fails chain verification is aborted, not settled', async () => {
  const stores = createStores();
  const matchId = 'mat_corrupt';
  await seedMatch(stores, { matchId, seed: 100, league: 'core', agentA: 'agt_A', agentB: 'agt_B' });
  const log = await buildDurableLog(stores, { matchId, seed: 100, league: 'core', maxTicks: 300 });
  assert.equal(log.terminal, true, 'the log IS terminal — it would settle if it verified');
  // Corrupt the durable checkpoint: append a post-terminal tick with a bogus chain
  // hash so the last recorded checkpoint no longer matches the re-folded chain.
  await stores.matchEvents.appendTick(matchId, { tick: 999_999, input: { A: [], B: [] }, hash: 'corrupt_checkpoint' });

  const report = await runRecoveryScan({ stores, log: noLog, now: () => ts(500) });
  assert.equal(report.settled, 0, 'never settle a log that does not verify');
  assert.equal(report.aborted, 1, 'clean-fail instead');
  assert.equal(report.outcomes[0].reason, 'hash_mismatch');
  assert.equal((await stores.matchEvents.getManifest(matchId))?.winner, undefined);
});

test('(f) BRING-UP CRASH: a manifest still `starting` is aborted', async () => {
  const stores = createStores();
  const matchId = 'mat_boot';
  await seedMatch(stores, { matchId, seed: 5, league: 'core', agentA: 'agt_A', agentB: 'agt_B', live: false });
  const report = await runRecoveryScan({ stores, log: noLog, now: () => ts(500) });
  assert.equal(report.aborted, 1);
  assert.equal(report.outcomes[0].reason, 'no_tick_log');
  assert.equal((await stores.matchEvents.getManifest(matchId))?.status, 'aborted');
});
