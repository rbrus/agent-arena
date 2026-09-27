/**
 * G-6 (service level): every passports log sink is redacted by key AND value,
 * at any depth, including error objects handed to the terminal errorHandler and
 * request header bags. Secrets are injected at depth 3 and in header values;
 * the test captures the sink and asserts none of them reach it. Also covers the
 * configured pepper and the live signing key (registered at load).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PEPPER = 'pepper-for-g6-Zq9vN3kT1xL8wR2yB6mC';
process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-g6-keys-'));
process.env.WOT_SECRET_PEPPER = PEPPER;
process.env.WOT_DEV_AUTH = '1';

const { exportJWK } = await import('jose');
const { createStores } = await import('wot-store');
const { generateClientSecret, getKeyMaterial, mintAccessToken } = await import('wot-auth');
const { createPassportsApp, errorHandler, log, setLogSink } = await import('../src/index.ts');

const lines: string[] = [];
const all = (): string => lines.join('\n');
let restore: ReturnType<typeof setLogSink>;
let server: http.Server;
let base: string;

before(async () => {
  restore = setLogSink((_level, line) => lines.push(line));
  server = http.createServer(createPassportsApp({ stores: createStores() }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  setLogSink(restore);
  await new Promise<void>((r) => server.close(() => r()));
});

test('log(): secrets at depth 3 and in request-header values never reach the sink', async () => {
  const sk = generateClientSecret();
  const jwt = await mintAccessToken({ clientId: 'cid_01J0TESTTESTTESTTESTTESTTE', agentId: 'agt_01J0TESTTESTTESTTESTTESTTE', ownerId: 'own_dev', scope: ['play:duel'], league: 'core' } as never);
  lines.length = 0;
  log('info', `startup ${sk}`, {
    level1: { level2: { level3: { client_secret: sk, harmless: `embedded ${jwt} here` } } },
    arr: [[{ token: jwt }], `pepper=${PEPPER}`],
    headers: {
      authorization: `Bearer ${jwt}`,
      cookie: `sid=${sk}`,
      'x-custom': `Bearer ${jwt}`,
      'x-api-key': 'k-0123456789abcdef',
      'user-agent': 'curl/8',
    },
    client_id: 'cid_01J0TESTTESTTESTTESTTESTTE',
  });
  const out = all();
  for (const s of [sk, jwt, PEPPER, 'k-0123456789abcdef', jwt.split('.')[2]]) {
    assert.ok(!out.includes(s), `secret reached the sink: ${s.slice(0, 12)}…\n${out}`);
  }
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.headers['user-agent'], 'curl/8');
  assert.equal(rec.client_id, 'cid_01J0TESTTESTTESTTESTTESTTE');
  assert.equal(rec.level1.level2.level3.client_secret, '[redacted]');
});

test('log(): the live signing key (private scalar) is registered and redacted', async () => {
  const km = await getKeyMaterial();
  const { d } = await exportJWK(km.privateKey);
  assert.ok(d && d.length > 20);
  lines.length = 0;
  log('warn', 'oops', { detail: { k: { v: `d=${d}` } }, raw: Buffer.from(d!).toString('base64') });
  assert.ok(!all().includes(d!), all());
  assert.ok(!all().includes(Buffer.from(d!).toString('base64')), all());
});

test('errorHandler: a JWT / wotk_sk_ inside the error message (and cause) is not logged', async () => {
  const sk = generateClientSecret();
  const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlc2lnbmF0dXJl'; // EXAMPLE: synthetic value for this test, not a credential
  lines.length = 0;
  const res = {
    headersSent: false,
    locals: { requestId: 'req_test' },
    statusCode: 0,
    setHeader() {},
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json() {},
  };
  const err = Object.assign(new Error(`verify failed for ${jwt} using ${sk}`, { cause: new Error(`Bearer ${jwt}`) }), {
    request: { headers: { authorization: `Bearer ${jwt}` } },
  });
  errorHandler(err, { method: 'POST', path: '/v1/oauth/token', headers: { authorization: `Basic ${sk}` } } as never, res as never, () => {});
  assert.equal(res.statusCode, 500);
  const out = all();
  assert.ok(out.includes('unhandled_error'), out);
  assert.ok(!out.includes(jwt) && !out.includes(sk), out);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.err.name, 'Error');
  assert.ok(!('request' in rec.err), 'request options are never logged');
});

test('end to end over HTTP: register + token + a bad Basic header leave no secret in any log line', async () => {
  lines.length = 0;
  const reg = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': 'own_dev' },
    body: JSON.stringify({ display_name: 'Log Probe' }),
  });
  assert.equal(reg.status, 201);
  const { client_id, client_secret } = (await reg.json()) as { client_id: string; client_secret: string };
  const tok = await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id, client_secret }).toString(),
  });
  assert.equal(tok.status, 200);
  const { access_token } = (await tok.json()) as { access_token: string };
  await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}x`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const out = all();
  assert.ok(lines.length > 0, 'the flow logs something');
  assert.ok(!out.includes(client_secret), out);
  assert.ok(!out.includes(access_token), out);
  assert.ok(!out.includes(PEPPER), out);
});
