/**
 * Standard map invariants (design §1.2, fixture section X.M), the pinned
 * MAP_DIGEST, and the diplomacy/ import-boundary scan (design §0).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMY_EDGES, FLEET_EDGES, PROVINCES } from '../src/diplomacy/map-data.ts';
import {
  MAP,
  MAP_DIGEST,
  armyNeighbours,
  canArmyOccupy,
  canFleetOccupy,
  fleetNeighbours,
  provinceOf,
  reach,
  unionDistance,
} from '../src/diplomacy/map.ts';
import { POWERS } from '../src/diplomacy/types.ts';

/**
 * Pinned after the hand-entered map passed every DATC case. Any edit to
 * map-data.ts must change this value in the same, reviewed commit.
 */
const PINNED_MAP_DIGEST = 'sha256:70564c4aaaa4bcea179d6e03647a24d09369496f9c99b866ccdfb89233f119a6';

test('MAP_DIGEST is pinned', () => {
  assert.equal(MAP_DIGEST, PINNED_MAP_DIGEST);
});

test('75 provinces: 19 sea, 14 inland, 42 coastal; sorted, unique', () => {
  assert.equal(PROVINCES.length, 75);
  const count = (k: string): number => PROVINCES.filter((p) => p.kind === k).length;
  assert.deepEqual([count('sea'), count('inland'), count('coastal')], [19, 14, 42]);
  const ids = PROVINCES.map((p) => p.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, 75);
  for (const id of ids) assert.match(id, /^[a-z]{3}$/);
});

test('34 supply centres, 22 home centres (3 per power, 4 for Russia), none at sea', () => {
  assert.equal(PROVINCES.filter((p) => p.sc).length, 34);
  assert.equal(PROVINCES.filter((p) => p.home).length, 22);
  for (const power of POWERS) {
    assert.equal(PROVINCES.filter((p) => p.home === power).length, power === 'russia' ? 4 : 3, power);
  }
  for (const p of PROVINCES) {
    if (p.home) assert.ok(p.sc, `${p.id} home but not SC`);
    if (p.sc) assert.notEqual(p.kind, 'sea');
  }
});

test('exactly three split-coast provinces with the design coast table', () => {
  const split = PROVINCES.filter((p) => p.coasts.length > 0).map((p) => [p.id, [...p.coasts]]);
  assert.deepEqual(split, [
    ['bul', ['ec', 'sc']],
    ['spa', ['nc', 'sc']],
    ['stp', ['nc', 'sc']],
  ]);
  assert.deepEqual(fleetNeighbours('spa/nc'), ['gas', 'mao', 'por']);
  assert.deepEqual(fleetNeighbours('spa/sc'), ['lyo', 'mao', 'mar', 'por', 'wes']);
  assert.deepEqual(fleetNeighbours('stp/nc'), ['bar', 'nwy']);
  assert.deepEqual(fleetNeighbours('stp/sc'), ['bot', 'fin', 'lvn']);
  assert.deepEqual(fleetNeighbours('bul/ec'), ['bla', 'con', 'rum']);
  assert.deepEqual(fleetNeighbours('bul/sc'), ['aeg', 'con', 'gre']);
  assert.deepEqual(fleetNeighbours('spa'), [], 'the bare id of a split-coast province has no fleet edges');
});

test('78 nodes (75 − 3 + 6)', () => {
  assert.equal(MAP.nodes.length, 78);
  assert.deepEqual([...MAP.nodes], [...MAP.nodes].sort());
});

test('edge lists: canonical (a < b, sorted), no duplicates, no self edges, correct endpoints', () => {
  for (const [name, edges] of [
    ['army', ARMY_EDGES],
    ['fleet', FLEET_EDGES],
  ] as const) {
    const keys = edges.map(([a, b]) => `${a}|${b}`);
    assert.deepEqual(keys, [...keys].sort(), `${name} edges sorted`);
    assert.equal(new Set(keys).size, keys.length, `${name} edges unique`);
    for (const [a, b] of edges) {
      assert.ok(a < b, `${name} ${a}-${b} ordered`);
      assert.notEqual(provinceOf(a), provinceOf(b));
    }
  }
  for (const [a, b] of ARMY_EDGES) assert.ok(canArmyOccupy(a) && canArmyOccupy(b), `army edge ${a}-${b}`);
  for (const [a, b] of FLEET_EDGES) assert.ok(canFleetOccupy(a) && canFleetOccupy(b), `fleet edge ${a}-${b}`);
  // Every coastal province touches the sea; every sea touches only fleet nodes.
  for (const p of PROVINCES) {
    if (p.kind === 'coastal') {
      const nodes = p.coasts.length ? p.coasts.map((c) => `${p.id}/${c}`) : [p.id];
      for (const n of nodes) assert.ok(fleetNeighbours(n).length > 0, `${n} has fleet neighbours`);
      assert.ok(armyNeighbours(p.id).length > 0, `${p.id} has army neighbours`);
    }
    if (p.kind === 'inland') assert.equal(fleetNeighbours(p.id).length, 0);
    if (p.kind === 'sea') assert.equal(armyNeighbours(p.id).length, 0);
  }
});

test('DATC section 4 geography notes', () => {
  assert.ok(armyNeighbours('nwy').includes('stp'), 'nwy–stp army edge');
  assert.ok(fleetNeighbours('nwy').includes('stp/nc'), 'nwy–stp/nc fleet edge');
  assert.ok(!fleetNeighbours('nwy').includes('stp/sc'));
  assert.ok(fleetNeighbours('lvp').includes('nao'), 'lvp–nao fleet edge');
  assert.ok(!fleetNeighbours('cly').includes('iri') && !armyNeighbours('cly').includes('iri'), 'cly–iri not an edge');
});

test('support reach and union distance', () => {
  assert.deepEqual(reach('F', 'rom'), ['nap', 'tus', 'tys']);
  assert.ok(!reach('F', 'spa/nc').includes('lyo'));
  assert.ok(reach('F', 'mar').includes('spa'));
  assert.equal(unionDistance('gre', new Set(['nap'])), 2); // 6.J.10: over water
  assert.equal(unionDistance('war', new Set(['war'])), 0);
});

test('the union graph is connected', () => {
  const seen = new Set<string>(['adr']);
  const queue = ['adr'];
  const inf = 1_000_000;
  while (queue.length) {
    const p = queue.shift()!;
    for (const q of PROVINCES.map((x) => x.id)) {
      if (!seen.has(q) && unionDistance(p, new Set([q])) === 1) {
        seen.add(q);
        queue.push(q);
      }
    }
  }
  assert.equal(seen.size, 75);
  assert.ok(unionDistance('adr', new Set(['bar'])) < inf);
});

test('import boundary: diplomacy/ imports only diplomacy/, ../hash.ts, ../rng.ts and node:crypto', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../src/diplomacy');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);
  const bad: string[] = [];
  for (const f of files) {
    const depth = f.slice(root.length + 1).split('/').length - 1; // 0 = diplomacy/, 1 = diplomacy/datc/
    const up = '../'.repeat(depth);
    for (const m of readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)) {
      const spec = m[1];
      const ok =
        spec === 'node:crypto' ||
        spec === `${up}../hash.ts` ||
        spec === `${up}../rng.ts` ||
        (spec.startsWith('./') && depth === 0) ||
        (depth > 0 && (spec.startsWith('./') || (spec.startsWith('../') && !spec.startsWith(`${up}../`))));
      if (!ok) bad.push(`${f.slice(root.length + 1)}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});
