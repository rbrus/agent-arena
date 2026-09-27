/**
 * The `extended` budget tier (contracts 2.10.0; Architect ruling 2026-09-27, replacing the
 * reserved-and-refused `league`): Dh 30000 ms by ruling, the other dials by the rules that hold
 * across edge / core / frontier (Ds = Dh / 2; allowance ×1.5 per tier step; Diplomacy R 3 and the
 * frontier press quotas, capped by the structural press batch of 12). No anchor is frozen at
 * `extended`: it is outside every frozen-anchor check (ANCHORED_TIER_IDS).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIP_PRESS_QUOTAS, dipInit } from 'wot-engine';
import {
  anchorFor,
  ANCHORED_TIER_IDS,
  BUDGET_TIERS,
  evalValidators,
  runEpisode,
  SELF_TESTS,
  TIER_IDS,
  tierOf,
  toEpisodeResult,
} from '../src/index.ts';

const KEY = '7e'.repeat(32);

test('extended: the fixed dials (Ds 15000, Dh 30000, allowance 540) and the structural ones as in every tier', () => {
  assert.deepEqual([...TIER_IDS], ['edge', 'core', 'frontier', 'extended']);
  assert.deepEqual([...ANCHORED_TIER_IDS], ['edge', 'core', 'frontier']);
  const x = tierOf('extended');
  assert.deepEqual({ ...x }, { id: 'extended', softDeadlineMs: 15000, hardDeadlineMs: 30000, hardMissForfeit: 3, actionAllowance: 540, tickCap: 120, maxInboundFrameBytes: 8192 });
  assert.throws(() => tierOf('league' as never), /unknown budget tier: league/);
});

test('extended: derived by the rules that hold across edge, core and frontier', () => {
  for (const id of TIER_IDS) assert.equal(BUDGET_TIERS[id].softDeadlineMs * 2, BUDGET_TIERS[id].hardDeadlineMs, `${id}: Ds = Dh / 2`);
  for (let i = 1; i < TIER_IDS.length; i++) {
    assert.equal(BUDGET_TIERS[TIER_IDS[i]].actionAllowance, BUDGET_TIERS[TIER_IDS[i - 1]].actionAllowance * 1.5, `${TIER_IDS[i]}: allowance ×1.5 per step`);
  }
  // Diplomacy: R saturates at 3; one more doubling of the press quotas (24 per round) would exceed the batch cap of 12.
  assert.deepEqual({ ...DIP_PRESS_QUOTAS.extended }, { ...DIP_PRESS_QUOTAS.frontier });
  assert.equal(DIP_PRESS_QUOTAS.frontier.msgsPerRound * 2 > 12, true);
  assert.equal(dipInit(1, 'extended').config.pressRounds, 3);
});

test('extended: no frozen anchor exists, and anchor lookups at extended find none', () => {
  assert.equal(SELF_TESTS.filter((c) => c.tier === 'extended').length, 0);
  assert.equal(anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'extended', seed: 20260720, policy: 'coordinated' }), undefined);
});

test('extended: a raid and a duel run at the tier; the EpisodeResult is contract-valid with tier extended and allowance 540 per seat', () => {
  const raid = runEpisode('byzantine', 20260720, 'extended', { mode: 'squad', targetDriver: 'ref:coordinated', blindingKey: KEY });
  assert.equal(raid.terminal()!.outcome, 'clear');
  const er = toEpisodeResult(raid.record(), { episodeIndex: 0 });
  assert.ok(evalValidators.episode_result(er), JSON.stringify(evalValidators.episode_result.errors?.slice(0, 3)));
  assert.equal(er.budget.tier, 'extended');
  assert.equal(er.budget.tokens_allowance, 540 * 5, 'squad: five controlled seats');
  // Same outcome and tick as the frozen Core anchor (only `remaining`, which is hashed, differs by tier).
  const core = anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'core', seed: 20260720, policy: 'coordinated' })!;
  assert.equal(raid.terminal()!.outcome, core.outcome);
  assert.notEqual(raid.replayHash(), core.replayHash);
  const duel = runEpisode('grid_tactics', 2, 'extended', { mode: 'duel', targetSeat: 'A', targetDriver: 'ref:reflex', blindingKey: KEY });
  const der = toEpisodeResult(duel.record(), { episodeIndex: 1 });
  assert.ok(evalValidators.episode_result(der), JSON.stringify(evalValidators.episode_result.errors?.slice(0, 3)));
  assert.equal(der.budget.tokens_allowance, 540);
});
