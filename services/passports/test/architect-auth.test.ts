/**
 * Architect (human-plane) auth after ADR-003 §3 / extraction blocker M8:
 * an EdDSA JWT from a locally minted key registers an agent; foreign-shaped
 * tokens (a legacy RS256 hosted-IdP ID token, an agent access token, wrong
 * iss/aud/typ, expired, untrusted key) are refused; the dev verifier cannot
 * exist outside WOT_ENV=development|test; and the package carries no hosted
 * identity SDK.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-arch-keys-'));
process.env.WOT_SECRET_PEPPER = 'test-pepper-architect-auth';
delete process.env.WOT_DEV_AUTH;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const ISS = 'https://id.example.test';
const AUD = 'agent-arena:architect';

const { createStores } = await import('wot-store');
const { mintAccessToken } = await import('wot-auth');
const {
  createPassportsApp,
  architectVerifierFromEnv,
  DevArchitectVerifier,
  LocalJwtArchitectVerifier,
  ArchitectVerifierConfigError,
} = await import('../src/index.ts');

let trustedKey: KeyLike;
let trustedJwk: JWK;
let server: http.Server;
let base: string;
let stores: ReturnType<typeof createStores>;

interface MintOpts {
  key?: KeyLike;
  alg?: string;
  typ?: string | null;
  iss?: string;
  aud?: string | string[];
  sub?: string | null;
  iat?: number;
  exp?: number;
  kid?: string;
  claims?: Record<string, unknown>;
}

async function mint(o: MintOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = { alg: o.alg ?? 'EdDSA', kid: o.kid ?? 'arch-key-1' };
  if (o.typ !== null) header.typ = o.typ ?? 'architect+jwt';
  const jwt = new SignJWT({ ...(o.claims ?? {}) })
    .setProtectedHeader(header as { alg: string })
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt(o.iat ?? now)
    .setExpirationTime(o.exp ?? now + 600);
  if (o.sub !== null) jwt.setSubject(o.sub ?? 'arch_alice');
  return jwt.sign(o.key ?? trustedKey);
}

async function register(token?: string) {
  const res = await fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ display_name: 'Reflex Prime' }),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  trustedKey = kp.privateKey;
  trustedJwk = { ...(await exportJWK(kp.publicKey)), kid: 'arch-key-1', alg: 'EdDSA', use: 'sig' };
  // Wire through the ENVIRONMENT, exactly as the sandbox/hosted image would.
  process.env.WOT_ARCHITECT_ISS = ISS;
  process.env.WOT_ARCHITECT_JWKS = JSON.stringify({ keys: [trustedJwk] });
  stores = createStores();
  const app = createPassportsApp({ stores }); // no explicit verifier → architectVerifierFromEnv()
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

after(async () => {
  delete process.env.WOT_ARCHITECT_ISS;
  delete process.env.WOT_ARCHITECT_JWKS;
  await new Promise<void>((r) => server.close(() => r()));
});

test('an Architect JWT from a locally minted Ed25519 key registers an agent, bound to the owner for (iss, sub)', async () => {
  const { res, json } = await register(await mint());
  assert.equal(res.status, 201, JSON.stringify(json));
  const rec = await stores.passports.getByClientId(json.client_id as string);
  const owner = await stores.owners.resolveByArchitect(ISS, 'arch_alice');
  assert.equal(rec!.ownerId, owner.ownerId);
  // The architect id never appears in the response.
  assert.ok(!JSON.stringify(json).includes('arch_alice'));

  // Same sub again → same owner; a different sub → a different owner.
  const again = await register(await mint());
  assert.equal((await stores.passports.getByClientId(again.json.client_id as string))!.ownerId, owner.ownerId);
  const bob = await register(await mint({ sub: 'arch_bob' }));
  assert.notEqual((await stores.passports.getByClientId(bob.json.client_id as string))!.ownerId, owner.ownerId);
});

test('rotate/revoke: the owning Architect may, another Architect may not', async () => {
  const { json } = await register(await mint());
  const cid = json.client_id as string;
  const asBob = await fetch(`${base}/v1/agents/${cid}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${await mint({ sub: 'arch_bob' })}` } });
  assert.equal(asBob.status, 403);
  const asAlice = await fetch(`${base}/v1/agents/${cid}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${await mint()}` } });
  assert.equal(asAlice.status, 200);
});

test('same sub at a different issuer is a different owner (no cross-issuer collision)', async () => {
  const s = createStores();
  const a = await s.owners.resolveByArchitect('https://a.test', 'x');
  const b = await s.owners.resolveByArchitect('https://b.test', 'x');
  const a2 = await s.owners.resolveByArchitect('https://a.test', 'x');
  assert.notEqual(a.ownerId, b.ownerId);
  assert.equal(a.ownerId, a2.ownerId);
});

test('a legacy hosted-IdP ID token (RS256, securetoken-style iss/aud) is refused', async () => {
  const rsa = await generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ user_id: 'uid-123', auth_time: now, sign_in_provider: 'google.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'arch-key-1', typ: 'JWT' })
    .setIssuer('https://securetoken.google.com/legacy-project')
    .setAudience('legacy-project')
    .setSubject('uid-123')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(rsa.privateKey);
  const r = await register(idToken);
  assert.equal(r.res.status, 401);
  assert.equal(r.json.error, 'unauthenticated');
  assert.equal(r.res.headers.get('www-authenticate'), 'Bearer error="invalid_token"');

  // Even signed by the TRUSTED key, that token's claims shape is refused (iss, aud, typ).
  const shaped = await mint({ typ: 'JWT', iss: 'https://securetoken.google.com/legacy-project', aud: 'legacy-project', sub: 'uid-123' });
  assert.equal((await register(shaped)).res.status, 401);
});

test('refused: wrong iss, wrong aud, wrong/missing typ, missing sub, bad sub, expired, too old, untrusted key, alg none', async () => {
  const now = Math.floor(Date.now() / 1000);
  const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const cases: Array<[string, string]> = [
    ['wrong iss', await mint({ iss: 'https://evil.test' })],
    ['wrong aud', await mint({ aud: 'agent-arena' })],
    ['typ at+jwt', await mint({ typ: 'at+jwt' })],
    ['no typ', await mint({ typ: null })],
    ['no sub', await mint({ sub: null })],
    ['bad sub', await mint({ sub: 'has space' })],
    ['expired', await mint({ iat: now - 1200, exp: now - 600 })],
    ['older than 1h', await mint({ iat: now - 7200, exp: now + 600 })],
    ['untrusted key', await mint({ key: other.privateKey })],
    ['alg none', `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'architect+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISS, aud: AUD, sub: 'arch_alice', iat: now, exp: now + 600 })).toString('base64url')}.`],
    ['garbage', 'not-a-jwt'],
  ];
  for (const [name, tok] of cases) {
    const r = await register(tok);
    assert.equal(r.res.status, 401, `${name} must be refused`);
  }
});

test('an agent access token (at+jwt) is never accepted as an Architect token', async () => {
  const at = await mintAccessToken({ agentId: 'agt_01J8ZKF7Q0AAAAAAAAAAAAAAAA', ownerId: 'own_x', clientId: 'cid_x', league: 'core', scope: ['play:duel'] });
  assert.equal((await register(at)).res.status, 401);
});

test('config: private key in JWKS, agent audience, http JWKS URL, two sources, and a missing issuer are refused at startup', () => {
  assert.throws(() => architectVerifierFromEnv({ WOT_ARCHITECT_ISS: ISS, WOT_ARCHITECT_JWKS: JSON.stringify({ keys: [{ ...trustedJwk, d: 'AAAA' }] }) }), /PRIVATE key/);
  assert.throws(() => architectVerifierFromEnv({ WOT_ARCHITECT_ISS: ISS, WOT_ARCHITECT_AUD: 'agent-arena', WOT_ARCHITECT_JWKS: JSON.stringify({ keys: [trustedJwk] }) }), /must differ/);
  assert.throws(() => architectVerifierFromEnv({ WOT_ARCHITECT_ISS: ISS, WOT_ARCHITECT_JWKS_URL: 'http://id.example.test/jwks.json' }), /https/);
  assert.throws(() => architectVerifierFromEnv({ WOT_ARCHITECT_ISS: ISS, WOT_ARCHITECT_JWKS: '{"keys":[]}', WOT_ARCHITECT_JWKS_URL: 'https://x.test/j' }), /exactly one/);
  assert.throws(() => architectVerifierFromEnv({ WOT_ARCHITECT_JWKS: JSON.stringify({ keys: [trustedJwk] }) }), /WOT_ARCHITECT_ISS/);
  assert.throws(() => architectVerifierFromEnv({ WOT_ARCHITECT_VERIFIER: 'legacy-idp' }), ArchitectVerifierConfigError);
  assert.equal(architectVerifierFromEnv({}), undefined, 'nothing configured → no verifier → 401');
  // RSA keys are not accepted into the trust set at all.
  assert.throws(() => new LocalJwtArchitectVerifier({ issuer: ISS, jwks: { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }] } }), /Ed25519/);
});

test('JWKS from a file works (WOT_ARCHITECT_JWKS_FILE)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wot-arch-jwks-'));
  const file = join(dir, 'jwks.json');
  writeFileSync(file, JSON.stringify({ keys: [trustedJwk] }));
  const v = architectVerifierFromEnv({ WOT_ARCHITECT_ISS: ISS, WOT_ARCHITECT_JWKS_FILE: file });
  assert.ok(v);
  assert.deepEqual(await v!.verify(await mint()), { issuer: ISS, architectId: 'arch_alice' });
});

test('dev verifier: works under WOT_ENV=test, refused to construct outside development|test', async () => {
  const dev = new DevArchitectVerifier({ WOT_ENV: 'test' });
  assert.deepEqual(await dev.verify('dev:arch_dev'), { issuer: 'urn:agent-arena:dev', architectId: 'arch_dev' });
  await assert.rejects(dev.verify('arch_dev'));
  for (const WOT_ENV of [undefined, 'production', 'staging', 'Development']) {
    const env = WOT_ENV === undefined ? {} : { WOT_ENV };
    assert.throws(() => new DevArchitectVerifier(env), /only available with WOT_ENV=development\|test/);
    assert.throws(() => architectVerifierFromEnv({ ...env, WOT_ARCHITECT_VERIFIER: 'dev' }), ArchitectVerifierConfigError);
  }
  // Re-checked per call: a process that flips to production stops accepting.
  const saved = process.env.WOT_ENV;
  process.env.WOT_ENV = 'production';
  try {
    await assert.rejects(dev.verify('dev:arch_dev'), /only available/);
  } finally {
    if (saved === undefined) delete process.env.WOT_ENV;
    else process.env.WOT_ENV = saved;
  }
});

test('dev verifier: the passports service refuses to START with it in production', () => {
  const body = `
    const { createStores } = await import('wot-store');
    const { createPassportsApp } = await import(${JSON.stringify(join(ROOT, 'services/passports/src/index.ts'))});
    createPassportsApp({ stores: createStores() });
    console.log('started');
  `;
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WOT_DEV_KEYS_DIR: mkdtempSync(join(tmpdir(), 'wot-arch-refusal-')), ...env },
      encoding: 'utf8',
      cwd: ROOT,
    });
  const prod = run({ WOT_ENV: 'production', WOT_SECRET_PEPPER: 'p'.repeat(40), WOT_ARCHITECT_VERIFIER: 'dev' });
  assert.notEqual(prod.status, 0, 'started with the dev Architect verifier in production');
  assert.match(prod.stderr, /DevArchitectVerifier is only available/);
  const dev = run({ WOT_ENV: 'development', WOT_ARCHITECT_VERIFIER: 'dev' });
  assert.equal(dev.status, 0, dev.stderr);
});

test('the passports package depends on no hosted identity SDK (dependency allowlist)', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['ajv', 'cors', 'express', 'jose', 'wot-auth', 'wot-store']);
});
