// B5c: every shipped inspector sample is verifiable by the CLI. Runs the real
// `agent-arena verify --json` (tsx packages/arena-cli/src/bin.ts, a child
// process: no network, re-simulates from the shipped record) on every sample
// listed in public/samples/index.json and requires status `verified`, exit 0.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SAMPLES, index, readSample } from './helpers.ts';

const run = promisify(execFile);
const ASCENSION = join(__dirname, '..', '..');
const TSX = join(ASCENSION, 'node_modules', '.bin', 'tsx');
const BIN = join(ASCENSION, 'packages', 'arena-cli', 'src', 'bin.ts');

async function verify(report: string): Promise<{ exitCode: number; status: string; errors: unknown }> {
  let stdout = '';
  let exitCode = 0;
  try {
    ({ stdout } = await run(TSX, [BIN, 'verify', join(SAMPLES, report), '--json'], { maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    const x = e as { code?: number; stdout?: string };
    exitCode = typeof x.code === 'number' ? x.code : -1;
    stdout = x.stdout ?? '';
  }
  const doc = JSON.parse(stdout) as { status: string; errors?: unknown };
  return { exitCode, status: doc.status, errors: doc.errors };
}

describe('samples are verifiable by agent-arena verify', () => {
  const list = index();

  it('ship the CLI layout: <id>/report.json + the episode record (+ replay when listed)', () => {
    expect(list.length).toBeGreaterThanOrEqual(15);
    for (const s of list) {
      expect(s.report, s.id).toBe(`${s.id}/report.json`);
      const report = JSON.parse(readSample(s.report)) as { episodes: { replay_ref: string }[] };
      for (const ep of report.episodes) {
        expect(existsSync(join(SAMPLES, s.id, ep.replay_ref.replace(/\.replay\.json$/, '.record.json'))), `${s.id} record`).toBe(true);
        if (s.replay) expect(s.replay, s.id).toBe(`${s.id}/${ep.replay_ref}`);
      }
    }
  });

  it.each(list.map((s) => [s.id, s.report] as const))('%s verifies (exit 0, status verified)', async (_id, report) => {
    const r = await verify(report);
    expect({ status: r.status, exitCode: r.exitCode }, JSON.stringify(r.errors)).toEqual({ status: 'verified', exitCode: 0 });
  }, 60_000);
});
