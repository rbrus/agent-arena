/**
 * `serve-reference --hosted` (I-7; SIXI-INTEGRATION §1.14): the cross-check
 * reference origin checks `Host` against the verified origin and verifies a
 * Sixi-minted `sixi_run_token` (EdDSA at+jwt, aud = origin, sub = run id bound
 * to X-Agent-Arena-Run). Tokenless requests pass unless --require-run-token.
 */

import assert from 'node:assert/strict';
import { sign as edSign } from 'node:crypto';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { serveReferenceCommand } from '../src/commands/serve-reference.ts';
import { CliError } from '../src/errors.ts';
import { loadPublicKeySet } from '../src/keys.ts';
import { verifyRunToken } from '../src/reference/run-token.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { OTHER_PRIV, PRIV, pubJwk } from './hosted-fixtures.ts';

const ORIGIN = 'https://xcheck-ref.example.com';
const RUN = 'run_01JB5H0STED0TEST000000000A';
const KID = 'sixi-arena-runtoken-ed25519-20261101';
const keys = () => loadPublicKeySet(pubJwk(KID), '--run-token-key');

function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'at+jwt', kid: KID }, key = PRIV): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://arena.sixi.example', aud: ORIGIN, sub: RUN, org: 'org_TEST000000001', iat: now, exp: now + 600, jti: 'jti-0123456789abcdef', ...claims })).toString('base64url');
  const s = edSign(null, Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${s}`;
}

let open: ReferenceServer;
let strict: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  open = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine', hosted: { verifiedOrigin: ORIGIN, runTokenKeys: keys(), issuer: 'https://arena.sixi.example' } });
  strict = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine', hosted: { verifiedOrigin: ORIGIN, runTokenKeys: keys(), requireToken: true } });
});
after(async () => {
  await open.close();
  await strict.close();
});

function call(srv: ReferenceServer, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const CARD = '/.well-known/agent-card.json';

test('Host must name the verified origin (421 otherwise); /healthz is exempt', async () => {
  assert.equal((await call(open, CARD, { host: 'evil.example.net' })).status, 421);
  assert.equal((await call(open, CARD, { host: `127.0.0.1:${open.port}` })).status, 421);
  assert.equal((await call(open, '/healthz', { host: 'anything' })).status, 200);
  const ok = await call(open, CARD, { host: 'xcheck-ref.example.com' });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).url, `${ORIGIN}/a2a`, 'the card names the endpoint on the verified origin');
  assert.equal((await call(open, CARD, { host: 'xcheck-ref.example.com:443' })).status, 200);
});

test('a valid run token bound to its run is admitted; tokenless requests pass unless --require-run-token', async () => {
  const good = { host: 'xcheck-ref.example.com', authorization: `Bearer ${mint()}`, 'x-agent-arena-run': RUN };
  assert.equal((await call(open, CARD, good)).status, 200);
  assert.equal((await call(strict, CARD, good)).status, 200);
  assert.equal((await call(open, CARD, { host: 'xcheck-ref.example.com' })).status, 200);
  assert.equal((await call(strict, CARD, { host: 'xcheck-ref.example.com' })).status, 401);
});

test('refused tokens: another run, expired, wrong audience, wrong issuer, wrong key, extra header member, wrong typ, non-canonical encoding', async () => {
  const h = (token: string, run = RUN) => ({ host: 'xcheck-ref.example.com', authorization: `Bearer ${token}`, 'x-agent-arena-run': run });
  const cases: [string, Record<string, string>][] = [
    ['run header differs from sub', h(mint(), 'run_01JB5H0STED0TEST000000000B')],
    ['expired', h(mint({ exp: Math.floor(Date.now() / 1000) - 3600 }))],
    ['wrong aud', h(mint({ aud: 'https://agent.example.com' }))],
    ['wrong iss', h(mint({ iss: 'https://evil.example' }))],
    ['wrong key', h(mint({}, undefined, OTHER_PRIV))],
    ['jwk in header', h(mint({}, { alg: 'EdDSA', typ: 'at+jwt', kid: KID, jwk: {} }))],
    ['typ JWT', h(mint({}, { alg: 'EdDSA', typ: 'JWT', kid: KID }))],
    ['unknown kid', h(mint({}, { alg: 'EdDSA', typ: 'at+jwt', kid: 'other-kid-000' }))],
    ['padded segment', h(`${mint()}=`)],
    ['not bearer', { host: 'xcheck-ref.example.com', authorization: `Basic ${mint()}`, 'x-agent-arena-run': RUN }],
  ];
  for (const [why, headers] of cases) {
    const r = await call(open, CARD, headers);
    assert.equal(r.status, 401, why);
    assert.equal(JSON.parse(r.body).error, 'invalid_token', `${why}: one refusal code, no oracle`);
  }
  assert.equal(verifyRunToken(mint(), { keys: keys(), audience: ORIGIN }).ok, true);
});

test('serve-reference flags: --hosted needs --verified-origin and --run-token-key; the hosted flags need --hosted', async () => {
  await assert.rejects(serveReferenceCommand({ hosted: true, port: '0', runTokenKey: pubJwk(KID) }), (e: unknown) => e instanceof CliError && /--verified-origin/.test(e.message));
  await assert.rejects(serveReferenceCommand({ hosted: true, port: '0', verifiedOrigin: ORIGIN }), (e: unknown) => e instanceof CliError && /--run-token-key/.test(e.message));
  await assert.rejects(serveReferenceCommand({ port: '0', verifiedOrigin: ORIGIN }), (e: unknown) => e instanceof CliError && /belong to --hosted/.test(e.message));
  await assert.rejects(serveReferenceCommand({ hosted: true, port: '0', verifiedOrigin: 'https://X.example.com/path', runTokenKey: pubJwk(KID) }), (e: unknown) => e instanceof CliError);
});
