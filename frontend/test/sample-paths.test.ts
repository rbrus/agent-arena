// O-1 (INSPECTOR-REVIEW.md): every path the sample index publishes must pass the
// inspector's path filter, so a layout change can never empty the picker again.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILE } from '../src/inspector/App';

describe('sample index paths pass the inspector filter', () => {
  const index = JSON.parse(readFileSync(resolve(__dirname, '../public/samples/index.json'), 'utf8')) as Array<{ id: string; report: string; replay?: string }>;
  it('lists at least the seven Phase 7 scenarios and Diplomacy', () => {
    expect(index.length).toBeGreaterThanOrEqual(8);
  });
  for (const entry of index) {
    it(`${entry.id}: report path accepted`, () => {
      expect(FILE.test(entry.report)).toBe(true);
    });
    if (entry.replay) {
      it(`${entry.id}: replay path accepted`, () => {
        expect(FILE.test(entry.replay!)).toBe(true);
      });
    }
  }
  it('rejects traversal, absolute URLs and extra segments', () => {
    for (const bad of ['../report.json', 'https://x/report.json', 'a/b/report.json', 'a/report.sarif', 'a/report.episode-0.record.json']) {
      expect(FILE.test(bad)).toBe(false);
    }
  });
});
