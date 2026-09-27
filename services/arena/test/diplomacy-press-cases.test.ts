/**
 * Replays the contract's must-reject corpus (contracts/fixtures/diplomacy_press_cases.json,
 * contracts 2.1.0, cases `since: 2.5.0` included) through the B3a press transport: the arena
 * edge schema, the signature attestation (signatures.ts), the wire → engine mapping (wire.ts)
 * and the engine's round close (`closePressRound`) or step (`dipTick`). For every accepted
 * frame the produced `press_rejects` codes and the delivered message indexes must equal the
 * corpus EXACTLY, for all cases (wot-dip-scenario/3 closed the two former known gaps,
 * `recipient_eliminated` and `terms_note_not_sanitised_form`).
 *
 * The context is built for real: `horizon_year` reaches `closePressRound`, `eliminated` powers
 * have no unit and no centre on the board, `active_commitments` have an escrowed clause, and
 * `ended_commitments` have every clause settled every covered phase, so `renounce_ended_commitment`
 * exercises the ended path (a positive control proves the same renounce is accepted while active).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintPassportSigningKey, signPressMove, type PassportSigningKey } from 'wot-auth';
// WOT_CONTRACTS_DIR, else <workspace root>/contracts (public layout), else <workspace root>/../contracts (private).
import { contractsDir } from 'wot-contracts/contracts-dir';
import {
  DIP_PRESS_QUOTAS,
  dipAct,
  dipInit,
  dipCommitmentEnded,
  dipInitialState,
  dipTick,
  POWERS,
  type DipCommitment,
  type DipState,
  type DipEvalClass,
  type DipOffer,
  type DipPressState,
  type Power,
} from 'wot-engine';
import { closePressRound, emptyPressState, resetWindow } from '../../../packages/wot-engine/src/diplomacy/press.ts';
import { attestBatch } from '../src/diplomacy/signatures.ts';
import { dipValidators } from '../src/diplomacy/validators.ts';
import { fromWireAction, pressRejectCode, wireIdToEngine, wireMsgId } from '../src/diplomacy/wire.ts';

const CORPUS = JSON.parse(readFileSync(join(contractsDir(), 'fixtures', 'diplomacy_press_cases.json'), 'utf8')) as {
  cases: {
    id: string;
    context: {
      phase: string;
      tick: number;
      step: { kind: string; round?: number; rounds_total: number };
      tier: DipEvalClass;
      power: Power;
      known_offers: string[];
      active_commitments: string[];
      eliminated: Power[];
      sig_mode?: 'key' | 'session';
      /** 2.5.0: the final year (absent = 1908). */
      horizon_year?: number;
      /** 2.5.0: commitments the sender is party to whose every clause has settled. */
      ended_commitments?: string[];
    };
    frame: Record<string, unknown>;
    expect: { frame: 'schema_invalid' | 'accepted'; press_rejects?: { msg_index: number; code: string }[]; delivered?: number[] };
  }[];
};

const powerOfId = (id: string): Power => /:r\d:([a-z]+):/.exec(id)![1] as Power;
const DEFAULT_HORIZON = 1908;

/** The board at the start of the case's phase: the initial position minus every eliminated power. */
function boardFor(ctx: (typeof CORPUS.cases)[number]['context']): DipState {
  const s0 = dipInitialState();
  if (ctx.eliminated.length === 0) return s0;
  const out = new Set<string>(ctx.eliminated);
  return { ...s0, units: s0.units.filter((u) => !out.has(u.power)), sc: Object.fromEntries(Object.entries(s0.sc).filter(([, p]) => !out.has(p as string))) as DipState['sc'] };
}

/**
 * The corpus JWS values are EXAMPLE placeholders standing for a VALID signature by the sender's
 * passport key (no key-mode case expects `signature_invalid`). In key mode each one is replaced by a
 * real detached JWS over the same message from `key`, so a case that expects delivery of a signed
 * move (2.5.0 `clause_beyond_horizon`) is judged on its terms, not on the placeholder bytes.
 */
function signPlaceholders(frame: Record<string, unknown>, ctx: (typeof CORPUS.cases)[number]['context'], key: PassportSigningKey | null): Record<string, unknown> {
  const press = frame.press as Record<string, unknown>[] | undefined;
  if (!key || !press || ctx.step.kind !== 'press') return frame;
  const signed = press.map((m, i) => {
    if (typeof m.signature !== 'string' || !m.signature.includes('EXAMPLE')) return m;
    const jws = signPressMove(key, {
      episodeId: frame.episode_id as string,
      msgIdExpected: wireMsgId(ctx.phase, ctx.step.round!, ctx.power, i + 1),
      from: ctx.power,
      to: m.to,
      move: m.move as string,
      respondTo: (m.respond_to as string | undefined) ?? null,
      terms: m.move === 'offer' || m.move === 'counter' ? m.terms : null,
    });
    return { ...m, signature: jws };
  });
  return { ...frame, press: signed };
}

const prevMovementPhase = (ph: string): string => (ph[0] === 'F' ? `S${ph.slice(1)}` : `F${Number(ph.slice(1, 5)) - 1}M`);

/** Press state holding the corpus context's live offers and active commitments (engine ids). */
function pressStateFor(ctx: (typeof CORPUS.cases)[number]['context']): DipPressState {
  const ps = resetWindow(emptyPressState(), ctx.phase);
  const offers: DipOffer[] = ctx.known_offers.map((wid) => {
    const from = powerOfId(wid);
    return {
      id: wireIdToEngine(wid) as string,
      from,
      to: from === ctx.power ? 'austria' : ctx.power,
      phase: ctx.phase,
      made_tick: ctx.tick - 1,
      terms: { give: [{ kind: 'no_enter', from: ctx.phase, to: ctx.phase, provinces: ['bur'] }], want: [] },
      terms_hash: 'sha256:' + '0'.repeat(64),
      expires_after_round: 3,
      counter_of: null,
      status: 'live',
      sig_mode: 'key',
    };
  });
  // Active: one clause escrowed over the current phase. Ended: one clause over the previous movement
  // phase, settled (kept) at its adjudication, so every clause has settled every covered phase.
  const commitment = (wid: string, ended: boolean): DipCommitment => {
    const offerId = (wireIdToEngine(wid) as string).slice('cmt:'.length);
    const proposer = powerOfId(wid);
    const ph = ended ? prevMovementPhase(ctx.phase) : ctx.phase;
    return {
      id: wireIdToEngine(wid) as string,
      parties: [proposer, ctx.power] as const,
      offer_msg_id: offerId,
      accept_msg_id: offerId,
      terms_hash: 'sha256:' + '0'.repeat(64),
      bound_tick: ended ? ctx.tick - 8 : ctx.tick - 1,
      bound_phase: ph,
      sig_mode: 'key',
      clauses: [
        {
          index: 0,
          side: 'give',
          obligor: proposer,
          clause: { kind: 'no_enter', from: ph, to: ph, provinces: ['bur'] },
          phases: [ph],
          settlements: ended ? [{ phase: ph, status: 'kept', tick: ctx.tick - 2 }] : [],
        },
      ],
      releases: [],
      renounced: null,
    };
  };
  const commitments = [...ctx.active_commitments.map((w) => commitment(w, false)), ...(ctx.ended_commitments ?? []).map((w) => commitment(w, true))];
  for (const c of commitments) assert.equal(dipCommitmentEnded(c), (ctx.ended_commitments ?? []).some((w) => wireIdToEngine(w) === c.id), `${c.id}: built state`);
  return { ...ps, offers, commitments };
}

for (const c of CORPUS.cases) {
  test(`press corpus: ${c.id}`, () => {
    const valid = dipValidators.diplomacy_action(c.frame);
    if (c.expect.frame === 'schema_invalid') {
      assert.equal(valid, false, 'the arena edge refuses the whole frame (schema_invalid)');
      return;
    }
    assert.equal(valid, true, 'schema-valid frame');
    const ctx = c.context;
    const signer = ctx.sig_mode === 'session' ? null : mintPassportSigningKey();
    const key = signer ? signer.publicJwk : null;
    const frame = signPlaceholders(c.frame, ctx, signer);
    assert.equal(dipValidators.diplomacy_action(frame), true, 'still schema-valid once signed');
    const press = (frame.press as unknown[] | undefined) ?? [];
    let produced: [number, string][];
    let delivered: number[];

    if (ctx.step.kind === 'press') {
      const { attest } = attestBatch(press, { episodeId: c.frame.episode_id as string, phase: ctx.phase, round: ctx.step.round!, tick: ctx.tick, power: ctx.power, publicJwk: key, policy: { allowSession: ctx.sig_mode === 'session' } });
      const mapped = fromWireAction(frame, ctx.phase, attest);
      const r = closePressRound(
        { phase: ctx.phase, round: ctx.step.round!, rounds: ctx.step.rounds_total, tick: ctx.tick, state: boardFor(ctx), quotas: DIP_PRESS_QUOTAS[ctx.tier], horizonYear: ctx.horizon_year ?? DEFAULT_HORIZON },
        pressStateFor(ctx),
        { [ctx.power]: mapped.action.press },
      );
      produced = r.rejects.map((x) => [x.index ?? 0, pressRejectCode(x)]);
      // Not vacuous: the ended case is refused by the ended rule, not the "not a party" one.
      if (c.id === 'renounce_ended_commitment') assert.deepEqual(r.rejects.map((x) => x.detail), ['respond_to: commitment has ended']);
      delivered = r.delivered.filter((m) => m.from === ctx.power).map((m) => Number(m.msg_id.split(':').pop()) - 1);
    } else {
      // intent / orders / retreat: press outside a round. The engine refuses it in dipTick
      // through one path for every non-press step (scenario.ts `wrong`); an S1901 episode
      // at the same step kind reproduces it (the retreat case uses the orders step).
      let ep = dipInit(1, ctx.tier);
      const kind = ctx.step.kind === 'intent' ? 'intent' : 'orders';
      while (ep.step.kind !== kind) ep = dipTick(ep).ep;
      const mapped = fromWireAction(c.frame, ep.step.phaseId, []);
      ep = dipTick(dipAct(ep, ctx.power, mapped.action)).ep;
      const rej = ep.feedback[ctx.power] ?? [];
      produced = rej.filter((x) => x.kind === 'press').map((x) => [x.index ?? 0, pressRejectCode(x)]);
      delivered = [];
    }

    const expected = (c.expect.press_rejects ?? []).map((x) => [x.msg_index, x.code] as [number, string]);
    const expectedDelivered = c.expect.delivered ?? [];
    assert.deepEqual(produced, expected, 'press_rejects (msg_index, code)');
    assert.deepEqual(delivered, expectedDelivered, 'delivered indexes');
    void POWERS;
  });
}

/**
 * Positive control for `renounce_ended_commitment`: the same frame against the same commitment while it
 * is still ACTIVE is accepted and delivered, so the corpus case fails on "ended" and nothing else.
 */
test('press corpus control: renounce_ended_commitment is delivered while the commitment is active', () => {
  const c = CORPUS.cases.find((x) => x.id === 'renounce_ended_commitment')!;
  const ctx = { ...c.context, active_commitments: c.context.ended_commitments!, ended_commitments: [] };
  const signer = mintPassportSigningKey();
  const frame = signPlaceholders(c.frame, ctx, signer);
  const press = frame.press as unknown[];
  const { attest } = attestBatch(press, { episodeId: c.frame.episode_id as string, phase: ctx.phase, round: ctx.step.round!, tick: ctx.tick, power: ctx.power, publicJwk: signer.publicJwk, policy: { allowSession: false } });
  const mapped = fromWireAction(frame, ctx.phase, attest);
  const r = closePressRound(
    { phase: ctx.phase, round: ctx.step.round!, rounds: ctx.step.rounds_total, tick: ctx.tick, state: boardFor(ctx), quotas: DIP_PRESS_QUOTAS[ctx.tier], horizonYear: DEFAULT_HORIZON },
    pressStateFor(ctx),
    { [ctx.power]: mapped.action.press },
  );
  assert.deepEqual(r.rejects, []);
  assert.deepEqual(r.delivered.map((m) => m.move), ['renounce']);
  assert.equal(r.renounced.length, 1);
});
