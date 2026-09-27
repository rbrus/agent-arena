/**
 * G-6: the shared log redactor. Secrets at depth >= 3, inside arrays, Maps,
 * header bags, error messages and error causes, and registered live secrets
 * (pepper, signing key) with their encodings, must never survive serialisation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REDACTED,
  _clearLogSecrets,
  generateClientSecret,
  redactForLog,
  redactText,
  registerLogSecret,
  serializeLogRecord,
} from '../src/index.ts';

const JWT =
  'eyJhbGciOiJFZERTQSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJjaWRfMDFKMFRFU1QifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl'; // EXAMPLE: synthetic value for this test, not a credential

test('value shapes are redacted as substrings, not only whole values', () => {
  const sk = generateClientSecret();
  const out = redactText(`auth failed for ${sk} with token=${JWT}; header "Bearer abcdefgh12345678"`);
  assert.ok(!out.includes(sk), out);
  assert.ok(!out.includes('wotk_sk_'), out);
  assert.ok(!out.includes(JWT.split('.')[1]), out);
  assert.ok(!out.includes('abcdefgh12345678'), out);
  assert.match(out, /Bearer \[redacted\]/);
  for (const s of ['ghp_' + 'a'.repeat(36), 'sk-' + 'b'.repeat(40), 'AKIA' + 'C'.repeat(16)]) {
    assert.ok(!redactText(`x ${s} y`).includes(s), s);
  }
});

test('nested objects, arrays, Maps and header bags: sensitive keys and values at depth 3+', () => {
  const sk = generateClientSecret();
  const record = {
    a: { b: { c: { client_secret: 'plain-but-keyed', note: `leaked ${sk}` } } },
    list: [{ deep: [{ access_token: 'xyz-keyed-value' }, `bearer ${JWT}`] }],
    headers: {
      authorization: 'Basic dXNlcjpwYXNz',
      cookie: 'session=abcdef0123456789',
      'x-api-key': 'k-1234567890',
      'x-forwarded-for': '203.0.113.9',
      'x-debug': `Bearer ${JWT}`,
    },
    map: new Map<string, unknown>([['set-cookie', 'sid=zzzzzzzzzz'], ['ok', 'visible']]),
    secret_version: 3,
    token_type: 'Bearer',
    client_id: 'cid_01J0TESTTESTTESTTESTTESTTE',
  };
  const line = serializeLogRecord(record);
  for (const leaked of [sk, 'plain-but-keyed', 'xyz-keyed-value', JWT, 'dXNlcjpwYXNz', 'abcdef0123456789', 'k-1234567890', 'zzzzzzzzzz']) {
    assert.ok(!line.includes(leaked), `${leaked} leaked: ${line}`);
  }
  const parsed = JSON.parse(line);
  assert.equal(parsed.a.b.c.client_secret, REDACTED);
  assert.equal(parsed.headers.authorization, REDACTED);
  assert.equal(parsed.headers['x-forwarded-for'], '203.0.113.9');
  assert.equal(parsed.map.ok, 'visible');
  assert.equal(parsed.secret_version, 3, 'benign operational key stays visible');
  assert.equal(parsed.token_type, 'Bearer');
  assert.equal(parsed.client_id, 'cid_01J0TESTTESTTESTTESTTESTTE');
});

test('errors: only name/message/code/status/cause, all redacted; no stack, no request options', () => {
  const sk = generateClientSecret();
  const cause = Object.assign(new Error(`upstream rejected ${JWT}`), { code: 'EUPSTREAM' });
  const err = Object.assign(new Error(`bad secret ${sk}`, { cause }), {
    status: 500,
    options: { headers: { authorization: `Bearer ${JWT}` } },
    config: { password: 'hunter2hunter2' },
  });
  const line = serializeLogRecord({ msg: 'x', err });
  assert.ok(!line.includes(sk) && !line.includes(JWT) && !line.includes('hunter2'), line);
  const e = JSON.parse(line).err;
  assert.deepEqual(Object.keys(e).sort(), ['cause', 'message', 'name', 'status']);
  assert.equal(e.cause.code, 'EUPSTREAM');
  assert.ok(!line.includes('at '), 'no stack frames');
});

test('registered live secrets (pepper, signing key) and their encodings are redacted anywhere', () => {
  _clearLogSecrets();
  const pepper = 'pepper-Zq9vN3kT1xL8wR2yB6mC';
  registerLogSecret(pepper);
  registerLogSecret('short'); // below MIN_SECRET_LENGTH: ignored, no collateral damage
  const b64 = Buffer.from(pepper).toString('base64');
  const line = serializeLogRecord({
    msg: `pepper is ${pepper}`,
    detail: { nested: { deeper: { v: `b64=${b64} uri=${encodeURIComponent(pepper)}` } } },
    [`k_${pepper}`]: 1,
    note: 'a short word stays',
  });
  assert.ok(!line.includes(pepper) && !line.includes(b64), line);
  assert.match(line, /a short word stays/);
  _clearLogSecrets();
});

test('cycles, depth and size are bounded; primitives pass through', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  let deep: Record<string, unknown> = { v: 'bottom' };
  for (let i = 0; i < 20; i++) deep = { d: deep };
  const out = redactForLog({ a, deep, big: 'x'.repeat(10_000), n: 1, b: true, z: null }) as Record<string, unknown>;
  assert.equal((out.a as Record<string, unknown>).self, '[circular]');
  assert.ok(JSON.stringify(out.deep).includes('[depth-limit]'));
  assert.ok((out.big as string).length < 5000);
  assert.equal(out.n, 1);
  assert.equal(out.b, true);
  assert.equal(out.z, null);
});

test('B3c: a passport signing key (private Ed25519 JWK) is redacted under any key, nested or serialised', async () => {
  const { mintPassportSigningKey } = await import('../src/press-signing.ts');
  const k = mintPassportSigningKey();
  const d = k.privateJwk.d;
  const line = serializeLogRecord({
    msg: `leaked ${JSON.stringify(k.privateJwk)}`,
    detail: { jwk_copy: { inner: k.privateJwk } },
    benign: { note: k.privateJwk },
    response: { client_id: 'cid_x', signing_key: k.privateJwk },
    embedded: JSON.stringify({ body: JSON.stringify(k.privateJwk) }),
    public_ok: k.publicJwk.kid,
  });
  assert.ok(!line.includes(d), line);
  // The public half and the kid stay visible (operators need the kid).
  assert.ok(line.includes(k.jkt), line);
});
