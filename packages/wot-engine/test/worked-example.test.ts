/**
 * Worked example (A1 §10): the mid-game tick-20 resolution must produce the
 * exact next state given in the ruleset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTick, type MatchState, type TickActions } from '../src/index.ts';
import { workedExampleState } from './helpers.ts';

function cellOf(state: MatchState, unitId: string): [number, number] | null {
  const u = state.units.find((x) => x.unitId === unitId);
  return u ? [u.x, u.y] : null;
}
function hpOf(state: MatchState, unitId: string): number | null {
  const u = state.units.find((x) => x.unitId === unitId);
  return u ? u.hp : null;
}

test('A1 §10 tick 20 resolves to the documented start-of-tick-21 state', () => {
  const state = workedExampleState();
  const actions: TickActions = {
    A: [
      { unit_id: 'A-guard', verb: 'hold' },
      { unit_id: 'A-archer', verb: 'hold' },
      { unit_id: 'A-scout', verb: 'attack', target: [6, 4] },
      { unit_id: 'A-lancer', verb: 'move', steps: ['N'] },
    ],
    B: [
      { unit_id: 'B-lancer', verb: 'move', steps: ['S', 'S'] },
      { unit_id: 'B-archer', verb: 'move', steps: ['S', 'S'] },
      { unit_id: 'B-guard', verb: 'move', steps: ['S'] },
      { unit_id: 'B-scout', verb: 'attack', target: [7, 3] },
    ],
  };

  const next = resolveTick(state, actions);

  // Positions (A1 §10.6).
  assert.deepEqual(cellOf(next, 'A-guard'), [4, 4]);
  assert.deepEqual(cellOf(next, 'A-archer'), [2, 4]);
  assert.deepEqual(cellOf(next, 'A-scout'), [7, 3]);
  assert.deepEqual(cellOf(next, 'A-lancer'), [4, 3]);
  assert.deepEqual(cellOf(next, 'B-scout'), [6, 4]);
  assert.deepEqual(cellOf(next, 'B-lancer'), [5, 5]);
  assert.deepEqual(cellOf(next, 'B-archer'), [6, 5]);
  assert.deepEqual(cellOf(next, 'B-guard'), [4, 6]);

  // Combat: both scouts chipped 3 → 2 (A1 §10.5).
  assert.equal(hpOf(next, 'A-scout'), 2);
  assert.equal(hpOf(next, 'B-scout'), 2);

  // Scores: A 44+3 = 47, B 40+1 = 41 (A1 §10.5).
  assert.equal(next.scores.A, 47);
  assert.equal(next.scores.B, 41);

  // Allowances: A 150→147 (spends 3), B 130→123 (spends 7).
  assert.equal(next.remaining.A, 147);
  assert.equal(next.remaining.B, 123);
  assert.equal(next.spent.A, 93);
  assert.equal(next.spent.B, 117);

  // No deaths.
  assert.equal(next.units.length, 8);

  // The tick advanced.
  assert.equal(next.tick, 21);
});

test('A1 §11 edge case: mutual-bounce (contended + swap) and a whiff', () => {
  const state = workedExampleState();
  // Rebuild the §11 ground truth on the same board (scoring ignored here).
  state.units = [
    { unitId: 'A-lancer', owner: 'A', type: 'lancer', x: 3, y: 3, hp: 6 },
    { unitId: 'B-lancer', owner: 'B', type: 'lancer', x: 5, y: 3, hp: 6 },
    { unitId: 'A-archer', owner: 'A', type: 'archer', x: 1, y: 1, hp: 3 },
    { unitId: 'B-scout', owner: 'B', type: 'scout', x: 1, y: 2, hp: 3 },
    { unitId: 'A-guard', owner: 'A', type: 'guard', x: 4, y: 6, hp: 10 },
    { unitId: 'B-archer', owner: 'B', type: 'archer', x: 4, y: 4, hp: 3 },
  ];
  state.obstacles = [];

  const next = resolveTick(state, {
    A: [
      { unit_id: 'A-lancer', verb: 'move', steps: ['E'] },
      { unit_id: 'A-archer', verb: 'move', steps: ['N'] },
      { unit_id: 'A-guard', verb: 'move', steps: ['S'] },
    ],
    B: [
      { unit_id: 'B-lancer', verb: 'move', steps: ['W'] },
      { unit_id: 'B-scout', verb: 'move', steps: ['S'] },
      { unit_id: 'B-archer', verb: 'attack', target: [4, 6] },
    ],
  });

  // Contended (4,3): both lancers bounce, stay put.
  assert.deepEqual([next.units.find((u) => u.unitId === 'A-lancer')!.x, next.units.find((u) => u.unitId === 'A-lancer')!.y], [3, 3]);
  assert.deepEqual([next.units.find((u) => u.unitId === 'B-lancer')!.x, next.units.find((u) => u.unitId === 'B-lancer')!.y], [5, 3]);
  // Swap (1,1)<->(1,2): both bounce, stay put.
  assert.deepEqual([next.units.find((u) => u.unitId === 'A-archer')!.x, next.units.find((u) => u.unitId === 'A-archer')!.y], [1, 1]);
  assert.deepEqual([next.units.find((u) => u.unitId === 'B-scout')!.x, next.units.find((u) => u.unitId === 'B-scout')!.y], [1, 2]);
  // Guard moved (4,6)->(4,5); B-archer's attack at the vacated (4,6) whiffs.
  assert.deepEqual([next.units.find((u) => u.unitId === 'A-guard')!.x, next.units.find((u) => u.unitId === 'A-guard')!.y], [4, 5]);
  assert.equal(next.units.find((u) => u.unitId === 'A-guard')!.hp, 10); // undamaged (whiff)
  const whiff = next.events.find((e) => e.type === 'attack_whiff');
  assert.ok(whiff, 'a whiff event was emitted');
});

test('RPS math: Guard survives a Lancer melee and counters it to death over 2 ticks (A1 §2.1)', () => {
  const state = workedExampleState();
  state.units = [
    { unitId: 'A-guard', owner: 'A', type: 'guard', x: 4, y: 4, hp: 10 },
    { unitId: 'B-lancer', owner: 'B', type: 'lancer', x: 4, y: 5, hp: 6 },
  ];
  state.obstacles = [];
  state.corruptedRings = [];
  state.tick = 5;

  // Tick 1: Lancer hits Guard for 4 (10→6); Guard counters 3 (Lancer 6→3).
  const t1 = resolveTick(state, {
    A: [{ unit_id: 'A-guard', verb: 'hold' }],
    B: [{ unit_id: 'B-lancer', verb: 'attack', target: [4, 4] }],
  });
  assert.equal(t1.units.find((u) => u.unitId === 'A-guard')!.hp, 6);
  assert.equal(t1.units.find((u) => u.unitId === 'B-lancer')!.hp, 3);

  // Tick 2: Lancer 4 (Guard 6→2); Guard counter 3 (Lancer 3→0, dies).
  const t2 = resolveTick(t1, {
    A: [{ unit_id: 'A-guard', verb: 'hold' }],
    B: [{ unit_id: 'B-lancer', verb: 'attack', target: [4, 4] }],
  });
  assert.equal(t2.units.find((u) => u.unitId === 'A-guard')!.hp, 2);
  assert.ok(!t2.units.find((u) => u.unitId === 'B-lancer'), 'Lancer destroyed');
});
