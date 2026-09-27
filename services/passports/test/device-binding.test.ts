/**
 * contracts 2.2.0 / G-10: `RegisterAgentRequest.device_binding` is accepted and
 * IGNORED. A registration that sends it succeeds, stores nothing of it, and the
 * minted access token carries no `cnf` (or any DPoP-related) claim; wot-auth
 * never mints one.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-db-keys-'));
process.env.WOT_SECRET_PEPPER = 'test-pepper-device-binding';
process.env.WOT_DEV_AUTH = '1';

const { decodeJwt } = await import('jose');
const { createStores } = await import('wot-store');
const { mintAccessToken, verifyAccessToken } = await import('wot-auth');
const { createPassportsApp, setLogSink } = await import('../src/index.ts');

const stores = createStores();
const lines: string[] = [];
let restore: ReturnType<typeof setLogSink>;
let server: http.Server;
let base: string;

before(async () => {
  restore = setLogSink((_l, line) => lines.push(line));
  server = http.createServer(createPassportsApp({ stores }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  setLogSink(restore);
  await new Promise<void>((r) => server.close(() => r()));
});

const JWK = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };

test('registration with device_binding succeeds; the token has no cnf / DPoP claim', async () => {
  const reg = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': 'own_dev' },
    body: JSON.stringify({ display_name: 'Bound Agent', device_binding: { enabled: true, jwk: JWK } }),
  });
  assert.equal(reg.status, 201, await reg.clone().text());
  const regJson = (await reg.json()) as Record<string, unknown>;
  assert.ok(!('device_binding' in regJson), 'not echoed');
  const { client_id, client_secret } = regJson as { client_id: string; client_secret: string };

  const tok = await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id, client_secret }).toString(),
  });
  assert.equal(tok.status, 200);
  const tokJson = (await tok.json()) as { access_token: string; token_type: string };
  assert.equal(tokJson.token_type, 'Bearer', 'plain bearer, not DPoP');
  const claims = decodeJwt(tokJson.access_token);
  assert.ok(!('cnf' in claims), `no cnf claim: ${JSON.stringify(claims)}`);
  for (const k of Object.keys(claims)) assert.doesNotMatch(k, /cnf|jkt|dpop|device/i);
  const verified = await verifyAccessToken(tokJson.access_token);
  assert.ok(!('cnf' in verified));

  // Nothing of the binding is stored with the passport.
  const rec = await stores.passports.getByClientId(client_id);
  assert.ok(rec);
  // (B3c) The passport's own server-minted signing key is the one JWK a record holds;
  // it is never the ignored device_binding key.
  const { signingKey, ...rest } = rec;
  assert.ok(signingKey && signingKey.publicJwk.x !== JWK.x, 'the device_binding key is not adopted as the signing key');
  assert.doesNotMatch(JSON.stringify(signingKey), /device|11qYAYKx/i);
  assert.doesNotMatch(JSON.stringify(rest), /device|jwk|11qYAYKx/i);
  // At most a one-line deprecation note, carrying no binding material.
  const notes = lines.filter((l) => l.includes('deprecated_field_ignored'));
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /11qYAYKx|jwk/);
});

test('an invalid device_binding shape is still rejected by the contract schema (400)', async () => {
  const reg = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': 'own_dev2' },
    body: JSON.stringify({ display_name: 'Bad Binding', device_binding: { enabled: 'yes' } }),
  });
  assert.equal(reg.status, 400);
});

test('wot-auth mint ignores any cnf-like input: no cnf claim is ever minted', async () => {
  const jwt = await mintAccessToken({
    ownerId: 'own_dev',
    agentId: 'agt_01J0TESTTESTTESTTESTTESTTE',
    clientId: 'cid_01J0TESTTESTTESTTESTTESTTE',
    league: 'core',
    scope: ['play:duel'],
    ...({ cnfJkt: 'thumbprint-should-be-ignored', cnf: { jkt: 'x' } } as object),
  } as Parameters<typeof mintAccessToken>[0]);
  const claims = decodeJwt(jwt);
  assert.ok(!('cnf' in claims));
  assert.ok(!JSON.stringify(claims).includes('thumbprint-should-be-ignored'));
});
