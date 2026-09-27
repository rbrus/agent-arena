import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SELF_TESTS, evalValidators } from 'arena-scenarios';
import { buildReport, ReportBuildError, toFileJson, validateReportSchema, exitCodeForReport, EXIT_CODES, CONFLICT_OF_INTEREST, type RunSpec } from '../src/index.ts';
import { DUEL_SPEC, RAID_MEMBER_SPEC, aborted, clone, input, report, runEpisodes } from './helpers.ts';

test('duel: builds and validates from real toEpisodeResult output (A/B alternation, house-bot reference)', () => {
  const eps = runEpisodes(DUEL_SPEC, 'ref:reflex');
  for (const e of eps) assert.ok(evalValidators.episode_result(e), 'arena-scenarios output is contract-valid on its own');
  const r = buildReport(input(DUEL_SPEC, eps));
  assert.ok(validateReportSchema(r));
  assert.deepEqual(r.episodes.map((e) => e.seat), ['A', 'B']);
  assert.equal(r.scenario.reference_policy, 'house-bot:silver');
  assert.equal(r.scenario.failure_mode_id, undefined);
  assert.deepEqual(r.scenario.oracles.map((o) => [o.oracle_id, o.level]), [
    ['grid_tactics.outcome', 'episode'],
    ['grid_tactics.token_efficiency', 'episode'],
    ['shared.budget_violation', 'episode'],
    ['shared.illegal_action_rate', 'episode'],
    ['shared.participation', 'episode'],
    ['harness.replay_integrity', 'episode'],
    ['grid_tactics.win_rate', 'run'],
  ]);
  assert.deepEqual(r.budget_limits, { tier: 'core', soft_deadline_ms: 1500, hard_deadline_ms: 3000, hard_miss_forfeit: 3, token_allowance: 240, tick_cap: 120, max_orders_per_unit: 1, max_inbound_frame_bytes: 8192 });
  // Seat A seed 2 at Core is the frozen reflex-vs-silver anchor.
  const anchor = SELF_TESTS.find((c) => c.name === 'grid_tactics core seed 2 A reflex vs silver')!;
  assert.equal(r.episodes[0].replay_hash, anchor.expect.replayHash);
  // Two duels: the run-level win rate is not assessed (n < 6), never a pass.
  assert.equal(r.run_oracles.length, 1);
  assert.equal(r.run_oracles[0].verdict, 'not_assessed');
  assert.equal(r.run_oracles[0].reason_code, 'insufficient_samples');
  assert.equal(r.run_oracles[0].seat, undefined, 'win_rate spans both seats');
  assert.notEqual(r.summary.verdict, 'pass');
  assert.equal(r.disclosure.conflict_of_interest, CONFLICT_OF_INTEREST);
});

test('duel: six side-balanced episodes assess the run-level win rate; null agent fails it (warning)', () => {
  const spec: RunSpec = { ...DUEL_SPEC, seeds: [2, 2, 3, 3, 4, 4], episodes: 6, budget_tier: 'frontier' };
  const r = report(spec, 'ref:null');
  const wr = r.run_oracles[0];
  assert.equal(wr.verdict, 'fail');
  assert.equal(wr.severity, 'warning');
  assert.match(wr.evidence_ref!.replay_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.summary.oracles.find((o) => o.oracle_id === 'grid_tactics.win_rate')!.fail, 1);
});

test('raid (member mode): builds and validates; reference fill and failure mode recorded; seat pinned', () => {
  const r = report(RAID_MEMBER_SPEC, 'ref:coordinated', { engineCommit: '4f2c9a1' });
  assert.ok(validateReportSchema(r));
  assert.equal(r.scenario.reference_policy, 'ref:bftQuorumSquad@4f2c9a1');
  assert.equal(r.scenario.failure_mode_id, 'byzantine-fault');
  assert.equal(r.engine.commit, '4f2c9a1');
  assert.ok(r.episodes.every((e) => e.seat === 'm1' && e.fill === 'coordinated'));
  assert.deepEqual(r.run_oracles, []);
  assert.equal(r.scenario.oracles[0].primary, true);
  assert.match(r.run.run_id, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('buildReport is deterministic: same inputs, same bytes; the run id moves with the inputs', () => {
  const eps = runEpisodes(RAID_MEMBER_SPEC, 'ref:coordinated');
  const a = toFileJson(buildReport(input(RAID_MEMBER_SPEC, clone(eps))));
  const b = toFileJson(buildReport(input(RAID_MEMBER_SPEC, clone(eps))));
  assert.equal(a, b);
  const c = buildReport(input(RAID_MEMBER_SPEC, clone(eps), { startedAt: '2026-09-26T10:00:01Z' }));
  assert.notEqual(c.run.run_id, JSON.parse(a).run.run_id);
});

test('summary: counts, effective episodes and outcomes', () => {
  const spec: RunSpec = { ...RAID_MEMBER_SPEC, seeds: [20260720], episodes: 3 };
  const r = report(spec, 'ref:coordinated');
  assert.equal(r.summary.episodes_total, 3);
  assert.equal(r.summary.effective_episodes, 1, 'three repeats of one seed are one experiment for a deterministic target');
  assert.deepEqual(r.summary.outcomes, { clear: 3 });
  for (const o of r.summary.oracles) assert.equal(o.pass + o.fail + o.not_assessed, 3, o.oracle_id);
});

test('summary verdict: an aborted episode is never a pass; its verdicts count as not_assessed', () => {
  const spec: RunSpec = { ...RAID_MEMBER_SPEC, seeds: [20260720, 1], episodes: 2 };
  const eps = runEpisodes(spec, 'ref:coordinated');
  const clean = buildReport(input(spec, clone(eps)));
  assert.equal(clean.summary.verdict, 'pass');
  assert.equal(exitCodeForReport(clean), EXIT_CODES.ok);
  const r = buildReport(input(spec, [eps[0], aborted(eps[1])]));
  assert.equal(r.summary.verdict, 'inconclusive');
  assert.equal(r.summary.episodes_aborted, 1);
  assert.deepEqual(r.summary.outcomes, { clear: 1, aborted: 1 });
  assert.equal(r.summary.effective_episodes, 1);
  assert.ok(r.summary.oracles.every((o) => o.not_assessed === 1));
  assert.equal(exitCodeForReport(r), EXIT_CODES.ok, 'no finding, but not a pass either (summary says inconclusive)');
  const h = buildReport(input(spec, [eps[0], aborted(eps[1], 'harness_error')]));
  assert.equal(exitCodeForReport(h), EXIT_CODES.error, 'the arena failed: exit 2, not a clean run');
});

test('summary verdict: error fail => fail (exit 1); warning-only fail => inconclusive; --fail-on warning', () => {
  const naive = report({ ...RAID_MEMBER_SPEC, seeds: [2], episodes: 1, seat: { mode: 'squad' } }, 'ref:naive');
  assert.equal(naive.summary.verdict, 'fail');
  assert.equal(exitCodeForReport(naive), EXIT_CODES.findings);
  // The null duel (the golden loss) now also fails shared.participation at
  // error (arena-scenarios.md §9): a do-nothing target is a `fail`, never
  // `inconclusive`.
  const nul = report({ ...DUEL_SPEC, seeds: [2], episodes: 1 }, 'ref:null');
  assert.deepEqual(nul.episodes[0].oracles.filter((o) => o.verdict === 'fail').map((o) => [o.oracle_id, o.severity]), [
    ['grid_tactics.outcome', 'warning'],
    ['shared.participation', 'error'],
  ]);
  assert.equal(nul.summary.verdict, 'fail');
  assert.equal(exitCodeForReport(nul), EXIT_CODES.findings);
  // B2c: every naive raid squad fails its primary with error (calibration rule),
  // so the warning-only case is a duel the reflex reference loses while acting:
  // seed 20260720 at Edge (arena-scenarios.md §2.1 Built).
  const warnOnly = report({ ...DUEL_SPEC, seeds: [20260720], episodes: 1, budget_tier: 'edge' }, 'ref:reflex');
  assert.equal(warnOnly.episodes[0].outcome, 'loss');
  const fails = warnOnly.episodes[0].oracles.filter((o) => o.verdict === 'fail');
  assert.ok(fails.length >= 1 && fails.every((o) => o.severity === 'warning'), JSON.stringify(fails.map((o) => [o.oracle_id, o.severity])));
  assert.equal(warnOnly.episodes[0].oracles.find((o) => o.oracle_id === 'shared.participation')!.verdict, 'pass');
  assert.equal(warnOnly.summary.verdict, 'inconclusive');
  assert.equal(exitCodeForReport(warnOnly), EXIT_CODES.ok);
  assert.equal(exitCodeForReport(warnOnly, { failOn: 'warning' }), EXIT_CODES.findings);
});

test('buildReport refuses episode results that contradict the RunSpec', () => {
  const eps = runEpisodes(RAID_MEMBER_SPEC, 'ref:coordinated');
  const cases: [string, () => unknown, RegExp][] = [
    ['missing episode', () => buildReport(input(RAID_MEMBER_SPEC, eps.slice(0, 2))), /run_spec.episodes is 3 but 2/],
    ['seed relabelled', () => buildReport(input(RAID_MEMBER_SPEC, [eps[0], { ...clone(eps[1]), seed: 99 }, eps[2]])), /seed is 99/],
    ['episodes out of order', () => buildReport(input(RAID_MEMBER_SPEC, [eps[1], eps[0], eps[2]])), /episode_index is 1, expected 0/],
    ['wrong seat', () => buildReport(input(RAID_MEMBER_SPEC, [{ ...clone(eps[0]), seat: 'm2' }, eps[1], eps[2]])), /seat is m2, expected m1/],
    ['wrong tier', () => buildReport(input({ ...RAID_MEMBER_SPEC, budget_tier: 'edge' }, eps)), /budget.tier is core, expected edge/],
    ['verdict dropped', () => buildReport(input(RAID_MEMBER_SPEC, [{ ...clone(eps[0]), oracles: eps[0].oracles.slice(1) }, eps[1], eps[2]])), /catalog order/],
    ['not an EpisodeResult', () => buildReport(input(RAID_MEMBER_SPEC, [{ ...clone(eps[0]), outcome: 'victory' }, eps[1], eps[2]])), /not a valid EpisodeResult/],
    ['bad engine build', () => buildReport(input(RAID_MEMBER_SPEC, eps, { engineBuild: 'arena@2.0.0' })), /engineBuild must be sha256/],
    ['secret in the spec', () => buildReport(input({ ...RAID_MEMBER_SPEC, target: { ...RAID_MEMBER_SPEC.target, auth: { scheme: 'bearer', ref: 'eyJhbGciOi.xx' } } }, eps)), /run_spec/],
    ['unknown scenario', () => buildReport(input({ ...RAID_MEMBER_SPEC, scenario_id: 'diplomacy' }, eps)), /not in this build's catalog/],
    ['pinned version mismatch', () => buildReport(input({ ...RAID_MEMBER_SPEC, scenario_version: '9.9.9' }, eps)), /pins scenario_version 9.9.9/],
  ];
  for (const [name, fn, re] of cases) {
    assert.throws(fn, (e: unknown) => e instanceof ReportBuildError && re.test(e.message), name);
  }
});

test('summary verdict: the hold-only target of writing-an-agent.md is `fail` (exit 1) in every raid, squad and member m1, five gate seeds (shared.participation, §9)', async () => {
  const { createScenario, runToTerminal, toEpisodeResult, RAID_SCENARIO_IDS } = await import('arena-scenarios');
  type Body = { views?: { member_id: string; you: { unit: { unit_id: string } | null } }[]; view?: { member_id: string; you: { unit: { unit_id: string } | null } } };
  const hold = (v: NonNullable<Body['view']>) => (v.you.unit ? [{ unit_id: v.you.unit.unit_id, verb: 'hold' }] : []);
  const seeds = [20260720, 1, 2, 3, 5];
  for (const scenario_id of RAID_SCENARIO_IDS) {
    for (const seat of [{ mode: 'squad' as const }, { mode: 'member' as const, position: 'm1' as const, fill: 'coordinated' as const }]) {
      const spec: RunSpec = { ...RAID_MEMBER_SPEC, scenario_id, seeds, episodes: seeds.length, seat };
      const eps = seeds.map((seed, i) => {
        const scn = createScenario(scenario_id);
        scn.init(seed, 'core', seat.mode === 'squad' ? { mode: 'squad', blindingKey: 'ab'.repeat(32) } : { mode: 'member', targetSeat: 'm1', fill: 'coordinated', blindingKey: 'ab'.repeat(32) });
        runToTerminal(scn, (obs) => {
          const b = obs as Body;
          const payload = b.views ? { members: Object.fromEntries(b.views.map((v) => [v.member_id, hold(v)])) } : { units: hold(b.view!) };
          return { kind: 'action', payload, latencyMs: 1, frameBytes: JSON.stringify(payload).length };
        });
        return toEpisodeResult(scn.record(), { episodeIndex: i }) as never;
      });
      const r = buildReport(input(spec, eps));
      assert.ok(validateReportSchema(r));
      const cell = `${scenario_id} ${seat.mode}`;
      assert.equal(r.summary.verdict, 'fail', cell);
      assert.equal(exitCodeForReport(r), EXIT_CODES.findings, cell);
      for (const e of r.episodes) {
        const p = e.oracles.find((o) => o.oracle_id === 'shared.participation')!;
        assert.deepEqual([p.verdict, p.severity], ['fail', 'error'], `${cell} seed ${e.seed}`);
      }
    }
  }
});
