/**
 * runTable: seating, the CLI-identical wire path, determinism, per-seat deadlines and faults.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiplomacyScenario, diplomacyObservationFrame, parseDiplomacyActionFrame } from 'arena-scenarios';
import { validateReportSchema } from 'arena-report';
import { POWERS, type Power } from 'wot-engine';
import { DiplomacyReferenceAgent } from '../../arena-cli/src/reference/diplomacy.ts';
import { definePeer, fakePeer, hangingPeer, runTable, throwingPeer, verifyTableReport, type Peer } from '../src/index.ts';
import { detOpts, sleep, table, threeModelTable } from './helpers.ts';

const KEY = 'a'.repeat(64);

test('a three-model table: one report per peer seat, same game, house diplomats on every unseated power', async () => {
  const run = await threeModelTable();
  assert.equal(run.outcome, 'completed');
  assert.deepEqual(run.reports.map((r) => r.power), ['france', 'germany', 'italy']);
  const hashes = new Set(run.reports.map((r) => r.report.episodes[0].replay_hash));
  assert.equal(hashes.size, 1, 'every perspective report is the same game');
  for (const s of run.reports) {
    const rep = s.report;
    assert.ok(validateReportSchema(rep), JSON.stringify(validateReportSchema.errors?.slice(0, 3)));
    assert.equal(rep.run.spec.seat?.mode, 'power');
    assert.equal((rep.run.spec.seat as { position: string }).position, s.power);
    assert.equal(rep.run.spec.diplomacy?.profile, 'table', 'another seat is a target: the K7 table profile');
    assert.equal(rep.run.spec.labels?.['ng.provider'], s.provider_id);
    const e = rep.episodes[0];
    assert.equal(e.seat, s.power);
    const bySeat = new Map(e.seats!.map((x) => [x.seat, x]));
    for (const p of POWERS as readonly Power[]) {
      const x = bySeat.get(p)!;
      if (['france', 'germany', 'italy'].includes(p)) {
        assert.deepEqual([x.driver, x.inputs_source], ['target', 'recorded'], 'contracts 2.8.0: every Neutral Ground seat is a target');
        assert.equal(x.peer, undefined, 'no peer block: Neutral Ground is not a pack');
      }
      else {
        assert.deepEqual([x.driver, x.inputs_source], ['engine', 'seed_regenerated']);
        assert.equal(x.recorded_inputs, undefined);
      }
    }
    const roster = (e.diplomacy as { roster: { power: string; seat_kind: string; agent?: string }[] }).roster;
    for (const row of roster) {
      if (!['france', 'germany', 'italy'].includes(row.power)) assert.deepEqual([row.seat_kind, row.agent], ['reference', 'house-diplomat']);
    }
    for (const p of ['france', 'germany', 'italy']) assert.equal(roster.find((r) => r.power === p)!.seat_kind, 'target');
    // Recorded inputs: one entry per decision the seat had.
    const decisions = run.record.log[s.power]!.length;
    assert.equal(bySeat.get(s.power)!.recorded_inputs!.decisions, decisions);
    assert.equal(e.budget.decisions, decisions);
  }
  const spec = run.reports.find((r) => r.power === 'germany')!.report.run.spec;
  assert.deepEqual(spec.seats!.map((x) => [x.position, x.driver, (x as { owner?: string }).owner]), [['france', 'target', 'beta'], ['italy', 'target', 'gamma']]);
});

test('deterministic given deterministic peers: identical record and identical report bytes', async () => {
  const a = await threeModelTable();
  const b = await threeModelTable();
  assert.deepEqual(a.record, b.record);
  assert.equal(JSON.stringify(a.reports), JSON.stringify(b.reports));
  const c = await threeModelTable(20261116);
  assert.notEqual(c.record.seed, a.record.seed);
  assert.notEqual(c.reports[0].report.episodes[0].replay_hash, a.reports[0].report.episodes[0].replay_hash);
});

test('the harness drives a seat exactly as the CLI does: same board chain and transcript as DiplomacyScenario fed through the edge', async () => {
  const seed = 7;
  const horizon = 1902;
  // CLI path: the scenario with one external target, the served reference agent answering frames.
  const agent = new DiplomacyReferenceAgent('robust', seed);
  const s = new DiplomacyScenario();
  s.init(seed, 'core', { mode: 'power', targetSeat: 'germany', blindingKey: KEY, diplomacy: { fill: 'house', horizonYear: horizon } });
  const EPI = `epi_${'1'.repeat(26)}`;
  while (!s.terminal()) {
    const t = s.currentTick();
    const nonce = `nonce-${t}-xxxxxxxx`;
    const frame = diplomacyObservationFrame(s.observe('germany'), { episodeId: EPI, nonce });
    const out = agent.respond(frame);
    if (out) {
      const sub = parseDiplomacyActionFrame(JSON.stringify(out), { episodeId: EPI, turnId: t, nonce, power: 'germany' }, 0);
      s.act('germany', sub);
    }
    s.tick();
  }
  // Harness path: the same agent behind `Peer`, alone at the table.
  const t = table('t-cli', seed, [{ power: 'germany', peer: fakePeer('robust', { agentSeed: seed }) }], { horizon_year: horizon });
  const run = await runTable(t.spec, t.peers, detOpts());
  const e = run.reports[0].report.episodes[0];
  assert.equal(e.replay_hash, s.replayHash());
  assert.equal(e.transcript_hash, s.transcriptHash());
  assert.equal(run.reports[0].report.run.spec.diplomacy?.profile, 'clean', 'a single peer is not a K7 table');
  assert.equal(run.reports[0].report.run.spec.seats, undefined);
});

test('seven peers: every power seated, no house diplomat', async () => {
  const policies = ['robust', 'credulous', 'house', 'injector', 'robust', 'credulous', 'house'] as const;
  const seats = (POWERS as readonly Power[]).map((p, i) => ({ power: p, peer: fakePeer(policies[i], { provider_id: `p${i}`, model_id: `m${i}` }) }));
  const t = table('t-seven', 11, seats, { horizon_year: 1901 });
  const run = await runTable(t.spec, t.peers, detOpts());
  assert.equal(run.reports.length, 7);
  for (const s of run.reports) {
    assert.equal(s.report.run.spec.seats!.length, 6);
    assert.ok(s.report.episodes[0].seats!.every((x) => x.driver !== 'engine'));
    assert.equal(verifyTableReport(s.report, run.record).status, 'verified');
  }
  await assert.rejects(runTable({ ...t.spec, seats: [...t.spec.seats, { power: 'austria' }] }, t.peers, detOpts()), /distinct powers/);
});

test('a peer that never answers: hard misses at Dh, civil disorder after three, the others play on', async () => {
  const t = table('t-hang', 3, [
    { power: 'germany', peer: fakePeer('robust') },
    { power: 'russia', peer: hangingPeer({ provider_id: 'slow', model_id: 'slow-1' }) },
  ], { tier: 'edge', horizon_year: 1901 });
  const t0 = Date.now();
  const run = await runTable(t.spec, t.peers, { gameBudgetChf: 1, now: () => new Date('2026-10-05T08:00:00Z') });
  const took = Date.now() - t0;
  const ru = run.record.log.russia!;
  assert.equal(ru.length, 3, 'three hard misses, then the power is forfeited and asked nothing more');
  assert.ok(ru.every((e) => e.fault === 'timeout' && e.miss === 'hard'));
  assert.ok(took < 3 * 1600 + 3000, `the tick never waits past Dh (${took} ms)`);
  const rep = run.reports.find((r) => r.power === 'russia')!.report.episodes[0];
  assert.equal(rep.outcome, 'forfeit');
  assert.equal(rep.budget.hard_deadline_misses, 3);
  const de = run.reports.find((r) => r.power === 'germany')!.report.episodes[0];
  assert.deepEqual((de.diplomacy as { civil_disorder: string[] }).civil_disorder, ['russia']);
  assert.equal(run.record.log.germany!.every((e) => e.miss === 'none'), true, 'a slow peer only hurts itself');
  for (const s of run.reports) assert.equal(verifyTableReport(s.report, run.record).status, 'verified');
});

test('a throwing peer is a hard miss with no retry; a slow answer past Ds is applied as a soft miss', async () => {
  const inner = fakePeer('robust', { provider_id: 'slowish', model_id: 's-1' });
  let n = 0;
  const slowOnce: Peer = definePeer(inner.meta, async (o, c) => {
    if (n++ === 0) await sleep(1000); // edge: Ds 800 ms < 1000 ms < Dh 1600 ms
    return inner(o, c);
  });
  const t = table('t-fault', 5, [
    { power: 'austria', peer: throwingPeer({ provider_id: 'broken', model_id: 'b-1', inner: fakePeer('house'), after: 2 }) },
    { power: 'turkey', peer: slowOnce },
  ], { tier: 'edge', horizon_year: 1901 });
  const run = await runTable(t.spec, t.peers, { gameBudgetChf: 1, now: () => new Date('2026-10-05T08:00:00Z') });
  const au = run.record.log.austria!;
  assert.deepEqual(au.map((e) => e.fault ?? 'ok'), ['ok', 'ok', 'error', 'error', 'error']);
  assert.deepEqual(run.record.actions.austria!.slice(2), [null, null, null]);
  const tu = run.record.log.turkey!;
  assert.equal(tu[0].miss, 'soft');
  assert.notEqual(run.record.actions.turkey![0], null, 'a soft-late answer is applied');
  const te = run.reports.find((r) => r.power === 'turkey')!.report.episodes[0];
  assert.equal(te.budget.soft_deadline_misses, 1);
  for (const s of run.reports) assert.equal(verifyTableReport(s.report, run.record).status, 'verified');
});

test('the CLI edge refuses a malformed answer (recorded as a refusal and a hard miss)', async () => {
  const bad: Peer = definePeer({ provider_id: 'odd', model_id: 'odd-1', region: 'local-harness1', cost: { input_tokens: 0, output_tokens: 0, chf: 0 } }, async () => ({ orders: 'hold everything' }) as never);
  const t = table('t-edge', 9, [{ power: 'england', peer: bad }], { horizon_year: 1901 });
  const run = await runTable(t.spec, t.peers, detOpts());
  const log = run.record.log.england!;
  assert.equal(log[0].reject, 'schema_invalid');
  assert.equal(log[0].miss, 'hard');
  const e = run.reports[0].report.episodes[0];
  assert.equal(e.budget.actions_rejected, log.filter((x) => x.reject).length);
  assert.equal(verifyTableReport(run.reports[0].report, run.record).status, 'verified');
});

test('peer meta is checked before any call: provider slugs only', async () => {
  const p = fakePeer('robust');
  const t = table('t-meta', 1, [{ power: 'germany', peer: p }]);
  (p.meta as { provider_id: string }).provider_id = 'Some Provider (EU)';
  await assert.rejects(runTable(t.spec, t.peers, detOpts()), /provider slug/);
  assert.throws(() => definePeer({ provider_id: 'x', model_id: 'y', region: 'eu', cost: { input_tokens: 0, output_tokens: 0, chf: 0 } }, async () => ({})), /region/);
});
