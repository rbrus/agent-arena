/**
 * Guarded webhook egress (threat-model-arena G-3): https only, no private /
 * loopback / link-local / metadata destination (checked at connect time, so a
 * hostname that RESOLVES to one is refused too), redirects never followed, and
 * the dev/test opt-in for local receivers is ignored in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  EgressRefused,
  WebhookDeliverer,
  checkEgressUrl,
  createStores,
  guardedPost,
  isForbiddenAddress,
} from '../src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

test('isForbiddenAddress: private, loopback, link-local, metadata, CGNAT, multicast and embedded forms', () => {
  const forbidden = [
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1', '::127.0.0.1', 'fe80::1%eth0', 'not-an-ip',
  ];
  for (const ip of forbidden) assert.equal(isForbiddenAddress(ip), true, `${ip} must be forbidden`);
  // G-25: every IPv6 transition form is refused for webhooks, even around a public v4.
  for (const ip of ['::ffff:8.8.8.8', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2002:0808:0808::1']) {
    assert.equal(isForbiddenAddress(ip), true, `${ip} must be forbidden (transition form)`);
  }
  const allowed = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '2a00:1450:4001:80b::200e'];
  for (const ip of allowed) assert.equal(isForbiddenAddress(ip), false, `${ip} must be allowed`);
});

test('checkEgressUrl: https only, no userinfo, no forbidden literal address', () => {
  const refused: Array<[string, string]> = [
    ['http://hooks.example.com/x', 'scheme_not_https'],
    ['ftp://hooks.example.com/x', 'scheme_not_https'],
    ['https://user:pw@hooks.example.com/x', 'userinfo_in_url'],
    ['https://127.0.0.1/x', 'forbidden_address'],
    ['https://169.254.169.254/latest/meta-data', 'forbidden_address'],
    ['https://[::1]:8443/x', 'forbidden_address'],
    ['https://[::ffff:10.0.0.1]/x', 'forbidden_address'],
    ['not a url', 'malformed_url'],
  ];
  for (const [url, reason] of refused) {
    assert.throws(() => checkEgressUrl(url), (e: unknown) => e instanceof EgressRefused && e.reason === reason, url);
  }
  assert.equal(checkEgressUrl('https://hooks.example.com/wot').hostname, 'hooks.example.com');
});

test('a hostname that resolves to loopback is refused at connect time (no request sent)', async () => {
  await assert.rejects(
    guardedPost('https://localhost:9/hook', { 'content-type': 'application/json' }, '{}'),
    (e: unknown) => e instanceof EgressRefused && e.reason === 'forbidden_address',
  );
});

test('redirects are never followed', async () => {
  let secondHit = 0;
  const second = http.createServer((_req, res) => {
    secondHit += 1;
    res.end('ok');
  });
  await new Promise<void>((r) => second.listen(0, '127.0.0.1', () => r()));
  const secondPort = (second.address() as AddressInfo).port;
  const first = http.createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `http://127.0.0.1:${secondPort}/metadata`);
    res.end();
  });
  await new Promise<void>((r) => first.listen(0, '127.0.0.1', () => r()));
  const firstPort = (first.address() as AddressInfo).port;
  try {
    // The dev/test opt-in is needed to reach a loopback receiver at all.
    const res = await guardedPost(`http://127.0.0.1:${firstPort}/hook`, {}, '{}', { allowPrivateTargets: true });
    assert.equal(res.status, 302, 'the 3xx is reported, not followed');
    assert.equal(secondHit, 0, 'the redirect target was never contacted');
  } finally {
    await new Promise<void>((r) => first.close(() => r()));
    await new Promise<void>((r) => second.close(() => r()));
  }
});

test('WebhookDeliverer refuses a webhook that points at a private destination, without retrying', async () => {
  const stores = createStores();
  await stores.webhooks.create({ ownerId: 'own_x', url: 'https://localhost:9/hook', events: ['match.end'] });
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const d = new WebhookDeliverer({ store: stores.webhooks, log: (_l, msg, fields) => logs.push({ msg, fields }), backoffMs: [5, 5] });
  d.matchEnd({
    matchId: 'mat_01J8ZK9QMR4T7V2X0PABCDE3FG',
    league: 'core',
    winner: 'A',
    reason: 'ascension',
    finalScores: { A: 1, B: 0 },
    ticksPlayed: 1,
    replayId: 'rpl_01J8ZK9QMR4T7V2X0PABCDE3FG',
    replayHash: `sha256:${'0'.repeat(64)}`,
    players: [{ player_id: 'A', agent_id: 'agt_01J8ZK9QMR4T7V2X0PABCDE3FG', display_name: 'A', ownerId: 'own_x' }],
  });
  for (let i = 0; i < 50 && logs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  d.close();
  assert.deepEqual(logs.map((l) => l.msg), ['webhook_delivery_refused']);
  assert.equal(logs[0].fields?.reason, 'forbidden_address');
});

test('the private-target opt-in is ignored in production', () => {
  const body = `
    const { checkEgressUrl } = await import(${JSON.stringify(join(HERE, '..', 'src', 'egress.ts'))});
    try { checkEgressUrl('http://127.0.0.1:8080/x', { allowPrivateTargets: true }); console.log('allowed'); }
    catch (e) { console.log('refused:' + e.reason); }
  `;
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      encoding: 'utf8',
      cwd: join(HERE, '..'),
    });
  const prod = run({ WOT_SECRET_PEPPER: 'p'.repeat(40) });
  assert.equal(prod.status, 0, prod.stderr);
  assert.equal(prod.stdout.trim(), 'refused:scheme_not_https');
  const dev = run({ WOT_ENV: 'development' });
  assert.equal(dev.stdout.trim(), 'allowed');
});
