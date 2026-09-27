/**
 * Misuse guard (threat model §8.1, contracts 2.1.0 `target.ownership_attested`),
 * the 3×401 abort (M-3), and the exit-code contract (EXIT_CODES, EXTRACTION.md §9):
 *   run:    0 no findings · 1 findings · 2 error · 3 misconfiguration
 *   verify: 0 verified · 1 mismatch · 2 unverifiable · 3 unsupported engine build
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { startReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { runCli, scratch, stub } from './helpers.ts';

setOutputMode({ quiet: true });

test('misuse guard: a non-loopback target without --i-own-this-target exits 3 before any network I/O', async () => {
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', 'https://agent.example.com/act', '--out', scratch()]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /target_ownership_unattested/);
  assert.match(r.stderr, /--i-own-this-target/);
  assert.match(r.stderr, /Nothing was sent/);
});

test('misuse guard: attestation is recorded in the report (run.spec.target.ownership_attested, run.target_ownership)', async () => {
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
  const out = scratch();
  // A hostname that resolves to loopback: needs --allow-private AND (being non-literal) the attestation.
  const target = `http://my-agent.test:${ref.port}/`;
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target, allowPrivate: true, out, resolver }, []), (e: unknown) => e instanceof CliError && e.exitCode === 3);
  await assert.rejects(
    runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target, ownTarget: true, out, resolver }, []),
    (e: unknown) => e instanceof CliError && /resolves to 127\.0\.0\.1/.test(e.message),
    'attested but the name resolves to a private address: still blocked without --allow-private',
  );
  const r = await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target, ownTarget: true, allowPrivate: true, maxRps: '50', out, resolver }, []);
  assert.equal(r.exitCode, 0);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(report.run.spec.target.ownership_attested, true);
  assert.deepEqual(report.run.target_ownership, { loopback: false, attested: true, source: 'cli_flag' });
  assert.equal(report.run.spec.labels['arena.network_policy'], 'allow-private');
  await ref.close();
});

test('three consecutive 401s abort the run (exit 2); the arena never retries authentication', async () => {
  const s = await stub((_req, _b, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad token"}'));
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', s.url, '--auth', 'env:TOK', '--out', scratch()], { TOK: 'abcdefgh-not-the-right-one' });
  assert.equal(r.code, 2);
  assert.equal(s.requests.length, 3);
  assert.match(r.stderr, /3 times in a row over rest/);
  await s.close();
});

test('exit codes: run 0 (coordinated) / 1 (naive findings) / 2 (unreachable target) / 3 (misconfiguration, --hosted)', async () => {
  assert.equal((await runCommand({ scenario: 'byzantine', seat: 'squad', target: 'ref:coordinated', out: scratch() }, [])).exitCode, 0);
  assert.equal((await runCommand({ scenario: 'hallucinator', seat: 'squad', seeds: '20260720', target: 'ref:naive', out: scratch() }, [])).exitCode, 1);
  const closed = await stub((_q, _b, res) => res.end());
  const port = closed.port;
  await closed.close();
  const unreachable = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', `http://127.0.0.1:${port}`, '--out', scratch()]);
  assert.equal(unreachable.code, 2);
  assert.match(unreachable.stderr, /could not reach the target over rest at http:\/\/127\.0\.0\.1:\d+\/: connection refused/);
  assert.match(unreachable.stderr, /Next: start it first/);
  for (const args of [['--scenario', 'nope'], ['--scenario', 'byzantine', '--tier', 'huge'], ['--scenario', 'byzantine', '--seat', 'duel'], ['--scenario', 'byzantine', '--hosted'], ['--scenario', 'byzantine', '--seeds', '1,2', '--episodes', '1']]) {
    const r = await runCli(['run', ...args, '--target', 'ref:coordinated', '--out', scratch()]);
    assert.equal(r.code, 3, args.join(' '));
    assert.match(r.stderr, /error: /);
  }
  const unknown = await runCli(['frobnicate']);
  assert.equal(unknown.code, 3);
});

test('deadline misses name the tier budget and the overshoot', async () => {
  // Answers slower than Ds (edge: 800 ms) but inside Dh (1600 ms): a soft miss, reported with the overshoot.
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
  let n = 0;
  const slow = await stub(async (req, body, res) => {
    n++;
    const delay = n === 1 ? 900 : n === 2 ? 1800 : 0;
    const r = await fetchReference(ref.port, body);
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(r), delay);
    void req;
  });
  const out = scratch();
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--tier', 'edge', '--seeds', '20260720', '--target', slow.url, '--out', out]);
  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assert.match(r.stderr, /answered in \d+ ms, \d+ ms over the soft deadline Ds 800 ms \(edge tier\)/);
  assert.match(r.stderr, /no action frame within the hard deadline Dh 1600 ms \(edge tier\)/);
  const ep = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).episodes[0];
  assert.equal(ep.budget.soft_deadline_misses, 1);
  assert.equal(ep.budget.hard_deadline_misses, 1);
  await slow.close();
  await ref.close();
});

/** Forward a frame to the reference server (test plumbing, outside the CLI). */
async function fetchReference(port: number, body: string): Promise<string> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const q = request({ host: '127.0.0.1', port, method: 'POST', path: '/act', headers: { 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    q.on('error', reject);
    q.end(body);
  });
}

test('exit codes: verify 0 (verified) / 1 (tampered verdict or hash) / 2 (garbage, missing record) / 3 (other engine build)', async () => {
  const out = scratch();
  await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720,1', target: 'ref:naive', out }, []);
  const path = join(out, 'report.json');
  const pristine = readFileSync(path, 'utf8');
  assert.equal(verifyCommand(path), 0);

  const r1 = JSON.parse(pristine);
  const v = r1.episodes[0].oracles.find((o: { verdict: string }) => o.verdict === 'fail');
  v.verdict = 'pass';
  v.severity = 'note';
  delete v.evidence_ref;
  writeFileSync(path, JSON.stringify(r1));
  assert.equal(verifyCommand(path), 1, 'a flipped verdict is recomputed, never read back');

  const r2 = JSON.parse(pristine);
  r2.episodes[1].outcome = 'clear';
  writeFileSync(path, JSON.stringify(r2));
  assert.equal(verifyCommand(path), 1);

  const r3 = JSON.parse(pristine);
  r3.engine.build_hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(path, JSON.stringify(r3));
  assert.equal(verifyCommand(path), 3);

  writeFileSync(path, '{"__proto__": {"x": 1}}');
  assert.equal(verifyCommand(path), 2);
  writeFileSync(path, 'not json');
  assert.equal(verifyCommand(path), 2);

  writeFileSync(path, pristine);
  // A forged target input changes the hash chain: the record no longer re-simulates.
  const recPath = join(out, 'report.episode-0.record.json');
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  rec.inputs[3].m0 = [];
  writeFileSync(recPath, JSON.stringify(rec));
  assert.equal(verifyCommand(path), 2, 'a record that does not re-simulate is unverifiable, never a match');
});

test('verify regenerates engine-controlled seats: a forged reference-fill move in a member-mode record is refused', async () => {
  const out = scratch();
  assert.equal((await runCommand({ scenario: 'byzantine', seat: 'member', position: 'm1', seeds: '20260720', target: 'ref:naive', out }, [])).exitCode >= 0, true);
  const path = join(out, 'report.json');
  assert.equal(verifyCommand(path), 0);
  const recPath = join(out, 'report.episode-0.record.json');
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  const t = rec.inputs.findIndex((x: Record<string, unknown[]>) => (x.m0 ?? []).length > 0);
  rec.inputs[t].m0 = []; // "disarm" a platform teammate; the target seat m1 is untouched
  writeFileSync(recPath, JSON.stringify(rec));
  assert.equal(verifyCommand(path), 2);
});
