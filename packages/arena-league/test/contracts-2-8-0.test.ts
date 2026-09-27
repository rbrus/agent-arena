/**
 * Contracts 2.8.0 (CHANGELOG migration notes, run_spec `seats[]`, RESERVED.md) for the Neutral
 * Ground harness:
 *  1. every seat is `driver: target` with `owner` = the provider slug; a seat whose provider is the
 *     primary's provider is `owner: "primary"`, in every per-seat report of the table; no
 *     `recorded_peer`, `llm_peer`, `peer` block or `sx-neutral-ground` pack id appears anywhere;
 *  2. the old seat role / pack id is refused at admission (no peer is called) and a pre-2.8.0
 *     record carrying it never verifies;
 *  3. the `league` budget tier value is refused (runTable, the record, verify; contracts 2.10.0: the
 *     reserved tier was renamed `extended`, so `league` is simply unknown), while every tier of the
 *     RunSpec enum, `extended` included, is playable; the contract's RunSpec schema refuses `league` too.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReportSchema, validateRunSpecSchema } from 'arena-report';
import { assertTableRecord, definePeer, fakePeer, MonthlyCostCap, runTable, TABLE_TIERS, verifyTableReport, type Peer, type TableRecord, type TableSpec } from '../src/index.ts';
import { detOpts, table, threeModelTable } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

test('2.8.0: every seat is driver target; owner = provider slug, same provider as the primary = "primary", in every per-seat report', async () => {
  const t = table('t-owners', 20261201, [
    { power: 'england', peer: fakePeer('robust', { provider_id: 'alpha', model_id: 'alpha-m1' }) },
    { power: 'france', peer: fakePeer('credulous', { provider_id: 'beta', model_id: 'beta-m1' }) },
    { power: 'germany', peer: fakePeer('house', { provider_id: 'alpha', model_id: 'alpha-m2' }) },
  ], { horizon_year: 1901 });
  const run = await runTable(t.spec, t.peers, detOpts());
  assert.equal(run.outcome, 'completed');
  const owners = Object.fromEntries(run.reports.map((s) => [s.power, Object.fromEntries(s.report.run.spec.seats!.map((x) => [x.position, [x.driver, (x as { owner?: string }).owner]]))]));
  assert.deepEqual(owners, {
    england: { france: ['target', 'beta'], germany: ['target', 'primary'] },
    france: { england: ['target', 'alpha'], germany: ['target', 'alpha'] },
    germany: { england: ['target', 'primary'], france: ['target', 'beta'] },
  });
  for (const s of run.reports) {
    assert.ok(validateRunSpecSchema(s.report.run.spec), JSON.stringify(validateRunSpecSchema.errors?.slice(0, 3)));
    assert.ok(validateReportSchema(s.report), JSON.stringify(validateReportSchema.errors?.slice(0, 3)));
    assert.equal(s.report.run.spec.diplomacy?.profile, 'table');
    assert.ok(s.report.episodes[0].seats!.every((x) => x.driver === 'target' || x.driver === 'engine'));
    const bytes = JSON.stringify(s.report);
    for (const banned of ['recorded_peer', 'llm_peer', 'sx-neutral-ground', '"peer"']) assert.ok(!bytes.includes(banned), `${s.power}: report contains ${banned}`);
    assert.equal(verifyTableReport(s.report, run.record).status, 'verified');
  }
  assert.ok(!JSON.stringify(run.record).includes('sx-neutral-ground'));
  assert.ok(run.record.seats.every((s) => s.role === 'target'));
});

test('2.8.0: a recorded_peer seat role or a pack id is refused at admission, before any peer is called', async () => {
  let calls = 0;
  const counting: Peer = definePeer({ provider_id: 'alpha', model_id: 'a-1', region: 'local-harness1', cost: { input_tokens: 0, output_tokens: 0, chf: 0 } }, async () => {
    calls++;
    throw new Error('must not be called');
  });
  for (const extra of [{ as: 'recorded_peer' }, { pack: 'sx-neutral-ground' }, { as: 'recorded_peer', pack: 'sx-neutral-ground' }]) {
    const spec = { table_id: 't-legacy', seed: 1, tier: 'core', horizon_year: 1901, seats: [{ power: 'austria', ...extra }] } as unknown as TableSpec;
    await assert.rejects(runTable(spec, { austria: counting }, detOpts()), /driver target|recorded_peer|pack id/);
  }
  assert.equal(calls, 0);
});

test('2.8.0: a pre-2.8.0 record with a recorded_peer seat or a pack id never verifies', async () => {
  const run = await threeModelTable();
  const report = run.reports.find((r) => r.power === 'germany')!.report;
  const legacy = clone(run.record) as TableRecord;
  const fr = legacy.seats.find((s) => s.power === 'france')! as unknown as Record<string, unknown>;
  fr.role = 'recorded_peer';
  fr.pack = 'sx-neutral-ground';
  fr.agent = 'beta/beta-m1@0.0.0';
  assert.throws(() => assertTableRecord(legacy), /role "recorded_peer"/);
  assert.equal(verifyTableReport(report, legacy).status, 'unverifiable');
  const packOnly = clone(run.record) as TableRecord;
  (packOnly.seats[0] as unknown as Record<string, unknown>).pack = 'sx-neutral-ground';
  assert.throws(() => assertTableRecord(packOnly), /Neutral Ground is not a pack/);
  assert.equal(verifyTableReport(report, packOnly).status, 'unverifiable');
});

test('2.10.0: the value league is not a tier (renamed extended): refused by runTable (no reservation, no call), the record and verify; the RunSpec schema refuses it too', async () => {
  assert.deepEqual([...TABLE_TIERS], ['edge', 'core', 'frontier', 'extended']);
  let calls = 0;
  const inner = fakePeer('robust');
  const counting: Peer = definePeer(inner.meta, async (o, c) => {
    calls++;
    return inner(o, c);
  });
  const cap = new MonthlyCostCap({ now: () => new Date('2026-10-05T08:00:00Z') });
  const spec = { table_id: 't-league', seed: 1, tier: 'league', horizon_year: 1901, seats: [{ power: 'austria' }] } as unknown as TableSpec;
  await assert.rejects(runTable(spec, { austria: counting }, detOpts({ cap })), /unknown budget tier: league/);
  await assert.rejects(runTable({ ...spec, tier: 'weekly' } as unknown as TableSpec, { austria: counting }, detOpts()), /unknown budget tier/);
  assert.equal(calls, 0);
  assert.equal(cap.snapshot().reserved_chf, 0, 'no reservation was taken');

  const run = await threeModelTable();
  const rec = clone(run.record) as TableRecord;
  (rec as unknown as Record<string, unknown>).tier = 'league';
  assert.throws(() => assertTableRecord(rec), /unknown budget tier: league/);
  assert.equal(verifyTableReport(run.reports[0].report, rec).status, 'unverifiable');

  const rs = clone(run.reports[0].report.run.spec) as unknown as Record<string, unknown>;
  assert.ok(validateRunSpecSchema(rs));
  rs.budget_tier = 'league';
  assert.equal(validateRunSpecSchema(rs), false, 'contracts 2.8.0 and 2.10.0: a RunSpec naming league is schema_invalid');
  rs.budget_tier = 'extended';
  assert.ok(validateRunSpecSchema(rs), 'contracts 2.10.0: extended is a tier');
});

test('2.8.0 / 2.10.0: league tables play and verify on core, frontier and extended (Dh 30 s)', async () => {
  for (const tier of ['core', 'frontier', 'extended'] as const) {
    const t = table(`t-${tier}`, 17, [
      { power: 'italy', peer: fakePeer('robust', { provider_id: 'alpha', model_id: 'alpha-m1' }) },
      { power: 'turkey', peer: fakePeer('house', { provider_id: 'beta', model_id: 'beta-m1' }) },
    ], { tier, horizon_year: 1901 });
    const run = await runTable(t.spec, t.peers, detOpts());
    assert.equal(run.outcome, 'completed');
    assert.equal(run.record.tier, tier);
    for (const s of run.reports) {
      assert.equal(s.report.run.spec.budget_tier, tier);
      assert.equal(verifyTableReport(s.report, run.record).status, 'verified');
    }
  }
});
