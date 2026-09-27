/**
 * Order grammar (design §1.5.1, fixture section X.P): accepted and rejected
 * vectors, the formatRaw/parseOrder round-trip, and the JSON form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.ts';
import { MAP } from '../src/diplomacy/map.ts';
import { formatRaw } from '../src/diplomacy/orders.ts';
import { isParseError, parseOrder, rawFromJson } from '../src/diplomacy/parse.ts';
import type { RawOrder } from '../src/diplomacy/types.ts';

const ACCEPTED = [
  'A par - bur',
  'F spa/nc - mao',
  'A lvp - edi VIA',
  'A mun S A bur - par',
  'F por S F mao - spa/nc',
  'F bla S A rum',
  'F nth C A yor - nwy',
  'A pic R bel',
  'F kie D',
  'B F stp/nc',
  'W',
  'par H',
  'A pru S lvn - pru',
  'F ska C den - nwy',
  'A mun S germany A bur - par',
  'F nth C england A yor - nwy',
  'F bre/nc - mao',
  'A gas - spa/nc',
  'F gas - spa/wc',
];

const REJECTED: [string, string][] = [
  ['a par h', 'bad_token'],
  ['A Paris - Burgundy', 'bad_token'],
  ['A yor - nth - bel', 'trailing_tokens'],
  ['A par  - bur', 'bad_whitespace'],
  [' A par H', 'bad_whitespace'],
  ['A par H ', 'bad_whitespace'],
  ['A par\t- bur', 'non_ascii'],
  ['A pаr H', 'non_ascii'],
  ['A xyz H', 'unknown_province'],
  ['F bre/xx - mao', 'unknown_coast'],
  ['A par', 'bad_token'],
  ['B par', 'bad_token'],
  ['A par - bur via', 'trailing_tokens'],
  ['F nth C A yor', 'bad_token'],
  ['', 'empty'],
  ['A par - bur '.repeat(6), 'too_long'],
  ['W W', 'trailing_tokens'],
];

test('accepted vectors parse and round-trip exactly', () => {
  for (const s of ACCEPTED) {
    const r = parseOrder(s);
    assert.ok(!isParseError(r), `${s}: ${JSON.stringify(r)}`);
    assert.equal(formatRaw(r as RawOrder), s);
  }
});

test('rejected vectors give the expected parse error code', () => {
  for (const [s, code] of REJECTED) {
    const r = parseOrder(s);
    assert.ok(isParseError(r), `${JSON.stringify(s)} should be rejected`);
    assert.equal((r as { error: string }).error, code, JSON.stringify(s));
  }
  assert.equal((parseOrder(42) as { error: string }).error, 'not_string');
});

test('property: parseOrder(formatRaw(x)) deep-equals x for random well-formed orders', () => {
  const rng = mulberry32(20260926);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
  const provs = MAP.provinces.map((p) => p.id);
  const loc = () => (rng() < 0.2 ? { p: pick(provs), coast: pick(['nc', 'sc', 'ec', 'wc'] as const) } : { p: pick(provs) });
  const type = () => (rng() < 0.3 ? {} : { type: pick(['A', 'F'] as const) });
  const who = () => ({
    ...(rng() < 0.2 ? { ofPower: pick(['austria', 'turkey'] as const) } : {}),
    ...(rng() < 0.5 ? { ofType: pick(['A', 'F'] as const) } : {}),
    of: loc(),
  });
  for (let i = 0; i < 2000; i++) {
    const k = pick(['hold', 'move', 'support', 'supportmove', 'convoy', 'retreat', 'disband', 'build', 'waive'] as const);
    let o: RawOrder;
    switch (k) {
      case 'hold': o = { k: 'hold', ...type(), at: loc() }; break;
      case 'move': o = { k: 'move', ...type(), at: loc(), to: loc(), via: rng() < 0.3 }; break;
      case 'support': o = { k: 'support', ...type(), at: loc(), ...who() }; break;
      case 'supportmove': o = { k: 'support', ...type(), at: loc(), ...who(), to: loc() }; break;
      case 'convoy': o = { k: 'convoy', ...type(), at: loc(), ...who(), to: loc() }; break;
      case 'retreat': o = { k: 'retreat', ...type(), at: loc(), to: loc() }; break;
      case 'disband': o = { k: 'disband', ...type(), at: loc() }; break;
      case 'build': o = { k: 'build', type: pick(['A', 'F'] as const), at: loc() }; break;
      default: o = { k: 'waive' };
    }
    const text = formatRaw(o);
    if (text.length > 64) continue;
    assert.deepEqual(parseOrder(text), o, text);
  }
});

test('JSON form: same validator as text; unknown keys rejected', () => {
  assert.deepEqual(rawFromJson({ k: 'move', type: 'A', at: { p: 'par' }, to: { p: 'bur' } }), parseOrder('A par - bur'));
  assert.deepEqual(
    rawFromJson({ k: 'support', at: { p: 'mun' }, ofType: 'A', of: { p: 'bur' }, to: { p: 'par' } }),
    parseOrder('mun S A bur - par'),
  );
  assert.deepEqual(rawFromJson({ k: 'build', type: 'F', at: { p: 'stp', coast: 'nc' } }), parseOrder('B F stp/nc'));
  assert.deepEqual(rawFromJson('F kie D'), parseOrder('F kie D'));
  for (const bad of [
    { k: 'move', at: { p: 'par' }, to: { p: 'bur' }, evil: 1 },
    { k: 'move', at: { p: 'par', x: 1 }, to: { p: 'bur' } },
    { k: 'nuke', at: { p: 'par' } },
    { k: 'build', at: { p: 'par' } },
    { k: 'move', at: { p: 'PAR' }, to: { p: 'bur' } },
    [],
    null,
  ]) {
    assert.ok(isParseError(rawFromJson(bad)), JSON.stringify(bad));
  }
});
