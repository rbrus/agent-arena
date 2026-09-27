/**
 * `replay` emits the inspector's format (frontend/src/lib/replay-format.ts)
 * byte-for-byte equal to the file `run` wrote; the hash chain folds to the
 * report's replay_hash; a tampered replay file fails `verify`. Plus the two
 * build guards wired into `npm test`: lint:net (single guarded network layer)
 * and contract drift of the generated types.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ReplayFile as InspectorReplayFile } from '../../../frontend/src/lib/replay-format.ts';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import type { ReplayFile } from '../src/replay-file.ts';
import { setOutputMode } from '../src/ui.ts';
import { PKG, runCli, scratch } from './helpers.ts';

setOutputMode({ quiet: true });

// Compile-time drift guard against the inspector's own type (both directions).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<ReplayFile, InspectorReplayFile> = true;

const fold = (p: string, h: string) => `sha256:${createHash('sha256').update(`${p}:${h}`, 'utf8').digest('hex')}`;

test('replay --json is the inspector format, identical to the run output, and its chain folds to replay_hash', async () => {
  assert.equal(sameShape, true);
  const out = scratch();
  await runCommand({ scenario: 'grid_tactics', seeds: '2', episodes: '2', target: 'ref:coordinated', out }, []);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  for (const ep of report.episodes) {
    assert.match(ep.replay_ref, /^report\.episode-\d+\.replay\.json$/);
    const r = await runCli(['replay', join(out, 'report.json'), '--episode', String(ep.episode_index), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const stored = readFileSync(join(out, ep.replay_ref), 'utf8');
    assert.equal(r.stdout, stored, 'replay --json == the file run wrote');
    const f = JSON.parse(stored) as ReplayFile;
    assert.equal(f.replay_version, '1.0');
    assert.equal(f.replay_hash, ep.replay_hash);
    assert.equal(f.seat, ep.seat);
    assert.ok(f.ticks.length <= 121 && f.ticks.every((t) => t.seats.length <= 5 && t.engine_events.length <= 64));
    let chain = f.initial_state_hash;
    for (const t of f.ticks) chain = fold(chain, t.state_hash);
    assert.equal(chain, ep.replay_hash);
  }
  const human = await runCli(['replay', join(out, 'report.json'), '--hash', report.episodes[1].replay_hash]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /^t=\s+0 /m);
  assert.match(human.stdout, /matches the report/);
});

test('verify refuses a report whose inspector replay file was edited', async () => {
  const out = scratch();
  await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out }, []);
  const path = join(out, 'report.json');
  assert.equal(verifyCommand(path), 0);
  const rp = join(out, 'report.episode-0.replay.json');
  const f = JSON.parse(readFileSync(rp, 'utf8')) as ReplayFile;
  f.ticks[2].oracle_events = [];
  f.ticks[2].seats[0].ack = { status: 'accepted' };
  f.ticks[2].engine_events = [];
  writeFileSync(rp, JSON.stringify(f));
  assert.equal(verifyCommand(path), 2);
});

test('lint:net passes on src/ and fails on network calls outside src/net/', () => {
  const ok = spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const dir = join(scratch(), 'src');
  mkdirSync(join(dir, 'net'), { recursive: true });
  writeFileSync(join(dir, 'net', 'allowed.ts'), "import http from 'node:http';\nexport const x = http;\n");
  writeFileSync(
    join(dir, 'bad.ts'),
    [
      "import { request } from 'node:https';",
      "import WebSocket from 'ws';",
      "const u = await import('undici');",
      "const r = await fetch('https://x');",
      "const g = globalThis.fetch;",
      "const w = new WebSocket('ws://x');",
      "// fetch('in a comment') is fine",
      "const s = 'fetch( in a string is fine';",
    ].join('\n'),
  );
  const bad = spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs'), dir], { encoding: 'utf8', cwd: '/' });
  assert.equal(bad.status, 1);
  for (const line of [1, 2, 3, 4, 5, 6]) assert.match(bad.stderr, new RegExp(`bad\\.ts:${line}\\b`), `line ${line} flagged`);
  assert.doesNotMatch(bad.stderr, /bad\.ts:[78]\b/);
  assert.doesNotMatch(bad.stderr, /allowed\.ts/, 'net/ itself is the one exempt module');
});

test('generated contract types match contracts/schemas (CI fails on drift)', () => {
  const r = spawnSync(process.execPath, [join(PKG, 'codegen.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
