/**
 * The guarded network layer (threat model §2.5 abuse cases): address classes,
 * URL checks, the per-socket lookup guard (DNS rebinding, mixed answers),
 * redirects, credential origin binding, proxy env, byte and time caps.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LookupAddress } from 'node:dns';
import {
  addressVerdict,
  checkUrl,
  classifyAddress,
  DEFAULT_POLICY,
  httpRequest,
  isLoopbackLiteral,
  NetBlockedError,
  NetContext,
  NetTimeoutError,
  policyFor,
  RateLimiter,
  effectiveRps,
  type NetPolicy,
  type Resolver,
} from '../src/net/index.ts';
import { runCli, scratch, stub } from './helpers.ts';
import { startReferenceServer } from '../src/reference/serve.ts';

const deadline = (ms = 2000) => performance.now() + ms;
const v4 = (address: string): LookupAddress => ({ address, family: 4 });

function ctxFor(url: string, policy: NetPolicy, o: { resolver?: Resolver; followRedirects?: boolean; credential?: { header: string; value: string } } = {}) {
  return new NetContext({ policy, target: new URL(url), userAgent: 'agent-arena/test', runId: 'run_TEST', rps: 0, ...o });
}

test('address classes: the §2.1 blocklist, IPv4 spellings and IPv6 transition forms', () => {
  const table: [string, string][] = [
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.5.4', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['169.254.169.254', 'link_local'],
    ['fe80::1', 'link_local'],
    ['fd00:ec2::254', 'link_local'],
    ['0.0.0.0', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['224.0.0.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['198.51.100.7', 'reserved'],
    ['203.0.113.9', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['::', 'reserved'],
    ['ff02::1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['::ffff:8.8.8.8', 'ipv6_transition'],
    ['::ffff:127.0.0.1', 'ipv6_transition'],
    ['::ffff:169.254.169.254', 'link_local'],
    ['::ffff:a9fe:a9fe', 'link_local'],
    ['64:ff9b::a9fe:a9fe', 'link_local'],
    ['64:ff9b::808:808', 'ipv6_transition'],
    ['2002:a9fe:a9fe::1', 'link_local'],
    ['2002:0808:0808::1', 'ipv6_transition'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'], // Teredo (RFC 4380 example): client 192.0.2.45
    ['2001:0:4136:e378:8000:63bf:f7f7:f7f7', 'ipv6_transition'], // Teredo, client 8.8.8.8
  ];
  for (const [ip, cls] of table) assert.equal(classifyAddress(ip), cls, ip);
});

test('policy: private and loopback are opt-in, link-local needs its own flag, reserved never', () => {
  const p = (o: Partial<NetPolicy>): NetPolicy => ({ ...DEFAULT_POLICY, ...o });
  assert.equal(addressVerdict('10.0.0.1', p({})).allowed, false);
  assert.equal(addressVerdict('10.0.0.1', p({ allowPrivate: true })).allowed, true);
  assert.equal(addressVerdict('127.0.0.1', p({ loopbackLiteral: true })).allowed, true);
  assert.equal(addressVerdict('10.0.0.1', p({ loopbackLiteral: true })).allowed, false, 'loopback-literal opts in loopback only');
  assert.equal(addressVerdict('169.254.169.254', p({ allowPrivate: true })).allowed, false, 'metadata stays blocked under --allow-private');
  assert.equal(addressVerdict('169.254.169.254', p({ allowLinkLocal: true })).allowed, true);
  assert.equal(addressVerdict('224.0.0.1', p({ allowPrivate: true, allowLinkLocal: true })).allowed, false);
  assert.equal(addressVerdict('::ffff:127.0.0.1', p({})).allowed, false, 'IPv4-mapped is blocked by default');
});

test('URL checks: alternate IPv4 spellings normalise and are blocked; schemes, userinfo, metadata names', () => {
  for (const u of ['http://0177.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3:8080/', 'http://[fd00::1]/']) {
    assert.throws(() => checkUrl(new URL(u), DEFAULT_POLICY), NetBlockedError, u);
  }
  assert.throws(() => checkUrl(new URL('file:///etc/passwd'), DEFAULT_POLICY), NetBlockedError);
  assert.throws(() => checkUrl(new URL('ftp://example.com/'), DEFAULT_POLICY), NetBlockedError);
  assert.throws(() => checkUrl(new URL('https://u:p@example.com/'), DEFAULT_POLICY), NetBlockedError);
  assert.throws(() => checkUrl(new URL('http://metadata.google.internal/'), { ...DEFAULT_POLICY, allowPrivate: true }), NetBlockedError);
  assert.throws(() => checkUrl(new URL('http://foo.localhost/'), DEFAULT_POLICY), NetBlockedError);
  assert.throws(() => checkUrl(new URL('http://localhost:8080/'), DEFAULT_POLICY), NetBlockedError, 'localhost needs the literal opt-in');
  checkUrl(new URL('http://localhost:8080/'), policyFor(new URL('http://localhost:8080/'), {}));
  checkUrl(new URL('https://agent.example.com/act'), DEFAULT_POLICY);
  assert.equal(isLoopbackLiteral(new URL('http://127.0.0.1:1/')), true);
  assert.equal(isLoopbackLiteral(new URL('http://[::1]:1/')), true);
  assert.equal(isLoopbackLiteral(new URL('http://localhost:1/')), true);
  assert.equal(isLoopbackLiteral(new URL('http://my-laptop.local:1/')), false);
  assert.equal(isLoopbackLiteral(new URL('http://10.0.0.1:1/')), false);
});

test('lookup guard: every answer checked, mixed answers refused, and each new socket re-resolves (DNS rebinding)', async () => {
  let n = 0;
  const answers = [[v4('93.184.216.34')], [v4('127.0.0.1')], [v4('93.184.216.34'), v4('10.0.0.7')]];
  const ctx = ctxFor('http://rebind.example/', DEFAULT_POLICY, { resolver: async () => answers[n++] });
  const call = () =>
    new Promise<{ err: unknown; address: unknown }>((resolve) => ctx.lookup('rebind.example', { all: true }, (err, address) => resolve({ err, address })));
  const first = await call();
  assert.equal(first.err, null);
  assert.deepEqual(first.address, [{ address: '93.184.216.34', family: 4 }], 'the checked address is the one handed to connect (pinning)');
  const second = await call();
  assert.ok(second.err instanceof NetBlockedError, 'second resolution to 127.0.0.1 is refused');
  const third = await call();
  assert.ok(third.err instanceof NetBlockedError, 'one private address in a mixed answer refuses the whole connection');
  assert.equal(ctx.lookups, 3);
});

test('DNS rebinding end to end: a name that answers loopback first and private next is re-checked on the second socket', async () => {
  const s = await stub((_req, _body, res) => res.writeHead(200, { connection: 'close', 'content-type': 'application/json' }).end('{}'));
  let n = 0;
  // Policy as if the user had typed a loopback literal: loopback allowed, nothing else private.
  const policy: NetPolicy = { ...DEFAULT_POLICY, loopbackLiteral: true };
  const ctx = ctxFor(`http://rebind.example:${s.port}/`, policy, { resolver: async () => [v4(n++ === 0 ? '127.0.0.1' : '10.0.0.7')] });
  const url = new URL(`http://rebind.example:${s.port}/act`);
  const r1 = await httpRequest(ctx, { method: 'POST', url, body: '{}', deadline: deadline() });
  assert.equal(r1.status, 200);
  await assert.rejects(httpRequest(ctx, { method: 'POST', url, body: '{}', deadline: deadline() }), NetBlockedError);
  assert.equal(s.requests.length, 1, 'the second connection never reached anything');
  assert.equal(ctx.lookups, 2, 'one guarded lookup per new socket');
  ctx.close();
  await s.close();
});

test('a hostname that merely resolves to loopback stays blocked by default (no connection is made)', async () => {
  const s = await stub((_req, _body, res) => res.end('{}'));
  const url = new URL(`http://sneaky.example:${s.port}/`);
  const ctx = ctxFor(url.toString(), policyFor(url, {}), { resolver: async () => [v4('127.0.0.1')] });
  await assert.rejects(httpRequest(ctx, { method: 'POST', url, body: '{}', deadline: deadline() }), (e: unknown) => e instanceof NetBlockedError && /resolves to 127\.0\.0\.1/.test(e.message));
  assert.equal(s.connections, 0);
  ctx.close();
  // …and --allow-private lets it through, logged per new socket.
  const logs: string[] = [];
  const ctx2 = new NetContext({ policy: policyFor(url, { allowPrivate: true }), target: url, userAgent: 't', runId: 'run_TEST', rps: 0, resolver: async () => [v4('127.0.0.1')], onOptIn: (l) => logs.push(l) });
  const r = await httpRequest(ctx2, { method: 'POST', url, body: '{}', deadline: deadline() });
  assert.equal(r.status, 200);
  assert.match(logs.join('\n'), /opt-in connection to sneaky\.example -> 127\.0\.0\.1 \(loopback\)/);
  ctx2.close();
  await s.close();
});

test('redirects are refused by default: 302 to cloud metadata and to another origin are never followed', async () => {
  const other = await stub((_req, _body, res) => res.end('{"stolen":true}'));
  const s = await stub((req, _body, res) => {
    if (req.url === '/meta') res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    else if (req.url === '/cross') res.writeHead(302, { location: `${other.url}/grab` }).end();
    else if (req.url === '/same') res.writeHead(307, { location: '/final' }).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ auth: req.headers.authorization ?? null }));
  });
  const credential = { header: 'authorization', value: 'Bearer canary-redirect-0123456789' };
  const base = new URL(s.url);
  const ctx = ctxFor(s.url, policyFor(base, {}), { credential });
  const meta = await httpRequest(ctx, { method: 'POST', url: new URL('/meta', s.url), body: '{}', deadline: deadline() });
  assert.equal(meta.status, 302);
  assert.ok(meta.redirectRefused);
  const cross = await httpRequest(ctx, { method: 'POST', url: new URL('/cross', s.url), body: '{}', deadline: deadline() });
  assert.ok(cross.redirectRefused?.crossOrigin);
  ctx.close();
  // Even with --follow-redirects: cross-origin hops are not followed, same-origin hops are (re-checked).
  const ctxF = ctxFor(s.url, policyFor(base, {}), { credential, followRedirects: true });
  const cross2 = await httpRequest(ctxF, { method: 'POST', url: new URL('/cross', s.url), body: '{}', deadline: deadline() });
  assert.ok(cross2.redirectRefused?.crossOrigin);
  const same = await httpRequest(ctxF, { method: 'POST', url: new URL('/same', s.url), body: '{}', deadline: deadline() });
  assert.equal(same.status, 200);
  assert.equal(JSON.parse(same.body.toString()).auth, credential.value, 'credential kept on the same origin');
  ctxF.close();
  assert.equal(other.requests.length, 0, 'the second origin never received a request (so never a credential)');
  await s.close();
  await other.close();
});

test('credentials are attached only to the exact origin the user typed', () => {
  const ctx = ctxFor('https://agent.example.com/act', DEFAULT_POLICY, { credential: { header: 'authorization', value: 'Bearer abcdefgh12345' } });
  assert.deepEqual(ctx.credentialFor(new URL('https://agent.example.com/other')), { authorization: 'Bearer abcdefgh12345' });
  assert.deepEqual(ctx.credentialFor(new URL('https://agent.example.com:8443/act')), {});
  assert.deepEqual(ctx.credentialFor(new URL('http://agent.example.com/act')), {});
  assert.deepEqual(ctx.credentialFor(new URL('https://evil.example.com/act')), {});
  assert.deepEqual(ctx.credentialFor(new URL('wss://agent.example.com/ws')), { authorization: 'Bearer abcdefgh12345' }, 'wss is the https origin');
});

test('byte cap: a 10 MiB body is cut while streaming; Content-Encoding other than identity is refused', async () => {
  const s = await stub((req, _b, res) => {
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip' }).end('x');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < 10 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  const u = new URL(s.url);
  const ctx = ctxFor(s.url, policyFor(u, {}));
  const r = await httpRequest(ctx, { method: 'POST', url: new URL('/big', s.url), body: '{}', deadline: deadline(5000), maxBytes: 64 * 1024 });
  assert.equal(r.truncated, true);
  assert.ok(r.body.length <= 64 * 1024);
  await assert.rejects(httpRequest(ctx, { method: 'POST', url: new URL('/gzip', s.url), body: '{}', deadline: deadline() }), /identity only/);
  ctx.close();
  await s.close();
});

test('time cap: a target that never answers is cut at the deadline', async () => {
  const s = await stub(() => {
    /* never respond */
  });
  const u = new URL(s.url);
  const ctx = ctxFor(s.url, policyFor(u, {}));
  const t0 = performance.now();
  await assert.rejects(httpRequest(ctx, { method: 'POST', url: u, body: '{}', deadline: deadline(300) }), NetTimeoutError);
  assert.ok(performance.now() - t0 < 1500);
  ctx.close();
  await s.close();
});

test('proxy environment variables are ignored (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NODE_USE_ENV_PROXY)', async () => {
  const proxy = await stub((_req, _body, res) => res.writeHead(502).end());
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
  const out = scratch();
  const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', `http://127.0.0.1:${ref.port}/`, '--out', out, '-q'], {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
    http_proxy: proxy.url,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: '',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(proxy.connections, 0, 'nothing went through the proxy');
  assert.ok(ref.agent.decisions > 0, 'the target was reached directly');
  await ref.close();
  await proxy.close();
});

test('politeness: token bucket paces requests; defaults 5/s remote, unlimited loopback, max 50', () => {
  let now = 0;
  const rl = new RateLimiter(5, () => now);
  const waits = Array.from({ length: 8 }, () => rl.reserve());
  assert.deepEqual(waits.slice(0, 5), [0, 0, 0, 0, 0], 'one second of burst');
  assert.ok(waits[5] > 0 && waits[6] > waits[5], 'then paced');
  now += 2000;
  assert.equal(rl.reserve(), 0, 'refills over time');
  assert.equal(effectiveRps(undefined, false), 5);
  assert.equal(effectiveRps(undefined, true), 0);
  assert.equal(effectiveRps(500, false), 50);
  assert.throws(() => effectiveRps(-1, false));
});
