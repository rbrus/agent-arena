/**
 * docs/phase-9/SECURITY-REVIEW-HOSTED.md §8 (the 2.11.0 verify path), the fixes of G-60, G-61 and G-65
 * (G-62 and G-63 need a sealed bundle and live in hosted-digest-statement.test.ts). Each test fails on the
 * code the review read (`9161b55`):
 *   - G-60: a stdout closed by its reader made the process exit 0 whatever `verify` or `run` found.
 *   - G-61: the `--result` bundle boundary was lexical and was not checked again at write time.
 *   - G-65: the pinned key file validator accepted impossible dates and measured its size on a re-serialisation.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { verifyHostedSeal } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { pinnedKeyFileBytesProblems, pinnedKeyFileProblems } from '../src/hosted/pinned-keys.ts';
import { prepareResultPath, writeResultFile } from '../src/result-file.ts';
import { setOutputMode } from '../src/ui.ts';
import { MANIFEST_KID, NO_PIN, pubJwk } from './hosted-fixtures.ts';
import { PKG, scratch } from './helpers.ts';

setOutputMode({ quiet: true });

describe('G-60: a stdout closed by its reader never turns a failing exit into 0 (the built binary)', () => {
  let bin = '';
  let dir = '';
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  /** Spawn the bundle with its stdout closed by the reader before the first byte (what `| head -n 1` does to later writes). */
  const closedStdout = (args: string[]): Promise<{ code: number; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.destroy();
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });

  before(async () => {
    dir = scratch('arena-g60-');
    const { bundle } = await import('../build.ts');
    bin = (await bundle(join(dir, 'agent-arena.cjs'))).outfile;
    const run = await closedStdout(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', 'ref:coordinated', '--out', join(dir, 'ok'), '--quiet']);
    assert.equal(run.code, 0, run.stderr);
    const r = JSON.parse(readFileSync(join(dir, 'ok', 'report.json'), 'utf8'));
    r.episodes[0].replay_hash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(join(dir, 'ok', 'tampered.json'), JSON.stringify(r));
    mkdirSync(join(dir, 'bundle'));
    writeFileSync(join(dir, 'bundle', 'report.json'), 'not json\n');
    mkdirSync(join(dir, 'seal'));
  }, { timeout: 180_000 } as never);

  test('verify of a tampered report: exit 1 (mismatch), not 0', { timeout: 60_000 }, async () => {
    const r = await closedStdout(['verify', join(dir, 'ok', 'tampered.json')]);
    assert.equal(r.code, 1, r.stderr);
  });

  test('verify of a report that is not a report: exit 2, not 0', { timeout: 60_000 }, async () => {
    writeFileSync(join(dir, 'bad.json'), '{"report_version":42}\n');
    const r = await closedStdout(['verify', join(dir, 'bad.json')]);
    assert.equal(r.code, 2, r.stderr);
  });

  test('--result: the file exitCode equals the process exit code (2), with stdout closed', { timeout: 60_000 }, async () => {
    const out = join(dir, 'seal', 'verify.json');
    const r = await closedStdout(['verify', '--hosted-seal', join(dir, 'bundle'), '--result', out]);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).exitCode, r.code);
  });

  test('run with findings: exit 1, not 0', { timeout: 60_000 }, async () => {
    const r = await closedStdout(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', 'ref:naive', '--out', join(dir, 'naive')]);
    assert.equal(r.code, 1, r.stderr);
  });
});

describe('G-61: the --result bundle boundary is physical, and it is checked again at write time', () => {
  const inside = (e: unknown) => e instanceof CliError && e.exitCode === 3 && /inside the bundle/.test(e.message);
  const layout = () => {
    const d = scratch('arena-g61-');
    mkdirSync(join(d, 'out', 'episodes'), { recursive: true });
    mkdirSync(join(d, 'seal'));
    return d;
  };

  test('P1: a parent reached through a link into the bundle is refused (exit 3), nothing written', () => {
    const d = layout();
    symlinkSync(join(d, 'out'), join(d, 'alias'));
    symlinkSync(join(d, 'out', 'episodes'), join(d, 'seal', 'eps'));
    assert.throws(() => prepareResultPath(join(d, 'alias', 'verify.json'), join(d, 'out')), inside);
    assert.throws(() => prepareResultPath(join(d, 'seal', 'eps', 'verify.json'), join(d, 'out')), inside);
    assert.equal(existsSync(join(d, 'out', 'verify.json')), false);
  });

  test('P2: a bundle named through a link still contains its own directory (exit 3), also through verify --hosted-seal', () => {
    const d = layout();
    symlinkSync(join(d, 'out'), join(d, 'outlink'));
    assert.throws(() => prepareResultPath(join(d, 'out', 'verify.json'), join(d, 'outlink')), inside);
    assert.throws(() => verifyHostedSeal(join(d, 'outlink'), { pinnedKeys: NO_PIN, manifestKey: pubJwk(MANIFEST_KID), result: join(d, 'out', 'verify.json') }), inside);
    assert.throws(() => verifyHostedSeal(join(d, 'outlink', 'report.json'), { pinnedKeys: NO_PIN, manifestKey: pubJwk(MANIFEST_KID), result: join(d, 'out', 'verify.json') }), inside);
  });

  test('a bundle of / contains every path (exit 3)', () => {
    const d = layout();
    assert.throws(() => prepareResultPath(join(d, 'seal', 'verify.json'), '/'), inside);
  });

  test('a parent swapped for a link into the bundle between the check and the write: exit 2 result_not_written, nothing in the bundle', () => {
    const d = layout();
    const t = prepareResultPath(join(d, 'seal', 'verify.json'), join(d, 'out'));
    renameSync(join(d, 'seal'), join(d, 'seal.old'));
    symlinkSync(join(d, 'out'), join(d, 'seal'));
    assert.throws(() => writeResultFile(t, { ok: true }), (e: unknown) => e instanceof CliError && e.exitCode === 2 && /^result_not_written: /.test(e.message));
    assert.equal(existsSync(join(d, 'out', 'verify.json')), false);
  });

  test('a parent swapped for a link elsewhere (outside the bundle) is refused too: the directory is not the one checked', () => {
    const d = layout();
    mkdirSync(join(d, 'other'));
    const t = prepareResultPath(join(d, 'seal', 'verify.json'), join(d, 'out'));
    renameSync(join(d, 'seal'), join(d, 'seal.old'));
    symlinkSync(join(d, 'other'), join(d, 'seal'));
    assert.throws(() => writeResultFile(t, { ok: true }), (e: unknown) => e instanceof CliError && e.exitCode === 2 && /changed after --result was checked/.test(e.message));
    assert.equal(existsSync(join(d, 'other', 'verify.json')), false);
  });

  test('an unchanged parent is written create-only', () => {
    const d = layout();
    const t = prepareResultPath(join(d, 'seal', 'verify.json'), join(d, 'out'));
    writeResultFile(t, { ok: true });
    assert.equal(JSON.parse(readFileSync(join(d, 'seal', 'verify.json'), 'utf8')).ok, true);
  });
});

describe('G-65: the pinned key file validator', () => {
  const FILE = join(PKG, 'src', 'hosted', 'pinned-keys.json');
  const raw = () => JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, any>;

  test('the bundled file is valid as its bytes', () => {
    assert.deepEqual(pinnedKeyFileBytesProblems(readFileSync(FILE)), []);
  });

  for (const [what, v] of [['2026-11-31T00:00:00Z', '2026-11-31T00:00:00Z'], ['T24:00:00Z', '2026-09-27T24:00:00Z'], ['2026-02-29 (not a leap year)', '2026-02-29T00:00:00Z']] as const) {
    test(`an impossible time is refused, not shifted: ${what}`, () => {
      const d = raw();
      d.fetched_at = v;
      assert.match(pinnedKeyFileProblems(d).join('; '), /fetched_at must be an RFC 3339 UTC time/);
      const k = raw();
      k.manifest.keys[0].not_before = v;
      assert.match(pinnedKeyFileProblems(k).join('; '), /not_before and not_after must be RFC 3339 UTC times/);
    });
  }

  test('the 65536-byte limit is measured on the file bytes, not on a re-serialisation', () => {
    const bytes = readFileSync(FILE);
    const padded = Buffer.concat([bytes, Buffer.alloc(70_000, 0x20)]);
    assert.match(pinnedKeyFileBytesProblems(padded).join('; '), /the file is over 65536 bytes/);
    assert.match(pinnedKeyFileProblems(JSON.parse(padded.toString('utf8')), padded).join('; '), /the file is over 65536 bytes/);
  });
});
