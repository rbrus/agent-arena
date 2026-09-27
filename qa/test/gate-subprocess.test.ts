/**
 * Regression test for the gates' subprocess timeout (qa/phase7-gate.ts `runProc`, used by both
 * harnesses' `sh`).
 *
 * Bug pinned (2026-09-26, `tsx qa/phase7-gate.ts --layout private`): C5-NPM-TEST's 900 s timeout
 * SIGKILLed only `npm`; its `node --test` grandchild, stuck on a hung test file
 * (packages/arena-cli/test/redaction.test.ts, a loopback server left listening), kept the stdout
 * pipe open, so `close` never fired and the gate hung for 30+ minutes. Fixed contract: the command
 * runs in its own process group, the timeout kills the whole group, and the result says timedOut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProc } from '../phase7-gate.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('runProc: a timeout kills the grandchild that holds the pipes, and resolves promptly', { timeout: 20_000 }, async () => {
  // sh starts a background sleep that inherits stdout (the pipe), prints its pid, then waits.
  const t0 = performance.now();
  const p = await runProc('sh', ['-c', 'sleep 60 & echo $!; wait'], { cwd: process.cwd(), timeoutMs: 500 });
  const ms = performance.now() - t0;
  assert.equal(p.timedOut, true);
  assert.ok(ms < 15_000, `resolved after ${ms.toFixed(0)} ms (the old helper waited for the 60 s grandchild)`);
  assert.match(p.stderr, /timed out after/);
  const grandchild = Number(p.stdout.trim());
  assert.ok(grandchild > 0, `grandchild pid printed: "${p.stdout}"`);
  // A killed process can linger in the table for a few ms until it is reaped; poll briefly under load.
  let gone = !alive(grandchild);
  for (let i = 0; i < 40 && !gone; i++) { await new Promise((r) => setTimeout(r, 50)); gone = !alive(grandchild); }
  assert.equal(gone, true, 'the grandchild sleep was killed with the group');
});

test('runProc: a normal exit is untouched (code, output, no timedOut)', async () => {
  const p = await runProc('sh', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: process.cwd(), timeoutMs: 10_000 });
  assert.equal(p.code, 3);
  assert.equal(p.stdout, 'out\n');
  assert.equal(p.stderr, 'err\n');
  assert.equal(p.timedOut, undefined);
});
