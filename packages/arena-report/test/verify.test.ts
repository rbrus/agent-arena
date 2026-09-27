import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT_CODES, buildReport, verifyReport, type EpisodeResult, type Report, type RunSpec } from '../src/index.ts';
import { GOLDEN_ENGINE_BUILD, buildGoldenReport, goldenRerun, referenceRerun } from '../scripts/golden.ts';
import { DUEL_SPEC, RAID_MEMBER_SPEC, aborted, clone, input, report, runEpisodes } from './helpers.ts';

const golden = buildGoldenReport();

test('an untampered report verifies: every episode re-simulates to the same hash and verdicts (exit 0)', () => {
  const v = verifyReport(clone(golden), goldenRerun, { engineBuilds: [GOLDEN_ENGINE_BUILD] });
  assert.equal(v.status, 'verified', JSON.stringify(v, null, 1).slice(0, 2000));
  assert.equal(v.exitCode, EXIT_CODES.ok);
  assert.ok(v.episodes.every((e) => e.status === 'match' && e.replay_hash.reported === e.replay_hash.recomputed));
  assert.deepEqual(v.run, []);
});

test('duel (A/B alternation) and member-mode reports verify with their reference reruns', () => {
  const duel = report({ ...DUEL_SPEC, seeds: [2, 3, 4], episodes: 4 }, 'ref:reflex');
  assert.equal(verifyReport(duel, referenceRerun('ref:reflex')).status, 'verified');
  const member = report(RAID_MEMBER_SPEC, 'ref:coordinated');
  assert.equal(verifyReport(member, referenceRerun('ref:coordinated')).status, 'verified');
});

test('tampered verdict: a fail flipped to pass, with the summary forged to match, is a mismatch (exit 1)', () => {
  const t = clone(golden);
  const ep = t.episodes[2];
  const k = ep.oracles.findIndex((o) => o.oracle_id === 'byzantine.self_distrust');
  assert.equal(ep.oracles[k].verdict, 'fail');
  ep.oracles[k] = { oracle_id: 'byzantine.self_distrust', seat: 'squad', verdict: 'pass', severity: 'note', basis: 'resim' };
  const s = t.summary.oracles.find((o) => o.oracle_id === 'byzantine.self_distrust')!;
  s.pass += 1; s.fail -= 1; s.fail_by_severity = { error: s.fail };
  const v = verifyReport(t, goldenRerun);
  assert.equal(v.status, 'mismatch');
  assert.equal(v.exitCode, EXIT_CODES.findings);
  assert.equal(v.episodes[2].status, 'mismatch');
  assert.ok(v.episodes[2].diffs.some((d) => d.path === `/episodes/2/oracles/${k}/verdict` && d.reported === 'pass' && d.recomputed === 'fail' && d.basis === 'resim'));
  assert.ok(v.run.some((d) => d.path.startsWith('/summary/oracles/')), 'the forged summary is recomputed, not read back');
  assert.ok(v.episodes.filter((e) => e.episode_index !== 2).every((e) => e.status === 'match'));
});

test('tampered summary alone (verdict fail -> pass) is a mismatch', () => {
  const t = clone(golden);
  t.summary.verdict = 'pass';
  const v = verifyReport(t, goldenRerun);
  assert.equal(v.status, 'mismatch');
  assert.deepEqual(v.run.map((d) => d.path), ['/summary/verdict']);
});

test('tampered replay_hash (and its evidence refs) is a mismatch that names both hashes', () => {
  const t = clone(golden);
  const forged = `sha256:${'0'.repeat(64)}`;
  const real = t.episodes[1].replay_hash;
  t.episodes[1].replay_hash = forged;
  for (const o of t.episodes[1].oracles) if (o.evidence_ref) o.evidence_ref.replay_hash = forged;
  const v = verifyReport(t, goldenRerun);
  assert.equal(v.status, 'mismatch');
  assert.deepEqual(v.episodes[1].replay_hash, { reported: forged, recomputed: real });
  assert.ok(v.episodes[1].diffs.some((d) => d.path === '/episodes/1/replay_hash'));
});

test('tampered measures, severity, catalog, budget limits or disclosure are all mismatches', () => {
  const muts: [string, (r: Report) => void][] = [
    ['measure', (r) => { const o = r.episodes[0].oracles[0]; o.measures = { ...(o.measures ?? {}), off_quorum_fraction: 0 }; }],
    ['severity of a fail', (r) => { const o = r.episodes[0].oracles.find((x) => x.verdict === 'fail')!; o.severity = 'note'; r.summary.oracles.find((s) => s.oracle_id === o.oracle_id)!.fail_by_severity = { warning: 4, note: 1 }; }],
    ['catalog severity downgraded', (r) => { r.scenario.oracles[0].severities = ['note']; }],
    ['catalog oracle dropped', (r) => { r.scenario.oracles.splice(2, 1); }],
    ['budget counter', (r) => { r.episodes[4].budget.tokens_spent = 1; }],
    ['outcome', (r) => { r.episodes[0].outcome = 'clear'; r.summary.outcomes = { clear: 1, wipe: 4 }; }],
    ['trajectory class', (r) => { r.episodes[3].trajectory_class = r.episodes[4].trajectory_class; r.summary.effective_episodes = 4; }],
    ['conflict-of-interest text', (r) => { r.disclosure.conflict_of_interest = 'Independent.'; }],
  ];
  for (const [name, mut] of muts) {
    const t = clone(golden);
    mut(t);
    const v = verifyReport(t, goldenRerun);
    assert.equal(v.status, 'mismatch', name);
  }
});

test('seeds come from the RunSpec, not the episode: a relabelled seed cannot steer its own re-simulation', () => {
  const t = clone(golden);
  const seen: number[] = [];
  t.episodes[3].seed = 20260720; // claim episode 3 replayed the (passing-ish) first seed
  const v = verifyReport(t, (spec, seed, ctx) => { seen.push(seed); return goldenRerun(spec, seed, ctx); });
  assert.deepEqual(seen, golden.run.spec.seeds);
  assert.equal(v.status, 'mismatch');
  assert.ok(v.episodes[3].diffs.some((d) => d.path === '/episodes/3/seed'));
});

test('a report whose episodes cannot be regenerated is unverifiable (exit 2), never verified', () => {
  const throws = verifyReport(clone(golden), (spec, seed, ctx) => {
    if (seed === 3) throw new Error('episode record missing');
    return goldenRerun(spec, seed, ctx);
  });
  assert.equal(throws.status, 'unverifiable');
  assert.equal(throws.exitCode, EXIT_CODES.error);
  assert.equal(throws.episodes[3].status, 'unverifiable');
  assert.match(throws.errors.join(), /episode 3 \(seed 3\) cannot be regenerated: episode record missing/);

  const wrongSeed = verifyReport(clone(golden), (spec, _seed, ctx) => goldenRerun(spec, 999, ctx));
  assert.equal(wrongSeed.status, 'unverifiable');
  const garbage = verifyReport(clone(golden), () => ({ nope: true }) as unknown as EpisodeResult);
  assert.equal(garbage.status, 'unverifiable');
  assert.match(garbage.errors[0], /did not produce a valid EpisodeResult/);

  // Episodes claimed for a target the verifier's re-run does not reproduce (the robust squad's
  // record presented as the credulous one): every episode is a mismatch.
  const other = verifyReport(clone(golden), referenceRerun('ref:coordinated'));
  assert.equal(other.status, 'mismatch');
  assert.ok(other.episodes.every((e) => e.status === 'mismatch'));
});

test('an aborted episode verifies only if the re-run reproduces the abort', () => {
  const eps = runEpisodes(RAID_MEMBER_SPEC, 'ref:coordinated');
  const r = buildReport(input(RAID_MEMBER_SPEC, [eps[0], aborted(eps[1]), eps[2]]));
  const plain = verifyReport(r, referenceRerun('ref:coordinated'));
  assert.equal(plain.status, 'mismatch', 'a completed re-run contradicts the recorded abort');
  const faithful = verifyReport(r, (spec, seed, ctx) => (ctx.episodeIndex === 1 ? aborted(referenceRerun('ref:coordinated')(spec, seed, ctx)) : referenceRerun('ref:coordinated')(spec, seed, ctx)));
  assert.equal(faithful.status, 'verified');
});

test('input handling: schema-invalid, hostile keys and deep nesting are unverifiable before any re-sim; unknown build is exit 3', () => {
  let calls = 0;
  const count = (spec: RunSpec, seed: number, ctx: Parameters<typeof goldenRerun>[2]) => { calls++; return goldenRerun(spec, seed, ctx); };
  const bad = clone(golden) as unknown as Record<string, unknown>;
  delete bad.disclosure;
  assert.equal(verifyReport(bad, count).exitCode, EXIT_CODES.error);
  const proto = JSON.parse(JSON.stringify(golden).replace('"report_version"', '"__proto__":{"polluted":1},"report_version"'));
  const pv = verifyReport(proto, count);
  assert.equal(pv.status, 'unverifiable');
  assert.match(pv.errors[0], /forbidden key __proto__/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  let deep: unknown = 1;
  for (let i = 0; i < 200; i++) deep = [deep];
  assert.equal(verifyReport({ ...clone(golden), run_oracles: deep }, count).status, 'unverifiable');
  assert.equal(verifyReport('not a report', count).status, 'unverifiable');
  assert.equal(calls, 0, 'nothing is re-simulated for an invalid report');
  const other = verifyReport(clone(golden), count, { engineBuilds: [`sha256:${'1'.repeat(64)}`] });
  assert.equal(other.status, 'unsupported_engine');
  assert.equal(other.exitCode, EXIT_CODES.misconfig);
  assert.equal(calls, 0);
});

test('wall-clock-only fields are carried over and listed as unverified, never compared', () => {
  const t = clone(golden);
  t.episodes[0].duration_ms = 1234;
  t.episodes[0].budget.decision_ms_p95 = 88;
  const v = verifyReport(t, goldenRerun);
  assert.equal(v.status, 'verified');
  assert.ok(v.unverified.includes('/episodes/0/duration_ms'));
  assert.ok(v.unverified.includes('/episodes/0/budget/decision_ms_p95'));
});

test('2.3.0 engine.build_scope / source_manifest_digest: rebuilt from the report; a scope the scenario may not record is a mismatch', () => {
  assert.equal(golden.engine.build_scope, 'core', 'the golden records the scope it was hashed with');
  const withDigest = clone(golden);
  withDigest.engine.source_manifest_digest = `sha256:${'ab'.repeat(32)}`;
  assert.equal(verifyReport(withDigest, goldenRerun).status, 'verified', 'the manifest digest is an input (named, not re-derived here)');
  const misScoped = clone(golden);
  misScoped.engine.build_scope = 'diplomacy';
  const m = verifyReport(misScoped, goldenRerun);
  assert.equal(m.status, 'mismatch');
  assert.ok(m.run.some((d) => d.path === '/' && /record scope core or all/.test(String(d.recomputed))), JSON.stringify(m.run).slice(0, 400));
});
