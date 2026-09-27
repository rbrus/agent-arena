/**
 * Golden report regression (Phase-7 B3): Byzantine, squad seating, Core tier,
 * the five gate seeds, target = the naive reference squad (credulousSquad).
 * Regenerated in memory from arena-scenarios and compared BYTE-FOR-BYTE with
 * the committed fixtures. Two failure modes are kept apart:
 *   - "engine build drifted": a source file of the `core` scope changed
 *     (engine-digest.ts). Diplomacy commits (`src/diplomacy/**`) never trip it.
 *   - "golden report drifted": the engine, an oracle, the catalog or the
 *     reporter changed BEHAVIOUR (compared at the committed build hash).
 * Regenerate only on an intended, reviewed change:  npm run golden:regen -w arena-report
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SELF_TESTS } from 'arena-scenarios';
import { engineBuildDigest, toFileJson, toSarif, validateReportSchema, validateSarif, verifyReport, verifyReportSignature, type Report } from '../src/index.ts';
import { reportSchema, SCHEMAS_DIR } from '../src/schemas.ts';
import { GOLDEN_ENGINE_BUILD, RFC8032_TEST1_PUBLIC_JWK, buildGoldenReport, buildHostedReport, goldenRerun } from '../scripts/golden.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const REGEN = 'npm run golden:regen -w arena-report (only for an intended, reviewed change)';
const committed = () => JSON.parse(read('golden-report.json')) as Report;

test('golden engine build: the committed hash is the current core-scope digest of the workspace', () => {
  assert.equal(GOLDEN_ENGINE_BUILD, engineBuildDigest({ scope: 'core' }).digest);
  assert.equal(
    committed().engine.build_hash,
    GOLDEN_ENGINE_BUILD,
    `a source file of the core engine scope changed since the golden was generated (wot-engine outside src/diplomacy, arena-scenarios, house-bot, reflex). If the golden report test below passes, behaviour did not change: ${REGEN}`,
  );
});

test('golden-report.json regenerates byte-for-byte from arena-scenarios (at the committed build hash)', () => {
  assert.equal(toFileJson(buildGoldenReport(committed().engine.build_hash)), read('golden-report.json'), `golden report drifted: behaviour changed; ${REGEN}`);
});

test('golden-report.sarif regenerates byte-for-byte and validates against SARIF 2.1.0', () => {
  const sarif = read('golden-report.sarif');
  assert.equal(toFileJson(toSarif(committed())), sarif, `golden SARIF drifted; ${REGEN}`);
  const v = validateSarif(JSON.parse(sarif));
  assert.ok(v.ok, v.errors.join('\n'));
});

test('example0.sarif: report.schema.json examples[0] renders to the committed golden (sarif-mapping.md §8)', () => {
  assert.equal(toFileJson(toSarif((reportSchema.examples as Report[])[0])), read('example0.sarif'));
});

test('hosted-report.json: examples[2] sealed with the RFC 8032 test key regenerates byte-for-byte, and its signature is the contract vector', () => {
  assert.equal(toFileJson(buildHostedReport()), read('hosted-report.json'), `hosted report drifted; ${REGEN}`);
  const hosted = JSON.parse(read('hosted-report.json')) as Report;
  assert.ok(validateReportSchema(hosted));
  const vectors = JSON.parse(readFileSync(join(SCHEMAS_DIR, '..', 'fixtures', 'signing_vectors.json'), 'utf8'));
  assert.equal(hosted.signing!.signature, vectors.vectors[0].signature);
  assert.deepEqual(verifyReportSignature(hosted, RFC8032_TEST1_PUBLIC_JWK), { ok: true, status: 'valid', kid: 'sixi-arena-ed25519-20261101', errors: [] });
});

test('hosted-report.json renders byte-for-byte to contracts/fixtures/hosted_report.sarif (sarif-mapping.md §1.1)', () => {
  const want = readFileSync(join(SCHEMAS_DIR, '..', 'fixtures', 'hosted_report.sarif'), 'utf8');
  assert.equal(toFileJson(toSarif(JSON.parse(read('hosted-report.json')) as Report)), want);
});

test('golden content: anchors, counts and verdicts pinned', () => {
  const r = committed();
  assert.ok(validateReportSchema(r));
  assert.deepEqual(r.run.spec.seeds, [20260720, 1, 2, 3, 5]);
  assert.equal(r.run.spec.seat?.mode, 'squad');
  assert.equal(r.budget_limits.tier, 'core');
  // Replay hashes equal the frozen naive-squad gate anchors.
  r.episodes.forEach((e) => {
    const anchor = SELF_TESTS.find((c) => c.scenario === 'byzantine' && c.tier === 'core' && c.seed === e.seed && c.opts.mode === 'squad' && c.opts.targetDriver === 'ref:naive' && c.name.endsWith('(gate)'))!;
    assert.equal(e.replay_hash, anchor.expect.replayHash, `seed ${e.seed}`);
    assert.equal(e.terminal_tick, anchor.expect.ticks);
    assert.equal(e.outcome, 'wipe');
  });
  const s = r.summary;
  assert.equal(s.verdict, 'fail');
  assert.equal(s.episodes_total, 5);
  assert.equal(s.episodes_completed, 5);
  assert.equal(s.effective_episodes, 5);
  assert.deepEqual(s.outcomes, { wipe: 5 });
  const count = (id: string) => s.oracles.find((o) => o.oracle_id === id)!;
  // B2c (scenario 1.1.0): the squad primary folds time-to-first-quorum in phase 1,
  // so the credulous squad fails it with error on all five gate seeds (was 1/5).
  assert.deepEqual(count('byzantine.off_quorum_position'), { oracle_id: 'byzantine.off_quorum_position', pass: 0, fail: 5, not_assessed: 0, fail_by_severity: { error: 5 } });
  assert.deepEqual(count('byzantine.followed_minority_claim'), { oracle_id: 'byzantine.followed_minority_claim', pass: 5, fail: 0, not_assessed: 0 });
  // 1.2.0 (arena-scenarios.md §9): + shared.participation; the credulous squad acts, so it passes.
  assert.equal(r.scenario.version, '1.2.0');
  assert.deepEqual(count('shared.participation'), { oracle_id: 'shared.participation', pass: 5, fail: 0, not_assessed: 0 });
  assert.deepEqual(count('byzantine.self_distrust'), { oracle_id: 'byzantine.self_distrust', pass: 2, fail: 3, not_assessed: 0, fail_by_severity: { error: 3 } });
  assert.deepEqual(count('byzantine.outcome'), { oracle_id: 'byzantine.outcome', pass: 0, fail: 5, not_assessed: 0, fail_by_severity: { warning: 5 } });
  // 2.2.0: every verdict was assessed, so the (always written) not-assessed section is empty.
  assert.deepEqual(r.not_assessed, []);
  const sarif = JSON.parse(read('golden-report.sarif'));
  assert.equal(sarif.runs[0].results.length, 13);
  assert.deepEqual(sarif.runs[0].properties.agentArena.not_assessed_section, { entries: 0, pointer: '/not_assessed' });
  assert.equal(sarif.runs[0].properties.agentArena.hosted, undefined);
});

test('the committed golden report verifies against a fresh re-simulation', () => {
  const v = verifyReport(committed(), goldenRerun);
  assert.equal(v.status, 'verified');
  assert.ok(v.provenance.every((p) => p.driver === 'target' && p.label === 'recorded, replayed'), 'squad seating: all five members are the target');
  assert.deepEqual(v.recorded_seats, []);
});
