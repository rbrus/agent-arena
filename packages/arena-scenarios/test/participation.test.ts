/**
 * shared.participation (arena-scenarios.md §9; contracts 2.8.0, sarif-mapping.md §2.3).
 *
 * The docs test found that a target answering every tick with `hold` scored a
 * run `pass` on split_brain in member seating (the scripted teammates clear it)
 * and `inconclusive` on deadlock and latency: an agent that never acts cannot
 * do the wrong thing, so the failure-mode oracles stay silent. A do-nothing
 * target must never pass. This file pins:
 *
 *  1. the hold-only target fails participation at `error` in every raid ×
 *     {squad, member m1} × gate seed (so no run of it can be `pass` or
 *     `inconclusive`), including the member cells whose primary is
 *     `not_assessed`;
 *  2. golden pairs unchanged: every coordinated reference (squad and every
 *     member seat) and the reflex duel reference pass participation on every
 *     gate seed and tier; every frozen anchor still reproduces (verdict-only
 *     change, no replay hash moves);
 *  3. the null-vs-silver duel golden keeps its loss and now also fails
 *     participation;
 *  4. the definition: hold, zero-step move and an omitted unit are trivial;
 *     one move/attack/revive/ping is enough; ticks with no live target unit
 *     are not decision ticks;
 *  5. (2.8.0) the contract shape: no actable tick is `not_assessed`
 *     `never_actable` (not `precondition_not_reached`, which the 2.8.0
 *     schema refuses for this oracle); a fail carries exactly two evidence
 *     ticks, first and last actable; both validate against the
 *     episode_result conditional.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { DIP_SCHEMAS_DIR } from '../src/diplomacy/contracts.ts';
import { toContractVerdict } from '../src/episode-result.ts';
import type { RaidTickActions, TickActions } from 'wot-engine';
import {
  anchorFor,
  computeGridVerdicts,
  computeRaidVerdicts,
  createScenario,
  GATE_SEEDS_BYZANTINE,
  participation,
  raidParticipationTicks,
  RAID_ORACLE_CATALOG,
  RAID_SCENARIO_IDS,
  runEpisode,
  runToTerminal,
  scenarioModule,
  SCENARIO_IDS,
  tapRaid,
  TIER_IDS,
  type EpisodeRecord,
  type EvalRaidObservationBody,
  type OracleVerdict,
  type RaidScenarioId,
  type Scenario,
  type TierId,
} from '../src/index.ts';

const KEY = '5e'.repeat(32);
const GATE = GATE_SEEDS_BYZANTINE; // the five gate seeds, shared by every raid
const ID = 'shared.participation';
const P = (vs: readonly OracleVerdict[]) => vs.find((v) => v.oracleId === ID)!;

/** The hold-only target of docs/guides/writing-an-agent.md, in-process (same frames, no network). */
function holdRun(id: RaidScenarioId, seed: number, tier: TierId, seating: 'squad' | 'm1'): Scenario {
  const scn = createScenario(id);
  scn.init(seed, tier, seating === 'squad' ? { mode: 'squad', blindingKey: KEY } : { mode: 'member', targetSeat: 'm1', fill: 'coordinated', blindingKey: KEY });
  const hold = (v: EvalRaidObservationBody['view']) => (v!.you.unit ? [{ unit_id: v!.you.unit.unit_id, verb: 'hold' as const }] : []);
  runToTerminal(scn, (obs) => {
    const b = obs as EvalRaidObservationBody;
    const payload = b.views ? { members: Object.fromEntries(b.views.map((v) => [v.member_id, hold(v)])) } : { units: hold(b.view) };
    return { kind: 'action', payload, latencyMs: 1, frameBytes: JSON.stringify(payload).length };
  });
  return scn;
}

test('catalog: shared.participation is declared (error, resim, not primary) in every raid and the duel, right before harness.replay_integrity; not in diplomacy_standard (contract 2.1.0 catalog)', () => {
  for (const id of SCENARIO_IDS) {
    const os = scenarioModule(id).describe().oracles;
    const i = os.findIndex((o) => o.oracleId === ID);
    if (id === 'diplomacy_standard') {
      assert.equal(i, -1);
      continue;
    }
    assert.ok(i > 0, id);
    assert.deepEqual({ ...os[i] }, { oracleId: ID, primary: false, basis: 'resim', severityOnFail: ['error'] }, id);
    assert.equal(os[i - 1].oracleId, 'shared.illegal_action_rate', id);
    assert.equal(os[i + 1].oracleId, 'harness.replay_integrity', id);
  }
});

test('hold-only target: participation fails at error in every raid × {squad, member m1} × gate seed (Core), whatever the primary said', () => {
  const primaryNa: string[] = [];
  for (const id of RAID_SCENARIO_IDS) {
    for (const seating of ['squad', 'm1'] as const) {
      for (const seed of GATE) {
        const scn = holdRun(id, seed, 'core', seating);
        const vs = scn.oracles();
        const p = P(vs);
        const cell = `${id} ${seating} ${seed}`;
        assert.equal(p.status, 'fail', cell);
        assert.equal(p.severity, 'error', cell);
        assert.equal(p.code, 'no_participation', cell);
        assert.equal(p.measure.nontrivial_actions, 0, cell);
        assert.ok(p.measure.decision_ticks > 0 && p.measure.trivial_actions > 0, cell);
        assert.ok(p.evidenceTicks.length >= 1, cell);
        // An error-severity fail makes summary.verdict `fail` (never pass, never inconclusive).
        assert.ok(vs.some((v) => v.status === 'fail' && v.severity === 'error'), cell);
        if (vs.find((v) => v.oracleId === RAID_ORACLE_CATALOG[id][0])!.status === 'not_assessed') primaryNa.push(cell);
      }
    }
  }
  // Positive control for deliverable (2): the gap existed — the member cells whose
  // behavioural primary is not_assessed (latency never strikes; split_brain m1 is
  // never in the minority on some seeds) are exactly the ones participation now decides.
  assert.ok(primaryNa.some((c) => c.startsWith('latency m1')), primaryNa.join());
});

test('hold-only target: the failure is tier-independent (edge and frontier, S0)', () => {
  for (const tier of ['edge', 'frontier'] as const) {
    for (const id of RAID_SCENARIO_IDS) {
      for (const seating of ['squad', 'm1'] as const) {
        const p = P(holdRun(id, 20260720, tier, seating).oracles());
        assert.equal(`${p.status}/${p.severity}`, 'fail/error', `${tier} ${id} ${seating}`);
      }
    }
  }
});

test('golden pairs: every coordinated reference (squad and each member seat m0..m4) passes participation on every gate seed and tier', () => {
  for (const id of RAID_SCENARIO_IDS) {
    for (const tier of TIER_IDS) {
      for (const seed of GATE) {
        for (const seat of ['squad', 'm0', 'm1', 'm2', 'm3', 'm4'] as const) {
          const opts = seat === 'squad' ? ({ mode: 'squad' } as const) : ({ mode: 'member', targetSeat: seat, fill: 'coordinated' } as const);
          const p = P(runEpisode(id, seed, tier, { ...opts, targetDriver: 'ref:coordinated', blindingKey: KEY }).oracles());
          assert.equal(p.status, 'pass', `${id} ${tier} ${seed} ${seat}: ${JSON.stringify(p.measure)}`);
        }
      }
    }
  }
});

test('golden pairs: every S0 squad anchor (coordinated and naive, every tier) still reproduces its frozen hash and outcome, and passes participation', () => {
  for (const id of RAID_SCENARIO_IDS) {
    for (const tier of TIER_IDS) {
      for (const which of ['coordinated', 'naive'] as const) {
        const a = anchorFor({ scenario: id, seat: 'squad', tier, seed: 20260720, policy: which })!;
        const scn = runEpisode(id, 20260720, tier, { mode: 'squad', targetDriver: `ref:${which}`, blindingKey: KEY });
        assert.equal(scn.replayHash(), a.replayHash, `${id} ${tier} ${which}`);
        assert.equal(scn.terminal()!.outcome, a.outcome);
        assert.equal(P(scn.oracles()).status, 'pass', `${id} ${tier} ${which}: a naive squad acts too`);
      }
    }
  }
});

test('duel golden pair: reflex passes participation; null vs silver keeps its frozen loss and now also fails participation (every tier, both frozen seeds, both sides)', () => {
  for (const tier of TIER_IDS) {
    for (const seed of [2, 20260720]) {
      for (const side of ['A', 'B'] as const) {
        const r = runEpisode('grid_tactics', seed, tier, { mode: 'duel', targetSeat: side, targetDriver: 'ref:reflex', blindingKey: KEY });
        assert.equal(P(r.oracles()).status, 'pass', `reflex ${tier} ${seed} ${side}`);
        const n = runEpisode('grid_tactics', seed, tier, { mode: 'duel', targetSeat: side, targetDriver: 'ref:null', blindingKey: KEY });
        const p = P(n.oracles());
        assert.equal(`${p.status}/${p.severity}/${p.code}`, 'fail/error/no_participation', `null ${tier} ${seed} ${side}`);
        assert.equal(n.terminal()!.outcome, 'loss', `null ${tier} ${seed} ${side}`);
        const a = anchorFor({ scenario: 'grid_tactics', seat: side, tier, seed, policy: 'null' });
        if (a) {
          assert.equal(n.replayHash(), a.replayHash, `${tier} ${seed} ${side}: the null golden hash is unchanged`);
          assert.equal(a.outcome, 'loss');
        }
      }
    }
  }
  // The frozen seed-2 Core pair specifically (arena-scenarios.md §2.1 Built).
  assert.ok(anchorFor({ scenario: 'grid_tactics', seat: 'A', tier: 'core', seed: 2, policy: 'null' }), 'seed-2 null anchor exists');
});

test('definition (raid): hold, zero-step move and an omitted unit are trivial; one move, attack, revive or ping passes', () => {
  const rec = runEpisode('split_brain', 20260720, 'core', { mode: 'member', targetSeat: 'm1', fill: 'coordinated', targetDriver: 'ref:coordinated', blindingKey: KEY }).record();
  const inputs = rec.inputs as RaidTickActions[];
  const unit = inputs.flatMap((t) => t.m1 ?? []).find((a) => 'unit_id' in a && a.unit_id)!.unit_id!;
  const withM1 = (f: (i: number) => RaidTickActions['m1']): EpisodeRecord => ({ ...rec, inputs: inputs.map((t, i) => ({ ...t, m1: f(i) })) });

  const holds = P(computeRaidVerdicts(withM1(() => [{ unit_id: unit, verb: 'hold' }])).verdicts);
  assert.equal(`${holds.status}/${holds.severity}`, 'fail/error');
  assert.equal(holds.measure.trivial_actions, holds.measure.decision_ticks);

  const zeroStep = P(computeRaidVerdicts(withM1(() => [{ unit_id: unit, verb: 'move', steps: [] }])).verdicts);
  assert.equal(zeroStep.status, 'fail', 'a zero-step move is a hold');

  const omitted = P(computeRaidVerdicts(withM1(() => [])).verdicts);
  assert.equal(omitted.status, 'fail');
  assert.equal(omitted.measure.trivial_actions, 0);

  const onePing = P(computeRaidVerdicts(withM1((i) => (i === 3 ? [{ verb: 'ping', cell: [0, 0], tag: 'mark' }] : [{ unit_id: unit, verb: 'hold' }]))).verdicts);
  assert.equal(onePing.status, 'pass');
  assert.equal(onePing.measure.pings, 1);
  assert.equal(onePing.measure.nontrivial_actions, 1);

  // The recorded (coordinated) actions pass, and their measures add up.
  const ok = P(computeRaidVerdicts(rec).verdicts);
  assert.equal(ok.status, 'pass');
  assert.equal(ok.measure.nontrivial_actions, ok.measure.moves + ok.measure.attacks + ok.measure.revives + ok.measure.pings);
  assert.ok(ok.measure.decision_ticks <= inputs.length);
});

test('definition (raid): a tick on which no target unit is up at the start is not a decision tick', () => {
  let seen = 0;
  for (const id of RAID_SCENARIO_IDS) {
    const tap = tapRaid(runEpisode(id, 20260720, 'core', { mode: 'squad', targetDriver: 'ref:naive', blindingKey: KEY }).record());
    for (const m of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      const up = tap.ticks.filter((k) => k.start.units.some((u) => u.memberId === m && !u.downed && u.hp > 0)).map((k) => k.t);
      const got = raidParticipationTicks(tap, [m]).map((f) => f.t);
      assert.deepEqual(got, up, `${id} ${m}`);
      if (up.length < tap.ticks.length) seen++;
    }
  }
  assert.ok(seen > 0, 'positive control: some naive member is down on some tick');
});

test('definition (duel): any unit order other than hold is non-trivial; explicit holds alone fail', () => {
  const rec = runEpisode('grid_tactics', 2, 'core', { mode: 'duel', targetSeat: 'A', targetDriver: 'ref:reflex', blindingKey: KEY }).record();
  const inputs = rec.inputs as TickActions[];
  const holdsOnly: EpisodeRecord = {
    ...rec,
    inputs: inputs.map((t) => ({ ...t, A: t.A.map((a) => ({ unit_id: a.unit_id, verb: 'hold' as const })) })),
  };
  const p = P(computeGridVerdicts(holdsOnly).verdicts);
  assert.equal(`${p.status}/${p.severity}`, 'fail/error');
  assert.ok(p.measure.trivial_actions > 0);
  assert.equal(P(computeGridVerdicts(rec).verdicts).status, 'pass');
});

test('participation(): not_assessed (never_actable, 2.8.0) only with no decision tick; pass/not_assessed are notes; evidence names the first and last decision tick', () => {
  const na = participation('m1', []);
  assert.equal(na.status, 'not_assessed');
  assert.equal(na.reason, 'never_actable');
  assert.equal(na.severity, 'note');
  assert.deepEqual(na.evidenceTicks, []);
  const f = participation('m1', [{ t: 4, kinds: [], trivial: 1 }, { t: 9, kinds: [], trivial: 0 }]);
  assert.deepEqual(f.evidenceTicks, [4, 9]);
  assert.equal(`${f.status}/${f.severity}/${f.code}/${f.basis}`, 'fail/error/no_participation/resim');
  const one = participation('m1', [{ t: 7, kinds: [], trivial: 1 }]);
  assert.deepEqual(one.evidenceTicks, [7, 7], 'one actable tick: first = last');
  const many = participation('m1', [3, 5, 8, 13, 21].map((t) => ({ t, kinds: [], trivial: 1 })));
  assert.deepEqual(many.evidenceTicks, [3, 21], 'exactly two ticks, never every actable tick');
  assert.equal(f.measure.decision_ticks, 2);
  const ok = participation('m1', [{ t: 4, kinds: ['attack'], trivial: 0 }]);
  assert.equal(ok.severity, 'note');
  assert.deepEqual(ok.thresholds, { nontrivial_actions_min: 1 });
});

test('verify: participation re-derives bit-for-bit from the record (basis resim)', () => {
  const scn = holdRun('split_brain', 1, 'core', 'm1');
  const again = scenarioModule('split_brain').verify(scn.record());
  assert.deepEqual(P(again.verdicts), P(scn.oracles()));
  assert.equal(P(again.verdicts).basis, 'resim');
});

/**
 * (2.8.0) Synthetic participation verdicts, converted exactly as a report
 * converts them (`toContractVerdict`), spliced into the contract's own
 * episode_result `examples[0]` and validated against the 2.8.0 schema. The
 * negative controls prove the conditional is live in this validator: the
 * pre-2.8.0 spelling and a one-tick fail are refused.
 */
test('2.8.0 schema: never_actable and a two-tick fail validate against the episode_result conditional; the old spelling is refused', () => {
  const schema = JSON.parse(readFileSync(`${DIP_SCHEMAS_DIR}/episode_result.schema.json`, 'utf8')) as Record<string, unknown> & { examples: Record<string, unknown>[] };
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
  ajv.addFormat('date-time', true);
  ajv.addFormat('uri', true);
  const validate = ajv.compile(schema);
  const base = schema.examples[0] as { replay_hash: string; seat: string; oracles: { oracle_id: string }[] };
  assert.ok(validate(base), 'examples[0] is valid as committed');
  const at = base.oracles.findIndex((o) => o.oracle_id === ID);
  assert.ok(at >= 0, 'examples[0] lists shared.participation (2.8.0)');
  const withVerdict = (v: unknown) => ({ ...base, oracles: base.oracles.map((o, i) => (i === at ? v : o)) });
  const seat = base.seat as 'm1';
  const ok = (v: unknown, why: string) => assert.ok(validate(withVerdict(v)), `${why}: ${JSON.stringify(validate.errors)}`);
  const refused = (v: unknown, why: string) => assert.equal(validate(withVerdict(v)), false, why);

  const never = toContractVerdict(participation(seat, []), base.replay_hash);
  assert.equal(never.reason_code, 'never_actable');
  ok(never, 'never_actable');
  const fail2 = toContractVerdict(participation(seat, [{ t: 4, kinds: [], trivial: 1 }, { t: 9, kinds: [], trivial: 0 }]), base.replay_hash);
  assert.deepEqual(fail2.evidence_ref?.ticks, [4, 9]);
  ok(fail2, 'fail, first and last actable tick');
  ok(toContractVerdict(participation(seat, [{ t: 7, kinds: [], trivial: 1 }]), base.replay_hash), 'fail, one actable tick [t, t]');
  ok(toContractVerdict(participation(seat, [{ t: 4, kinds: ['ping'], trivial: 0 }]), base.replay_hash), 'pass');

  refused({ ...never, reason_code: 'precondition_not_reached' }, 'pre-2.8.0 spelling is refused for this oracle');
  refused({ ...fail2, evidence_ref: { ...fail2.evidence_ref, ticks: [4] } }, 'a one-tick fail is refused');
  refused({ ...fail2, evidence_ref: { ...fail2.evidence_ref, ticks: [4, 5, 9] } }, 'a three-tick fail is refused');
  refused({ ...fail2, severity: 'warning' }, 'a fail below error is refused');
  refused({ ...fail2, basis: 'attested' }, 'basis attested is refused');
});
