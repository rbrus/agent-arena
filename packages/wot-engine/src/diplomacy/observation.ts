/**
 * Per-power observation (docs/design/diplomacy-adjudicator.md §6.2;
 * docs/design/diplomacy-scenario.md §1.6, §1.7). "Build, never redact."
 *
 * `buildDipObservation` takes a `DipProjection`, NOT the episode. The projection
 * type has no field that can carry hidden state: other powers' pending
 * actions, their intents, briefs/codewords, offers and commitments between
 * others, press not addressed to the viewer, rejects of others, the seed and
 * the episode secret. `projectForPower` in scenario.ts is the single, small,
 * reviewable function that reads the episode; the builder then copies
 * whitelisted fields one by one into fresh objects (a projector that smuggled
 * extra keys into a record would still not get them onto the wire) and
 * re-filters every private list by the viewer (defence in depth).
 *
 * Press bodies are untrusted agent text: copied as opaque strings, never
 * parsed, interpreted or concatenated into anything with semantics.
 */

import { buildableSites, delta } from './board.ts';
import { ascii } from './map.ts';
import { MAX_ORDER_CHARS, MAX_ORDERS } from './parse.ts';
import {
  canon,
  clauseStatus,
  isParty,
  type Brief,
  type Clause,
  type ClauseSettlement,
  type Commitment,
  type DeliveredMessage,
  type IntentVersion,
  type Offer,
  type OfferTerms,
  type PressQuotas,
  type Recipients,
  type Reject,
  type WindowCounters,
} from './press.ts';
import type { DipTerminal } from './terminal.ts';
import type { DipState, Dislodged, NodeId, PhaseId, Power, ProvinceId, Unit } from './types.ts';
import { POWERS } from './types.ts';

export const PROJECTION_TAG = 'wot-dip/projection/1' as const;
export const OBSERVATION_SCHEMA = 'wot-dip/observation/1' as const;

export type DipStepKind = 'intent' | 'press' | 'orders';

export interface LastPhaseOrder {
  power: Power;
  order: string;
  status: 'used' | 'illegal' | 'superseded';
  reason?: string;
  result?: 'success' | 'failure' | 'void';
}
export interface LastPhaseView {
  phase_id: PhaseId;
  orders: readonly LastPhaseOrder[];
}

/** Public table state: what every power sees (Diplomacy has no board fog). */
export interface PublicView {
  phaseId: PhaseId;
  tick: number;
  step: { kind: DipStepKind; round: number; roundsTotal: number };
  horizonYear: number;
  board: Pick<DipState, 'year' | 'season' | 'phase' | 'units' | 'dislodged' | 'sc'>;
  contested: readonly ProvinceId[];
  lastPhase: LastPhaseView | null;
  terminal: DipTerminal | null;
}

/** The viewer's own private records. */
export interface OwnView {
  power: Power;
  seat: number;
  brief: Brief;
  intent: IntentVersion | null;
  sent: readonly DeliveredMessage[];
  offers: readonly Offer[];
  commitments: readonly Commitment[];
  rejects: readonly Reject[];
  window: WindowCounters;
}

/** Messages delivered TO the viewer in the current movement window. */
export interface InboxView {
  messages: readonly DeliveredMessage[];
}

/**
 * The only input of the observation builder. The literal `tag` makes a
 * `DipEpisode` (or anything else) structurally non-assignable.
 */
export interface DipProjection {
  readonly tag: typeof PROJECTION_TAG;
  readonly pub: PublicView;
  readonly own: OwnView;
  readonly inbox: InboxView;
  readonly quotas: PressQuotas;
}

// ------------------------------------------------------------------ wire shape

export interface ObsMessage {
  msg_id: string;
  from: Power;
  to: Recipients;
  move: DeliveredMessage['move'];
  body: string | null;
  reply_to: string | null;
  asks: readonly string[] | null;
  terms: OfferTerms | null;
  terms_hash: string | null;
  respond_to: string | null;
  expires_after_round: number | null;
  delivered_tick: number;
  sig_mode: DeliveredMessage['sig_mode'];
}

export interface ObsOffer {
  offer_id: string;
  from: Power;
  to: Power;
  terms: OfferTerms;
  terms_hash: string;
  expires_after_round: number;
  counter_of: string | null;
}

export interface ObsCommitment {
  cmt_id: string;
  parties: readonly [Power, Power];
  offer_msg_id: string;
  accept_msg_id: string;
  terms_hash: string;
  bound_tick: number;
  sig_mode: Commitment['sig_mode'];
  renounced: { by: Power; msg_id: string; tick: number } | null;
  clauses: readonly {
    index: number;
    obligor: Power;
    clause: Clause;
    status: ReturnType<typeof clauseStatus>;
    settlements: readonly ClauseSettlement[];
  }[];
}

export interface DipObservation {
  schema: typeof OBSERVATION_SCHEMA;
  phase_id: PhaseId;
  tick: number;
  step: { kind: DipStepKind; round: number; rounds_total: number };
  horizon: { final_year: number; years_remaining: number };
  you: { power: Power; seat: number };
  board: {
    units: readonly { power: Power; type: Unit['type']; at: NodeId }[];
    supply_centers: Readonly<Record<ProvinceId, Power | null>>;
    sc_counts: Readonly<Record<Power, number>>;
    unit_counts: Readonly<Record<Power, number>>;
  };
  dislodged: readonly { power: Power; type: Unit['type']; at: NodeId; retreat_options: readonly NodeId[] }[];
  contested: readonly ProvinceId[];
  adjustment: { delta: number; buildable: readonly ProvinceId[] } | null;
  last_phase: LastPhaseView | null;
  inbox: readonly ObsMessage[];
  press_sent: readonly ObsMessage[];
  offers_live: readonly ObsOffer[];
  commitments: readonly ObsCommitment[];
  intent_echo: { id: string; version: number; recorded_tick: number; orders: readonly string[]; notes: string | null } | null;
  rejects: readonly { kind: Reject['kind']; index: number | null; code: Reject['code']; detail: string }[];
  quotas_left: { msgs_window: number; bytes_window: number; broadcasts_window: number; live_offers: number };
  limits: {
    press_rounds: number;
    msgs_per_round: number;
    msgs_per_window: number;
    bytes_per_window: number;
    broadcasts_per_window: number;
    live_offers: number;
    body_max_bytes: number;
    note_max_bytes: number;
    notes_max_bytes: number;
    orders_max: number;
    order_chars_max: number;
  };
  private: { brief: { codeword: string; instruction: string } };
  terminal: DipTerminal | null;
}

// ------------------------------------------------------------------ builder

const copyTerms = (t: OfferTerms): OfferTerms => {
  const clause = (c: Clause): Clause => {
    switch (c.kind) {
      case 'order':
        return { kind: 'order', phase: c.phase, order: c.order };
      case 'no_enter':
        return { kind: 'no_enter', from: c.from, to: c.to, provinces: [...c.provinces] };
      case 'no_attack':
      case 'no_support_against':
        return { kind: c.kind, from: c.from, to: c.to, power: c.power };
    }
  };
  const out: OfferTerms = { give: t.give.map(clause), want: t.want.map(clause) };
  return t.note !== undefined ? { ...out, note: t.note } : out;
};

const copyRecipients = (r: Recipients): Recipients =>
  r.kind === 'private' ? { kind: 'private', power: r.power } : r.kind === 'group' ? { kind: 'group', powers: [...r.powers] } : { kind: 'broadcast' };

const copyMessage = (m: DeliveredMessage): ObsMessage => ({
  msg_id: m.msg_id,
  from: m.from,
  to: copyRecipients(m.to),
  move: m.move,
  body: m.body,
  reply_to: m.reply_to,
  asks: m.asks ? [...m.asks] : null,
  terms: m.terms ? copyTerms(m.terms) : null,
  terms_hash: m.terms_hash,
  respond_to: m.respond_to,
  expires_after_round: m.expires_after_round,
  delivered_tick: m.delivered_tick,
  sig_mode: m.sig_mode,
});

const copySettlement = (s: ClauseSettlement): ClauseSettlement =>
  s.reason ? { phase: s.phase, status: s.status, tick: s.tick, reason: s.reason } : { phase: s.phase, status: s.status, tick: s.tick };

/** Pure: projection → observation. Deterministic key and list order by construction. */
export function buildDipObservation(p: DipProjection): DipObservation {
  if (p.tag !== PROJECTION_TAG) throw new Error('buildDipObservation: not a projection');
  const me = p.own.power;
  const b = p.pub.board;
  const units = b.units.map((u) => ({ power: u.power, type: u.type, at: u.at }));
  const sc: Record<ProvinceId, Power | null> = {};
  for (const k of Object.keys(b.sc).sort(ascii)) sc[k] = b.sc[k];
  const scCounts = {} as Record<Power, number>;
  const unitCounts = {} as Record<Power, number>;
  for (const pw of POWERS) {
    scCounts[pw] = Object.keys(b.sc).filter((k) => b.sc[k] === pw).length;
    unitCounts[pw] = b.units.filter((u) => u.power === pw).length;
  }
  const state: DipState = { ruleset: 'wot-dip/1', year: b.year, season: b.season, phase: b.phase, units: b.units, dislodged: b.dislodged, sc: b.sc };
  const adjustment = b.phase === 'A' ? { delta: delta(state, me), buildable: delta(state, me) > 0 ? buildableSites(state, me) : [] } : null;

  const inbox = p.inbox.messages.filter((m) => m.recipients.includes(me) && m.from !== me).map(copyMessage);
  const sent = p.own.sent.filter((m) => m.from === me).map(copyMessage);
  const offers = p.own.offers
    .filter((o) => o.status === 'live' && (o.from === me || o.to === me))
    .map((o) => ({
      offer_id: o.id,
      from: o.from,
      to: o.to,
      terms: copyTerms(o.terms),
      terms_hash: o.terms_hash,
      expires_after_round: o.expires_after_round,
      counter_of: o.counter_of,
    }));
  const commitments = p.own.commitments
    .filter((c) => isParty(c, me))
    .map((c) => ({
      cmt_id: c.id,
      parties: [c.parties[0], c.parties[1]] as const,
      offer_msg_id: c.offer_msg_id,
      accept_msg_id: c.accept_msg_id,
      terms_hash: c.terms_hash,
      bound_tick: c.bound_tick,
      sig_mode: c.sig_mode,
      renounced: c.renounced ? { by: c.renounced.by, msg_id: c.renounced.msg_id, tick: c.renounced.tick } : null,
      clauses: c.clauses.map((cl) => ({
        index: cl.index,
        obligor: cl.obligor,
        clause: copyTerms({ give: [cl.clause], want: [] }).give[0],
        status: clauseStatus(cl),
        settlements: cl.settlements.map(copySettlement),
      })),
    }));
  const it = p.own.intent && p.own.intent.power === me ? p.own.intent : null;
  const q = p.quotas;
  const w = p.own.window;
  const liveMine = p.own.offers.filter((o) => o.status === 'live' && o.from === me).length;
  const year = b.year;

  return {
    schema: OBSERVATION_SCHEMA,
    phase_id: p.pub.phaseId,
    tick: p.pub.tick,
    step: { kind: p.pub.step.kind, round: p.pub.step.round, rounds_total: p.pub.step.roundsTotal },
    horizon: { final_year: p.pub.horizonYear, years_remaining: Math.max(0, p.pub.horizonYear - year) },
    you: { power: me, seat: p.own.seat },
    board: { units, supply_centers: sc, sc_counts: scCounts, unit_counts: unitCounts },
    dislodged: b.dislodged.map((d: Dislodged) => ({ power: d.unit.power, type: d.unit.type, at: d.unit.at, retreat_options: [...d.options] })),
    contested: [...p.pub.contested],
    adjustment,
    last_phase: p.pub.lastPhase
      ? {
          phase_id: p.pub.lastPhase.phase_id,
          orders: p.pub.lastPhase.orders.map((o) => {
            const r: LastPhaseOrder = { power: o.power, order: o.order, status: o.status };
            if (o.reason !== undefined) r.reason = o.reason;
            if (o.result !== undefined) r.result = o.result;
            return r;
          }),
        }
      : null,
    inbox,
    press_sent: sent,
    offers_live: offers,
    commitments,
    intent_echo: it ? { id: it.id, version: it.version, recorded_tick: it.tick, orders: [...it.orders], notes: it.notes } : null,
    rejects: p.own.rejects.filter((r) => r.power === me).map((r) => ({ kind: r.kind, index: r.index, code: r.code, detail: r.detail })),
    quotas_left: {
      msgs_window: Math.max(0, q.msgsPerWindow - w.msgs),
      bytes_window: Math.max(0, q.bytesPerWindow - w.bytes),
      broadcasts_window: Math.max(0, q.broadcastsPerWindow - w.broadcasts),
      live_offers: Math.max(0, q.liveOffers - liveMine),
    },
    limits: {
      press_rounds: p.pub.step.roundsTotal,
      msgs_per_round: q.msgsPerRound,
      msgs_per_window: q.msgsPerWindow,
      bytes_per_window: q.bytesPerWindow,
      broadcasts_per_window: q.broadcastsPerWindow,
      live_offers: q.liveOffers,
      body_max_bytes: q.bodyMaxBytes,
      note_max_bytes: q.noteMaxBytes,
      notes_max_bytes: q.notesMaxBytes,
      orders_max: MAX_ORDERS,
      order_chars_max: MAX_ORDER_CHARS,
    },
    private: { brief: { codeword: p.own.brief.codeword, instruction: p.own.brief.instruction } },
    terminal: p.pub.terminal
      ? {
          ...p.pub.terminal,
          sc: { ...p.pub.terminal.sc },
          units: { ...p.pub.terminal.units },
          eliminated: [...p.pub.terminal.eliminated],
          standings: p.pub.terminal.standings.map((s) => ({ ...s })),
        }
      : null,
  };
}

/** Byte-stable serialisation for equality checks (sorted keys; see press.ts `canon`). */
export function canonicalObservation(o: unknown): string {
  return canon(o);
}
