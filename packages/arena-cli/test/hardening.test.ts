/**
 * Stage C2a (docs/phase-7/SECURITY-REVIEW.md): G-20 bounded WebSocket
 * buffering, G-21 lint:net coverage, G-22 one-line terminal output, G-23
 * Retry-After and the request ceiling, G-26 diagnostics refused, G-27
 * serve-reference hardening.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { serveReferenceCommand } from '../src/commands/serve-reference.ts';
import { CliError } from '../src/errors.ts';
import { assertNoDiagnostics, dashName, diagnosticFlags, disableDiagnosticReports, splitNodeOptions } from '../src/hardening.ts';
import { NetContext, openWebSocket, policyFor } from '../src/net/index.ts';
import { SessionStore, startReferenceServer, validRpcId } from '../src/reference/serve.ts';
import { ReferenceAgent } from '../src/reference/policy.ts';
import { requestCeiling } from '../src/runner.ts';
import { info, out, setOutputMode } from '../src/ui.ts';
import { PKG, runCli, scratch, stub } from './helpers.ts';

const MiB = 1024 * 1024;

async function floodServer(frames: number, frameBytes: number) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const closes: { code: number; reason: string }[] = [];
  wss.on('connection', (ws) => {
    const f = Buffer.alloc(frameBytes, 0x78);
    ws.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }));
    for (let i = 0; i < frames && ws.readyState === ws.OPEN; i++) ws.send(f);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = new URL(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  return {
    url,
    closes,
    close: () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      server.close();
    },
  };
}

test('G-20: a WS target streaming > 64 MiB of unsolicited frames is cut off after a bounded queue, with close 1008 and a reason', async () => {
  const srv = await floodServer(1100, 60 * 1024); // 1100 x 60 KiB = 66 MiB
  const ctx = new NetContext({ policy: policyFor(srv.url, {}), target: srv.url, userAgent: 'c2a', runId: 'c2a', rps: 0 });
  const before = process.memoryUsage().arrayBuffers;
  const sock = await openWebSocket(ctx, srv.url, { deadline: performance.now() + 2000, maxPayload: 64 * 1024 });
  await new Promise((r) => setTimeout(r, 1000));
  const st = sock.stats();
  assert.match(st.overflow ?? '', /unread messages/, 'the connection was closed for flooding');
  assert.ok(st.totalBytes <= 5 * 64 * 1024, `the client accepted ${st.totalBytes} bytes before cutting off`);
  assert.equal(st.queuedMessages, 0, 'the queue was dropped');
  const next = await sock.next(performance.now() + 100);
  assert.deepEqual([next.kind, (next as { code?: number }).code], ['closed', 1008]);
  await assert.rejects(sock.send('{}'), /arena closed the WebSocket \(1008\)/);
  const growth = process.memoryUsage().arrayBuffers - before;
  sock.close();
  ctx.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(srv.closes.some((c) => c.code === 1008 && /^arena: /.test(c.reason)) || srv.closes.some((c) => c.code === 1006), `server saw ${JSON.stringify(srv.closes)}`);
  srv.close();
  assert.ok(growth < 32 * MiB, `buffer growth ${Math.round(growth / MiB)} MiB`);
});

test('G-20: a client that keeps reading is still bounded per connection (total bytes)', async () => {
  const srv = await floodServer(1100, 60 * 1024);
  const ctx = new NetContext({ policy: policyFor(srv.url, {}), target: srv.url, userAgent: 'c2a', runId: 'c2a', rps: 0 });
  const sock = await openWebSocket(ctx, srv.url, { deadline: performance.now() + 2000, maxPayload: 64 * 1024, limits: { maxConnectionBytes: 8 * MiB } });
  let messages = 0;
  for (;;) {
    const e = await sock.next(performance.now() + 2000);
    if (e.kind !== 'message') break;
    messages++;
  }
  const st = sock.stats();
  assert.match(st.overflow ?? '', /bytes received on one connection/);
  assert.ok(st.totalBytes <= 8 * MiB + 64 * 1024, `${st.totalBytes}`);
  assert.ok(messages > 16 && messages < 150, `${messages} messages read`);
  sock.close();
  ctx.close();
  srv.close();
});

test('G-20 end to end: a flooding WS target costs decisions, not memory; the warning names the bound', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  // A burst of tiny unsolicited frames per observation: they arrive in one TCP chunk, faster than any decision reads them.
  wss.on('connection', (ws) => ws.on('message', () => { for (let i = 0; i < 2000; i++) ws.send('x'); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--tier', 'edge', '--target', `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, '--out', scratch()]);
    assert.ok(r.code === 0 || r.code === 1, `completed with a verdict (exit ${r.code}): ${r.stderr.slice(-400)}`);
    assert.match(r.stderr, /arena closed the WebSocket \(1008\): more than 16 unread messages/);
  } finally {
    wss.close();
    server.closeAllConnections();
    server.close();
  }
});

test('G-21: lint:net catches multi-line imports, WebSocketStream, computed globals, require aliasing, eval; takes an absolute root', () => {
  const root = scratch();
  const dir = join(root, 'src');
  mkdirSync(join(dir, 'net'), { recursive: true });
  writeFileSync(join(dir, 'net', 'allowed.ts'), "import http from 'node:http';\nexport const h = http;\n");
  const cases: Record<string, string> = {
    'multiline.ts': "import http\n  from\n  'node:http';\nexport const h = http;\n",
    'stream.ts': "export const s = new WebSocketStream('ws://x');\n",
    'computed.ts': "export const f = globalThis['fe' + 'tch'];\n",
    'proc.ts': "export const b = process['getBuiltin' + 'Module'];\n",
    'alias.ts': "const r = require;\nexport const h = r('node:http');\n",
    'evil.ts': "export const h = eval(\"import('node:' + 'http')\");\n",
    'worker.ts': "import { Worker } from 'node:worker_threads';\nexport const w = Worker;\n",
    'inspector.ts': "export const i = await import('node:inspector');\n",
  };
  const missed: string[] = [];
  for (const [name, src] of Object.entries(cases)) {
    writeFileSync(join(dir, name), src);
    const r = spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs'), dir], { encoding: 'utf8' });
    if (r.status === 0) missed.push(name);
    spawnSync('rm', [join(dir, name)]);
  }
  assert.deepEqual(missed, [], `lint:net passed: ${missed.join(', ')}`);
  const clean = spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs'), dir], { encoding: 'utf8' });
  assert.equal(clean.status, 0, `src/net/ itself is exempt: ${clean.stderr}`);
  // Prose in comments does not trip it.
  writeFileSync(join(dir, 'doc.ts'), "// never call fetch() or require('node:http') here\n/* createRequire, eval(x) */\nexport const x = 1;\n");
  assert.equal(spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs'), dir]).status, 0);
});

test('G-21: the bundle check refuses non-allowlisted packages and network imports from bundled sources outside src/net/', async () => {
  const { checkMetafile } = (await import(join(PKG, 'scripts', 'lint-net.mjs'))) as { checkMetafile: (m: unknown, r: (p: string) => string | null) => { path: string; rule: string }[] };
  const meta = {
    inputs: {
      'packages/arena-cli/src/net/client.ts': { imports: [{ path: 'node:http', kind: 'import-statement', external: true }] },
      'node_modules/ws/lib/websocket.js': { imports: [{ path: 'http', kind: 'require-call', external: true }] },
      'packages/arena-report/src/leak.ts': { imports: [{ path: 'node:https', kind: 'import-statement', external: true }] },
      'packages/wot-engine/src/sneaky.ts': { imports: [] },
      'node_modules/left-pad/index.js': { imports: [] },
      'node_modules/ajv/dist/core.js': { imports: [] },
      'packages/arena-scenarios/src/ws-user.ts': { imports: [{ path: 'node_modules/ws/index.js', kind: 'import-statement' }] },
    },
  };
  const sources: Record<string, string> = {
    'packages/arena-report/src/leak.ts': "import https from 'node:https';\n",
    'packages/wot-engine/src/sneaky.ts': "export const h = process.getBuiltinModule('node:http');\n",
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'node_modules/ajv/dist/core.js': "const x = process.getBuiltinModule('http');\n",
    'packages/arena-scenarios/src/ws-user.ts': "import WebSocket from 'ws';\n",
  };
  const v = checkMetafile(meta, (p) => sources[p] ?? null);
  const where = (p: string) => v.filter((x) => x.path === p).map((x) => x.rule).join(' | ');
  assert.match(where('packages/arena-report/src/leak.ts'), /imports node:https outside src\/net/);
  assert.match(where('packages/wot-engine/src/sneaky.ts'), /getBuiltinModule/);
  assert.match(where('node_modules/left-pad/index.js'), /not on BUNDLE_ALLOWLIST/);
  assert.match(where('node_modules/ajv/dist/core.js'), /network\/process primitive/);
  assert.match(where('packages/arena-scenarios/src/ws-user.ts'), /outside src\/net/);
  assert.equal(where('packages/arena-cli/src/net/client.ts'), '');
  assert.equal(where('node_modules/ws/lib/websocket.js'), '');
});

test('G-21: the real bundle passes (every bundled package allowlisted, no network import outside src/net/)', () => {
  const r = spawnSync(process.execPath, [join(PKG, 'scripts', 'lint-net.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bundle: \d+ inputs, packages ajv, ajv-draft-04, fast-deep-equal, fast-uri, json-schema-traverse, ws\)/);
});

test('G-22: one out() call is one line; nothing can start a line with a CI command', () => {
  const lines: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (c: string) => (lines.push(String(c)), true);
  (process.stderr as { write: unknown }).write = (c: string) => (lines.push(String(c)), true);
  try {
    setOutputMode({});
    out('replay_hash sha256:00\n::error file=README.md::x\r\n##vso[task.setvariable]1');
    out('::warning::starts the line');
    out('   ::notice:: after whitespace');
    info('##[group]x');
    out('section_start:1:x');
  } finally {
    (process.stdout as { write: unknown }).write = o;
    (process.stderr as { write: unknown }).write = e;
  }
  const all = lines.join('').split('\n').filter(Boolean);
  assert.equal(all.length, 5, all.join(' / '));
  for (const l of all) assert.ok(!/^\s*(::|##|section_)/.test(l), l);
  assert.match(all[0], /sha256:00\\n::error/, 'the newline is shown, not emitted');
});

test('G-23: Retry-After beyond --max-retry-after aborts the run; nothing is sent inside the window', async () => {
  const t = await stub((_q, _b, res) => res.writeHead(429, { 'retry-after': '3600' }).end('slow down'));
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', `${t.url}/act`, '--out', scratch()]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /wait 3600 s .*longer than the 30 s/);
  assert.match(r.stderr, /--max-retry-after/);
  assert.equal(t.requests.length, 1, 'exactly one request: none inside the Retry-After window');
  await t.close();
});

test('G-23: a Retry-After within the cap is honoured in full (no request inside the window); the request ceiling is printed first', async () => {
  const agent = new ReferenceAgent('coordinated');
  const t = await stub((_q, body, res, n) => {
    if (n === 1) return void res.writeHead(429, { 'retry-after': '1' }).end();
    const frame = agent.respond(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(frame ?? {}));
  });
  const times: number[] = [];
  t.server.on('request', () => times.push(Date.now()));
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', `${t.url}/act`, '--out', scratch()]);
  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assert.ok(times[1] - times[0] >= 950, `second request ${times[1] - times[0]} ms after the 429`);
  const lines = r.stderr.split('\n');
  const ceiling = lines.findIndex((l) => /^request ceiling: at most 121 requests to http:\/\/127\.0\.0\.1:\d+\/act \(1 episode\(s\) × ≤ 120 decisions\)/.test(l));
  assert.ok(ceiling >= 0 && ceiling < lines.findIndex((l) => l.startsWith('episode 0')), r.stderr);
  assert.ok(t.requests.length <= 121, `${t.requests.length} requests, over the printed ceiling`);
  await t.close();
  const bad = await runCli(['run', '--scenario', 'byzantine', '--target', 'ref:coordinated', '--max-retry-after', '99999', '--out', scratch()]);
  assert.equal(bad.code, 3);
});

test('G-23: request ceilings per transport', () => {
  assert.deepEqual(requestCeiling('rest', 'core', 5).requests, 5 * 121);
  assert.equal(requestCeiling('mcp', 'core', 2).requests, 2 * 121 + 4);
  assert.equal(requestCeiling('a2a', 'edge', 1).requests, 1 + 121 * (1 + 32));
});

test('G-26: Node diagnostics that can dump memory are refused unless ARENA_DEBUG=1', async () => {
  assert.deepEqual(diagnosticFlags(['--import', 'tsx'], ''), []);
  assert.deepEqual(diagnosticFlags(['--inspect-brk=0'], '--heapsnapshot-signal=SIGUSR2 --report-on-fatalerror --max-old-space-size=100'), ['--heapsnapshot-signal', '--inspect-brk', '--report-on-fatalerror']);
  // What the Node test runner passes to its children only configures facilities; none of it is refused.
  assert.deepEqual(diagnosticFlags(['--inspect-port=127.0.0.1:9229', '--inspect-publish-uid=stderr,http', '--report-signal=SIGUSR2', '--heapsnapshot-near-heap-limit=0', '--heap-prof-interval=524288'], ''), []);
  assert.deepEqual(diagnosticFlags([], '--heapsnapshot-near-heap-limit=3'), ['--heapsnapshot-near-heap-limit']);
  assert.throws(() => assertNoDiagnostics({ NODE_OPTIONS: '--inspect' }, []), (e: unknown) => e instanceof CliError && e.exitCode === 3 && /ARENA_DEBUG=1/.test(e.next ?? ''));
  assert.doesNotThrow(() => assertNoDiagnostics({ NODE_OPTIONS: '--inspect', ARENA_DEBUG: '1' }, []));
  assert.doesNotThrow(() => assertNoDiagnostics({}, ['--import', 'tsx']));
  for (const flag of ['--heapsnapshot-near-heap-limit=1', '--report-on-signal', '--report-uncaught-exception']) {
    const r = await runCli(['list-scenarios'], { NODE_OPTIONS: flag });
    assert.equal(r.code, 3, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, /refusing to run with Node diagnostics enabled/);
  }
  const ok = await runCli(['list-scenarios'], { NODE_OPTIONS: '--report-on-signal', ARENA_DEBUG: '1' });
  assert.equal(ok.code, 0, ok.stderr);
});

test('G-27: serve-reference refuses a non-loopback bind without --allow-non-loopback', async () => {
  const r = await runCli(['serve-reference', '--host', '0.0.0.0', '--port', '0']);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /--allow-non-loopback/);
  setOutputMode({ quiet: true, json: true });
  const s = await serveReferenceCommand({ host: '0.0.0.0', port: '0', allowNonLoopback: true });
  assert.ok(s.port > 0);
  await s.close();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  setOutputMode({});
});

test('G-27: MCP JSON-RPC ids must be string, number or null; sessions are LRU-capped and expire', async () => {
  assert.ok(validRpcId(1) && validRpcId('a') && validRpcId(null));
  assert.ok(!validRpcId({}) && !validRpcId([1]) && !validRpcId(true) && !validRpcId('x'.repeat(200)) && !validRpcId(Number.NaN));
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', maxMcpSessions: 2, mcpSessionTtlMs: 150 });
  const post = async (body: unknown, sid?: string) => {
    return new Promise<{ status: number; sid?: string; json: { id?: unknown; error?: { code: number } } }>((resolve) => {
      const payload = JSON.stringify(body);
      const req = request(ref.urls.mcp, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(sid ? { 'mcp-session-id': sid } : {}) } }, (res) => {
        let b = '';
        res.on('data', (c: Buffer) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, sid: res.headers['mcp-session-id'] as string | undefined, json: b ? JSON.parse(b) : {} }));
      });
      req.end(payload);
    });
  };
  const bad = await post({ jsonrpc: '2.0', id: { evil: 'x'.repeat(1000) }, method: 'tools/list' });
  assert.equal(bad.json.error?.code, -32600);
  assert.equal(bad.json.id, null, 'the invalid id is not echoed');
  const init = () => post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const s1 = (await init()).sid!;
  const s2 = (await init()).sid!;
  const s3 = (await init()).sid!;
  const list = (sid: string) => post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
  assert.equal((await list(s1)).status, 404, 'the least recently used session was evicted');
  assert.equal((await list(s3)).status, 200);
  assert.equal((await list(s2)).status, 200);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await list(s3)).status, 404, 'an idle session expires');
  await ref.close();

  let now = 0;
  const store = new SessionStore(3, 100, () => now);
  store.add('a');
  store.add('b');
  now = 50;
  assert.ok(store.touch('a'));
  now = 120;
  assert.ok(!store.touch('b'), 'b expired');
  assert.ok(store.touch('a'), 'a was refreshed at 50');
});

test('G-27: a request body that never finishes is answered 408 at the body deadline', async () => {
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', bodyTimeoutMs: 300 });
  const t0 = Date.now();
  const reply = await new Promise<string>((resolve) => {
    const sock = connect(ref.port, '127.0.0.1', () => sock.write('POST /act HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"t":'));
    let got = '';
    sock.on('data', (d) => (got += d));
    sock.on('close', () => resolve(got));
    setTimeout(() => sock.destroy(), 3000);
  });
  assert.match(reply, /^HTTP\/1\.1 408/);
  assert.ok(Date.now() - t0 < 2000, `answered after ${Date.now() - t0} ms`);
  await ref.close();
});

test('G-31: NODE_OPTIONS is split with Node\'s quoting rules before the diagnostic-flag check', () => {
  assert.deepEqual(splitNodeOptions('--a  "--b c" \'--d e\' "x\\"y" --f="g h"'), ['--a', '--b c', '--d e', 'x"y', '--f=g h']);
  assert.deepEqual(splitNodeOptions('   '), []);
  assert.deepEqual(splitNodeOptions('""'), ['']);
  assert.deepEqual(diagnosticFlags([], '"--report-on-fatalerror"'), ['--report-on-fatalerror']);
  assert.deepEqual(diagnosticFlags([], "'--report-on-signal'"), ['--report-on-signal']);
  assert.deepEqual(diagnosticFlags([], '--max-old-space-size=4096 "--inspect=0.0.0.0:9229"'), ['--inspect']);
  assert.deepEqual(diagnosticFlags([], '"--heapsnapshot-near-heap-limit=2" --stack-size=900'), ['--heapsnapshot-near-heap-limit']);
  assert.deepEqual(diagnosticFlags([], '--"inspect"'), ['--inspect'], 'quotes inside a token are removed as Node does');
  assert.deepEqual(diagnosticFlags([], '"--report-dir=/tmp/x y" "--inspect-port=0"'), [], 'configuring flags stay allowed when quoted');
  assert.throws(() => assertNoDiagnostics({ NODE_OPTIONS: '"--report-on-fatalerror"' }, []), (e: unknown) => e instanceof CliError && e.exitCode === 3);
});

test('G-31 backstop: diagnostic reports are forced off after the flag check', () => {
  const r = { reportOnFatalError: true, reportOnSignal: false, reportOnUncaughtException: true };
  assert.deepEqual(disableDiagnosticReports(r), ['reportOnFatalError', 'reportOnUncaughtException']);
  assert.deepEqual(r, { reportOnFatalError: false, reportOnSignal: false, reportOnUncaughtException: false });
  assert.deepEqual(disableDiagnosticReports(undefined), []);
});

test('G-41: option names are compared in their dash spelling (Node reads `_` as `-`); values are left alone', () => {
  assert.equal(dashName('--heapsnapshot_signal=SIGUSR2'), '--heapsnapshot-signal=SIGUSR2');
  assert.equal(dashName('--report_dir=/tmp/a_b'), '--report-dir=/tmp/a_b');
  assert.equal(dashName('--inspect_brk'), '--inspect-brk');
  assert.equal(dashName('not_a_flag'), 'not_a_flag');
  assert.deepEqual(diagnosticFlags(['--inspect_brk', '--inspect_wait=0'], '--heapsnapshot_signal=SIGUSR2 --report_on_fatalerror --report_uncaught_exception --debug_brk'), [
    '--debug_brk',
    '--heapsnapshot_signal',
    '--inspect_brk',
    '--inspect_wait',
    '--report_on_fatalerror',
    '--report_uncaught_exception',
  ]);
  assert.deepEqual(diagnosticFlags([], '--heapsnapshot_near_heap_limit=0 --inspect_port=9229 --report_signal=SIGUSR2'), [], 'configuring flags stay allowed in the underscore spelling');
  assert.throws(() => assertNoDiagnostics({ NODE_OPTIONS: '--heapsnapshot_signal=SIGUSR2' }, []), /--heapsnapshot_signal/);
  assert.throws(() => assertNoDiagnostics({}, ['--inspect_brk']), /--inspect_brk/);
});
