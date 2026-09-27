/**
 * Delegated squad tokens — ENFORCEMENT + CASCADE (B1, arena side).
 * Implements docs/security/delegated-squad-tokens.md §7.14–§7.19 to the extent
 * coverable without the raid engine (B2/C1): the reusable connect seam
 * `verifyDelegatedChild` (what B2 calls at raid_hello), scope-at-connect on the
 * duel channel, raid/squad binding, one-session-per-slot keying, and the full
 * revocation cascade (parent revoke, owner ban, grant dissolve, single-jti kill).
 *
 * The arena's rolling 30 s loop re-reads the SAME gates this seam checks, so
 * proving the seam proves the loop's net-new branch (grant status + jti denylist).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Architect issuer for owners minted directly in the store (agent-passports §1.1). */
const TEST_ISSUER = 'urn:agent-arena:test';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-arena-dlg-'));

const { createStores, newId } = await import('wot-store');
const { mintAccessToken, verifyAccessToken, authorizeAffordance } = await import('wot-auth');
const { verifyDelegatedChild, registryKeyFor } = await import('../src/delegation.ts');
const { CLOSE } = await import('../src/config.ts');
const { setup, Client, helloFrame } = await import('./helpers.ts');

type Stores = ReturnType<typeof createStores>;

interface Child {
  token: string;
  jti: string;
  memberId: string;
  slot: number;
  squadId: string;
  raidId: string | null;
}
interface Squad {
  parent: { clientId: string; agentId: string };
  ownerId: string;
  grantId: string;
  squadId: string;
  children: Child[];
}

let uidSeq = 0;

/** Build a parent passport + active owner + one grant, and mint `count` children on it. */
async function makeSquad(
  stores: Stores,
  opts: { count?: number; raidId?: string | null; scopes?: string[]; league?: 'edge' | 'core' | 'frontier' } = {},
): Promise<Squad> {
  const count = opts.count ?? 1;
  const scopes = opts.scopes ?? ['play:raid'];
  const owner = await stores.owners.resolveByArchitect(TEST_ISSUER, `uid-${uidSeq++}`);
  const parent = await stores.passports.createPassport({
    ownerId: owner.ownerId,
    scopes: ['play:raid', 'spectate:read', 'negotiate:a2a'],
    league: 'core',
  });
  const grant = await stores.delegations.openOrGet({
    raidId: opts.raidId ?? null,
    parentClientId: parent.clientId,
    parentAgentId: parent.agentId,
    ownerId: owner.ownerId,
    scopes,
    ttlSeconds: 3600,
  });
  const slots = (await stores.delegations.reserveSlots(grant.grantId, count, 5))!;
  const children: Child[] = [];
  for (const slot of slots) {
    const childAgentId = newId('agt');
    const memberId = newId('mem');
    const token = await mintAccessToken({
      ownerId: owner.ownerId,
      agentId: childAgentId,
      clientId: parent.clientId,
      league: opts.league ?? 'core',
      scope: scopes,
      ttlSeconds: 300,
      delegation: {
        grant_id: grant.grantId,
        parent_client_id: parent.clientId,
        parent_agent_id: parent.agentId,
        parent_jti: 'root-jti',
        chain: [parent.agentId, childAgentId],
        depth: 1,
        squad_id: grant.squadId,
        slot,
        member_id: memberId,
        raid_id: grant.raidId,
      },
    });
    const { jti } = await verifyAccessToken(token);
    children.push({ token, jti, memberId, slot, squadId: grant.squadId, raidId: grant.raidId });
  }
  return {
    parent: { clientId: parent.clientId, agentId: parent.agentId },
    ownerId: owner.ownerId,
    grantId: grant.grantId,
    squadId: grant.squadId,
    children,
  };
}

// ─────────────────────────── happy path + not-delegated ───────────────────────────

test('verifyDelegatedChild: a well-bound child is accepted with a (squad_id, slot) registry key', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 1 });
  const c = sq.children[0];
  const r = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId, memberId: c.memberId });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.registryKey, `${c.squadId}:${c.slot}`);
    assert.equal(r.delegation.depth, 1);
    assert.deepEqual(r.claims.scopes, ['play:raid']);
  }
});

test('verifyDelegatedChild: a ROOT/parent token is not valid on the raid channel (4403 not_delegated)', async () => {
  const stores = createStores();
  const owner = await stores.owners.resolveByArchitect(TEST_ISSUER, 'root-holder');
  const p = await stores.passports.createPassport({ ownerId: owner.ownerId, scopes: ['play:raid'], league: 'core' });
  const rootToken = await mintAccessToken({
    ownerId: owner.ownerId,
    agentId: p.agentId,
    clientId: p.clientId,
    league: 'core',
    scope: ['play:raid'],
  });
  const r = await verifyDelegatedChild(stores, { token: rootToken });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'not_delegated');
    assert.equal(r.code, CLOSE.FORBIDDEN);
  }
});

test('verifyDelegatedChild: an unverifiable token is rejected 4401', async () => {
  const stores = createStores();
  const r = await verifyDelegatedChild(stores, { token: 'not-a-jwt.at.all' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, CLOSE.UNAUTHENTICATED);
});

// ─────────────────────────── §7.14 scope at connect ───────────────────────────

test('§7.14 scope enforcement — a play:raid child is rejected at a play:duel (arena) connect with 4403', async () => {
  const h = await setup();
  try {
    const sq = await makeSquad(h.stores, { count: 1 });
    const c = new Client(h.url);
    await c.open();
    c.send(helloFrame(sq.children[0].token)); // mode:'duel'
    const close = await c.waitClose(5000);
    assert.equal(close.code, CLOSE.FORBIDDEN); // 4403 — missing play:duel scope
  } finally {
    await h.close();
  }
});

test('§7.14 scope enforcement — a child is denied a negotiate:a2a affordance (insufficient_scope → REST 403)', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 1 });
  const claims = await verifyAccessToken(sq.children[0].token);
  const decision = authorizeAffordance(claims, { scope: 'negotiate:a2a' });
  assert.deepEqual(decision, { ok: false, reason: 'insufficient_scope', scope: 'negotiate:a2a' });
});

// ─────────────────────────── §7.15 raid / squad binding ───────────────────────────

test('§7.15 raid binding — a child bound to raid A is rejected at a raid-B connect (4403)', async () => {
  const stores = createStores();
  const radA = newId('rad');
  const radB = newId('rad');
  const sq = await makeSquad(stores, { count: 1, raidId: radA });
  const c = sq.children[0];
  const bad = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId, raidId: radB });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.reason, 'raid_binding');
    assert.equal(bad.code, CLOSE.FORBIDDEN);
  }
  // Its own raid is accepted.
  const good = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId, raidId: radA });
  assert.equal(good.ok, true);
});

test('§7.15 squad binding — a squad_id mismatch is rejected (4403)', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 1 });
  const c = sq.children[0];
  const bad = await verifyDelegatedChild(stores, { token: c.token, squadId: newId('sqd') });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'squad_binding');
  // member_id mismatch is likewise rejected.
  const badMember = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId, memberId: newId('mem') });
  assert.equal(badMember.ok, false);
  if (!badMember.ok) assert.equal(badMember.reason, 'member_binding');
});

// ─────────────────────────── §7.16 one session per child slot ───────────────────────────

test('§7.16 one-session-per-child — children key by (squad_id, slot); the parent keys by client_id', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 2 });
  const [c1, c2] = sq.children;
  const claims1 = await verifyAccessToken(c1.token);
  const claims2 = await verifyAccessToken(c2.token);
  // Distinct slots → distinct keys (the squad does not collapse to one session).
  assert.notEqual(registryKeyFor(claims1), registryKeyFor(claims2));
  assert.equal(registryKeyFor(claims1), `${c1.squadId}:${c1.slot}`);
  // A second connect for the SAME (squad_id, slot) resolves to the SAME key → supersede.
  assert.equal(registryKeyFor(claims1), `${claims1.delegation!.squad_id}:${claims1.delegation!.slot}`);
  // A root (parent) keys by its client_id — NOT by the shared squad — so it keeps
  // its own session alongside the children (all children share the parent cid).
  assert.equal(registryKeyFor({ client_id: sq.parent.clientId, delegation: null }), sq.parent.clientId);
});

// ─────────────────────────── §7.17 / §7.18 cascade: parent revoke, owner ban ───────────────────────────

test('§7.17 cascade — revoking the parent passport invalidates the child (4410)', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 1 });
  const c = sq.children[0];
  assert.equal((await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId })).ok, true);
  await stores.passports.revoke(sq.parent.clientId);
  const after = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId });
  assert.equal(after.ok, false);
  if (!after.ok) {
    assert.equal(after.reason, 'passport_or_owner_revoked');
    assert.equal(after.code, CLOSE.REVOKED);
  }
});

test('§7.18 cascade — banning the owner invalidates the child (4410, via the shared client_id)', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 1 });
  const c = sq.children[0];
  const banned = await stores.passports.banOwner(sq.ownerId); // flips the parent passport
  assert.ok(banned >= 1);
  const after = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId });
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.code, CLOSE.REVOKED);
});

// ─────────────────────────── §7.19 grant dissolve + sibling / jti independence ───────────────────────────

test('§7.19 cascade — dissolving a grant kills all its children; a sibling squad is unaffected', async () => {
  const stores = createStores();
  const g = await makeSquad(stores, { count: 2 }); // squad G (grant gA)
  const gPrime = await makeSquad(stores, { count: 1 }); // squad G′ (a different grant/owner)
  assert.ok(await stores.delegations.revokeGrant(g.grantId));
  for (const c of g.children) {
    const r = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId });
    assert.equal(r.ok, false, 'G child dies');
    if (!r.ok) {
      assert.equal(r.reason, 'grant_revoked');
      assert.equal(r.code, CLOSE.REVOKED);
    }
  }
  // The sibling squad under a different grant is untouched.
  const gp = gPrime.children[0];
  assert.equal((await verifyDelegatedChild(stores, { token: gp.token, squadId: gp.squadId })).ok, true);
});

test('§7.19 child independence — revoking one jti kills only that child; its sibling survives', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 2 }); // two children on ONE grant
  const [c1, c2] = sq.children;
  assert.ok(await stores.delegations.revokeJti(c1.jti));
  const r1 = await verifyDelegatedChild(stores, { token: c1.token, squadId: c1.squadId });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, 'jti_revoked');
  // The sibling (same grant, different jti) is unaffected.
  const r2 = await verifyDelegatedChild(stores, { token: c2.token, squadId: c2.squadId });
  assert.equal(r2.ok, true);
});

test('cascade — an expired grant invalidates its children (grant TTL)', async () => {
  const stores = createStores();
  const sq = await makeSquad(stores, { count: 1 });
  const c = sq.children[0];
  // Verify "in the future" past the grant's expiresAt (3600 s).
  const future = Date.now() + 3601_000;
  const r = await verifyDelegatedChild(stores, { token: c.token, squadId: c.squadId }, future);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'grant_revoked');
});
