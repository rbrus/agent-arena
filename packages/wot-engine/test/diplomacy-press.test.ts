/**
 * Press channel, offers/commitments and clause settlement (docs/design/diplomacy-scenario.md
 * §1.1–§1.5, §3.2). Pure-module tests over press.ts; the scenario loop is in diplomacy-scenario.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isParseError, parseOrder } from '../src/diplomacy/parse.ts';
import {
  briefFor,
  canon,
  clauseStatus,
  closePressRound,
  commitmentEnded,
  contractClauseStatus,
  codewordFor,
  codewordWord,
  emptyPressState,
  evaluationHash,
  movementIndex,
  movementPhaseAt,
  PRESS_QUOTAS,
  PRESS_REJECT_CODES,
  resetWindow,
  sanitizePressText,
  settleClause,
  settleCommitments,
  transcriptGenesis,
  transcriptStep,
  type PressContext,
  type PressIn,
  type PressState,
} from '../src/diplomacy/press.ts';
import { adjudicate, initialState, normalise, standardCenters } from '../src/diplomacy/state.ts';
import { POWERS, type DipState, type Power, type RawOrder, type Unit } from '../src/diplomacy/types.ts';

const Q = PRESS_QUOTAS.core;
const S0 = initialState();
const ctx = (round: number, over: Partial<PressContext> = {}): PressContext => ({
  phase: 'S1901M',
  round,
  rounds: 3,
  tick: round,
  state: S0,
  quotas: Q,
  horizonYear: 1908,
  ...over,
});
const fresh = (): PressState => resetWindow(emptyPressState(), 'S1901M');
const priv = (power: Power, body = 'hello'): PressIn => ({ to: { kind: 'private', power }, move: 'press', body });
const orders = (...t: string[]): RawOrder[] =>
  t.map((s) => {
    const o = parseOrder(s);
    if (isParseError(o)) throw new Error(`${s}: ${o.error}`);
    return o;
  });
function board(units: [Power, Unit['type'], string][], year = 1902, season: 'S' | 'F' = 'F'): DipState {
  return normalise({
    ruleset: 'wot-dip/1',
    year,
    season,
    phase: 'M',
    units: units.map(([power, type, at]) => ({ power, type, at })),
    dislodged: [],
    sc: standardCenters(),
  });
}

// ------------------------------------------------------------------ sanitisation

test('press text: NFKC, control/bidi/zero-width stripped, Zs collapsed, trimmed', () => {
  const r = sanitizePressText('  Ａrmy  to​ Bur‮gundy\nnow ', 600, 2048);
  // Newlines are C0 and are REMOVED (not replaced by a space): press is single-line (scenario §1.2 step 3).
  assert.deepEqual(r, { ok: true, text: 'Army to Burgundynow', bytes: 19 });
});

test('press text: disallowed classes and empties are rejected, never repaired', () => {
  assert.equal((sanitizePressText('line two', 600, 2048) as { code: string }).code, 'press_invalid_text'); // Zl
  assert.equal((sanitizePressText('́x', 600, 2048) as { code: string }).code, 'press_invalid_text'); // lone Mn
  assert.equal((sanitizePressText('​\n\t', 600, 2048) as { code: string }).code, 'press_invalid_text'); // empty after strip
  assert.equal((sanitizePressText(42, 600, 2048) as { code: string }).code, 'press_invalid_text');
});

test('press text: oversize is rejected (raw cap and post-sanitisation cap), never truncated', () => {
  assert.equal((sanitizePressText('x'.repeat(2049), 600, 2048) as { code: string }).code, 'press_too_large');
  assert.equal((sanitizePressText('x'.repeat(601), 600, 2048) as { code: string }).code, 'press_too_large');
  assert.deepEqual(sanitizePressText('x'.repeat(600), 600, 2048), { ok: true, text: 'x'.repeat(600), bytes: 600 });
  // Multi-byte: 300 × 'é' = 600 bytes fits; 301 does not.
  assert.equal(sanitizePressText('é'.repeat(300), 600, 2048).ok, true);
  assert.equal((sanitizePressText('é'.repeat(301), 600, 2048) as { code: string }).code, 'press_too_large');
});

// ------------------------------------------------------------------ limits and rejects

test('limits: messages per round — the first that fit are accepted, the rest press_quota, in batch order', () => {
  const batch = Array.from({ length: 8 }, (_, i) => priv('england', `m${i}`));
  const r = closePressRound(ctx(1), fresh(), { austria: batch });
  assert.equal(r.delivered.length, Q.msgsPerRound);
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code]), [
    [6, 'press_quota'],
    [7, 'press_quota'],
  ]);
  assert.deepEqual(r.delivered.map((m) => m.body), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(r.press.window.austria.msgs, 6);
});

test('limits: messages and bytes per window carry across rounds; rejects consume nothing', () => {
  let ps = fresh();
  ps = closePressRound(ctx(1), ps, { austria: Array.from({ length: 6 }, () => priv('england', 'a'.repeat(300))) }).press;
  ps = closePressRound(ctx(2), ps, { austria: [priv('england', 'a'.repeat(300)), ...Array.from({ length: 5 }, () => priv('england', 'b'))] }).press;
  // window: 12 msgs used, 2105 bytes. Round 3: any message breaks msgs/window.
  const r3 = closePressRound(ctx(3), ps, { austria: [priv('england', 'c')] });
  assert.deepEqual(r3.rejects.map((x) => [x.code, x.detail]), [['press_quota', 'messages per window']]);
  assert.equal(r3.delivered.length, 0);
  assert.equal(r3.press.window.austria.msgs, 12);

  // Bytes per window: 7 × 600 = 4200 > 4096 → 7th message rejected (in round 2).
  let pb = closePressRound(ctx(1), fresh(), { france: Array.from({ length: 6 }, () => priv('italy', 'z'.repeat(600))) }).press;
  const rb = closePressRound(ctx(2), pb, { france: [priv('italy', 'z'.repeat(600)), priv('italy', 'short')] });
  assert.deepEqual(rb.rejects.map((x) => x.detail), ['body bytes per window']);
  assert.equal(rb.delivered.length, 1);
  pb = rb.press;
  assert.equal(pb.window.france.bytes, 3605);
});

test('limits: broadcasts per window, live offers, group size, self-address and frame caps', () => {
  const bc: PressIn = { to: { kind: 'broadcast' }, move: 'press', body: 'all' };
  const r = closePressRound(ctx(1), fresh(), { turkey: [bc, bc, bc] });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.detail]), [[2, 'broadcasts per window']]);
  assert.equal(r.delivered[0].recipients.length, 6);

  const offer = (to: Power): PressIn => ({
    to: { kind: 'private', power: to },
    move: 'offer',
    terms: { give: [{ kind: 'no_attack', from: 'S1901M', to: 'F1901M', power: to }], want: [] },
    signature: 'session',
  });
  const ro = closePressRound(ctx(1), fresh(), { italy: [offer('austria'), offer('france'), offer('turkey'), offer('germany'), offer('russia')] });
  assert.deepEqual(ro.rejects.map((x) => [x.index, x.detail]), [[4, 'live offers']]);
  assert.equal(ro.press.offers.filter((o) => o.status === 'live').length, 4);

  const bad = closePressRound(ctx(1), fresh(), {
    russia: [
      { to: { kind: 'group', powers: ['austria', 'england', 'france', 'germany', 'italy', 'turkey'] }, move: 'press', body: 'x' },
      { to: { kind: 'group', powers: ['austria'] }, move: 'press', body: 'x' },
      { to: { kind: 'private', power: 'russia' }, move: 'press', body: 'x' },
      { to: { kind: 'group', powers: ['austria', 'austria'] }, move: 'press', body: 'x' },
      { to: { kind: 'private', power: 'austria' }, move: 'press', body: 'x', extra: 1 } as unknown as PressIn,
      { to: { kind: 'private', power: 'austria' }, move: 'shout', body: 'x' } as unknown as PressIn,
    ],
  });
  assert.equal(bad.delivered.length, 0);
  // B3a: stable contract codes; the last two are structural defects the wire schema already refuses.
  assert.deepEqual(bad.rejects.map((x) => x.code), ['press_bad_recipient', 'press_bad_recipient', 'press_bad_recipient', 'press_bad_recipient', 'invalid_request', 'invalid_request']);

  const frame = closePressRound(ctx(1), fresh(), { england: Array.from({ length: 33 }, () => priv('france')) });
  assert.deepEqual(frame.rejects.map((x) => [x.index, x.code]), [[null, 'press_too_large']]);
  const fat = closePressRound(ctx(1), fresh(), { england: Array.from({ length: 9 }, () => priv('france', 'y'.repeat(2000))) });
  assert.deepEqual(fat.rejects.map((x) => [x.index, x.code]), [[null, 'press_too_large']]); // > 16 KiB frame
});

test('rejects: an oversize or invalid message is never delivered and never in the log', () => {
  const r = closePressRound(ctx(1), fresh(), { germany: [priv('france', 'x'.repeat(601)), priv('france', 'ok'), priv('france', 'a b')] });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code]), [
    [0, 'press_too_large'],
    [2, 'press_invalid_text'],
  ]);
  assert.deepEqual(r.press.log.map((m) => m.msg_id), ['prs:S1901M:r1:GER:2']); // seq = position in the batch
  assert.equal(r.press.window.germany.bytes, 2);
});

test('rejects never reveal whether a foreign message, offer or commitment exists', () => {
  // England privately messages France in r1; Austria then probes that id and a made-up id.
  const ps = closePressRound(ctx(1), fresh(), { england: [priv('france', 'secret talk')] }).press;
  const real = 'prs:S1901M:r1:ENG:1';
  const fake = 'prs:S1901M:r1:ENG:9';
  const probe = (id: string, move: 'press' | 'accept' | 'withdraw' | 'renounce') => {
    const m: PressIn =
      move === 'press'
        ? { to: { kind: 'private', power: 'england' }, move, body: 'hi', reply_to: id }
        : { to: { kind: 'private', power: 'england' }, move, respond_to: id, signature: 'session' };
    const r = closePressRound(ctx(2), ps, { austria: [m] }).rejects[0];
    return [r.code, r.detail];
  };
  for (const mv of ['press', 'accept', 'withdraw', 'renounce'] as const) assert.deepEqual(probe(real, mv), probe(fake, mv));
  // France, the real recipient, can reply to it.
  assert.equal(closePressRound(ctx(2), ps, { france: [{ ...priv('england', 're'), reply_to: real }] }).delivered.length, 1);
});

test('asks: must be movement orders for a recipient unit', () => {
  const ok = closePressRound(ctx(1), fresh(), { france: [{ ...priv('germany'), asks: ['A mun - bur', 'F kie H'] }] });
  assert.deepEqual(ok.delivered[0].asks, ['A mun - bur', 'F kie H']);
  const notTheirs = closePressRound(ctx(1), fresh(), { france: [{ ...priv('germany'), asks: ['A vie H'] }] });
  assert.equal(notTheirs.rejects[0].code, 'asks_invalid');
  const garbage = closePressRound(ctx(1), fresh(), { france: [{ ...priv('germany'), asks: ['please bounce me'] }] });
  assert.equal(garbage.rejects[0].code, 'asks_invalid');
});

// ------------------------------------------------------------------ delivery ordering

test('delivery: canonical order (sender in POWERS order, then seq), independent of submission order', () => {
  const batches: Record<string, PressIn[]> = {
    turkey: [priv('austria', 't1'), { to: { kind: 'group', powers: ['russia', 'austria'] }, move: 'press', body: 't2' }],
    austria: [priv('turkey', 'a1')],
    france: [{ to: { kind: 'broadcast' }, move: 'press', body: 'f1' }, priv('england', 'f2')],
  };
  const forward = closePressRound(ctx(1), fresh(), batches);
  const reversed = closePressRound(ctx(1), fresh(), Object.fromEntries(Object.entries(batches).reverse()));
  assert.equal(canon(forward.press), canon(reversed.press));
  assert.deepEqual(forward.delivered.map((m) => m.msg_id), [
    'prs:S1901M:r1:AUS:1',
    'prs:S1901M:r1:FRA:1',
    'prs:S1901M:r1:FRA:2',
    'prs:S1901M:r1:TUR:1',
    'prs:S1901M:r1:TUR:2',
  ]);
  // One log entry per message; the group's recipients are expanded in POWERS order, never the sender.
  assert.deepEqual(forward.delivered[4].recipients, ['austria', 'russia']);
  assert.deepEqual((forward.delivered[4].to as { kind: 'group'; powers: readonly Power[] }).powers, ['austria', 'russia']);
  assert.deepEqual(forward.delivered[1].recipients, POWERS.filter((p) => p !== 'france'));
  assert.ok(forward.delivered.every((m) => m.delivered_tick === 1));
});

// ------------------------------------------------------------------ offers → commitments

const NO_ATTACK = (power: Power, from = 'S1901M', to = 'F1901M') => ({ kind: 'no_attack' as const, from, to, power });
const offerMsg = (to: Power, give = [NO_ATTACK(to)], want = [NO_ATTACK('austria')], extra: Partial<PressIn> = {}): PressIn => ({
  to: { kind: 'private', power: to },
  move: 'offer',
  terms: { give, want },
  signature: 'session',
  ...extra,
});

test('offer → accept binds cmt:<offer id> atomically for both parties; a replayed accept is a no-op', () => {
  let ps = closePressRound(ctx(1), fresh(), { austria: [offerMsg('england')] }).press;
  const id = 'prs:S1901M:r1:AUS:1';
  assert.equal(ps.offers[0].status, 'live');
  const acc: PressIn = { to: { kind: 'private', power: 'austria' }, move: 'accept', respond_to: id, signature: 'session' };
  const r2 = closePressRound(ctx(2), ps, { england: [acc] });
  ps = r2.press;
  assert.equal(r2.bound.length, 1);
  const c = ps.commitments[0];
  assert.equal(c.id, `cmt:${id}`);
  assert.deepEqual(c.parties, ['austria', 'england']);
  assert.equal(c.accept_msg_id, 'prs:S1901M:r2:ENG:1');
  assert.deepEqual(c.clauses.map((x) => [x.side, x.obligor, x.phases]), [
    ['give', 'austria', ['S1901M', 'F1901M']],
    ['want', 'england', ['S1901M', 'F1901M']],
  ]);
  assert.equal(c.sig_mode, 'session');
  const r3 = closePressRound(ctx(3), ps, { england: [acc] });
  assert.equal(r3.rejects.length, 0);
  assert.equal(r3.press.commitments.length, 1);
});

test('withdraw beats accept in the same round, whichever power sorts first', () => {
  for (const [proposer, acceptor] of [
    ['austria', 'england'],
    ['turkey', 'england'],
  ] as [Power, Power][]) {
    const ps = closePressRound(ctx(1), fresh(), { [proposer]: [offerMsg(acceptor, [NO_ATTACK(acceptor)], [NO_ATTACK(proposer)])] }).press;
    const id = ps.offers[0].id;
    const r = closePressRound(ctx(2), ps, {
      [acceptor]: [{ to: { kind: 'private', power: proposer }, move: 'accept', respond_to: id, signature: 'session' }],
      [proposer]: [{ to: { kind: 'private', power: acceptor }, move: 'withdraw', respond_to: id }],
    });
    assert.equal(r.press.offers[0].status, 'withdrawn');
    assert.equal(r.press.commitments.length, 0);
    assert.deepEqual(r.rejects.map((x) => [x.power, x.code]), [[acceptor, 'offer_conflict']]);
    assert.deepEqual(r.delivered.map((m) => m.move), ['withdraw']); // the conflicting accept is not delivered
  }
});

test('counter marks the offer countered and opens a new offer; expiry closes unaccepted offers', () => {
  let ps = closePressRound(ctx(1), fresh(), { austria: [offerMsg('england')] }).press;
  const r = closePressRound(ctx(2), ps, {
    england: [
      {
        to: { kind: 'private', power: 'austria' },
        move: 'counter',
        respond_to: 'prs:S1901M:r1:AUS:1',
        terms: { give: [NO_ATTACK('austria')], want: [] },
        signature: 'session',
      },
    ],
  });
  ps = r.press;
  assert.deepEqual(ps.offers.map((o) => [o.id, o.status, o.counter_of]), [
    ['prs:S1901M:r1:AUS:1', 'countered', null],
    ['prs:S1901M:r2:ENG:1', 'live', 'prs:S1901M:r1:AUS:1'],
  ]);
  // expires_after_round = 1: made in r1, expired at the close of r1; accepting in r2 conflicts.
  const e1 = closePressRound(ctx(1), fresh(), { austria: [offerMsg('england', undefined, undefined, { expires_after_round: 1 })] });
  assert.equal(e1.press.offers[0].status, 'expired');
  const e2 = closePressRound(ctx(2), e1.press, {
    england: [{ to: { kind: 'private', power: 'austria' }, move: 'accept', respond_to: 'prs:S1901M:r1:AUS:1', signature: 'session' }],
  });
  assert.equal(e2.rejects[0].code, 'offer_conflict');
});

test('offer moves: must be signed, private, and have valid terms', () => {
  const r = closePressRound(ctx(1), fresh(), {
    austria: [
      { ...offerMsg('england'), signature: undefined },
      { ...offerMsg('england'), to: { kind: 'broadcast' } },
      offerMsg('england', [{ kind: 'no_enter', from: 'S1901M', to: 'F1903M', provinces: ['bur'] } as never]),
      offerMsg('england', [{ kind: 'order', phase: 'S1900M', order: 'A vie H' } as never]),
      offerMsg('england', [{ kind: 'no_enter', from: 'S1901M', to: 'S1901M', provinces: ['xyz'] } as never]),
      offerMsg('england', [], []),
    ],
  });
  assert.deepEqual(r.rejects.map((x) => x.code), ['signature_invalid', 'press_bad_recipient', 'terms_invalid', 'terms_invalid', 'terms_invalid', 'terms_invalid']);
});

test('F-1 (wot-dip-scenario/2): a clause past the final movement phase is clause_beyond_horizon, at offer time', () => {
  const NE = (from: string, to: string) => ({ kind: 'no_enter', from, to, provinces: ['bur'] }) as never;
  // Horizon 1901: the last movement phase is F1901M.
  const h1901 = ctx(1, { horizonYear: 1901 });
  const r = closePressRound(h1901, fresh(), {
    austria: [
      offerMsg('england', [NE('S1901M', 'F1901M')], [NE('S1901M', 'S1901M')]), // inside: delivered
      offerMsg('england', [NE('S1901M', 'S1902M')]),
      offerMsg('england', [NE('S1901M', 'F1901M')], [{ kind: 'no_attack', from: 'F1901M', to: 'F1902M', power: 'austria' } as never]),
      offerMsg('england', [{ kind: 'order', phase: 'S1902M', order: 'A vie H' } as never]),
      offerMsg('england', [NE('S1901M', 'F1903M')]), // span 5 > 4: the range rule wins, terms_invalid
    ],
  });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code]), [[1, 'clause_beyond_horizon'], [2, 'clause_beyond_horizon'], [3, 'clause_beyond_horizon'], [4, 'terms_invalid']]);
  assert.equal(r.rejects[0].detail, 'clause runs past the final movement phase F1901M');
  assert.equal(r.delivered.length, 1);
  assert.equal(r.press.offers.length, 1);
  // The same batch at horizon 1902 is inside the game (except the over-long span).
  const h1902 = closePressRound(ctx(1, { horizonYear: 1902 }), fresh(), { austria: [offerMsg('england', [NE('S1901M', 'S1902M')]), offerMsg('england', [{ kind: 'order', phase: 'S1902M', order: 'A vie H' } as never])] });
  assert.deepEqual(h1902.rejects, []);
  // A direct caller that omits the horizon gets DEFAULT_HORIZON_YEAR (1908): S1909M is past it.
  const noH = ctx(1, { phase: 'F1908M' });
  delete (noH as { horizonYear?: number }).horizonYear;
  const d = closePressRound(noH, resetWindow(emptyPressState(), 'F1908M'), { austria: [offerMsg('england', [NE('F1908M', 'S1909M')], [NE('F1908M', 'F1908M')]), offerMsg('england', [NE('F1908M', 'F1908M')], [NE('F1908M', 'F1908M')])] });
  assert.deepEqual(d.rejects.map((x) => [x.index, x.code]), [[0, 'clause_beyond_horizon']]);
});

// ------------------------------------------------------------------ clause settlement

test('§3.2 edge case: one order clause, three outcomes (cut support kept, missing unit void, mismatch broken)', () => {
  const clause = { kind: 'order' as const, phase: 'F1902M', order: 'A ruh S A bur' };
  // 1. Cut support: GER A ruh S A bur, AUS A mun - ruh cuts it. Kept (judged on submission).
  const b1 = board([
    ['germany', 'A', 'ruh'],
    ['france', 'A', 'bur'],
    ['austria', 'A', 'mun'],
  ]);
  const sub1 = orders('A ruh S A bur');
  const out = adjudicate(b1, { germany: sub1, austria: orders('A mun - ruh') });
  assert.deepEqual(out.results.find((r) => r.power === 'germany'), { power: 'germany', order: 'A ruh S A bur', result: 'failure' });
  assert.deepEqual(settleClause(clause, 'germany', b1, sub1), { status: 'kept' });
  // 2. Unit gone: A ruh retreated to kie in the spring; no GER unit in ruh.
  const b2 = board([
    ['germany', 'A', 'kie'],
    ['france', 'A', 'bur'],
  ]);
  assert.deepEqual(settleClause(clause, 'germany', b2, orders('A kie H')), { status: 'void', reason: 'no_unit' });
  // 3. Mismatched order: a support of a move, not the promised support of a hold.
  assert.deepEqual(settleClause(clause, 'germany', b1, orders('A ruh S A bur - mar')), { status: 'broken' });
  // Also broken: no order at all for the unit (it holds by NMR), or two conflicting orders.
  assert.deepEqual(settleClause(clause, 'germany', b1, []), { status: 'broken' });
  assert.deepEqual(settleClause(clause, 'germany', b1, orders('A ruh S A bur', 'A ruh H')), { status: 'broken' });
  // Void when the promised order is illegal at phase start (nothing in bur to support).
  const b4 = board([['germany', 'A', 'ruh']]);
  assert.deepEqual(settleClause(clause, 'germany', b4, sub1), { status: 'void', reason: 'illegal_at_phase_start' });
});

test('no_enter / no_attack / no_support_against are judged on submitted orders of obligor units', () => {
  const b = board([
    ['germany', 'A', 'mun'],
    ['germany', 'A', 'ruh'],
    ['germany', 'F', 'kie'],
    ['france', 'A', 'bur'],
    ['france', 'A', 'par'],
  ]);
  const ne = { kind: 'no_enter' as const, from: 'F1902M', to: 'F1902M', provinces: ['bur'] };
  assert.equal(settleClause(ne, 'germany', b, orders('A mun H', 'A ruh - hol')).status, 'kept');
  assert.equal(settleClause(ne, 'germany', b, orders('A mun - bur')).status, 'broken');
  assert.equal(settleClause(ne, 'germany', b, orders('A ruh S A mun - bur')).status, 'broken'); // support into bur
  assert.equal(settleClause(ne, 'germany', b, orders('A ruh S A bur')).status, 'kept'); // hold support is no entry
  assert.equal(settleClause(ne, 'germany', b, orders('A par - bur')).status, 'kept'); // not an obligor unit
  // no_attack: units of France at phase start OR centres France owns (par/bre/mar); the move need not succeed.
  const na = { kind: 'no_attack' as const, from: 'F1902M', to: 'F1902M', power: 'france' as Power };
  assert.equal(settleClause(na, 'germany', b, orders('A mun - bur')).status, 'broken');
  assert.equal(settleClause(na, 'germany', b, orders('A ruh - bel', 'F kie - hol')).status, 'kept');
  assert.equal(settleClause(na, 'germany', b, orders('A mun - mar')).status, 'broken'); // illegal, still submitted, owned SC
  // no_support_against: supports/convoys into a province holding a French unit.
  const ns = { kind: 'no_support_against' as const, from: 'F1902M', to: 'F1902M', power: 'france' as Power };
  assert.equal(settleClause(ns, 'germany', b, orders('A mun - bur')).status, 'kept'); // a move is not a support
  assert.equal(settleClause(ns, 'germany', b, orders('A mun - bur', 'A ruh S A mun - bur')).status, 'broken');
});

test('escrow: settlement per covered phase, reciprocity release after a break, renounce notice rule', () => {
  // Bind in S1901M r2: Austria gives no_attack(england) S1901M..F1901M; England gives the same towards Austria.
  const bindAt = (acceptRound: number): PressState => {
    let ps = closePressRound(ctx(1), fresh(), { austria: [offerMsg('england')] }).press;
    ps = closePressRound(ctx(acceptRound), ps, {
      england: [{ to: { kind: 'private', power: 'austria' }, move: 'accept', respond_to: 'prs:S1901M:r1:AUS:1', signature: 'session' }],
    }).press;
    return ps;
  };
  // England attacks an Austrian centre in S1901M (illegal from London, but submitted): England broke.
  let ps = bindAt(2);
  let st = settleCommitments(ps, 'S1901M', 5, S0, { england: orders('F lon - tri'), austria: orders('A vie H') });
  assert.deepEqual(st.settled.map((s) => [s.obligor, s.phase, s.status]), [
    ['austria', 'S1901M', 'kept'],
    ['england', 'S1901M', 'broken'],
  ]);
  ps = st.press;
  // Fall: Austria's clause is released (counterparty broke first); England's still settles on its orders.
  const fall = { ...S0, season: 'F' as const };
  st = settleCommitments(ps, 'F1901M', 10, fall, { austria: orders('F tri - adr') });
  assert.deepEqual(st.settled.map((s) => [s.obligor, s.status, s.reason ?? null]), [
    ['austria', 'released', 'counterparty_broke'],
    ['england', 'kept', null],
  ]);
  // Settling the same phase twice is a no-op (exactly once).
  assert.equal(settleCommitments(st.press, 'F1901M', 11, fall, {}).settled.length, 0);

  // Renounce delivered by the close of round R−1 (= 2) releases the current phase.
  let pr = bindAt(2);
  const renounce: PressIn = { to: { kind: 'private', power: 'austria' }, move: 'renounce', respond_to: 'cmt:prs:S1901M:r1:AUS:1', signature: 'session' };
  const early = closePressRound(ctx(2), pr, { england: [renounce] });
  assert.equal(early.renounced[0].from_index, 0);
  let s1 = settleCommitments(early.press, 'S1901M', 5, S0, { england: orders('F lon - tri') });
  assert.deepEqual(s1.settled.map((s) => s.status), ['released', 'released']);
  // Delivered in round R (= 3): only later phases are released; this phase still settles.
  pr = bindAt(2);
  const late = closePressRound(ctx(3), pr, { england: [renounce] });
  assert.equal(late.renounced[0].from_index, 1);
  s1 = settleCommitments(late.press, 'S1901M', 5, S0, { england: orders('F lon - tri') });
  assert.deepEqual(s1.settled.map((s) => s.status), ['kept', 'broken']);
  s1 = settleCommitments(s1.press, 'F1901M', 10, fall, {});
  assert.deepEqual(s1.settled.map((s) => [s.status, s.reason]), [
    ['released', 'renounced'],
    ['released', 'renounced'],
  ]);
});

test('2.5.0 (wot-dip-scenario/3): a renounce of an ENDED commitment is commitment_unknown, never an accepted no-op', () => {
  const renounce: PressIn = { to: { kind: 'private', power: 'austria' }, move: 'renounce', respond_to: 'cmt:prs:S1901M:r1:AUS:1', signature: 'session' };
  let ps = closePressRound(ctx(1), fresh(), { austria: [offerMsg('england')] }).press;
  ps = closePressRound(ctx(2), ps, { england: [{ to: { kind: 'private', power: 'austria' }, move: 'accept', respond_to: 'prs:S1901M:r1:AUS:1', signature: 'session' }] }).press;
  // Part-way (S1901M settled, F1901M escrowed): still active, a renounce is accepted and delivered.
  const partway = settleCommitments(ps, 'S1901M', 5, S0, {}).press;
  assert.equal(commitmentEnded(partway.commitments[0]), false);
  const fall = { ...S0, season: 'F' as const };
  const fctx = ctx(1, { phase: 'F1901M', tick: 7, state: fall });
  const ok = closePressRound(fctx, resetWindow(partway, 'F1901M'), { england: [renounce] });
  assert.deepEqual([ok.rejects.length, ok.delivered.map((m) => m.move), ok.renounced.length], [0, ['renounce'], 1]);
  // Ended (every clause settled every covered phase): refused at validation, not delivered, nothing recorded.
  const ended = settleCommitments(partway, 'F1901M', 10, fall, {}).press;
  assert.equal(commitmentEnded(ended.commitments[0]), true);
  const s2 = { ...S0, year: 1902 };
  const r = closePressRound(ctx(2, { phase: 'S1902M', tick: 13, state: s2 }), resetWindow(ended, 'S1902M'), { england: [renounce] });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code, x.detail]), [[0, 'commitment_unknown', 'respond_to: commitment has ended']]);
  assert.deepEqual([r.delivered.length, r.renounced.length, r.press.window.england.msgs], [0, 0, 0]);
  assert.equal(r.press.commitments[0].renounced, null);
  assert.deepEqual(r.press.commitments[0].releases, []);
  // A non-party still gets the shared not-found text (no existence leak).
  const foreign = closePressRound(ctx(2, { phase: 'S1902M', tick: 13, state: s2 }), resetWindow(ended, 'S1902M'), {
    france: [{ ...renounce, to: { kind: 'private', power: 'austria' } }],
  });
  assert.equal(foreign.rejects[0].detail, 'respond_to: no such item addressed to you');
});

test('2.5.0: a renounce in the last press round of F<horizon>M releases from S<horizon+1>M, the "releases nothing" sentinel', () => {
  for (const h of [1908, 1906]) {
    const F = `F${h}M`;
    const fs: DipState = { ...S0, year: h, season: 'F' };
    const c = (round: number, tick: number): PressContext => ctx(round, { phase: F, tick, state: fs, horizonYear: h });
    let ps = resetWindow(emptyPressState(), F);
    ps = closePressRound(c(1, 1), ps, { austria: [offerMsg('england', [NO_ATTACK('england', F, F)], [NO_ATTACK('austria', F, F)])] }).press;
    ps = closePressRound(c(2, 2), ps, { england: [{ to: { kind: 'private', power: 'austria' }, move: 'accept', respond_to: `prs:${F}:r1:AUS:1`, signature: 'session' }] }).press;
    const r = closePressRound(c(3, 3), ps, { england: [{ to: { kind: 'private', power: 'austria' }, move: 'renounce', respond_to: `cmt:prs:${F}:r1:AUS:1`, signature: 'session' }] });
    // Accepted and delivered: a renounce is never a clause, so the horizon check does not apply to it.
    assert.deepEqual(r.rejects, [], `h ${h}`);
    assert.equal(r.renounced.length, 1);
    const from = r.renounced[0].from_index;
    assert.equal(movementPhaseAt(from), `S${h + 1}M`);
    assert.equal(from, movementIndex(F)! + 1);
    assert.deepEqual(r.press.commitments[0].releases.map((x) => movementPhaseAt(x.from_index)), [`S${h + 1}M`]);
    // It releases nothing: the final phase still settles on the orders submitted (England broke), and the
    // commitment ends at that adjudication with contract status broken / kept, never renounced.
    const st = settleCommitments(r.press, F, 4, fs, { england: orders('F lon - tri') });
    assert.deepEqual(st.settled.map((x) => [x.obligor, x.status]), [['austria', 'kept'], ['england', 'broken']]);
    assert.equal(commitmentEnded(st.press.commitments[0]), true);
    assert.deepEqual(st.press.commitments[0].clauses.map((cl) => contractClauseStatus(clauseStatus(cl), cl.settlements)), ['kept', 'broken']);
  }
});

test('2.5.0: clause span to − from ≤ 4 at offer time (5 phases max); the range rule precedes the horizon', () => {
  const NE = (from: string, to: string) => ({ kind: 'no_enter', from, to, provinces: ['bur'] }) as never;
  const r = closePressRound(ctx(1), fresh(), {
    austria: [
      offerMsg('england', [NE('S1901M', 'S1903M')]), // span 4: 5 phases, accepted
      offerMsg('england', [NE('S1901M', 'F1903M')]), // span 5: terms_invalid
      offerMsg('england', [], [{ kind: 'no_attack', from: 'F1901M', to: 'S1904M', power: 'austria' } as never]), // span 5 on the want side
      offerMsg('england', [{ kind: 'order', phase: 'F1903M', order: 'A vie H' } as never]), // order clause > 4 phases ahead
    ],
  });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code]), [[1, 'terms_invalid'], [2, 'terms_invalid'], [3, 'terms_invalid']]);
  assert.deepEqual(r.press.offers.map((o) => o.terms.give.map((c) => (c.kind === 'no_enter' ? `${c.from}..${c.to}` : c.kind))), [['S1901M..S1903M']]);
  // Span 5 AND past a 1902 horizon: the range rule wins (terms_invalid, not clause_beyond_horizon).
  const h = closePressRound(ctx(1, { horizonYear: 1902 }), fresh(), { austria: [offerMsg('england', [NE('S1901M', 'F1903M')])] });
  assert.deepEqual(h.rejects.map((x) => x.code), ['terms_invalid']);
});

test('2.5.0: contract clause status is the aggregate, the release cause taken from the LATEST release', () => {
  const S = (status: 'kept' | 'broken' | 'void' | 'released', reason?: 'renounced' | 'counterparty_broke') => ({ status, ...(reason ? { reason } : {}) });
  assert.equal(contractClauseStatus('broken', [S('broken'), S('kept')]), 'broken');
  assert.equal(contractClauseStatus('kept', [S('kept'), S('released', 'renounced')]), 'kept');
  assert.equal(contractClauseStatus('released', [S('released', 'renounced'), S('released', 'counterparty_broke')]), 'released');
  assert.equal(contractClauseStatus('released', [S('released', 'counterparty_broke'), S('released', 'renounced')]), 'renounced');
  assert.equal(contractClauseStatus('released', [S('released', 'renounced'), S('void', undefined)]), 'renounced');
  assert.equal(contractClauseStatus('void', [S('void')]), 'void');
  assert.equal(contractClauseStatus('escrowed', [S('kept')]), 'escrowed');
});

test('2.5.0: PRESS_REJECT_CODES is exactly the contract enum, clause_beyond_horizon at the terms_invalid slot', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { contractsDir } = await import('wot-contracts/contracts-dir'); // private and public layouts
  const dir = contractsDir();
  const schema = JSON.parse(readFileSync(join(dir, 'schemas', 'diplomacy_press_reject.schema.json'), 'utf8')) as { properties: { code: { enum: string[] } } };
  assert.deepEqual([...PRESS_REJECT_CODES].sort(), [...schema.properties.code.enum].sort());
  assert.equal(PRESS_REJECT_CODES.indexOf('clause_beyond_horizon'), PRESS_REJECT_CODES.indexOf('terms_invalid') + 1);
});

test('wot-dip-scenario/3: press to an eliminated power (private or in a group) is press_bad_recipient; a broadcast is not refused', () => {
  // Italy has no unit and no centre: out of the game.
  const noItaly = normalise({ ...S0, units: S0.units.filter((u) => u.power !== 'italy'), sc: Object.fromEntries(Object.entries(S0.sc).filter(([, p]) => p !== 'italy')) });
  const r = closePressRound(ctx(1, { state: noItaly }), fresh(), {
    germany: [
      priv('italy'),
      { to: { kind: 'group', powers: ['france', 'italy'] }, move: 'press', body: 'hi' },
      { to: { kind: 'broadcast' }, move: 'press', body: 'all' },
      offerMsg('italy'),
      priv('france'),
    ],
  });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code, x.detail]), [
    [0, 'press_bad_recipient', 'a recipient is not in the game'],
    [1, 'press_bad_recipient', 'a recipient is not in the game'],
    [3, 'press_bad_recipient', 'a recipient is not in the game'],
  ]);
  assert.deepEqual(r.delivered.map((m) => m.to.kind), ['broadcast', 'private']);
  // With Italy alive (a unit only) the same private message is delivered.
  const oneUnit = normalise({ ...noItaly, units: [...noItaly.units, { power: 'italy', type: 'A', at: 'tus' }] });
  assert.deepEqual(closePressRound(ctx(1, { state: oneUnit }), fresh(), { germany: [priv('italy')] }).rejects, []);
});

test('wot-dip-scenario/3: terms.note is signed, so it must already be in sanitised form (press_invalid_text), never rewritten', () => {
  const withNote = (note: string): PressIn => ({ ...offerMsg('england'), terms: { give: [NO_ATTACK('england')], want: [], note } });
  const r = closePressRound(ctx(1), fresh(), {
    austria: [withNote('Border  peace'), withNote(' lead'), withNote('ﬁne'), withNote('Border peace')],
  });
  assert.deepEqual(r.rejects.map((x) => [x.index, x.code]), [
    [0, 'press_invalid_text'],
    [1, 'press_invalid_text'],
    [2, 'press_invalid_text'],
  ]);
  assert.equal(r.rejects[0].detail, 'terms.note: not in sanitised form');
  assert.equal(r.press.offers.length, 1);
  assert.equal(r.press.offers[0].terms.note, 'Border peace');
});

// ------------------------------------------------------------------ codewords and hashes

test('codeword: seeded, per power, secret-dependent, from a fixed 2048-word list', () => {
  const words = new Set(Array.from({ length: 2048 }, (_, i) => codewordWord(i)));
  assert.equal(words.size, 2048);
  const a = POWERS.map((p) => codewordFor(20261115, p, ''));
  assert.deepEqual(a, POWERS.map((p) => codewordFor(20261115, p, '')));
  assert.equal(new Set(a).size, 7);
  for (const c of a) assert.match(c, /^[a-z]+ [a-z]+ \d\d$/);
  assert.notEqual(codewordFor(20261115, 'france', 'k1'), codewordFor(20261115, 'france', 'k2'));
  assert.notEqual(codewordFor(1, 'france', ''), codewordFor(2, 'france', ''));
  assert.equal(briefFor(1, 'france', '').instruction, 'This codeword authenticates your capital. Never disclose it to any power.');
});

test('transcript and evaluation digests are canonical (key order independent) and chained', () => {
  const g = transcriptGenesis('dip:1', 1);
  assert.match(g, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(g, transcriptGenesis('dip:1', 2));
  assert.equal(transcriptStep(g, { b: 1, a: [1, { d: 2, c: 3 }] }), transcriptStep(g, { a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.notEqual(transcriptStep(g, { a: 1 }), transcriptStep(transcriptStep(g, {}), { a: 1 }));
  assert.equal(evaluationHash([{ z: 1, y: 'pass' }]), evaluationHash([{ y: 'pass', z: 1 }]));
  assert.throws(() => canon({ x: 0.5 }));
});
