/**
 * The arena raid flow (Phase 4 B2, gate item 1's arena spine): queue a squad with
 * DELEGATED child tokens → each member raid_hello (authenticated by B1's
 * `verifyDelegatedChild` seam) → raid_observation/raid_action loop → a
 * deterministic CLEAR → outcome + replay hash recorded, the replay retrievable
 * (no reward: ADR-001 §6).
 *
 * The five test clients COORDINATE (as a squad may over an A2A back-channel,
 * raids-v1 §6.3): the harness pools each tick's observations and drives the
 * frozen consensus reference policy, which the engine golden test proves clears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Architect issuer for owners minted directly in the store (agent-passports §1.1). */
const TEST_ISSUER = 'urn:agent-arena:test';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-raid-'));

const { WebSocket } = await import('ws');
const { createStores, newId } = await import('wot-store');
const { mintAccessToken } = await import('wot-auth');
const { runRaid, referenceSquadSpec, consensusSquad, buildRaidObservation, createInitialRaidState, resolveRaidTick } =
  await import('wot-engine');
const { attachRaidArena } = await import('../src/raid.ts');
const { CLOSE } = await import('../src/config.ts');

const SEED = 20260720; // the frozen golden seed (consensus clears The Hallucinator)

type Stores = ReturnType<typeof createStores>;

async function makeSquad(stores: Stores, count = 5) {
  const owner = await stores.owners.resolveByArchitect(TEST_ISSUER, `uid-${newId('agt')}`);
  const parent = await stores.passports.createPassport({
    ownerId: owner.ownerId,
    scopes: ['play:raid', 'spectate:read'],
    league: 'core',
  });
  const grant = await stores.delegations.openOrGet({
    parentClientId: parent.clientId,
    parentAgentId: parent.agentId,
    ownerId: owner.ownerId,
    scopes: ['play:raid'],
    ttlSeconds: 3600,
    raidId: null,
  });
  const slots = (await stores.delegations.reserveSlots(grant.grantId, count, 5))!;
  const children = [];
  for (const slot of slots) {
    const childAgentId = newId('agt');
    const memberId = newId('mem');
    const token = await mintAccessToken({
      ownerId: owner.ownerId,
      agentId: childAgentId,
      clientId: parent.clientId,
      league: 'core',
      scope: ['play:raid'],
      ttlSeconds: 600,
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
        raid_id: null,
      },
    });
    children.push({ token, memberId, slot });
  }
  return { owner, parent, grant, squadId: grant.squadId, children };
}

async function setup() {
  const stores = createStores();
  const server = http.createServer();
  const raid = attachRaidArena({ server, stores, raidSeed: SEED, softMs: 200, hardMs: 500 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    stores,
    raid,
    url: `ws://127.0.0.1:${port}/v1/raid`,
    close: async () => {
      await raid.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ─────────────────────────── queue ───────────────────────────

test('POST /v1/raids/queue: forms a 5-slot squad from delegated tokens → RaidTicket', async () => {
  const h = await setup();
  try {
    const sq = await makeSquad(h.stores);
    const res = await h.raid.queueRaid({
      squad_id: sq.squadId,
      boss_id: 'the_hallucinator',
      delegated_tokens: sq.children.map((c) => c.token),
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.match(String(res.ticket!.raid_id), /^rad_/);
    assert.equal((res.ticket!.members as unknown[]).length, 5);
    assert.match(String(res.ticket!.arena_url), /\/v1\/raid$/);
  } finally {
    await h.close();
  }
});

test('POST /v1/raids/queue: a token not bound to the squad is rejected 422', async () => {
  const h = await setup();
  try {
    const a = await makeSquad(h.stores, 2);
    const b = await makeSquad(h.stores, 1); // a foreign child (different squad)
    const res = await h.raid.queueRaid({
      squad_id: a.squadId,
      boss_id: 'the_hallucinator',
      delegated_tokens: [a.children[0].token, b.children[0].token],
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 422);
    assert.equal(res.error!.code, 'token_not_bound');
  } finally {
    await h.close();
  }
});

// ─────────────────────────── raid_hello auth ───────────────────────────

test('raid_hello: a non-delegated (root) token is closed 4403 on the raid channel', async () => {
  const h = await setup();
  try {
    const owner = await h.stores.owners.resolveByArchitect(TEST_ISSUER, 'root-holder');
    const p = await h.stores.passports.createPassport({ ownerId: owner.ownerId, scopes: ['play:raid'], league: 'core' });
    const rootToken = await mintAccessToken({ ownerId: owner.ownerId, agentId: p.agentId, clientId: p.clientId, league: 'core', scope: ['play:raid'] });
    const ws = new WebSocket(h.url);
    await new Promise<void>((r) => ws.once('open', () => r()));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send(JSON.stringify({ t: 'raid_hello', protocol_version: '1.0', token: rootToken, mode: 'raid', squad_id: newId('sqd') }));
    assert.equal(await closed, CLOSE.FORBIDDEN);
  } finally {
    await h.close();
  }
});

// ─────────────────────────── full flow: clear + replay ───────────────────────────────────

test('end-to-end: 5 delegated children raid, CLEAR The Hallucinator, outcome + replay retrievable', async () => {
  const h = await setup();
  try {
    const sq = await makeSquad(h.stores);

    // Precompute the frozen consensus action sets for this exact (seed, spec).
    const golden = runRaid(SEED, 'the_hallucinator', consensusSquad, referenceSquadSpec());

    const ticket = (await h.raid.queueRaid({ squad_id: sq.squadId, boss_id: 'the_hallucinator', delegated_tokens: sq.children.map((c) => c.token) })).ticket!;
    const raidId = String(ticket.raid_id);
    const memBySlot = new Map(sq.children.map((c) => [c.slot, c.memberId]));

    // Map an engine action (unit_id m{i}-type, engine member ids) → a wire raid_action.
    const wireUnits = (units: unknown[]): unknown[] =>
      units.map((raw) => {
        const u = raw as Record<string, unknown>;
        if (u.verb === 'revive' && typeof u.target_member === 'string') {
          const slot = Number(String(u.target_member).slice(1)) + 1;
          return { unit_id: u.unit_id, verb: 'revive', target_member: memBySlot.get(slot) };
        }
        return u;
      });

    const ends: Record<string, unknown>[] = [];
    const sockets: InstanceType<typeof WebSocket>[] = [];
    const allDone = Promise.all(
      sq.children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(h.url);
            sockets.push(ws);
            const engineMember = `m${child.slot - 1}`;
            ws.on('open', () => ws.send(JSON.stringify({ t: 'raid_hello', protocol_version: '1.0', token: child.token, mode: 'raid', squad_id: sq.squadId, member_id: child.memberId, raid_id: raidId })));
            ws.on('message', (data) => {
              const f = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
              if (f.t === 'raid_observation') {
                const turn = f.turn_id as number;
                const acts = golden.inputs[turn]?.[engineMember] ?? [{ unit_id: `${engineMember}-x`, verb: 'hold' }];
                ws.send(JSON.stringify({ t: 'raid_action', protocol_version: '1.0', raid_id: raidId, turn_id: turn, nonce: f.nonce, member_id: child.memberId, units: wireUnits(acts) }));
              } else if (f.t === 'raid_end') {
                ends.push(f);
                resolve();
              }
            });
            ws.on('error', reject);
          }),
      ),
    );

    await allDone;
    for (const ws of sockets) ws.close();

    // Every member saw a CLEAR.
    assert.equal(ends.length, 5);
    for (const e of ends) {
      assert.equal(e.outcome, 'clear');
      assert.equal(e.boss_defeated, true);
      assert.equal(e.replay_hash, golden.replayHash, 'the arena reproduced the frozen golden clear');
      assert.equal('reward' in e, false, 'raid_end carries no reward (contracts 2.0.0)');
    }

    // The replay is retrievable (like a duel replay) and hash-committed.
    const replayId = String(ends[0].replay_id);
    const replay = await h.stores.replays.getReplay(replayId);
    assert.ok(replay, 'replay stored');
    assert.equal(replay!.hash, golden.replayHash);
    assert.equal(replay!.matchId, raidId);

    // The raid summary is retrievable (GET /v1/raids/{raid_id}).
    const summary = (await h.raid.getRaidSummary(raidId)) as Record<string, unknown>;
    assert.equal(summary.outcome, 'clear');
    assert.equal(summary.boss_defeated, true);
    void createInitialRaidState;
    void resolveRaidTick;
    void buildRaidObservation;
  } finally {
    await h.close();
  }
});
