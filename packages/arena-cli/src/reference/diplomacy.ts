/**
 * The Diplomacy reference agents as a TARGET (scripted, deterministic, no
 * model): `robust-diplomat`, `credulous-diplomat`, `injector`, `house-diplomat`
 * answering `diplomacy_observation` frames with `diplomacy_action` frames.
 *
 * The engine's reference agents read the engine's `DipObservation`, whose
 * inbox is the whole movement window and whose commitments keep every clause's
 * settlement history. The contract frame carries only the step that just
 * closed (inbox / sent) and drops a commitment one adjudication after it ends,
 * so a wire client that wants the engine's view has to keep it. `DipWireView`
 * is that memory, one per episode (session): it folds each frame into the
 * current movement window's inbox and sent lists and the latest state of every
 * commitment ever seen, then rebuilds the engine-shaped observation
 * (`fromWireObservation`). Same technique as B3a's server-side client
 * (services/arena/src/diplomacy/wire.ts), adapted to the arena-scenarios
 * egress the CLI sends (full power names in ids, clause spans `from_phase` /
 * `to_phase`, `retreat` / `adjust` steps, offers `status: pending`).
 *
 * Tie-break salt: the in-process agents take the EPISODE seed as their private
 * tie-break salt. A served agent never sees the seed (the episode id is opaque,
 * never derived from it), so it uses its own fixed salt (`agentSeed`, default
 * the engine goldens' seed 20261115). It therefore reproduces the in-process
 * references (and the golden anchors) exactly when the episode seed equals its
 * salt, and plays as a different but equally deterministic agent otherwise.
 *
 * Every frame is untrusted input here (the server listens on a socket): shape
 * checks first, and any surprise yields `null` (the arena records a miss).
 */

import { dipContractId, dipEngineActionToWire, dipEngineId, DIP_POWERS } from 'arena-scenarios';
import { credulousDiplomat, dipInjectorPlan, houseDiplomat, robustDiplomat, type DipAction, type DipObservation, type Power } from 'wot-engine';

export type DipServedPolicy = 'robust' | 'credulous' | 'injector' | 'house';
export const DIP_SERVED_POLICIES: readonly DipServedPolicy[] = ['robust', 'credulous', 'injector', 'house'];
/** The engine goldens' seed (arena-scenarios DIP_GOLDEN_SEED): the served agents' default tie-break salt. */
export const DIP_DEFAULT_AGENT_SEED = 20261115;

type W = Record<string, unknown>;
type ObsMessage = DipObservation['inbox'][number];
type ObsCommitment = DipObservation['commitments'][number];
type ObsClause = ObsCommitment['clauses'][number];

const ABBR: Readonly<Record<string, string>> = { austria: 'AUS', england: 'ENG', france: 'FRA', germany: 'GER', italy: 'ITA', russia: 'RUS', turkey: 'TUR' };
const isObj = (v: unknown): v is W => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): W[] => (Array.isArray(v) ? (v.filter(isObj) as W[]) : []);
const isPower = (v: unknown): v is Power => typeof v === 'string' && (DIP_POWERS as readonly string[]).includes(v);
const idIn = (v: unknown): string => (typeof v === 'string' ? dipEngineId(v) : '');

function clauseIn(c: unknown): unknown {
  if (!isObj(c)) return c;
  if (c.kind === 'order') return { kind: 'order', phase: c.phase, order: c.order };
  const out: W = {};
  for (const [k, v] of Object.entries(c)) out[k === 'from_phase' ? 'from' : k === 'to_phase' ? 'to' : k] = v;
  return out;
}

function termsIn(t: unknown): ObsMessage['terms'] {
  if (!isObj(t)) return null;
  const out: W = { give: arr(t.give).map(clauseIn), want: arr(t.want).map(clauseIn) };
  if (t.note !== undefined) out.note = t.note;
  return out as unknown as ObsMessage['terms'];
}

function messageIn(m: W): ObsMessage {
  return {
    msg_id: idIn(m.msg_id),
    from: m.from as Power,
    to: m.to as ObsMessage['to'],
    move: m.move as ObsMessage['move'],
    body: typeof m.body === 'string' ? m.body : null,
    reply_to: m.reply_to !== undefined ? idIn(m.reply_to) : null,
    asks: Array.isArray(m.asks) ? (m.asks as string[]) : null,
    terms: m.terms !== undefined ? termsIn(m.terms) : null,
    terms_hash: typeof m.terms_hash === 'string' ? m.terms_hash : null,
    respond_to: m.respond_to !== undefined ? idIn(m.respond_to) : null,
    expires_after_round: typeof m.expires_after_round === 'number' ? m.expires_after_round : null,
    delivered_tick: m.delivered_tick as number,
    sig_mode: (m.sig_mode as ObsMessage['sig_mode'] | undefined) ?? null,
  };
}

function clauseStatusIn(cl: W): ObsClause {
  const status = String(cl.status);
  const engineStatus = (status === 'renounced' ? 'released' : status) as ObsClause['status'];
  const settlements: ObsClause['settlements'] =
    status === 'escrowed' || typeof cl.settled_phase !== 'string'
      ? []
      : [
          {
            phase: cl.settled_phase,
            status: engineStatus as 'kept' | 'broken' | 'void' | 'released',
            tick: cl.settled_tick as number,
            ...(status === 'renounced' ? { reason: 'renounced' as const } : {}),
          } as ObsClause['settlements'][number],
        ];
  return { index: cl.index as number, obligor: cl.obligor as Power, clause: clauseIn(cl.clause) as ObsClause['clause'], status: engineStatus, settlements };
}

function commitmentIn(c: W): ObsCommitment {
  const r = isObj(c.renounced) ? c.renounced : null;
  return {
    cmt_id: idIn(c.cmt_id),
    parties: [...(c.parties as Power[])] as unknown as ObsCommitment['parties'],
    offer_msg_id: idIn(c.offer_msg_id),
    accept_msg_id: idIn(c.accept_msg_id),
    terms_hash: c.terms_hash as string,
    bound_tick: c.bound_tick as number,
    sig_mode: c.sig_mode as ObsCommitment['sig_mode'],
    renounced: r ? { by: r.by as Power, msg_id: idIn(r.msg_id), tick: r.delivered_tick as number } : null,
    clauses: arr(c.clauses).map(clauseStatusIn),
  };
}

/**
 * Contract `diplomacy_observation` (arena-scenarios egress) → the engine's
 * `DipObservation` shape. Fields the contract does not carry (`contested`,
 * `terminal`, `you.seat`) get neutral values; the reference agents do not read
 * them. `inbox` / `sent` / `commitments` are taken as given (the caller passes
 * the accumulated window, see `DipWireView`).
 */
export function fromWireObservation(f: W): DipObservation {
  const step = f.step as W;
  const wkind = String(step.kind);
  const movement = wkind === 'intent' || wkind === 'press' || wkind === 'orders';
  const power = f.power as Power;
  const priv = f.private as W;
  const intent = isObj(priv.intent) ? priv.intent : null;
  const limits = f.limits as W;
  const quotas = f.quotas as W;
  const lp = isObj(f.last_phase) ? f.last_phase : null;
  return {
    schema: 'wot-dip/observation/1',
    phase_id: f.phase as string,
    tick: f.turn_id as number,
    step: { kind: movement ? (wkind as 'intent' | 'press' | 'orders') : 'orders', round: typeof step.round === 'number' ? step.round : 0, rounds_total: movement ? (step.rounds_total as number) : 0 },
    horizon: f.horizon as DipObservation['horizon'],
    you: { power, seat: -1 },
    board: f.board as unknown as DipObservation['board'],
    dislodged: f.dislodged as DipObservation['dislodged'],
    contested: [],
    adjustment: f.adjustment as DipObservation['adjustment'],
    last_phase: lp ? { phase_id: lp.phase as string, orders: lp.orders as NonNullable<DipObservation['last_phase']>['orders'] } : null,
    inbox: arr(f.inbox).map(messageIn),
    press_sent: arr(f.sent).map(messageIn),
    offers_live: arr(f.offers)
      .filter((o) => o.status === 'pending')
      .map((o) => ({
        offer_id: idIn(o.offer_id),
        from: o.from as Power,
        to: o.to as Power,
        terms: termsIn(o.terms)!,
        terms_hash: o.terms_hash as string,
        expires_after_round: o.expires_after_round as number,
        counter_of: o.counters !== undefined ? idIn(o.counters) : null,
      })),
    commitments: arr(f.commitments).map(commitmentIn),
    intent_echo: intent
      ? {
          id: `int:${String(intent.phase)}:${ABBR[power] ?? 'UNK'}:v${String(intent.version)}`,
          version: intent.version as number,
          recorded_tick: intent.recorded_tick as number,
          orders: [...(intent.orders as string[])],
          notes: typeof intent.notes === 'string' ? intent.notes : null,
        }
      : null,
    rejects: [
      ...arr(f.press_rejects).map((r) => ({ kind: 'press' as const, index: r.msg_index as number, code: r.code as DipObservation['rejects'][number]['code'], detail: String(r.hint) })),
      ...arr(f.order_feedback).map((r) => ({ kind: r.source as 'orders' | 'intent', index: r.index as number, code: r.code as DipObservation['rejects'][number]['code'], detail: String(r.code) })),
    ],
    quotas_left: {
      msgs_window: quotas.messages_window as number,
      bytes_window: quotas.body_bytes_window as number,
      broadcasts_window: quotas.broadcasts_window as number,
      live_offers: quotas.live_offers as number,
    },
    limits: {
      press_rounds: movement ? (limits.press_rounds as number) : 0,
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
 * G-37: what one session's memory may hold. `DipWireView` never keeps a peer's
 * object: it stores the projection `fromWireObservation` reads, cut to the
 * engine's own limits (press.ts `PRESS_QUOTAS` / `DIP_LIMITS`: body ≤ 600 bytes,
 * note ≤ 200, ≤ 6 clauses per side, ≤ 6 asks, orders ≤ 64 chars), and it keeps a
 * byte budget per session; `DiplomacyReferenceAgent` keeps a global one across
 * sessions and evicts the least recently used session beyond it.
 */
export const DIP_VIEW_LIMITS = Object.freeze({
  windowMessages: 512,
  commitments: 256,
  bodyBytes: 600,
  noteBytes: 200,
  clausesPerSide: 6,
  asks: 6,
  /** Any other string the view keeps (order text, phase ids, hashes). */
  textChars: 64,
  /** Clause members a generic (non-order) clause may carry. */
  clauseKeys: 8,
  sessionBytes: 1024 * 1024,
  globalBytes: 64 * 1024 * 1024,
  sessions: 64,
});

/** Contract `msg_id` (diplomacy_press_message.schema.json `$defs.msg_id`); a message whose id fails it is refused. */
const MSG_ID = /^prs:[SF]190[1-8]M:r[1-3]:(austria|england|france|germany|italy|russia|turkey):([1-9]|1[0-2])$/;
const CLAUSE_KEY = /^[a-z_]{1,24}$/;

/** At most `max` UTF-8 bytes of `s`, never splitting a code point. */
function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}
const text = (v: unknown, max: number = DIP_VIEW_LIMITS.textChars): string | undefined => (typeof v === 'string' ? cutBytes(v, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Drop undefined members (so the projection's JSON is exactly what is kept). */
function compact(o: W): W {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function clauseKeep(c: unknown): W | null {
  if (!isObj(c)) return null;
  if (c.kind === 'order') return compact({ kind: 'order', phase: text(c.phase), order: text(c.order) });
  const out: W = {};
  let n = 0;
  for (const [k, v] of Object.entries(c)) {
    if (n >= DIP_VIEW_LIMITS.clauseKeys || !CLAUSE_KEY.test(k)) continue;
    if (typeof v === 'string') out[k] = text(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, DIP_VIEW_LIMITS.clausesPerSide).filter((x) => typeof x === 'string').map((x) => text(x));
    else continue;
    n++;
  }
  return out;
}

function termsKeep(t: unknown): W | undefined {
  if (!isObj(t)) return undefined;
  const side = (v: unknown) => arr(v).slice(0, DIP_VIEW_LIMITS.clausesPerSide).map(clauseKeep).filter((x): x is W => x !== null);
  return compact({ give: side(t.give), want: side(t.want), note: text(t.note, DIP_VIEW_LIMITS.noteBytes) });
}

function recipientsKeep(v: unknown): W | undefined {
  if (!isObj(v)) return undefined;
  if (v.kind === 'private') return isPower(v.power) ? { kind: 'private', power: v.power } : undefined;
  if (v.kind === 'group') return { kind: 'group', powers: (Array.isArray(v.powers) ? v.powers : []).filter(isPower).slice(0, 5) };
  if (v.kind === 'broadcast') return { kind: 'broadcast' };
  return undefined;
}

/** The fields `messageIn` reads, cut to the engine limits; null for a message whose id or sender is not the contract's. */
export function projectWireMessage(m: W): W | null {
  if (typeof m.msg_id !== 'string' || !MSG_ID.test(m.msg_id) || !isPower(m.from)) return null;
  return compact({
    msg_id: m.msg_id,
    from: m.from,
    to: recipientsKeep(m.to),
    move: text(m.move, 16),
    phase: text(m.phase, 16),
    body: text(m.body, DIP_VIEW_LIMITS.bodyBytes),
    reply_to: text(m.reply_to),
    asks: Array.isArray(m.asks) ? m.asks.slice(0, DIP_VIEW_LIMITS.asks).filter((x) => typeof x === 'string').map((x) => text(x)) : undefined,
    terms: termsKeep(m.terms),
    terms_hash: text(m.terms_hash, 71),
    respond_to: text(m.respond_to),
    expires_after_round: num(m.expires_after_round),
    delivered_tick: num(m.delivered_tick),
    sig_mode: m.sig_mode === 'key' || m.sig_mode === 'session' ? m.sig_mode : undefined,
  });
}

/** The fields `commitmentIn` reads, cut to the engine limits. */
export function projectWireCommitment(c: W): W | null {
  if (typeof c.cmt_id !== 'string' || c.cmt_id.length > DIP_VIEW_LIMITS.textChars) return null;
  const r = isObj(c.renounced) ? c.renounced : null;
  const clauses = arr(c.clauses)
    .slice(0, 2 * DIP_VIEW_LIMITS.clausesPerSide)
    .map((cl) => compact({ index: num(cl.index), obligor: isPower(cl.obligor) ? cl.obligor : undefined, clause: clauseKeep(cl.clause) ?? undefined, status: text(cl.status, 16), settled_phase: text(cl.settled_phase, 16), settled_tick: num(cl.settled_tick) }));
  return compact({
    cmt_id: c.cmt_id,
    parties: (Array.isArray(c.parties) ? c.parties : []).filter(isPower).slice(0, 2),
    offer_msg_id: text(c.offer_msg_id),
    accept_msg_id: text(c.accept_msg_id),
    terms_hash: text(c.terms_hash, 71),
    bound_tick: num(c.bound_tick),
    sig_mode: c.sig_mode === 'key' || c.sig_mode === 'session' ? c.sig_mode : undefined,
    renounced: r ? compact({ by: isPower(r.by) ? r.by : undefined, msg_id: text(r.msg_id), delivered_tick: num(r.delivered_tick) }) : undefined,
    clauses,
  });
}

const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * One episode's memory: the current movement window's inbox and sent lists
 * (reset when the phase changes) and the latest state of every commitment seen
 * (first-seen order = bind order, the engine's listing order). Holds projections
 * only (G-37), within `DIP_VIEW_LIMITS.sessionBytes`: an entry that would exceed
 * the budget is not kept (a new state of a known commitment replaces the old one
 * when it fits).
 */
export class DipWireView {
  private phase = '';
  private inbox: W[] = [];
  private sent: W[] = [];
  private readonly commitments = new Map<string, { c: W; bytes: number }>();
  private windowBytes = 0;
  private commitmentBytes = 0;

  constructor(private readonly budget: number = DIP_VIEW_LIMITS.sessionBytes) {}

  /** Bytes this session retains (serialised projections). */
  get bytes(): number {
    return this.windowBytes + this.commitmentBytes;
  }

  observe(f: W): DipObservation {
    const phase = String(f.phase);
    if (phase !== this.phase) {
      this.phase = phase;
      this.inbox = [];
      this.sent = [];
      this.windowBytes = 0;
    }
    const seen = new Set([...this.inbox, ...this.sent].map((m) => m.msg_id));
    const fold = (list: W[], incoming: unknown) => {
      for (const raw of arr(incoming)) {
        if (raw.phase !== phase || list.length >= DIP_VIEW_LIMITS.windowMessages) continue;
        const m = projectWireMessage(raw);
        if (!m || seen.has(m.msg_id)) continue;
        const b = sizeOf(m);
        if (this.bytes + b > this.budget) continue;
        list.push(m);
        seen.add(m.msg_id);
        this.windowBytes += b;
      }
    };
    fold(this.inbox, f.inbox);
    fold(this.sent, f.sent);
    for (const raw of arr(f.commitments)) {
      const c = projectWireCommitment(raw);
      if (!c) continue;
      const id = c.cmt_id as string;
      const prev = this.commitments.get(id);
      if (!prev && this.commitments.size >= DIP_VIEW_LIMITS.commitments) continue;
      const b = sizeOf(c);
      if (this.bytes - (prev?.bytes ?? 0) + b > this.budget) continue;
      this.commitmentBytes += b - (prev?.bytes ?? 0);
      this.commitments.set(id, { c, bytes: b });
    }
    // The current frame's other fields are read once and not retained.
    return fromWireObservation({ ...f, inbox: this.inbox, sent: this.sent, commitments: [...this.commitments.values()].map((x) => x.c) });
  }
}

/** The engine action of one served policy for one observation. */
export function dipPolicyAction(policy: DipServedPolicy, o: DipObservation, seed: number): DipAction {
  switch (policy) {
    case 'robust':
      return robustDiplomat(o, { seed });
    case 'credulous':
      return credulousDiplomat(o, { seed });
    case 'house':
      return houseDiplomat(o, { seed });
    case 'injector':
      // The injector as the target: it works on every other power at the table (a red-team fixture, not an agent to score).
      return dipInjectorPlan(o, { seed, targets: DIP_POWERS.filter((p) => p !== o.you.power) as Power[] }).action;
  }
}

/** Shape check of an inbound observation frame before anything reads it. */
function plausible(f: W): boolean {
  return (
    f.t === 'diplomacy_observation' &&
    f.scenario_id === 'diplomacy_standard' &&
    typeof f.episode_id === 'string' &&
    f.episode_id.length <= 64 &&
    typeof f.nonce === 'string' &&
    f.nonce.length <= 64 &&
    Number.isInteger(f.turn_id) &&
    isPower(f.power) &&
    typeof f.phase === 'string' &&
    isObj(f.step) &&
    isObj(f.board) &&
    isObj(f.private) &&
    isObj(f.limits) &&
    isObj(f.quotas) &&
    isObj(f.horizon) &&
    Array.isArray(f.inbox) &&
    Array.isArray(f.sent) &&
    Array.isArray(f.commitments) &&
    Array.isArray(f.offers) &&
    Array.isArray(f.dislodged)
  );
}

/**
 * The served Diplomacy reference: one `DipWireView` per episode id, at most
 * `DIP_VIEW_LIMITS.sessions` of them and `DIP_VIEW_LIMITS.globalBytes` in all
 * (G-37); beyond either, the least recently used session is forgotten.
 */
export class DiplomacyReferenceAgent {
  private readonly views = new Map<string, DipWireView>();

  constructor(
    readonly policy: DipServedPolicy,
    readonly agentSeed: number = DIP_DEFAULT_AGENT_SEED,
    private readonly limits: { sessions: number; globalBytes: number; sessionBytes: number } = DIP_VIEW_LIMITS,
  ) {}

  private viewFor(episodeId: string): DipWireView {
    let v = this.views.get(episodeId);
    if (v) {
      this.views.delete(episodeId);
      this.views.set(episodeId, v);
      return v;
    }
    while (this.views.size >= this.limits.sessions) this.views.delete(this.views.keys().next().value!);
    v = new DipWireView(this.limits.sessionBytes);
    this.views.set(episodeId, v);
    return v;
  }

  /** Evict least recently used sessions (never `keep`) until the global byte budget holds. */
  private enforceGlobal(keep: string): void {
    let total = 0;
    for (const v of this.views.values()) total += v.bytes;
    for (const [id, v] of this.views) {
      if (total <= this.limits.globalBytes) break;
      if (id === keep) continue;
      total -= v.bytes;
      this.views.delete(id);
    }
  }

  /** Bytes retained across every session. */
  get bytes(): number {
    let total = 0;
    for (const v of this.views.values()) total += v.bytes;
    return total;
  }

  /** `diplomacy_episode_end`: forget the session. */
  end(episodeId: unknown): void {
    if (typeof episodeId === 'string') this.views.delete(episodeId);
  }

  /** One observation frame in, one action frame out (null = stay silent). */
  respond(f: W): W | null {
    if (!plausible(f)) return null;
    let action: DipAction;
    try {
      const o = this.viewFor(f.episode_id as string).observe(f);
      this.enforceGlobal(f.episode_id as string);
      action = dipPolicyAction(this.policy, o, this.agentSeed);
    } catch {
      return null;
    }
    const payload = dipEngineActionToWire(action, f.phase as string);
    // Engine ids (three-letter powers) never go on the wire.
    if (Array.isArray(payload.press)) {
      payload.press = (payload.press as W[]).map((m) => {
        const o: W = { ...m };
        if (typeof o.reply_to === 'string') o.reply_to = dipContractId(o.reply_to);
        if (typeof o.respond_to === 'string') o.respond_to = dipContractId(o.respond_to);
        return o;
      });
    }
    return { t: 'diplomacy_action', protocol_version: '1.0', episode_id: f.episode_id, turn_id: f.turn_id, nonce: f.nonce, power: f.power, ...payload };
  }

  get sessions(): number {
    return this.views.size;
  }
}
