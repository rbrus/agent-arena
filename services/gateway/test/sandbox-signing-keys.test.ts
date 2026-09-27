/**
 * Phase 8 B3c: the sandbox (`startDevServer`, what the image and the hosted
 * runner run) wires ONE store-backed passport signing-key resolver into both the
 * gateway (Negotiation Chambers) and the arena (Diplomacy press). Here, through
 * the composed server only:
 *
 *   register (POST /v1/agents) → the private key returned once → a chamber offer
 *   signed with it binds with the counterparty's registration key; after the
 *   owner rotates, the OLD key's signature is `signature_invalid` and the NEW
 *   key's is accepted; after revoke, the shared resolver returns nothing.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-sbx-sk-'));
process.env.WOT_ENV = 'test';
process.env.WOT_DEV_AUTH = '1';

const { signDetachedJws } = await import('wot-auth');
const { startDevServer } = await import('../../../sandbox/index.ts');
const { chamberSigningPayload, chamberTermsHash } = await import('../src/negotiations.ts');

type Srv = Awaited<ReturnType<typeof startDevServer>>;
type Jwk = Record<string, string>;
let srv: Srv;

before(async () => {
  srv = await startDevServer({ port: 0 });
});
after(async () => {
  await srv.close();
});

let n = 0;
async function registerAndToken() {
  const owner = `own_sbx${++n}`;
  const reg = await fetch(`${srv.url}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-owner': owner },
    body: JSON.stringify({ display_name: `Sbx ${n}` }),
  });
  assert.equal(reg.status, 201);
  const r = (await reg.json()) as { client_id: string; client_secret: string; agent_id: string; signing_key: Jwk };
  return { owner, ...r, token: await tokenFor(r.client_id, r.client_secret) };
}

async function tokenFor(clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${srv.url}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'negotiate:a2a' }).toString(),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const GIVE = { terms: [{ term: 'non_aggression', args: { toward: 'B' }, until_tick: 40 }] };
const WANT = { terms: [{ term: 'non_aggression', args: { toward: 'A' }, until_tick: 40 }] };

function signMove(key: Jwk, negId: string, fromAgentId: string, action: 'offer' | 'accept', respondTo: string | null) {
  return signDetachedJws(
    key as never,
    chamberSigningPayload({ negotiationId: negId, action, fromAgentId, respondTo, termsHash: chamberTermsHash(GIVE, WANT), expiresAt: null }),
    { kid: key.kid },
  );
}

async function post(path: string, token: string, body: unknown) {
  const res = await fetch(`${srv.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('sandbox: registration keys verify on the chambers; rotation and revocation revoke them on the shared resolver', async () => {
  const alice = await registerAndToken();
  const bob = await registerAndToken();
  assert.equal((await srv.signingKeys(alice.agent_id))?.kid, alice.signing_key.kid, 'the shared resolver serves the registration key');

  const opened = await post('/v1/negotiations', alice.token, { counterparty_agent_id: bob.agent_id });
  assert.equal(opened.status, 201);
  const negId = opened.json.negotiation_id as string;

  // Rotate Alice BEFORE she offers: her registration key is revoked, the rotation key replaces it.
  const rot = await fetch(`${srv.url}/v1/agents/${alice.client_id}/rotate`, { method: 'POST', headers: { 'x-dev-owner': alice.owner } });
  assert.equal(rot.status, 200);
  const rotated = (await rot.json()) as { client_secret: string; signing_key: Jwk };
  const aliceToken = await tokenFor(alice.client_id, rotated.client_secret);

  const stale = await post(`/v1/negotiations/${negId}/offers`, aliceToken, { action: 'offer', give: GIVE, want: WANT, signature: signMove(alice.signing_key, negId, alice.agent_id, 'offer', null) });
  assert.equal(stale.status, 422);
  assert.equal(stale.json.error, 'signature_invalid', 'the revoked registration key no longer signs for Alice');

  const offered = await post(`/v1/negotiations/${negId}/offers`, aliceToken, { action: 'offer', give: GIVE, want: WANT, signature: signMove(rotated.signing_key, negId, alice.agent_id, 'offer', null) });
  assert.equal(offered.status, 200, JSON.stringify(offered.json));
  const offerId = (offered.json.offers as Array<{ offer_id: string }>)[0].offer_id;

  const accepted = await post(`/v1/negotiations/${negId}/offers`, bob.token, { action: 'accept', respond_to: offerId, signature: signMove(bob.signing_key, negId, bob.agent_id, 'accept', offerId) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.status, 'bound');

  const del = await fetch(`${srv.url}/v1/agents/${bob.client_id}`, { method: 'DELETE', headers: { 'x-dev-owner': bob.owner } });
  assert.equal(del.status, 200);
  assert.equal(await srv.signingKeys(bob.agent_id), null);
});
