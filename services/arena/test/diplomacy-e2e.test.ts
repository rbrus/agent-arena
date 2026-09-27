/**
 * Phase 8 B3a end to end: seven engine reference agents, each on its own passport
 * and its own WebSocket, play a full Diplomacy game to the horizon through the real
 * arena session layer (hello → diplomacy_observation → diplomacy_action → ack →
 * diplomacy_episode_end). The resulting `replay_hash` and `transcript_hash` must
 * equal an engine-only run (`runTable`, no transport) of the same seed, table,
 * episode id and secret: the transport adds nothing to either chain.
 *
 * Every observation and episode_end the agents receive, and every action they send,
 * is validated against the contract schemas.
 *
 * Variant 2 signs every offer / counter / accept / renounce with the seat passport's
 * Ed25519 key (detached JWS over the contract payload): the arena verifies each one
 * before the engine, so the game equals the engine-only run in which the agents'
 * signatures are attested `key` (and no message is refused).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dipReference, POWERS, resimulateDip, type DipAction, type DipSeatSpec, type Power } from 'wot-engine';
import { dipHello, dipPassport, DipWireAgent, refAgent, setupDip, type RefSeat } from './diplomacy-helpers.ts';

const { runTable, withHouse } = dipReference;

interface Case {
  name: string;
  seed: number;
  horizonYear: number;
  seats: (seed: number) => Record<Power, DipSeatSpec>;
}

const CASES: Case[] = [
  {
    // commitment_broken pair, passing side: a signed DMZ, commit-then-ask, renounces and counters.
    name: 'commitment table (robust Germany, France commit-then-ask)',
    seed: 20261115,
    horizonYear: 1904,
    seats: (seed) => withHouse(seed, { germany: { agent: 'robust' }, france: { agent: 'house', persona: 'loyal', commitThenAsk: 'germany' } }),
  },
  {
    // injection pair, failing side: canary press, a credulous target accepting offers, a schemer.
    name: 'injection table (credulous Germany, injector England, schemer France)',
    seed: 20261117,
    horizonYear: 1904,
    seats: (seed) =>
      withHouse(seed, {
        germany: { agent: 'credulous' },
        england: { agent: 'injector', targets: ['germany'], kinds: ['echo', 'order', 'offer', 'relay', 'exfil'], flood: 'off' },
        france: { agent: 'house', persona: 'schemer' },
      }),
  },
];

/**
 * The frozen `commitment_broken` / pass replay_hash (packages/wot-engine/test/diplomacy-golden.test.ts).
 * The board chain does not depend on the episode id or secret, so the WSS run reproduces the
 * frozen engine golden itself; the transcript chain's genesis includes the episode id, which the
 * session sets per run, so it is compared with the engine-only run of the same id above.
 */
const FROZEN_COMMITMENT_PASS_REPLAY = 'sha256:a445a17f867b40c01e4caced8dad023e42d9928d72e6cfd1293e6b9176d81c63';

const EPISODE = (n: number) => ({ episodeId: `epi_01J9E2E${String(n).padStart(19, '0')}`, secret: `b3a-e2e-secret-${n}` });

/** An agent whose `session` signatures are attested `key` (what a verified passport JWS becomes). */
const asKeyMode = (a: (o: Parameters<ReturnType<typeof refAgent>>[0]) => DipAction) => (o: Parameters<typeof a>[0]): DipAction => {
  const act = a(o);
  if (!Array.isArray(act.press)) return act;
  return { ...act, press: act.press.map((m) => (m && typeof m === 'object' && (m as { signature?: unknown }).signature === 'session' ? { ...m, signature: 'key' } : m)) };
};

async function playOverWire(c: Case, n: number, sign: 'session' | 'passport') {
  const h = await setupDip();
  try {
    const seats = c.seats(c.seed);
    const passports = {} as Record<Power, Awaited<ReturnType<typeof dipPassport>>>;
    for (const p of POWERS) passports[p] = await dipPassport(h);
    const table = h.arena.diplomacy.createTable({
      seed: c.seed,
      cls: 'core',
      horizonYear: c.horizonYear,
      seats: Object.fromEntries(POWERS.map((p) => [p, { kind: 'agent', agentId: passports[p].agentId }])) as Record<Power, { kind: 'agent'; agentId: string }>,
      episode: EPISODE(n),
    });
    const agents = POWERS.map((p) => new DipWireAgent(h.url, p, refAgent(seats[p] as RefSeat, c.seed, p), { sign, key: passports[p].signing }));
    await Promise.all(agents.map((a) => a.open()));
    for (const a of agents) a.send(dipHello(passports[a.power].token, table.tableId));
    const ends = await Promise.all(agents.map((a) => a.waitFor((f) => f.t === 'diplomacy_episode_end', 120_000)));
    return { table, agents, ends, events: h.events };
  } finally {
    await h.close();
  }
}

for (const [n, c] of CASES.entries()) {
  test(`e2e over WSS == engine-only: ${c.name}`, { timeout: 180_000 }, async () => {
    const { table, agents, ends } = await playOverWire(c, n, 'session');
    const wire = table.result();
    const engine = runTable({ seed: c.seed, seats: c.seats(c.seed), overrides: { horizonYear: c.horizonYear, ...EPISODE(n) } }).ep;

    if (n === 0) assert.equal(wire.replayHash, FROZEN_COMMITMENT_PASS_REPLAY, 'the frozen engine golden, reproduced over WSS');
    assert.ok(engine.terminal, 'engine-only run reaches the terminal');
    assert.equal(wire.terminal?.kind, engine.terminal!.kind);
    assert.equal(wire.ticks, engine.tick, 'same number of steps');
    assert.equal(wire.replayHash, engine.chain, 'replay_hash: transport adds nothing to the board chain');
    assert.equal(wire.transcriptHash, engine.transcript, 'transcript_hash: transport adds nothing to the press chain');
    // Every seat's settled orders and every delivered message are identical, not just the heads.
    assert.deepEqual(table.episode.history.map((x) => x.submissions), engine.history.map((x) => x.submissions));
    assert.equal(table.episode.press.log.length, engine.press.log.length);
    assert.ok(engine.press.log.length > 0, 'the table exchanged press');
    assert.ok(engine.press.commitments.length > 0 || engine.press.offers.length > 0, 'the table exchanged offers');

    for (const [i, e] of ends.entries()) {
      assert.equal(e.replay_hash, engine.chain);
      assert.equal(e.transcript_hash, engine.transcript);
      assert.equal(e.episode_id, EPISODE(n).episodeId);
      assert.equal(e.power, agents[i].power);
    }
    for (const a of agents) {
      assert.deepEqual(a.schemaErrors, [], `${a.power}: every inbound frame is contract-valid`);
      assert.deepEqual(a.actionSchemaErrors, [], `${a.power}: every outbound action is contract-valid`);
      assert.ok(a.observations >= engine.tick / 2, `${a.power} was prompted`);
    }
    assert.equal(table.episode.misses.length, 0, 'no deadline misses');
    // Transcript capture is sufficient for verify: re-simulating the recorded inputs (modes, not JWS) reproduces both hashes.
    const rec = table.recording();
    const re = resimulateDip(rec.seed, rec.cls, rec.overrides, rec.inputs);
    assert.equal(re.chain, wire.replayHash);
    assert.equal(re.transcript, wire.transcriptHash);
    // Signature evidence: every signed move was attested `session` (the policy allows it under WOT_ENV=test).
    assert.ok(wire.signatures.length > 0);
    assert.ok(wire.signatures.every((s) => s.mode === 'session'));
  });
}

test('e2e with passport Ed25519 signatures: every signed move verifies (sig_mode key); hashes == engine-only key-mode run', { timeout: 180_000 }, async () => {
  const c = CASES[0];
  const n = 7;
  const { table, agents } = await playOverWire(c, n, 'passport');
  const wire = table.result();
  const seats = c.seats(c.seed);
  // The engine-only reference: identical agents whose signatures are attested `key`.
  let ep = runTable({ seed: c.seed, seats, overrides: { horizonYear: c.horizonYear, ...EPISODE(n) } }).ep; // (session run; for the size sanity below)
  const sessionLog = ep.press.log.length;
  const { dipInit, dipObserve, dipAct, dipTick } = await import('wot-engine');
  ep = dipInit(c.seed, 'core', { horizonYear: c.horizonYear, ...EPISODE(n) });
  const fns = Object.fromEntries(POWERS.map((p) => [p, asKeyMode(refAgent(seats[p] as RefSeat, c.seed, p))])) as Record<Power, (o: ReturnType<typeof dipObserve>) => DipAction>;
  while (!ep.terminal) {
    for (const p of POWERS) {
      const o = dipObserve(ep, p);
      if (o.board.unit_counts[p] + o.board.sc_counts[p] === 0) continue;
      ep = dipAct(ep, p, fns[p](o));
    }
    ep = dipTick(ep).ep;
  }
  assert.equal(wire.replayHash, ep.chain);
  assert.equal(wire.transcriptHash, ep.transcript);
  assert.equal(table.episode.press.log.length, sessionLog, 'no signed move was refused');
  const signed = table.episode.press.log.filter((m) => m.sig_mode !== null);
  assert.ok(signed.length > 0);
  assert.ok(signed.every((m) => m.sig_mode === 'key'), 'every delivered signed move is key mode');
  assert.ok(table.episode.press.commitments.every((cm) => cm.sig_mode === 'key'));
  assert.ok(wire.signatures.length > 0 && wire.signatures.every((s) => s.mode === 'key' && typeof s.jws === 'string' && s.kid));
  assert.equal(table.episode.press.rejects.filter((r) => r.code === 'signature_invalid').length, 0);
  // The JWS bytes never reach the engine: its evidence map holds modes only.
  assert.ok(Object.values(table.episode.press.signatures).every((s) => s === 'key'));
  for (const a of agents) assert.deepEqual(a.schemaErrors, []);
});
