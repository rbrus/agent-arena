/**
 * Policy unit tests (node:test).
 *
 * Assert the scripted policies produce contract-valid actions that echo the
 * anti-replay fields, and that the hunter's RPS heuristic picks the favourable
 * in-range target. Validation uses the real `wot-contracts` AJV validators, so a
 * drift between a policy and the action schema fails the build.
 *
 * Run:  node --test --import tsx agents/test/policy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validators } from 'wot-contracts';
import type { Observation } from 'wot-contracts';
import { reflexPolicy } from '../reflex/policy.ts';
import { createHunterPolicy } from '../hunter/policy.ts';
import { createHouseBot } from '../house-bot/policy.ts';

const MID = 'mat_01J8ZK9QMR4T7V2X0PABCDE3FG';
const NONCE = 'n_unit_test_0001';

type Unit = { unit_id: string; type: 'scout' | 'lancer' | 'archer' | 'guard'; cell: [number, number]; hp: number; max_hp: number };

function makeObs(units: Unit[], enemyVisible: Unit[], extra: Record<string, unknown> = {}): Observation {
  const o = {
    t: 'observation',
    protocol_version: '1.0',
    match_id: MID,
    turn_id: 20,
    nonce: NONCE,
    deadline_ms: 1500,
    hard_deadline_ms: 3000,
    phase: 'grid_tactics',
    you: { player_id: 'A', ascension_points: 0, action_tokens_remaining: 240, action_tokens_spent: 0, units },
    enemy_visible: enemyVisible,
    objectives: [
      { id: 'nexus', cell: [4, 4], controller: 'none' },
      { id: 'relay_w', cell: [2, 4], controller: 'none' },
      { id: 'relay_e', cell: [6, 4], controller: 'none' },
    ],
    scoreboard: { A: { points: 0, tokens_remaining: 240 }, B: { points: 0, tokens_remaining: 240 }, ticks_remaining: 100 },
    collapse: { active: false, corrupted_rings: [], next_ring_tick: 80 },
    ...extra,
  };
  // The fixture itself must be a contract-valid observation.
  assert.ok(validators.observation(o), `crafted observation invalid: ${JSON.stringify(validators.observation.errors)}`);
  return o as unknown as Observation;
}

function assertValidEcho(action: unknown, obs: Observation): void {
  assert.ok(validators.action(action), `action invalid: ${JSON.stringify(validators.action.errors)}`);
  const a = action as { turn_id: number; nonce: string; match_id: string };
  assert.equal(a.turn_id, obs.turn_id, 'echoes turn_id');
  assert.equal(a.nonce, obs.nonce, 'echoes nonce');
  assert.equal(a.match_id, obs.match_id, 'echoes match_id');
}

test('reflex: returns a schema-valid action that echoes turn_id + nonce + match_id', () => {
  const obs = makeObs([{ unit_id: 'A-scout', type: 'scout', cell: [4, 1], hp: 3, max_hp: 3 }], [], {
    reachable: { 'A-scout': [[4, 2], [3, 1], [5, 1]] },
  });
  assertValidEcho(reflexPolicy(obs), obs);
});

test('reflex: attacks a target that is in range', () => {
  const obs = makeObs(
    [{ unit_id: 'A-lancer', type: 'lancer', cell: [4, 3], hp: 6, max_hp: 6 }],
    [{ unit_id: 'B-archer', type: 'archer', cell: [4, 4], hp: 3, max_hp: 3 }],
    { attacks: { 'A-lancer': [[4, 4]] } },
  );
  const action = reflexPolicy(obs);
  assertValidEcho(action, obs);
  assert.equal(action.units.length, 1);
  assert.deepEqual(action.units[0], { unit_id: 'A-lancer', verb: 'attack', target: [4, 4] });
});

test('reflex: steps toward the nearest objective when nothing is in range', () => {
  const obs = makeObs([{ unit_id: 'A-scout', type: 'scout', cell: [4, 1], hp: 3, max_hp: 3 }], [], {
    reachable: { 'A-scout': [[4, 2], [3, 1], [5, 1]] },
  });
  const action = reflexPolicy(obs);
  assertValidEcho(action, obs);
  const a = action.units[0];
  assert.ok(a, 'a unit action was produced');
  assert.equal(a.verb, 'move');
  if (a.verb === 'move') assert.equal(a.steps[0], 'N', `expected a northward step toward the Nexus, got ${JSON.stringify(a)}`);
});

test('hunter: prefers the in-range favourable target (attacks the Archer, not the Guard)', () => {
  const obs = makeObs(
    [{ unit_id: 'A-lancer', type: 'lancer', cell: [4, 3], hp: 6, max_hp: 6 }],
    [
      { unit_id: 'B-guard', type: 'guard', cell: [3, 3], hp: 10, max_hp: 10 }, // Lancer LOSES this (counter)
      { unit_id: 'B-archer', type: 'archer', cell: [4, 4], hp: 3, max_hp: 3 }, // Lancer BEATS this
    ],
    { attacks: { 'A-lancer': [[3, 3], [4, 4]] } },
  );
  const action = createHunterPolicy()(obs);
  assertValidEcho(action, obs);
  assert.equal(action.units.length, 1);
  const a = action.units[0];
  assert.ok(a, 'a unit action was produced');
  assert.equal(a.verb, 'attack');
  if (a.verb === 'attack') assert.ok(a.target[0] === 4 && a.target[1] === 4, `expected the Archer at [4,4], got ${JSON.stringify(a)}`);
});

test('hunter: does NOT dive a Guard when only an unfavourable melee is offered', () => {
  const obs = makeObs(
    [{ unit_id: 'A-lancer', type: 'lancer', cell: [4, 3], hp: 6, max_hp: 6 }],
    [{ unit_id: 'B-guard', type: 'guard', cell: [4, 4], hp: 10, max_hp: 10 }],
    { attacks: { 'A-lancer': [[4, 4]] }, reachable: { 'A-lancer': [[4, 2], [3, 3], [5, 3], [4, 1]] } },
  );
  const action = createHunterPolicy()(obs);
  assertValidEcho(action, obs);
  // It must refuse the losing melee trade into the Guard's counter.
  const a = action.units[0];
  if (a && a.verb === 'attack') {
    assert.ok(!(a.target[0] === 4 && a.target[1] === 4), 'hunter should not attack into the Guard counter');
  }
});

test('house-bot: every tier emits a contract-valid action', () => {
  const obs = makeObs(
    [
      { unit_id: 'A-guard', type: 'guard', cell: [4, 2], hp: 10, max_hp: 10 },
      { unit_id: 'A-archer', type: 'archer', cell: [2, 2], hp: 3, max_hp: 3 },
    ],
    [{ unit_id: 'B-lancer', type: 'lancer', cell: [4, 5], hp: 6, max_hp: 6 }],
    {
      reachable: { 'A-guard': [[4, 3], [3, 2], [5, 2]], 'A-archer': [[2, 3], [1, 2], [3, 2]] },
      attacks: {},
    },
  );
  for (const tier of ['bronze', 'silver', 'gold'] as const) {
    const action = createHouseBot(tier)(obs);
    assertValidEcho(action, obs);
  }
});
