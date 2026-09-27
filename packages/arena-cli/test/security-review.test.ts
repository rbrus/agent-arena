/**
 * Phase 7 gate criterion 6 hand review (docs/phase-7/SECURITY-REVIEW.md):
 * targeted tests for the gaps the review found. G-19…G-22 were `todo` tests
 * documenting open findings; Stage C2a closed them and they are plain tests
 * now. Plain tests also pin controls the review verified.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { runCommand } from '../src/commands/run.ts';
import { CliError } from '../src/errors.ts';
import { NetContext, openWebSocket, policyFor, type Resolver } from '../src/net/index.ts';
import { setOutputMode } from '../src/ui.ts';
import { PKG, runCli, scratch, stub } from './helpers.ts';

/** The credential with every backslash escape removed: what a reader of the CI log reconstructs trivially. */
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');

test(
  'G-19a: a credential echoed by the target is redacted on stderr even when it contains Markdown-significant characters',
  async () => {
    const canary = `ghp_review_${randomBytes(16).toString('hex')}`;
    const target = await stub((req, _b, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad credentials', got: req.headers.authorization }));
    });
    const r = await runCli(
      ['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', `${target.url}/act`, '--auth', 'env:ARENA_REVIEW_TOKEN', '--out', scratch()],
      { ARENA_REVIEW_TOKEN: canary },
    );
    await target.close();
    assert.match(r.stderr, /target> /, 'the 401 body was shown');
    const tail = canary.slice(-24);
    assert.ok(!unescape(r.stderr).includes(tail), 'the echoed credential reached stderr (with one backslash inserted)');
  },
);

test(
  'G-19b: a credential that straddles the transport excerpt cut is not partially printed',
  async () => {
    const canary = `Zq${randomBytes(20).toString('hex')}`; // no Markdown-significant characters
    const target = await stub((_q, _b, res) => {
      // 490 zero-width spaces: survive the 512-unit slice, then are stripped by the sanitiser.
      res.writeHead(401, { 'content-type': 'text/plain' }).end(`${'​'.repeat(490)}${canary}`);
    });
    const r = await runCli(
      ['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', `${target.url}/act`, '--auth', 'env:ARENA_REVIEW_TOKEN', '--auth-header', 'X-Api-Key', '--out', scratch()],
      { ARENA_REVIEW_TOKEN: canary },
    );
    await target.close();
    assert.ok(!r.stderr.includes(canary.slice(0, 12)), 'a 22-character prefix of the credential reached stderr');
  },
);

test(
  'G-20: a WebSocket target cannot make the CLI buffer an unbounded number of inbound frames',
  async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const FRAMES = 400; // 400 x 60 KiB = 24 MiB, each frame under maxPayload
    wss.on('connection', (ws) => {
      const f = 'x'.repeat(60 * 1024);
      for (let i = 0; i < FRAMES; i++) ws.send(f);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = new URL(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const ctx = new NetContext({ policy: policyFor(url, {}), target: url, userAgent: 'review', runId: 'review', rps: 0 });
    const sock = await openWebSocket(ctx, url, { deadline: performance.now() + 2000, maxPayload: 64 * 1024 });
    await new Promise((r) => setTimeout(r, 750));
    const buffered = sock.drain();
    sock.close();
    ctx.close();
    wss.close();
    server.close();
    assert.ok(buffered <= 64, `the client buffered ${buffered} unsolicited frames (~${Math.round((buffered * 60) / 1024)} MiB)`);
  },
);

test('ownership attestation is refused before ANY network I/O, including DNS', async () => {
  setOutputMode({ quiet: true });
  let resolves = 0;
  const resolver: Resolver = async () => {
    resolves++;
    return [{ address: '93.184.216.34', family: 4 }];
  };
  await assert.rejects(
    runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'https://agent.arena-review.example/act', out: scratch(), resolver }, []),
    (e: unknown) => e instanceof CliError && e.exitCode === 3 && /target_ownership_unattested/.test(e.message),
  );
  assert.equal(resolves, 0, 'no DNS lookup happened before the refusal');
});

test('proxy environment variables are ignored by the ws transport too', async () => {
  const proxy = await stub((_q, _b, res) => res.writeHead(502).end());
  const { startReferenceServer } = await import('../src/reference/serve.ts');
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', `ws://127.0.0.1:${ref.port}/ws`, '--out', scratch(), '-q'], {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
    NODE_USE_ENV_PROXY: '1',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(proxy.connections, 0, 'nothing went through the proxy');
  await ref.close();
  await proxy.close();
});

test(
  'G-21: lint:net also catches createRequire, process.getBuiltinModule and child_process',
  () => {
    const root = scratch();
    const dir = join(root, 'src');
    mkdirSync(join(dir, 'net'), { recursive: true });
    const cases: Record<string, string> = {
      'create-require.ts': "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const h = r('node:http');\n",
      'builtin.ts': "export const h = process.getBuiltinModule('node:http');\n",
      'child.ts': "import { spawn } from 'node:child_process';\nspawn('curl', ['http://169.254.169.254/']);\n",
    };
    const missed: string[] = [];
    for (const [name, src] of Object.entries(cases)) {
      writeFileSync(join(dir, name), src);
      const r = spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs'), 'src'], { cwd: root, encoding: 'utf8' });
      if (r.status === 0) missed.push(name);
      spawnSync('rm', [join(dir, name)]);
    }
    assert.deepEqual(missed, [], `lint:net passed files that reach the network outside src/net/: ${missed.join(', ')}`);
  },
);

test(
  'G-22: a hostile report cannot start a CI log line (workflow command) through `replay` output',
  async () => {
    setOutputMode({ quiet: true });
    const dir = scratch();
    await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out: dir }, []);
    const path = join(dir, 'report.json');
    const { readFileSync } = await import('node:fs');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    report.episodes[0].replay_hash = `sha256:${'0'.repeat(8)}\n::error file=README.md,line=1::INJECTED`;
    writeFileSync(path, JSON.stringify(report));
    const r = await runCli(['replay', path, '--episode', '0']);
    const lines = `${r.stdout}\n${r.stderr}`.split('\n');
    assert.ok(!lines.some((l) => l.startsWith('::')), 'a report field started a line with a GitHub workflow command');
  },
);

// ── Re-review 2026-09-26 (C2a/C2f/B3a), docs/phase-7/SECURITY-REVIEW.md §8 ──
// Open findings are `todo` tests (they fail today by design); the fixing PR removes `todo`.

test(
  'G-29: a WS target that stops reading cannot hang a decision past its deadline (send is time-capped)',
  async () => {
    const { WsTransport } = await import('../src/transports/ws.ts');
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => (ws as unknown as { _socket: { pause(): void } })._socket.pause()); // accept, never read
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = new URL(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const ctx = new NetContext({ policy: policyFor(url, {}), target: url, userAgent: 'review', runId: 'review', rps: 0 });
    const t = new WsTransport(ctx, url);
    const session = await t.openEpisode('epi_review', performance.now() + 2000);
    const frame = { pad: 'x'.repeat(60 * 1024) };
    let hung = -1;
    try {
      for (let i = 0; i < 200 && hung < 0; i++) {
        const dl = performance.now() + 30;
        const r = await Promise.race([session.decide(frame, dl).then(() => 'answered'), new Promise((res) => setTimeout(() => res('hung'), 2000))]);
        if (r === 'hung') hung = i;
      }
    } finally {
      session.close();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      ctx.close();
    }
    assert.equal(hung, -1, `decision ${hung} was still pending 2 s after its 30 ms deadline (the target stopped reading)`);
  },
);

test('G-29: an explicit send deadline rejects with send_timeout (transport, address, budget, overshoot) and closes the socket; a reading target is unaffected', async () => {
  const { WsSendTimeoutError, WS_SEND_TIME_CAP_MS } = await import('../src/net/ws-client.ts');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let mode: 'stall' | 'echo' = 'stall';
  wss.on('connection', (ws) => {
    if (mode === 'stall') (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    else ws.on('message', (m) => ws.send(String(m).slice(0, 16)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = new URL(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const ctx = new NetContext({ policy: policyFor(url, {}), target: url, userAgent: 'review', runId: 'review', rps: 0 });
  try {
    const sock = await openWebSocket(ctx, url, { deadline: performance.now() + 2000, maxPayload: 64 * 1024 });
    const frame = 'x'.repeat(256 * 1024);
    let err: unknown = null;
    const t0 = performance.now();
    for (let i = 0; i < 400 && !err; i++) {
      try {
        await sock.send(frame, performance.now() + 50);
      } catch (e) {
        err = e;
      }
    }
    assert.ok(err instanceof WsSendTimeoutError, `expected a send_timeout, got ${String(err)}`);
    assert.equal(err.reason, 'send_timeout');
    assert.match(err.message, /^ws: a frame to ws:\/\/127\.0\.0\.1:\d+ was not accepted within \d+ ms \(\+\d+ ms over/);
    assert.ok(performance.now() - t0 < 10_000, 'the send was bounded');
    assert.equal(sock.stats().sendTimeout, true);
    await assert.rejects(() => sock.send('{}'), (e: unknown) => (e as { code?: string; reason?: string }).code === 'EARENA_WS_CLOSED' && (e as { reason?: string }).reason === 'send_timeout');
    assert.deepEqual(await sock.next(performance.now() + 50), (await sock.next(performance.now() + 50)));
    sock.close();

    mode = 'echo';
    const ok = await openWebSocket(ctx, url, { deadline: performance.now() + 2000, maxPayload: 64 * 1024 });
    for (let i = 0; i < 20; i++) {
      await ok.send(JSON.stringify({ i, pad: 'y'.repeat(32 * 1024) }), performance.now() + 1000);
      const e = await ok.next(performance.now() + 1000);
      assert.equal(e.kind, 'message');
    }
    assert.equal(ok.stats().pendingSends, 0);
    assert.equal(ok.stats().sendTimeout, undefined);
    // Without a deadline the send resolves once queued and is due by the next decision deadline.
    await ok.send('{"end":true}');
    assert.ok((await ok.next(performance.now() + 1000)).kind === 'message');
    ok.close();
    assert.equal(WS_SEND_TIME_CAP_MS, 6000);
  } finally {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.close();
    ctx.close();
  }
});

test(
  'G-30: --key never echoes its argument: a private key that does not start with -----BEGIN is not printed',
  async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { loadPublicKey } = await import('../src/keys.ts');
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const body = pem.split('\n')[1];
    const inputs = [`Bag Attributes\n    friendlyName: report-signing\n${pem}`, body, ` "${pem}"`];
    for (const arg of inputs) {
      let msg = '';
      try {
        loadPublicKey(arg);
      } catch (e) {
        msg = e instanceof CliError ? `${e.message} ${e.next ?? ''}` : String(e);
      }
      assert.ok(msg, 'a private key was accepted');
      assert.ok(!msg.includes(body.slice(8, 40)), `the private key material was quoted in the error: ${msg.slice(0, 120)}`);
    }
  },
);

test('G-30: verify --key never prints key material on stderr/stdout, whatever the argument or file looks like (CLI, canary grep)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { symlinkSync } = await import('node:fs');
  setOutputMode({ quiet: true });
  const dir = scratch();
  await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out: dir }, []);
  const report = join(dir, 'report.json');
  const kp = generateKeyPairSync('ed25519');
  const pem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const body = pem.split('\n')[1];
  const jwk = JSON.stringify(kp.privateKey.export({ format: 'jwk' }));
  const canaries = [body.slice(10, 34), JSON.parse(jwk).d.slice(4, 30)];
  const bagFile = join(dir, 'export.p12.pem');
  writeFileSync(bagFile, `Bag Attributes\n    friendlyName: report-signing\n${pem}`);
  const bodyFile = join(dir, 'body.txt');
  writeFileSync(bodyFile, `${body}\n`);
  const link = join(dir, 'link.pem');
  symlinkSync(bagFile, link);
  const big = join(dir, 'big.pem');
  writeFileSync(big, `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(70 * 1024)}\n${body}\n-----END PUBLIC KEY-----\n`);
  const args: [string, number][] = [
    [`Bag Attributes\n    friendlyName: report-signing\n${pem}`, 3],
    [body, 3],
    [` "${pem}"`, 3],
    [jwk, 3],
    [`'${jwk}'`, 3],
    [`garbage\n${body}`, 3],
    [bagFile, 3],
    [bodyFile, 3],
    [link, 3],
    [big, 3],
  ];
  for (const [arg, code] of args) {
    const r = await runCli(['verify', report, '--key', arg]);
    assert.equal(r.code, code, `exit code for a ${arg.length}-char argument: ${r.stderr.slice(0, 200)}`);
    const all = `${r.stdout}\n${r.stderr}`;
    for (const c of canaries) assert.ok(!all.includes(c), `key material reached the output: ${r.stderr.slice(0, 200)}`);
    // Nor any other slice of the argument long enough to carry material.
    if (arg.length > 40) assert.ok(!all.includes(arg.trim().slice(-40, -8)), 'a slice of the argument was echoed');
  }
});

test('G-30: loadPublicKey refuses symlinks and folders with O_NOFOLLOW/fstat, caps size, and still takes public PEM text, JWK text and files', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { symlinkSync } = await import('node:fs');
  const { loadPublicKey, MAX_KEY_BYTES } = await import('../src/keys.ts');
  const dir = scratch();
  const kp = generateKeyPairSync('ed25519');
  const pubPem = kp.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const pubJwk = JSON.stringify(kp.publicKey.export({ format: 'jwk' }));
  const file = join(dir, 'pub.pem');
  writeFileSync(file, pubPem);
  assert.equal(loadPublicKey(pubPem).asymmetricKeyType, 'ed25519');
  assert.equal(loadPublicKey(pubJwk).asymmetricKeyType, 'ed25519');
  assert.equal(loadPublicKey(file).asymmetricKeyType, 'ed25519');
  const link = join(dir, 'link.pem');
  symlinkSync(file, link);
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof CliError ? `${e.message} ${e.next ?? ''}` : String(e);
    }
    return '';
  };
  assert.match(msg(() => loadPublicKey(link)), /symbolic link/);
  assert.match(msg(() => loadPublicKey(dir)), /not a regular file/);
  const big = join(dir, 'big.pem');
  writeFileSync(big, 'x'.repeat(MAX_KEY_BYTES + 1));
  assert.match(msg(() => loadPublicKey(big)), /bytes/);
  assert.equal(MAX_KEY_BYTES, 64 * 1024);
  const missing = join(dir, 'no-such-canary-7f3a.pem');
  const m = msg(() => loadPublicKey(missing));
  assert.match(m, /not a key and not a readable file/);
  assert.ok(!m.includes('canary-7f3a'), 'the argument was echoed');
  const junk = join(dir, 'junk.pem');
  writeFileSync(junk, 'not a key canary-9e1b');
  const j = msg(() => loadPublicKey(junk));
  assert.ok(j && !j.includes('canary-9e1b') && !j.includes('junk.pem'), `the file or its path was echoed: ${j}`);
});

test(
  'G-31: a diagnostic flag quoted inside NODE_OPTIONS is refused too (Node accepts the quoted form)',
  async () => {
    const { diagnosticFlags } = await import('../src/hardening.ts');
    assert.deepEqual(diagnosticFlags([], '"--report-on-fatalerror"'), ['--report-on-fatalerror']);
    assert.deepEqual(diagnosticFlags([], '--max-old-space-size=4096 "--inspect=0.0.0.0:9229"'), ['--inspect']);
  },
);

test(
  'G-31 wiring: main.ts uses the quote-aware check from hardening.ts (so `NODE_OPTIONS=\'"--report-on-fatalerror"\' agent-arena …` exits 3)',
  async () => {
    const r = await runCli(['list-scenarios'], { NODE_OPTIONS: '"--report-on-fatalerror"' });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /refusing to run with Node diagnostics enabled \(--report-on-fatalerror\)/);
  },
);

test(
  'G-32: lint:net catches reflective access to process (Reflect.get / aliasing / property descriptors)',
  async () => {
    const { lintFile } = (await import(join(PKG, 'scripts', 'lint-net.mjs'))) as { lintFile: (p: string, t: string) => unknown[] };
    const cases = [
      "const k = ['getBuilt', 'inModule'].join('');\nexport const h = (Reflect.get(process, k) as (s: string) => unknown).call(process, 'node:' + 'http');\n",
      "const p = process as unknown as Record<string, (s: string) => unknown>;\nexport const h = p['getBuilt' + 'inModule']('node:' + 'http');\n",
      "export const h = (Object.getOwnPropertyDescriptor(process, 'getBuilt' + 'inModule')!.value as (s: string) => unknown)('node:' + 'https');\n",
    ];
    const missed = cases.filter((src) => lintFile('x.ts', src).length === 0);
    assert.equal(missed.length, 0, `lint:net passed ${missed.length} reflective loader(s)`);
  },
);

test(
  'G-33: an episode record cannot switch the target seat from recorded to regenerated (driver must match the RunSpec)',
  async () => {
    setOutputMode({ quiet: true });
    const dir = scratch();
    await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out: dir }, []);
    const path = join(dir, 'report.json');
    const { readFileSync } = await import('node:fs');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    // Claim an external agent; the record still says the squad was the in-process reference policy.
    report.run.spec.target = { transport: 'rest', url: 'https://agent.arena-review.example/act', ownership_attested: true };
    writeFileSync(path, JSON.stringify(report));
    const r = await runCli(['verify', path]);
    assert.notEqual(r.code, 0, 'verify accepted a report whose external target seat was regenerated from a reference policy');
  },
);

test(
  'G-25 residual: the CLI guard refuses deprecated site-local fec0::/10 like the shared blocklist does',
  async () => {
    const { classifyAddress } = await import('../src/net/guard.ts');
    assert.notEqual(classifyAddress('fec0::1'), 'public');
  },
);

test(
  'G-35: an echoed credential escaped as \\uXXXX (System.Text.Json default) or as HTML character references is redacted',
  async () => {
    const { clearSecrets, registerSecret, targetExcerpt } = await import('../src/redact.ts');
    const tok = `q7Rt2Lm9Xa4+Kp8/${randomBytes(12).toString('base64')}`; // standard base64: '+' and '/'
    registerSecret(tok, 'env');
    try {
      const esc = (s: string, f: (c: string) => string) => s.replace(/[+/=]/g, f);
      const forms = [
        `{"received":"${esc(tok, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`)}"}`,
        `<p>token: ${esc(tok, (c) => `&#${c.charCodeAt(0)};`)}</p>`,
        `<p>token: ${esc(tok, (c) => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`)}</p>`,
      ];
      for (const f of forms) {
        const out = targetExcerpt(f, 512);
        assert.ok(!out.includes(tok.slice(-12)), `the escaped credential survived redaction: ${out}`);
      }
    } finally {
      clearSecrets();
    }
  },
);
