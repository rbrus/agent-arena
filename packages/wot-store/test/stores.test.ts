import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySecret } from 'wot-auth';
import { createStores, newId, idPattern, type IdPrefix } from '../src/index.ts';

test('newId produces contract-valid, prefixed ULIDs', () => {
  const prefixes: IdPrefix[] = ['mat', 'tkt', 'rpl', 'agt', 'cid', 'own', 'ses'];
  for (const p of prefixes) {
    const id = newId(p);
    assert.match(id, new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{26}$`), `newId(${p}) = ${id}`);
    assert.ok(idPattern(p).test(id));
  }
  // ids are unique across calls
  assert.notEqual(newId('mat'), newId('mat'));
});

test('passport lifecycle: create -> get -> rotate -> revoke, hash-only storage', async () => {
  const { passports } = createStores();

  const { clientId, agentId, secret } = await passports.createPassport({
    ownerId: 'own_01J8ZK9QMR4T7V2X0PABCDE3FG',
    scopes: ['play:duel', 'spectate:read'],
    league: 'core',
  });
  assert.match(clientId, idPattern('cid'));
  assert.match(agentId, idPattern('agt'));
  assert.ok(secret.startsWith('wotk_sk_'));

  const rec = await passports.getByClientId(clientId);
  assert.ok(rec);
  // Only the keyed hash is stored — never the plaintext.
  assert.ok(rec.secretHash.startsWith('hmac_sha256:'));
  assert.ok(!rec.secretHash.includes(secret));
  assert.equal(verifySecret(secret, rec.secretHash), true);
  assert.equal(rec.status, 'active');
  assert.equal(rec.secretVersion, 1);

  const byAgent = await passports.getByAgentId(agentId);
  assert.equal(byAgent?.clientId, clientId);

  // Rotate: old secret stops verifying, new one starts.
  const rotated = await passports.rotateSecret(clientId);
  assert.ok(rotated);
  assert.notEqual(rotated.secret, secret);
  const rec2 = await passports.getByClientId(clientId);
  assert.ok(rec2);
  assert.equal(verifySecret(rotated.secret, rec2.secretHash), true);
  assert.equal(verifySecret(secret, rec2.secretHash), false);
  assert.equal(rec2.secretVersion, 2);
  assert.ok(rec2.rotatedAt);

  // Revoke.
  assert.equal(await passports.revoke(clientId), true);
  assert.equal((await passports.getByClientId(clientId))?.status, 'revoked');

  // Unknown ids.
  assert.equal(await passports.getByClientId('cid_missing'), null);
  assert.equal(await passports.rotateSecret('cid_missing'), null);
  assert.equal(await passports.revoke('cid_missing'), false);
});

test('owner ban voids every passport under the owner', async () => {
  const { passports } = createStores();
  const owner = 'own_BANME';
  const a = await passports.createPassport({ ownerId: owner, scopes: ['play:duel'], league: 'core' });
  const b = await passports.createPassport({ ownerId: owner, scopes: ['play:duel'], league: 'core' });
  const other = await passports.createPassport({
    ownerId: 'own_OTHER',
    scopes: ['play:duel'],
    league: 'core',
  });

  const count = await passports.banOwner(owner);
  assert.equal(count, 2);
  assert.equal((await passports.getByClientId(a.clientId))?.status, 'revoked');
  assert.equal((await passports.getByClientId(b.clientId))?.status, 'revoked');
  assert.equal((await passports.getByClientId(other.clientId))?.status, 'active');
});

test('ticket lifecycle: create -> bind match -> set status', async () => {
  const { tickets } = createStores();
  const ticket = await tickets.createTicket({
    ownerId: 'own_x',
    agentId: 'agt_x',
    mode: 'duel',
    league: 'core',
  });
  assert.match(ticket.ticketId, idPattern('tkt'));
  assert.equal(ticket.status, 'pending');
  assert.ok(ticket.arenaUrl.includes(ticket.ticketId));
  assert.equal(ticket.matchId, null);

  const matchId = newId('mat');
  const bound = await tickets.bindMatch(ticket.ticketId, matchId);
  assert.equal(bound?.matchId, matchId);
  assert.equal(bound?.status, 'assigned');

  const active = await tickets.setStatus(ticket.ticketId, 'active');
  assert.equal(active?.status, 'active');

  assert.equal(await tickets.getTicket('tkt_missing'), null);
});

test('match summary + replay round-trip', async () => {
  const { matches, replays } = createStores();

  const matchId = newId('mat');
  await matches.saveSummary({ matchId, winner: 'A', reason: 'ascension', ticksPlayed: 73 });
  const summary = await matches.getSummary(matchId);
  assert.equal(summary?.matchId, matchId);
  assert.equal(summary?.winner, 'A');
  assert.equal(await matches.getSummary('mat_missing'), null);

  const replay = await replays.saveReplay({
    seed: 2864901733,
    inputs: [{ turn: 0, units: [] }],
    tickLog: [{ tick: 0, hash: 'sha256:deadbeef' }],
    hash: 'sha256:9f2c1b7e4a6d8035f1c2b3a4d5e6f7089a0b1c2d3e4f5061728394a5b6c7d8e9',
    matchId,
  });
  assert.match(replay.replayId, idPattern('rpl'));
  assert.equal(replay.matchId, matchId);
  const fetched = await replays.getReplay(replay.replayId);
  assert.equal(fetched?.seed, 2864901733);
  assert.equal(fetched?.hash, replay.hash);
  assert.equal(await replays.getReplay('rpl_missing'), null);
});
