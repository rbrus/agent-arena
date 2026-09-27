/**
 * The verify path (ADR-004): a table report verifies with every other peer seat listed as
 * "recorded, replayed" (contracts 2.8.0: Neutral Ground seats are driver target, never
 * recorded_peer / llm_peer); a tampered recorded input, a tampered digest, a record that does not
 * fit the RunSpec and a pre-2.8.0 recorded_peer record never verify; recorded peers replay the game.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report } from 'arena-report';
import type { Power } from 'wot-engine';
import { recordedPeer, runTable, verifyTableReport, type TableRecord } from '../src/index.ts';
import { detOpts, threeModelTable } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

test('verifyReport on a table report: verified, house seats regenerated, every peer seat recorded and replayed', async () => {
  const run = await threeModelTable();
  const germany = run.reports.find((r) => r.power === 'germany')!.report;
  const v = verifyTableReport(germany, run.record);
  assert.equal(v.status, 'verified', JSON.stringify([v.errors, v.episodes.map((e) => e.diffs.slice(0, 3))]));
  assert.equal(v.exitCode, 0);
  const label = Object.fromEntries(v.provenance.map((p) => [p.seat, p.label]));
  assert.deepEqual(label, {
    austria: 'regenerated from seed',
    england: 'regenerated from seed',
    france: 'recorded, replayed',
    germany: 'recorded, replayed',
    italy: 'recorded, replayed',
    russia: 'regenerated from seed',
    turkey: 'regenerated from seed',
  });
  assert.ok(v.provenance.filter((p) => p.driver !== 'engine').every((p) => p.inputs_digest === 'match'));
  assert.deepEqual(v.recorded_seats, [
    { episode: 0, seat: 'france', inputs_source: 'recorded' },
    { episode: 0, seat: 'italy', inputs_source: 'recorded' },
  ]);
  assert.ok(!v.unverified.some((u) => u.endsWith('/peer')), 'no peer block: Neutral Ground is not a pack');
  assert.ok(!(germany.not_assessed ?? []).some((n) => n.reason_code === 'recorded_not_regenerated'), 'no seat is recorded-not-regenerable');
});

test('a tampered recorded input is caught', async () => {
  const run = await threeModelTable();
  const report = run.reports.find((r) => r.power === 'germany')!.report;
  // Alter one of france's (another target seat's) recorded moves: an order step with at least one order.
  const rec = clone(run.record) as TableRecord;
  const k = rec.actions.france!.findIndex((a) => Array.isArray(a?.orders) && (a!.orders as unknown[]).length > 0);
  assert.ok(k >= 0);
  const orders = rec.actions.france![k]!.orders as unknown[];
  rec.actions.france![k] = { ...rec.actions.france![k], orders: orders.slice(1) };
  const v = verifyTableReport(report, rec);
  assert.notEqual(v.status, 'verified');
  assert.equal(v.status, 'mismatch');
  const paths = v.episodes[0].diffs.map((d) => d.path);
  assert.ok(paths.some((p) => /\/seats\/\d+\/recorded_inputs\/digest$/.test(p)), `digest diff expected: ${paths.slice(0, 5).join(', ')}`);

  // A forged digest in the report with the genuine record is a mismatch too.
  const forged = clone(report) as Report;
  const s = forged.episodes[0].seats!.find((x) => x.seat === 'italy')!;
  s.recorded_inputs!.digest = `sha256:${'0'.repeat(64)}`;
  const v2 = verifyTableReport(forged, run.record);
  assert.equal(v2.status, 'mismatch');

  // A relabelled seat (a recorded target claimed as an engine seat) never verifies.
  const relabel = clone(report) as Report;
  const f = relabel.episodes[0].seats!.find((x) => x.seat === 'france')!;
  f.driver = 'engine';
  f.inputs_source = 'seed_regenerated';
  assert.notEqual(verifyTableReport(relabel, run.record).status, 'verified');
});

test('a record that does not describe the report is unverifiable, never a match', async () => {
  const run = await threeModelTable();
  const report = run.reports[0].report;
  const other = await threeModelTable(99);
  assert.equal(verifyTableReport(report, other.record).status, 'unverifiable');
  const rec = clone(run.record) as TableRecord;
  rec.seats = rec.seats.map((s) => (s.power === 'italy' ? { ...s, provider_id: 'someone-else' } : s));
  assert.equal(verifyTableReport(report, rec).status, 'unverifiable');
  const cut = clone(run.record) as TableRecord;
  cut.actions.germany!.pop();
  cut.log.germany!.pop();
  assert.equal(verifyTableReport(report, cut).status, 'unverifiable');
});

test('recorded peers replay the game: same moves, same board chain', async () => {
  const run = await threeModelTable();
  const peers: Partial<Record<Power, ReturnType<typeof recordedPeer>>> = {};
  for (const s of run.record.seats) peers[s.power] = recordedPeer(run.record, s.power);
  const spec = { table_id: 't-three', seed: run.record.seed, tier: run.record.tier, horizon_year: run.record.horizon_year, seats: run.record.seats.map((s) => ({ power: s.power })) };
  const again = await runTable(spec, peers, detOpts());
  assert.deepEqual(again.record.actions, run.record.actions);
  assert.equal(again.reports[0].report.episodes[0].replay_hash, run.reports[0].report.episodes[0].replay_hash);
  assert.equal(verifyTableReport(again.reports[1].report, again.record).status, 'verified');
});
