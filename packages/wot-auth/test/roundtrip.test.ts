import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use an isolated dev-keys dir so tests never touch the real one. Must be set
// before the module reads config on first key use.
process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-devkeys-'));

const auth = await import('../src/index.ts');

before(() => {
  auth._resetKeyCache();
});

test('mint -> verify round-trip yields the expected claims', async () => {
  const token = await auth.mintAccessToken({
    ownerId: 'own_01J8ZK9QMR4T7V2X0PABCDE3FG',
    agentId: 'agt_01J8ZK9QMR4T7V2X0PABCDE3FG',
    clientId: 'cid_01J8ZK9QMR4T7V2X0PABCDE3FG',
    league: 'core',
    scope: ['play:duel', 'spectate:read'],
  });
  assert.equal(typeof token, 'string');

  const claims = await auth.verifyAccessToken(token);
  assert.equal(claims.iss, auth.ISSUER);
  assert.equal(claims.aud, auth.AUDIENCE);
  assert.equal(claims.sub, 'agt_01J8ZK9QMR4T7V2X0PABCDE3FG');
  assert.equal(claims.agent_id, 'agt_01J8ZK9QMR4T7V2X0PABCDE3FG');
  assert.equal(claims.owner_id, 'own_01J8ZK9QMR4T7V2X0PABCDE3FG');
  assert.equal(claims.client_id, 'cid_01J8ZK9QMR4T7V2X0PABCDE3FG');
  assert.equal(claims.league, 'core');
  assert.deepEqual(claims.scopes, ['play:duel', 'spectate:read']);
  // The retired `adapters` claim is neither minted nor surfaced (ADR-001 §6).
  assert.equal('adapters' in claims, false);
  // Reserved delegation claims present-but-null (agent-passports §2.3).
  assert.equal(claims.parent_agent_id, null);
  assert.equal(claims.act, null);
});

test('mint never emits the retired adapters claim', async () => {
  const token = await auth.mintAccessToken({
    ownerId: 'own_x',
    agentId: 'agt_x',
    clientId: 'cid_x',
    league: 'core',
    scope: ['spectate:read'],
  });
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal('adapters' in payload, false);
});

test('verify ignores a legacy adapters claim on an otherwise valid token', async () => {
  const { SignJWT } = await import('jose');
  const { privateKey, kid } = await auth.getKeyMaterial();
  const now = Math.floor(Date.now() / 1000);
  const legacy = await new SignJWT({
    client_id: 'cid_legacy',
    owner_id: 'own_legacy',
    agent_id: 'agt_legacy',
    league: 'core',
    scope: 'play:duel',
    adapters: ['oracle_lens'],
    parent_agent_id: null,
    act: null,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
    .setIssuer(auth.ISSUER)
    .setSubject('agt_legacy')
    .setAudience(auth.AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti('jti-legacy')
    .sign(privateKey);

  const claims = await auth.verifyAccessToken(legacy);
  assert.equal(claims.agent_id, 'agt_legacy');
  assert.deepEqual(claims.scopes, ['play:duel']);
  assert.equal('adapters' in claims, false);
  // Authorization is scope-only: the legacy claim grants nothing extra.
  assert.deepEqual(auth.authorizeAffordance(claims, { scope: 'play:duel' }), { ok: true });
  assert.deepEqual(auth.authorizeAffordance(claims, { scope: 'negotiate:a2a' }), {
    ok: false,
    reason: 'insufficient_scope',
    scope: 'negotiate:a2a',
  });
});

test('scope enforcement: spectate:read token lacks play:duel', async () => {
  const token = await auth.mintAccessToken({
    ownerId: 'own_x',
    agentId: 'agt_x',
    clientId: 'cid_x',
    league: 'core',
    scope: ['spectate:read'],
  });
  const claims = await auth.verifyAccessToken(token);
  assert.equal(auth.hasScope(claims, 'play:duel'), false);
  assert.equal(auth.hasScope(claims, 'spectate:read'), true);
});

test('getPublicJwks advertises kid, use:sig, alg:EdDSA', async () => {
  const jwks = await auth.getPublicJwks();
  assert.equal(jwks.keys.length, 1);
  const [k] = jwks.keys;
  assert.equal(k.kty, 'OKP');
  assert.equal(k.crv, 'Ed25519');
  assert.equal(k.use, 'sig');
  assert.equal(k.alg, 'EdDSA');
  assert.equal(typeof k.kid, 'string');
  assert.ok((k.kid as string).startsWith('key_'));
  assert.equal(k.d, undefined, 'public JWK must not contain the private scalar');
});

test('an invalid token throws TokenInvalid', async () => {
  await assert.rejects(
    () => auth.verifyAccessToken('not.a.jwt'),
    (e: unknown) => e instanceof auth.TokenInvalid,
  );
});

test('an expired token throws TokenExpired', async () => {
  const token = await auth.mintAccessToken({
    ownerId: 'own_x',
    agentId: 'agt_x',
    clientId: 'cid_x',
    league: 'core',
    scope: ['play:duel'],
    ttlSeconds: -10, // already expired
  });
  await assert.rejects(
    () => auth.verifyAccessToken(token),
    (e: unknown) => e instanceof auth.TokenExpired,
  );
});

test('secret hashing: peppered HMAC round-trip, no plaintext', () => {
  const secret = auth.generateClientSecret();
  assert.ok(secret.startsWith('wotk_sk_'));
  const stored = auth.hashSecret(secret);
  assert.ok(stored.startsWith('hmac_sha256:v1:'));
  assert.ok(!stored.includes(secret));
  assert.equal(auth.verifySecret(secret, stored), true);
  assert.equal(auth.verifySecret('wotk_sk_wrong', stored), false);
  assert.equal(auth.verifySecret(secret, 'garbage'), false);
});
