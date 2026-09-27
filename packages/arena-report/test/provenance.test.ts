/**
 * Contracts 2.1.0/2.2.0 in buildReport and verifyReport (ADR-004): seat
 * provenance completed from the RunSpec, recorded seats replayed from their
 * recorded inputs (never regenerated), the not-assessed section, and the
 * run.target_ownership / run.hosted passthrough.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeVerdicts, runEpisode, toEpisodeResult, type EpisodeRecord, type TargetDriver } from 'arena-scenarios';
import {
  EXIT_CODES,
  buildReport,
  recordedInputsDigest,
  verifyReport,
  type EpisodeResult,
  type NotAssessedEntry,
  type PlayerSeat,
  type Report,
  type RerunContext,
  type RunSpec,
  type SeatProvenanceInput,
} from '../src/index.ts';
import { GOLDEN_SPEC, buildGoldenReport, goldenBlindingKey, goldenRerun } from '../scripts/golden.ts';
import { DUEL_SPEC, RAID_MEMBER_SPEC, aborted, clone, input, runEpisodes } from './helpers.ts';

/* ------------------------------------------------ an in-memory record store -- */

interface Store {
  records: EpisodeRecord[];
  episodes: EpisodeResult[];
  seats: SeatProvenanceInput[][];
}

const actionsOf = (rec: EpisodeRecord, seat: string): unknown[] => rec.inputs.map((t) => (t as Record<string, unknown>)[seat] ?? null);

/** Play a raid run in-process and keep its episode records, as the CLI writes them next to the report. */
function playRaid(spec: RunSpec, driver: TargetDriver): Store {
  const mode = spec.seat?.mode ?? 'member';
  const records: EpisodeRecord[] = [];
  for (let i = 0; i < spec.episodes; i++) {
    const seed = spec.seeds[i % spec.seeds.length];
    records.push(
      runEpisode(spec.scenario_id as 'byzantine', seed, spec.budget_tier, {
        mode: mode as 'squad' | 'member',
        ...(spec.seat?.position ? { targetSeat: spec.seat.position as 'm1' } : {}),
        ...(spec.seat?.fill ? { fill: spec.seat.fill } : {}),
        targetDriver: driver,
        blindingKey: goldenBlindingKey(seed),
      }).record(),
    );
  }
  const targets = (rec: EpisodeRecord) => rec.seats.filter((s) => s.role === 'target').flatMap((s) => s.controls);
  return {
    records,
    episodes: records.map((rec, i) => toEpisodeResult(rec, { episodeIndex: i }) as EpisodeResult),
    seats: records.map((rec) => targets(rec).map((seat) => ({ seat: seat as PlayerSeat, recorded_inputs: { decisions: rec.inputs.length, digest: recordedInputsDigest(actionsOf(rec, seat)) } }))),
  };
}

/**
 * The ADR-004 rerun contract over the store: recorded seats are REPLAYED from the record (never
 * regenerated) and their action arrays returned; regenerated seats are re-derived from the seed and
 * must equal the record. The replay hash is recomputed from the replayed inputs.
 */
function storeRerun(store: Store, driver: TargetDriver, seen: RerunContext[] = []) {
  return (spec: RunSpec, seed: number, ctx: RerunContext) => {
    seen.push(ctx);
    const rec = clone(store.records[ctx.episodeIndex]);
    if (rec.seed !== seed) throw new Error('record seed differs from the RunSpec');
    const recordedActions: Partial<Record<PlayerSeat, unknown[]>> = {};
    for (const rs of ctx.recordedSeats) recordedActions[rs.seat] = actionsOf(rec, rs.seat);
    if (ctx.regeneratedSeats.length) {
      const fresh = runEpisode(spec.scenario_id as 'byzantine', seed, spec.budget_tier, { mode: ctx.mode as 'member', targetSeat: ctx.seat as 'm1', fill: ctx.fill, targetDriver: driver, blindingKey: rec.blindingKey }).record();
      for (const s of ctx.regeneratedSeats) {
        if (JSON.stringify(actionsOf(fresh, s)) !== JSON.stringify(actionsOf(rec, s))) throw new Error(`engine seat ${s}: recorded inputs differ from the regenerated ones`);
      }
    }
    const { replayHash } = computeVerdicts(rec);
    return { result: toEpisodeResult({ ...rec, replayHash }, { episodeIndex: ctx.episodeIndex }) as EpisodeResult, recordedActions };
  };
}

const SQUAD: RunSpec = { ...GOLDEN_SPEC, seeds: GOLDEN_SPEC.seeds.slice(0, 2), episodes: 2 };
const squadStore = playRaid(SQUAD, 'ref:naive');
const squadReport = () => buildReport(input(SQUAD, clone(squadStore.episodes), { seats: squadStore.seats }));

/* --------------------------------------------------------------- build -- */

test('seats[]: squad seating lists all five members as the target, recorded, with the runner’s recorded inputs', () => {
  const r = squadReport();
  const e = r.episodes[0];
  assert.deepEqual(e.seats!.map((s) => [s.seat, s.driver, s.inputs_source]), ['m0', 'm1', 'm2', 'm3', 'm4'].map((m) => [m, 'target', 'recorded']));
  assert.equal(e.seats![2].recorded_inputs!.digest, recordedInputsDigest(actionsOf(squadStore.records[0], 'm2')));
  assert.equal(e.seats![2].recorded_inputs!.decisions, squadStore.records[0].inputs.length);
});

test('seats[]: member seating defaults the reference fill to seed_regenerated and the target seat to recorded', () => {
  const store = playRaid(RAID_MEMBER_SPEC, 'ref:coordinated');
  const r = buildReport(input(RAID_MEMBER_SPEC, store.episodes, { seats: store.seats }));
  assert.deepEqual(r.episodes[0].seats!.map((s) => `${s.seat}:${s.driver}:${s.inputs_source}`), ['m0:engine:seed_regenerated', 'm1:target:recorded', 'm2:engine:seed_regenerated', 'm3:engine:seed_regenerated', 'm4:engine:seed_regenerated']);
  assert.ok(r.episodes[0].seats!.filter((s) => s.driver === 'engine').every((s) => s.recorded_inputs === undefined));
});

test('seats[]: duel seating follows the A/B alternation of the RunSpec', () => {
  const eps = runEpisodes(DUEL_SPEC, 'ref:reflex');
  const ri = { decisions: 1, digest: recordedInputsDigest([]) };
  const r = buildReport(input(DUEL_SPEC, eps, { seats: [[{ seat: 'A', recorded_inputs: ri }], [{ seat: 'B', recorded_inputs: ri }]] }));
  assert.deepEqual(r.episodes.map((e) => e.seats!.map((s) => `${s.seat}:${s.driver}`).join()), ['A:target,B:engine', 'A:engine,B:target']);
});

test('seats[]: the builder refuses provenance the RunSpec does not allow (ADR-004 §2)', () => {
  const store = playRaid(RAID_MEMBER_SPEC, 'ref:coordinated');
  const ri = store.seats[0][0].recorded_inputs!;
  const cases: [string, SeatProvenanceInput[][], RegExp][] = [
    ['target without recorded inputs', store.seats.map(() => [{ seat: 'm1' }]), /a recorded seat needs recorded_inputs/],
    ['engine seat with recorded inputs', store.seats.map((s) => [...s, { seat: 'm0', recorded_inputs: ri }]), /an engine seat is regenerated from the seed/],
    ['engine seat relabelled as a recorded peer', store.seats.map((s) => [...s, { seat: 'm0', driver: 'recorded_peer', recorded_inputs: ri }]), /driver recorded_peer, the RunSpec implies engine/],
    ['target relabelled as llm_peer', store.seats.map(() => [{ seat: 'm1', inputs_source: 'llm_peer', recorded_inputs: ri }]), /inputs_source llm_peer, the RunSpec allows recorded/],
    ['not a seat of the mode', store.seats.map((s) => [...s, { seat: 'A', recorded_inputs: ri }]), /not a player seat of a member episode/],
  ];
  for (const [name, seats, re] of cases) assert.throws(() => buildReport(input(RAID_MEMBER_SPEC, store.episodes, { seats })), re, name);
  // Seats already on an episode are checked the same way.
  const eps = clone(store.episodes);
  eps[1].seats = buildReport(input(RAID_MEMBER_SPEC, store.episodes, { seats: store.seats })).episodes[1].seats!.map((s) => (s.seat === 'm3' ? { seat: 'm3', driver: 'target', inputs_source: 'recorded', recorded_inputs: ri } : s));
  assert.throws(() => buildReport(input(RAID_MEMBER_SPEC, eps)), /episodes\[1\]\.seats\[3\] \(m3\): driver target, the RunSpec implies engine/);
});

test('run.target_ownership and run.hosted pass through; hosted implies mode hosted and a sixi_verified ownership (schema)', () => {
  const eps = runEpisodes(DUEL_SPEC, 'ref:reflex');
  const own = buildReport(input(DUEL_SPEC, eps, { targetOwnership: { loopback: true, attested: false } }));
  assert.deepEqual(own.run.target_ownership, { loopback: true, attested: false });
  assert.equal(own.run.mode, 'local');
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { targetOwnership: { loopback: false, attested: false } })), /does not validate/);
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { targetOwnership: { loopback: true, attested: false, source: 'sixi_verified' } })), /does not validate/, 'sixi_verified implies run.hosted');
});

/* -------------------------------------------------------- not assessed -- */

test('not_assessed: every oracle with a not_assessed verdict, per seat, with reason counts; all-aborted adds the scenario entry', () => {
  const eps = runEpisodes(RAID_MEMBER_SPEC, 'ref:coordinated');
  const partial = buildReport(input(RAID_MEMBER_SPEC, [eps[0], aborted(eps[1]), eps[2]]));
  const oracleIds = partial.scenario.oracles.map((o) => o.oracle_id);
  const entries = partial.not_assessed!.filter((e) => e.verdict_reasons?.episode_aborted);
  assert.deepEqual(entries.map((e) => e.id), [...oracleIds].sort(), 'one entry per oracle, sorted by id');
  for (const e of entries) {
    assert.equal(e.kind, 'oracle');
    assert.equal(e.basis, 'resim');
    assert.equal(e.seat, 'm1');
    assert.equal(e.episodes, (e.verdict_reasons!.episode_aborted ?? 0) + Object.entries(e.verdict_reasons!).filter(([k]) => k !== 'episode_aborted').reduce((n, [, v]) => n + v, 0));
  }
  assert.ok(partial.not_assessed!.every((e) => e.kind !== 'scenario'));
  const none = buildReport(input(RAID_MEMBER_SPEC, eps.map((e) => aborted(e))));
  assert.deepEqual(none.not_assessed![0], { kind: 'scenario', id: 'byzantine', reason_code: 'no_episode_completed', basis: 'resim' });
  assert.ok(none.not_assessed!.slice(1).every((e) => e.reason_code === 'oracle_not_assessed' && e.episodes === 3 && e.verdict_reasons!.episode_aborted === 3));
});

test('not_assessed: caller entries must be `recorded` and are merged in schema order; resim entries are refused', () => {
  const eps = runEpisodes(DUEL_SPEC, 'ref:reflex');
  const extra: NotAssessedEntry[] = [
    { kind: 'property', id: 'target.model_identity', reason_code: 'out_of_scope_by_design', basis: 'recorded' },
    { kind: 'property', id: 'robustness.seed_recovery', reason_code: 'seed_recovery_not_modelled', basis: 'recorded' },
  ];
  const r = buildReport(input(DUEL_SPEC, eps, { notAssessed: extra }));
  assert.deepEqual(r.not_assessed!.filter((e) => e.kind === 'property').map((e) => e.id), ['robustness.seed_recovery', 'target.model_identity']);
  const kinds = r.not_assessed!.map((e) => e.kind);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => ['scenario', 'oracle', 'clause', 'seat', 'property'].indexOf(a) - ['scenario', 'oracle', 'clause', 'seat', 'property'].indexOf(b)));
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { notAssessed: [{ kind: 'property', id: 'target.model_identity', reason_code: 'out_of_scope_by_design', basis: 'resim' }] })), /must have basis recorded/);
  assert.equal(buildReport(input(DUEL_SPEC, eps, { emitNotAssessed: false })).not_assessed, undefined);
});

/* -------------------------------------------------------------- verify -- */

test('verify: recorded seats are replayed from the record, their digests recomputed, and reported as "recorded, replayed" (exit 0)', () => {
  const seen: RerunContext[] = [];
  const v = verifyReport(squadReport(), storeRerun(squadStore, 'ref:naive', seen));
  assert.equal(v.status, 'verified', JSON.stringify(v.episodes.map((e) => e.diffs)).slice(0, 800));
  assert.equal(v.exitCode, EXIT_CODES.ok);
  assert.deepEqual(seen[0].recordedSeats.map((s) => s.seat), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.deepEqual(seen[0].regeneratedSeats, []);
  assert.equal(v.provenance.length, 10);
  assert.ok(v.provenance.every((p) => p.verification === 'recorded_replayed' && p.label === 'recorded, replayed' && p.inputs_digest === 'match'));
  assert.deepEqual(v.recorded_seats, [], 'the primary target is not a recorded peer');
});

test('verify: tampered recorded actions with a forged recorded_inputs digest are caught by the replay-hash comparison (exit 1)', () => {
  const store = clone(squadStore);
  const t3 = store.records[1].inputs[3] as Record<string, unknown>;
  t3.m2 = [];
  const r = squadReport();
  r.episodes[1].seats![2].recorded_inputs!.digest = recordedInputsDigest(actionsOf(store.records[1], 'm2')); // the forger fixes the commitment too
  const v = verifyReport(r, storeRerun(store, 'ref:naive'));
  assert.equal(v.status, 'mismatch');
  assert.equal(v.exitCode, EXIT_CODES.findings);
  const ep = v.episodes[1];
  assert.notEqual(ep.replay_hash.recomputed, ep.replay_hash.reported);
  assert.ok(ep.diffs.some((d) => d.path === '/episodes/1/replay_hash'));
  assert.ok(!ep.diffs.some((d) => d.path.endsWith('/recorded_inputs/digest')), 'the digest itself was forged consistently');
  assert.equal(v.episodes[0].status, 'match');
});

test('verify: a forged recorded_inputs digest alone, or tampered actions alone, are mismatches naming the seat', () => {
  const forged = squadReport();
  forged.episodes[0].seats![4].recorded_inputs!.digest = `sha256:${'0'.repeat(64)}`;
  const a = verifyReport(forged, storeRerun(squadStore, 'ref:naive'));
  assert.equal(a.status, 'mismatch');
  assert.deepEqual(a.episodes[0].diffs.map((d) => d.path), ['/episodes/0/seats/4/recorded_inputs/digest']);
  assert.equal(a.provenance.find((p) => p.episode_index === 0 && p.seat === 'm4')!.inputs_digest, 'mismatch');
  const decisions = squadReport();
  decisions.episodes[0].seats![0].recorded_inputs!.decisions += 1;
  assert.ok(verifyReport(decisions, storeRerun(squadStore, 'ref:naive')).episodes[0].diffs.some((d) => d.path === '/episodes/0/seats/0/recorded_inputs/decisions'));

  const store = clone(squadStore);
  (store.records[0].inputs[5] as Record<string, unknown>).m0 = [];
  const b = verifyReport(squadReport(), storeRerun(store, 'ref:naive'));
  assert.equal(b.status, 'mismatch');
  const paths = b.episodes[0].diffs.map((d) => d.path);
  assert.ok(paths.includes('/episodes/0/seats/0/recorded_inputs/digest') && paths.includes('/episodes/0/replay_hash'), paths.join());
});

test('verify: a rerun that does not return the replayed actions leaves the digest unchecked and says so', () => {
  const v = verifyReport(squadReport(), goldenRerun);
  assert.equal(v.status, 'verified');
  assert.ok(v.provenance.every((p) => p.inputs_digest === 'unchecked'));
  assert.ok(v.unverified.includes('/episodes/0/seats/0/recorded_inputs/digest'));
});

test('verify: member seating regenerates the reference fill and replays only the target seat; a seat relabelled as the target is a mismatch, and cannot steer the rerun', () => {
  const store = playRaid(RAID_MEMBER_SPEC, 'ref:coordinated');
  const good = buildReport(input(RAID_MEMBER_SPEC, store.episodes, { seats: store.seats }));
  const seen: RerunContext[] = [];
  const v = verifyReport(good, storeRerun(store, 'ref:coordinated', seen));
  assert.equal(v.status, 'verified', JSON.stringify(v.episodes.map((e) => [e.error, e.diffs])).slice(0, 800));
  assert.deepEqual(seen[0].recordedSeats.map((s) => s.seat), ['m1']);
  assert.deepEqual(seen[0].regeneratedSeats, ['m0', 'm2', 'm3', 'm4']);
  assert.deepEqual(v.provenance.filter((p) => p.episode_index === 0).map((p) => `${p.seat}:${p.label}`), ['m0:regenerated from seed', 'm1:recorded, replayed', 'm2:regenerated from seed', 'm3:regenerated from seed', 'm4:regenerated from seed']);

  // The forger claims m0 (an engine seat) was a second target seat whose recorded inputs are to be replayed,
  // to make a weakened fill seat pass. `driver: target` is schema-valid in member seating (contracts 2.3.0), so
  // this stays a RunSpec mismatch: the RunSpec names only m1 as the target.
  const t = clone(good);
  t.episodes[0].seats![0] = { seat: 'm0', driver: 'target', inputs_source: 'recorded', recorded_inputs: { decisions: 1, digest: recordedInputsDigest([]) } };
  const seen2: RerunContext[] = [];
  const m = verifyReport(t, storeRerun(store, 'ref:coordinated', seen2));
  assert.equal(m.status, 'mismatch', JSON.stringify(m.errors).slice(0, 400));
  assert.equal(m.exitCode, EXIT_CODES.findings);
  assert.ok(m.episodes[0].diffs.some((d) => d.path === '/episodes/0/seats/0/driver' && d.reported === 'target' && d.recomputed === 'engine'));
  assert.ok(m.episodes[0].diffs.some((d) => d.path === '/episodes/0/seats/0/inputs_source' && d.reported === 'recorded' && d.recomputed === 'seed_regenerated'));
  assert.deepEqual(seen2[0].recordedSeats.map((s) => s.seat), ['m1'], 'the RunSpec, not the episode, decides what is replayed');
  assert.ok(seen2[0].regeneratedSeats.includes('m0'));
});

test('verify: a recorded_peer seat in member seating is schema-invalid since contracts 2.3.0, so the report is unverifiable before any re-simulation', () => {
  const store = playRaid(RAID_MEMBER_SPEC, 'ref:coordinated');
  const t = buildReport(input(RAID_MEMBER_SPEC, store.episodes, { seats: store.seats }));
  t.episodes[0].seats![0] = { seat: 'm0', driver: 'recorded_peer', inputs_source: 'recorded', recorded_inputs: { decisions: 1, digest: recordedInputsDigest([]) } };
  const seen: RerunContext[] = [];
  const u = verifyReport(t, storeRerun(store, 'ref:coordinated', seen));
  assert.equal(u.status, 'unverifiable');
  assert.equal(u.exitCode, EXIT_CODES.error);
  assert.ok(u.errors.some((e) => e.startsWith('report.schema.json: ')), u.errors.join('\n'));
  assert.equal(seen.length, 0, 'nothing is re-simulated for a schema-invalid report');
  for (const bad of ['llm_peer', 'recorded'] as const) {
    const x = clone(t);
    x.episodes[0].seats![0] = { seat: 'm0', driver: 'recorded_peer', inputs_source: bad, recorded_inputs: { decisions: 0, digest: recordedInputsDigest([]) } };
    assert.equal(verifyReport(x, storeRerun(store, 'ref:coordinated')).status, 'unverifiable', bad);
  }
});

test('verify: a 2.1.0-shaped report (no seats[], no not_assessed) verifies exactly as before', () => {
  const old = buildGoldenReport();
  delete old.not_assessed;
  const v = verifyReport(old, goldenRerun);
  assert.equal(v.status, 'verified');
  assert.ok(!v.run.some((d) => d.path.startsWith('/not_assessed')));
  assert.ok(v.provenance.every((p) => p.inputs_digest === 'unchecked'));
});

test('verify: not_assessed resim entries are recomputed (a deleted or forged entry is a mismatch); recorded entries are listed as unverified', () => {
  const eps = runEpisodes(RAID_MEMBER_SPEC, 'ref:coordinated');
  const withAbort = (): Report =>
    buildReport(input(RAID_MEMBER_SPEC, [eps[0], aborted(eps[1]), eps[2]], { notAssessed: [{ kind: 'property', id: 'target.model_identity', reason_code: 'out_of_scope_by_design', basis: 'recorded' }] }));
  const rerun = (spec: RunSpec, seed: number, ctx: RerunContext) => {
    const re = goldenRerunFor('ref:coordinated')(spec, seed, ctx);
    return ctx.episodeIndex === 1 ? aborted(re) : re;
  };
  const r = withAbort();
  const ok = verifyReport(r, rerun);
  assert.equal(ok.status, 'verified');
  const k = r.not_assessed!.findIndex((e) => e.basis === 'recorded');
  assert.ok(ok.unverified.includes(`/not_assessed/${k}`));

  const hidden = withAbort();
  hidden.not_assessed = hidden.not_assessed!.filter((e) => e.kind !== 'oracle' || e.id !== 'byzantine.off_quorum_position');
  assert.equal(verifyReport(hidden, rerun).status, 'mismatch', 'hiding a gap is a mismatch');
  const recount = withAbort();
  recount.not_assessed![0].episodes = 0;
  assert.equal(verifyReport(recount, rerun).status, 'mismatch');
});

function goldenRerunFor(driver: TargetDriver) {
  return (spec: RunSpec, seed: number, ctx: RerunContext) => {
    const rec = runEpisode(spec.scenario_id as 'byzantine', seed, spec.budget_tier, { mode: ctx.mode as 'member', targetSeat: ctx.seat as 'm1', fill: ctx.fill, targetDriver: driver, blindingKey: ctx.blindingKey ?? goldenBlindingKey(seed) }).record();
    return toEpisodeResult(rec, { episodeIndex: ctx.episodeIndex }) as EpisodeResult;
  };
}

test('SARIF §1.1 on local reports: not_assessed_section always, recorded_seats only for non-primary, non-engine seats, never hosted members', async () => {
  const { toSarif } = await import('../src/index.ts');
  const store = playRaid(RAID_MEMBER_SPEC, 'ref:coordinated');
  const member = toSarif(buildReport(input(RAID_MEMBER_SPEC, store.episodes, { seats: store.seats }))).runs[0].properties.agentArena;
  assert.equal(member.recorded_seats, undefined, 'the target seat is primary; the fill is engine');
  assert.equal(member.hosted, undefined);
  assert.equal(member.signing_key_id, undefined);
  const squad = toSarif(squadReport()).runs[0].properties.agentArena;
  assert.equal(squad.recorded_seats, undefined, 'squad seating: every member is the primary target');
  const r = squadReport();
  delete r.not_assessed;
  assert.equal(toSarif(r).runs[0].properties.agentArena.not_assessed_section, undefined, 'a 2.1.0 report renders byte-identical SARIF');
});
