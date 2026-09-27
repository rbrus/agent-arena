/**
 * Deterministic engine-test policy for the scenario layer: a seeded "chatty"
 * player that reads ONLY its `DipObservation` (like a real agent) and emits
 * intents, press (private / group / broadcast, asks, offers, counters,
 * accepts, withdraws, renounces, and a few deliberately invalid messages) and
 * orders. Orders come from `scriptedOrders` with `orderSeed` only, so two runs
 * that differ in `pressSalt` settle identical orders (the press-isolation test).
 * Not a strategy and not a B5 reference agent; a coverage driver.
 */

import { hash32, mulberry32 } from '../../rng.ts';
import { armyNeighbours, provinceOf } from '../map.ts';
import type { DipObservation } from '../observation.ts';
import { movementIndex, movementPhaseAt, type PressIn } from '../press.ts';
import type { DipAction } from '../scenario.ts';
import type { DipState, Dislodged, Power, Season } from '../types.ts';
import { POWERS } from '../types.ts';
import { scriptedOrders } from './scripted.ts';

export interface ScriptedPressOptions {
  orderSeed: number;
  pressSalt: number;
  /** 0 disables press entirely (orders + intent only). */
  chattiness?: number;
}

/** Rebuild the public board as a DipState (all of it is public in Diplomacy). */
export function stateFromObservation(o: DipObservation): DipState {
  const ph = o.phase_id;
  const dislodged: Dislodged[] = o.dislodged.map((d) => ({
    unit: { power: d.power, type: d.type, at: d.at },
    attackerFrom: '',
    byConvoy: false,
    options: d.retreat_options,
  }));
  return {
    ruleset: 'wot-dip/1',
    year: Number(ph.slice(1, 5)),
    season: ph[0] as Season,
    phase: ph[5] as DipState['phase'],
    units: o.board.units.map((u) => ({ power: u.power, type: u.type, at: u.at })),
    dislodged,
    sc: { ...o.board.supply_centers },
  };
}

const BODIES = [
  'Shall we keep the peace on our border this year?',
  'I have no designs on your centres. Do you?',
  'Your fleet worries me. Explain it.',
  'Let us talk after the next round.',
  'Support me and I will remember it.',
];

export function scriptedDipAction(o: DipObservation, opts: ScriptedPressOptions): DipAction {
  const me = o.you.power;
  const state = stateFromObservation(o);
  const myOrders = scriptedOrders(state, opts.orderSeed)[me];
  const step = o.step;
  if (step.kind === 'orders') return { orders: myOrders };

  const rng = mulberry32(hash32(`press:${opts.pressSalt}:${me}:${o.phase_id}:${step.kind}:${step.round}`));
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
  const chat = opts.chattiness ?? 1;
  const intent = { orders: myOrders, notes: `Plan for ${o.phase_id}: hold the line and probe ${pick(['north', 'south', 'east', 'west'])}.` };
  if (step.kind === 'intent') return { intent };

  const others = POWERS.filter((p) => p !== me && o.board.unit_counts[p] + o.board.sc_counts[p] > 0);
  if (!others.length || chat === 0) return {};
  const press: PressIn[] = [];
  const cur = movementIndex(o.phase_id)!;
  const next = movementPhaseAt(cur + 1);
  const theirUnit = (p: Power) => o.board.units.find((u) => u.power === p);
  const myUnits = o.board.units.filter((u) => u.power === me);

  if (rng() < 0.6 * chat) {
    const to = pick(others);
    const u = theirUnit(to);
    const m: PressIn = { to: { kind: 'private', power: to }, move: 'press', body: pick(BODIES) };
    if (u && rng() < 0.5) m.asks = [`${u.type} ${u.at} H`];
    const lastIn = o.inbox[o.inbox.length - 1];
    if (lastIn && lastIn.from === to && rng() < 0.5) m.reply_to = lastIn.msg_id;
    press.push(m);
  }
  if (rng() < 0.15 * chat) press.push({ to: { kind: 'broadcast' }, move: 'press', body: 'Peace to all who keep it.' });
  if (others.length >= 3 && rng() < 0.15 * chat) {
    const k = Math.floor(rng() * others.length);
    const g = [...others.slice(k), ...others.slice(0, k)].slice(0, 2 + Math.floor(rng() * 2));
    press.push({ to: { kind: 'group', powers: g }, move: 'press', body: 'A word to the three of us.' });
  }
  if (rng() < 0.3 * chat && o.quotas_left.live_offers > 0) {
    const to = pick(others);
    const mine = myUnits.length ? pick(myUnits) : null;
    const border = mine ? armyNeighbours(provinceOf(mine.at)) : [];
    const give =
      mine && rng() < 0.5
        ? [{ kind: 'order' as const, phase: rng() < 0.5 ? o.phase_id : next, order: `${mine.type} ${mine.at} H` }]
        : [{ kind: 'no_attack' as const, from: o.phase_id, to: next, power: to }];
    const want = border.length ? [{ kind: 'no_enter' as const, from: o.phase_id, to: next, provinces: [pick(border)] }] : [];
    press.push({ to: { kind: 'private', power: to }, move: 'offer', terms: { give, want, note: 'Border peace, signed.' }, signature: 'session' });
  }
  for (const off of o.offers_live) {
    if (off.to === me) {
      const r = rng();
      if (r < 0.5) press.push({ to: { kind: 'private', power: off.from }, move: 'accept', respond_to: off.offer_id, signature: 'session' });
      else if (r < 0.65)
        press.push({
          to: { kind: 'private', power: off.from },
          move: 'counter',
          respond_to: off.offer_id,
          terms: { give: off.terms.want, want: off.terms.give },
          signature: 'session',
        });
    } else if (off.from === me && rng() < 0.1) {
      press.push({ to: { kind: 'private', power: off.to }, move: 'withdraw', respond_to: off.offer_id });
    }
  }
  for (const c of o.commitments) {
    if (c.renounced || rng() >= 0.08) continue;
    const peer = c.parties[0] === me ? c.parties[1] : c.parties[0];
    press.push({ to: { kind: 'private', power: peer }, move: 'renounce', respond_to: c.cmt_id, body: 'We are done.', signature: 'session' });
  }
  // Deliberately invalid traffic (rejects must be reported, never delivered).
  const r = rng();
  if (r < 0.04) press.push({ to: { kind: 'private', power: pick(others) }, move: 'press', body: 'x'.repeat(700) });
  else if (r < 0.08) press.push({ to: { kind: 'private', power: pick(others) }, move: 'press', body: 'line one line two' });
  const action: DipAction = { press };
  if (rng() < 0.2) action.intent = intent;
  if (rng() < 0.03) action.orders = myOrders; // wrong step: must be ignored with feedback
  return action;
}
