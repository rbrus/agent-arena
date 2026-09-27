/**
 * Determinism (A1 §8.4): same seed + same action sequence → identical state
 * hashes every tick, bit-for-bit; and re-simulation reproduces the whole chain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateObstacles, resimulate, rho, ring, cellsInRing } from '../src/index.ts';
import { runScriptedMatch } from './helpers.ts';

test('same seed + same action sequence → identical per-tick hashes, bit-for-bit', () => {
  const a = runScriptedMatch(123456789);
  const b = runScriptedMatch(123456789);
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(a.replayHash, b.replayHash);
  assert.equal(a.finalState.tick, b.finalState.tick);
  // The chain is a proper sha256:<hex>.
  assert.match(a.replayHash, /^sha256:[0-9a-f]{64}$/);
});

test('different seeds diverge (the seed actually matters)', () => {
  const a = runScriptedMatch(1);
  const b = runScriptedMatch(2);
  assert.notEqual(a.replayHash, b.replayHash);
});

test('resimulate(seed, inputs) reproduces every hash bit-for-bit', () => {
  const m = runScriptedMatch(987654321);
  const resim = resimulate(987654321, m.inputs);
  assert.deepEqual(resim.perTickHashes, m.hashes);
  assert.equal(resim.replayHash, m.replayHash);
  // Re-running the resim itself is stable.
  const resim2 = resimulate(987654321, m.inputs);
  assert.equal(resim2.replayHash, resim.replayHash);
});

test('obstacle generator: deterministic, 8 cells, 180°-symmetric, seed-varying', () => {
  const o1 = generateObstacles(42);
  const o2 = generateObstacles(42);
  assert.deepEqual(o1, o2);
  assert.equal(o1.length, 8);
  // Rotational symmetry: every obstacle's ρ-image is also an obstacle.
  const set = new Set(o1.map(([x, y]) => `${x},${y}`));
  for (const c of o1) {
    const [mx, my] = rho(c);
    assert.ok(set.has(`${mx},${my}`), `mirror of ${c} present`);
  }
  // Never on an objective / centre.
  assert.ok(!set.has('4,4'));
  // A different seed yields a different field (with overwhelming probability).
  assert.notDeepEqual(generateObstacles(43), o1);
});

test('ring geometry: ring 4 is the Nexus alone; ring 0 is the border', () => {
  assert.equal(ring(4, 4), 4);
  assert.deepEqual(cellsInRing(4), [[4, 4]]);
  assert.equal(cellsInRing(0).length, 9 * 9 - 7 * 7); // outer border = 32 cells
});
