/**
 * Phase 8 B3a engine hooks (minimal, no hashing change):
 *  - X-9 / G-11: the engine's signature check accepts ONLY the two transport-attested
 *    modes (`key`, `session`); any other string, including an unverified JWS, is
 *    `signature_invalid` and never becomes `sig_mode: "key"`;
 *  - `rawFromJson` accepts the contract names `of_power` / `of_type` and, deprecated,
 *    the interim `ofPower` / `ofType`; both spellings at once is `bad_json`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isParseError, parseOrder, rawFromJson } from '../src/diplomacy/parse.ts';
import { closePressRound, emptyPressState, isSigMode, PRESS_QUOTAS, resetWindow, type PressContext, type PressIn } from '../src/diplomacy/press.ts';
import { initialState } from '../src/diplomacy/state.ts';

const ctx = (round: number): PressContext => ({ phase: 'S1901M', round, rounds: 3, tick: round, state: initialState(), quotas: PRESS_QUOTAS.core, horizonYear: 1908 });
const fresh = () => resetWindow(emptyPressState(), 'S1901M');
const offer = (signature: unknown): PressIn =>
  ({
    to: { kind: 'private', power: 'germany' },
    move: 'offer',
    terms: { give: [{ kind: 'no_enter', from: 'S1901M', to: 'F1901M', provinces: ['bur'] }], want: [] },
    signature,
  }) as PressIn;

test('X-9: only the modes `key` and `session` pass the engine; anything else is signature_invalid', () => {
  assert.equal(isSigMode('key'), true);
  assert.equal(isSigMode('session'), true);
  const JWS = 'eyJhbGciOiJFZERTQSJ9..' + 'A'.repeat(86);
  for (const bad of [JWS, 'passport', 'KEY', 'Session', 'key ', '', 'x'.repeat(40), 42, null, { mode: 'key' }]) {
    const r = closePressRound(ctx(1), fresh(), { france: [offer(bad)] });
    assert.deepEqual(r.rejects.map((x) => x.code), ['signature_invalid'], JSON.stringify(bad));
    assert.equal(r.delivered.length, 0);
    assert.equal(r.press.offers.length, 0);
  }
  const k = closePressRound(ctx(1), fresh(), { france: [offer('key')] });
  assert.equal(k.rejects.length, 0);
  assert.equal(k.press.offers[0].sig_mode, 'key');
  assert.equal(k.delivered[0].sig_mode, 'key');
  const s = closePressRound(ctx(1), fresh(), { france: [offer('session')] });
  assert.equal(s.press.offers[0].sig_mode, 'session');
  // the stored evidence is the mode, never signature bytes
  assert.deepEqual(Object.values(k.press.signatures), ['key']);
  // an unsigned offer is still refused
  assert.deepEqual(closePressRound(ctx(1), fresh(), { france: [offer(undefined)] }).rejects.map((x) => x.code), ['signature_invalid']);
});

test('X-9: a commitment is `key` only if both the offer and the accept are `key`', () => {
  const r1 = closePressRound(ctx(1), fresh(), { france: [offer('key')] });
  const id = r1.press.offers[0].id;
  const acc = (signature: string): PressIn => ({ to: { kind: 'private', power: 'france' }, move: 'accept', respond_to: id, signature: signature as PressIn['signature'] });
  assert.equal(closePressRound(ctx(2), r1.press, { germany: [acc('key')] }).bound[0].sig_mode, 'key');
  assert.equal(closePressRound(ctx(2), r1.press, { germany: [acc('session')] }).bound[0].sig_mode, 'session');
  const forged = closePressRound(ctx(2), r1.press, { germany: [acc('eyJhbGciOiJFZERTQSJ9..' + 'B'.repeat(86))] });
  assert.equal(forged.bound.length, 0);
  assert.deepEqual(forged.rejects.map((x) => x.code), ['signature_invalid']);
});

test('rawFromJson: contract names of_power / of_type; deprecated ofPower / ofType still accepted', () => {
  const want = parseOrder('A mun S germany A bur - par');
  assert.ok(!isParseError(want));
  const contract = rawFromJson({ k: 'support', type: 'A', at: { p: 'mun' }, of_power: 'germany', of_type: 'A', of: { p: 'bur' }, to: { p: 'par' } });
  const interim = rawFromJson({ k: 'support', type: 'A', at: { p: 'mun' }, ofPower: 'germany', ofType: 'A', of: { p: 'bur' }, to: { p: 'par' } });
  assert.deepEqual(contract, want);
  assert.deepEqual(interim, want);
  assert.deepEqual(rawFromJson({ k: 'convoy', type: 'F', at: { p: 'eng' }, of_type: 'A', of: { p: 'lon' }, to: { p: 'bre' } }), parseOrder('F eng C A lon - bre'));
  for (const bad of [
    { k: 'support', at: { p: 'mun' }, of_power: 'germany', ofPower: 'germany', of: { p: 'bur' } },
    { k: 'support', at: { p: 'mun' }, of_type: 'A', ofType: 'A', of: { p: 'bur' } },
    { k: 'support', at: { p: 'mun' }, of_power: 'prussia', of: { p: 'bur' } },
    { k: 'support', at: { p: 'mun' }, of_type: 'Z', of: { p: 'bur' } },
    { k: 'support', at: { p: 'mun' }, of_Power: 'germany', of: { p: 'bur' } },
  ]) {
    const r = rawFromJson(bad);
    assert.ok(isParseError(r) && r.error === 'bad_json', JSON.stringify(bad));
  }
});
