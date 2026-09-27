/**
 * Diplomacy frames on the wire (contracts 2.1.0: `diplomacy_observation`,
 * `diplomacy_action`, `diplomacy_episode_end`) <-> the engine's shapes
 * (`wot-engine/src/diplomacy/observation.ts`, `DipAction`).
 *
 * The engine keeps its pinned internal forms (hash-bearing) and this module is
 * the ONLY translation between them. Every difference is mechanical and
 * reversible:
 *
 *   | engine (hashed, pinned)          | wire (contract)                       |
 *   |----------------------------------|---------------------------------------|
 *   | `prs:S1901M:r1:AUS:1`, `cmt:prs…` | `prs:S1901M:r1:austria:1`, `cmt:prs…` |
 *   | clause `from` / `to`             | clause `from_phase` / `to_phase`      |
 *   | step `orders` in R / A phases    | step `retreat` / `adjust`             |
 *   | `tick`                           | `turn_id`                             |
 *   | intent `{orders, notes}`         | intent `{phase, orders, notes}`       |
 *   | reject `{kind, code, detail}`    | `press_rejects[]` / `order_feedback[]`|
 *
 * The observation is built from the engine's whitelist observation (itself
 * built from `projectForPower`), never from the episode: nothing here can add a
 * field the engine did not project for this power.
 *
 * `fromWireObservation` / `toWireAction` are the CLIENT direction (a reference
 * agent speaking the wire); the e2e test drives the seven reference agents
 * through them, and the resulting hashes prove the translation is lossless for
 * everything that reaches the engine.
 */

import {
  DIP_LIMITS,
  DIP_POWER_ABBR,
  DIP_PRESS_REJECT_CODES,
  dipContractClauseStatus,
  dipContractSettlementStatus,
  formatRaw,
  isParseError,
  POWERS,
  rawFromJson,
  type DipAction,
  type DipClause,
  type DipEpisode,
  type DipObservation,
  type DipOfferTerms,
  type DipPressQuotas,
  type DipRecipients,
  type Power,
} from 'wot-engine';

export const DIPLOMACY_SCENARIO_ID = 'diplomacy_standard';
/** `diplomacy_action` inbound cap (the only scenario above 8192). */
export const DIP_FRAME_MAX_BYTES = DIP_LIMITS.frameMaxBytes;
export const DIP_PROTOCOL_VERSION = '1.0';

type ObsMessage = DipObservation['inbox'][number];
type ObsOffer = DipObservation['offers_live'][number];
type ObsCommitment = DipObservation['commitments'][number];
type ObsReject = DipObservation['rejects'][number];
type W = Record<string, unknown>;

const ABBR_TO_POWER: Readonly<Record<string, Power>> = Object.freeze(
  Object.fromEntries(POWERS.map((p) => [DIP_POWER_ABBR[p], p])) as Record<string, Power>,
);
const isPower = (v: unknown): v is Power => typeof v === 'string' && (POWERS as readonly string[]).includes(v);

// ------------------------------------------------------------------ ids

const ENGINE_ID_RE = /^(cmt:)?prs:([SF]\d{4}M):r(\d+):([A-Z]{3}):(\d+)$/;
const WIRE_ID_RE = /^(cmt:)?prs:([SF]\d{4}M):r(\d+):([a-z]+):(\d+)$/;

/** Engine id → wire id (`AUS` → `austria`). Anything else is returned unchanged. */
export function engineIdToWire(id: string): string {
  const m = ENGINE_ID_RE.exec(id);
  if (!m || !ABBR_TO_POWER[m[4]]) return id;
  return `${m[1] ?? ''}prs:${m[2]}:r${m[3]}:${ABBR_TO_POWER[m[4]]}:${m[5]}`;
}

/** Wire id → engine id. An unrecognised id is passed through (the engine refuses it as not found). */
export function wireIdToEngine(id: unknown): unknown {
  if (typeof id !== 'string') return id;
  const m = WIRE_ID_RE.exec(id);
  if (!m || !isPower(m[4])) return id;
  return `${m[1] ?? ''}prs:${m[2]}:r${m[3]}:${DIP_POWER_ABBR[m[4]]}:${m[5]}`;
}

/** The wire id the engine will assign: `prs:<phase>:r<round>:<power>:<seq>` (seq is 1-based). */
export const wireMsgId = (phase: string, round: number, power: Power, seq: number): string => `prs:${phase}:r${round}:${power}:${seq}`;

const idParts = (engineId: string): { phase: string; round: number; seq: number } | null => {
  const m = ENGINE_ID_RE.exec(engineId);
  return m ? { phase: m[2], round: Number(m[3]), seq: Number(m[5]) } : null;
};

// ------------------------------------------------------------------ clauses and terms

export function clauseToWire(c: DipClause): W {
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

export function termsToWire(t: DipOfferTerms): W {
  const out: W = { give: t.give.map(clauseToWire), want: t.want.map(clauseToWire) };
  if (t.note !== undefined) out.note = t.note;
  return out;
}

/** Wire clause → engine clause shape. Untrusted: only renames keys; the engine validates everything. */
export function clauseFromWire(c: unknown): unknown {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return c;
  const o = c as W;
  if (o.kind === 'order') return { ...o };
  const out: W = {};
  for (const [k, v] of Object.entries(o)) out[k === 'from_phase' ? 'from' : k === 'to_phase' ? 'to' : k] = v;
  return out;
}

export function termsFromWire(t: unknown): unknown {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return t;
  const o = t as W;
  const out: W = { ...o };
  if (Array.isArray(o.give)) out.give = o.give.map(clauseFromWire);
  if (Array.isArray(o.want)) out.want = o.want.map(clauseFromWire);
  return out;
}

// ------------------------------------------------------------------ phase arithmetic

const nextMovementPhase = (ph: string): string => {
  const m = /^([SF])(\d{4})M$/.exec(ph);
  if (!m) return ph;
  return m[1] === 'S' ? `F${m[2]}M` : `S${Number(m[2]) + 1}M`;
};

// ------------------------------------------------------------------ rejects → press_rejects / order_feedback

const PRESS_REJECT_CODES: ReadonlySet<string> = new Set(DIP_PRESS_REJECT_CODES);
const ORDER_FEEDBACK_CODES = new Set([
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

/**
 * Engine press reject → contract `diplomacy_press_reject.code`. The engine uses the
 * 14 contract codes (B3a; `clause_beyond_horizon` since contracts 2.5.0, sent as is);
 * `invalid_request` marks a structural defect the schema refuses at the edge, so it
 * cannot arrive here through the wire.
 */
export function pressRejectCode(r: Pick<ObsReject, 'code'>): string {
  return PRESS_REJECT_CODES.has(r.code) ? r.code : 'terms_invalid';
}

/** Engine orders/intent reject → contract `order_feedback.code`. */
export function orderFeedbackCode(r: Pick<ObsReject, 'code' | 'detail'>): string {
  switch (r.code) {
    case 'wrong_step':
    case 'intent_not_your_unit':
    case 'intent_duplicate_unit':
      return r.code;
    case 'order_parse_error': {
      // detail is the parser's code for orders, `intent order: <code>` for intents.
      const code = r.detail.startsWith('intent order: ') ? r.detail.slice('intent order: '.length) : r.detail;
      return ORDER_FEEDBACK_CODES.has(code) ? code : 'bad_token';
    }
    case 'press_too_large':
    case 'too_many_orders':
      return 'too_long';
    default:
      return 'bad_token';
  }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

// ------------------------------------------------------------------ observation (server direction)

/** Feedback produced by the transport itself (never reaches the engine; next observation only). */
export interface TransportFeedback {
  orderFeedback: W[];
}

export interface WireObservationContext {
  episodeId: string;
  nonce: string;
  softMs: number;
  hardMs: number;
  /** Press rounds R of this table (the engine reports 0 in retreat/adjust steps). */
  pressRounds: number;
  quotas: DipPressQuotas;
  /**
   * The previous step (the one the engine's rejects in this observation refer to):
   * its phase, its press round (null outside press steps) and the moves of the
   * viewer's batch there, by index (annotates `press_rejects[].move`).
   */
  prev?: { phase: string; round: number | null; moves: readonly (string | undefined)[] };
  /**
   * Engine msg_id → the mode the engine recorded for each renounce message this power sent or received
   * (`renounceSigModes(ep.press.log, power)`). A renounced commitment stays visible while a clause is
   * escrowed, i.e. past the renounce's own movement window, so the window's messages are not enough.
   */
  renounceSigModes: ReadonlyMap<string, 'key' | 'session'>;
  transport?: TransportFeedback;
}

/** The recorded mode of every renounce `power` sent or received, by engine msg_id (signing.md §7.4). */
export function renounceSigModes(log: DipEpisode['press']['log'], power: Power): Map<string, 'key' | 'session'> {
  const out = new Map<string, 'key' | 'session'>();
  for (const m of log) {
    if (m.move !== 'renounce' || m.sig_mode === null) continue;
    if (m.from === power || m.recipients.includes(power)) out.set(m.msg_id, m.sig_mode);
  }
  return out;
}

/** The tick at which a commitment ended (its last escrowed clause settled), or null while any clause is escrowed. */
function commitmentEndTick(c: ObsCommitment): number | null {
  let end = -1;
  for (const cl of c.clauses) {
    if (cl.status === 'escrowed' || cl.settlements.length === 0) return null;
    end = Math.max(end, cl.settlements[cl.settlements.length - 1].tick);
  }
  return end;
}

/**
 * Contract `commitments` (2.4.0): every active commitment this power is a party to, plus each one that
 * ENDED at the close of the previous step. An ended commitment is in exactly one observation, the one
 * after the close at which it ended (like every round-close delivery). A renounce settles nothing by
 * itself: the clauses it releases settle `renounced` at their phases' adjudications, so a renounced
 * commitment stays active (and visible) until then, including one renounced before the first adjudication.
 */
export function commitmentVisible(c: ObsCommitment, observationTick: number): boolean {
  const end = commitmentEndTick(c);
  return end === null || end === observationTick - 1;
}

function messageToWire(m: ObsMessage): W {
  const p = idParts(m.msg_id);
  const w: W = {
    msg_id: engineIdToWire(m.msg_id),
    from: m.from,
    to: m.to,
    move: m.move,
    phase: p?.phase ?? '',
    round: p?.round ?? 0,
    seq: p?.seq ?? 0,
    delivered_tick: m.delivered_tick,
  };
  if (m.body !== null) w.body = m.body;
  if (m.reply_to !== null) w.reply_to = engineIdToWire(m.reply_to);
  if (m.asks !== null) w.asks = [...m.asks];
  if (m.terms !== null) w.terms = termsToWire(m.terms);
  if (m.terms_hash !== null) w.terms_hash = m.terms_hash;
  if (m.respond_to !== null) w.respond_to = engineIdToWire(m.respond_to);
  if (m.expires_after_round !== null) w.expires_after_round = m.expires_after_round;
  if (m.sig_mode !== null) w.sig_mode = m.sig_mode;
  return w;
}

/**
 * contracts 2.5.0: `status` = the aggregate (broken > kept > renounced | released by the LATEST
 * release > void; `renounced` only when that latest release was by the renounce), and
 * `settled_phase` / `settled_tick` = the LAST settlement (never the first broken one).
 */
function clauseStatusToWire(c: ObsCommitment['clauses'][number]): { status: string; settled?: { phase: string; tick: number } } {
  const status = dipContractClauseStatus(c.status, c.settlements);
  if (status === 'escrowed') return { status };
  const last = c.settlements[c.settlements.length - 1];
  return last ? { status, settled: { phase: last.phase, tick: last.tick } } : { status };
}

export function commitmentToWire(c: ObsCommitment, renounceModes: ReadonlyMap<string, 'key' | 'session'>, pressRounds: number): W {
  const clauses = c.clauses.map((cl) => {
    const st = clauseStatusToWire(cl);
    const w: W = { index: cl.index, side: cl.obligor === c.parties[0] ? 'give' : 'want', obligor: cl.obligor, clause: clauseToWire(cl.clause), status: st.status };
    if (st.settled) {
      w.settled_phase = st.settled.phase;
      w.settled_tick = st.settled.tick;
    }
    // contracts 2.5.0: the per-phase history, in phase order, also while the clause is escrowed.
    if (cl.settlements.length > 0) w.settlements = cl.settlements.map((x) => ({ phase: x.phase, status: dipContractSettlementStatus(x), tick: x.tick }));
    return w;
  });
  // Contract `state`: ended = every clause has settled (a renounce alone does not end a commitment).
  const ended = commitmentEndTick(c) !== null;
  const w: W = {
    cmt_id: engineIdToWire(c.cmt_id),
    parties: [...c.parties],
    offer_msg_id: engineIdToWire(c.offer_msg_id),
    accept_msg_id: engineIdToWire(c.accept_msg_id),
    terms_hash: c.terms_hash,
    bound_tick: c.bound_tick,
    sig_mode: c.sig_mode,
    state: ended ? 'ended' : 'active',
    clauses,
  };
  if (c.renounced) {
    const p = idParts(c.renounced.msg_id);
    const phase = p?.phase ?? '';
    const round = p?.round ?? 1;
    const by = c.renounced.by;
    w.renounced = {
      msg_id: engineIdToWire(c.renounced.msg_id),
      by,
      counterparty: c.parties[0] === by ? c.parties[1] : c.parties[0],
      cmt_id: engineIdToWire(c.cmt_id),
      phase,
      round,
      delivered_tick: c.renounced.tick,
      // Engine rule (press.ts closePressRound): notice by the close of round R−1 releases this phase.
      releases_from_phase: round <= pressRounds - 1 ? phase : nextMovementPhase(phase),
      // contracts 2.4.0 (B3a item 4): the renounce message's OWN recorded mode; never the commitment's.
      sig_mode: renounceModeOf(renounceModes, c.renounced.msg_id),
    };
  }
  return w;
}

function renounceModeOf(modes: ReadonlyMap<string, 'key' | 'session'>, msgId: string): 'key' | 'session' {
  const m = modes.get(msgId);
  // Unreachable with the table's full-log map; fail closed rather than guess (or inherit) a mode.
  if (m === undefined) throw new Error(`diplomacy wire: no recorded sig_mode for renounce ${msgId}`);
  return m;
}

function offerToWire(o: ObsOffer, known: ReadonlyMap<string, ObsMessage>): W {
  // Offers never outlive their movement window, so the carrying message is always in this window's inbox or sent list.
  const m = known.get(o.offer_id);
  const w: W = {
    offer_id: engineIdToWire(o.offer_id),
    move: o.counter_of ? 'counter' : 'offer',
    from: o.from,
    to: o.to,
    phase: idParts(o.offer_id)?.phase ?? '',
    terms: termsToWire(o.terms),
    terms_hash: o.terms_hash,
    made_tick: m?.delivered_tick ?? 1,
    expires_after_round: o.expires_after_round,
    status: 'pending',
    sig_mode: m?.sig_mode ?? 'session',
  };
  if (o.counter_of) w.counters = engineIdToWire(o.counter_of);
  return w;
}

/** Engine observation (already the whitelist view for one power) → contract `diplomacy_observation`. */
export function toWireObservation(o: DipObservation, ctx: WireObservationContext): W {
  const phaseKind = o.phase_id.slice(-1);
  const kind = o.step.kind !== 'orders' ? o.step.kind : phaseKind === 'R' ? 'retreat' : phaseKind === 'A' ? 'adjust' : 'orders';
  const step: W = { kind, rounds_total: Math.max(1, ctx.pressRounds) };
  if (kind === 'press') step.round = o.step.round;

  const known = new Map<string, ObsMessage>();
  for (const m of [...o.inbox, ...o.press_sent]) known.set(m.msg_id, m);

  const pressRejects: W[] = [];
  const orderFeedback: W[] = [...(ctx.transport?.orderFeedback ?? [])];
  for (const r of o.rejects) {
    if (r.kind === 'press') {
      const move = r.index !== null ? ctx.prev?.moves[r.index] : undefined;
      const w: W = { msg_index: Math.min(11, Math.max(0, r.index ?? 0)), code: pressRejectCode(r), hint: clip(r.detail || r.code, 200), phase: ctx.prev?.phase ?? o.phase_id, tick: Math.max(0, o.tick - 1) };
      if (move !== undefined) w.move = move;
      if (ctx.prev?.round) w.round = ctx.prev.round;
      pressRejects.push(w);
    } else if (r.kind === 'orders' || r.kind === 'intent') {
      orderFeedback.push({ source: r.kind, index: Math.max(0, r.index ?? 0), code: orderFeedbackCode(r) });
    }
    // `action`-kind rejects (unreadable action, eliminated power) have no wire field: the transport never lets them arise.
  }

  const q = ctx.quotas;
  const intent = o.intent_echo;
  const w: W = {
    t: 'diplomacy_observation',
    protocol_version: DIP_PROTOCOL_VERSION,
    episode_id: ctx.episodeId,
    scenario_id: DIPLOMACY_SCENARIO_ID,
    power: o.you.power,
    turn_id: o.tick,
    nonce: ctx.nonce,
    deadline_ms: ctx.softMs,
    hard_deadline_ms: ctx.hardMs,
    phase: o.phase_id,
    step,
    horizon: { final_year: o.horizon.final_year, years_remaining: o.horizon.years_remaining },
    board: {
      units: o.board.units.map((u) => ({ power: u.power, type: u.type, at: u.at })),
      supply_centers: { ...o.board.supply_centers },
      sc_counts: { ...o.board.sc_counts },
      unit_counts: { ...o.board.unit_counts },
    },
    dislodged: o.dislodged.map((d) => ({ power: d.power, type: d.type, at: d.at, retreat_options: [...d.retreat_options] })),
    adjustment: o.adjustment ? { delta: o.adjustment.delta, buildable: [...o.adjustment.buildable] } : null,
    last_phase: o.last_phase
      ? {
          phase: o.last_phase.phase_id,
          orders: o.last_phase.orders.map((x) => {
            const r: W = { power: x.power, order: x.order, status: x.status };
            if (x.result !== undefined) r.result = x.result;
            if (x.reason !== undefined) r.reason = x.reason;
            return r;
          }),
        }
      : null,
    private: {
      brief: { codeword: o.private.brief.codeword, instruction: o.private.brief.instruction },
      intent: intent
        ? {
            phase: o.phase_id,
            version: intent.version,
            recorded_tick: intent.recorded_tick,
            orders: [...intent.orders],
            ...(intent.notes !== null ? { notes: intent.notes } : {}),
          }
        : null,
    },
    // Contract: the deliveries of the PREVIOUS step's close only (the engine view is the whole window).
    inbox: o.inbox.filter((m) => m.delivered_tick === o.tick - 1).map(messageToWire),
    sent: o.press_sent.filter((m) => m.delivered_tick === o.tick - 1).map(messageToWire),
    press_rejects: pressRejects,
    order_feedback: orderFeedback,
    offers: o.offers_live.map((x) => offerToWire(x, known)),
    commitments: o.commitments.filter((c) => commitmentVisible(c, o.tick)).map((c) => commitmentToWire(c, ctx.renounceSigModes, ctx.pressRounds)),
    quotas: {
      messages_round: Math.min(q.msgsPerRound, o.quotas_left.msgs_window),
      messages_window: o.quotas_left.msgs_window,
      body_bytes_window: o.quotas_left.bytes_window,
      broadcasts_window: o.quotas_left.broadcasts_window,
      live_offers: o.quotas_left.live_offers,
    },
    limits: {
      press_rounds: ctx.pressRounds,
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
      clause_span_max_phases: DIP_LIMITS.clauseSpanMax,
      orders_max: o.limits.orders_max,
      order_chars_max: o.limits.order_chars_max,
      frame_max_bytes: DIP_FRAME_MAX_BYTES,
    },
  };
  return w;
}

// ------------------------------------------------------------------ action (server direction)

/** A signature attestation per press message, decided by the transport BEFORE the engine. */
export type SigAttestation = 'key' | 'session' | 'unverified' | undefined;

/** The sentinel the engine refuses (`signature_invalid`) in place of an unverifiable signature. */
export const UNVERIFIED_SIGNATURE = 'unverified';

export interface MappedAction {
  action: DipAction;
  transport: TransportFeedback;
  /** Moves of the press batch by index (for annotating the next observation's rejects). */
  batchMoves: (string | undefined)[];
}

/** An order in either wire form → the text grammar (JSON form is converted by the one parser). */
const orderText = (o: unknown): unknown => {
  if (typeof o === 'string') return o;
  const r = rawFromJson(o);
  return isParseError(r) ? o : formatRaw(r);
};

/**
 * A schema-valid `diplomacy_action` → the engine's `DipAction`. `attest[i]` is
 * the transport's verdict on message i's signature; the wire signature BYTES
 * never reach the engine. Batch positions are preserved exactly (the engine's
 * `seq`, which the signatures cover, is the 1-based position).
 */
export function fromWireAction(frame: W, currentPhase: string, attest: readonly SigAttestation[]): MappedAction {
  const action: DipAction = {};
  const transport: TransportFeedback = { orderFeedback: [] };
  if (frame.intent !== undefined) {
    const it = frame.intent as W;
    if (it.phase !== currentPhase) {
      transport.orderFeedback.push({ source: 'intent', index: 0, code: 'intent_wrong_phase' });
    } else {
      const orders = Array.isArray(it.orders) ? it.orders.map(orderText) : it.orders;
      action.intent = it.notes !== undefined ? { orders, notes: it.notes } : { orders };
    }
  }
  if (frame.orders !== undefined) action.orders = frame.orders;
  const batchMoves: (string | undefined)[] = [];
  if (Array.isArray(frame.press)) {
    action.press = frame.press.map((raw, i) => {
      const m = raw as W;
      batchMoves.push(typeof m.move === 'string' ? m.move : undefined);
      const out: W = {};
      for (const [k, v] of Object.entries(m)) {
        if (k === 'signature') continue;
        if (k === 'reply_to' || k === 'respond_to') out[k] = wireIdToEngine(v);
        else if (k === 'terms') out[k] = termsFromWire(v);
        else out[k] = v;
      }
      const a = attest[i];
      if (a !== undefined) out.signature = a;
      return out;
    });
  }
  return { action, transport, batchMoves };
}

// ------------------------------------------------------------------ episode end

export function toWireEpisodeEnd(ep: DipEpisode, power: Power, episodeId: string): W {
  const t = ep.terminal;
  const forfeited = ep.forfeited.map((f) => f.power);
  const sc = t ? t.sc : Object.fromEntries(POWERS.map((p) => [p, 0]));
  const units = t ? t.units : Object.fromEntries(POWERS.map((p) => [p, 0]));
  const eliminated = t ? [...t.eliminated] : [];
  let outcome: string;
  if (forfeited.includes(power)) outcome = 'forfeit';
  else if (t?.winner === power) outcome = 'solo';
  else if (eliminated.includes(power)) outcome = 'eliminated';
  else if (t?.kind === 'solo' || t?.kind === 'last_standing') outcome = 'loss';
  else outcome = 'survived';
  return {
    t: 'diplomacy_episode_end',
    protocol_version: DIP_PROTOCOL_VERSION,
    episode_id: episodeId,
    power,
    outcome,
    terminal: t ? { kind: t.kind, year: t.year, winner: t.kind === 'horizon' ? null : t.winner } : { kind: 'horizon', year: ep.config.horizonYear, winner: null },
    sc_counts: { ...sc },
    unit_counts: { ...units },
    eliminated,
    civil_disorder: forfeited,
    terminal_tick: Math.max(0, ep.tick - 1),
    replay_hash: ep.chain,
    transcript_hash: ep.transcript,
  };
}

// ------------------------------------------------------------------ client direction (reference agents over the wire)

const intentId = (phase: string, power: Power, v: number): string => `int:${phase}:${DIP_POWER_ABBR[power]}:v${v}`;

function messageFromWire(m: W): ObsMessage {
  return {
    msg_id: wireIdToEngine(m.msg_id) as string,
    from: m.from as Power,
    to: m.to as DipRecipients,
    move: m.move as ObsMessage['move'],
    body: (m.body as string | undefined) ?? null,
    reply_to: m.reply_to !== undefined ? (wireIdToEngine(m.reply_to) as string) : null,
    asks: (m.asks as string[] | undefined) ?? null,
    terms: m.terms !== undefined ? (termsFromWire(m.terms) as DipOfferTerms) : null,
    terms_hash: (m.terms_hash as string | undefined) ?? null,
    respond_to: m.respond_to !== undefined ? (wireIdToEngine(m.respond_to) as string) : null,
    expires_after_round: (m.expires_after_round as number | undefined) ?? null,
    delivered_tick: m.delivered_tick as number,
    sig_mode: (m.sig_mode as ObsMessage['sig_mode'] | undefined) ?? null,
  };
}

/**
 * A wire client's memory: the contract delivers each press message once (at the
 * close of its round) and shows an ended commitment in one observation only, so
 * a client that wants the engine's cumulative view keeps it. `observe` folds a
 * frame into that memory and returns the engine-shaped observation: inbox and
 * sent for the current movement phase (the engine's window), and the latest
 * state of every commitment ever seen.
 */
export class DipWireView {
  private phase = '';
  private inbox: W[] = [];
  private sent: W[] = [];
  private readonly commitments = new Map<string, W>();

  observe(f: W): DipObservation {
    const phase = f.phase as string;
    if (phase !== this.phase) {
      this.phase = phase;
      this.inbox = [];
      this.sent = [];
    }
    const seen = new Set([...this.inbox, ...this.sent].map((m) => m.msg_id));
    for (const m of f.inbox as W[]) if (m.phase === phase && !seen.has(m.msg_id)) this.inbox.push(m);
    for (const m of f.sent as W[]) if (m.phase === phase && !seen.has(m.msg_id)) this.sent.push(m);
    for (const c of f.commitments as W[]) {
      this.commitments.set(c.cmt_id as string, c); // latest state wins; first-seen order kept
    }
    // Map insertion order = first-seen order = bind order (the engine lists commitments by bind order).
    return fromWireObservation({ ...f, inbox: this.inbox, sent: this.sent, commitments: [...this.commitments.values()] });
  }
}

/**
 * Contract `diplomacy_observation` → the engine's `DipObservation` shape, so the
 * engine's reference agents can play over the wire. Fields the contract does
 * not carry (`contested`, `terminal`, `you.seat`, and the `void` reasons of the
 * per-phase settlements, which 2.5.0 `settlements[]` carries without) are filled
 * with neutral values; the reference agents do not read
 * them for decisions that reach the engine (proved by the e2e hash equality).
 */
export function fromWireObservation(f: W): DipObservation {
  const step = f.step as W;
  const wkind = step.kind as string;
  const movementStep = wkind === 'intent' || wkind === 'press' || wkind === 'orders';
  const power = f.power as Power;
  const priv = f.private as W;
  const intent = priv.intent as W | null;
  const limits = f.limits as W;
  const quotas = f.quotas as W;
  const board = f.board as W;
  const lp = f.last_phase as W | null;
  return {
    schema: 'wot-dip/observation/1',
    phase_id: f.phase as string,
    tick: f.turn_id as number,
    step: { kind: movementStep ? (wkind as 'intent' | 'press' | 'orders') : 'orders', round: (step.round as number | undefined) ?? 0, rounds_total: movementStep ? (step.rounds_total as number) : 0 },
    horizon: f.horizon as DipObservation['horizon'],
    you: { power, seat: -1 },
    board: board as unknown as DipObservation['board'],
    dislodged: f.dislodged as DipObservation['dislodged'],
    contested: [],
    adjustment: f.adjustment as DipObservation['adjustment'],
    last_phase: lp ? { phase_id: lp.phase as string, orders: lp.orders as NonNullable<DipObservation['last_phase']>['orders'] } : null,
    inbox: (f.inbox as W[]).map(messageFromWire),
    press_sent: (f.sent as W[]).map(messageFromWire),
    offers_live: (f.offers as W[])
      .filter((o) => o.status === 'pending')
      .map((o) => ({
        offer_id: wireIdToEngine(o.offer_id) as string,
        from: o.from as Power,
        to: o.to as Power,
        terms: termsFromWire(o.terms) as DipOfferTerms,
        terms_hash: o.terms_hash as string,
        expires_after_round: o.expires_after_round as number,
        counter_of: o.counters !== undefined ? (wireIdToEngine(o.counters) as string) : null,
      })),
    commitments: (f.commitments as W[]).map((c) => {
      const r = c.renounced as W | undefined;
      return {
        cmt_id: wireIdToEngine(c.cmt_id) as string,
        parties: [...(c.parties as Power[])] as unknown as readonly [Power, Power],
        offer_msg_id: wireIdToEngine(c.offer_msg_id) as string,
        accept_msg_id: wireIdToEngine(c.accept_msg_id) as string,
        terms_hash: c.terms_hash as string,
        bound_tick: c.bound_tick as number,
        sig_mode: c.sig_mode as ObsCommitment['sig_mode'],
        renounced: r ? { by: r.by as Power, msg_id: wireIdToEngine(r.msg_id) as string, tick: r.delivered_tick as number } : null,
        clauses: (c.clauses as W[]).map((cl) => {
          const status = cl.status as string;
          const engineStatus = (status === 'renounced' ? 'released' : status) as ObsCommitment['clauses'][number]['status'];
          type ObsSettlement = ObsCommitment['clauses'][number]['settlements'][number];
          const hist = cl.settlements as W[] | undefined;
          // contracts 2.5.0: the full per-phase history when the producer sends it.
          const settlements: ObsCommitment['clauses'][number]['settlements'] = hist
            ? hist.map((x): ObsSettlement => {
                const st = x.status as string;
                const base = { phase: x.phase as string, tick: x.tick as number };
                if (st === 'renounced') return { ...base, status: 'released', reason: 'renounced' };
                if (st === 'released') return { ...base, status: 'released', reason: 'counterparty_broke' };
                return { ...base, status: st as 'kept' | 'broken' | 'void' };
              })
            : status === 'escrowed' || cl.settled_phase === undefined
              ? []
              : [
                  {
                    phase: cl.settled_phase as string,
                    status: engineStatus as 'kept' | 'broken' | 'void' | 'released',
                    tick: cl.settled_tick as number,
                    ...(status === 'renounced' ? { reason: 'renounced' as const } : {}),
                  },
                ];
          return { index: cl.index as number, obligor: cl.obligor as Power, clause: clauseFromWire(cl.clause) as DipClause, status: engineStatus, settlements };
        }),
      };
    }),
    intent_echo: intent
      ? { id: intentId(intent.phase as string, power, intent.version as number), version: intent.version as number, recorded_tick: intent.recorded_tick as number, orders: [...(intent.orders as string[])], notes: (intent.notes as string | undefined) ?? null }
      : null,
    rejects: [
      ...(f.press_rejects as W[]).map((r) => ({ kind: 'press' as const, index: r.msg_index as number, code: r.code as ObsReject['code'], detail: r.hint as string })),
      ...(f.order_feedback as W[]).map((r) => ({ kind: r.source as 'orders' | 'intent', index: r.index as number, code: r.code as ObsReject['code'], detail: r.code as string })),
    ],
    quotas_left: {
      msgs_window: quotas.messages_window as number,
      bytes_window: quotas.body_bytes_window as number,
      broadcasts_window: quotas.broadcasts_window as number,
      live_offers: quotas.live_offers as number,
    },
    limits: {
      press_rounds: movementStep ? (limits.press_rounds as number) : 0,
      msgs_per_round: limits.messages_per_round as number,
      msgs_per_window: limits.messages_per_window as number,
      bytes_per_window: limits.body_bytes_per_window as number,
      broadcasts_per_window: limits.broadcasts_per_window as number,
      live_offers: limits.live_offers_max as number,
      body_max_bytes: limits.body_max_bytes as number,
      note_max_bytes: limits.offer_note_max_bytes as number,
      notes_max_bytes: limits.intent_notes_max_bytes as number,
      orders_max: limits.orders_max as number,
      order_chars_max: limits.order_chars_max as number,
    },
    private: { brief: priv.brief as DipObservation['private']['brief'] },
    terminal: null,
  };
}

/**
 * An engine-shaped `DipAction` (what a reference agent returns) → a contract
 * `diplomacy_action` frame. `sign(i, wireMessage)` may replace a message's
 * signature (e.g. with a passport JWS); by default the agent's own value stays.
 */
export function toWireAction(
  a: DipAction,
  echo: { episode_id: string; turn_id: number; nonce: string; power: Power; phase: string },
  sign?: (index: number, wireMessage: W) => string | undefined,
): W {
  const f: W = { t: 'diplomacy_action', protocol_version: DIP_PROTOCOL_VERSION, episode_id: echo.episode_id, turn_id: echo.turn_id, nonce: echo.nonce, power: echo.power };
  if (a.intent !== undefined) {
    const it = a.intent as { orders?: unknown; notes?: unknown };
    f.intent = { phase: echo.phase, orders: it.orders, ...(it.notes !== undefined && it.notes !== null ? { notes: it.notes } : {}) };
  }
  if (a.orders !== undefined) f.orders = a.orders;
  if (a.press !== undefined) {
    f.press = (a.press as W[]).map((m, i) => {
      const w: W = {};
      for (const [k, v] of Object.entries(m)) {
        if (v === undefined) continue;
        if (k === 'reply_to' || k === 'respond_to') w[k] = typeof v === 'string' ? engineIdToWire(v) : v;
        else if (k === 'terms') w[k] = termsToWire(v as DipOfferTerms);
        else w[k] = v;
      }
      const s = sign?.(i, w);
      if (s !== undefined) w.signature = s;
      return w;
    });
  }
  return f;
}
