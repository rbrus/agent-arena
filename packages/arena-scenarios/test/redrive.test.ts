/**
 * `redrive(record)` (C2e): the inverse of act()/tick() over the timing log.
 * Round-trip property: for any record the adapter produces, re-driving a fresh
 * Scenario from it reproduces the record byte for byte (inputs, timing,
 * coercions, per-tick hashes, terminal, seats).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScenario,
  egressSquadDriver,
  redrive,
  RedriveDriverMismatchError,
  reflexDriver,
  runEpisode,
  runToTerminal,
  scenarioModule,
  SELF_TESTS,
  targetDriverFromRunSpecTarget,
  targetDriverOf,
  tierOf,
  type EpisodeRecord,
  type EvalRaidObservationBody,
  type Submission,
} from '../src/index.ts';
import type { Observation } from 'wot-contracts';

const KEY = '1e'.repeat(32);
const canon = (r: EpisodeRecord) => JSON.stringify(r);

test('redrive: every frozen self-test record (in-process drivers, all seatings) round-trips', () => {
  for (const c of SELF_TESTS) {
    const rec = runEpisode(c.scenario, c.seed, c.tier, { ...c.opts, blindingKey: KEY }).record();
    const re = scenarioModule(c.scenario).redrive(rec).record();
    assert.equal(canon(re), canon(rec), c.name);
  }
});

test('targetDriverOf resolves renamed references (orderedLockSquad.disciplined) and duel drivers', () => {
  const d = runEpisode('deadlock', 20260720, 'core', { mode: 'squad', targetDriver: 'ref:coordinated', blindingKey: KEY }).record();
  assert.equal(d.seats[0].policyRef, 'driver:ref:orderedLockSquad.disciplined');
  assert.equal(targetDriverOf(d), 'ref:coordinated');
  const g = runEpisode('grid_tactics', 2, 'core', { mode: 'duel', targetSeat: 'A', targetDriver: 'ref:null', blindingKey: KEY }).record();
  assert.equal(targetDriverOf(g), 'ref:null');
});

/**
 * An external target that exercises every timing path on a fixed schedule:
 * t%9==1 late frame past Dh (dropped → hard miss), t%9==2 soft-late accepted,
 * t%9==3 schema_invalid then accepted, t%9==4 explicit soft miss, t%9==5
 * oversized frame then accepted, t%9==6 accepted then a duplicate, t%9==7
 * accepted with no latency measurement, otherwise accepted on time.
 */
function perturbed<P>(answer: (obs: unknown) => P, tier: 'edge' | 'core' | 'frontier') {
  const T = tierOf(tier);
  return (scn: ReturnType<typeof createScenario>) => {
    const seat = scn.targetSeats()[0];
    for (let guard = 0; guard < 200 && !scn.terminal(); guard++) {
      const t = scn.currentTick();
      const payload = answer(scn.observe(seat));
      const ok = (latencyMs: number | null): Submission => ({ kind: 'action', payload, latencyMs, frameBytes: 200 });
      switch (t % 9) {
        case 1:
          scn.act(seat, { kind: 'action', payload, latencyMs: T.hardDeadlineMs + 5, frameBytes: 200 });
          break;
        case 2:
          scn.act(seat, ok(T.softDeadlineMs + 7));
          break;
        case 3:
          scn.act(seat, { kind: 'rejected', reason: 'schema_invalid', latencyMs: 12, frameBytes: 90 });
          scn.act(seat, ok(40));
          break;
        case 4:
          scn.act(seat, { kind: 'miss', severity: 'soft' });
          break;
        case 5:
          scn.act(seat, { kind: 'action', payload, latencyMs: 30, frameBytes: T.maxInboundFrameBytes + 1 });
          scn.act(seat, ok(31));
          break;
        case 6:
          scn.act(seat, ok(20));
          scn.act(seat, ok(21));
          break;
        case 7:
          scn.act(seat, ok(null));
          break;
        default:
          scn.act(seat, ok(10 + (t % 5)));
      }
      scn.tick();
    }
    return scn;
  };
}

test('redrive: external squad / member / duel records with late, rejected, oversized, missed, duplicate and unmeasured frames round-trip', () => {
  let paths = 0;
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    for (const [id, which] of [['byzantine', 'naive'], ['deadlock', 'coordinated'], ['hallucinator', 'coordinated']] as const) {
      const drive = egressSquadDriver(id, which);
      const sq = createScenario(id);
      sq.init(3, tier, { mode: 'squad', blindingKey: KEY });
      perturbed((o) => {
        const b = o as EvalRaidObservationBody;
        return { members: drive(b.views!, b.turn_id) };
      }, tier)(sq);
      const rec = sq.record();
      assert.equal(canon(redrive(rec).record()), canon(rec), `${id} squad ${tier}`);
      paths += new Set(rec.timing.map((e) => `${e.event}:${e.miss}:${e.reject ?? ''}`)).size;

      const mem = createScenario(id);
      mem.init(3, tier, { mode: 'member', targetSeat: 'm2', fill: 'naive', blindingKey: KEY });
      perturbed((o) => {
        const b = o as EvalRaidObservationBody;
        return { units: drive([b.view!], b.turn_id)[b.view!.member_id] ?? [] };
      }, tier)(mem);
      const mrec = mem.record();
      assert.equal(canon(redrive(mrec).record()), canon(mrec), `${id} member ${tier}`);
    }
    const duel = createScenario('grid_tactics');
    duel.init(2, tier, { mode: 'duel', targetSeat: 'B', blindingKey: KEY });
    perturbed((o) => ({ units: reflexDriver(o as Observation) }), tier)(duel);
    const drec = duel.record();
    assert.equal(canon(redrive(drec).record()), canon(drec), `duel ${tier}`);
  }
  assert.ok(paths >= 6, 'the schedule reached the timing paths');
});

test('redrive: the decision trace reports what the adapter did', () => {
  const drive = egressSquadDriver('byzantine', 'coordinated');
  const scn = createScenario('byzantine');
  scn.init(20260720, 'core', { mode: 'squad', blindingKey: KEY });
  perturbed((o) => {
    const b = o as EvalRaidObservationBody;
    return { members: drive(b.views!, b.turn_id) };
  }, 'core')(scn);
  const statuses: string[] = [];
  redrive(scn.record(), (d) => statuses[d.tick] = `${d.ack.status}${d.ack.late ? ':late' : ''}${d.ack.reason ? ':' + d.ack.reason : ''}`);
  assert.equal(statuses[1], 'rejected:late_frame_dropped');
  assert.equal(statuses[2], 'accepted:late');
  assert.equal(statuses[3], 'accepted');
  assert.equal(statuses[4], 'miss:soft');
  assert.equal(statuses[0], 'accepted');
});

test('redrive: a record whose target action the adapter refuses is not replayable', () => {
  const rec = runEpisode('byzantine', 1, 'core', { mode: 'squad', targetDriver: 'ref:coordinated', blindingKey: KEY }).record();
  const ext: EpisodeRecord = { ...structuredClone(rec), seats: rec.seats.map((s) => ({ ...s, policyRef: 'external' })) };
  ext.timing = [];
  assert.throws(() => redrive(ext), /no decision entry for tick 0/);
  const bad: EpisodeRecord = { ...structuredClone(rec), seats: rec.seats.map((s) => ({ ...s, policyRef: 'driver:ref:madeUpSquad' })) };
  assert.throws(() => redrive(bad), /unsupported raid driver/);
});

/**
 * G-33 (docs/phase-7/SECURITY-REVIEW.md §8.4): the record must not choose the
 * target driver. `expectedTargetDriver` comes from the RunSpec
 * (`targetDriverFromRunSpecTarget(spec.target)`), never from the record.
 *
 * WIRING NOTE for the CLI: `arena-cli/src/rerun.ts` (`makeRerun` → `regenerate`)
 * MUST call `redrive(rec, { expectedTargetDriver: targetDriverFromRunSpecTarget(spec.target) })`.
 * Until it does, `verify` still takes the driver from the record, and the
 * arena-cli G-33 test in test/security-review.test.ts stays a `todo`.
 */
test('G-33: redrive refuses a record whose target driver disagrees with the RunSpec (typed error, before simulating)', () => {
  const rec = runEpisode('byzantine', 20260720, 'core', { mode: 'squad', targetDriver: 'ref:coordinated', blindingKey: KEY }).record();
  // The review probe: the RunSpec claims an external agent, the record says the in-process reference.
  const spec = { target: { transport: 'rest', url: 'https://agent.arena-review.example/act', ownership_attested: true } };
  assert.throws(
    () => redrive(rec, { expectedTargetDriver: targetDriverFromRunSpecTarget(spec.target) }),
    (e: unknown) => e instanceof RedriveDriverMismatchError && e.code === 'EREDRIVE_DRIVER_MISMATCH' && e.expected === 'external' && e.recorded === 'ref:coordinated',
  );
  // The other direction: an in-process RunSpec, a record claiming the seat was external.
  const ext: EpisodeRecord = { ...structuredClone(rec), seats: rec.seats.map((s) => ({ ...s, policyRef: 'external' })) };
  assert.throws(() => redrive(ext, { expectedTargetDriver: 'ref:coordinated' }), (e: unknown) => e instanceof RedriveDriverMismatchError && e.recorded === 'external');
  // A record with no seat descriptors cannot default to `external` when a driver is expected.
  const bare: EpisodeRecord = { ...structuredClone(rec), seats: [] };
  assert.throws(() => redrive(bare, { expectedTargetDriver: 'external' }), (e: unknown) => e instanceof RedriveDriverMismatchError && e.recorded === null);
  // A matching driver re-simulates exactly as before.
  const inProc = targetDriverFromRunSpecTarget({ url: 'http://in-process.invalid/ref:coordinated' });
  assert.equal(inProc, 'ref:coordinated');
  assert.equal(canon(redrive(rec, { expectedTargetDriver: inProc }).record()), canon(rec));
});

test('G-33: targetDriverFromRunSpecTarget reads only the RunSpec target URL', () => {
  assert.equal(targetDriverFromRunSpecTarget({ url: 'https://agent.example/act' }), 'external');
  assert.equal(targetDriverFromRunSpecTarget({ url: 'http://127.0.0.1:8080/act' }), 'external');
  assert.equal(targetDriverFromRunSpecTarget(undefined), 'external');
  for (const r of ['ref:naive', 'ref:reflex', 'ref:null', 'ref:silver', 'ref:robust', 'ref:credulous', 'ref:house'] as const) {
    assert.equal(targetDriverFromRunSpecTarget({ url: `http://in-process.invalid/${r}` }), r);
  }
  assert.throws(() => targetDriverFromRunSpecTarget({ url: 'http://in-process.invalid/external' }), /unknown in-process reference/);
  assert.throws(() => targetDriverFromRunSpecTarget({ url: 'http://in-process.invalid/ref:madeUp' }), /unknown in-process reference/);
});

test('G-33: the old signatures keep working (no options, or a bare onDecision callback)', () => {
  const rec = runEpisode('deadlock', 3, 'core', { mode: 'squad', targetDriver: 'ref:coordinated', blindingKey: KEY }).record();
  assert.equal(canon(redrive(rec).record()), canon(rec));
  let calls = 0;
  redrive(rec, () => calls++);
  assert.ok(calls > 0);
  let calls2 = 0;
  redrive(rec, { onDecision: () => calls2++, expectedTargetDriver: 'ref:coordinated' });
  assert.equal(calls2, calls);
});
