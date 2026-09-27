/**
 * Delegated squad tokens — RFC 8693 token exchange, MINT SIDE (B1).
 * Implements docs/security/delegated-squad-tokens.md §7.1–§7.13 (the mint-side
 * assertions) against the live POST /v1/oauth/token/exchange endpoint plus the
 * pure wot-auth narrowing/root helpers. Enforcement/cascade at the arena is in
 * services/arena/test/delegation.test.ts.
 *
 * Isolated dev-keys + test pepper set BEFORE wot-auth loads (same as passports.test.ts).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-dlg-keys-'));
process.env.WOT_SECRET_PEPPER = 'test-pepper-delegation';
process.env.WOT_DEV_AUTH = '1';

const { createStores } = await import('wot-store');
const { mintAccessToken, verifyAccessToken, narrowChildScope, isRootToken } = await import('wot-auth');
const { createPassportsApp } = await import('../src/index.ts');

type Stores = ReturnType<typeof createStores>;
type Json = Record<string, unknown>;

let server: http.Server;
let base: string;
let stores: Stores;

before(async () => {
  stores = createStores();
  const app = createPassportsApp({ stores });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
let uidSeq = 0;

/** A parent passport with an ACTIVE owner record (the exchange asserts owner status). */
async function makeParent(scopes = ['play:raid', 'spectate:read', 'negotiate:a2a']) {
  const owner = await stores.owners.resolveByArchitect('urn:test', `arch-${uidSeq++}`);
  const p = await stores.passports.createPassport({ ownerId: owner.ownerId, scopes, league: 'core' });
  return { ...p, ownerId: owner.ownerId, scopes };
}

/** Mint a live parent (root) at+jwt — the subject_token possession proof. */
function parentToken(
  p: { clientId: string; agentId: string; ownerId: string },
  scope: string[],
  ttlSeconds = 600,
  overrides: Record<string, unknown> = {},
) {
  return mintAccessToken({
    ownerId: p.ownerId,
    agentId: p.agentId,
    clientId: p.clientId,
    league: 'core',
    scope,
    ttlSeconds,
    ...overrides,
  });
}

function basic(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

async function exchange(
  auth: { clientId: string; secret: string } | null,
  body: Json,
): Promise<{ res: Response; json: Json }> {
  const res = await fetch(`${base}/v1/oauth/token/exchange`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: basic(auth.clientId, auth.secret) } : {}),
    },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as Json };
}

/** A well-formed exchange body for `count` play:raid children (fresh squad). */
function reqBody(count = 1, scope = 'play:raid', squadId?: string): Json {
  return {
    grant_type: EXCHANGE_GRANT,
    subject_token: '<set by caller>',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope,
    squad: { count, ...(squadId ? { squad_id: squadId } : {}) },
  };
}

function decodePayload(jwt: string): Json {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Json;
}

// ─────────────────────────── §7.1 / §7.2 scope narrowing ───────────────────────────

test('§7.1 child scope ⊄ parent → invalid_scope, no token minted', async () => {
  const p = await makeParent(['spectate:read', 'negotiate:a2a']); // parent lacks play:raid
  const subject = await parentToken(p, ['spectate:read', 'negotiate:a2a']);
  const { res, json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: subject },
  );
  assert.equal(res.status, 400);
  assert.equal(json.error, 'invalid_scope');
  assert.equal(json.children, undefined);
});

test('§7.2 non-delegable scope rejected even when the parent holds it', async () => {
  const p = await makeParent(['play:raid', 'negotiate:a2a', 'play:duel']);
  const subject = await parentToken(p, ['play:raid', 'negotiate:a2a', 'play:duel']);
  for (const scope of ['negotiate:a2a', 'play:duel']) {
    const { res, json } = await exchange(
      { clientId: p.clientId, secret: p.secret },
      { ...reqBody(1, scope), subject_token: subject },
    );
    assert.equal(res.status, 400, `scope ${scope}`);
    assert.equal(json.error, 'invalid_scope', `scope ${scope}`);
  }
});

test('§7.3 scope defaults + narrows (never a superset) — narrowChildScope', () => {
  // Omitted request ⇒ parent ∩ DELEGABLE.
  const def = narrowChildScope(null, ['play:raid', 'spectate:read', 'negotiate:a2a']);
  assert.deepEqual(def, { ok: true, scopes: ['play:raid', 'spectate:read'] });
  // A subset request is honored.
  assert.deepEqual(narrowChildScope(['play:raid'], ['play:raid', 'spectate:read']), {
    ok: true,
    scopes: ['play:raid'],
  });
  // Never a superset: a parent-held-but-non-delegable scope is refused.
  assert.deepEqual(narrowChildScope(['negotiate:a2a'], ['play:raid', 'negotiate:a2a']), {
    ok: false,
    reason: 'invalid_scope',
  });
  // A parent with no delegable scope at all can mint nothing.
  assert.deepEqual(narrowChildScope(null, ['negotiate:a2a']), { ok: false, reason: 'invalid_scope' });
});

// ─────────────────────────── §7.4 / §7.5 depth cap ───────────────────────────

test('§7.4 re-delegation rejected — a child presented as subject_token → invalid_request', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid', 'spectate:read']);
  // Mint a child first.
  const { json: ok } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: subject },
  );
  const childToken = (ok.children as Json[])[0].access_token as string;
  // Now try to exchange the CHILD (its client_id is the parent cid, so client auth
  // passes — the root-token gate is what stops it).
  const { res, json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: childToken },
  );
  assert.equal(res.status, 400);
  assert.equal(json.error, 'invalid_request');
});

test('§7.5 depth-cap shape — child has depth 1, flat act, parent_agent_id; isRootToken(child) is false', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const { json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: subject },
  );
  const childToken = (json.children as Json[])[0].access_token as string;
  const claims = await verifyAccessToken(childToken);
  assert.equal(claims.delegation!.depth, 1);
  assert.deepEqual(claims.act, { sub: p.agentId }); // FLAT, un-nested
  assert.equal(claims.parent_agent_id, p.agentId);
  assert.equal(isRootToken(claims), false);
  // The parent (subject) IS a root.
  assert.equal(isRootToken(await verifyAccessToken(subject)), true);
});

// ─────────────────────────── §7.6 subject live + own ───────────────────────────

test('§7.6 expired subject → invalid_grant; foreign-client subject → invalid_client', async () => {
  const p = await makeParent();

  const expired = await parentToken(p, ['play:raid'], -30); // already past exp
  const a = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: expired },
  );
  assert.equal(a.res.status, 401);
  assert.equal(a.json.error, 'invalid_grant');

  // A live subject whose client_id ≠ the authenticated client (confused deputy).
  const foreign = await mintAccessToken({
    ownerId: p.ownerId,
    agentId: p.agentId,
    clientId: 'cid_00000000000000000000000000',
    league: 'core',
    scope: ['play:raid'],
  });
  const b = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: foreign },
  );
  assert.equal(b.res.status, 401);
  assert.equal(b.json.error, 'invalid_client');
});

// ─────────────────────────── §7.7 / §7.8 / §7.9 claim shape, TTL, owner ───────────────────────────

test('§7.7 child is a well-formed at+jwt with a complete delegation claim; inherits owner_id/league', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid', 'spectate:read']);
  const squadId = undefined;
  const { json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid', squadId), subject_token: subject },
  );
  const child = (json.children as Json[])[0];
  const claims = await verifyAccessToken(child.access_token as string);
  const d = claims.delegation!;
  assert.match(d.grant_id, /^dlg_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(d.squad_id, /^sqd_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(d.member_id, /^mem_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(d.raid_id, null);
  assert.deepEqual(d.chain, [p.agentId, claims.agent_id]);
  assert.equal(d.slot, 1);
  assert.equal(d.depth, 1);
  // Inherited, never widened.
  assert.equal(claims.owner_id, p.ownerId);
  assert.equal(claims.league, 'core');
  assert.deepEqual(claims.scopes, ['play:raid']);
  // Response projection matches the token's binding.
  assert.equal(json.squad_id, d.squad_id);
  assert.equal((child.delegation as Json).squad_id, d.squad_id);
});

test('§7.8 TTL is capped at min(300, parent remaining) and never exceeds parent exp', async () => {
  const p = await makeParent();
  // Long parent (600 s) → child capped at 300.
  const long = await parentToken(p, ['play:raid'], 600);
  const longClaims = await verifyAccessToken(long);
  const { json: j1 } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: long },
  );
  const c1 = (j1.children as Json[])[0];
  assert.equal(c1.expires_in, 300);
  const c1exp = (await verifyAccessToken(c1.access_token as string)).exp;
  assert.ok(c1exp <= longClaims.exp, 'child exp ≤ parent exp');

  // Short parent (120 s) → child capped at the parent remaining, not 300.
  const short = await parentToken(p, ['play:raid'], 120);
  const shortClaims = await verifyAccessToken(short);
  const { json: j2 } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: short },
  );
  const c2 = (j2.children as Json[])[0];
  assert.ok((c2.expires_in as number) <= 120 && (c2.expires_in as number) >= 118);
  const c2exp = (await verifyAccessToken(c2.access_token as string)).exp;
  assert.ok(c2exp <= shortClaims.exp, 'child exp ≤ short parent exp');
});

test('§7.9 cross-owner blocked — child owner_id = subject owner_id; a caller-supplied owner is rejected', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  // A caller-supplied owner_id is not even a valid field (additionalProperties:false).
  const withOwner = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: subject, owner_id: 'own_EVIL' },
  );
  assert.equal(withOwner.res.status, 400);
  assert.equal(withOwner.json.error, 'invalid_request');
  // And the honest path always stamps the subject's owner.
  const { json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: subject },
  );
  const claims = await verifyAccessToken((json.children as Json[])[0].access_token as string);
  assert.equal(claims.owner_id, p.ownerId);
});

// ─────────────────────────── §7.10 child cannot re-mint / manage ───────────────────────────

test('§7.10 a child cannot re-mint — no secret ⇒ client_credentials with its client_id fails', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const { json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { ...reqBody(1, 'play:raid'), subject_token: subject },
  );
  const childClaims = await verifyAccessToken((json.children as Json[])[0].access_token as string);
  // The child carries the PARENT cid but never a secret. Any attempt to use that
  // client_id at the token endpoint without the (child-unknown) secret is refused.
  assert.equal(childClaims.client_id, p.clientId);
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: childClaims.client_id,
    client_secret: 'wotk_sk_' + 'Z'.repeat(43),
  });
  const res = await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as Json).error, 'invalid_client');
});

// ─────────────────────────── §7.11 rate limits / squad cap ───────────────────────────

test('§7.11 per-parent exchange bucket returns 429 at threshold', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const auth = { clientId: p.clientId, secret: p.secret };
  let last = 200;
  for (let i = 0; i < 21; i++) {
    const { res } = await exchange(auth, { ...reqBody(1, 'play:raid'), subject_token: subject });
    last = res.status;
  }
  assert.equal(last, 429, 'the 21st exchange in the window is rate-limited');
});

test('§7.11 squad-size cap — a 6th slot in the same squad is rejected (invalid_request)', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const auth = { clientId: p.clientId, secret: p.secret };
  const first = await exchange(auth, { ...reqBody(5, 'play:raid'), subject_token: subject });
  assert.equal(first.res.status, 200);
  const squadId = first.json.squad_id as string;
  assert.equal((first.json.children as Json[]).length, 5);
  // Reuse the SAME squad for a 6th member → over cap.
  const sixth = await exchange(auth, { ...reqBody(1, 'play:raid', squadId), subject_token: subject });
  assert.equal(sixth.res.status, 400);
  assert.equal(sixth.json.error, 'invalid_request');
});

test('reuse an existing squad_id keeps the same squad + grant and allocates fresh slots', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const auth = { clientId: p.clientId, secret: p.secret };
  const a = await exchange(auth, { ...reqBody(2, 'play:raid'), subject_token: subject });
  const squadId = a.json.squad_id as string;
  const b = await exchange(auth, { ...reqBody(2, 'play:raid', squadId), subject_token: subject });
  assert.equal(b.json.squad_id, squadId);
  const slotsA = (a.json.children as Json[]).map((c) => c.slot);
  const slotsB = (b.json.children as Json[]).map((c) => c.slot);
  assert.deepEqual(slotsA, [1, 2]);
  assert.deepEqual(slotsB, [3, 4]); // one shared grant, sequential slots
});

// ─────────────────────────── §7.12 no enumeration oracle ───────────────────────────

test('§7.12 no enumeration oracle — unknown parent id and wrong secret are byte-identical', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const body = { ...reqBody(1, 'play:raid'), subject_token: subject };
  const badId = await exchange(
    { clientId: 'cid_00000000000000000000000000', secret: 'wotk_sk_' + 'A'.repeat(43) },
    body,
  );
  const badSecret = await exchange({ clientId: p.clientId, secret: 'wotk_sk_' + 'B'.repeat(43) }, body);
  assert.equal(badId.res.status, 401);
  assert.equal(badSecret.res.status, 401);
  assert.deepEqual(badId.json, { error: 'invalid_client', error_description: 'Client authentication failed.' });
  assert.deepEqual(badSecret.json, badId.json); // identical body, no oracle
});

test('missing client auth → invalid_client (both credentials required with the subject_token)', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const { res, json } = await exchange(null, { ...reqBody(1, 'play:raid'), subject_token: subject });
  assert.equal(res.status, 401);
  assert.equal(json.error, 'invalid_client');
});

test('wrong grant_type → unsupported_grant_type', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const { res, json } = await exchange(
    { clientId: p.clientId, secret: p.secret },
    { grant_type: 'client_credentials', subject_token: subject, scope: 'play:raid', squad: { count: 1 } },
  );
  assert.equal(res.status, 400);
  assert.equal(json.error, 'unsupported_grant_type');
});

// ─────────────────────────── §7.13 reserved→enforced regression ───────────────────────────

test('§7.13 a root token (no delegation) verifies unchanged; mint without delegation emits no delegation key', async () => {
  const root = await mintAccessToken({
    ownerId: 'own_01J8ZK9QMR4T7V2X0PABCDE3FG',
    agentId: 'agt_01J8ZK9QMR4T7V2X0PABCDE3FG',
    clientId: 'cid_01J8ZK9QMR4T7V2X0PABCDE3FG',
    league: 'core',
    scope: ['play:duel', 'spectate:read', 'negotiate:a2a'],
  });
  const claims = await verifyAccessToken(root);
  assert.equal(claims.delegation, null);
  assert.equal(claims.act, null);
  assert.equal(claims.parent_agent_id, null);
  assert.equal(isRootToken(claims), true);
  // The wire payload carries NO `delegation` key (byte-shape unchanged from Phase 1).
  const payload = decodePayload(root);
  assert.equal('delegation' in payload, false);
  assert.equal(payload.act, null);
  assert.equal(payload.parent_agent_id, null);
});

// ─────────────────────────── mint-side cascade: revoked parent ───────────────────────────

test('cascade (mint) — a revoked parent passport cannot exchange (invalid_client)', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const auth = { clientId: p.clientId, secret: p.secret };
  const ok = await exchange(auth, { ...reqBody(1, 'play:raid'), subject_token: subject });
  assert.equal(ok.res.status, 200);
  await stores.passports.revoke(p.clientId);
  const after = await exchange(auth, { ...reqBody(1, 'play:raid'), subject_token: subject });
  assert.equal(after.res.status, 401);
  assert.equal(after.json.error, 'invalid_client');
});

test('cascade (mint) — a banned owner cannot exchange (invalid_client)', async () => {
  const p = await makeParent();
  const subject = await parentToken(p, ['play:raid']);
  const auth = { clientId: p.clientId, secret: p.secret };
  assert.equal((await exchange(auth, { ...reqBody(1, 'play:raid'), subject_token: subject })).res.status, 200);
  await stores.passports.banOwner(p.ownerId); // flips the passport to revoked (ban lineage)
  const after = await exchange(auth, { ...reqBody(1, 'play:raid'), subject_token: subject });
  assert.equal(after.res.status, 401);
  assert.equal(after.json.error, 'invalid_client');
});
