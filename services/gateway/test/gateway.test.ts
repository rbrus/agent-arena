/**
 * gateway service — happy path + the agent-passports §9 abuse cases required
 * for the Phase-1 gate: scope enforcement (a spectate:read token rejected at
 * /v1/queue → 403), unauthenticated rejection, and the reserved-claim tolerance
 * (a token carrying parent_agent_id:null / act:null authorizes normally).
 *
 * Tokens are minted directly via wot-auth (same in-process keypair the gateway
 * verifies with), using an isolated dev-keys dir set before wot-auth loads.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WOT_DEV_KEYS_DIR = mkdtempSync(join(tmpdir(), 'wot-gw-keys-'));

const { createStores } = await import('wot-store');
const { mintAccessToken } = await import('wot-auth');
const { createGatewayApp } = await import('../src/index.ts');

const ARENA_BASE = 'ws://localhost:8080';
let server: http.Server;
let base: string;
let stores: Awaited<ReturnType<typeof createStores>>;

before(async () => {
  stores = createStores({ arenaBaseUrl: `${ARENA_BASE}/v1/arena` });
  const app = createGatewayApp({ stores, arenaBaseUrl: ARENA_BASE });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://localhost:${port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

async function mint(scope: string[]) {
  return mintAccessToken({
    ownerId: 'own_alice',
    agentId: 'agt_01J8ZK9QMR4T7V2X0PABCDE3FG',
    clientId: 'cid_01J8ZK9QMR4T7V2X0PABCDE3FG',
    league: 'core',
    scope,
  });
}

async function queue(token: string | null, body: unknown = { mode: 'duel', league: 'core' }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/v1/queue`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

test('happy path: play:duel token enters queue → 202 ticket + arena_url', async () => {
  const token = await mint(['play:duel', 'spectate:read']);
  const { res, json } = await queue(token);
  assert.equal(res.status, 202);
  assert.match(json.ticket_id as string, /^tkt_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(json.status, 'queued');
  assert.equal(json.mode, 'duel');
  assert.equal(json.league, 'core');
  const arenaUrl = json.arena_url as string;
  assert.ok(arenaUrl.startsWith('ws://localhost:8080/v1/arena?ticket_id=tkt_'), arenaUrl);
  assert.ok(typeof json.expires_at === 'string');
});

test('ABUSE: scope enforcement — spectate:read-only token rejected at /v1/queue → 403', async () => {
  const token = await mint(['spectate:read']);
  const { res, json } = await queue(token);
  assert.equal(res.status, 403);
  assert.equal(json.error, 'insufficient_scope');
  assert.match(res.headers.get('www-authenticate') ?? '', /insufficient_scope/);
});

test('unauthenticated: no token → 401', async () => {
  const { res, json } = await queue(null);
  assert.equal(res.status, 401);
  assert.equal(json.error, 'unauthenticated');
  assert.equal(res.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
});

test('unauthenticated: a garbage token → 401', async () => {
  const { res, json } = await queue('not.a.jwt');
  assert.equal(res.status, 401);
  assert.equal(json.error, 'unauthenticated');
});

test('queue: unknown field in body → 400 invalid_request', async () => {
  const token = await mint(['play:duel']);
  const { res, json } = await queue(token, { mode: 'duel', evil: true });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'invalid_request');
});

test('reserved-claim tolerance: minted tokens carry parent_agent_id/act = null and still authorize', async () => {
  const token = await mint(['play:duel']);
  const { res } = await queue(token);
  assert.equal(res.status, 202); // verifyAccessToken tolerated the reserved null claims
});

test('matches: missing → 404; present → 200 (spectate:read)', async () => {
  const token = await mint(['spectate:read']);
  const miss = await fetch(`${base}/v1/matches/mat_00000000000000000000000000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(miss.status, 404);
  assert.equal(((await miss.json()) as Record<string, unknown>).error, 'match_not_found');

  await stores.matches.saveSummary({ matchId: 'mat_01J8ZK9QMR4T7V2X0PABCDE3FG', mode: 'duel', status: 'completed' });
  const hit = await fetch(`${base}/v1/matches/mat_01J8ZK9QMR4T7V2X0PABCDE3FG`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(hit.status, 200);
  const summary = (await hit.json()) as Record<string, unknown>;
  assert.equal(summary.match_id, 'mat_01J8ZK9QMR4T7V2X0PABCDE3FG');
  assert.equal(summary.status, 'completed');
});

test('matches: a play:duel-only token lacks spectate:read → 403', async () => {
  const token = await mint(['play:duel']);
  const res = await fetch(`${base}/v1/matches/mat_00000000000000000000000000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as Record<string, unknown>).error, 'insufficient_scope');
});

test('replays: missing → 404; present → 200 mapped to snake_case', async () => {
  const token = await mint(['spectate:read']);
  const miss = await fetch(`${base}/v1/replays/rpl_00000000000000000000000000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(miss.status, 404);
  assert.equal(((await miss.json()) as Record<string, unknown>).error, 'replay_not_found');

  const saved = await stores.replays.saveReplay({
    seed: 2864901733,
    inputs: [],
    tickLog: [],
    hash: 'sha256:' + '9'.repeat(64),
    matchId: 'mat_01J8ZK9QMR4T7V2X0PABCDE3FG',
  });
  const hit = await fetch(`${base}/v1/replays/${saved.replayId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(hit.status, 200);
  const replay = (await hit.json()) as Record<string, unknown>;
  assert.equal(replay.replay_id, saved.replayId);
  assert.equal(replay.seed, 2864901733);
  assert.match(replay.replay_hash as string, /^sha256:[0-9a-f]{64}$/);
});
