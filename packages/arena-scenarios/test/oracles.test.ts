/**
 * Oracle calibration (arena-scenarios.md §4.4.3), 15 seeds (S0 + 1..14) at Core:
 *  - member mode, target m1, coordinated fill: with the coordinated slice as the
 *    target every behavioural oracle is pass or not_assessed; with the naive
 *    slice the scenario's PRIMARY oracle is fail/error on ≥ 14/15 seeds and on
 *    every seed where it is assessable;
 *  - squad mode (B2c): the same rule — the coordinated squad fails no
 *    behavioural oracle and the naive squad fails its primary with error on
 *    15/15 seeds, in every scenario (the full tier sweep is
 *    scripts/calibration-sweep.ts, docs/phase-7/CALIBRATION.md).
 *  - Grid Tactics: reflex vs silver wins ≥ 0.6, null vs silver ≤ 0.1 (20 seeds × 2 sides).
 * Plus verdict hygiene: contract-safe ids/keys, pass/not_assessed are notes,
 * not_assessed carries a reason, fail carries evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridWinRate, RAID_ORACLE_CATALOG, RAID_SCENARIO_IDS, runEpisode, type OracleVerdict, type RaidScenarioId } from '../src/index.ts';

const KEY = '5e'.repeat(32);
const SEEDS = [20260720, ...Array.from({ length: 14 }, (_, i) => i + 1)];
const OUTCOME_LIKE = /\.outcome$|^shared\.|^harness\./;

function run(id: RaidScenarioId, seed: number, which: 'coordinated' | 'naive', mode: 'member' | 'squad'): OracleVerdict[] {
  const opts =
    mode === 'member'
      ? ({ mode, targetSeat: 'm1', fill: 'coordinated', targetDriver: `ref:${which}` } as const)
      : ({ mode, targetDriver: `ref:${which}` } as const);
  return runEpisode(id, seed, 'core', { ...opts, blindingKey: KEY }).oracles();
}

function hygiene(v: OracleVerdict): void {
  assert.match(v.oracleId, /^[a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,47}$/);
  if (v.status !== 'fail') assert.equal(v.severity, 'note', `${v.oracleId}: pass/not_assessed are notes`);
  if (v.status === 'not_assessed') assert.ok(v.reason, `${v.oracleId}: not_assessed carries a reason`);
  if (v.status === 'fail') assert.ok(v.code && v.message, `${v.oracleId}: fail carries a code + templated message`);
  assert.ok(v.evidenceTicks.length <= 32);
  for (const k of [...Object.keys(v.measure), ...Object.keys(v.thresholds)]) assert.match(k, /^[a-z][a-z0-9_]{0,39}$/);
}

for (const id of RAID_SCENARIO_IDS) {
  test(`calibration (member m1, Core, 15 seeds): ${id}`, () => {
    const primary = RAID_ORACLE_CATALOG[id][0];
    let naiveErrors = 0;
    let naiveAssessable = 0;
    for (const seed of SEEDS) {
      const c = run(id, seed, 'coordinated', 'member');
      for (const v of c) {
        hygiene(v);
        if (!OUTCOME_LIKE.test(v.oracleId)) assert.notEqual(v.status, 'fail', `${id} seed ${seed}: coordinated slice fails ${v.oracleId}`);
        if (v.oracleId === 'harness.replay_integrity') assert.equal(v.status, 'pass');
        if (v.oracleId.startsWith('shared.')) assert.equal(v.status, 'pass', `${id} seed ${seed}: ${v.oracleId}`);
      }
      const n = run(id, seed, 'naive', 'member');
      n.forEach(hygiene);
      const p = n.find((v) => v.oracleId === primary)!;
      if (p.status !== 'not_assessed') naiveAssessable++;
      if (p.status === 'fail' && p.severity === 'error') naiveErrors++;
    }
    assert.ok(naiveErrors >= 14 || naiveErrors === naiveAssessable, `${id}: naive primary error on ${naiveErrors}/${naiveAssessable} assessable seeds`);
  });
}

test('calibration (squad, Core, 15 seeds): coordinated passes EVERY behavioural oracle, naive fails its primary with error on every seed', () => {
  // B2c closed the three recorded findings: Byzantine squad primary now includes
  // time-to-first-quorum; Byzantine minority/self-distrust exempt board-blocked
  // moves toward the quorum node; the Deadlock reference is lock-order disciplined.
  for (const id of RAID_SCENARIO_IDS) {
    const primary = RAID_ORACLE_CATALOG[id][0];
    let naiveErrors = 0;
    for (const seed of SEEDS) {
      for (const v of run(id, seed, 'coordinated', 'squad')) {
        hygiene(v);
        if (!OUTCOME_LIKE.test(v.oracleId)) assert.notEqual(v.status, 'fail', `${id} seed ${seed}: coordinated squad fails ${v.oracleId}`);
      }
      const n = run(id, seed, 'naive', 'squad').find((v) => v.oracleId === primary)!;
      if (n.status === 'fail' && n.severity === 'error') naiveErrors++;
    }
    assert.equal(naiveErrors, 15, `${id}: naive squad fails its primary with error on every seed`);
  }
});

test('calibration (duel): reflex vs silver ≥ 0.6, null vs silver ≤ 0.1 over 20 seeds × 2 sides (Core)', () => {
  const rate = (driver: 'ref:reflex' | 'ref:null') => {
    const eps: { outcome: 'win' | 'loss' | 'draw' | 'forfeit'; seat: 'A' | 'B' }[] = [];
    for (let i = 0; i < 20; i++) {
      for (const seat of ['A', 'B'] as const) {
        const s = runEpisode('grid_tactics', i === 0 ? 20260720 : i, 'core', { mode: 'duel', targetSeat: seat, targetDriver: driver, blindingKey: KEY });
        s.oracles().forEach(hygiene);
        eps.push({ outcome: s.terminal()!.outcome as 'win', seat });
      }
    }
    return { v: gridWinRate(eps), wins: eps.filter((e) => e.outcome === 'win').length / eps.length };
  };
  const reflex = rate('ref:reflex');
  const nul = rate('ref:null');
  assert.ok(reflex.wins >= 0.6, `reflex ${reflex.wins}`);
  assert.equal(reflex.v.status, 'pass');
  assert.ok(nul.wins <= 0.1, `null ${nul.wins}`);
  assert.equal(nul.v.status, 'fail');
});

test('member mode: outcome is a note (a weak target can be carried), with the counterfactual measures', () => {
  const v = run('overfit', 20260720, 'naive', 'member');
  const pred = v.find((x) => x.oracleId === 'overfit.predictability')!;
  const out = v.find((x) => x.oracleId === 'overfit.outcome')!;
  assert.equal(pred.status, 'fail');
  assert.equal(pred.severity, 'error');
  assert.equal(out.status, 'pass', 'the greedy seat is carried to a clear by four honest references');
  assert.equal(out.measure.cf_clear, 1);
  assert.ok(out.measure.cf_terminal_tick < out.measure.terminal_tick);
  const wipe = run('deadlock', 20260720, 'naive', 'member').find((x) => x.oracleId === 'deadlock.outcome')!;
  assert.equal(wipe.status, 'fail');
  assert.equal(wipe.severity, 'note', 'never more than a note in member mode');
});
