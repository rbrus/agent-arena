/**
 * A small league end to end: composeLeague → runTable per table → perModelEvidence per model,
 * rendered through arena-report's renderEvidenceReport. Providers are named by provider id only.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report } from 'arena-report';
import { POWERS, type Power } from 'wot-engine';
import { composeLeague, fakePeer, perModelEvidence, reportsByModel, runTable, verifyTableReport, type Peer, type TableRun } from '../src/index.ts';
import { detOpts } from './helpers.ts';

/**
 * Nation and nationality words (a small denylist). The seven Diplomacy powers are board
 * positions and are expected in the output; these are the words a provider must never be
 * described with (HOSTED-PROFILE §6.3).
 */
const NATION_WORDS = [
  'american', 'usa', 'united states', 'chinese', 'china', 'canadian', 'canada', 'korean', 'korea', 'japanese', 'japan',
  'indian', 'israeli', 'emirati', 'uae', 'swiss', 'switzerland', 'european', 'nation', 'national', 'nationality', 'country',
  'flag', 'french', 'german', 'british', 'russian', 'italian', 'turkish', 'austrian',
];
const NATION_RE = new RegExp(`\\b(?:${NATION_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

const MODELS: Record<string, () => Peer> = {
  'alpha/alpha-large': () => fakePeer('robust', { provider_id: 'alpha', model_id: 'alpha-large' }),
  'beta/beta-7': () => fakePeer('credulous', { provider_id: 'beta', model_id: 'beta-7' }),
  'gamma/gamma-mini': () => fakePeer('injector', { provider_id: 'gamma', model_id: 'gamma-mini' }),
};

test('composeLeague: round-robin seating and a Latin-square power rotation keyed by the league seed', () => {
  const t = composeLeague({ league: 's2026-10', league_seed: 3, seeds: [1, 2, 3, 4, 5, 6, 7], models: Object.keys(MODELS) });
  assert.equal(t.length, 7);
  assert.equal(t[0].table_id, 's2026-10-t001');
  for (const x of t) assert.equal(new Set(x.seats.map((s) => s.power)).size, x.seats.length);
  // Over 7 tables each slot plays each power exactly once.
  for (let j = 0; j < 3; j++) assert.equal(new Set(t.map((x) => x.seats[j].power)).size, 7);
  // Same manifest, same tables; another league seed rotates the powers.
  assert.deepEqual(composeLeague({ league: 's2026-10', league_seed: 3, seeds: [1, 2, 3, 4, 5, 6, 7], models: Object.keys(MODELS) }), t);
  assert.notDeepEqual(composeLeague({ league: 's2026-10', league_seed: 4, seeds: [1, 2, 3, 4, 5, 6, 7], models: Object.keys(MODELS) })[0].seats, t[0].seats);
  assert.throws(() => composeLeague({ league: 'S!', league_seed: 1, seeds: [1], models: ['a/b'] }), /league/);
});

test('perModelEvidence: reproduced N of M across the tables a model sat at, rendered per model, no nation words', async () => {
  const league = composeLeague({ league: 's2026-10', league_seed: 5, seeds: [101, 102, 103], models: Object.keys(MODELS) });
  const runs: TableRun[] = [];
  for (const tb of league) {
    const peers: Partial<Record<Power, Peer>> = {};
    for (const s of tb.seats) peers[s.power] = MODELS[s.model]();
    const spec = { table_id: tb.table_id, seed: tb.seed, tier: 'core' as const, horizon_year: 1901, seats: tb.seats.map((s) => ({ power: s.power })) };
    runs.push(await runTable(spec, peers, detOpts()));
  }
  const byModel = reportsByModel(runs);
  assert.deepEqual([...byModel.keys()].sort(), Object.keys(MODELS).sort());
  const all: Report[] = runs.flatMap((r) => r.reports.map((s) => s.report));
  for (const r of runs) for (const s of r.reports) assert.equal(verifyTableReport(s.report, r.record).status, 'verified');

  for (const key of Object.keys(MODELS)) {
    const [provider, model] = key.split('/');
    const ev = perModelEvidence(all, model, { records: runs.map((r) => r.record), render: { verifyResult: all.filter((r) => r.run.spec.labels?.['ng.model'] === model).map((r) => verifyTableReport(r, runs.find((x) => x.record.table_id === r.run.spec.labels?.['ng.table'])!.record)) } });
    assert.equal(ev.provider_id, provider);
    assert.equal(ev.tables.length, 3, 'every model sat at all three tables');
    assert.equal(ev.cost.games_metered, 3);
    assert.ok(ev.cost.total_chf > 0);
    const powers = Object.keys(ev.powers_played) as Power[];
    assert.ok(powers.every((p) => (POWERS as readonly string[]).includes(p)));
    assert.equal(ev.oracles.length, 7);
    for (const o of ev.oracles) {
      assert.equal(o.pass + o.fail + o.not_assessed, 3);
      assert.equal(o.reproduced, `reproduced ${o.fail} of ${o.pass + o.fail}`);
    }
    assert.ok(ev.markdown.includes(`\`${provider}\``));
    assert.ok(ev.markdown.includes('(unverified)'));
    const out = `${ev.markdown}\n${JSON.stringify({ ...ev, markdown: undefined })}`;
    const hit = NATION_RE.exec(out);
    assert.equal(hit, null, `nation word in the ${key} evidence: ${hit?.[0]}`);
  }
  // Every report, as data, is free of nation words too.
  for (const r of all) assert.equal(NATION_RE.exec(JSON.stringify(r)), null);
  assert.throws(() => perModelEvidence(all, 'no-such-model'), /no table report/);
});
