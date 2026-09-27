/**
 * The Diplomacy wire mapping (contracts 2.1.0): engine shapes <-> the
 * `diplomacy_observation` / `diplomacy_action` frames.
 *
 * EGRESS is built by whitelist from `dipProjectForPower(ep, power)` — the
 * engine's single reader of the episode — and never from the episode itself;
 * `buildWireObservation` cannot receive a `DipEpisode` (it takes the
 * projection). Every private list is re-filtered by the viewer (defence in
 * depth), every id is converted to the contract form (full lower-case power
 * names, `dipOracles.contractId`), and press text is copied as an opaque
 * string. Differences from the engine's own `DipObservation`:
 *   - inbox / sent: the step that just closed only (contract: "delivered at
 *     the close of the PREVIOUS step"), not the whole movement window;
 *   - clause spans `from_phase` / `to_phase` (engine `from` / `to`);
 *   - step kinds `retreat` / `adjust` for the orders step of R / A phases;
 *   - engine rejects split into `press_rejects` (contract codes) and
 *     `order_feedback` (parse / step codes).
 *
 * INGRESS (`toEngineAction`) runs after whole-frame schema validation: JSON
 * orders become canonical order TEXT (the engine's one parser; `of_power` /
 * `of_type` accepted whatever key form the engine's interim JSON reader takes),
 * contract ids become engine ids, clause spans become engine keys, and the
 * intent's `phase` echo is checked here (a mismatch is `intent_wrong_phase`
 * edge feedback and the intent is dropped).
 */

import {
  dipClauseStatus,
  dipContractClauseStatus,
  dipContractSettlementStatus,
  dipOracles,
  DIP_POWER_ABBR,
  formatRaw,
  isParseError,
  MAX_ORDER_CHARS,
  MAX_ORDERS,
  rawFromJson,
  type DipAction,
  type DipClause,
  type DipCommitment,
  type DipDeliveredMessage,
  type DipObservation,
  type DipOffer,
  type DipOfferTerms,
  type DipPressQuotas,
  type DipProjection,
  type DipReject,
  type Power,
} from 'wot-engine';
import type { PowerSeat } from '../types.ts';

// ------------------------------------------------------------------ constants (contract limits)

/** `diplomacy_action` x-max-frame-bytes (contracts 2.1.0; 16 KiB for Diplomacy only). */
export const DIP_MAX_INBOUND_FRAME_BYTES = 16384;
/** Engine press constants the observation's `limits` block publishes (press.ts; not re-exported by the engine). */
export const DIP_LIMITS = Object.freeze({ groupMin: 2, groupMax: 5, asksMax: 6, clausesPerSideMax: 6, clauseSpanMaxPhases: 4 });

const ORDER_FEEDBACK_CODES: ReadonlySet<string> = new Set([
  'not_string',
  'too_long',
  'non_ascii',
  'bad_whitespace',
  'empty',
  'bad_token',
  'unknown_province',
  'unknown_coast',
  'trailing_tokens',
  'bad_json',
  'wrong_step',
  'intent_wrong_phase',
  'intent_not_your_unit',
  'intent_duplicate_unit',
]);
const PRESS_REJECT_CODES: ReadonlySet<string> = new Set([
  'press_too_large',
  'press_invalid_text',
  'press_quota',
  'press_not_in_round',
  'press_bad_recipient',
  'signature_invalid',
  'offer_unknown',
  'offer_self_accept',
  'offer_conflict',
  'commitment_unknown',
  'terms_invalid',
  'clause_beyond_horizon', // contracts 2.5.0 (F-1): sent on the wire as is
  'asks_invalid',
  'reply_to_unknown',
]);
const ILLEGAL_REASONS: ReadonlySet<string> = new Set([
  'wrong_phase',
  'no_unit',
  'not_your_unit',
  'move_to_self',
  'army_to_sea',
  'no_convoy_route',
  'fleet_convoy',
  'not_adjacent',
  'bad_coast',
  'coast_required',
  'support_own_area',
  'support_unreachable',
  'unsupportable_move',
  'convoy_from_coast',
  'convoy_not_army',
  'convoy_bad_destination',
  'convoy_not_needed',
  'retreat_not_allowed',
  'no_disbands',
  'no_builds',
  'build_not_home',
  'build_not_owned',
  'build_occupied',
  'build_fleet_inland',
  'too_many_orders',
]);

// ------------------------------------------------------------------ ids

const ABBR_TO_FULL = new Map<string, string>(Object.entries(DIP_POWER_ABBR).map(([full, abbr]) => [abbr, full]));
const FULL_RE = /:(austria|england|france|germany|italy|russia|turkey)(?=:|#|$)/g;

/** Engine id → contract id (full lower-case power names). Idempotent. */
export const cid = (engineId: string): string => dipOracles.contractId(engineId);
/** Contract id → engine id (the engine's transcript uses the three-letter abbreviations). */
export const eid = (contractId: string): string => contractId.replace(FULL_RE, (_m, p: string) => `:${DIP_POWER_ABBR[p as Power]}`);
/** Free engine text (reject details) with every embedded engine id converted. */
const cText = (s: string): string => dipOracles.contractId(s).replace(/:(AUS|ENG|FRA|GER|ITA|RUS|TUR):/g, (_m, a: string) => `:${ABBR_TO_FULL.get(a) ?? a}:`);

const seqOf = (msgId: string): number => Number(msgId.slice(msgId.lastIndexOf(':') + 1));
const movementPhaseAt = (idx: number): string => `${idx % 2 === 0 ? 'S' : 'F'}${1901 + Math.floor(idx / 2)}M`;

// ------------------------------------------------------------------ clauses / terms / messages

export type WireClause =
  | { kind: 'order'; phase: string; order: string }
  | { kind: 'no_enter'; from_phase: string; to_phase: string; provinces: string[] }
  | { kind: 'no_attack' | 'no_support_against'; from_phase: string; to_phase: string; power: string };

export function wireClause(c: DipClause): WireClause {
  switch (c.kind) {
    case 'order':
      return { kind: 'order', phase: c.phase, order: c.order };
    case 'no_enter':
      return { kind: 'no_enter', from_phase: c.from, to_phase: c.to, provinces: [...c.provinces] };
    case 'no_attack':
    case 'no_support_against':
      return { kind: c.kind, from_phase: c.from, to_phase: c.to, power: c.power };
  }
}

const wireTerms = (t: DipOfferTerms): Record<string, unknown> => ({
  give: t.give.map(wireClause),
  want: t.want.map(wireClause),
  ...(t.note !== undefined ? { note: t.note } : {}),
});

/** Inbound clause (schema-valid) → engine clause keys. Unknown shapes pass through for the engine to refuse. */
function engineClause(c: unknown): unknown {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return c;
  const o = c as Record<string, unknown>;
  if (o.kind === 'order') return { kind: 'order', phase: o.phase, order: o.order };
  if ('from_phase' in o || 'to_phase' in o) {
    const { from_phase, to_phase, ...rest } = o;
    return { ...rest, from: from_phase, to: to_phase };
  }
  return o;
}

function engineTerms(t: unknown): unknown {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return t;
  const o = t as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (o.give !== undefined) out.give = Array.isArray(o.give) ? o.give.map(engineClause) : o.give;
  if (o.want !== undefined) out.want = Array.isArray(o.want) ? o.want.map(engineClause) : o.want;
  if (o.note !== undefined) out.note = o.note;
  return out;
}

export function wireMessage(m: DipDeliveredMessage): Record<string, unknown> {
  const to =
    m.to.kind === 'private' ? { kind: 'private', power: m.to.power } : m.to.kind === 'group' ? { kind: 'group', powers: [...m.to.powers] } : { kind: 'broadcast' };
  const out: Record<string, unknown> = {
    msg_id: cid(m.msg_id),
    from: m.from,
    to,
    move: m.move,
    phase: m.phase,
    round: m.round,
    seq: seqOf(m.msg_id),
    delivered_tick: m.delivered_tick,
  };
  if (m.body !== null) out.body = m.body;
  if (m.reply_to !== null) out.reply_to = cid(m.reply_to);
  if (m.asks !== null) out.asks = [...m.asks];
  if (m.terms !== null) out.terms = wireTerms(m.terms);
  if (m.terms_hash !== null) out.terms_hash = m.terms_hash;
  if (m.respond_to !== null) out.respond_to = cid(m.respond_to);
  if (m.expires_after_round !== null) out.expires_after_round = m.expires_after_round;
  if (m.sig_mode !== null && m.move !== 'press') out.sig_mode = m.sig_mode;
  return out;
}

function wireOffer(o: DipOffer): Record<string, unknown> {
  return {
    offer_id: cid(o.id),
    move: o.counter_of ? 'counter' : 'offer',
    from: o.from,
    to: o.to,
    phase: o.phase,
    ...(o.counter_of ? { counters: cid(o.counter_of) } : {}),
    terms: wireTerms(o.terms),
    terms_hash: o.terms_hash,
    made_tick: o.made_tick,
    expires_after_round: o.expires_after_round,
    status: 'pending',
    sig_mode: o.sig_mode,
  };
}

function renounceSigMode(modes: RenounceSigModes, msgId: string): 'key' | 'session' {
  const m = modes.get(msgId);
  // Fail closed: an unknown mode is never guessed (nor inherited from the commitment, signing.md §7.4).
  if (m === undefined) throw new Error(`wire: no recorded sig_mode for renounce ${msgId} (pass WireContext.renounceSigModes); refusing to guess`);
  return m;
}

/** Engine msg_id of a renounce → the mode the engine recorded when it accepted that message (signing.md §7.4). */
export type RenounceSigModes = ReadonlyMap<string, 'key' | 'session'>;

/**
 * The recorded `sig_mode` of every renounce message that renounced one of `power`'s commitments, by engine
 * msg_id. For the egress CALLER (it reads the episode's delivered log, which the projection only carries for
 * the current movement window): a renounced commitment stays visible while any clause is escrowed, i.e. into
 * later phases, where the renounce message is no longer in the projection. Only messages the viewer sent or
 * received are read, and only their mode.
 */
export function dipRenounceSigModes(log: readonly DipDeliveredMessage[], power: Power): Map<string, 'key' | 'session'> {
  const out = new Map<string, 'key' | 'session'>();
  for (const m of log) {
    if (m.move !== 'renounce' || m.sig_mode === null) continue;
    if (m.from !== power && !m.recipients.includes(power)) continue;
    out.set(m.msg_id, m.sig_mode);
  }
  return out;
}

/** Engine commitment → contract `diplomacy_commitment` (exported for the adapter tests). */
export function wireCommitment(c: DipCommitment, renounceModes: RenounceSigModes): Record<string, unknown> {
  let active = false;
  const clauses = c.clauses.map((cl) => {
    // contracts 2.5.0: status = the aggregate (broken > kept > renounced | released by the latest
    // release > void); settled_phase / settled_tick = the LAST settlement; `settlements[]` = the
    // per-phase history in phase order (the engine settles phases in order), even while escrowed.
    const st = dipContractClauseStatus(dipClauseStatus(cl), cl.settlements);
    const w: Record<string, unknown> = { index: cl.index, side: cl.side, obligor: cl.obligor, clause: wireClause(cl.clause), status: st };
    if (st === 'escrowed') active = true;
    else {
      const last = cl.settlements[cl.settlements.length - 1];
      w.settled_phase = last.phase;
      w.settled_tick = last.tick;
    }
    if (cl.settlements.length > 0) w.settlements = cl.settlements.map((x) => ({ phase: x.phase, status: dipContractSettlementStatus(x), tick: x.tick }));
    return w;
  });
  const out: Record<string, unknown> = {
    cmt_id: cid(c.id),
    parties: [c.parties[0], c.parties[1]],
    offer_msg_id: cid(c.offer_msg_id),
    accept_msg_id: cid(c.accept_msg_id),
    terms_hash: c.terms_hash,
    bound_tick: c.bound_tick,
    sig_mode: c.sig_mode,
    state: active ? 'active' : 'ended',
    clauses,
  };
  if (c.renounced) {
    const rel = c.releases.find((r) => r.by === 'renounce');
    out.renounced = {
      msg_id: cid(c.renounced.msg_id),
      by: c.renounced.by,
      counterparty: c.parties[0] === c.renounced.by ? c.parties[1] : c.parties[0],
      cmt_id: cid(c.id),
      phase: c.renounced.phase,
      round: c.renounced.round,
      delivered_tick: c.renounced.tick,
      releases_from_phase: movementPhaseAt(rel ? rel.from_index : 0),
      // contracts 2.4.0 (B3a item 4): the renounce message's OWN recorded mode, never the commitment's.
      sig_mode: renounceSigMode(renounceModes, c.renounced.msg_id),
    };
  }
  return out;
}

// ------------------------------------------------------------------ rejects → contract feedback

export interface OrderFeedback {
  source: 'orders' | 'intent';
  index: number;
  code: string;
}

export interface PressRejectOut {
  msg_index: number;
  code: string;
  hint: string;
  phase: string;
  round?: number;
  tick: number;
}

/** Engine press reject → contract `diplomacy_press_reject.code` (errors.md §3e). */
export function pressRejectCode(r: Pick<DipReject, 'code' | 'detail'>, move?: string): string {
  // `clause_beyond_horizon` (F-1) is in the set since contracts 2.5.0: sent unchanged.
  if (PRESS_REJECT_CODES.has(r.code)) return r.code;
  const d = r.detail;
  if (r.code === 'wrong_step') return 'press_not_in_round';
  if (/^(to\b|to\.|group|offer moves are private)/.test(d)) return 'press_bad_recipient';
  if (/^reply_to/.test(d)) return 'reply_to_unknown';
  if (/^asks/.test(d)) return 'asks_invalid';
  if (/^respond_to/.test(d)) return move === 'renounce' ? 'commitment_unknown' : 'offer_unknown';
  if (/^press needs a body/.test(d)) return 'press_invalid_text';
  return 'terms_invalid';
}

/** Engine orders/intent/action reject → contract `order_feedback` entry. */
export function orderFeedback(r: DipReject): OrderFeedback {
  const source: OrderFeedback['source'] = r.kind === 'intent' ? 'intent' : 'orders';
  const index = Math.min(63, Math.max(0, r.index ?? 0));
  let code: string;
  if (r.code === 'wrong_step') code = 'wrong_step';
  else if (r.code === 'order_parse_error') code = ORDER_FEEDBACK_CODES.has(r.detail) ? r.detail : 'bad_token';
  else if (r.code === 'press_too_large') code = 'too_long';
  else if (r.code === 'press_invalid_text') code = 'bad_token';
  else if (/unit you do not own/.test(r.detail)) code = 'intent_not_your_unit';
  else if (/two intent orders for one unit/.test(r.detail)) code = 'intent_duplicate_unit';
  else {
    const m = /^intent order: ([a-z_]+)$/.exec(r.detail);
    code = m && ORDER_FEEDBACK_CODES.has(m[1]) ? m[1] : 'bad_json';
  }
  return { source, index, code };
}

// ------------------------------------------------------------------ egress

export interface WireContext {
  deadlineMs: number;
  hardDeadlineMs: number;
  /** R of the episode (the contract's rounds_total, ≥ 1 on every step). */
  pressRounds: number;
  /** Adapter (edge) feedback for the viewer's previous submission. */
  edgeFeedback: readonly OrderFeedback[];
  /** The viewer's previous batch, for the offer-vs-commitment reading of `respond_to` rejects. */
  previousPressMoves?: readonly (string | undefined)[];
  /**
   * (contracts 2.4.0) Recorded modes of renounces delivered BEFORE the current movement window
   * (`dipRenounceSigModes(ep.press.log, power)`). Renounces in the window are read from the projection.
   * Without it, a renounced commitment still visible after its renounce's window refuses egress.
   */
  renounceSigModes?: RenounceSigModes;
}

/** The `diplomacy_observation` frame BODY (the edge adds t, protocol_version, episode_id, nonce). */
export type DiplomacyObservationBody = Record<string, unknown> & { scenario_id: 'diplomacy_standard'; power: PowerSeat; turn_id: number };

const stepKindOf = (phase: string, kind: string): string => (kind !== 'orders' ? kind : phase.endsWith('R') ? 'retreat' : phase.endsWith('A') ? 'adjust' : 'orders');

/**
 * Projection (+ the engine's builder over the SAME projection for derived board fields) →
 * contract frame body. Pure. Everything private is re-filtered by `me`.
 */
export function buildWireObservation(p: DipProjection, obs: DipObservation, w: WireContext): DiplomacyObservationBody {
  const me = p.own.power as PowerSeat;
  if (obs.you.power !== me) throw new Error('wire: observation and projection disagree on the viewer');
  const tick = p.pub.tick;
  const phase = p.pub.phaseId;
  const kind = stepKindOf(phase, p.pub.step.kind);
  const prev = tick - 1;
  const q: DipPressQuotas = p.quotas;

  const step: Record<string, unknown> = { kind, rounds_total: w.pressRounds };
  if (kind === 'press') step.round = p.pub.step.round;

  const inbox = p.inbox.messages.filter((m) => m.recipients.includes(me) && m.from !== me && m.delivered_tick === prev).map(wireMessage);
  const sent = p.own.sent.filter((m) => m.from === me && m.delivered_tick === prev).map(wireMessage);

  const pressRound = (): number | undefined => {
    // The step that produced last tick's rejects: press round k-1 (current r_k, k > 1), or rR (current orders step of a movement phase).
    if (kind === 'press' && p.pub.step.round > 1) return p.pub.step.round - 1;
    if (kind === 'orders') return w.pressRounds;
    return undefined;
  };
  const ownRejects = p.own.rejects.filter((r) => r.power === me);
  const press_rejects: PressRejectOut[] = [];
  const order_feedback: OrderFeedback[] = [];
  for (const r of ownRejects) {
    if (r.kind === 'press') {
      const code = pressRejectCode(r, r.index !== null ? w.previousPressMoves?.[r.index] : undefined);
      const round = code === 'press_not_in_round' ? undefined : pressRound();
      const hint = cText(r.detail).slice(0, 200) || code;
      press_rejects.push({ msg_index: Math.min(11, Math.max(0, r.index ?? 0)), code, hint, phase: r.phase, ...(round !== undefined ? { round } : {}), tick: r.tick });
    } else {
      order_feedback.push(orderFeedback(r));
    }
  }
  for (const f of w.edgeFeedback) order_feedback.push({ ...f });

  const offers = p.own.offers.filter((o) => o.status === 'live' && (o.from === me || o.to === me)).map(wireOffer);
  // Renounce modes: the window's own messages (sent or received) first, then the caller's earlier record.
  const renounceModes = new Map<string, 'key' | 'session'>(w.renounceSigModes ?? []);
  for (const m of [...p.own.sent, ...p.inbox.messages]) {
    if (m.move === 'renounce' && m.sig_mode !== null && (m.from === me || m.recipients.includes(me))) renounceModes.set(m.msg_id, m.sig_mode);
  }
  const commitments = p.own.commitments
    .filter((c) => c.parties[0] === me || c.parties[1] === me)
    // contracts 2.4.0: every active commitment, plus each one that ENDED (its last escrowed clause settled)
    // at the close of the previous step: an ended commitment is in exactly one observation. A renounce
    // settles nothing by itself (its released clauses settle at their phases' adjudications), so a renounce
    // of an already-ended commitment does not show it again.
    .filter((c) => {
      const settled = c.clauses.map((cl) => (dipClauseStatus(cl) === 'escrowed' ? null : cl.settlements[cl.settlements.length - 1].tick));
      return settled.includes(null) || Math.max(...(settled as number[])) === prev;
    })
    .map((c) => wireCommitment(c, renounceModes))
    .slice(-32);

  const it = p.own.intent && p.own.intent.power === me ? p.own.intent : null;
  const intent = it
    ? { phase: it.phase, version: it.version, recorded_tick: it.tick, orders: [...it.orders], ...(it.notes !== null && it.notes !== '' ? { notes: it.notes } : {}) }
    : null;

  const ql = obs.quotas_left;
  const lastPhase = obs.last_phase
    ? {
        phase: obs.last_phase.phase_id,
        orders: obs.last_phase.orders.map((o) => {
          const r: Record<string, unknown> = { power: o.power, order: o.order.slice(0, MAX_ORDER_CHARS), status: o.status };
          if (o.result !== undefined) r.result = o.result;
          if (o.reason !== undefined && ILLEGAL_REASONS.has(o.reason)) r.reason = o.reason;
          return r;
        }),
      }
    : null;

  return {
    scenario_id: 'diplomacy_standard',
    power: me,
    turn_id: tick,
    deadline_ms: w.deadlineMs,
    hard_deadline_ms: w.hardDeadlineMs,
    phase,
    step,
    horizon: { final_year: obs.horizon.final_year, years_remaining: obs.horizon.years_remaining },
    board: {
      units: [...obs.board.units].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((u) => ({ power: u.power, type: u.type, at: u.at })),
      supply_centers: { ...obs.board.supply_centers },
      sc_counts: { ...obs.board.sc_counts },
      unit_counts: { ...obs.board.unit_counts },
    },
    dislodged: obs.dislodged.map((d) => ({ power: d.power, type: d.type, at: d.at, retreat_options: [...d.retreat_options] })),
    adjustment: obs.adjustment ? { delta: obs.adjustment.delta, buildable: [...obs.adjustment.buildable] } : null,
    last_phase: lastPhase,
    private: { brief: { codeword: obs.private.brief.codeword, instruction: obs.private.brief.instruction }, intent },
    inbox: inbox.slice(0, 72),
    sent: sent.slice(0, 12),
    press_rejects: press_rejects.slice(0, 12),
    order_feedback: order_feedback.slice(0, 128),
    offers: offers.slice(0, 32),
    commitments,
    quotas: {
      messages_round: Math.min(q.msgsPerRound, ql.msgs_window),
      messages_window: ql.msgs_window,
      body_bytes_window: ql.bytes_window,
      broadcasts_window: ql.broadcasts_window,
      live_offers: ql.live_offers,
    },
    limits: {
      press_rounds: w.pressRounds,
      messages_per_round: q.msgsPerRound,
      messages_per_window: q.msgsPerWindow,
      body_bytes_per_window: q.bytesPerWindow,
      broadcasts_per_window: q.broadcastsPerWindow,
      live_offers_max: q.liveOffers,
      body_max_bytes: q.bodyMaxBytes,
      body_raw_max_bytes: q.rawTextMaxBytes,
      offer_note_max_bytes: q.noteMaxBytes,
      intent_notes_max_bytes: q.notesMaxBytes,
      group_min: DIP_LIMITS.groupMin,
      group_max: DIP_LIMITS.groupMax,
      asks_max: DIP_LIMITS.asksMax,
      clauses_per_side_max: DIP_LIMITS.clausesPerSideMax,
      clause_span_max_phases: DIP_LIMITS.clauseSpanMaxPhases,
      orders_max: MAX_ORDERS,
      order_chars_max: MAX_ORDER_CHARS,
      frame_max_bytes: Math.min(q.frameMaxBytes, DIP_MAX_INBOUND_FRAME_BYTES),
    },
  };
}

// ------------------------------------------------------------------ ingress

/** What the target submits for one step (the `diplomacy_action` frame minus the envelope; `thought` dropped). */
export interface DiplomacyActionPayload {
  orders?: unknown;
  intent?: unknown;
  press?: unknown;
}

/** One wire order (text or the contract JSON form) → canonical text, or the input unchanged for the engine to refuse. */
export function wireOrderToEngine(o: unknown): unknown {
  if (typeof o === 'string' || typeof o !== 'object' || o === null || Array.isArray(o)) return o;
  const first = rawFromJson(o);
  if (!isParseError(first)) return formatRaw(first);
  const src = o as Record<string, unknown>;
  if ('of_power' in src || 'of_type' in src) {
    const { of_power, of_type, ...rest } = src;
    const alt = rawFromJson({ ...rest, ...(of_power !== undefined ? { ofPower: of_power } : {}), ...(of_type !== undefined ? { ofType: of_type } : {}) });
    if (!isParseError(alt)) return formatRaw(alt);
  }
  return o;
}

function enginePress(m: unknown): unknown {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
  const o = { ...(m as Record<string, unknown>) };
  if (typeof o.reply_to === 'string') o.reply_to = eid(o.reply_to);
  if (typeof o.respond_to === 'string') o.respond_to = eid(o.respond_to);
  if (o.terms !== undefined) o.terms = engineTerms(o.terms);
  return o;
}

/**
 * Schema-valid payload → the engine's `DipAction` for the current step, plus edge feedback.
 * `movementPhase` is the phase of the current step when it is a movement phase, else null.
 */
export function toEngineAction(payload: DiplomacyActionPayload, currentPhase: string): { action: DipAction; feedback: OrderFeedback[] } {
  const action: DipAction = {};
  const feedback: OrderFeedback[] = [];
  if (payload.orders !== undefined) action.orders = Array.isArray(payload.orders) ? payload.orders.map(wireOrderToEngine) : payload.orders;
  if (payload.intent !== undefined) {
    const it = payload.intent as { phase?: unknown; orders?: unknown; notes?: unknown };
    if (it.phase !== currentPhase) feedback.push({ source: 'intent', index: 0, code: 'intent_wrong_phase' });
    else action.intent = { orders: Array.isArray(it.orders) ? it.orders.map(wireOrderToEngine) : it.orders, ...(it.notes !== undefined ? { notes: it.notes } : {}) };
  }
  if (payload.press !== undefined) action.press = Array.isArray(payload.press) ? payload.press.map(enginePress) : payload.press;
  return { action, feedback };
}

/**
 * The inverse of `toEngineAction` for in-process agents that speak the engine's action shape
 * (reference agents served as local targets, transport-invariance tests): engine `DipAction`
 * → the wire payload of a `diplomacy_action` frame for the step of `currentPhase`.
 */
export function engineActionToWire(action: DipAction, currentPhase: string): DiplomacyActionPayload {
  const out: DiplomacyActionPayload = {};
  if (action.orders !== undefined) out.orders = action.orders;
  if (action.intent !== undefined) {
    const it = action.intent as { orders?: unknown; notes?: unknown };
    out.intent = { phase: currentPhase, orders: it.orders, ...(it.notes !== undefined && it.notes !== null ? { notes: it.notes } : {}) };
  }
  if (action.press !== undefined) {
    out.press = Array.isArray(action.press)
      ? action.press.map((m: unknown) => {
          if (typeof m !== 'object' || m === null) return m;
          const src = m as Record<string, unknown>;
          const o: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(src)) if (v !== undefined) o[k] = v;
          if (typeof o.reply_to === 'string') o.reply_to = cid(o.reply_to);
          if (typeof o.respond_to === 'string') o.respond_to = cid(o.respond_to);
          if (o.terms && typeof o.terms === 'object') {
            const t = o.terms as DipOfferTerms;
            o.terms = wireTerms(t);
          }
          return o;
        })
      : action.press;
  }
  return out;
}
