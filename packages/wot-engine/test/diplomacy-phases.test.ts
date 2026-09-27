/**
 * Phase machine and order-set rules (design §1.4, §1.5.3 step 4–5, §3.4;
 * supplementary sections X.S and X.N).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isParseError, parseOrder } from '../src/diplomacy/parse.ts';
import { adjudicate, initialState, normalise, standardCenters } from '../src/diplomacy/state.ts';
import type { DipState, Power, RawOrder, Submissions, Unit } from '../src/diplomacy/types.ts';

const subs = (o: Partial<Record<Power, string[]>>): Submissions => {
  const s: Partial<Record<Power, RawOrder[]>> = {};
  for (const [p, l] of Object.entries(o)) s[p as Power] = l!.map((x) => parseOrder(x) as RawOrder);
  return s;
};
const board = (units: Unit[], extra: Partial<DipState> = {}): DipState =>
  normalise({ ruleset: 'wot-dip/1', year: 1901, season: 'S', phase: 'M', units, dislodged: [], sc: standardCenters(), ...extra });
const phaseOf = (s: DipState): string => `${s.season}${s.year}${s.phase}`;

test('X.S: spring occupation does not change ownership; fall does; no dislodgement skips R', () => {
  let s = initialState();
  s = adjudicate(s, subs({ russia: ['A war - gal', 'F sev - rum'] })).next;
  assert.equal(phaseOf(s), 'F1901M');
  assert.equal(s.sc.rum, null);
  const out = adjudicate(s, subs({}));
  assert.equal(out.next.sc.rum, 'russia');
  assert.ok(out.events.some((e) => e.kind === 'sc_changed' && e.province === 'rum'));
  assert.equal(phaseOf(out.next), 'W1901A', 'russia has a build on an empty home centre (war)');
});

test('X.S: the adjustment phase is skipped when nobody can adjust', () => {
  const out = adjudicate({ ...initialState(), season: 'F' }, subs({}));
  assert.equal(phaseOf(out.next), 'S1902M');
});

test('X.S: a power with +delta but no free home centre does not force an adjustment phase', () => {
  const s = board(
    [
      { power: 'russia', type: 'A', at: 'mos' },
      { power: 'russia', type: 'A', at: 'war' },
      { power: 'russia', type: 'F', at: 'sev' },
      { power: 'russia', type: 'F', at: 'stp/sc' },
      { power: 'russia', type: 'A', at: 'rum' },
    ],
    { season: 'F', sc: { ...standardCenters(), rum: 'russia', swe: 'russia' } },
  );
  // Russia: delta = 6 − 5 = +1 but every Russian home centre is occupied.
  const out = adjudicate(s, subs({}));
  assert.equal(phaseOf(out.next), 'W1901A', 'the other powers have empty home centres, so they can build');
  const lonely = board(s.units as Unit[], { season: 'F', sc: Object.fromEntries(Object.entries(s.sc).map(([k, v]) => [k, v === 'russia' ? v : null])) });
  assert.equal(phaseOf(adjudicate(lonely, subs({})).next), 'S1902M');
});

test('X.N: NMR — units hold, dislodged units are disbanded, builds are waived', () => {
  const s = board([
    { power: 'austria', type: 'A', at: 'vie' },
    { power: 'italy', type: 'A', at: 'tyr' },
    { power: 'italy', type: 'A', at: 'tri' },
  ]);
  const m = adjudicate(s, subs({ italy: ['A tyr - vie', 'A tri S A tyr - vie'] }));
  assert.equal(phaseOf(m.next), 'S1901R');
  const r = adjudicate(m.next, subs({}));
  assert.ok(r.events.some((e) => e.kind === 'retreat_disbanded'));
  assert.deepEqual(r.next.units.map((u) => u.at), ['tri', 'vie']);
});

test('X.N 4.D.3: two different orders for one unit are superseded and the unit holds (and can be supported)', () => {
  const s = board([
    { power: 'germany', type: 'A', at: 'mun' },
    { power: 'germany', type: 'A', at: 'ber' },
    { power: 'france', type: 'A', at: 'bur' },
    { power: 'france', type: 'A', at: 'ruh' },
  ]);
  const out = adjudicate(s, subs({ germany: ['A mun - boh', 'A mun - tyr', 'A ber S A mun'], france: ['A bur - mun', 'A ruh S A bur - mun'] }));
  const statuses = out.legal.report.filter((r) => r.power === 'germany').map((r) => r.status);
  assert.deepEqual(statuses, ['superseded', 'superseded', 'used']);
  assert.ok(out.next.units.some((u) => u.at === 'mun' && u.power === 'germany'), 'supported hold stands');
});

test('X.N 4.D.9: hold support to a unit in civil disorder (no orders) is valid', () => {
  const s = board([
    { power: 'austria', type: 'A', at: 'vie' },
    { power: 'germany', type: 'A', at: 'boh' },
    { power: 'italy', type: 'A', at: 'tyr' },
    { power: 'italy', type: 'A', at: 'tri' },
  ]);
  const out = adjudicate(s, subs({ germany: ['A boh S A vie'], italy: ['A tyr - vie', 'A tri S A tyr - vie'] }));
  assert.ok(out.results.some((r) => r.order === 'A boh S A vie' && r.result === 'success'));
  assert.equal(out.next.dislodged.length, 0);
});

test('X.N: orders beyond the 64-order cap are illegal (too_many_orders)', () => {
  const many = Array.from({ length: 70 }, () => 'A par H');
  const out = adjudicate(initialState(), subs({ france: many }));
  const fr = out.legal.report.filter((r) => r.power === 'france');
  assert.equal(fr.filter((r) => r.reason === 'too_many_orders').length, 6);
});

test('X.N: waive consumes a build slot; builds beyond the delta fail', () => {
  const s = board([], { season: 'W', phase: 'A', sc: { ...Object.fromEntries(Object.keys(standardCenters()).map((k) => [k, null])), mos: 'russia', war: 'russia' } });
  const out = adjudicate(s, subs({ russia: ['W', 'B A mos', 'B A war'] }));
  assert.deepEqual(out.results.map((r) => r.result), ['success', 'success', 'failure']);
  assert.deepEqual(out.next.units.map((u) => u.at), ['mos']);
  assert.ok(!isParseError(parseOrder('W')));
});
