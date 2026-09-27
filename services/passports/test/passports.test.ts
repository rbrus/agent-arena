/**
 * passports service — happy path + the agent-passports §9 abuse cases required
 * for the Phase-1 gate: no-enumeration-oracle, scope subset, dev-auth
 * fail-closed, and secret hygiene.
 *
 * Uses an isolated dev-keys dir + test pepper set before wot-auth loads.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-pp-keys-'));
process.env.WOT_SECRET_PEPPER = 'test-pepper-passports';
process.env.WOT_DEV_AUTH = '1';

const { createStores } = await import('wot-store');
const { createPassportsApp } = await import('../src/index.ts');

let server: http.Server;
let base: string;

before(async () => {
  const stores = createStores();
  const app = createPassportsApp({ stores });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://localhost:${port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

async function register(owner = 'own_dev', body: Record<string, unknown> = { display_name: 'Reflex Prime' }) {
  const res = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': owner },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

async function token(clientId: string, clientSecret: string, scope?: string) {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) form.set('scope', scope);
  const res = await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

test('happy path: register → token exchange', async () => {
  const { res, json } = await register();
  assert.equal(res.status, 201);
  assert.match(json.client_id as string, /^cid_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(json.agent_id as string, /^agt_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(json.client_secret as string, /^wotk_sk_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(json.scopes, ['play:duel', 'spectate:read', 'play:raid', 'negotiate:a2a']);
  assert.equal(json.display_name, 'Reflex Prime');
  assert.ok((json.token_endpoint as string).endsWith('/v1/oauth/token'));

  const { res: tRes, json: tJson } = await token(
    json.client_id as string,
    json.client_secret as string,
  );
  assert.equal(tRes.status, 200);
  assert.equal(tRes.headers.get('cache-control'), 'no-store');
  assert.equal(tJson.token_type, 'Bearer');
  assert.equal(tJson.expires_in, 600);
  assert.equal(tJson.scope, 'play:duel spectate:read play:raid negotiate:a2a');
  assert.equal(typeof tJson.access_token, 'string');
  // Secret hygiene: the token response never carries a secret.
  assert.equal(tJson.client_secret, undefined);
});

test('ABUSE: no enumeration oracle — bad client_id and bad secret are identical', async () => {
  const { json } = await register();
  const goodId = json.client_id as string;

  const badId = await token('cid_00000000000000000000000000', 'wotk_sk_' + 'A'.repeat(43));
  const badSecret = await token(goodId, 'wotk_sk_' + 'B'.repeat(43));

  assert.equal(badId.res.status, 401);
  assert.equal(badSecret.res.status, 401);
  assert.deepEqual(badId.json, { error: 'invalid_client', error_description: 'Client authentication failed.' });
  assert.deepEqual(badSecret.json, badId.json); // byte-identical body, no oracle
});

test('ABUSE: dev-auth fail-closed — register without the flag and without an Architect token → 401', async () => {
  delete process.env.WOT_DEV_AUTH;
  try {
    const res = await fetch(`${base}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Sneaky' }),
    });
    assert.equal(res.status, 401);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json.error, 'unauthenticated');
    assert.equal(res.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  } finally {
    process.env.WOT_DEV_AUTH = '1';
  }
});

test('PROD auth: injected Architect verifier → 201, passport bound to a stable owner_id derived from (iss, sub); same sub shares the owner', async () => {
  // A dedicated app+server running the PRODUCTION path: dev-auth OFF, a stub
  // ArchitectVerifier that maps a Bearer token → an architect id (throws on anything else).
  const prodStores = createStores();
  const verifier = {
    kind: 'jwt' as const,
    issuer: 'https://idp.test',
    async verify(token: string) {
      if (token === 'good-alice') return { issuer: 'https://idp.test', architectId: 'arch-alice' };
      if (token === 'good-bob') return { issuer: 'https://idp.test', architectId: 'arch-bob' };
      throw new Error('invalid token');
    },
  };
  const prodApp = createPassportsApp({ stores: prodStores, architectVerifier: verifier });
  const prodServer = http.createServer(prodApp);
  await new Promise<void>((r) => prodServer.listen(0, () => r()));
  const prodBase = `http://localhost:${(prodServer.address() as { port: number }).port}`;

  const registerAs = (auth?: string) =>
    fetch(`${prodBase}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify({ display_name: 'Reflex Prime' }),
    });

  const savedDevAuth = process.env.WOT_DEV_AUTH;
  delete process.env.WOT_DEV_AUTH; // force the prod path even inside this suite
  try {
    // No token at all → fail closed (401), even though a verifier IS wired.
    const noTok = await registerAs();
    assert.equal(noTok.status, 401);
    assert.equal(((await noTok.json()) as Record<string, unknown>).error, 'unauthenticated');

    // A bad token the verifier rejects (throws) → 401.
    const badTok = await registerAs('nonsense');
    assert.equal(badTok.status, 401);

    // A valid token → 201, and the created passport is bound to a minted owner.
    const a1 = await registerAs('good-alice');
    assert.equal(a1.status, 201);
    const a1Json = (await a1.json()) as Record<string, unknown>;
    const a1Owner = (await prodStores.passports.getByClientId(a1Json.client_id as string))!.ownerId;
    assert.match(a1Owner, /^own_[0-9A-HJKMNP-TV-Z]{26}$/);

    // The architect id never leaks into the passport / response; only the opaque
    // owner_id is used, and it matches what the owner store resolves for (iss, sub).
    const resolved = await prodStores.owners.resolveByArchitect('https://idp.test', 'arch-alice');
    assert.equal(resolved.ownerId, a1Owner);

    // A SECOND register by the SAME sub shares the same owner_id (quota/ban group).
    const a2 = await registerAs('good-alice');
    assert.equal(a2.status, 201);
    const a2Json = (await a2.json()) as Record<string, unknown>;
    const a2Owner = (await prodStores.passports.getByClientId(a2Json.client_id as string))!.ownerId;
    assert.equal(a2Owner, a1Owner, 'same sub → same owner_id');
    assert.notEqual(a1Json.client_id, a2Json.client_id, 'but distinct passports');

    // A DIFFERENT sub → a DIFFERENT owner_id.
    const b1 = await registerAs('good-bob');
    assert.equal(b1.status, 201);
    const b1Json = (await b1.json()) as Record<string, unknown>;
    const b1Owner = (await prodStores.passports.getByClientId(b1Json.client_id as string))!.ownerId;
    assert.notEqual(b1Owner, a1Owner, 'distinct sub → distinct owner_id');
  } finally {
    if (savedDevAuth !== undefined) process.env.WOT_DEV_AUTH = savedDevAuth;
    await new Promise<void>((r) => prodServer.close(() => r()));
  }
});

test('PROD auth fail-closed: dev-auth off AND no verifier wired → 401 even with a token', async () => {
  const prodStores = createStores();
  const prodApp = createPassportsApp({ stores: prodStores, architectVerifier: null }); // no verifier
  const prodServer = http.createServer(prodApp);
  await new Promise<void>((r) => prodServer.listen(0, () => r()));
  const prodBase = `http://localhost:${(prodServer.address() as { port: number }).port}`;

  const savedDevAuth = process.env.WOT_DEV_AUTH;
  delete process.env.WOT_DEV_AUTH;
  try {
    const res = await fetch(`${prodBase}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify({ display_name: 'Sneaky' }),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as Record<string, unknown>).error, 'unauthenticated');
  } finally {
    if (savedDevAuth !== undefined) process.env.WOT_DEV_AUTH = savedDevAuth;
    await new Promise<void>((r) => prodServer.close(() => r()));
  }
});

test('scope subset: requesting a scope beyond granted → invalid_scope', async () => {
  const { json } = await register();
  const { res, json: err } = await token(
    json.client_id as string,
    json.client_secret as string,
    'play:duel ops:admin', // never granted (caster:publish was removed in contracts 2.0.0)
  );
  assert.equal(res.status, 400);
  assert.equal(err.error, 'invalid_scope');
});

test('scope subset: a narrower requested scope is honored', async () => {
  const { json } = await register();
  const { res, json: t } = await token(
    json.client_id as string,
    json.client_secret as string,
    'spectate:read',
  );
  assert.equal(res.status, 200);
  assert.equal(t.scope, 'spectate:read');
});

test('unsupported grant type → unsupported_grant_type', async () => {
  const form = new URLSearchParams({ grant_type: 'password', client_id: 'x', client_secret: 'y' });
  const res = await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json.error, 'unsupported_grant_type');
});

test('rotate: must-own — owner mismatch → 403 not_owner; owner → 200 new secret', async () => {
  const { json } = await register('own_alice');
  const clientId = json.client_id as string;
  const oldSecret = json.client_secret as string;

  // Wrong owner → 403.
  const wrong = await fetch(`${base}/v1/agents/${clientId}/rotate`, {
    method: 'POST',
    headers: { 'x-dev-owner': 'own_bob' },
  });
  assert.equal(wrong.status, 403);
  assert.equal(((await wrong.json()) as Record<string, unknown>).error, 'not_owner');

  // Owner → 200, new secret, version bump; old secret no longer authenticates.
  const ok = await fetch(`${base}/v1/agents/${clientId}/rotate`, {
    method: 'POST',
    headers: { 'x-dev-owner': 'own_alice' },
  });
  assert.equal(ok.status, 200);
  const rotated = (await ok.json()) as Record<string, unknown>;
  assert.match(rotated.client_secret as string, /^wotk_sk_[A-Za-z0-9_-]{43}$/);
  assert.equal(rotated.secret_version, 2);
  assert.notEqual(rotated.client_secret, oldSecret);

  const oldTry = await token(clientId, oldSecret);
  assert.equal(oldTry.res.status, 401);
  const newTry = await token(clientId, rotated.client_secret as string);
  assert.equal(newTry.res.status, 200);
});

test('revoke: token minting fails immediately with invalid_client', async () => {
  const { json } = await register('own_alice');
  const clientId = json.client_id as string;
  const secret = json.client_secret as string;

  const del = await fetch(`${base}/v1/agents/${clientId}`, {
    method: 'DELETE',
    headers: { 'x-dev-owner': 'own_alice' },
  });
  assert.equal(del.status, 200);
  assert.equal(((await del.json()) as Record<string, unknown>).status, 'revoked');

  const after = await token(clientId, secret);
  assert.equal(after.res.status, 401);
  assert.equal(after.json.error, 'invalid_client');
});

test('register: unknown field is rejected (edge validation)', async () => {
  const res = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': 'own_dev' },
    body: JSON.stringify({ display_name: 'x', evil: true }),
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>).error, 'invalid_request');
});

test('JWKS: public keys advertised (kid, use:sig, alg:EdDSA)', async () => {
  const res = await fetch(`${base}/.well-known/jwks.json`);
  assert.equal(res.status, 200);
  const jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].use, 'sig');
  assert.equal(jwks.keys[0].alg, 'EdDSA');
  assert.equal(jwks.keys[0].d, undefined); // never leak the private scalar
});
