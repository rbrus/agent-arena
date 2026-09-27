/**
 * Gate criterion 6 / threat model §1.5: a target credential never appears in
 * any output. A hostile stub target echoes the Authorization header back in
 * every channel it has (the `thought` field of valid frames, a 500 error page,
 * a 401-free JSON error); the run's stdout, stderr and every file written are
 * grepped for the canary and its encodings. Literal secrets on argv, userinfo,
 * credential-looking query parameters, short and group-readable secrets are
 * refused before any network I/O.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReferenceAgent } from '../src/reference/policy.ts';
import { allFiles, assertNoLeak, runCli, scratch, stub } from './helpers.ts';

/**
 * A target that answers correctly but echoes every credential header it
 * receives, everywhere it can, in every form: raw, Markdown-escaped, base64,
 * URL-encoded (upper-case hex), interleaved with zero-width spaces, and cut so
 * that the credential straddles the transport's 512-character excerpt.
 */
async function echoingTarget() {
  const agent = new ReferenceAgent('coordinated');
  return stub((req, body, res, n) => {
    const echo = `${req.headers.authorization ?? ''} ${req.headers['x-api-key'] ?? ''}`.trim();
    const bare = echo.replace(/^Bearer /, '');
    let frame: Record<string, unknown> | null = null;
    try {
      frame = agent.respond(JSON.parse(body));
    } catch {
      frame = null;
    }
    const page = (text: string) => void res.writeHead(500, { 'content-type': 'text/plain' }).end(text);
    if (!frame || n % 5 === 0) return page(`<h1>debug</h1><pre>headers: ${echo} base64: ${Buffer.from(echo).toString('base64')}</pre>`);
    if (n % 7 === 0) return page(`escaped: ${echo.replace(/[_*~[\]<>#|!&@`]/g, (c) => `\\${c}`)}`);
    if (n % 11 === 0) return page(`url: ${[...Buffer.from(bare)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')}`);
    if (n % 13 === 0) return page(`zw: ${[...bare].join('\u200b')}`);
    if (n % 17 === 0) return page(`${'.'.repeat(512 - Math.floor(bare.length / 2))}${bare}`);
    if (n % 19 === 0) return page(`you sent ${bare.slice(0, Math.floor(bare.length * 0.6))}`);
    if (frame.ok === true) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...frame, thought: echo.slice(0, 200) }));
  });
}

test('canary bearer token via --auth env:NAME never reaches stdout, stderr, report, SARIF, run spec, replay or record files', async () => {
  const canary = `canary_${randomBytes(18).toString('hex')}`;
  const target = await echoingTarget();
  const out = scratch();
  const r = await runCli(
    ['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720,1', '--target', `${target.url}/act`, '--auth', 'env:ARENA_CANARY', '--out', out],
    { ARENA_CANARY: canary },
  );
  assert.ok(r.code === 0 || r.code === 1, `run finished (exit ${r.code}): ${r.stderr}`);
  assert.ok(target.requests.length > 20, 'the target was really exercised');
  assert.ok(target.requests.every((q) => q.headers.authorization === `Bearer ${canary}`), 'the credential was sent to the typed origin');
  assert.match(r.stderr, /target> /, 'the 500 page echo was shown (redacted, prefixed)');
  assert.match(r.stderr, /\[redacted:env\]/);
  const files = allFiles(out);
  assert.ok(files.some((f) => f.path.endsWith('report.json')) && files.some((f) => f.path.endsWith('report.sarif')));
  assertNoLeak(canary, [{ where: 'stdout', text: r.stdout }, { where: 'stderr', text: r.stderr }, ...files.map((f) => ({ where: f.path, text: f.text }))]);
  const spec = JSON.parse(readFileSync(join(out, 'report.run-spec.json'), 'utf8'));
  assert.deepEqual(spec.target.auth, { scheme: 'bearer', ref: 'env:ARENA_CANARY' }, 'the RunSpec on disk carries the reference, not the value');
  await target.close();
});

test('canary via --auth secret:name + --auth-header: same guarantees; the file must be private', async () => {
  const canary = `sek_${randomBytes(16).toString('hex')}`;
  const dir = scratch('arena-secrets-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-key'), `${canary}\n`, { mode: 0o600 });
  const target = await echoingTarget();
  const out = scratch();
  const r = await runCli(
    ['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', target.url, '--auth', 'secret:agent-key', '--auth-header', 'X-Api-Key', '--out', out],
    { AGENT_ARENA_SECRETS_DIR: dir },
  );
  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assert.ok(target.requests.every((q) => q.headers['x-api-key'] === canary && q.headers.authorization === undefined));
  assertNoLeak(canary, [{ where: 'stdout', text: r.stdout }, { where: 'stderr', text: r.stderr }, ...allFiles(out).map((f) => ({ where: f.path, text: f.text }))]);
  const spec = JSON.parse(readFileSync(join(out, 'report.run-spec.json'), 'utf8'));
  assert.deepEqual(spec.target.auth, { scheme: 'header', ref: 'secret:agent-key', header_name: 'X-Api-Key' });

  chmodSync(join(dir, 'agent-key'), 0o644);
  const loose = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', target.url, '--auth', 'secret:agent-key', '--out', scratch()], { AGENT_ARENA_SECRETS_DIR: dir });
  assert.equal(loose.code, 3);
  assert.match(loose.stderr, /readable by group\/others/);
  assert.ok(!loose.stderr.includes(canary));
  await target.close();
});

test('refused before any network I/O: literal secrets on argv, userinfo, credential query params, missing/short credentials', async () => {
  const target = await stub((_q, _b, res) => res.end('{}'));
  const base = ['run', '--scenario', 'byzantine', '--seat', 'squad', '--out', scratch()];
  const cases: { args: string[]; env?: Record<string, string>; msg: RegExp }[] = [
    { args: ['--target', target.url, '--token', 'abcdefgh12345678'], msg: /--token is not accepted/ },
    { args: ['--target', target.url, '--header', 'Authorization: Bearer abcdefgh12345678'], msg: /--header is not accepted/ },
    { args: ['--target', target.url.replace('http://', 'http://user:hunter2hunter2@')], msg: /user:password@/ },
    { args: ['--target', `${target.url}/act?api_key=abcdefgh12345678`], msg: /credential-looking query parameter/ },
    { args: ['--target', target.url, '--auth', 'Bearer abcdefgh12345678'], msg: /takes a reference, not a value/ },
    { args: ['--target', target.url, '--auth', 'env:ARENA_MISSING_TOKEN'], msg: /ARENA_MISSING_TOKEN is not set/ },
    { args: ['--target', target.url, '--auth', 'env:ARENA_SHORT'], env: { ARENA_SHORT: 'abc' }, msg: /shorter than 8/ },
    { args: ['--target', target.url, '--auth', 'secret:nope'], msg: /AGENT_ARENA_SECRETS_DIR/ },
  ];
  for (const c of cases) {
    const r = await runCli([...base, ...c.args], c.env ?? {});
    assert.equal(r.code, 3, `${c.args.join(' ')} → ${r.stderr}`);
    assert.match(r.stderr, c.msg);
    assert.ok(!r.stderr.includes('hunter2hunter2') && !r.stdout.includes('abcdefgh12345678'), 'the refused value is not echoed');
  }
  assert.equal(target.connections, 0, 'no connection was ever made');
  await target.close();
});
