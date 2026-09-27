/**
 * Leak hooks for sim-qa-engineer (docs/design/diplomacy-adjudicator.md §4.5, §6.2).
 *
 * Non-interference: for an episode, a viewer power and a mutation of state
 * hidden from that viewer, the canonical bytes of `observe(viewer)` must be
 * identical. Every hook takes the observe function as a parameter so the
 * same check runs against a deliberately LEAKY observer (`leakyObserve`),
 * which must be caught: the positive control that stops the fuzzer passing
 * vacuously. `mutateVisible` is the second control: a visible change must
 * change the bytes.
 */

import { canonicalObservation, type DipObservation } from '../observation.ts';
import { intentId, msgId, POWER_ABBR, type Commitment, type DeliveredMessage, type IntentVersion, type Offer, type Reject } from '../press.ts';
import { dipObserve, type DipEpisode } from '../scenario.ts';
import { ascii } from '../map.ts';
import type { Power } from '../types.ts';
import { POWERS } from '../types.ts';

export const DIP_LEAK_SURFACES = [
  'pending_orders',
  'pending_press',
  'pending_intent',
  'foreign_private_press',
  'foreign_intents',
  'foreign_codewords',
  'foreign_offers',
  'foreign_commitments',
  'foreign_rejects',
  'foreign_quota_usage',
  'foreign_signatures',
  'foreign_misses',
  'seed_and_secret',
] as const;
export type DipLeakSurface = (typeof DIP_LEAK_SURFACES)[number];

export type ObserveFn = (ep: DipEpisode, power: Power) => unknown;

export { canonicalObservation };

const others = (viewer: Power): Power[] => POWERS.filter((p) => p !== viewer);
const pick = <T,>(rng: () => number, a: readonly T[]): T => a[Math.floor(rng() * a.length)];
const token = (rng: () => number): string => Math.floor(rng() * 0xffffffff).toString(16).padStart(8, '0');

/** Two distinct powers, neither the viewer. */
function foreignPair(viewer: Power, rng: () => number): [Power, Power] {
  const o = others(viewer);
  const a = pick(rng, o);
  const b = pick(rng, o.filter((p) => p !== a));
  return [a, b];
}

/** Mutate one hidden surface (w.r.t. `viewer`). Always changes something. */
export function mutateHidden(ep: DipEpisode, viewer: Power, rng: () => number, surface: DipLeakSurface): DipEpisode {
  const q = pick(rng, others(viewer));
  const ph = ep.step.phaseId;
  const t = token(rng);
  switch (surface) {
    case 'pending_orders':
      return { ...ep, pending: { ...ep.pending, [q]: { ...(ep.pending[q] ?? {}), orders: [`A ${t.slice(0, 3)} H`, 'F nth - nwy'] } } };
    case 'pending_press':
      // Undelivered press, even press addressed TO the viewer, is hidden until round close.
      return {
        ...ep,
        pending: { ...ep.pending, [q]: { ...(ep.pending[q] ?? {}), press: [{ to: { kind: 'private', power: viewer }, move: 'press', body: `secret ${t}` }] } },
      };
    case 'pending_intent':
      return { ...ep, pending: { ...ep.pending, [q]: { ...(ep.pending[q] ?? {}), intent: { orders: [], notes: `hidden plan ${t}` } } } };
    case 'foreign_private_press': {
      const [a, b] = foreignPair(viewer, rng);
      const m: DeliveredMessage = {
        msg_id: msgId(ph, 1, a, 900 + Math.floor(rng() * 99)),
        phase: ph,
        round: 1,
        delivered_tick: ep.tick,
        from: a,
        to: rng() < 0.5 ? { kind: 'private', power: b } : { kind: 'group', powers: [b, pick(rng, others(viewer).filter((x) => x !== a && x !== b))] },
        recipients: [],
        move: 'press',
        body: `between us ${t}`,
        reply_to: null,
        asks: null,
        terms: null,
        terms_hash: null,
        respond_to: null,
        expires_after_round: null,
        sig_mode: null,
      };
      const recipients: Power[] = m.to.kind === 'private' ? [m.to.power] : m.to.kind === 'group' ? [...m.to.powers] : [];
      return { ...ep, press: { ...ep.press, log: [...ep.press.log, { ...m, recipients }] } };
    }
    case 'foreign_intents': {
      const n = ep.press.intents.filter((v) => v.power === q && v.phase === ph).length + 1;
      const v: IntentVersion = { id: intentId(ph, q, n), power: q, phase: ph, version: n, tick: ep.tick, orders: [], notes: `my secret plan ${t}` };
      return { ...ep, press: { ...ep.press, intents: [...ep.press.intents, v] } };
    }
    case 'foreign_codewords':
      return { ...ep, briefs: { ...ep.briefs, [q]: { ...ep.briefs[q], codeword: `leak ${t} 00` } } };
    case 'foreign_offers': {
      const [a, b] = foreignPair(viewer, rng);
      const o: Offer = {
        id: msgId(ph, 1, a, 950),
        from: a,
        to: b,
        phase: ph,
        made_tick: ep.tick,
        terms: { give: [{ kind: 'no_attack', from: ph, to: ph, power: b }], want: [], note: t },
        terms_hash: `sha256:${t}`,
        expires_after_round: 3,
        counter_of: null,
        status: 'live',
        sig_mode: 'session',
      };
      return { ...ep, press: { ...ep.press, offers: [...ep.press.offers, o] } };
    }
    case 'foreign_commitments': {
      const [a, b] = foreignPair(viewer, rng);
      const c: Commitment = {
        id: `cmt:prs:${ph}:r1:${POWER_ABBR[a]}:${t}`,
        parties: [a, b],
        offer_msg_id: 'x',
        accept_msg_id: 'y',
        terms_hash: `sha256:${t}`,
        bound_tick: ep.tick,
        bound_phase: ph,
        sig_mode: 'session',
        clauses: [],
        releases: [],
        renounced: null,
      };
      return { ...ep, press: { ...ep.press, commitments: [...ep.press.commitments, c] } };
    }
    case 'foreign_rejects': {
      const r: Reject = { tick: ep.tick, phase: ph, power: q, kind: 'press', index: 0, code: 'press_quota', detail: `quota ${t}` };
      return { ...ep, feedback: { ...ep.feedback, [q]: [...(ep.feedback[q] ?? []), r] }, press: { ...ep.press, rejects: [...ep.press.rejects, r] } };
    }
    case 'foreign_quota_usage': {
      const w = ep.press.window[q];
      return { ...ep, press: { ...ep.press, window: { ...ep.press.window, [q]: { msgs: w.msgs + 1 + Math.floor(rng() * 5), bytes: w.bytes + 100, broadcasts: w.broadcasts + 1 } } } };
    }
    case 'foreign_signatures': {
      const sigs: Record<string, string> = { ...ep.press.signatures, [`prs:${ph}:r1:${POWER_ABBR[q]}:1`]: `sig-${t}` };
      return { ...ep, press: { ...ep.press, signatures: sigs } };
    }
    case 'foreign_misses':
      return {
        ...ep,
        misses: [...ep.misses, { tick: ep.tick, power: q, step: ep.step.kind, severity: 'hard' }],
        missStreak: { ...ep.missStreak, [q]: ep.missStreak[q] + 1 },
      };
    case 'seed_and_secret':
      return { ...ep, seed: (ep.seed ^ (1 + Math.floor(rng() * 0xfffffe))) >>> 0, config: { ...ep.config, secret: t } };
  }
}

/** Positive control: a mutation the viewer MUST see. */
export function mutateVisible(ep: DipEpisode, viewer: Power, rng: () => number): DipEpisode {
  const t = token(rng);
  const k = Math.floor(rng() * 4);
  if (k === 0) return { ...ep, briefs: { ...ep.briefs, [viewer]: { ...ep.briefs[viewer], codeword: `own ${t} 11` } } };
  if (k === 1) {
    const from = pick(rng, others(viewer));
    const m: DeliveredMessage = {
      msg_id: msgId(ep.step.phaseId, 1, from, 990),
      phase: ep.step.phaseId,
      round: 1,
      delivered_tick: ep.tick,
      from,
      to: { kind: 'private', power: viewer },
      recipients: [viewer],
      move: 'press',
      body: `to you ${t}`,
      reply_to: null,
      asks: null,
      terms: null,
      terms_hash: null,
      respond_to: null,
      expires_after_round: null,
      sig_mode: null,
    };
    return { ...ep, press: { ...ep.press, log: [...ep.press.log, m] } };
  }
  if (k === 2) {
    const sc = { ...ep.state.sc };
    const keys = Object.keys(sc);
    const p = keys[Math.floor(rng() * keys.length)];
    sc[p] = sc[p] === viewer ? null : viewer;
    return { ...ep, state: { ...ep.state, sc } };
  }
  const r: Reject = { tick: ep.tick, phase: ep.step.phaseId, power: viewer, kind: 'press', index: 0, code: 'press_quota', detail: `own ${t}` };
  return { ...ep, feedback: { ...ep.feedback, [viewer]: [...(ep.feedback[viewer] ?? []), r] } };
}

/** The raw hidden data of one surface (what a leaky observer would expose). */
export function hiddenSurfaceData(ep: DipEpisode, viewer: Power, surface: DipLeakSurface): unknown {
  const o = others(viewer);
  switch (surface) {
    case 'pending_orders':
      return o.map((p) => ep.pending[p]?.orders ?? null);
    case 'pending_press':
      return o.map((p) => ep.pending[p]?.press ?? null);
    case 'pending_intent':
      return o.map((p) => ep.pending[p]?.intent ?? null);
    case 'foreign_private_press':
      return ep.press.log.filter((m) => m.from !== viewer && !m.recipients.includes(viewer)).map((m) => [m.msg_id, m.body]);
    case 'foreign_intents':
      return ep.press.intents.filter((v) => v.power !== viewer).map((v) => [v.id, v.notes]);
    case 'foreign_codewords':
      return o.map((p) => ep.briefs[p].codeword);
    case 'foreign_offers':
      return ep.press.offers.filter((x) => x.from !== viewer && x.to !== viewer).map((x) => x.id);
    case 'foreign_commitments':
      return ep.press.commitments.filter((c) => !c.parties.includes(viewer)).map((c) => c.id);
    case 'foreign_rejects':
      return o.map((p) => (ep.feedback[p] ?? []).map((r) => r.detail));
    case 'foreign_quota_usage':
      return o.map((p) => ep.press.window[p]);
    case 'foreign_signatures':
      return Object.keys(ep.press.signatures).sort(ascii).map((k) => ep.press.signatures[k]);
    case 'foreign_misses':
      return o.map((p) => ep.missStreak[p]);
    case 'seed_and_secret':
      return [ep.seed, ep.config.secret];
  }
}

/** A deliberately leaky observer: the real observation plus one hidden surface. */
export function leakyObserve(surface: DipLeakSurface): ObserveFn {
  return (ep, power) => ({ ...(dipObserve(ep, power) as DipObservation), debug: JSON.parse(JSON.stringify(hiddenSurfaceData(ep, power, surface) ?? null)) });
}

/** True iff `observe(viewer)` is byte-identical before and after the hidden mutation. */
export function nonInterference(observe: ObserveFn, ep: DipEpisode, viewer: Power, rng: () => number, surface: DipLeakSurface): boolean {
  const before = canonicalObservation(observe(ep, viewer));
  const after = canonicalObservation(observe(mutateHidden(ep, viewer, rng, surface), viewer));
  return before === after;
}
