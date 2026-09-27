/**
 * Phase 9 hosted-beta hardening: chaos test of the Diplomacy table session
 * (asyncapi `diplomacy_table`, errors.md "Diplomacy table session", threat-model-arena §5,
 * MISSION Phase 5 chaos style). Evidence: docs/phase-9/CHAOS-DIPLOMACY.md.
 *
 *  1. load: 10 tables x 7 seats over ONE in-process WSS server to the 1904 horizon; every
 *     table's replay/transcript hash == the engine-only run of the same table;
 *  2. seat flapping: supersession mid-round and mid-orders, a disconnect during adjudication,
 *     a hard miss while disconnected and one while connected; hashes == the engine-only run
 *     with the recorded misses, and two runs agree bit for bit;
 *  3. malicious frames from one seat: every reject / close code of the contract, a press flood
 *     beyond quota, a forged JWS, a renounce of an ended commitment; the other six seats are
 *     untouched and the table equals the engine-only run with the attacker's accepted frames;
 *  4. slow seat: soft miss, three hard misses, forfeit, civil disorder, the table completes;
 *  5. restart between phases: there is no Diplomacy recovery path (N-A); what IS true is
 *     asserted (1012, no invented result, 4403 afterwards, the recording re-simulates);
 *  6. key rotation mid-table as a smoke check on a full seven-seat passport-signed table.
 *
 * The defects this suite found (D-1 schema_invalid escalation, D-2 ended-table retention,
 * D-3 double-scheduled step resolve: case 3's duplicate frame, when it landed in the same I/O
 * turn as the completing frame, closed the NEXT step with no answers, so the flood tick was
 * all hard misses; load-dependent here, deterministic in diplomacy-resolve-once.test.ts)
 * are fixed in service code; their probes are now ordinary passing tests. Seat-arrival
 * deadline and result-sink coverage: diplomacy-lifecycle.test.ts. Every scenario prints one
 * `CHAOS {...}` line with its numbers.
 *
 * Run: cd ascension && WOT_ENV=test node --test --import tsx services/arena/test/diplomacy-chaos.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Ed25519PrivateJwk, PassportSigningKey } from 'wot-auth';
import { dipCommitmentEnded, dipReference, POWERS, resimulateDip, type DipAction, type DipEpisode, type DipSeatSpec as EngineSeatSpec, type Power } from 'wot-engine';
import { engineIdToWire, fromWireAction, type SigAttestation } from '../src/diplomacy/wire.ts';
import type { DiplomacyTable } from '../src/diplomacy/table.ts';
import type { TableLookup } from '../src/diplomacy/lobby.ts';
import { memoryResultSink } from '../src/diplomacy/results.ts';
import { MAX_SCHEMA_INVALID } from '../src/config.ts';
import { dipPassport, refAgent, signingKeyFromRegistration, type DipPassport, type RefSeat } from './diplomacy-helpers.ts';
import { ChaosSeat, chaosSetup, engineMirror, MemSampler, missMap, record, settledHeap, sleep, type ChaosHarness, type Frame, type SeatConn, type WireOverride } from './chaos-helpers.ts';

const { runTable, withHouse } = dipReference;

type Seats = Record<Power, EngineSeatSpec>;
const EPISODE = (n: number) => ({ episodeId: `epi_01J9CHA0S${String(n).padStart(17, '0')}`, secret: `chaos-secret-${n}` });

const SHAPES: Array<{ name: string; seats: (seed: number) => Seats }> = [
  { name: 'commitment', seats: (s) => withHouse(s, { germany: { agent: 'robust' }, france: { agent: 'house', persona: 'loyal', commitThenAsk: 'germany' } }) },
  {
    name: 'injection',
    seats: (s) =>
      withHouse(s, {
        germany: { agent: 'credulous' },
        england: { agent: 'injector', targets: ['germany'], kinds: ['echo', 'order', 'offer', 'relay', 'exfil'], flood: 'off' },
        france: { agent: 'house', persona: 'schemer' },
      }),
  },
  { name: 'house-one-schemer', seats: (s) => withHouse(s, {}, {}, 'one') },
  { name: 'robust-credulous', seats: (s) => withHouse(s, { germany: { agent: 'robust' }, italy: { agent: 'credulous' }, turkey: { agent: 'robust' } }) },
  { name: 'flooding-injector', seats: (s) => withHouse(s, { austria: { agent: 'credulous' }, russia: { agent: 'injector', targets: ['austria', 'turkey'], kinds: ['echo', 'offer'], flood: 'every4' } }) },
];

const agentsFor = (seats: Seats, seed: number): Record<Power, (o: Parameters<ReturnType<typeof refAgent>>[0]) => DipAction> =>
  Object.fromEntries(POWERS.map((p) => [p, refAgent(seats[p] as RefSeat, seed, p)])) as Record<Power, (o: Parameters<ReturnType<typeof refAgent>>[0]) => DipAction>;

interface Live {
  table: DiplomacyTable;
  seats: Record<Power, ChaosSeat>;
  passports: Record<Power, DipPassport>;
}

/** Create a seven-agent table and a ChaosSeat per power (not yet connected). */
async function liveTable(h: ChaosHarness, o: { seed: number; seats: Seats; horizonYear: number; n: number; sign?: 'session' | 'passport'; overrides?: Partial<Record<Power, Map<number, WireOverride>>> }): Promise<Live> {
  const passports = {} as Record<Power, DipPassport>;
  for (const p of POWERS) passports[p] = await dipPassport(h);
  const table = h.arena.diplomacy.createTable({
    seed: o.seed,
    cls: 'core',
    horizonYear: o.horizonYear,
    seats: Object.fromEntries(POWERS.map((p) => [p, { kind: 'agent', agentId: passports[p].agentId }])) as Record<Power, { kind: 'agent'; agentId: string }>,
    episode: EPISODE(o.n),
  });
  const seats = Object.fromEntries(
    POWERS.map((p) => [
      p,
      new ChaosSeat(h.url, p, refAgent(o.seats[p] as RefSeat, o.seed, p), {
        token: passports[p].token,
        tableId: table.tableId,
        sign: o.sign ?? 'session',
        key: passports[p].signing,
        ...(o.overrides?.[p] ? { overrides: o.overrides[p] } : {}),
      }),
    ]),
  ) as Record<Power, ChaosSeat>;
  return { table, seats, passports };
}

const ends = (live: Live, ms = 180_000) => Promise.all(POWERS.map((p) => live.seats[p].waitFor((f) => f.t === 'diplomacy_episode_end', ms)));

/** The hashes and per-seat invariants every scenario checks against its engine-only run. */
function assertEqualsEngine(live: Live, engine: DipEpisode, endFrames: Frame[], label: string): void {
  const wire = live.table.result();
  assert.ok(engine.terminal, `${label}: engine-only run is terminal`);
  assert.equal(wire.terminal?.kind, engine.terminal!.kind, `${label}: terminal kind`);
  assert.equal(wire.ticks, engine.tick, `${label}: ticks`);
  assert.equal(wire.replayHash, engine.chain, `${label}: replay_hash == engine-only`);
  assert.equal(wire.transcriptHash, engine.transcript, `${label}: transcript_hash == engine-only`);
  assert.deepEqual(live.table.episode.history.map((x) => x.submissions), engine.history.map((x) => x.submissions), `${label}: settled orders`);
  for (const e of endFrames) {
    assert.equal(e.replay_hash, engine.chain, `${label}: ${String(e.power)} episode_end replay_hash`);
    assert.equal(e.transcript_hash, engine.transcript, `${label}: ${String(e.power)} episode_end transcript_hash`);
  }
  // verify path: the recorded inputs alone reproduce both heads.
  const rec = live.table.recording();
  const re = resimulateDip(rec.seed, rec.cls, rec.overrides, rec.inputs);
  assert.equal(re.chain, wire.replayHash, `${label}: resimulated replay_hash`);
  assert.equal(re.transcript, wire.transcriptHash, `${label}: resimulated transcript_hash`);
}

// =====================================================================================
// 1. Load: 10 tables x 7 seats over one WSS server
// =====================================================================================

test('1. load: 10 concurrent tables x 7 seats on one WSS server to 1904; every table == its engine-only run', { timeout: 900_000 }, async () => {
  const TABLES = 10;
  const HORIZON = 1904;
  const h = await chaosSetup({ quietLog: true });
  try {
    const specs = Array.from({ length: TABLES }, (_, i) => {
      const shape = SHAPES[i % SHAPES.length];
      const seed = 20261115 + 101 * i;
      return { i, seed, shape: shape.name, seats: shape.seats(seed) };
    });
    // Engine-only baseline (sequential, no transport) for the wall-clock comparison.
    const tE = performance.now();
    const engines = specs.map((s) => runTable({ seed: s.seed, seats: s.seats, overrides: { horizonYear: HORIZON, ...EPISODE(100 + s.i) } }).ep);
    const engineMs = Math.round(performance.now() - tE);

    const lives: Live[] = [];
    for (const s of specs) lives.push(await liveTable(h, { seed: s.seed, seats: s.seats, horizonYear: HORIZON, n: 100 + s.i }));
    const mem = new MemSampler();
    const t0 = performance.now();
    // All 70 connections at once.
    await Promise.all(lives.flatMap((l) => POWERS.map((p) => l.seats[p].connect())));
    const endFrames = await Promise.all(lives.map((l) => ends(l, 600_000)));
    const wallMs = Math.round(performance.now() - t0);
    const m = mem.stop();

    const perTable = [];
    for (const [i, l] of lives.entries()) {
      assertEqualsEngine(l, engines[i], endFrames[i], `table ${i} (${specs[i].shape}, seed ${specs[i].seed})`);
      assert.equal(l.table.episode.misses.length, 0, `table ${i}: no deadline miss under load`);
      for (const p of POWERS) {
        const s = l.seats[p];
        assert.deepEqual(s.schemaErrors, [], `table ${i} ${p}: inbound frames contract-valid`);
        assert.deepEqual(s.actionSchemaErrors, [], `table ${i} ${p}: outbound frames contract-valid`);
        assert.equal(s.of('reject').length, 0, `table ${i} ${p}: no reject`);
        assert.equal(s.conns.length, 1);
        await s.conns[0].closed;
        assert.equal(s.conns[0].closeInfo?.code, 1000, `table ${i} ${p}: closed 1000 after episode_end`);
      }
      perTable.push({ table: i, shape: specs[i].shape, seed: specs[i].seed, ticks: l.table.episode.tick, press: l.table.episode.press.log.length, replay: l.table.result().replayHash.slice(7, 19) });
    }
    const frames = lives.reduce((n, l) => n + POWERS.reduce((k, p) => k + l.seats[p].all.length, 0), 0);
    record('1-load', { tables: TABLES, seats: TABLES * 7, horizon: HORIZON, wallMs, engineOnlySequentialMs: engineMs, framesToClients: frames, ...m, perTable });
  } finally {
    await h.close();
  }
});

// =====================================================================================
// 2. Seat flapping (supersession / disconnect / reconnect)
// =====================================================================================

const stepKey = (f: Frame): string => {
  const s = f.step as { kind: string; round?: number };
  return `${String(f.phase)}:${s.kind}:${s.kind === 'press' ? s.round : 0}`;
};

async function flappingRun(n: number) {
  const SOFT = 1000;
  const HARD = 1600;
  const seed = 20261115;
  const seatsSpec = SHAPES[0].seats(seed);
  const h = await chaosSetup({ softMs: SOFT, hardMs: HARD, quietLog: true });
  try {
    const live = await liveTable(h, { seed, seats: seatsSpec, horizonYear: 1904, n });
    const F: Power = 'england';
    const seat = live.seats[F];
    const at: Record<string, number> = {};
    const handled = new Set<number>();
    const hold = new Set<number>();
    seat.policy = async (f, conn, s) => {
      const turn = f.turn_id as number;
      if (handled.has(turn)) {
        if (!hold.has(turn)) s.answer(f, conn);
        return;
      }
      handled.add(turn);
      switch (stepKey(f)) {
        case 'S1901M:press:2': // E1 supersession mid-round, BEFORE answering: the new session gets the same prompt
          at.E1_supersede_mid_round = turn;
          await s.connect();
          return;
        case 'S1901M:orders:0': // E2 answer the orders, then supersede at once
          at.E2_supersede_mid_orders = turn;
          s.answer(f, conn);
          await s.connect();
          return;
        case 'F1901M:orders:0': // E3 answer, drop the socket while the step adjudicates, reconnect
          at.E3_disconnect_during_adjudication = turn;
          s.answer(f, conn);
          conn.ws.close();
          await conn.closed;
          await s.connect();
          return;
        case 'S1902M:intent:0': // E4 drop the socket without answering; reconnect after Dh (hard miss while away)
          at.E4_hard_miss_disconnected = turn;
          hold.add(turn);
          conn.ws.close();
          await conn.closed;
          await sleep(HARD + 300);
          await s.connect();
          return;
        case 'F1902M:press:1': // E5 stay connected, never answer this step (hard miss while connected)
          at.E5_hard_miss_connected = turn;
          hold.add(turn);
          return;
        case 'S1903M:orders:0': // E6 silent on an ORDERS step: England's units hold by default (the board diverges)
          at.E6_hard_miss_orders = turn;
          hold.add(turn);
          return;
        default:
          s.answer(f, conn);
      }
    };
    const t0 = performance.now();
    await Promise.all(POWERS.map((p) => live.seats[p].connect()));
    const endFrames = await ends(live, 120_000);
    const wallMs = Math.round(performance.now() - t0);
    return { live, at, endFrames, wallMs, seatsSpec, seed, F };
  } finally {
    await h.close();
  }
}

test('2. seat flapping: supersession mid-round / mid-orders, disconnect during adjudication, hard misses; deterministic given the recorded misses', { timeout: 300_000 }, async () => {
  const runs = [await flappingRun(200), await flappingRun(200)];
  for (const [r, { live, at, endFrames, seatsSpec, seed, F }] of runs.entries()) {
    const seat = live.seats[F];
    // Every event fired, in game order, exactly once.
    assert.deepEqual(Object.keys(at), ['E1_supersede_mid_round', 'E2_supersede_mid_orders', 'E3_disconnect_during_adjudication', 'E4_hard_miss_disconnected', 'E5_hard_miss_connected', 'E6_hard_miss_orders'], `run ${r}`);
    // Connection history: two supersessions (4409), two client drops, the last session ends 1000.
    assert.equal(seat.conns.length, 5, `run ${r}: five sessions`);
    for (const c of seat.conns) await c.closed;
    assert.deepEqual(seat.conns.map((c) => c.closeInfo?.code), [4409, 4409, 1005, 1005, 1000], `run ${r}: close codes`);
    for (const i of [0, 1]) {
      const sup = seat.conns[i].frames.find((f) => f.t === 'session_superseded');
      const nextAck = seat.conns[i + 1].frames.find((f) => f.t === 'ack' && f.ack_type === 'session');
      assert.ok(sup && nextAck, `run ${r}: session ${i} got session_superseded`);
      assert.equal(sup.superseded_by, nextAck.session_id, `run ${r}: superseded_by names the new session`);
    }
    // E1: the new session received the SAME prompt (turn and nonce) and answered it; the old one never did.
    const e1old = seat.conns[0].frames.find((f) => f.t === 'diplomacy_observation' && f.turn_id === at.E1_supersede_mid_round)!;
    const e1new = seat.conns[1].frames.find((f) => f.t === 'diplomacy_observation' && f.turn_id === at.E1_supersede_mid_round)!;
    assert.equal(e1new.nonce, e1old.nonce, `run ${r}: re-sent prompt keeps its nonce`);
    assert.ok(seat.conns[1].frames.some((f) => f.t === 'ack' && f.ack_type === 'action' && f.turn_id === at.E1_supersede_mid_round));
    // Recorded misses: exactly the two holds, nothing from the supersessions or the drop during adjudication.
    assert.deepEqual(
      live.table.episode.misses.map((m) => [m.tick, m.power, m.step, m.severity]),
      [
        [at.E4_hard_miss_disconnected, F, 'intent', 'hard'],
        [at.E5_hard_miss_connected, F, 'press', 'hard'],
        [at.E6_hard_miss_orders, F, 'orders', 'hard'],
      ],
      `run ${r}: recorded misses`,
    );
    assert.deepEqual(live.table.episode.forfeited, [], `run ${r}: non-consecutive misses do not forfeit`);
    for (const p of POWERS) if (p !== F) assert.equal(live.seats[p].of('reject').length, 0, `run ${r}: ${p} unaffected`);
    for (const p of POWERS) assert.deepEqual([...live.seats[p].schemaErrors, ...live.seats[p].actionSchemaErrors], [], `run ${r}: ${p} frames contract-valid`);
    // The engine-only run of the same table with the same misses.
    const engine = engineMirror({ seed, overrides: { horizonYear: 1904, ...EPISODE(200) }, agents: agentsFor(seatsSpec, seed), misses: missMap(live.table.episode.misses) });
    assertEqualsEngine(live, engine, endFrames, `flapping run ${r}`);
    // The misses matter (not a vacuous comparison): without them the game differs.
    const noMiss = engineMirror({ seed, overrides: { horizonYear: 1904, ...EPISODE(200) }, agents: agentsFor(seatsSpec, seed) });
    assert.notEqual(noMiss.transcript, engine.transcript, 'the recorded misses change the transcript');
    assert.notEqual(noMiss.chain, engine.chain, 'the orders-step miss changes the board chain');
  }
  // Bit-for-bit across two independent runs (fresh server, fresh passports, fresh nonces).
  const [a, b] = runs.map((x) => x.live.table.result());
  assert.equal(a.replayHash, b.replayHash);
  assert.equal(a.transcriptHash, b.transcriptHash);
  record('2-flapping', { runs: 2, wallMs: runs.map((x) => x.wallMs), events: runs[0].at, misses: runs[0].live.table.episode.misses.length, sessions: runs[0].live.seats.england.conns.length, closeCodes: runs[0].live.seats.england.conns.map((c) => c.closeInfo?.code), replay: a.replayHash.slice(7, 19), transcript: a.transcriptHash.slice(7, 19) });
});

// =====================================================================================
// 3. Malicious frames from one seat
// =====================================================================================

const DMZ = (phase: string) => ({
  give: [{ kind: 'no_enter', from_phase: phase, to_phase: phase, provinces: ['bur'] }],
  want: [{ kind: 'no_enter', from_phase: phase, to_phase: phase, provinces: ['bur'] }],
});

test('3. malicious seat: every reject / close code, flood beyond quota, forged JWS, renounce of an ended commitment; the other six seats are untouched', { timeout: 300_000 }, async () => {
  const SOFT = 4000;
  const HARD = 6000;
  const seed = 20261115;
  const n = 300;
  const A: Power = 'germany';
  const seatsSpec = SHAPES[0].seats(seed);

  // Pass 1 (engine only): decide the attacker's accepted overrides on the engine's own state.
  type Plan = { label: string; press: Record<string, unknown>[]; sigs: Array<'session' | 'forged' | undefined> };
  const plans = new Map<number, Plan>();
  let flooded = false;
  let forged = false;
  const override = (ep: DipEpisode, p: Power): DipAction | undefined => {
    if (p !== A || ep.step.kind !== 'press') return undefined;
    let plan: Plan | undefined;
    if (!flooded) {
      flooded = true;
      plan = { label: 'flood', press: Array.from({ length: 12 }, (_, i) => ({ move: 'press', to: { kind: 'private', power: 'austria' }, body: `chaos flood ${i + 1}` })), sigs: Array(12).fill(undefined) };
    } else if (!forged) {
      const c = ep.press.commitments.find((x) => x.parties.includes(A) && dipCommitmentEnded(x) && !x.renounced);
      if (c) {
        forged = true;
        const peer = c.parties[0] === A ? c.parties[1] : c.parties[0];
        plan = {
          label: 'forged+renounce',
          press: [
            { move: 'offer', to: { kind: 'private', power: peer }, terms: DMZ(ep.step.phaseId) },
            { move: 'renounce', to: { kind: 'private', power: peer }, respond_to: engineIdToWire(c.id) },
          ],
          sigs: ['forged', 'session'],
        };
      }
    }
    if (!plan) return undefined;
    plans.set(ep.tick, plan);
    const attest = plan.sigs.map((s) => (s === 'forged' ? 'unverified' : s)) as SigAttestation[];
    return fromWireAction({ press: plan.press }, ep.step.phaseId, attest).action;
  };
  const engine = engineMirror({ seed, overrides: { horizonYear: 1904, ...EPISODE(n) }, agents: agentsFor(seatsSpec, seed), override });
  assert.deepEqual([...plans.values()].map((p) => p.label), ['flood', 'forged+renounce']);

  const h = await chaosSetup({ softMs: SOFT, hardMs: HARD, quietLog: true });
  try {
    const stranger = (await dipPassport(h)).signing!;
    const wireOverrides = new Map<number, WireOverride>(
      [...plans].map(([tick, p]) => [tick, { press: p.press, sign: p.sigs.map((s) => (s === 'forged' ? stranger : s)) as WireOverride['sign'] }]),
    );
    const live = await liveTable(h, { seed, seats: seatsSpec, horizonYear: 1904, n, overrides: { [A]: wireOverrides } });
    const seat = live.seats[A];
    const at: Record<string, number> = {};
    const handled = new Set<number>();
    const reconnectAndAnswer = async (conn: SeatConn) => {
      await conn.closed;
      await seat.connect();
    };
    seat.policy = async (f, conn, s) => {
      const turn = f.turn_id as number;
      if (handled.has(turn)) return s.answer(f, conn);
      handled.add(turn);
      const real = s.actionFrame(f);
      switch (stepKey(f)) {
        case 'S1901M:intent:0': // the same accepted frame twice: both acked, latest-only (idempotent)
          at.duplicate = turn;
          s.answer(f, conn);
          s.answer(f, conn);
          return;
        case 'S1901M:orders:0': {
          at.rejects = turn;
          const prev = s.sentByTurn.get(turn - 1)!;
          for (const bad of [
            { ...real, nonce: 'n_000000000000000000000000' },
            { ...real, episode_id: 'epi_01J9ZZZZZZZZZZZZZZZZZZZZZZ' },
            { ...real, power: 'austria' },
            { ...real, turn_id: turn + 7 },
            prev, // replay of the previous step's accepted frame, verbatim
            { ...real, admin: true },
            { ...real, junk: 'J'.repeat(11_800) }, // 8193..16384 bytes and schema-invalid
            { t: 'diplomacy_action' },
          ]) s.send(conn, bad);
          s.answer(f, conn, 12_000); // the real answer padded to 12000 bytes: within the 16384 cap, accepted
          return;
        }
        case 'F1901M:intent:0': // one frame over 16384 bytes: ws closes 1009 before any app check
          at.close1009 = turn;
          s.sendRaw(conn, JSON.stringify({ ...real, junk: 'K'.repeat(20_000) }));
          return reconnectAndAnswer(conn);
        case 'F1901M:press:2': // frame flood: rate_limited, then 4429
          at.close4429 = turn;
          for (let i = 0; i < 60; i++) s.send(conn, { ...real, nonce: `n_flood${String(i).padStart(18, '0')}` });
          return reconnectAndAnswer(conn);
        case 'F1901M:orders:0': // unparseable: reject + 4400
          at.close4400 = turn;
          s.sendRaw(conn, '{"t":"diplomacy_action",');
          return reconnectAndAnswer(conn);
        default:
          s.answer(f, conn);
      }
    };
    const t0 = performance.now();
    await Promise.all(POWERS.map((p) => live.seats[p].connect()));
    const endFrames = await ends(live, 120_000);
    const wallMs = Math.round(performance.now() - t0);
    for (const c of seat.conns) await c.closed;

    // --- the attacker's view of every refusal ---
    const c0 = seat.conns[0];
    const acksFor = (c: SeatConn, turn: number) => c.frames.filter((f) => f.t === 'ack' && f.ack_type === 'action' && f.turn_id === turn).length;
    assert.equal(acksFor(c0, at.duplicate), 2, 'a duplicate accepted frame is acked twice (latest-only)');
    const iObs = c0.frames.findIndex((f) => f.t === 'diplomacy_observation' && f.turn_id === at.rejects);
    const after = c0.frames.slice(iObs + 1);
    const iAck = after.findIndex((f) => f.t === 'ack' && f.ack_type === 'action');
    assert.deepEqual(
      after.slice(0, iAck).filter((f) => f.t === 'reject').map((f) => [f.reason, f.retryable]),
      [
        ['bad_echo', true], // wrong nonce
        ['bad_echo', true], // wrong episode_id
        ['not_your_seat', false], // wrong power echo
        ['stale_turn', false], // wrong turn
        ['stale_turn', false], // replayed previous action
        ['schema_invalid', true], // unknown field
        ['schema_invalid', true], // 11.8 KB garbage field
        ['schema_invalid', true], // missing required fields
      ],
    );
    assert.equal(after[iAck].turn_id, at.rejects, 'the 12000-byte real answer is accepted');
    // Close paths: 1009 (no reject precedes it), 4429 after rate_limited rejects, 4400 after `unparseable`.
    assert.deepEqual(seat.conns.map((c) => c.closeInfo?.code), [1009, 4429, 4400, 1000]);
    assert.equal(seat.conns[1].frames.filter((f) => f.t === 'reject' && f.reason === 'rate_limited').length > 0, true);
    assert.ok(seat.conns[2].frames.some((f) => f.t === 'reject' && f.reason === 'unparseable'));
    for (const i of [0, 1, 2]) {
      const turn = [at.close1009, at.close4429, at.close4400][i];
      assert.ok(acksFor(seat.conns[i + 1], turn) >= 1, `after close ${i}, the reconnected seat answered turn ${turn} (same prompt re-sent)`);
    }
    // Press flood beyond quota and the forged / ended-commitment batch, reported in the next observation only.
    const [floodTick, forgeTick] = [...plans.keys()];
    const obsAfter = (tick: number) => seat.all.find((f) => f.t === 'diplomacy_observation' && f.turn_id === tick + 1)!;
    const fl = obsAfter(floodTick);
    assert.deepEqual((fl.press_rejects as Frame[]).map((r) => [r.msg_index, r.code]), [6, 7, 8, 9, 10, 11].map((i) => [i, 'press_quota']));
    assert.equal((fl.sent as Frame[]).length, 6, 'six of twelve flood messages delivered (core quota)');
    const au = live.seats.austria.all.find((f) => f.t === 'diplomacy_observation' && f.turn_id === floodTick + 1)!;
    assert.equal((au.inbox as Frame[]).filter((m) => m.from === A && String(m.body).startsWith('chaos flood')).length, 6);
    const fg = obsAfter(forgeTick);
    assert.deepEqual((fg.press_rejects as Frame[]).map((r) => [r.msg_index, r.code]), [[0, 'signature_invalid'], [1, 'commitment_unknown']]);
    assert.deepEqual(live.table.signatures.filter((s) => s.power === A && s.tick === forgeTick).map((s) => [s.index, s.mode, s.reason ?? null]), [[0, 'rejected', 'kid_mismatch'], [1, 'session', null]]);

    // --- nobody else noticed ---
    assert.equal(live.table.episode.misses.length, 0, 'no deadline miss anywhere (reconnects land inside Ds)');
    for (const p of POWERS) {
      assert.deepEqual([...live.seats[p].schemaErrors, ...live.seats[p].actionSchemaErrors], [], `${p} frames contract-valid`);
      if (p === A) continue;
      const s: ChaosSeat = live.seats[p];
      assert.equal(s.of('reject').length, 0, `${p}: no reject`);
      assert.equal(s.conns.length, 1, `${p}: one session`);
      assert.equal(s.conns[0].closeInfo?.code, 1000, `${p}: closed 1000`);
      const blob = JSON.stringify(s.all);
      assert.ok(!blob.includes('JJJJJJJJ') && !blob.includes('KKKKKKKK') && !blob.includes('n_flood'), `${p}: no attacker bytes relayed`);
    }
    assertEqualsEngine(live, engine, endFrames, 'malicious seat');
    record('3-malicious', { wallMs, events: at, plans: Object.fromEntries([...plans].map(([t, p]) => [t, p.label])), attackerSessions: seat.conns.length, closeCodes: seat.conns.map((c) => c.closeInfo?.code), rateLimitedRejects: seat.conns[1].frames.filter((f) => f.reason === 'rate_limited').length, replay: engine.chain.slice(7, 19) });
  } finally {
    await h.close();
  }
});

// =====================================================================================
// 4. Slow seat
// =====================================================================================

test('4. slow seat: late answer = soft miss, then silence: three hard misses, forfeit, civil disorder; the table completes', { timeout: 300_000 }, async () => {
  const SOFT = 1000;
  const HARD = 1500;
  const seed = 20261117;
  const n = 400;
  const S: Power = 'russia';
  const seatsSpec = SHAPES[1].seats(seed);
  const h = await chaosSetup({ softMs: SOFT, hardMs: HARD, quietLog: true });
  try {
    const live = await liveTable(h, { seed, seats: seatsSpec, horizonYear: 1904, n });
    live.seats[S].policy = async (f, conn, s) => {
      if (f.turn_id !== 0) return; // never answers again
      await sleep(SOFT + 250);
      s.answer(f, conn);
    };
    const t0 = performance.now();
    await Promise.all(POWERS.map((p) => live.seats[p].connect()));
    const endFrames = await ends(live, 120_000);
    const wallMs = Math.round(performance.now() - t0);
    const ep = live.table.episode;
    assert.deepEqual(ep.misses.map((m) => [m.tick, m.power, m.severity]), [
      [0, S, 'soft'],
      [1, S, 'hard'],
      [2, S, 'hard'],
      [3, S, 'hard'],
    ]);
    assert.deepEqual(ep.forfeited, [{ power: S, tick: 3 }]);
    assert.deepEqual(live.seats[S].observedTurns, [0, 1, 2, 3], 'a forfeited seat is never prompted again');
    const endS = endFrames[POWERS.indexOf(S)];
    assert.equal(endS.outcome, 'forfeit');
    for (const e of endFrames) assert.deepEqual(e.civil_disorder, [S], `${String(e.power)} sees russia in civil disorder`);
    await live.seats[S].conns[0].closed;
    assert.equal(live.seats[S].conns[0].closeInfo?.code, 1000, 'the silent seat still gets episode_end and 1000');
    for (const p of POWERS) if (p !== S) assert.equal(live.seats[p].of('reject').length, 0);
    const engine = engineMirror({ seed, overrides: { horizonYear: 1904, ...EPISODE(n) }, agents: agentsFor(seatsSpec, seed), misses: missMap(ep.misses) });
    assertEqualsEngine(live, engine, endFrames, 'slow seat');
    record('4-slow-seat', { wallMs, ticks: ep.tick, misses: ep.misses.map((m) => `${m.tick}:${m.severity}`), forfeitTick: 3, terminal: ep.terminal?.kind, replay: engine.chain.slice(7, 19) });
  } finally {
    await h.close();
  }
});

// =====================================================================================
// 5. Restart between phases
// =====================================================================================

test('5. restart between phases: N-A (no Diplomacy recovery path); seats close 1012, nothing is invented, the table is gone, the recording re-simulates', { timeout: 300_000 }, async () => {
  const seed = 20261115;
  const n = 500;
  const STOP = 10; // F1901M orders is tick 9; tick 10 is the step after the first autumn adjudication
  const seatsSpec = SHAPES[0].seats(seed);
  const h = await chaosSetup({ quietLog: true });
  try {
    const live = await liveTable(h, { seed, seats: seatsSpec, horizonYear: 1904, n });
    for (const p of POWERS) {
      live.seats[p].policy = (f, conn, s) => {
        if ((f.turn_id as number) < STOP) s.answer(f, conn);
      };
    }
    await Promise.all(POWERS.map((p) => live.seats[p].connect()));
    await Promise.all(POWERS.map((p) => live.seats[p].waitFor((f) => f.t === 'diplomacy_observation' && f.turn_id === STOP, 60_000)));
    const pre = { tick: live.table.episode.tick, chain: live.table.episode.chain, transcript: live.table.episode.transcript, rec: live.table.recording() };
    assert.equal(pre.tick, STOP);

    const report = await h.restart({ recover: true });
    const recovery = await report.ready;
    for (const p of POWERS) {
      const c = live.seats[p].conns[0];
      await c.closed;
      assert.equal(c.closeInfo?.code, 1012, `${p}: arena shutdown closes 1012`);
      assert.equal(live.seats[p].of('diplomacy_episode_end').length, 0, `${p}: no episode_end is invented`);
    }
    assert.equal(live.table.isEnded, true);
    assert.equal(live.table.result().terminal, null, 'no terminal, no winner recorded for the interrupted table');
    assert.equal(recovery?.scanned ?? 0, 0, 'the boot recovery scan has no Diplomacy manifest to reconcile');
    assert.equal(h.arena.diplomacy.getTable(live.table.tableId), undefined, 'the table does not survive the restart');
    // A seat that reconnects to its table after the restart is refused exactly like an unknown table.
    const again = await live.seats.france.connect();
    assert.equal((await again.closed).code, 4403);

    // What a recovery would rebuild from: the recorded inputs re-simulate to the pre-restart heads,
    // which equal the engine-only run of the same table stopped at the same tick.
    const re = resimulateDip(pre.rec.seed, pre.rec.cls, pre.rec.overrides, pre.rec.inputs);
    assert.equal(re.tick, STOP);
    assert.equal(re.chain, pre.chain);
    assert.equal(re.transcript, pre.transcript);
    const prefix = engineMirror({ seed, overrides: { horizonYear: 1904, ...EPISODE(n) }, agents: agentsFor(seatsSpec, seed), untilTick: STOP });
    assert.equal(prefix.chain, pre.chain);
    assert.equal(prefix.transcript, pre.transcript);
    record('5-restart', { result: 'N-A', stoppedAtTick: STOP, closeCode: 1012, rehello: 4403, recoveryScanned: recovery?.scanned ?? 0, recordingResimulates: true, inputsRecorded: pre.rec.inputs.length });
  } finally {
    await h.close();
  }
});

// =====================================================================================
// 6. Key rotation mid-table (smoke; B3d on a full seven-seat table)
// =====================================================================================

test('6. key rotation mid-table (smoke): seven passport-signed seats, one rotates between steps without reconnecting; zero refusals, hashes == engine key-mode run', { timeout: 300_000 }, async () => {
  const seed = 20261115;
  const n = 600;
  const R: Power = 'germany';
  const seatsSpec = SHAPES[0].seats(seed);
  const h = await chaosSetup({ quietLog: true });
  try {
    const live = await liveTable(h, { seed, seats: seatsSpec, horizonYear: 1904, n, sign: 'passport' });
    const oldKey = live.passports[R].signing!;
    let newKey: PassportSigningKey | null = null;
    let rotatedAt = -1;
    live.seats[R].policy = async (f, conn, s) => {
      if (rotatedAt < 0 && stepKey(f) === 'S1902M:press:1') {
        rotatedAt = f.turn_id as number;
        const rot = await fetch(`${h.httpUrl}/v1/agents/${live.passports[R].clientId}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${live.passports[R].ownerBearer}` } });
        assert.equal(rot.status, 200);
        newKey = signingKeyFromRegistration(((await rot.json()) as { signing_key: Ed25519PrivateJwk }).signing_key);
        s.key = newKey;
      }
      s.answer(f, conn);
    };
    await Promise.all(POWERS.map((p) => live.seats[p].connect()));
    const endFrames = await ends(live, 120_000);
    assert.ok(newKey && rotatedAt > 0);
    const asKey = (a: DipAction): DipAction =>
      Array.isArray(a.press) ? { ...a, press: a.press.map((m) => (m && typeof m === 'object' && (m as { signature?: unknown }).signature === 'session' ? { ...m, signature: 'key' } : m)) } : a;
    const base = agentsFor(seatsSpec, seed);
    const agents = Object.fromEntries(POWERS.map((p) => [p, (o: Parameters<(typeof base)[Power]>[0]) => asKey(base[p](o))])) as typeof base;
    const engine = engineMirror({ seed, overrides: { horizonYear: 1904, ...EPISODE(n) }, agents });
    assertEqualsEngine(live, engine, endFrames, 'rotation');
    const ep = live.table.episode;
    assert.equal(ep.press.rejects.filter((r) => r.code === 'signature_invalid').length, 0, 'no signed move refused');
    const ev = live.table.signatures.filter((s) => s.power === R);
    const before = ev.filter((s) => s.tick < rotatedAt);
    const afterRot = ev.filter((s) => s.tick >= rotatedAt);
    assert.ok(before.length > 0 && afterRot.length > 0, 'the rotating seat signed before and after');
    assert.ok(before.every((s) => s.mode === 'key' && s.kid === oldKey.jkt));
    assert.ok(afterRot.every((s) => s.mode === 'key' && s.kid === newKey!.jkt));
    assert.equal(live.seats[R].conns.length, 1, 'no reconnect');
    assert.equal(ep.misses.length, 0);
    record('6-rotation', { rotatedAtTick: rotatedAt, signedBefore: before.length, signedAfter: afterRot.length, refused: 0, replay: engine.chain.slice(7, 19) });
  } finally {
    await h.close();
  }
});

// =====================================================================================
// Defects found by this suite (D-1, D-2): fixed; kept as regression tests
// =====================================================================================

async function twoSeatTable(h: ChaosHarness) {
  const fr = await dipPassport(h);
  const ge = await dipPassport(h);
  const table = h.arena.diplomacy.createTable({
    seed: 7,
    cls: 'core',
    horizonYear: 1901,
    seats: Object.fromEntries(POWERS.map((p) => [p, p === 'france' ? { kind: 'agent', agentId: fr.agentId } : p === 'germany' ? { kind: 'agent', agentId: ge.agentId } : { kind: 'house' }])) as Parameters<typeof h.arena.diplomacy.createTable>[0]['seats'],
  });
  const A = new ChaosSeat(h.url, 'france', null, { token: fr.token, tableId: table.tableId });
  const B = new ChaosSeat(h.url, 'germany', null, { token: ge.token, tableId: table.tableId });
  return { table, A, B };
}

test('D-1 (fixed): repeated schema_invalid on a Diplomacy seat escalates to close 4400 after MAX_SCHEMA_INVALID (errors.md escalation; "the same codes" for the table session)', { timeout: 60_000 }, async () => {
  const h = await chaosSetup({ quietLog: true });
  try {
    const { A, B } = await twoSeatTable(h);
    const c = await A.connect();
    await B.connect();
    const o = await A.waitFor((f) => f.t === 'diplomacy_observation');
    for (let i = 0; i < 8; i++) A.send(c, { t: 'diplomacy_action', protocol_version: '1.0', episode_id: o.episode_id, turn_id: o.turn_id, nonce: o.nonce, power: 'france', junk: i });
    await Promise.race([c.closed, sleep(5000)]);
    const rejects = c.frames.filter((f) => f.reason === 'schema_invalid').length;
    record('D-1', { schemaInvalidRejects: rejects, closed: c.closeInfo?.code ?? null, threshold: MAX_SCHEMA_INVALID });
    assert.equal(c.closeInfo?.code, 4400, `8 schema_invalid frames: expected close 4400 after ${MAX_SCHEMA_INVALID}; got ${rejects} rejects`);
    assert.equal(rejects, MAX_SCHEMA_INVALID, 'exactly the threshold number of rejects precede the close (same count as a duel action)');
    // The other seat is untouched: one session, no reject.
    assert.equal(B.conns.length, 1);
    assert.equal(B.all.filter((f) => f.t === 'reject').length, 0);
  } finally {
    await h.close();
  }
});

test('D-1 (fixed): fewer than MAX_SCHEMA_INVALID schema_invalid frames do not close; the seat still answers on the same session', { timeout: 60_000 }, async () => {
  const h = await chaosSetup({ quietLog: true });
  try {
    const { A, B } = await twoSeatTable(h);
    const c = await A.connect();
    await B.connect();
    const o = await A.waitFor((f) => f.t === 'diplomacy_observation');
    for (let i = 0; i < MAX_SCHEMA_INVALID - 1; i++) A.send(c, { t: 'diplomacy_action', protocol_version: '1.0', episode_id: o.episode_id, turn_id: o.turn_id, nonce: o.nonce, power: 'france', junk: i });
    A.send(c, { t: 'diplomacy_action', protocol_version: '1.0', episode_id: o.episode_id, turn_id: o.turn_id, nonce: o.nonce, power: 'france' });
    await A.waitFor((f) => f.t === 'ack' && f.ack_type === 'action', 5000);
    assert.equal(c.frames.filter((f) => f.reason === 'schema_invalid').length, MAX_SCHEMA_INVALID - 1);
    assert.equal(c.closeInfo, null, 'below the threshold the session stays open');
  } finally {
    await h.close();
  }
});

/** Twenty house-only 1902 tables with fixed identities (the D-2 measurement set). */
const D2_TABLES = 20;
async function runD2Tables(h: ChaosHarness): Promise<string[]> {
  const houseOnly = Object.fromEntries(POWERS.map((p) => [p, { kind: 'house' }])) as Parameters<typeof h.arena.diplomacy.createTable>[0]['seats'];
  const ids: string[] = [];
  for (let i = 0; i < D2_TABLES; i++) ids.push(h.arena.diplomacy.createTable({ seed: 1000 + i, horizonYear: 1902, seats: houseOnly, episode: EPISODE(700 + i) }).tableId);
  const ended = (id: string): boolean => {
    const x = h.arena.diplomacy.getTable(id);
    return x !== undefined && (isLive(x) ? x.isEnded : true);
  };
  for (let k = 0; k < 800 && !ids.every(ended); k++) await sleep(25);
  assert.ok(ids.every(ended), 'all 20 tables ended');
  return ids;
}
const isLive = (x: TableLookup): x is DiplomacyTable => !('kind' in x);

test('D-2 (fixed): an ended table is handed to the result sink and released; memory returns to baseline; getTable() answers with the summary', { timeout: 300_000 }, async () => {
  const mib = (n: number) => Math.round((n / 2 ** 20) * 100) / 100;
  // Before (the pre-fix retention, reproduced with an end grace longer than the measurement).
  let before: { heapDelta: number; retained: number; bytesPerTable: number; hashes: Map<number, [string, string]> };
  {
    const h = await chaosSetup({ quietLog: true, tables: { endGraceMs: 600_000 } });
    try {
      await runD2Tables(h); // warm-up batch: JIT and first-use allocations land before the baseline
      const base = await settledHeap();
      const ids = await runD2Tables(h);
      const heapDelta = (await settledHeap()) - base;
      const live = ids.map((id) => h.arena.diplomacy.getTable(id)!).filter(isLive);
      let bytes = 0;
      for (const t of live) bytes += JSON.stringify(t.episode).length;
      const hashes = new Map(live.map((t, i) => [i, [t.result().replayHash, t.result().transcriptHash] as [string, string]]));
      before = { heapDelta, retained: live.length, bytesPerTable: live.length ? Math.round(bytes / live.length) : 0, hashes };
    } finally {
      await h.close();
    }
  }
  // After: the test default (endGraceMs 0 under WOT_ENV=test) with an explicit capped sink and seal hook.
  const sealed: string[] = [];
  const sink = memoryResultSink({ cap: 64, onResult: (s) => void sealed.push(s.tableId) });
  const h = await chaosSetup({ quietLog: true, tables: { results: sink } });
  try {
    const warm = await runD2Tables(h);
    const base = await settledHeap();
    const ids = await runD2Tables(h);
    const heapDelta = (await settledHeap()) - base;
    const lobby = h.arena.diplomacy;
    const retained = ids.filter((id) => { const x = lobby.getTable(id); return x !== undefined && isLive(x); }).length;
    record('D-2', {
      endedTables: ids.length,
      before: { retained: before.retained, approxRetainedBytesPerTable: before.bytesPerTable, heapDeltaMiB: mib(before.heapDelta) },
      after: { retained, liveTables: lobby.liveTables, sinkSize: sink.size, heapDeltaMiB: mib(heapDelta) },
    });
    assert.equal(before.retained, D2_TABLES, 'control: inside the grace every ended table is still held in full');
    assert.equal(retained, 0, `${retained} ended tables still held by the lobby`);
    assert.equal(lobby.liveTables, 0);
    assert.deepEqual(sealed.sort(), [...warm, ...ids].sort(), 'the seal hook saw every ended table once');
    for (const [i, id] of ids.entries()) {
      const s = lobby.getTable(id);
      assert.ok(s && !isLive(s), `${id}: getTable after release returns the summary`);
      assert.equal(s.kind, 'diplomacy_table_result');
      assert.equal(s.cause, 'terminal');
      assert.equal(s.closeCode, 1000);
      assert.ok(s.terminal, 'terminal carried over');
      assert.deepEqual([s.replayHash, s.transcriptHash], before.hashes.get(i), `${id}: summary hashes == the same table's live result`);
      assert.deepEqual(lobby.getResult(id), s);
    }
    // Memory (steady state, after a warm-up batch): 20 released tables cost less than a quarter of 20
    // retained ones, and under 1 MiB in all (20 summaries are a few KB; the rest is GC noise).
    assert.ok(heapDelta < before.heapDelta / 4, `heap delta after ${mib(heapDelta)} MiB vs before ${mib(before.heapDelta)} MiB`);
    assert.ok(heapDelta < 2 ** 20, `heap delta after release ${mib(heapDelta)} MiB`);
  } finally {
    await h.close();
  }
});
