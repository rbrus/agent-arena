/**
 * `serve-reference --ownership-token` (env ARENA_OWNERSHIP_TOKEN): the Sixi Arena ownership
 * proof, well-known-file method, for the hosted cross-check's run.app reference origins.
 * The gate (sixi-scanner go/arena/origins.go checkWellKnown) fetches GET
 * https://<host>/.well-known/sixi-verify, follows no redirect, and needs 200, Content-Type
 * text/plain, a body of at most 256 bytes whose trimmed value EQUALS the token
 * (`sixi-verify=` + 32 lower-case hex). Off by default; the value is never printed.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { serveReferenceCommand } from '../src/commands/serve-reference.ts';
import { CliError } from '../src/errors.ts';
import { loadPublicKeySet } from '../src/keys.ts';
import { OWNERSHIP_PROOF_PATH, OWNERSHIP_TOKEN_FORMAT, ownershipProofResponse, resolveOwnershipToken } from '../src/reference/ownership-proof.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { BIN, TSX, WORKSPACE } from './helpers.ts';
import { pubJwk } from './hosted-fixtures.ts';

// Built, not written out, so no token-shaped literal sits in the tree (secret scanners).
const TOKEN = 'sixi-verify=' + 'a1'.repeat(16);
const OTHER = 'sixi-verify=' + '0f'.repeat(16);
const ORIGIN = 'https://xcheck-ref.hosted.example';
const HOSTNAME = 'xcheck-ref.hosted.example';

let plain: ReferenceServer;
let off: ReferenceServer;
let hosted: ReferenceServer;
let hostedOff: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  plain = await startReferenceServer({ port: 0, policy: 'coordinated', ownershipToken: TOKEN });
  off = await startReferenceServer({ port: 0, policy: 'coordinated' });
  const runTokenKeys = loadPublicKeySet(pubJwk('sixi-arena-runtoken-ed25519-20261101'), '--run-token-key');
  hosted = await startReferenceServer({ port: 0, policy: 'coordinated', ownershipToken: TOKEN, hosted: { verifiedOrigin: ORIGIN, runTokenKeys, requireToken: true } });
  hostedOff = await startReferenceServer({ port: 0, policy: 'coordinated', hosted: { verifiedOrigin: ORIGIN, runTokenKeys, requireToken: true } });
});
after(async () => {
  await Promise.all([plain.close(), off.close(), hosted.close(), hostedOff.close()]);
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
function call(srv: ReferenceServer, path: string, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The Sixi gate's exact acceptance rule (go/arena/origins.go checkWellKnown), restated. */
function gateAccepts(r: Res, token: string): boolean {
  if (r.status !== 200) return false;
  const mt = String(r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mt !== 'text/plain') return false;
  if (r.body.length > 256) return false;
  return r.body.toString('utf8').trim() === token;
}

test('the proof route: GET answers exactly the token bytes as text/plain, no auth, and the gate rule accepts it', async () => {
  const r = await call(plain, OWNERSHIP_PROOF_PATH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, Buffer.from(TOKEN, 'utf8'), 'identical bytes: the token, no newline, nothing else');
  assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(r.headers['content-length'], String(TOKEN.length), 'a fixed length, not chunked');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers.location, undefined, 'never a redirect: the gate follows none');
  assert.ok(gateAccepts(r, TOKEN));
  assert.ok(!gateAccepts(r, OTHER), 'another host\'s token is not proven');
  // A query string does not change the answer (the gate sends none; the path is what matters).
  assert.deepEqual((await call(plain, `${OWNERSHIP_PROOF_PATH}?x=1`)).body, Buffer.from(TOKEN));
});

test('method rules: HEAD is 200 with no body; POST, PUT, DELETE, OPTIONS are 405 (Allow: GET, HEAD) and never carry the token', async () => {
  const head = await call(plain, OWNERSHIP_PROOF_PATH, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(head.headers['content-length'], String(TOKEN.length));
  for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const r = await call(plain, OWNERSHIP_PROOF_PATH, m, { 'content-type': 'text/plain' }, m === 'POST' ? TOKEN : undefined);
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.allow, 'GET, HEAD', m);
    assert.ok(!r.body.toString().includes('sixi-verify='), `${m} must not echo a token`);
  }
  assert.equal(ownershipProofResponse('GET', TOKEN).body, TOKEN);
});

test('off by default: without the option there is no route (404, like any unknown path), and the other routes are unchanged', async () => {
  const r = await call(off, OWNERSHIP_PROOF_PATH);
  assert.equal(r.status, 404);
  assert.ok(!r.body.toString().includes('sixi-verify='));
  assert.equal((await call(off, OWNERSHIP_PROOF_PATH, 'HEAD')).status, 404);
  // With the option, the agent is still served on the same listener.
  assert.equal((await call(plain, '/healthz')).status, 200);
  assert.equal((await call(plain, '/.well-known/agent-card.json')).status, 200);
  // Near-miss paths are not the proof.
  for (const p of ['/.well-known/sixi-verify/', '/.well-known/sixi-verify.txt', '/.well-known/SIXI-VERIFY', '/sixi-verify']) {
    const x = await call(plain, p);
    assert.equal(x.status, 404, p);
    assert.ok(!x.body.toString().includes('sixi-verify='), p);
  }
});

test('--hosted: the proof is served without a run token even under --require-run-token, but only for the verified Host and only as a plain GET/HEAD', async () => {
  const ok = await call(hosted, OWNERSHIP_PROOF_PATH, 'GET', { host: HOSTNAME });
  assert.equal(ok.status, 200);
  assert.ok(gateAccepts(ok, TOKEN));
  assert.equal((await call(hosted, OWNERSHIP_PROOF_PATH, 'GET', { host: `${HOSTNAME}:443` })).status, 200);
  assert.equal((await call(hosted, OWNERSHIP_PROOF_PATH, 'HEAD', { host: HOSTNAME })).status, 200);
  // Another name for the same server does not get the proof (Host allowlist, I-7).
  const wrongHost = await call(hosted, OWNERSHIP_PROOF_PATH, 'GET', { host: 'evil.example.net' });
  assert.equal(wrongHost.status, 421);
  assert.ok(!wrongHost.body.toString().includes('sixi-verify='));
  // The exemption is the proof path only: the agent still needs its run token.
  assert.equal((await call(hosted, '/.well-known/agent-card.json', 'GET', { host: HOSTNAME })).status, 401);
  assert.equal((await call(hosted, '/', 'POST', { host: HOSTNAME, 'content-type': 'application/json' }, '{}')).status, 401);
  assert.equal((await call(hosted, OWNERSHIP_PROOF_PATH, 'POST', { host: HOSTNAME }, '{}')).status, 401, 'no exemption for other methods');
  // A WebSocket upgrade on the proof path is not a way around the run token.
  const upgrade = await call(hosted, OWNERSHIP_PROOF_PATH, 'GET', { host: HOSTNAME, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('the sample nonce').toString('base64') });
  assert.equal(upgrade.status, 401);
  // Without the option the hosted server has no exemption at all.
  assert.equal((await call(hostedOff, OWNERSHIP_PROOF_PATH, 'GET', { host: HOSTNAME })).status, 401);
});

test('value rules: flag wins over the env; unset is off; empty, whitespace, upper-case, wrong prefix or length fail fast (exit 3) without quoting the value', () => {
  assert.equal(resolveOwnershipToken(undefined, {}), undefined);
  assert.equal(resolveOwnershipToken(TOKEN, {}), TOKEN);
  assert.equal(resolveOwnershipToken(undefined, { ARENA_OWNERSHIP_TOKEN: TOKEN }), TOKEN);
  assert.equal(resolveOwnershipToken(TOKEN, { ARENA_OWNERSHIP_TOKEN: OTHER }), TOKEN, 'the flag wins');
  assert.equal(resolveOwnershipToken(TOKEN, { ARENA_OWNERSHIP_TOKEN: '' }), TOKEN, 'the flag wins over a broken env too');
  const bad: [string, RegExp][] = [
    ['', /is empty/],
    [`${TOKEN}\n`, /whitespace/],
    [` ${TOKEN}`, /whitespace/],
    [TOKEN.toUpperCase(), /not a Sixi ownership token/],
    ['sixi-verify=' + 'A1'.repeat(16), /not a Sixi ownership token/],
    ['sixi-verify=' + 'a1'.repeat(15), /not a Sixi ownership token/],
    ['sixi-verify=' + 'a1'.repeat(17), /not a Sixi ownership token/],
    ['sixi-verify=' + 'g1'.repeat(16), /not a Sixi ownership token/],
    ['a1'.repeat(16), /not a Sixi ownership token/],
    [`sixi-verify:${'a1'.repeat(16)}`, /not a Sixi ownership token/],
    [`${TOKEN}<script>`, /not a Sixi ownership token/],
  ];
  for (const [v, why] of bad) {
    for (const [flag, env, source] of [[v, {}, '--ownership-token'], [undefined, { ARENA_OWNERSHIP_TOKEN: v }, 'ARENA_OWNERSHIP_TOKEN']] as const) {
      assert.throws(
        () => resolveOwnershipToken(flag, env),
        (e: unknown) => {
          assert.ok(e instanceof CliError);
          assert.equal(e.exitCode, 3);
          assert.match(e.message, why);
          assert.ok(e.message.startsWith(source), e.message);
          const text = `${e.message} ${e.next ?? ''}`;
          if (v.length) assert.ok(!text.includes(v.trim()) && !text.includes('a1a1'), 'the value is never quoted');
          return true;
        },
        JSON.stringify(v).slice(0, 40),
      );
    }
  }
  assert.ok(OWNERSHIP_TOKEN_FORMAT.test(TOKEN));
});

test('serveReferenceCommand: a malformed token is refused before anything listens', async () => {
  await assert.rejects(serveReferenceCommand({ port: '0', ownershipToken: 'sixi-verify=' + 'nope', env: {} }), (e: unknown) => e instanceof CliError && e.exitCode === 3);
  await assert.rejects(serveReferenceCommand({ port: '0', env: { ARENA_OWNERSHIP_TOKEN: '' } }), (e: unknown) => e instanceof CliError && e.exitCode === 3);
});

/** Start the real CLI and wait until it has printed where it listens (the --json document, or the health line). */
function startCli(args: string[], env: Record<string, string>): Promise<{ first: string; stop: () => Promise<{ stdout: string; stderr: string }> }> {
  const ready = (s: string): string | null => {
    if (args.includes('--json')) {
      try {
        JSON.parse(s);
        return s;
      } catch {
        return null;
      }
    }
    return /health .*\n/.test(s) ? s : null;
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, BIN, 'serve-reference', '--port', '0', ...args], {
      cwd: WORKSPACE,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const closed = new Promise<void>((r) => child.on('close', () => r()));
    const stop = async () => {
      child.kill('SIGTERM');
      await closed;
      return { stdout, stderr };
    };
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      stdout += d;
      const got = done ? null : ready(stdout);
      if (got !== null) {
        done = true;
        resolve({ first: got, stop });
      }
    });
    child.on('close', (code) => {
      if (!done) reject(new Error(`serve-reference exited ${code}: ${stderr}`));
    });
  });
}

test('CLI end to end: env and flag both serve the proof, the flag wins, and the token never appears in stdout or stderr', async () => {
  for (const [args, env, want] of [
    [['--json'], { ARENA_OWNERSHIP_TOKEN: TOKEN }, TOKEN],
    [['--json', '--ownership-token', OTHER], { ARENA_OWNERSHIP_TOKEN: TOKEN }, OTHER],
  ] as const) {
    const cli = await startCli([...args], env);
    const info = JSON.parse(cli.first) as { port: number; ownership_proof?: string };
    const fetched = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: info.port, path: OWNERSHIP_PROOF_PATH }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end();
    });
    const r = await fetched.catch((e: unknown) => e as Error);
    const { stdout, stderr } = await cli.stop();
    if (r instanceof Error) throw r;
    assert.equal(info.ownership_proof, OWNERSHIP_PROOF_PATH);
    assert.equal(r.status, 200);
    assert.equal(r.body, want);
    for (const t of [TOKEN, OTHER, 'a1a1', '0f0f']) assert.ok(!stdout.includes(t) && !stderr.includes(t), 'never printed');
  }
  // Text mode names the route, not the value.
  const text = await startCli([], { ARENA_OWNERSHIP_TOKEN: TOKEN });
  await new Promise((r) => setTimeout(r, 300)); // let the trailing info line land too
  const { stdout, stderr } = await text.stop();
  assert.match(stdout, /proof http:\/\/127\.0\.0\.1:\d+\/\.well-known\/sixi-verify {3}\(Sixi ownership token; value not shown\)/);
  assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN));
  // Without the option, the JSON line has no ownership_proof.
  const none = await startCli(['--json'], {});
  await none.stop();
  assert.equal((JSON.parse(none.first) as { ownership_proof?: string }).ownership_proof, undefined);
});

test('CLI: a malformed env value exits 3 with a next step and without the value', async () => {
  const bad = 'sixi-verify=' + 'ZZ'.repeat(16);
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', TSX, BIN, 'serve-reference', '--port', '0'], {
      cwd: WORKSPACE,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ARENA_OWNERSHIP_TOKEN: bad },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /ARENA_OWNERSHIP_TOKEN is not a Sixi ownership token/);
  assert.match(r.stderr, /POST \/api\/arena\/origins/);
  assert.ok(!r.stderr.includes('ZZZZ') && !r.stdout.includes('ZZZZ'));
});

test('--help documents the option and the env fallback', async () => {
  const r = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ['--import', TSX, BIN, '--help'], { cwd: WORKSPACE, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    child.stdout.on('data', (d) => (s += d));
    child.stderr.on('data', (d) => (s += d));
    child.on('close', () => resolve(s));
  });
  assert.match(r, /--ownership-token/);
  assert.match(r, /ARENA_OWNERSHIP_TOKEN/);
  assert.match(r, /\/\.well-known\/sixi-verify/);
});
