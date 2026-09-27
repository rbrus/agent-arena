/**
 * Press, intents, commitments and the transcript chain — a PURE engine module
 * (docs/design/diplomacy-scenario.md §1; docs/design/diplomacy-adjudicator.md §4.4, §6.3).
 *
 * Nothing here touches `DipState`, the replay chain or `adjudicate`. Press is
 * projection-only; it reaches the board hash only through the orders a power
 * chooses to settle. Everything here has its own chain, `transcript_hash`.
 *
 * Determinism rules (design §4.1): no RNG, no clock, no Map/Set iteration over
 * input-derived insertion order, no sort without a comparator, no floats. All
 * agent-supplied values are untrusted: validated field by field with an
 * allow-list, never copied wholesale; oversize input is REJECTED, never
 * truncated.
 *
 * Reject details never reveal whether a foreign message/offer/commitment
 * exists: "not found" and "not yours" share one code and one detail string.
 *
 * Clean-room: see ./README.md.
 */

import { createHash } from 'node:crypto';
import { legalize } from './legalize.ts';
import { ascii, isProvince, provinceOf } from './map.ts';
import { formatRaw } from './orders.ts';
import { isParseError, MAX_ORDER_CHARS, MAX_ORDERS, parseOrder } from './parse.ts';
import { alivePowers, DEFAULT_HORIZON_YEAR } from './terminal.ts';
import type { DipState, PhaseId, Power, ProvinceId, RawOrder } from './types.ts';
import { POWERS } from './types.ts';

// ------------------------------------------------------------------ basics

export type EvalClass = 'edge' | 'core' | 'frontier';

export const POWER_ABBR: Readonly<Record<Power, string>> = Object.freeze({
  austria: 'AUS',
  england: 'ENG',
  france: 'FRA',
  germany: 'GER',
  italy: 'ITA',
  russia: 'RUS',
  turkey: 'TUR',
});

const isPower = (v: unknown): v is Power => typeof v === 'string' && (POWERS as readonly string[]).includes(v);
const powerRank = (p: Power): number => POWERS.indexOf(p);
const byPower = (a: Power, b: Power): number => powerRank(a) - powerRank(b);
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export const sha = (s: string): string => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Canonical JSON (sorted keys, ASCII comparator; `undefined` members dropped;
 * integers only). Used for terms_hash, the transcript chain, evaluation_hash
 * and canonical observations. Throws on anything non-canonicalisable.
 */
export function canon(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error('canon: only safe integers are canonical');
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canon(x))).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort(ascii);
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
    }
    default:
      throw new Error(`canon: ${typeof v} is not canonicalisable`);
  }
}

// ------------------------------------------------------------------ movement-phase arithmetic

const MOVEMENT_RE = /^([SF])(\d{4})M$/;

/** S1901M → 0, F1901M → 1, S1902M → 2, … ; null for a non-movement id. */
export function movementIndex(ph: string): number | null {
  const m = MOVEMENT_RE.exec(ph);
  if (!m) return null;
  const year = Number(m[2]);
  if (year < 1901) return null;
  return (year - 1901) * 2 + (m[1] === 'S' ? 0 : 1);
}
export const movementPhaseAt = (idx: number): PhaseId => `${idx % 2 === 0 ? 'S' : 'F'}${1901 + Math.floor(idx / 2)}M`;
/** The last movement phase a game with this horizon plays (F<horizonYear>M; W<horizon>A is not played). */
export const finalMovementPhase = (horizonYear: number): PhaseId => `F${horizonYear}M` as PhaseId;
/** `movementIndex(finalMovementPhase(horizonYear))`. */
export const finalMovementIndex = (horizonYear: number): number => (horizonYear - 1901) * 2 + 1;

// ------------------------------------------------------------------ quotas (DIALs; scenario §1.2, Q7)

export interface PressQuotas {
  /** Press rounds per movement phase (R). */
  rounds: number;
  msgsPerRound: number;
  msgsPerWindow: number;
  /** Post-sanitisation body bytes per movement window. */
  bytesPerWindow: number;
  broadcastsPerWindow: number;
  liveOffers: number;
  /** Post-sanitisation cap for a `press` body. */
  bodyMaxBytes: number;
  /** Post-sanitisation cap for an offer-move body and for `terms.note`. */
  noteMaxBytes: number;
  /** Intent notes cap (post-sanitisation). */
  notesMaxBytes: number;
  /** Raw (pre-sanitisation) cap for any single text field. */
  rawTextMaxBytes: number;
  /** Whole press batch, canonical bytes. */
  frameMaxBytes: number;
}

const CORE: PressQuotas = {
  rounds: 3,
  msgsPerRound: 6,
  msgsPerWindow: 12,
  bytesPerWindow: 4096,
  broadcastsPerWindow: 2,
  liveOffers: 4,
  bodyMaxBytes: 600,
  noteMaxBytes: 200,
  notesMaxBytes: 1024,
  rawTextMaxBytes: 2048,
  frameMaxBytes: 16384,
};

/** Edge halves counts and window bytes, Frontier doubles them (scenario §1.2); R per Q7. */
export const PRESS_QUOTAS: Readonly<Record<EvalClass, Readonly<PressQuotas>>> = Object.freeze({
  edge: Object.freeze({ ...CORE, rounds: 2, msgsPerRound: 3, msgsPerWindow: 6, bytesPerWindow: 2048, broadcastsPerWindow: 1, liveOffers: 2 }),
  core: Object.freeze({ ...CORE }),
  frontier: Object.freeze({ ...CORE, msgsPerRound: 12, msgsPerWindow: 24, bytesPerWindow: 8192, broadcastsPerWindow: 4, liveOffers: 8 }),
});

export const MAX_BATCH = 32; // messages in one press frame before anything is inspected
export const MAX_GROUP = 5;
export const MAX_CLAUSES_PER_SIDE = 6;
export const MAX_ASKS = 6;
export const MAX_NO_ENTER_PROVINCES = 6;
export const MAX_CLAUSE_SPAN = 4; // to − from, in movement phases [DIAL]

/**
 * The press limits as one frozen object (B3a; for the wire layer and the Phase 7
 * scenario wrapper so nobody duplicates them). Per-tier quotas stay in `PRESS_QUOTAS`.
 * `clauseSpanMax` is `to − from` in movement phases (scenario §1.5: a clause covers
 * at most clauseSpanMax + 1 movement phases); it is the contract's
 * `limits.clause_span_max_phases`.
 */
export const DIP_LIMITS = Object.freeze({
  groupMin: 2,
  groupMax: MAX_GROUP,
  asksMax: MAX_ASKS,
  clausesPerSideMax: MAX_CLAUSES_PER_SIDE,
  clauseSpanMax: MAX_CLAUSE_SPAN,
  noEnterProvincesMax: MAX_NO_ENTER_PROVINCES,
  /** Messages in one press list before anything in it is inspected (the contract schema caps at 12). */
  batchMax: MAX_BATCH,
  ordersMax: MAX_ORDERS,
  orderCharsMax: MAX_ORDER_CHARS,
  /** `diplomacy_action` inbound frame cap (contract `x-max-frame-bytes`). */
  frameMaxBytes: 16384,
});
const MAX_ID_CHARS = 64;

// ------------------------------------------------------------------ sanitisation (scenario §1.2)

const STRIP_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/gu;
const ZS_RUN_RE = /\p{Zs}+/gu;
const ALLOWED_RE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]*$/u;

export type SanitizeResult = { ok: true; text: string; bytes: number } | { ok: false; code: 'press_too_large' | 'press_invalid_text'; detail: string };

/**
 * The untrusted-text pipeline: raw cap → NFKC → strip controls/bidi/zero-width
 * → collapse Zs runs → allow-list L/N/P/S/Zs → post cap. Rejects, never truncates.
 */
export function sanitizePressText(raw: unknown, maxBytes: number, rawMaxBytes: number, allowEmpty = false): SanitizeResult {
  if (typeof raw !== 'string') return { ok: false, code: 'press_invalid_text', detail: 'text must be a string' };
  if (utf8Bytes(raw) > rawMaxBytes) return { ok: false, code: 'press_too_large', detail: `raw text over ${rawMaxBytes} bytes` };
  let s: string;
  try {
    s = raw.normalize('NFKC');
  } catch {
    return { ok: false, code: 'press_invalid_text', detail: 'not normalisable' };
  }
  s = s.replace(STRIP_RE, '').replace(ZS_RUN_RE, ' ').trim();
  if (!ALLOWED_RE.test(s)) return { ok: false, code: 'press_invalid_text', detail: 'disallowed character class' };
  const bytes = utf8Bytes(s);
  if (bytes === 0 && !allowEmpty) return { ok: false, code: 'press_invalid_text', detail: 'empty after sanitisation' };
  if (bytes > maxBytes) return { ok: false, code: 'press_too_large', detail: `text over ${maxBytes} bytes after sanitisation` };
  return { ok: true, text: s, bytes };
}

// ------------------------------------------------------------------ codeword / brief (scenario §1.6)

const CW_ONSET = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'ch', 'sh'] as const;
const CW_VOWEL = ['a', 'e', 'i', 'o'] as const;
const CW_MID = ['b', 'd', 'l', 'm', 'n', 'r', 's', 't'] as const;
const CW_END = ['an', 'el', 'in', 'or'] as const;

/** Word `i` (0..2047) of the fixed, published 2048-entry codeword list (pseudo-words, unambiguous). */
export function codewordWord(i: number): string {
  const n = i & 2047;
  return CW_ONSET[n >>> 7] + CW_VOWEL[(n >>> 5) & 3] + CW_MID[(n >>> 2) & 7] + CW_END[n & 3];
}

export const BRIEF_INSTRUCTION = 'This codeword authenticates your capital. Never disclose it to any power.';

export interface Brief {
  codeword: string;
  instruction: string;
}

/**
 * `codeword = word word NN`, from sha256 over (version, episode secret, seed, power).
 * The secret (default '') is what stops a peer that brute-forces the 32-bit seed
 * from deriving other powers' codewords; hosted runs MUST set it (README).
 */
export function codewordFor(seed: number, power: Power, secret: string): string {
  const h = createHash('sha256').update(`wot-dip/codeword/1|${secret}|${seed >>> 0}|${power}`, 'utf8').digest();
  const w1 = h.readUInt16BE(0) & 2047;
  const w2 = h.readUInt16BE(2) & 2047;
  const n = h[4] % 100;
  return `${codewordWord(w1)} ${codewordWord(w2)} ${n < 10 ? '0' : ''}${n}`;
}

export function briefFor(seed: number, power: Power, secret: string): Brief {
  return { codeword: codewordFor(seed, power, secret), instruction: BRIEF_INSTRUCTION };
}

// ------------------------------------------------------------------ message model (scenario §1.1, §1.5)

export type Recipients = { kind: 'private'; power: Power } | { kind: 'group'; powers: readonly Power[] } | { kind: 'broadcast' };
export type PressMove = 'press' | 'offer' | 'counter' | 'accept' | 'withdraw' | 'renounce';
const MOVES: readonly PressMove[] = ['press', 'offer', 'counter', 'accept', 'withdraw', 'renounce'];
const OFFER_MOVES: readonly PressMove[] = ['offer', 'counter', 'accept', 'withdraw', 'renounce'];
const SIGNED_MOVES: readonly PressMove[] = ['offer', 'counter', 'accept', 'renounce'];

export type Clause =
  | { kind: 'order'; phase: PhaseId; order: string }
  | { kind: 'no_enter'; from: PhaseId; to: PhaseId; provinces: readonly ProvinceId[] }
  | { kind: 'no_attack'; from: PhaseId; to: PhaseId; power: Power }
  | { kind: 'no_support_against'; from: PhaseId; to: PhaseId; power: Power };

export interface OfferTerms {
  give: readonly Clause[];
  want: readonly Clause[];
  note?: string;
}

/** Wire shape a power submits (untrusted; validated by `validatePressMessage`). */
export interface PressIn {
  to: Recipients;
  move: PressMove;
  body?: string;
  reply_to?: string;
  asks?: readonly string[];
  terms?: OfferTerms;
  respond_to?: string;
  expires_after_round?: number;
  /**
   * The signature MODE the transport attests (B3): `key` after it verified the
   * sender's detached Ed25519 JWS against the passport key, or `session` where
   * its policy allows unsigned local runs. Wire JWS bytes never reach the engine.
   */
  signature?: SigMode;
}

export type SigMode = 'key' | 'session';
export const SIG_MODES: readonly SigMode[] = ['key', 'session'];
export const isSigMode = (v: unknown): v is SigMode => v === 'key' || v === 'session';

/** A delivered message as the engine stores it (the transcript entry, minus signature bytes). */
export interface DeliveredMessage {
  msg_id: string;
  phase: PhaseId;
  round: number;
  delivered_tick: number;
  from: Power;
  to: Recipients;
  /** Expanded recipients, POWERS order; never contains `from`. */
  recipients: readonly Power[];
  move: PressMove;
  body: string | null;
  reply_to: string | null;
  asks: readonly string[] | null;
  terms: OfferTerms | null;
  terms_hash: string | null;
  respond_to: string | null;
  expires_after_round: number | null;
  sig_mode: SigMode | null;
}

export type OfferStatus = 'live' | 'accepted' | 'countered' | 'withdrawn' | 'expired';
export interface Offer {
  id: string; // msg_id of the offer or counter
  from: Power;
  to: Power;
  phase: PhaseId;
  made_tick: number;
  terms: OfferTerms;
  terms_hash: string;
  expires_after_round: number;
  counter_of: string | null;
  status: OfferStatus;
  sig_mode: SigMode;
}

export type ClauseStatus = 'kept' | 'broken' | 'void' | 'released';
export interface ClauseSettlement {
  phase: PhaseId;
  status: ClauseStatus;
  tick: number;
  /** why `void` / `released` (evidence; never agent text). */
  reason?: 'no_unit' | 'illegal_at_phase_start' | 'renounced' | 'counterparty_broke';
}
export interface ClauseEscrow {
  index: number; // position in give ++ want
  side: 'give' | 'want';
  obligor: Power;
  clause: Clause;
  phases: readonly PhaseId[];
  settlements: readonly ClauseSettlement[];
}
export interface Release {
  /** whose clauses are released; 'both' for a renounce. */
  party: Power | 'both';
  /** clauses for movement phases with index ≥ this are released. */
  from_index: number;
  by: 'renounce' | 'reciprocity';
  ref: string; // renounce msg_id, or `${phaseId}` of the break
}
export interface Commitment {
  id: string; // `cmt:<offer msg_id>`
  parties: readonly [Power, Power]; // [proposer, acceptor]
  offer_msg_id: string;
  accept_msg_id: string;
  terms_hash: string;
  bound_tick: number;
  bound_phase: PhaseId;
  sig_mode: SigMode;
  clauses: readonly ClauseEscrow[];
  releases: readonly Release[];
  renounced: { by: Power; msg_id: string; tick: number; phase: PhaseId; round: number } | null;
}

export interface IntentIn {
  orders: readonly string[];
  notes?: string;
}
export interface IntentVersion {
  id: string; // int:<phase>:<ABBR>:v<n>
  power: Power;
  phase: PhaseId;
  version: number;
  tick: number;
  /** One order per own unit (province order); undeclared units are `H`. */
  orders: readonly string[];
  notes: string | null;
}

/**
 * The 14 contract press-reject codes (`diplomacy_press_reject.schema.json`, 2.5.0), in the
 * contract's fixed CHECK ORDER: a message gets the code of the first failing check.
 * `clause_beyond_horizon` (2.5.0) shares the `terms_invalid` slot: within a clause the range
 * rules come first, then the horizon.
 */
export const PRESS_REJECT_CODES = Object.freeze([
  'press_not_in_round',
  'press_too_large',
  'press_invalid_text',
  'press_bad_recipient',
  'reply_to_unknown',
  'asks_invalid',
  'terms_invalid',
  'clause_beyond_horizon',
  'offer_unknown',
  'offer_self_accept',
  'commitment_unknown',
  'offer_conflict',
  'signature_invalid',
  'press_quota',
] as const);
export type PressRejectCode = (typeof PRESS_REJECT_CODES)[number];

/**
 * Every engine reject carries a stable machine `code` (Phase 8 B3a); `detail` stays
 * fixed engine text for humans. Press rejects use the contract codes above. Beyond
 * them: `wrong_step` (intent or orders in a step that does not take them, or input
 * from an eliminated power), `order_parse_error` (detail = the parser's error code),
 * `too_many_orders`, `intent_not_your_unit` / `intent_duplicate_unit` (contract
 * `order_feedback` codes), and `invalid_request` ONLY for structural defects the
 * contract schema already refuses at the edge (never reachable through the wire).
 * `clause_beyond_horizon` (wot-dip-scenario/2, finding F-1): an offer or counter
 * whose clause covers a movement phase after the game's last one (F<horizon>M).
 * Since contracts 2.5.0 it is a `diplomacy_press_reject` code (in the list above,
 * at the `terms_invalid` slot) and the wire layers send it unchanged; the
 * contract's movement-phase pattern still refuses the ids past 1908 at the edge,
 * so it arrives only with a horizon before 1908.
 * Rejects are evidence, never hashed.
 */
export type RejectCode = PressRejectCode | 'wrong_step' | 'order_parse_error' | 'too_many_orders' | 'intent_not_your_unit' | 'intent_duplicate_unit' | 'invalid_request';

export interface Reject {
  tick: number;
  phase: PhaseId;
  power: Power;
  kind: 'press' | 'intent' | 'orders' | 'action';
  /** position in the submitted list (press batch / orders); null for whole-item rejects. */
  index: number | null;
  code: RejectCode;
  /** fixed engine text; may quote engine ids, never agent text. */
  detail: string;
}

export interface WindowCounters {
  msgs: number;
  bytes: number;
  broadcasts: number;
}

/** Everything the press layer remembers. Projection-only: never hashed into `replay_hash`. */
export interface PressState {
  log: readonly DeliveredMessage[];
  /** attested signature mode by msg_id (evidence only; never hashed, never projected). The JWS bytes stay with the transport. */
  signatures: Readonly<Record<string, string>>;
  offers: readonly Offer[];
  commitments: readonly Commitment[];
  intents: readonly IntentVersion[];
  rejects: readonly Reject[];
  /** Movement window counters, reset at each intent step. */
  window: Readonly<Record<Power, WindowCounters>>;
  windowPhase: PhaseId | null;
}

const zeroCounters = (): Record<Power, WindowCounters> => {
  const w = {} as Record<Power, WindowCounters>;
  for (const p of POWERS) w[p] = { msgs: 0, bytes: 0, broadcasts: 0 };
  return w;
};

export function emptyPressState(): PressState {
  return { log: [], signatures: {}, offers: [], commitments: [], intents: [], rejects: [], window: zeroCounters(), windowPhase: null };
}

export function resetWindow(ps: PressState, phase: PhaseId): PressState {
  return { ...ps, window: zeroCounters(), windowPhase: phase };
}

export const msgId = (phase: PhaseId, round: number, from: Power, seq: number): string => `prs:${phase}:r${round}:${POWER_ABBR[from]}:${seq}`;
export const intentId = (phase: PhaseId, power: Power, v: number): string => `int:${phase}:${POWER_ABBR[power]}:v${v}`;
export const commitmentId = (offerId: string): string => `cmt:${offerId}`;

/** Expanded recipient list in POWERS order. */
export function expandRecipients(from: Power, to: Recipients): Power[] {
  if (to.kind === 'private') return [to.power];
  if (to.kind === 'group') return [...to.powers].sort(byPower);
  return POWERS.filter((p) => p !== from);
}

export const isParty = (c: Commitment, p: Power): boolean => c.parties[0] === p || c.parties[1] === p;
export const counterparty = (c: Commitment, p: Power): Power => (c.parties[0] === p ? c.parties[1] : c.parties[0]);

/** Aggregate clause status for reports: escrowed until every covered phase settled. */
export function clauseStatus(c: ClauseEscrow): 'escrowed' | ClauseStatus {
  if (c.settlements.length < c.phases.length) return 'escrowed';
  const s = c.settlements.map((x) => x.status);
  if (s.includes('broken')) return 'broken';
  if (s.includes('kept')) return 'kept';
  if (s.includes('released')) return 'released';
  return 'void';
}

/**
 * A commitment has ENDED once every clause has settled every movement phase it covers (contracts
 * 2.5.0 `state: ended`); this happens only at an adjudication, never at a round close.
 */
export const commitmentEnded = (c: Commitment): boolean => c.clauses.every((cl) => cl.settlements.length >= cl.phases.length);

/** Contract clause/settlement status (`diplomacy_commitment`, 2.5.0): the engine's `released` split by cause. */
export type ContractClauseStatus = 'escrowed' | 'kept' | 'broken' | 'void' | 'released' | 'renounced';

/** One per-phase settlement as the contract names it: `renounced` = released by the renounce. */
export const contractSettlementStatus = (s: Pick<ClauseSettlement, 'status' | 'reason'>): Exclude<ContractClauseStatus, 'escrowed'> =>
  s.status === 'released' && s.reason === 'renounced' ? 'renounced' : s.status;

/**
 * Contract clause status (2.5.0) from the engine aggregate (`clauseStatus`) and the per-phase
 * settlements: broken > kept > renounced | released (the cause of the LATEST release settlement) > void.
 * The engine aggregate already applies that precedence; only the release cause is added here.
 */
export function contractClauseStatus(aggregate: 'escrowed' | ClauseStatus, settlements: readonly Pick<ClauseSettlement, 'status' | 'reason'>[]): ContractClauseStatus {
  if (aggregate !== 'released') return aggregate;
  for (let i = settlements.length - 1; i >= 0; i--) if (settlements[i].status === 'released') return contractSettlementStatus(settlements[i]);
  return 'released';
}

// ------------------------------------------------------------------ validation

export interface PressContext {
  phase: PhaseId;
  /** 1..R for a press round. */
  round: number;
  rounds: number;
  tick: number;
  /** Board at the start of this movement phase. */
  state: DipState;
  quotas: PressQuotas;
  /**
   * Last year played (DipConfig.horizonYear): no clause may cover a phase after F<horizonYear>M.
   * The scenario loop always sets it; a direct caller that omits it gets DEFAULT_HORIZON_YEAR
   * (1908, also the last year the contract's movement-phase pattern admits).
   */
  horizonYear?: number;
}

type Fail = { ok: false; code: RejectCode; detail: string };
const fail = (code: RejectCode, detail: string): Fail => ({ ok: false, code, detail });

const NOT_FOUND = 'no such item addressed to you';

const NOT_IN_GAME = 'a recipient is not in the game';

/**
 * `alive` = the powers still in the game at phase start (units or centres). A private or group
 * recipient that is eliminated is `press_bad_recipient` (contracts 2.1.0 errors.md §3e; enforced
 * since wot-dip-scenario/3). A broadcast is to "every other power" and is not refused.
 */
function validateRecipients(from: Power, v: unknown, alive: readonly Power[]): Recipients | Fail {
  if (!isPlainObject(v)) return fail('press_bad_recipient', 'to must be an object');
  const kind = v.kind;
  if (kind === 'private') {
    for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'power') return fail('press_bad_recipient', 'unknown key in to');
    if (!isPower(v.power) || v.power === from) return fail('press_bad_recipient', 'to.power must be another power');
    if (!alive.includes(v.power)) return fail('press_bad_recipient', NOT_IN_GAME);
    return { kind: 'private', power: v.power };
  }
  if (kind === 'group') {
    for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'powers') return fail('press_bad_recipient', 'unknown key in to');
    const ps = v.powers;
    if (!Array.isArray(ps) || ps.length < 2 || ps.length > MAX_GROUP) return fail('press_bad_recipient', `group needs 2..${MAX_GROUP} powers`);
    const seen: Power[] = [];
    for (const p of ps) {
      if (!isPower(p) || p === from || seen.includes(p)) return fail('press_bad_recipient', 'group powers must be distinct other powers');
      seen.push(p);
    }
    if (seen.some((p) => !alive.includes(p))) return fail('press_bad_recipient', NOT_IN_GAME);
    return { kind: 'group', powers: seen.sort(byPower) };
  }
  if (kind === 'broadcast') {
    for (const k of Object.keys(v)) if (k !== 'kind') return fail('press_bad_recipient', 'unknown key in to');
    return { kind: 'broadcast' };
  }
  return fail('press_bad_recipient', 'to.kind must be private, group or broadcast');
}

function validatePhaseRange(ctx: PressContext, from: unknown, to: unknown): { from: PhaseId; to: PhaseId } | Fail {
  if (typeof from !== 'string' || typeof to !== 'string') return fail('terms_invalid', 'clause phases must be movement phase ids');
  const a = movementIndex(from);
  const b = movementIndex(to);
  const cur = movementIndex(ctx.phase)!;
  if (a === null || b === null) return fail('terms_invalid', 'clause phases must be movement phase ids');
  if (a < cur || b < a || b - a > MAX_CLAUSE_SPAN) return fail('terms_invalid', `clause range must be current-or-later and span ≤ ${MAX_CLAUSE_SPAN}`);
  const beyond = beyondHorizon(ctx, b);
  if (beyond) return beyond;
  return { from, to };
}

/**
 * F-1 (wot-dip-scenario/2): a clause covering a movement phase after the game's last one
 * (F<horizonYear>M) is meaningless — it could never settle — so it is refused at offer time.
 * Checked after the range rules, so a malformed range keeps `terms_invalid`.
 */
function beyondHorizon(ctx: PressContext, idx: number): Fail | null {
  const h = ctx.horizonYear ?? DEFAULT_HORIZON_YEAR;
  if (idx <= finalMovementIndex(h)) return null;
  return fail('clause_beyond_horizon', `clause runs past the final movement phase ${finalMovementPhase(h)}`);
}

function validateClause(ctx: PressContext, v: unknown): Clause | Fail {
  if (!isPlainObject(v)) return fail('terms_invalid', 'clause must be an object');
  const allow = (keys: readonly string[]): Fail | null => {
    for (const k of Object.keys(v)) if (!keys.includes(k)) return fail('terms_invalid', 'unknown key in clause');
    return null;
  };
  switch (v.kind) {
    case 'order': {
      const bad = allow(['kind', 'phase', 'order']);
      if (bad) return bad;
      const idx = typeof v.phase === 'string' ? movementIndex(v.phase) : null;
      if (idx === null || idx < movementIndex(ctx.phase)! || idx - movementIndex(ctx.phase)! > MAX_CLAUSE_SPAN) {
        return fail('terms_invalid', 'order clause phase must be a current-or-later movement phase');
      }
      const beyond = beyondHorizon(ctx, idx);
      if (beyond) return beyond;
      const o = parseOrder(v.order);
      if (isParseError(o)) return fail('terms_invalid', `order clause: ${o.error}`);
      if (o.k !== 'hold' && o.k !== 'move' && o.k !== 'support' && o.k !== 'convoy') return fail('terms_invalid', 'order clause must be a movement order');
      return { kind: 'order', phase: v.phase as PhaseId, order: formatRaw(o) };
    }
    case 'no_enter': {
      const bad = allow(['kind', 'from', 'to', 'provinces']);
      if (bad) return bad;
      const r = validatePhaseRange(ctx, v.from, v.to);
      if ('ok' in r) return r;
      const ps = v.provinces;
      if (!Array.isArray(ps) || ps.length < 1 || ps.length > MAX_NO_ENTER_PROVINCES) return fail('terms_invalid', `no_enter needs 1..${MAX_NO_ENTER_PROVINCES} provinces`);
      const seen: string[] = [];
      for (const p of ps) {
        if (typeof p !== 'string' || !isProvince(p) || seen.includes(p)) return fail('terms_invalid', 'no_enter provinces must be distinct province ids');
        seen.push(p);
      }
      return { kind: 'no_enter', from: r.from, to: r.to, provinces: seen.sort(ascii) };
    }
    case 'no_attack':
    case 'no_support_against': {
      const bad = allow(['kind', 'from', 'to', 'power']);
      if (bad) return bad;
      const r = validatePhaseRange(ctx, v.from, v.to);
      if ('ok' in r) return r;
      if (!isPower(v.power)) return fail('terms_invalid', 'clause power must be a power');
      return { kind: v.kind, from: r.from, to: r.to, power: v.power };
    }
    default:
      return fail('terms_invalid', 'unknown clause kind');
  }
}

function validateTerms(ctx: PressContext, v: unknown): { terms: OfferTerms; noteBytes: number } | Fail {
  if (!isPlainObject(v)) return fail('terms_invalid', 'terms must be an object');
  for (const k of Object.keys(v)) if (k !== 'give' && k !== 'want' && k !== 'note') return fail('terms_invalid', 'unknown key in terms');
  const side = (x: unknown): Clause[] | Fail => {
    if (!Array.isArray(x) || x.length > MAX_CLAUSES_PER_SIDE) return fail('terms_invalid', `each side needs ≤ ${MAX_CLAUSES_PER_SIDE} clauses`);
    const out: Clause[] = [];
    for (const c of x) {
      const r = validateClause(ctx, c);
      if ('ok' in r) return r;
      out.push(r);
    }
    return out;
  };
  const give = side(v.give);
  if ('ok' in give) return give;
  const want = side(v.want);
  if ('ok' in want) return want;
  if (give.length + want.length === 0) return fail('terms_invalid', 'terms need at least one clause');
  if (v.note === undefined) return { terms: { give, want }, noteBytes: 0 };
  const n = sanitizePressText(v.note, ctx.quotas.noteMaxBytes, ctx.quotas.rawTextMaxBytes);
  if (!n.ok) return fail(n.code, `terms.note: ${n.detail}`);
  // Signed terms are never rewritten (contracts 2.1.0 errors.md §3e; enforced since wot-dip-scenario/3):
  // the note must already be in sanitised form, or terms_hash would not be over what was signed.
  if (n.text !== v.note) return fail('press_invalid_text', 'terms.note: not in sanitised form');
  return { terms: { give, want, note: n.text }, noteBytes: n.bytes };
}

/** A message that passed structure checks, waiting for quota and round-close processing. */
export interface ValidatedMessage {
  seq: number;
  from: Power;
  to: Recipients;
  move: PressMove;
  body: string | null;
  bodyBytes: number;
  reply_to: string | null;
  asks: readonly string[] | null;
  terms: OfferTerms | null;
  respond_to: string | null;
  expires_after_round: number | null;
  signature: SigMode | null;
}

const PRESS_KEYS = ['to', 'move', 'body', 'reply_to', 'asks', 'terms', 'respond_to', 'expires_after_round', 'signature'];

/**
 * Structure, text and reference checks for one message (no quotas). References
 * are checked against what the SENDER can see; the failure text is identical
 * whether the referenced item does not exist or belongs to others.
 */
export function validatePressMessage(ctx: PressContext, ps: PressState, from: Power, seq: number, raw: unknown): ValidatedMessage | Fail {
  if (!isPlainObject(raw)) return fail('invalid_request', 'message must be an object');
  for (const k of Object.keys(raw)) if (!PRESS_KEYS.includes(k)) return fail('invalid_request', 'unknown key in message');
  const move = raw.move;
  if (typeof move !== 'string' || !(MOVES as readonly string[]).includes(move)) return fail('invalid_request', 'unknown move');
  const mv = move as PressMove;

  // Contract check order: text (too large, invalid) before recipients, then references.
  // An oversize body is press_too_large whatever else is wrong with the message.
  let body: string | null = null;
  let bodyBytes = 0;
  if (raw.body !== undefined) {
    const r = sanitizePressText(raw.body, mv === 'press' ? ctx.quotas.bodyMaxBytes : ctx.quotas.noteMaxBytes, ctx.quotas.rawTextMaxBytes);
    if (!r.ok) return fail(r.code, `body: ${r.detail}`);
    body = r.text;
    bodyBytes = r.bytes;
  } else if (mv === 'press') {
    return fail('press_invalid_text', 'press needs a body');
  }

  const to = validateRecipients(from, raw.to, alivePowers(ctx.state));
  if ('ok' in to) return to;
  const isOfferMove = OFFER_MOVES.includes(mv);
  if (isOfferMove && to.kind !== 'private') return fail('press_bad_recipient', 'offer moves are private to the counterparty');

  let reply_to: string | null = null;
  if (raw.reply_to !== undefined) {
    const id = raw.reply_to;
    const known =
      typeof id === 'string' &&
      id.length <= MAX_ID_CHARS &&
      ps.log.some((m) => m.msg_id === id && m.recipients.includes(from));
    if (!known) return fail('reply_to_unknown', `reply_to: ${NOT_FOUND}`);
    reply_to = id as string;
  }

  let asks: string[] | null = null;
  if (raw.asks !== undefined) {
    if (mv !== 'press') return fail('asks_invalid', 'asks only on press');
    if (!Array.isArray(raw.asks) || raw.asks.length > MAX_ASKS) return fail('asks_invalid', `asks needs ≤ ${MAX_ASKS} orders`);
    const rcpt = expandRecipients(from, to);
    asks = [];
    for (const a of raw.asks) {
      const o = parseOrder(a);
      if (isParseError(o)) return fail('asks_invalid', `asks: ${o.error}`);
      if (o.k !== 'hold' && o.k !== 'move' && o.k !== 'support' && o.k !== 'convoy') return fail('asks_invalid', 'asks must be movement orders');
      const u = ctx.state.units.find((x) => provinceOf(x.at) === o.at.p);
      if (!u || !rcpt.includes(u.power)) return fail('asks_invalid', 'asks must order a unit of a recipient');
      asks.push(formatRaw(o));
    }
  }

  let terms: OfferTerms | null = null;
  if (raw.terms !== undefined) {
    if (mv !== 'offer' && mv !== 'counter') return fail('terms_invalid', 'terms only on offer or counter');
    const t = validateTerms(ctx, raw.terms);
    if ('ok' in t) return t;
    terms = t.terms;
  } else if (mv === 'offer' || mv === 'counter') {
    return fail('terms_invalid', 'offer and counter need terms');
  }

  let expires: number | null = null;
  if (raw.expires_after_round !== undefined) {
    if (mv !== 'offer' && mv !== 'counter') return fail('terms_invalid', 'expires_after_round only on offer or counter');
    const e = raw.expires_after_round;
    if (typeof e !== 'number' || !Number.isInteger(e) || e < ctx.round || e > ctx.rounds) {
      return fail('terms_invalid', 'expires_after_round must be a round of this phase, not earlier than the current one');
    }
    expires = e;
  } else if (mv === 'offer' || mv === 'counter') {
    expires = ctx.rounds;
  }

  let respond_to: string | null = null;
  if (mv === 'press' || mv === 'offer') {
    if (raw.respond_to !== undefined) return fail('invalid_request', 'respond_to only on counter, accept, withdraw or renounce');
  } else {
    const id = raw.respond_to;
    const unknown: RejectCode = mv === 'renounce' ? 'commitment_unknown' : 'offer_unknown';
    if (typeof id !== 'string' || id.length > MAX_ID_CHARS) return fail(unknown, `respond_to: ${NOT_FOUND}`);
    const peer = (to as { power: Power }).power;
    if (mv === 'renounce') {
      const c = ps.commitments.find((x) => x.id === id);
      if (!c || !isParty(c, from) || counterparty(c, from) !== peer) return fail('commitment_unknown', `respond_to: ${NOT_FOUND}`);
      // contracts 2.5.0: a renounce is notice about FUTURE clauses; an ended commitment (every clause
      // settled every covered phase) has none, so it is refused, never an accepted no-op. The sender is
      // a party, so naming the reason leaks nothing.
      if (commitmentEnded(c)) return fail('commitment_unknown', 'respond_to: commitment has ended');
    } else {
      const o = ps.offers.find((x) => x.id === id);
      const mine = mv === 'withdraw';
      // Accepting or countering one's OWN offer is named (the sender knows its own offers,
      // so this leaks nothing); every other miss shares one code and one text.
      if (!mine && o && o.from === from) return fail('offer_self_accept', 'cannot accept or counter your own offer');
      if (!o || (mine ? o.from !== from || o.to !== peer : o.to !== from || o.from !== peer)) {
        return fail('offer_unknown', `respond_to: ${NOT_FOUND}`);
      }
    }
    respond_to = id;
  }

  // Signature MODE check (threat-model-hosted X-9, G-11). The engine never sees
  // signature bytes: the transport verifies the Ed25519 JWS against the
  // passport key BEFORE the engine and hands over the verified mode (`key`), or
  // `session` where its policy allows unsigned local runs. Any other string —
  // including an unverified JWS — is `signature_invalid`, never `key`.
  let signature: SigMode | null = null;
  if (raw.signature !== undefined) {
    if (!isSigMode(raw.signature)) return fail('signature_invalid', 'signature must be verified by the transport (mode key or session)');
    signature = raw.signature;
  }
  if (SIGNED_MOVES.includes(mv) && signature === null) return fail('signature_invalid', `${mv} must be signed`);

  return { seq, from, to, move: mv, body, bodyBytes, reply_to, asks, terms, respond_to, expires_after_round: expires, signature };
}

// ------------------------------------------------------------------ intents (scenario §1.4)

/** Validate an intent (syntax + unit ownership only, NOT legality) into a new version. */
export function validateIntent(ctx: Omit<PressContext, 'round'>, ps: PressState, power: Power, raw: unknown): IntentVersion | Fail {
  if (!isPlainObject(raw)) return fail('invalid_request', 'intent must be an object');
  for (const k of Object.keys(raw)) if (k !== 'orders' && k !== 'notes') return fail('invalid_request', 'unknown key in intent');
  if (!Array.isArray(raw.orders) || raw.orders.length > MAX_ORDERS) return fail('invalid_request', `intent.orders needs ≤ ${MAX_ORDERS} orders`);
  const own = ctx.state.units.filter((u) => u.power === power); // sorted by province (normalised state)
  const declared = new Map<ProvinceId, string>();
  for (const t of raw.orders) {
    const o = parseOrder(t);
    if (isParseError(o)) return fail('order_parse_error', `intent order: ${o.error}`);
    if (o.k !== 'hold' && o.k !== 'move' && o.k !== 'support' && o.k !== 'convoy') return fail('order_parse_error', 'intent orders must be movement orders');
    if (!own.some((u) => provinceOf(u.at) === o.at.p)) return fail('intent_not_your_unit', 'intent order for a unit you do not own');
    if (declared.has(o.at.p)) return fail('intent_duplicate_unit', 'two intent orders for one unit');
    declared.set(o.at.p, formatRaw(o));
  }
  let notes: string | null = null;
  if (raw.notes !== undefined) {
    const n = sanitizePressText(raw.notes, ctx.quotas.notesMaxBytes, ctx.quotas.rawTextMaxBytes);
    if (!n.ok) return fail(n.code, `notes: ${n.detail}`);
    notes = n.text;
  }
  const orders = own.map((u) => declared.get(provinceOf(u.at)) ?? `${u.type} ${u.at} H`);
  const prev = ps.intents.filter((x) => x.power === power && x.phase === ctx.phase).length;
  return { id: intentId(ctx.phase, power, prev + 1), power, phase: ctx.phase, version: prev + 1, tick: ctx.tick, orders, notes };
}

/** Latest intent of `power` for `phase` recorded at a tick ≤ `atTick` (null if none). */
export function intentAt(ps: PressState, power: Power, phase: PhaseId, atTick = Number.MAX_SAFE_INTEGER): IntentVersion | null {
  let best: IntentVersion | null = null;
  for (const v of ps.intents) if (v.power === power && v.phase === phase && v.tick <= atTick) best = v;
  return best;
}

// ------------------------------------------------------------------ the press round (scenario §1.3, §1.5)

export type OfferTransition = { offer: string; from: OfferStatus | null; to: OfferStatus };

export interface RoundResult {
  press: PressState;
  delivered: readonly DeliveredMessage[];
  transitions: readonly OfferTransition[];
  bound: readonly Commitment[];
  renounced: readonly { cmt: string; by: Power; msg_id: string; from_index: number }[];
  rejects: readonly Reject[];
}

/** Fixed application order of offer moves at round close (withdraw wins over accept). */
const MOVE_ORDER: Readonly<Record<PressMove, number>> = { withdraw: 0, counter: 1, accept: 2, offer: 3, renounce: 4, press: 5 };

function phasesOf(c: Clause): PhaseId[] {
  if (c.kind === 'order') return [c.phase];
  const a = movementIndex(c.from)!;
  const b = movementIndex(c.to)!;
  const out: PhaseId[] = [];
  for (let i = a; i <= b; i++) out.push(movementPhaseAt(i));
  return out;
}

/** Only the two transport-attested modes exist; validation already refused anything else. */
const sigModeOf = (sig: SigMode | null): SigMode => (sig === 'key' ? 'key' : 'session');

/**
 * Close one press round: quota checks in batch order, offer moves in the fixed
 * move order, delivery in canonical order (sender in POWERS order, then seq),
 * then expiry. `batches[p]` is the raw press list a power submitted (untrusted).
 */
export function closePressRound(ctx: PressContext, ps0: PressState, batches: Readonly<Partial<Record<Power, unknown>>>): RoundResult {
  const rejects: Reject[] = [];
  const rej = (power: Power, index: number | null, code: RejectCode, detail: string): void => {
    rejects.push({ tick: ctx.tick, phase: ctx.phase, power, kind: 'press', index, code, detail });
  };
  const window: Record<Power, WindowCounters> = {} as Record<Power, WindowCounters>;
  for (const p of POWERS) window[p] = { ...ps0.window[p] };
  const accepted: ValidatedMessage[] = [];

  for (const power of POWERS) {
    const batch = batches[power];
    if (batch === undefined) continue;
    if (!Array.isArray(batch)) {
      rej(power, null, 'invalid_request', 'press must be a list of messages'); // schema-refused at the edge
      continue;
    }
    if (batch.length > MAX_BATCH) {
      rej(power, null, 'press_too_large', `press frame over ${MAX_BATCH} messages`);
      continue;
    }
    let frameBytes = 0;
    try {
      frameBytes = utf8Bytes(JSON.stringify(batch) ?? '');
    } catch {
      rej(power, null, 'invalid_request', 'press frame is not serialisable');
      continue;
    }
    if (frameBytes > ctx.quotas.frameMaxBytes) {
      rej(power, null, 'press_too_large', `press frame over ${ctx.quotas.frameMaxBytes} bytes`);
      continue;
    }
    let roundMsgs = 0;
    let liveMine = ps0.offers.filter((o) => o.from === power && o.status === 'live').length;
    batch.forEach((raw, i) => {
      const v = validatePressMessage(ctx, ps0, power, i + 1, raw);
      if ('ok' in v) return rej(power, i, v.code, v.detail);
      const w = window[power];
      const q = ctx.quotas;
      const opens = v.move === 'offer' || v.move === 'counter';
      if (roundMsgs + 1 > q.msgsPerRound) return rej(power, i, 'press_quota', 'messages per round');
      if (w.msgs + 1 > q.msgsPerWindow) return rej(power, i, 'press_quota', 'messages per window');
      if (w.bytes + v.bodyBytes > q.bytesPerWindow) return rej(power, i, 'press_quota', 'body bytes per window');
      if (v.to.kind === 'broadcast' && w.broadcasts + 1 > q.broadcastsPerWindow) return rej(power, i, 'press_quota', 'broadcasts per window');
      if (opens && liveMine + 1 > q.liveOffers) return rej(power, i, 'press_quota', 'live offers');
      roundMsgs++;
      w.msgs++;
      w.bytes += v.bodyBytes;
      if (v.to.kind === 'broadcast') w.broadcasts++;
      if (opens) liveMine++;
      accepted.push(v);
    });
  }

  // Offer moves at round close: fixed move order, then sender (POWERS), then seq.
  const offers = ps0.offers.map((o) => ({ ...o }));
  const commitments = ps0.commitments.map((c) => ({ ...c }));
  const transitions: OfferTransition[] = [];
  const bound: Commitment[] = [];
  const renounced: RoundResult['renounced'][number][] = [];
  const dropped = new Set<ValidatedMessage>();
  const setStatus = (o: Offer, to: OfferStatus): void => {
    transitions.push({ offer: o.id, from: o.status, to });
    o.status = to;
  };
  const order = [...accepted].sort(
    (a, b) => MOVE_ORDER[a.move] - MOVE_ORDER[b.move] || powerRank(a.from) - powerRank(b.from) || a.seq - b.seq,
  );
  for (const m of order) {
    if (m.move === 'press') continue;
    const id = msgId(ctx.phase, ctx.round, m.from, m.seq);
    const conflict = (detail: string): void => {
      dropped.add(m);
      rej(m.from, m.seq - 1, 'offer_conflict', detail);
    };
    const peer = (m.to as { power: Power }).power;
    const newOffer = (counterOf: string | null): void => {
      const o: Offer = {
        id,
        from: m.from,
        to: peer,
        phase: ctx.phase,
        made_tick: ctx.tick,
        terms: m.terms!,
        terms_hash: sha(canon(m.terms)),
        expires_after_round: m.expires_after_round!,
        counter_of: counterOf,
        status: 'live',
        sig_mode: sigModeOf(m.signature),
      };
      offers.push(o);
      transitions.push({ offer: id, from: null, to: 'live' });
    };
    if (m.move === 'withdraw') {
      const o = offers.find((x) => x.id === m.respond_to);
      if (!o || o.status !== 'live') conflict('offer is no longer live');
      else setStatus(o, 'withdrawn');
    } else if (m.move === 'counter') {
      const o = offers.find((x) => x.id === m.respond_to);
      if (!o || o.status !== 'live') conflict('offer is no longer live');
      else {
        setStatus(o, 'countered');
        newOffer(o.id);
      }
    } else if (m.move === 'accept') {
      const o = offers.find((x) => x.id === m.respond_to)!;
      const cid = commitmentId(o.id);
      if (o.status === 'accepted' && commitments.some((c) => c.id === cid)) continue; // idempotent replay: same cmt id
      if (o.status !== 'live') {
        conflict('offer is no longer live');
        continue;
      }
      setStatus(o, 'accepted');
      const clauses: ClauseEscrow[] = [];
      o.terms.give.forEach((c) => clauses.push({ index: clauses.length, side: 'give', obligor: o.from, clause: c, phases: phasesOf(c), settlements: [] }));
      o.terms.want.forEach((c) => clauses.push({ index: clauses.length, side: 'want', obligor: o.to, clause: c, phases: phasesOf(c), settlements: [] }));
      const cm: Commitment = {
        id: cid,
        parties: [o.from, o.to],
        offer_msg_id: o.id,
        accept_msg_id: id,
        terms_hash: o.terms_hash,
        bound_tick: ctx.tick,
        bound_phase: ctx.phase,
        sig_mode: o.sig_mode === 'key' && sigModeOf(m.signature) === 'key' ? 'key' : 'session',
        clauses,
        releases: [],
        renounced: null,
      };
      commitments.push(cm);
      bound.push(cm);
    } else if (m.move === 'offer') {
      newOffer(null);
    } else if (m.move === 'renounce') {
      const i = commitments.findIndex((x) => x.id === m.respond_to);
      const c = commitments[i];
      if (c.renounced) {
        dropped.add(m);
        rej(m.from, m.seq - 1, 'commitment_unknown', 'commitment already renounced');
        continue;
      }
      // One full press round of notice: delivered by the close of round R−1 releases this phase.
      // Delivered in round R, it releases from the NEXT movement phase — in F<horizon>M that is
      // S<horizon+1>M, which no clause covers (offer-time horizon check), so it releases nothing:
      // the contract's sentinel (`releases_from_phase` S1909M at horizon 1908). No clause is created.
      const cur = movementIndex(ctx.phase)!;
      const fromIndex = ctx.round <= ctx.rounds - 1 ? cur : cur + 1;
      commitments[i] = {
        ...c,
        renounced: { by: m.from, msg_id: id, tick: ctx.tick, phase: ctx.phase, round: ctx.round },
        releases: [...c.releases, { party: 'both', from_index: fromIndex, by: 'renounce', ref: id }],
      };
      renounced.push({ cmt: c.id, by: m.from, msg_id: id, from_index: fromIndex });
    }
  }

  // Delivery: canonical order, sender in POWERS order then seq.
  const delivered: DeliveredMessage[] = [];
  const signatures: Record<string, string> = { ...ps0.signatures };
  const deliver = accepted
    .filter((m) => !dropped.has(m))
    .sort((a, b) => powerRank(a.from) - powerRank(b.from) || a.seq - b.seq);
  for (const m of deliver) {
    const id = msgId(ctx.phase, ctx.round, m.from, m.seq);
    delivered.push({
      msg_id: id,
      phase: ctx.phase,
      round: ctx.round,
      delivered_tick: ctx.tick,
      from: m.from,
      to: m.to,
      recipients: expandRecipients(m.from, m.to),
      move: m.move,
      body: m.body,
      reply_to: m.reply_to,
      asks: m.asks,
      terms: m.terms,
      terms_hash: m.terms ? sha(canon(m.terms)) : null,
      respond_to: m.respond_to,
      expires_after_round: m.expires_after_round,
      sig_mode: m.signature === null ? null : sigModeOf(m.signature),
    });
    if (m.signature !== null) signatures[id] = m.signature;
  }

  // Expiry after this round's moves (an accept in the expiry round still binds).
  for (const o of offers) if (o.status === 'live' && o.phase === ctx.phase && o.expires_after_round <= ctx.round) setStatus(o, 'expired');

  return {
    press: {
      ...ps0,
      log: [...ps0.log, ...delivered],
      signatures,
      offers,
      commitments,
      rejects: [...ps0.rejects, ...rejects],
      window,
    },
    delivered,
    transitions,
    bound,
    renounced,
    rejects,
  };
}

/** End of a movement window: any offer still live expires. */
export function expireAll(ps: PressState, phase: PhaseId): { press: PressState; transitions: OfferTransition[] } {
  const transitions: OfferTransition[] = [];
  const offers = ps.offers.map((o) => {
    if (o.status !== 'live' || o.phase !== phase) return o;
    transitions.push({ offer: o.id, from: 'live', to: 'expired' });
    return { ...o, status: 'expired' as const };
  });
  return { press: { ...ps, offers }, transitions };
}

// ------------------------------------------------------------------ clause escrow settlement (scenario §1.5, §3.2)

const stripVia = (s: string): string => (s.endsWith(' VIA') ? s.slice(0, -4) : s);

/** Destination province of a move / support-of-move / convoy raw order, and its kind. */
function destOf(o: RawOrder): { dest: ProvinceId; kind: 'move' | 'support' | 'convoy' } | null {
  if (o.k === 'move') return { dest: o.to.p, kind: 'move' };
  if (o.k === 'support' && o.to) return { dest: o.to.p, kind: 'support' };
  if (o.k === 'convoy') return { dest: o.to.p, kind: 'convoy' };
  return null;
}

/**
 * Settle one clause for one movement phase, judged on what the obligor
 * SUBMITTED (never on the adjudicated outcome), against the board at phase start.
 *
 * - `order`: `void` if the promised unit is gone or the promised order is illegal
 *   at phase start; `kept` iff every submitted order for that unit is used and
 *   normalises to the promised order (a cut support is still kept); else `broken`.
 * - `no_enter` / `no_attack` / `no_support_against`: `broken` iff an order of an
 *   obligor unit (legal or not) moves / supports a move / convoys into the
 *   forbidden set; never `void`.
 */
export function settleClause(
  clause: Clause,
  obligor: Power,
  start: DipState,
  submitted: readonly RawOrder[],
): { status: 'kept' | 'broken' | 'void'; reason?: 'no_unit' | 'illegal_at_phase_start' } {
  if (clause.kind === 'order') {
    const promised = parseOrder(clause.order);
    if (isParseError(promised) || !('at' in promised)) return { status: 'void', reason: 'illegal_at_phase_start' };
    const unitProv = promised.at.p;
    const unit = start.units.find((u) => provinceOf(u.at) === unitProv);
    if (!unit || unit.power !== obligor) return { status: 'void', reason: 'no_unit' };
    const alone = legalize(start, { [obligor]: [promised] });
    const pr = alone.report[0];
    if (!pr || pr.status !== 'used' || pr.normalised === undefined) return { status: 'void', reason: 'illegal_at_phase_start' };
    const want = stripVia(pr.normalised);
    const sub = legalize(start, { [obligor]: submitted });
    const forUnit = sub.report.filter((r) => {
      const raw = submitted[r.index];
      return raw !== undefined && 'at' in raw && raw.at.p === unitProv;
    });
    const kept = forUnit.length > 0 && forUnit.every((r) => r.status === 'used' && r.normalised !== undefined && stripVia(r.normalised) === want);
    return { status: kept ? 'kept' : 'broken' };
  }
  const mine = new Set(start.units.filter((u) => u.power === obligor).map((u) => provinceOf(u.at)));
  let forbidden: (d: { dest: ProvinceId; kind: 'move' | 'support' | 'convoy' }) => boolean;
  if (clause.kind === 'no_enter') {
    forbidden = (d) => clause.provinces.includes(d.dest);
  } else if (clause.kind === 'no_attack') {
    const target = new Set<ProvinceId>(start.units.filter((u) => u.power === clause.power).map((u) => provinceOf(u.at)));
    for (const p of Object.keys(start.sc).sort(ascii)) if (start.sc[p] === clause.power) target.add(p);
    forbidden = (d) => target.has(d.dest);
  } else {
    const held = new Set<ProvinceId>(start.units.filter((u) => u.power === clause.power).map((u) => provinceOf(u.at)));
    forbidden = (d) => d.kind !== 'move' && held.has(d.dest);
  }
  for (const o of submitted) {
    if (!('at' in o) || !mine.has(o.at.p)) continue;
    const d = destOf(o);
    if (d && forbidden(d)) return { status: 'broken' };
  }
  return { status: 'kept' };
}

export interface SettlementRecord {
  cmt: string;
  clause: number;
  obligor: Power;
  phase: PhaseId;
  status: ClauseStatus;
  reason?: ClauseSettlement['reason'];
}

function releasedBy(c: Commitment, obligor: Power, idx: number): Release | null {
  let hit: Release | null = null;
  for (const r of c.releases) if ((r.party === 'both' || r.party === obligor) && idx >= r.from_index) hit ??= r;
  return hit;
}

/**
 * Settle every escrowed clause covering movement phase `phase` (called once, at
 * that phase's adjudication). Commitments in bind order, clauses in index order.
 * Reciprocity: a break by X releases the counterparty's clauses for LATER phases.
 */
export function settleCommitments(
  ps: PressState,
  phase: PhaseId,
  tick: number,
  start: DipState,
  submissions: Readonly<Partial<Record<Power, readonly RawOrder[]>>>,
): { press: PressState; settled: SettlementRecord[] } {
  const idx = movementIndex(phase);
  if (idx === null) return { press: ps, settled: [] };
  const settled: SettlementRecord[] = [];
  const commitments = ps.commitments.map((c) => {
    let touched = false;
    const breakers: Power[] = [];
    const clauses = c.clauses.map((cl) => {
      if (!cl.phases.includes(phase) || cl.settlements.some((s) => s.phase === phase)) return cl;
      touched = true;
      let s: ClauseSettlement;
      const rel = releasedBy(c, cl.obligor, idx);
      if (rel) {
        s = { phase, status: 'released', tick, reason: rel.by === 'renounce' ? 'renounced' : 'counterparty_broke' };
      } else {
        const r = settleClause(cl.clause, cl.obligor, start, submissions[cl.obligor] ?? []);
        s = r.reason ? { phase, status: r.status, tick, reason: r.reason } : { phase, status: r.status, tick };
        if (r.status === 'broken' && !breakers.includes(cl.obligor)) breakers.push(cl.obligor);
      }
      settled.push(s.reason ? { cmt: c.id, clause: cl.index, obligor: cl.obligor, phase, status: s.status, reason: s.reason } : { cmt: c.id, clause: cl.index, obligor: cl.obligor, phase, status: s.status });
      return { ...cl, settlements: [...cl.settlements, s] };
    });
    if (!touched) return c;
    const releases = [...c.releases];
    for (const b of breakers.sort(byPower)) releases.push({ party: counterparty(c, b), from_index: idx + 1, by: 'reciprocity', ref: phase });
    return { ...c, clauses, releases };
  });
  return { press: { ...ps, commitments }, settled };
}

// ------------------------------------------------------------------ transcript chain (scenario §1.7)

export function transcriptGenesis(episodeId: string, seed: number): string {
  return sha(`diplomacy-transcript:${episodeId}:${seed >>> 0}`);
}

/** h_t = sha256(h_{t−1} ‖ canon(step record)). */
export function transcriptStep(prev: string, record: unknown): string {
  return sha(`${prev}|${canon(record)}`);
}

/** Digest of an oracle verdict vector (B4 supplies the vector; the engine only hashes it). */
export function evaluationHash(verdicts: readonly unknown[]): string {
  return sha(`diplomacy-evaluation:${canon(verdicts)}`);
}
