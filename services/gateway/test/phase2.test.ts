/**
 * Gateway webhooks: Architect-side webhook registration and signed delivery.
 * (The public live-match directory GET /v1/matches was cut with the live
 * spectator plane in Phase 7 B0-21; GET /v1/matches/{id} stays.)
 *
 *  - webhook management is gated by an `architect+jwt` bearer verified by the
 *    injected `ArchitectVerifier` (agent-passports §1.1, ADR-003 §3); a legacy
 *    hosted-IdP ID token (RS256, `typ: JWT`), an untyped EdDSA token, an agent
 *    access token and a verifier-less gateway are all refused with 401;
 *  - POST /v1/webhooks returns the signing_secret exactly once (never on GET);
 *  - a delivered webhook_event verifies against its WoT-Signature HMAC (and
 *    fails under a wrong secret), and validates against the schema.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-gw2-keys-'));
delete process.env.WOT_DEV_AUTH;

const { createStores, newId, WebhookDeliverer, verifyWebhookSignature } = await import('wot-store');
const { webhookValidators } = await import('wot-contracts');
const { mintAccessToken } = await import('wot-auth');
const { LocalJwtArchitectVerifier } = await import('wot-passports');
const { createGatewayApp } = await import('../src/index.ts');

const ARENA_BASE = 'ws://localhost:8082';
const ISS = 'https://id.gateway.example.test';
const AUD = 'agent-arena:architect';
let server: http.Server;
let base: string;
let stores: Awaited<ReturnType<typeof createStores>>;
let architectKey: KeyLike;

/** Mint an Architect token (agent-passports §1.1). Distinct `sub`s resolve to
 * distinct stable owner_ids via stores.owners (get-or-create), so a token
 * resolves to the SAME owner on every request (register + list). */
async function architectToken(
  sub: string,
  o: { key?: KeyLike; alg?: string; typ?: string; iss?: string; aud?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: o.alg ?? 'EdDSA', typ: o.typ ?? 'architect+jwt', kid: 'gw-arch-1' })
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? AUD)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(o.key ?? architectKey);
}

let ALICE = '';

before(async () => {
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  architectKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'gw-arch-1', alg: 'EdDSA', use: 'sig' };
  const architectVerifier = new LocalJwtArchitectVerifier({ issuer: ISS, audience: AUD, jwks: { keys: [jwk] } });
  ALICE = await architectToken('arch_alice');
  stores = createStores({ arenaBaseUrl: `${ARENA_BASE}/v1/arena` });
  const app = createGatewayApp({ stores, arenaBaseUrl: ARENA_BASE, architectVerifier });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://localhost:${port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

test('webhook registration returns the signing_secret exactly once (never on GET)', async () => {
  const res = await fetch(`${base}/v1/webhooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ALICE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://hooks.example.com/wot', events: ['match.found', 'match.end'] }),
  });
  assert.equal(res.status, 201);
  const reg = (await res.json()) as Record<string, unknown>;
  assert.match(reg.webhook_id as string, /^whk_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(reg.signing_secret as string, /^whsec_[A-Za-z0-9_-]{32,}$/);
  assert.equal(reg.status, 'active');

  // Registration requires Architect auth.
  const noauth = await fetch(`${base}/v1/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://hooks.example.com/x', events: ['match.end'] }),
  });
  assert.equal(noauth.status, 401);

  // GET never exposes the signing secret.
  const list = await fetch(`${base}/v1/webhooks`, { headers: { authorization: `Bearer ${ALICE}` } });
  const listBody = (await list.json()) as { webhooks: Record<string, unknown>[] };
  const hook = listBody.webhooks.find((w) => w.webhook_id === reg.webhook_id);
  assert.ok(hook, 'the webhook is listed');
  assert.equal(hook!.signing_secret, undefined, 'signing_secret is never returned on GET');
});

test('webhook registration refuses private, metadata and non-https endpoints (G-3)', async () => {
  for (const url of [
    'http://hooks.example.com/wot',
    'https://127.0.0.1/wot',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/wot',
    'https://user:pw@hooks.example.com/wot',
  ]) {
    const res = await fetch(`${base}/v1/webhooks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ALICE}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url, events: ['match.end'] }),
    });
    assert.equal(res.status, 400, url);
    assert.equal(((await res.json()) as Record<string, unknown>).error, 'invalid_request');
  }
});

async function listWith(authorization: string | null): Promise<number> {
  const res = await fetch(`${base}/v1/webhooks`, { headers: authorization ? { authorization } : {} });
  await res.arrayBuffer();
  return res.status;
}

test('webhook management refuses a legacy hosted-IdP ID token (RS256, typ JWT) and other non-Architect tokens', async () => {
  // Shaped like the retired hosted-IdP ID token: RS256, `typ: JWT`, issuer/audience
  // of a hosted IdP project. The gateway no longer has any path that accepts it.
  const rsa = await generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);
  const legacyIdToken = await new SignJWT({ auth_time: now, sign_in_provider: 'password' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'legacy-idp-kid' })
    .setIssuer('https://securetoken.google.com/legacy-project')
    .setAudience('legacy-project')
    .setSubject('legacy-uid-alice')
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(rsa.privateKey);
  assert.equal(await listWith(`Bearer ${legacyIdToken}`), 401, 'legacy hosted-IdP ID token');

  // Right key, wrong explicit type (RFC 8725 §3.11): refused.
  assert.equal(await listWith(`Bearer ${await architectToken('arch_alice', { typ: 'JWT' })}`), 401, 'typ JWT');
  // Right shape, untrusted key.
  const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  assert.equal(await listWith(`Bearer ${await architectToken('arch_alice', { key: other.privateKey })}`), 401, 'untrusted key');
  // Wrong issuer / audience.
  assert.equal(await listWith(`Bearer ${await architectToken('arch_alice', { iss: 'https://evil.example' })}`), 401, 'iss');
  assert.equal(await listWith(`Bearer ${await architectToken('arch_alice', { aud: 'agent-arena' })}`), 401, 'aud');
  // An agent access token is never an Architect token.
  const agentToken = await mintAccessToken({
    agentId: newId('agt'),
    clientId: newId('cid'),
    ownerId: 'own_x',
    scope: ['spectate:read'],
    league: 'core',
  });
  assert.equal(await listWith(`Bearer ${agentToken}`), 401, 'agent token');
  // The pre-ADR-003 opaque stub tokens and a missing header.
  assert.equal(await listWith('Bearer architect-alice'), 401, 'opaque stub token');
  assert.equal(await listWith(null), 401, 'no token');
  // The real one still works.
  assert.equal(await listWith(`Bearer ${ALICE}`), 200);
});

test('a gateway with no Architect verifier answers 401 on webhook management (fail closed)', async () => {
  const s2 = createStores({ arenaBaseUrl: `${ARENA_BASE}/v1/arena` });
  const app = createGatewayApp({ stores: s2, arenaBaseUrl: ARENA_BASE, architectVerifier: null });
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://localhost:${port}/v1/webhooks`, { headers: { authorization: `Bearer ${ALICE}` } });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.match(JSON.stringify(body), /Human authentication is not configured/);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('a delivered webhook_event verifies against its WoT-Signature HMAC', async () => {
  // Register a webhook whose deliveries land on a local receiver.
  const received: Array<{ rawBody: string; signature: string; event: string }> = [];
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({
        rawBody: raw,
        signature: String(req.headers['wot-signature'] ?? ''),
        event: String(req.headers['wot-event'] ?? ''),
      });
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  const rport = (receiver.address() as { port: number }).port;
  const url = `http://127.0.0.1:${rport}/hook`;

  // Register the LOCAL http receiver directly in the store, under own_bob
  // (isolated from the own_alice webhook above). We bypass the gateway's POST
  // here only because it (correctly) requires https endpoints — that input rule
  // is exercised by the registration test; this test exercises signed delivery.
  const { signingSecret } = await stores.webhooks.create({
    ownerId: 'own_bob',
    url,
    events: ['match.end'],
  });

  // Fire a match.end for own_alice via the shared deliverer.
  // The local http receiver is only reachable with the dev/test opt-in (G-3).
  const deliverer = new WebhookDeliverer({ store: stores.webhooks, allowPrivateTargets: true });
  const gotDelivery = new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (received.length > 0) {
        clearInterval(iv);
        resolve();
      }
    }, 10);
  });
  deliverer.matchEnd({
    matchId: 'mat_01J8ZK9QMR4T7V2X0PABCDE3FG',
    league: 'core',
    winner: 'A',
    reason: 'ascension',
    finalScores: { A: 100, B: 71 },
    tokensRemaining: { A: 88, B: 0 },
    ticksPlayed: 73,
    seed: 2864901733,
    replayId: newId('rpl'),
    replayHash: 'sha256:' + '9'.repeat(64),
    endedAt: new Date().toISOString(),
    players: [
      { player_id: 'A', agent_id: newId('agt'), display_name: 'Reflex Prime', result: 'win', ownerId: 'own_bob' },
      { player_id: 'B', agent_id: newId('agt'), display_name: 'House Bot', result: 'loss' },
    ],
  });

  await gotDelivery;
  deliverer.close();

  const d = received[0];
  assert.equal(d.event, 'match.end');
  assert.match(d.signature, /^t=\d+,v1=[0-9a-f]{64}$/);

  // Verifies with the right secret; fails with a wrong one (tamper/rotation guard).
  assert.equal(verifyWebhookSignature(signingSecret, d.rawBody, d.signature), true);
  assert.equal(verifyWebhookSignature('whsec_' + 'z'.repeat(40), d.rawBody, d.signature), false);

  // The delivered envelope validates against the contract schema.
  const envelope = JSON.parse(d.rawBody) as unknown;
  assert.ok(
    webhookValidators.webhook_event(envelope),
    `webhook_event invalid: ${JSON.stringify(webhookValidators.webhook_event.errors)}`,
  );
  const env = envelope as Record<string, unknown>;
  assert.equal(env.type, 'match.end');
  assert.match(env.id as string, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal((env.data as Record<string, unknown>).your_agent_id !== undefined, true);

  await new Promise<void>((r) => receiver.close(() => r()));
});
