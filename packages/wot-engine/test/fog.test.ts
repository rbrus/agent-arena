/**
 * Fog leakage (A1 §7, threat-model §3) — THE #1 security surface.
 *
 * Over the worked-example ambush, assert A's observation never contains any
 * cell/unit outside A's vision set, never reflects B's current-tick action, and
 * that its size/field-ordering do not correlate with hidden state (byte-for-byte
 * identical whether or not B's hidden strike force exists).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObservation,
  cheb,
  cloneState,
  createInitialState,
  ROSTER,
  type MatchState,
  type Player,
} from '../src/index.ts';
import { runScriptedMatch, workedExampleState } from './helpers.ts';

const NONCE = 'n_fogtest_0001';

/** V(P): cells within Chebyshev vision of at least one living unit owned by P. */
function visibleSet(state: MatchState, player: Player): Set<string> {
  const set = new Set<string>();
  for (const u of state.units) {
    if (u.owner !== player) continue;
    const v = ROSTER[u.type].vision;
    for (let x = 0; x < 9; x++) {
      for (let y = 0; y < 9; y++) {
        if (cheb(u.x, u.y, x, y) <= v) set.add(`${x},${y}`);
      }
    }
  }
  return set;
}
const visibleSetA = (state: MatchState): Set<string> => visibleSet(state, 'A');

test('worked example: A sees only B-scout; the 3-unit strike force is ABSENT', () => {
  const state = workedExampleState();
  const obs = buildObservation(state, 'A', 20, NONCE, 1500, 3000);

  // enemy_visible whitelist: exactly B-scout at (6,4), nothing else.
  assert.equal(obs.enemy_visible.length, 1);
  assert.equal(obs.enemy_visible[0].unit_id, 'B-scout');
  assert.deepEqual(obs.enemy_visible[0].cell, [6, 4]);

  // The hidden units leave NO trace anywhere in the frame (absence, not null).
  const json = JSON.stringify(obs);
  for (const hidden of ['B-lancer', 'B-archer', 'B-guard']) {
    assert.ok(!json.includes(hidden), `${hidden} must be absent from A's observation`);
  }
  // Their exact cells must not appear as enemy positions. (These coordinates are
  // outside V(A); confirm none leaked into enemy_visible.)
  for (const ev of obs.enemy_visible) {
    assert.ok(cheb(0, 0, 0, 0) === 0); // noop guard
    assert.notDeepEqual(ev.cell, [5, 7]);
    assert.notDeepEqual(ev.cell, [6, 7]);
    assert.notDeepEqual(ev.cell, [4, 7]);
  }
});

test('every enemy in enemy_visible is genuinely inside V(A); nothing outside leaks', () => {
  const state = workedExampleState();
  const V = visibleSetA(state);
  const obs = buildObservation(state, 'A', 20, NONCE, 1500, 3000);
  for (const ev of obs.enemy_visible) {
    assert.ok(V.has(`${ev.cell[0]},${ev.cell[1]}`), `${ev.unit_id} at ${ev.cell} must be in V(A)`);
  }
  // Every visible_cell is truly within A's vision.
  for (const c of obs.visible_cells ?? []) {
    assert.ok(V.has(`${c[0]},${c[1]}`));
  }
});

test('observation size/content does NOT correlate with hidden state (byte-identical)', () => {
  // Full state (B strike force present, all outside V(A)) vs. reduced state
  // (strike force removed). A's observation must be byte-for-byte identical.
  const full = workedExampleState();
  const reduced = workedExampleState();
  reduced.units = reduced.units.filter(
    (u) => !['B-lancer', 'B-archer', 'B-guard'].includes(u.unitId),
  );

  const obsFull = buildObservation(full, 'A', 20, NONCE, 1500, 3000);
  const obsReduced = buildObservation(reduced, 'A', 20, NONCE, 1500, 3000);
  assert.equal(JSON.stringify(obsFull), JSON.stringify(obsReduced));
});

test('moving a still-hidden enemy does not change A observation bytes', () => {
  const before = workedExampleState();
  const after = workedExampleState();
  // Move B-lancer (5,7)->(3,7): the whole y=7 row is outside V(A) (A's northmost
  // vision reaches y=6 via A-scout's radius-3 square), so it stays hidden.
  const bl = after.units.find((u) => u.unitId === 'B-lancer')!;
  bl.x = 3;
  const obsBefore = buildObservation(before, 'A', 20, NONCE, 1500, 3000);
  const obsAfter = buildObservation(after, 'A', 20, NONCE, 1500, 3000);
  assert.equal(JSON.stringify(obsBefore), JSON.stringify(obsAfter));
});

test('buildObservation cannot reflect the opponent current-tick action (no action input)', () => {
  // Structural guarantee: buildObservation takes (state, player, turn, nonce,
  // deadline, hardDeadline) — it never receives either player's pending action,
  // so it cannot leak commit-reveal state. Same state → same frame regardless.
  const state = workedExampleState();
  const o1 = buildObservation(state, 'A', 20, NONCE, 1500, 3000);
  const o2 = buildObservation(state, 'A', 20, NONCE, 1500, 3000);
  assert.equal(JSON.stringify(o1), JSON.stringify(o2));
  assert.equal(buildObservation.length, 6);
});

test('fog boundary: an enemy at the tightest hidden distance (vision+1) is ABSENT and byte-neutral', () => {
  // The `vision >= 1` invariant means an ADJACENT enemy (Chebyshev 1) is ALWAYS
  // visible, so the closest an enemy can be while still HIDDEN is exactly
  // vision+1 from the nearest own unit. Put A-guard (vision 1) alone and a B unit
  // at Chebyshev 2 — hidden by a single cell, the hardest case for an off-by-one.
  const base = createInitialState(99);
  base.obstacles = [];
  base.units = [{ unitId: 'A-guard', owner: 'A', type: 'guard', x: 1, y: 1, hp: 10 }];

  const withEnemy = cloneState(base);
  withEnemy.units = [
    ...base.units.map((u) => ({ ...u })),
    { unitId: 'B-lancer', owner: 'B', type: 'lancer', x: 1, y: 3, hp: 6 }, // cheb((1,1),(1,3))=2 > vision 1
  ];

  const obsBase = buildObservation(base, 'A', 0, NONCE, 1500, 3000);
  const obsWith = buildObservation(withEnemy, 'A', 0, NONCE, 1500, 3000);
  assert.equal(obsWith.enemy_visible.length, 0, 'the vision+1 enemy is hidden');
  assert.ok(!JSON.stringify(obsWith).includes('B-lancer'), 'no byte of the hidden enemy leaks');
  assert.equal(
    JSON.stringify(obsWith),
    JSON.stringify(obsBase),
    'a hidden boundary enemy must not change the observation bytes',
  );

  // One cell closer (Chebyshev 1, adjacent) → now inside vision → visible.
  const adj = cloneState(withEnemy);
  adj.units = adj.units.map((u) => (u.unitId === 'B-lancer' ? { ...u, y: 2 } : u));
  const obsAdj = buildObservation(adj, 'A', 0, NONCE, 1500, 3000);
  assert.equal(obsAdj.enemy_visible.length, 1);
  assert.equal(obsAdj.enemy_visible[0].unit_id, 'B-lancer');
  assert.deepEqual(obsAdj.enemy_visible[0].cell, [1, 2]);
});

test('full scripted match: the fog whitelist holds every tick, with V(P) RE-DERIVED from ground truth', () => {
  const m = runScriptedMatch(55501);
  assert.ok(m.states.length > 10, 'a real multi-tick match ran');
  for (let i = 0; i < m.states.length; i++) {
    const state = m.states[i];
    const { A: obsA, B: obsB } = m.observations[i];
    for (const [player, obs] of [
      ['A', obsA],
      ['B', obsB],
    ] as const) {
      const enemy: Player = player === 'A' ? 'B' : 'A';
      const V = visibleSet(state, player); // re-derived from the authoritative state
      const shown = new Set(obs.enemy_visible.map((e) => e.unit_id));
      const ownIds = new Set(obs.you.units.map((u) => u.unit_id));
      const json = JSON.stringify(obs);

      for (const u of state.units) {
        if (u.owner !== enemy) continue;
        const inV = V.has(`${u.x},${u.y}`);
        if (inV) {
          // Every enemy inside V(P) is shown, at its true cell.
          assert.ok(shown.has(u.unitId), `${player}: visible enemy ${u.unitId} must be shown at tick ${state.tick}`);
          const view = obs.enemy_visible.find((e) => e.unit_id === u.unitId)!;
          assert.deepEqual(view.cell, [u.x, u.y]);
        } else {
          // Every enemy OUTSIDE V(P) is absent — no id, no byte anywhere.
          assert.ok(!shown.has(u.unitId), `${player}: hidden enemy ${u.unitId} must be absent at tick ${state.tick}`);
          assert.ok(!json.includes(u.unitId), `${player}: no byte of hidden ${u.unitId} may leak`);
        }
      }
      // Every shown enemy is genuinely inside V(P); never an own unit.
      for (const ev of obs.enemy_visible) {
        assert.ok(V.has(`${ev.cell[0]},${ev.cell[1]}`), `${player}: shown ${ev.unit_id} must be in V`);
        assert.ok(!ownIds.has(ev.unit_id));
      }
    }
  }
});
