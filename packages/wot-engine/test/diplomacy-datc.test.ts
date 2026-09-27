/**
 * DATC v3.0 §6.A–§6.J (design §5.2): one test() per encoded case, schema
 * validation per file, and a completeness meta-test that reports coverage
 * (encoded / todo) rather than failing while sections are still being encoded.
 * Writes datc-report.json for the phase-8 gate when DATC_REPORT is set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allDatcIds,
  baseId,
  runCase,
  validateFixtureFile,
  type FixtureFile,
} from '../src/diplomacy/datc/load.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/diplomacy/datc/fixtures');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();
const loaded: FixtureFile[] = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FixtureFile);

const report: Record<string, { total: number; encoded: number; passed: number; todo: number; deviations: string[] }> = {};

files.forEach((f, i) => {
  test(`fixture file ${f} matches the schema`, () => {
    assert.deepEqual(validateFixtureFile(loaded[i]), []);
  });
  for (const c of loaded[i].cases) {
    const sec = c.id.split('.').slice(0, 2).join('.');
    const r = (report[sec] ??= { total: 0, encoded: 0, passed: 0, todo: 0, deviations: [] });
    if (c.status === 'todo') {
      test(`DATC ${c.id} ${c.title}`, { todo: 'not yet encoded' }, () => {});
      continue;
    }
    if (c.status === 'deviation') r.deviations.push(c.id);
    test(`DATC ${c.id} ${c.title}`, () => {
      const problems = runCase(c);
      if (problems.length === 0) r.passed++;
      assert.deepEqual(problems, []);
    });
  }
});

test('completeness: every DATC v3.0 case id 6.A–6.J is present exactly once (encoded or todo)', () => {
  const seen = new Map<string, string[]>();
  for (const f of loaded) {
    for (const c of f.cases) {
      if (!c.id.startsWith('6.')) continue;
      const b = baseId(c.id);
      seen.set(b, [...(seen.get(b) ?? []), c.id]);
    }
  }
  const want = allDatcIds();
  const missing = want.filter((id) => !seen.has(id));
  const extra = [...seen.keys()].filter((id) => !want.includes(id));
  const dupes = [...seen.entries()].filter(([, v]) => new Set(v).size !== v.length).map(([k]) => k);
  assert.deepEqual({ missing, extra, dupes }, { missing: [], extra: [], dupes: [] });
  for (const f of loaded) {
    for (const c of f.cases) {
      const sec = c.id.split('.').slice(0, 2).join('.');
      const r = report[sec];
      r.total++;
      if (c.status === 'todo') r.todo++;
      else r.encoded++;
    }
  }
  const encoded = Object.values(report).reduce((n, r) => n + r.encoded, 0);
  const todo = Object.values(report).reduce((n, r) => n + r.todo, 0);
  // Coverage line for the gate log; not a failure while todo > 0.
  console.log(`DATC coverage: ${encoded} encoded, ${todo} todo, of ${want.length} (sub-cases counted separately)`);
});

test('write datc-report.json (only when DATC_REPORT is set)', { skip: !process.env.DATC_REPORT }, () => {
  writeFileSync(process.env.DATC_REPORT!, JSON.stringify(report, null, 2) + '\n');
});
