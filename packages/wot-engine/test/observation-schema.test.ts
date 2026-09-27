/**
 * Every buildObservation output validates against the wot-contracts observation
 * validator (single source of truth) and respects the frame byte cap (A1 §7.6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxBytes, validators } from 'wot-contracts';
import { buildObservation } from '../src/index.ts';
import { runScriptedMatch, workedExampleState } from './helpers.ts';

test('worked-example observations (both players) validate against the schema', () => {
  const state = workedExampleState();
  for (const player of ['A', 'B'] as const) {
    const obs = buildObservation(state, player, 20, 'n_00000000abcd', 1500, 3000);
    const ok = validators.observation(obs);
    assert.ok(ok, `observation invalid: ${JSON.stringify(validators.observation.errors)}`);
  }
});

test('every observation across a full scripted match validates + is within the byte cap', () => {
  const m = runScriptedMatch(778899);
  const cap = maxBytes('observation');
  let checked = 0;
  for (const { A, B } of m.observations) {
    for (const obs of [A, B]) {
      const ok = validators.observation(obs);
      assert.ok(ok, `invalid observation: ${JSON.stringify(validators.observation.errors)}`);
      const bytes = Buffer.byteLength(JSON.stringify(obs), 'utf8');
      assert.ok(bytes <= cap, `observation ${bytes}B exceeds cap ${cap}B`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'the scripted match produced observations');
});

test('observation with an empty enemy_visible array still validates (absence, not null)', () => {
  const state = workedExampleState();
  // Remove all B units → A sees no enemies; enemy_visible must be [] (not null).
  state.units = state.units.filter((u) => u.owner === 'A');
  const obs = buildObservation(state, 'A', 20, 'n_00000000abcd', 1500, 3000);
  assert.deepEqual(obs.enemy_visible, []);
  assert.ok(validators.observation(obs), JSON.stringify(validators.observation.errors));
});
