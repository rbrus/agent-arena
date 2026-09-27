/**
 * Phase 8 B3c (G-11): passport signing keys through the passports service.
 *
 *  - registration mints an Ed25519 key pair: the response carries the PRIVATE JWK
 *    once (`signing_key`, kid = RFC 7638 thumbprint), the store holds only the
 *    public half + kid, and the store-backed resolver serves exactly that half;
 *  - a signature made with the returned key verifies against the resolved key;
 *  - rotation revokes the key and returns a new one (the old kid no longer
 *    resolves); revocation and an owner ban revoke it (nothing resolves);
 *  - the store refuses a private or foreign-shaped key, and a kid that is not the
 *    thumbprint, creating nothing;
 *  - the private key never reaches a log line (register, rotate, and the shared
 *    redactor over the response body).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-sk-keys-'));
process.env.WOT_SECRET_PEPPER = 'test-pepper-signing-keys';
process.env.WOT_DEV_AUTH = '1';

const { createStores, passportKeyResolver, SigningKeyError } = await import('wot-store');
const { isEd25519PublicJwk, jwkThumbprint, mintPassportSigningKey, signDetachedJws, verifyDetachedJws } = await import('wot-auth');
const { createPassportsApp, log, setLogSink } = await import('../src/index.ts');

type Stores = ReturnType<typeof createStores>;
let stores: Stores;
let server: http.Server;
let base: string;
const lines: string[] = [];
let restore: ReturnType<typeof setLogSink>;

before(async () => {
  restore = setLogSink((_level, line) => lines.push(line));
  stores = createStores();
  server = http.createServer(createPassportsApp({ stores }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  setLogSink(restore);
  await new Promise<void>((r) => server.close(() => r()));
});

let ownerSeq = 0;
async function register(owner = `own_sk${++ownerSeq}`) {
  const res = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': owner },
    body: JSON.stringify({ display_name: 'Signer' }),
  });
  return { res, owner, json: (await res.json()) as Record<string, unknown> & { client_id: string; agent_id: string; signing_key: Record<string, string> } };
}

test('register: returns the private Ed25519 JWK once; the store keeps only the public half + kid; the resolver serves it', async () => {
  const { res, json } = await register();
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const sk = json.signing_key;
  assert.deepEqual(Object.keys(sk).sort(), ['alg', 'crv', 'd', 'kid', 'kty', 'use', 'x']);
  assert.equal(sk.kty, 'OKP');
  assert.equal(sk.crv, 'Ed25519');
  assert.equal(sk.alg, 'EdDSA');
  assert.equal(sk.kid, jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: sk.x }), 'kid = RFC 7638 thumbprint');
  assert.equal(Buffer.from(sk.d, 'base64url').length, 32);

  const record = await stores.passports.getByClientId(json.client_id);
  assert.ok(record?.signingKey);
  assert.equal(record.signingKey.kid, sk.kid);
  assert.equal(record.signingKey.revokedAt, null);
  assert.ok(isEd25519PublicJwk(record.signingKey.publicJwk), 'stored key is a public JWK');
  assert.ok(!JSON.stringify(record).includes(sk.d), 'the private scalar is never stored');

  const resolve = passportKeyResolver(stores.passports);
  const pub = await resolve(json.agent_id);
  assert.deepEqual(pub, { kty: 'OKP', crv: 'Ed25519', x: sk.x, kid: sk.kid, alg: 'EdDSA', use: 'sig' });
  // The returned private key signs; the resolved public key verifies.
  const jws = signDetachedJws(sk as never, { hello: 'world' }, { kid: sk.kid });
  assert.deepEqual(verifyDetachedJws(pub, jws, { hello: 'world' }), { ok: true, kid: sk.kid });
  assert.equal(await resolve('agt_01J0NOSUCHAGENTNOSUCHAGENT'), null);
});

test('rotate: revokes the old key and returns a new one (once); only the new kid resolves', async () => {
  const { json, owner } = await register();
  const resolve = passportKeyResolver(stores.passports);
  const oldKid = json.signing_key.kid;
  const res = await fetch(`${base}/v1/agents/${json.client_id}/rotate`, { method: 'POST', headers: { 'x-dev-owner': owner } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = (await res.json()) as { signing_key: Record<string, string>; secret_version: number };
  assert.equal(body.secret_version, 2);
  assert.notEqual(body.signing_key.kid, oldKid);
  assert.ok(body.signing_key.d);
  const pub = await resolve(json.agent_id);
  assert.equal(pub?.kid, body.signing_key.kid);
  // A signature by the old key no longer verifies against what the passport resolves to.
  const oldSig = signDetachedJws(json.signing_key as never, { m: 1 }, { kid: oldKid });
  assert.equal(verifyDetachedJws(pub, oldSig, { m: 1 }).ok, false);
});

test('revoke and owner ban: the key is revoked with the passport; nothing resolves', async () => {
  const resolve = passportKeyResolver(stores.passports);
  const a = await register();
  const del = await fetch(`${base}/v1/agents/${a.json.client_id}`, { method: 'DELETE', headers: { 'x-dev-owner': a.owner } });
  assert.equal(del.status, 200);
  assert.equal(await resolve(a.json.agent_id), null);
  assert.ok((await stores.passports.getByClientId(a.json.client_id))?.signingKey?.revokedAt);

  const b = await register();
  assert.ok(await resolve(b.json.agent_id));
  assert.equal(await stores.passports.banOwner(b.owner), 1);
  assert.equal(await resolve(b.json.agent_id), null);
  assert.ok((await stores.passports.getByClientId(b.json.client_id))?.signingKey?.revokedAt);
});

test('store: a private key, a non-Ed25519 key or a kid that is not the thumbprint is refused and creates nothing', async () => {
  const s = createStores();
  const k = mintPassportSigningKey();
  const input = { ownerId: 'own_x', scopes: ['negotiate:a2a'], league: 'core' as const };
  await assert.rejects(s.passports.createPassport({ ...input, signingPublicJwk: k.privateJwk }), SigningKeyError);
  await assert.rejects(s.passports.createPassport({ ...input, signingPublicJwk: { kty: 'RSA', n: 'x', e: 'AQAB' } as never }), SigningKeyError);
  await assert.rejects(s.passports.createPassport({ ...input, signingPublicJwk: { ...k.publicJwk, kid: 'my-own-kid' } }), SigningKeyError);
  assert.equal(await s.passports.banOwner('own_x'), 0, 'no passport was created');
  // Rotation with a refused key leaves the passport (secret and key) untouched.
  const created = await s.passports.createPassport({ ...input, signingPublicJwk: k.publicJwk });
  const before = { ...(await s.passports.getByClientId(created.clientId))! };
  await assert.rejects(s.passports.rotateSecret(created.clientId, { signingPublicJwk: k.privateJwk }), SigningKeyError);
  const after = await s.passports.getByClientId(created.clientId);
  assert.equal(after?.secretHash, before.secretHash);
  assert.equal(after?.signingKey?.kid, k.jkt);
  assert.equal(after?.signingKey?.revokedAt, null);
  // A passport created without a key (fixtures) resolves to null.
  const bare = await s.passports.createPassport(input);
  assert.equal(await passportKeyResolver(s.passports)(bare.agentId), null);
});

test('logs: the private signing key never reaches a log line (register, rotate, and the redactor over the response body)', async () => {
  lines.length = 0;
  const { json, owner } = await register();
  const rot = await fetch(`${base}/v1/agents/${json.client_id}/rotate`, { method: 'POST', headers: { 'x-dev-owner': owner } });
  const rotated = (await rot.json()) as { signing_key: Record<string, string> };
  // A careless call site handing the whole body (or the bare JWK, or its JSON) to the logger.
  log('info', 'debug_dump', { body: json, detail: { note: json.signing_key }, text: JSON.stringify(rotated.signing_key) });
  const out = lines.join('\n');
  assert.ok(lines.length >= 3);
  for (const d of [json.signing_key.d, rotated.signing_key.d]) assert.ok(!out.includes(d), `private key reached the sink:\n${out}`);
  // The kid is public and logged for audit.
  assert.ok(out.includes(json.signing_key.kid));
});
