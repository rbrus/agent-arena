/**
 * The Diplomacy game loop (docs/design/diplomacy-adjudicator.md §6; diplomacy-scenario.md §1.3):
 * seeded seats, step machine, defaults on missed deadlines, forfeit → civil disorder,
 * terminal conditions, the two chains, press isolation, resimulation and golden anchors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalObservation } from '../src/diplomacy/observation.ts';
import {
  dipAct,
  dipEvaluate,
  dipForfeit,
  dipInit,
  dipMiss,
  dipObserve,
  dipResult,
  dipTick,
  resimulateDip,
  seatPowers,
  settledSubmissions,
  stepLabel,
  type DipConfig,
  type DipEpisode,
} from '../src/diplomacy/scenario.ts';
import type { EvalClass } from '../src/diplomacy/press.ts';
import { replayDip } from '../src/diplomacy/simulate.ts';
import { normalise, standardCenters } from '../src/diplomacy/state.ts';
import { checkTerminal, standings } from '../src/diplomacy/terminal.ts';
import { scriptedDipAction, type ScriptedPressOptions } from '../src/diplomacy/testing/scripted-press.ts';
import { POWERS, type DipState, type Power } from '../src/diplomacy/types.ts';

interface PlayOpts extends ScriptedPressOptions {
  cls?: EvalClass;
  overrides?: Partial<DipConfig>;
  /** called before each power acts; `skip: true` means the power missed this step's deadline. */
  beforeAct?: (ep: DipEpisode, p: Power) => { ep: DipEpisode; skip: boolean };
  maxTicks?: number;
}

function play(seed: number, o: PlayOpts): DipEpisode {
  let ep = dipInit(seed, o.cls ?? 'core', o.overrides);
  const cap = o.maxTicks ?? 10_000;
  while (!ep.terminal && ep.tick < cap) {
    for (const p of POWERS) {
      if (o.beforeAct) {
        const r = o.beforeAct(ep, p);
        ep = r.ep;
        if (r.skip) continue;
      }
      ep = dipAct(ep, p, scriptedDipAction(dipObserve(ep, p), o));
    }
    ep = dipTick(ep).ep;
  }
  return ep;
}

// ------------------------------------------------------------------ seats

test('§6.1: seat → power is a seeded Fisher–Yates permutation; the override wins', () => {
  const a = seatPowers(20261115);
  assert.deepEqual(a, seatPowers(20261115));
  assert.deepEqual([...a].sort(), [...POWERS]);
  const distinct = new Set(Array.from({ length: 50 }, (_, i) => seatPowers(i).join(',')));
  assert.ok(distinct.size > 40);
  const fixed = ['germany', 'austria', 'england', 'france', 'italy', 'russia', 'turkey'] as const;
  assert.deepEqual(dipInit(5, 'core', { seatPowers: fixed }).seats, fixed);
  assert.throws(() => dipInit(5, 'core', { seatPowers: ['germany', 'germany', 'england', 'france', 'italy', 'russia', 'turkey'] }));
  // The seats are committed in the replay genesis.
  assert.notEqual(dipInit(5, 'core', { seatPowers: fixed }).chain, dipInit(5, 'core').chain);
});

// ------------------------------------------------------------------ step machine

test('steps: intent → r1..rR → orders per movement phase; retreat/adjustment are one orders step', () => {
  const ep = play(11, { orderSeed: 11, pressSalt: 1, maxTicks: 40 });
  const labels = ep.inputs.map((i) => i.step);
  assert.deepEqual(labels.slice(0, 10), [
    'S1901M:intent',
    'S1901M:r1',
    'S1901M:r2',
    'S1901M:r3',
    'S1901M:orders',
    'F1901M:intent',
    'F1901M:r1',
    'F1901M:r2',
    'F1901M:r3',
    'F1901M:orders',
  ]);
  for (const l of labels) {
    if (/[RA]:/.test(l)) assert.match(l, /^[SFW]\d{4}[RA]:orders$/);
  }
  assert.ok(labels.some((l) => l.endsWith('A:orders')));
  const edge = play(11, { orderSeed: 11, pressSalt: 1, cls: 'edge', maxTicks: 4 });
  assert.deepEqual(edge.inputs.map((i) => i.step), ['S1901M:intent', 'S1901M:r1', 'S1901M:r2', 'S1901M:orders']);
  const none = play(11, { orderSeed: 11, pressSalt: 1, overrides: { pressRounds: 0 }, maxTicks: 2 });
  assert.deepEqual(none.inputs.map((i) => i.step), ['S1901M:intent', 'S1901M:orders']);
});

test('wrong-step input is ignored with feedback to the sender only', () => {
  let ep = dipInit(1, 'core');
  ep = dipAct(ep, 'france', { orders: ['A par - bur'], press: [] });
  ep = dipTick(ep).ep; // intent step
  const fr = dipObserve(ep, 'france');
  assert.deepEqual(fr.rejects.map((r) => [r.kind, r.code]), [
    ['press', 'press_not_in_round'],
    ['orders', 'wrong_step'],
  ]);
  assert.equal(dipObserve(ep, 'germany').rejects.length, 0);
  // Garbage actions are rejected whole, never thrown.
  ep = dipAct(ep, 'germany', 'not an object');
  ep = dipAct(ep, 'italy', { press: [], rogue: true });
  ep = dipTick(ep).ep;
  assert.deepEqual(dipObserve(ep, 'germany').rejects.map((r) => r.code), ['invalid_request']);
  assert.deepEqual(dipObserve(ep, 'italy').rejects.map((r) => r.detail), ['unknown key in action']);
});

// ------------------------------------------------------------------ defaults, misses, forfeit

test('missed deadlines: absent input = default (no intent, empty press, NMR holds); the game still reaches its horizon', () => {
  let ep = dipInit(3, 'edge', { horizonYear: 1903 });
  while (!ep.terminal) ep = dipTick(ep).ep;
  assert.equal(ep.press.intents.length, 0);
  assert.equal(ep.press.log.length, 0);
  assert.equal(ep.terminal!.kind, 'horizon');
  assert.equal(ep.terminal!.year, 1903);
  assert.equal(ep.history.length, 6); // S/F × 1901–1903, no retreats or adjustments with all holds
  const replay = replayDip(ep.seats, 1903, ep.history.map(() => ({})));
  assert.equal(replay.replayHash, ep.chain);
});

test('forfeit: three hard misses in a row → civil disorder until the end; its later input is ignored', () => {
  const ep = play(21, {
    orderSeed: 21,
    pressSalt: 2,
    overrides: { horizonYear: 1902 },
    beforeAct: (e, p) => (p === 'england' && e.tick < 3 ? { ep: dipMiss(e, p, 'hard'), skip: true } : { ep: e, skip: false }),
  });
  assert.deepEqual(ep.forfeited, [{ power: 'england', tick: 2 }]);
  assert.equal(ep.misses.filter((m) => m.power === 'england').length, 3);
  assert.equal(ep.inputs[2].forfeit[0], 'england');
  for (const h of ep.history) assert.deepEqual(h.submissions.england, []); // civil disorder: NMR every phase
  assert.ok(ep.inputs.slice(3).every((i) => i.actions.england === undefined));
  assert.ok(ep.history.some((h) => h.submissions.france.length > 0));
  // An accepted action resets the streak; soft misses never forfeit.
  let e2 = dipInit(1, 'core');
  e2 = dipMiss(dipMiss(e2, 'italy', 'hard'), 'italy', 'hard');
  e2 = dipAct(e2, 'italy', {});
  e2 = dipMiss(dipMiss(e2, 'italy', 'hard'), 'italy', 'soft');
  assert.equal(e2.forfeited.length, 0);
  assert.equal(dipForfeit(dipForfeit(e2, 'italy'), 'italy').forfeited.length, 1);
});

// ------------------------------------------------------------------ terminal

function position(sc: Record<string, Power>, units: [Power, 'A' | 'F', string][], year: number, season: 'S' | 'F' | 'W'): DipState {
  const all = standardCenters();
  for (const k of Object.keys(all)) all[k] = null;
  return normalise({
    ruleset: 'wot-dip/1',
    year,
    season,
    phase: season === 'W' ? 'A' : 'M',
    units: units.map(([power, type, at]) => ({ power, type, at })),
    dislodged: [],
    sc: { ...all, ...sc },
  });
}

test('terminal: solo ≥ 18 only after a Fall update; last standing; horizon; precedence solo > last_standing > horizon', () => {
  const eighteen: Record<string, Power> = {};
  const scs = Object.keys(standardCenters()).sort();
  scs.slice(0, 18).forEach((p) => (eighteen[p] = 'france'));
  scs.slice(18, 20).forEach((p) => (eighteen[p] = 'england'));
  const units: [Power, 'A' | 'F', string][] = [
    ['france', 'A', 'par'],
    ['england', 'F', 'lon'],
  ];
  // Spring → no solo check (SCs cannot have changed).
  assert.equal(checkTerminal('S1905M', position(eighteen, units, 1905, 'F'), 1908), null);
  const solo = checkTerminal('F1905M', position(eighteen, units, 1906, 'S'), 1908)!;
  assert.equal(solo.kind, 'solo');
  assert.equal(solo.winner, 'france');
  assert.equal(solo.sc.france, 18);
  assert.deepEqual(solo.eliminated, ['austria', 'germany', 'italy', 'russia', 'turkey']);
  // Solo wins over horizon in the horizon year.
  assert.equal(checkTerminal('F1908R', position(eighteen, units, 1909, 'S'), 1908)!.kind, 'solo');
  // Last standing, even in spring.
  const alone = checkTerminal('S1904M', position({ par: 'france' }, [['france', 'A', 'par']], 1904, 'F'), 1908)!;
  assert.deepEqual([alone.kind, alone.winner], ['last_standing', 'france']);
  // Horizon: Fall of the horizon year, no W<horizon>A.
  const h = checkTerminal('F1908M', position({ par: 'france', lon: 'england' }, units, 1908, 'W'), 1908)!;
  assert.deepEqual([h.kind, h.winner, h.year], ['horizon', null, 1908]);
  assert.equal(checkTerminal('F1907M', position({ par: 'france', lon: 'england' }, units, 1908, 'S'), 1908), null);
  assert.equal(checkTerminal('F1908M', position({ par: 'france', lon: 'england' }, units, 1908, 'F'), 1908), null); // retreats pending
  // Standings: SC desc, then units; equal rows share a rank.
  const st = standings(position({ par: 'france', lon: 'england' }, units, 1908, 'W'));
  assert.deepEqual(st.slice(0, 3).map((s) => [s.power, s.rank]), [
    ['england', 1],
    ['france', 1],
    ['austria', 3],
  ]);
});

// ------------------------------------------------------------------ full game, chains, replay

const FULL: PlayOpts = { orderSeed: 20261115, pressSalt: 7 };
let fullGame: DipEpisode | null = null;
const full = (): DipEpisode => (fullGame ??= play(20261115, FULL));

test('full scripted game with press reaches a terminal through scenario.ts', () => {
  const ep = full();
  assert.ok(ep.terminal);
  assert.ok(['horizon', 'solo', 'last_standing'].includes(ep.terminal!.kind));
  if (ep.terminal!.kind === 'horizon') assert.equal(ep.terminal!.year, 1908);
  const kinds = new Set(ep.history.map((h) => h.phaseId.slice(-1)));
  assert.deepEqual([...kinds].sort(), ['A', 'M', 'R']);
  // Press really happened: messages, offers, commitments, settlements of every kind, rejects.
  assert.ok(ep.press.log.length > 100);
  assert.ok(ep.press.commitments.length > 5);
  const statuses = new Set(ep.press.commitments.flatMap((c) => c.clauses.flatMap((cl) => cl.settlements.map((s) => s.status))));
  for (const s of ['kept', 'broken', 'released'] as const) assert.ok(statuses.has(s), `no ${s} settlement`);
  assert.ok(ep.press.rejects.some((r) => r.code === 'press_too_large'));
  assert.ok(ep.press.rejects.some((r) => r.code === 'press_invalid_text'));
  // After terminal: tick throws, act is a no-op.
  assert.throws(() => dipTick(ep));
  assert.equal(dipAct(ep, 'france', { orders: [] }), ep);
  assert.deepEqual(dipObserve(ep, 'france').terminal, ep.terminal);
});

test('replay_hash is EXACTLY the adjudicator chain: replayDip over the settled submissions reproduces it', () => {
  const ep = full();
  const r = replayDip(ep.seats, ep.config.horizonYear, settledSubmissions(ep));
  assert.equal(r.replayHash, ep.chain);
  assert.deepEqual(r.perPhase.map((p) => p.chain), ep.history.map((h) => h.chain));
  assert.equal(dipResult(ep).replayHash, ep.chain);
});

test('resimulation from seed + recorded inputs (after a JSON round-trip) reproduces both chains and every observation', () => {
  const ep = full();
  const inputs = JSON.parse(JSON.stringify(ep.inputs));
  const again = resimulateDip(ep.seed, ep.cls, {}, inputs);
  assert.equal(again.chain, ep.chain);
  assert.equal(again.transcript, ep.transcript);
  for (const p of POWERS) assert.equal(canonicalObservation(dipObserve(again, p)), canonicalObservation(dipObserve(ep, p)));
  assert.deepEqual(again.press.rejects, ep.press.rejects);
});

test('press isolation: same orders, different press ⇒ same replay_hash, different transcript_hash', () => {
  const a = full();
  const b = play(20261115, { ...FULL, pressSalt: 8 });
  const silent = play(20261115, { ...FULL, chattiness: 0 });
  assert.equal(b.chain, a.chain);
  assert.equal(silent.chain, a.chain);
  assert.notEqual(b.transcript, a.transcript);
  assert.notEqual(silent.transcript, a.transcript);
  assert.equal(silent.press.log.length, 0);
  // And different orders do change the board chain.
  assert.notEqual(play(20261115, { ...FULL, orderSeed: 1 }).chain, a.chain);
});

test('evaluation_hash hook: the engine hashes whatever verdict vector B4 returns', () => {
  const ep = full();
  const empty = dipEvaluate(ep);
  assert.deepEqual(empty.verdicts, []);
  const v = dipEvaluate(ep, (e) => [{ oracle: 'diplomacy.placeholder', seats: e.seats.length }]);
  assert.notEqual(v.evaluationHash, empty.evaluationHash);
  assert.equal(v.evaluationHash, dipEvaluate(ep, () => [{ seats: 7, oracle: 'diplomacy.placeholder' }]).evaluationHash);
});

// Frozen anchors for the scenario layer (scenario version wot-dip-scenario/2). Re-freeze only with
// a documented version bump of the scenario or the scripted policy, never silently.
//   /1 → /2 (Phase 8 F-1): the scripted policy offers `S1909M`-reaching clauses in F1908M; the
//   engine now rejects them as `clause_beyond_horizon` instead of opening the offer, so the
//   transcript moves: f52536349c71… → 45220b936232…. Settled orders are untouched: replay_hash
//   37d54037956c… is unchanged.
//   /2 → /3 (contracts 2.5.0): a renounce of an ENDED commitment is refused `commitment_unknown`
//   (it was delivered as a no-op). The scripted policy renounces ended commitments: 78 such
//   renounces are now refused (17 of them were delivered under /2; the rest were already refused
//   at round close as re-renounces), so the transcript moves: 45220b936232… → 2cd1ac050d25….
//   Settled orders are untouched: replay_hash 37d54037956c… is unchanged.
const GOLDEN_SCENARIO = {
  seed: 20261115,
  // 99 ticks, 35 adjudicated phases, horizon 1908.
  replayHash: 'sha256:37d54037956cb2c4a3f15532561f66e1861d1ab7d4079f1ac5e104464f689690',
  transcriptHash: 'sha256:2cd1ac050d25e8e377818a64e08828fcf263d1b5f5f906954f98ecfd8f6450ca',
};

test('X.K: golden anchors for the scripted scenario game (replay_hash and transcript_hash)', () => {
  const ep = full();
  const r = dipResult(ep);
  assert.equal(r.scenarioVersion, 'wot-dip-scenario/3');
  assert.equal(r.replayHash, GOLDEN_SCENARIO.replayHash);
  assert.equal(r.transcriptHash, GOLDEN_SCENARIO.transcriptHash);
  // The /2 transcript move is exactly the F-1 path: beyond-horizon offers refused in F1908M only.
  const beyond = ep.press.rejects.filter((x) => x.code === 'clause_beyond_horizon');
  assert.ok(beyond.length > 0);
  assert.deepEqual([...new Set(beyond.map((x) => x.phase))], ['F1908M']);
  // The /3 move is exactly the 2.5.0 path: renounces of ended commitments refused, never delivered.
  const endedRenounces = ep.press.rejects.filter((x) => x.detail === 'respond_to: commitment has ended');
  assert.equal(endedRenounces.length, 78);
  assert.ok(endedRenounces.every((x) => x.code === 'commitment_unknown'));
  for (const m of ep.press.log) {
    if (m.move !== 'renounce') continue;
    const c = ep.press.commitments.find((x) => x.id === m.respond_to)!;
    const settledBefore = c.clauses.every((cl) => cl.settlements.length === cl.phases.length && cl.settlements[cl.settlements.length - 1].tick < m.delivered_tick);
    assert.equal(settledBefore, false, `delivered renounce ${m.msg_id} of an ended commitment`);
  }
});

test('benchmark: full scripted 1901–1908 game with press and per-power observations', (t) => {
  const t0 = performance.now();
  let ep = dipInit(99, 'core');
  const obsMs: number[] = [];
  while (!ep.terminal) {
    for (const p of POWERS) {
      const o0 = performance.now();
      const obs = dipObserve(ep, p);
      obsMs.push(performance.now() - o0);
      ep = dipAct(ep, p, scriptedDipAction(obs, { orderSeed: 99, pressSalt: 99 }));
    }
    ep = dipTick(ep).ep;
  }
  const total = performance.now() - t0;
  obsMs.sort((a, b) => a - b);
  const p99 = obsMs[Math.floor(obsMs.length * 0.99)];
  t.diagnostic(`full game ${ep.tick} ticks: ${total.toFixed(1)} ms; observation median ${obsMs[obsMs.length >> 1].toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`);
  assert.ok(total < 5000, 'full game must stay well inside the 1 s design budget on CI hardware (hard ceiling 5 s)');
  assert.ok(p99 < 20, 'observation p99 budget 1 ms (hard ceiling 20 ms: one GC pause on a loaded runner must not fail the suite)');
  void stepLabel;
});

test('every reject (incl. wrong-step press) lands in the evidence log exactly once', () => {
  let ep = dipInit(2, 'core');
  ep = dipAct(ep, 'turkey', { press: [{ to: { kind: 'broadcast' }, move: 'press', body: 'too early' }] });
  ep = dipTick(ep).ep; // intent step
  ep = dipAct(ep, 'turkey', { press: [{ to: { kind: 'broadcast' }, move: 'press', body: 'x'.repeat(601) }] });
  ep = dipTick(ep).ep; // r1
  assert.deepEqual(ep.press.rejects.map((r) => [r.tick, r.kind, r.code]), [
    [0, 'press', 'press_not_in_round'],
    [1, 'press', 'press_too_large'],
  ]);
});
