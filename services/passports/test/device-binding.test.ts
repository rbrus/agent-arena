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

/**
 * Every property name in a JSON value, recursively. The "nothing of the binding is stored"
 * checks look at NAMES structurally and at the binding's key material by exact value: a
 * case-insensitive regex over the serialized record also scanned random ids, and a ULID
 * holding "JWK" (Crockford base32 has J, W, K; about 1 registration in 700) failed the
 * test with nothing stored (flake seen 2026-09-27; regression below).
 */
const keysOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  return out;
};
/** The binding's key material (the public `x`, or any 8+ char slice of it) appears nowhere. */
const holdsBindingKey = (s: string): boolean => {
  for (let i = 0; i + 8 <= JWK.x.length; i++) if (s.includes(JWK.x.slice(i, i + 8))) return true;
  return false;
};
const BINDING_NAME = /device|jwk|cnf|jkt|dpop/i;

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
  assert.deepEqual(keysOf(signingKey).filter((k) => /device/i.test(k)), [], 'no device_* field in the signing key');
  assert.ok(!holdsBindingKey(JSON.stringify(signingKey)), 'the signing key holds none of the binding key');
  assert.deepEqual(keysOf(rest).filter((k) => BINDING_NAME.test(k)), [], 'no binding-named field in the record');
  assert.ok(!holdsBindingKey(JSON.stringify(rest)), 'the record holds none of the binding key');
  // At most a one-line deprecation note, carrying no binding material.
  const notes = lines.filter((l) => l.includes('deprecated_field_ignored'));
  assert.equal(notes.length, 1);
  const note = JSON.parse(notes[0]) as Record<string, unknown>;
  assert.equal(note.field, 'device_binding', 'the note names the ignored field');
  assert.deepEqual(keysOf(note).filter((k) => BINDING_NAME.test(k)), [], 'no binding-named field in the note');
  assert.ok(!holdsBindingKey(notes[0]), 'the note holds none of the binding key');
});

test('regression: the stored-record checks see binding names and key material, not random ids that spell them', () => {
  // A record whose ids spell JWK / device / cnf (the 2026-09-27 flake) holds no binding.
  const benign = { clientId: 'cid_01M3HBPN0FB9ASJQ8JWKEG3R6Z', agentId: 'agt_01DEVICE0CNF0JKT0JWK000000', displayName: 'jwk device' };
  assert.deepEqual(keysOf(benign).filter((k) => BINDING_NAME.test(k)), []);
  assert.ok(!holdsBindingKey(JSON.stringify(benign)));
  // Each way the binding could leak is still caught.
  assert.deepEqual(keysOf({ a: 1, deviceBinding: { enabled: true } }).filter((k) => BINDING_NAME.test(k)), ['deviceBinding']);
  assert.deepEqual(keysOf({ a: [{ jwk: {} }] }).filter((k) => BINDING_NAME.test(k)), ['jwk']);
  assert.deepEqual(keysOf({ cnf: { jkt: 'x' } }).filter((k) => BINDING_NAME.test(k)), ['cnf', 'jkt']);
  assert.ok(holdsBindingKey(JSON.stringify({ k: JWK.x })));
  assert.ok(holdsBindingKey(JSON.stringify({ k: `pre${JWK.x.slice(20, 30)}post` })), 'a slice of the key is caught');
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
