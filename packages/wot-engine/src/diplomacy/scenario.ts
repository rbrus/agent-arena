/**
 * The Diplomacy game loop (docs/design/diplomacy-adjudicator.md §6;
 * docs/design/diplomacy-scenario.md §1.3). Pure: every function returns a new
 * episode; no clock, no I/O, and the seat shuffle at `dipInit` is the ONLY RNG.
 *
 * Steps per movement phase: intent → press r1..rR → orders (adjudicate +
 * clause settlement). Retreat and adjustment phases: one orders step, no press.
 * One step = one tick. A missed deadline is simply an absent action: no intent,
 * an empty press batch, or NMR orders (holds; retreat → disband; adjustments →
 * civil disorder, all inside `adjudicate`). A forfeited power is in civil
 * disorder for the rest of the game.
 *
 * Two chains:
 *  - `chain` (replay_hash): EXACTLY the adjudicator chain of hash.ts (genesis =
 *    ruleset + map + seat powers + horizon; per adjudicated phase the settled
 *    orders digest and the next state hash). `replayDip(seats, horizon, subs)`
 *    over the recorded settled submissions reproduces it. Press has no path in.
 *  - `transcript` (transcript_hash): one fold per tick over the step record
 *    (delivered press, intent versions, offer transitions, bindings,
 *    renounces, clause settlements).
 * `evaluation_hash` is a hook for B4's oracles (`dipEvaluate`).
 */

import { hash32, mulberry32 } from '../rng.ts';
import { chainStart, chainStep, stateHash } from './hash.ts';
import { buildDipObservation, PROJECTION_TAG, type DipObservation, type DipProjection, type DipStepKind, type LastPhaseView } from './observation.ts';
import { formatRaw } from './orders.ts';
import { isParseError, MAX_ORDERS, rawFromJson } from './parse.ts';
import {
  briefFor,
  closePressRound,
  evaluationHash,
  expireAll,
  emptyPressState,
  intentAt,
  isParty,
  movementIndex,
  PRESS_QUOTAS,
  resetWindow,
  settleCommitments,
  transcriptGenesis,
  transcriptStep,
  validateIntent,
  type Brief,
  type EvalClass,
  type PressQuotas,
  type PressState,
  type Reject,
  type RejectCode,
  type SettlementRecord,
} from './press.ts';
import { adjudicate, initialState, phaseId, RULESET } from './state.ts';
import { alivePowers, checkTerminal, DEFAULT_HORIZON_YEAR, type DipTerminal } from './terminal.ts';
import type { DipEvent, DipState, OrderReport, OrderResult, PhaseId, Power, ProvinceId, RawOrder, Submissions } from './types.ts';
import { POWERS } from './types.ts';

/**
 * Engine scenario-layer version. /2 (Phase 8 F-1): offers and counters whose clause covers a
 * movement phase after F<horizonYear>M are rejected (`clause_beyond_horizon`), and the house
 * diplomat and injector clamp their clause spans to the horizon. Transcripts of tables whose
 * reference seats used to offer such clauses move; settled orders do not (see the golden test).
 * /3 (contracts 2.5.0): a renounce of an ENDED commitment (every clause settled every covered phase)
 * is refused `commitment_unknown` instead of being delivered as a no-op; private/group press to an
 * eliminated power is `press_bad_recipient`; a `terms.note` not in sanitised form is
 * `press_invalid_text` (contract rules since 2.1.0). Only transcripts of tables
 * whose seats renounce ended commitments move (the scripted X.K anchor); the 14 golden pair tables,
 * the house sweep and every replay_hash are unchanged.
 */
export const DIP_SCENARIO_VERSION = 'wot-dip-scenario/3';
/** Hard cap on one action's JSON size before anything in it is inspected. */
export const MAX_ACTION_BYTES = 65536;
export const DEFAULT_HARD_MISS_FORFEIT = 3; // Phase 7 HARD_MISS_FORFEIT (arena-scenarios/src/tiers.ts)

export interface DipConfig {
  /** Last year played; the game ends after its Fall SC update. */
  horizonYear: number;
  /** Press rounds per movement phase (R). */
  pressRounds: number;
  quotas: PressQuotas;
  /** Explicit seat → power list (golden pairs, fixed tables); else the seeded shuffle. */
  seatPowers?: readonly Power[];
  /** Transcript genesis input. */
  episodeId: string;
  /** Episode secret for codewords (hosted runs set it; disclosed after terminal). */
  secret: string;
  hardMissForfeit: number;
}

export function defaultDipConfig(cls: EvalClass, seed: number): DipConfig {
  const q = PRESS_QUOTAS[cls];
  return {
    horizonYear: DEFAULT_HORIZON_YEAR,
    pressRounds: q.rounds,
    quotas: { ...q },
    episodeId: `dip:${seed >>> 0}`,
    secret: '',
    hardMissForfeit: DEFAULT_HARD_MISS_FORFEIT,
  };
}

/** What a power submits for one step (untrusted; validated at tick). */
export interface DipAction {
  /** Intent step, and optional revision in any press round. */
  intent?: unknown;
  /** Press rounds only: a list of PressIn. */
  press?: unknown;
  /** Orders step only: text (§1.5.1) or interim JSON orders. */
  orders?: unknown;
}

export interface DipStep {
  phaseId: PhaseId;
  kind: DipStepKind;
  /** 1..R for press; 0 otherwise. */
  round: number;
  roundsTotal: number;
}

export interface PhaseRecord {
  phaseId: PhaseId;
  tick: number;
  /** Settled (parseable) orders per power, formatRaw, submission order: the replay input. */
  submissions: Readonly<Record<Power, readonly string[]>>;
  /** Parse-rejected entries (evidence; never replay input). `text` only when a short string. */
  parseRejected: readonly { power: Power; index: number; error: string; text: string | null }[];
  report: readonly OrderReport[];
  results: readonly OrderResult[];
  events: readonly DipEvent[];
  settlements: readonly SettlementRecord[];
  stateHash: string;
  chain: string;
}

export interface TickInput {
  tick: number;
  step: string;
  /** Post-clone actions of every non-forfeited power that acted (null = unreadable action). */
  actions: Readonly<Partial<Record<Power, DipAction | null>>>;
  /** Powers forfeited at this tick, before it was played. */
  forfeit: readonly Power[];
}

export interface MissEntry {
  tick: number;
  power: Power;
  step: DipStepKind;
  severity: 'soft' | 'hard';
}

export interface DipEpisode {
  readonly seed: number;
  readonly cls: EvalClass;
  readonly config: DipConfig;
  /** seat i plays seats[i]. */
  readonly seats: readonly Power[];
  /** HIDDEN per power: each power sees only its own brief. */
  readonly briefs: Readonly<Record<Power, Brief>>;
  readonly state: DipState;
  readonly tick: number;
  readonly step: DipStep;
  /** HIDDEN until the tick: latest action per power (latest replaces). */
  readonly pending: Readonly<Partial<Record<Power, DipAction | null>>>;
  readonly press: PressState;
  readonly forfeited: readonly { power: Power; tick: number }[];
  readonly missStreak: Readonly<Record<Power, number>>;
  /** Attested timing evidence (budget_violation); never hashed. */
  readonly misses: readonly MissEntry[];
  readonly chain: string;
  readonly transcript: string;
  readonly history: readonly PhaseRecord[];
  readonly lastPhase: LastPhaseView | null;
  readonly contested: readonly ProvinceId[];
  /** Each power's rejects from the last tick (projected to that power only). */
  readonly feedback: Readonly<Partial<Record<Power, readonly Reject[]>>>;
  readonly inputs: readonly TickInput[];
  readonly terminal: DipTerminal | null;
}

// ------------------------------------------------------------------ init

/** Design §6.1: `mulberry32(hash32('wot-dip/seats:' + seed))`, Fisher–Yates from i = 6 down to 1. */
export function seatPowers(seed: number): Power[] {
  const rng = mulberry32(hash32('wot-dip/seats:' + (seed >>> 0)));
  const a = [...POWERS];
  for (let i = a.length - 1; i >= 1; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function validateConfig(c: DipConfig): void {
  if (!Number.isInteger(c.horizonYear) || c.horizonYear < 1901 || c.horizonYear > 1999) throw new Error('config: horizonYear must be 1901..1999');
  if (!Number.isInteger(c.pressRounds) || c.pressRounds < 0 || c.pressRounds > 8) throw new Error('config: pressRounds must be 0..8');
  if (!Number.isInteger(c.hardMissForfeit) || c.hardMissForfeit < 1) throw new Error('config: hardMissForfeit must be ≥ 1');
  if (c.seatPowers) {
    const s = [...c.seatPowers];
    if (s.length !== POWERS.length || POWERS.some((p) => !s.includes(p))) throw new Error('config: seatPowers must be a permutation of POWERS');
  }
}

const zeroStreak = (): Record<Power, number> => {
  const r = {} as Record<Power, number>;
  for (const p of POWERS) r[p] = 0;
  return r;
};

function firstStepOf(state: DipState, rounds: number): DipStep {
  const id = phaseId(state);
  return state.phase === 'M' ? { phaseId: id, kind: 'intent', round: 0, roundsTotal: rounds } : { phaseId: id, kind: 'orders', round: 0, roundsTotal: 0 };
}

export function dipInit(seed: number, cls: EvalClass, overrides: Partial<DipConfig> = {}): DipEpisode {
  const config: DipConfig = { ...defaultDipConfig(cls, seed), ...overrides };
  validateConfig(config);
  const seats = config.seatPowers ? [...config.seatPowers] : seatPowers(seed);
  const briefs = {} as Record<Power, Brief>;
  for (const p of POWERS) briefs[p] = briefFor(seed, p, config.secret);
  const state = initialState();
  return {
    seed: seed >>> 0,
    cls,
    config,
    seats,
    briefs,
    state,
    tick: 0,
    step: firstStepOf(state, config.pressRounds),
    pending: {},
    press: resetWindow(emptyPressState(), phaseId(state)),
    forfeited: [],
    missStreak: zeroStreak(),
    misses: [],
    chain: chainStart({ ruleset: RULESET, seats, horizonYear: config.horizonYear }, state),
    transcript: transcriptGenesis(config.episodeId, seed),
    history: [],
    lastPhase: null,
    contested: [],
    feedback: {},
    inputs: [],
    terminal: null,
  };
}

// ------------------------------------------------------------------ act / miss / forfeit

export const isForfeited = (ep: DipEpisode, p: Power): boolean => ep.forfeited.some((f) => f.power === p);
export const seatOf = (ep: DipEpisode, p: Power): number => ep.seats.indexOf(p);

/** Snapshot an untrusted action (JSON semantics). Unreadable or oversize → null (rejected at tick). */
function snapshot(action: unknown): DipAction | null {
  try {
    const s = JSON.stringify(action);
    if (s === undefined || Buffer.byteLength(s, 'utf8') > MAX_ACTION_BYTES) return null;
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as DipAction) : null;
  } catch {
    return null;
  }
}

/** Buffer a power's action for the current step (latest replaces). No-op after terminal or forfeit. */
export function dipAct(ep: DipEpisode, power: Power, action: unknown): DipEpisode {
  if (!POWERS.includes(power)) throw new Error(`dipAct: unknown power ${String(power)}`);
  if (ep.terminal || isForfeited(ep, power)) return ep;
  return { ...ep, pending: { ...ep.pending, [power]: snapshot(action) }, missStreak: { ...ep.missStreak, [power]: 0 } };
}

/** Forfeit: the power is in civil disorder until the end (design §6.4). Recorded as a replay input. */
export function dipForfeit(ep: DipEpisode, power: Power): DipEpisode {
  if (ep.terminal || isForfeited(ep, power)) return ep;
  const pending = { ...ep.pending };
  delete pending[power];
  return { ...ep, pending, forfeited: [...ep.forfeited, { power, tick: ep.tick }] };
}

/**
 * The arena reports a missed deadline for `power` at the current step. The
 * engine never waits: absent = default. `hard` misses in a row reach the
 * forfeit threshold. Misses are attested evidence only (never hashed).
 */
export function dipMiss(ep: DipEpisode, power: Power, severity: 'soft' | 'hard'): DipEpisode {
  if (ep.terminal || isForfeited(ep, power)) return ep;
  const streak = severity === 'hard' ? ep.missStreak[power] + 1 : ep.missStreak[power];
  const next: DipEpisode = {
    ...ep,
    misses: [...ep.misses, { tick: ep.tick, power, step: ep.step.kind, severity }],
    missStreak: { ...ep.missStreak, [power]: streak },
  };
  return streak >= ep.config.hardMissForfeit ? dipForfeit(next, power) : next;
}

// ------------------------------------------------------------------ tick

export const stepLabel = (s: DipStep): string => (s.kind === 'press' ? `${s.phaseId}:r${s.round}` : `${s.phaseId}:${s.kind}`);

function nextStep(ep: DipEpisode, s: DipStep): DipStep {
  if (s.kind === 'intent') return ep.config.pressRounds > 0 ? { ...s, kind: 'press', round: 1 } : { ...s, kind: 'orders', round: 0 };
  if (s.kind === 'press') return s.round < s.roundsTotal ? { ...s, round: s.round + 1 } : { ...s, kind: 'orders', round: 0 };
  throw new Error('nextStep: orders steps advance the phase');
}

export interface DipTickResult {
  ep: DipEpisode;
  events: readonly DipEvent[];
}

const MAX_REJECTED_TEXT = 256;

/** Play the current step. Throws after terminal (the caller checks `ep.terminal`). */
export function dipTick(ep: DipEpisode): DipTickResult {
  if (ep.terminal) throw new Error('dipTick: episode is terminal');
  const s = ep.step;
  const tick = ep.tick;
  const phase = s.phaseId;
  const rejects: Reject[] = [];
  /** Rejects closePressRound already appended to press.rejects. */
  let roundRejects: readonly Reject[] = [];
  const reject = (power: Power, kind: Reject['kind'], index: number | null, code: RejectCode, detail: string): void => {
    rejects.push({ tick, phase, power, kind, index, code, detail });
  };
  const alive = alivePowers(ep.state);
  const active = POWERS.filter((p) => !isForfeited(ep, p));
  const input: TickInput = {
    tick,
    step: stepLabel(s),
    actions: Object.fromEntries(active.filter((p) => ep.pending[p] !== undefined).map((p) => [p, ep.pending[p]!])),
    forfeit: ep.forfeited.filter((f) => f.tick === tick).map((f) => f.power),
  };
  // Per-power action for this step; null/garbage rejected whole; eliminated powers are out.
  const acts = {} as Partial<Record<Power, DipAction>>;
  for (const p of active) {
    const a = ep.pending[p];
    if (a === undefined) continue;
    if (a === null) {
      reject(p, 'action', null, 'invalid_request', 'action must be a JSON object within the size cap'); // schema-refused at the edge
      continue;
    }
    if (!alive.includes(p)) {
      reject(p, 'action', null, 'wrong_step', 'power is eliminated');
      continue;
    }
    for (const k of Object.keys(a)) if (k !== 'intent' && k !== 'press' && k !== 'orders') reject(p, 'action', null, 'invalid_request', 'unknown key in action');
    acts[p] = a;
  }
  const wrong = (p: Power, what: 'intent' | 'press' | 'orders'): void => {
    if (what === 'press') {
      // Contract: one `press_not_in_round` per message (a non-list is one whole-batch reject).
      const batch = acts[p]?.press;
      const n = Array.isArray(batch) ? batch.length : 0;
      if (n === 0) reject(p, 'press', null, 'press_not_in_round', `press is not accepted in a ${s.kind} step`);
      for (let i = 0; i < n; i++) reject(p, 'press', i, 'press_not_in_round', `press is not accepted in a ${s.kind} step`);
      return;
    }
    reject(p, what === 'orders' ? 'orders' : what, null, 'wrong_step', `${what} is not accepted in a ${s.kind} step`);
  };

  let press = ep.press;
  let state = ep.state;
  let history = ep.history;
  let lastPhase = ep.lastPhase;
  let contested = ep.contested;
  let chain = ep.chain;
  let terminal: DipTerminal | null = null;
  let events: readonly DipEvent[] = [];
  let step: DipStep;
  const record: Record<string, unknown> = { tick, phase, step: s.kind, round: s.round };
  const pressCtx = { phase, round: s.round, rounds: s.roundsTotal, tick, state, quotas: ep.config.quotas, horizonYear: ep.config.horizonYear };

  const recordIntents = (): void => {
    const recorded = [];
    for (const p of POWERS) {
      const a = acts[p];
      if (a?.intent === undefined) continue;
      const v = validateIntent(pressCtx, press, p, a.intent);
      if ('ok' in v) reject(p, 'intent', null, v.code, v.detail);
      else {
        press = { ...press, intents: [...press.intents, v] };
        recorded.push(v);
      }
    }
    record.intents = recorded;
  };

  if (s.kind === 'intent') {
    for (const p of POWERS) {
      if (acts[p]?.press !== undefined) wrong(p, 'press');
      if (acts[p]?.orders !== undefined) wrong(p, 'orders');
    }
    recordIntents();
    step = nextStep(ep, s);
  } else if (s.kind === 'press') {
    for (const p of POWERS) if (acts[p]?.orders !== undefined) wrong(p, 'orders');
    recordIntents();
    const batches: Partial<Record<Power, unknown>> = {};
    for (const p of POWERS) if (acts[p]?.press !== undefined) batches[p] = acts[p]!.press;
    const r = closePressRound(pressCtx, press, batches);
    press = r.press;
    rejects.push(...r.rejects);
    roundRejects = r.rejects;
    record.messages = r.delivered;
    record.offers = r.transitions;
    record.bound = r.bound.map((c) => ({ cmt: c.id, parties: c.parties, terms_hash: c.terms_hash, sig_mode: c.sig_mode, clauses: c.clauses.map((x) => ({ index: x.index, obligor: x.obligor, clause: x.clause })) }));
    record.renounced = r.renounced;
    step = nextStep(ep, s);
  } else {
    // ---------------------------------------------------------------- orders step
    for (const p of POWERS) {
      if (acts[p]?.intent !== undefined) wrong(p, 'intent');
      if (acts[p]?.press !== undefined) wrong(p, 'press');
    }
    const subs: Partial<Record<Power, RawOrder[]>> = {};
    const settledText = {} as Record<Power, string[]>;
    const parseRejected: PhaseRecord['parseRejected'][number][] = [];
    for (const p of POWERS) {
      const list: RawOrder[] = [];
      const a = acts[p];
      if (a?.orders !== undefined) {
        if (!Array.isArray(a.orders)) reject(p, 'orders', null, 'invalid_request', 'orders must be a list');
        else
          a.orders.forEach((o: unknown, i: number) => {
            if (i >= MAX_ORDERS) return reject(p, 'orders', i, 'too_many_orders', `more than ${MAX_ORDERS} orders`);
            const r = rawFromJson(o);
            if (isParseError(r)) {
              reject(p, 'orders', i, 'order_parse_error', r.error);
              parseRejected.push({ power: p, index: i, error: r.error, text: typeof o === 'string' && o.length <= MAX_REJECTED_TEXT ? o : null });
            } else list.push(r);
          });
      }
      if (list.length) subs[p] = list;
      settledText[p] = list.map(formatRaw);
    }
    const settled: Submissions = subs;
    const out = adjudicate(state, settled);
    chain = chainStep(chain, phase, settled, out.next);
    let settlements: SettlementRecord[] = [];
    if (state.phase === 'M') {
      const st = settleCommitments(press, phase, tick, state, settled);
      press = st.press;
      settlements = st.settled;
      const ex = expireAll(press, phase);
      press = ex.press;
      record.offers = ex.transitions;
    }
    record.settlements = settlements;
    const resultOf = (power: Power, norm: string | undefined): OrderResult['result'] | undefined =>
      norm === undefined ? undefined : out.results.find((r) => r.power === power && r.order === norm)?.result;
    lastPhase = {
      phase_id: phase,
      orders: out.legal.report.map((r) => {
        const o: LastPhaseView['orders'][number] = { power: r.power, order: r.normalised ?? r.raw, status: r.status };
        if (r.reason !== undefined) o.reason = r.reason;
        const res = resultOf(r.power, r.normalised);
        if (res !== undefined) o.result = res;
        return o;
      }),
    };
    contested = state.phase === 'M' ? out.contested : [];
    history = [
      ...history,
      {
        phaseId: phase,
        tick,
        submissions: settledText,
        parseRejected,
        report: out.legal.report,
        results: out.results,
        events: out.events,
        settlements,
        stateHash: stateHash(out.next),
        chain,
      },
    ];
    events = out.events;
    terminal = checkTerminal(phase, out.next, ep.config.horizonYear);
    state = out.next;
    step = firstStepOf(state, ep.config.pressRounds);
    if (state.phase === 'M' && movementIndex(step.phaseId) !== null) press = resetWindow(press, step.phaseId);
  }

  const feedback: Partial<Record<Power, Reject[]>> = {};
  for (const r of rejects) (feedback[r.power] ??= []).push(r);
  const rejectsLog = rejects.filter((r) => !roundRejects.includes(r));
  press = { ...press, rejects: [...press.rejects, ...rejectsLog] };

  return {
    ep: {
      ...ep,
      state,
      tick: tick + 1,
      step,
      pending: {},
      press,
      chain,
      transcript: transcriptStep(ep.transcript, record),
      history,
      lastPhase,
      contested,
      feedback,
      inputs: [...ep.inputs, input],
      terminal,
    },
    events,
  };
}

// ------------------------------------------------------------------ observe

/**
 * THE whitelist gate: the only function that reads a `DipEpisode` on behalf of
 * a power. Everything it passes is either public or the viewer's own.
 */
export function projectForPower(ep: DipEpisode, power: Power): DipProjection {
  const cur = ep.step.phaseId;
  const ps = ep.press;
  return {
    tag: PROJECTION_TAG,
    pub: {
      phaseId: cur,
      tick: ep.tick,
      step: { kind: ep.step.kind, round: ep.step.round, roundsTotal: ep.step.roundsTotal },
      horizonYear: ep.config.horizonYear,
      board: { year: ep.state.year, season: ep.state.season, phase: ep.state.phase, units: ep.state.units, dislodged: ep.state.dislodged, sc: ep.state.sc },
      contested: ep.contested,
      lastPhase: ep.lastPhase,
      terminal: ep.terminal,
    },
    own: {
      power,
      seat: seatOf(ep, power),
      brief: ep.briefs[power],
      intent: intentAt(ps, power, cur),
      sent: ps.log.filter((m) => m.phase === cur && m.from === power),
      offers: ps.offers.filter((o) => o.status === 'live' && (o.from === power || o.to === power)),
      commitments: ps.commitments.filter((c) => isParty(c, power)),
      rejects: ep.feedback[power] ?? [],
      window: ps.window[power],
    },
    inbox: { messages: ps.log.filter((m) => m.phase === cur && m.recipients.includes(power)) },
    quotas: ep.config.quotas,
  };
}

export function dipObserve(ep: DipEpisode, power: Power): DipObservation {
  return buildDipObservation(projectForPower(ep, power));
}

// ------------------------------------------------------------------ results, replay, evaluation hook

export interface DipResult {
  scenarioVersion: string;
  seed: number;
  cls: EvalClass;
  seats: readonly Power[];
  replayHash: string;
  transcriptHash: string;
  ticks: number;
  phases: number;
  terminal: DipTerminal | null;
}

export function dipResult(ep: DipEpisode): DipResult {
  return {
    scenarioVersion: DIP_SCENARIO_VERSION,
    seed: ep.seed,
    cls: ep.cls,
    seats: ep.seats,
    replayHash: ep.chain,
    transcriptHash: ep.transcript,
    ticks: ep.tick,
    phases: ep.history.length,
    terminal: ep.terminal,
  };
}

/** Settled submissions per adjudicated phase, as `replayDip` consumes them (parsed text). */
export function settledSubmissions(ep: DipEpisode): Submissions[] {
  return ep.history.map((h) => {
    const s: Partial<Record<Power, RawOrder[]>> = {};
    for (const p of POWERS) {
      const list = h.submissions[p].map((t) => rawFromJson(t)).filter((r): r is RawOrder => !isParseError(r));
      if (list.length) s[p] = list;
    }
    return s;
  });
}

/** Re-run an episode from seed + config overrides + recorded inputs. */
export function resimulateDip(seed: number, cls: EvalClass, overrides: Partial<DipConfig>, inputs: readonly TickInput[]): DipEpisode {
  let ep = dipInit(seed, cls, overrides);
  for (const inp of inputs) {
    if (inp.tick !== ep.tick) throw new Error(`resimulate: input for tick ${inp.tick} at tick ${ep.tick}`);
    for (const p of inp.forfeit) ep = dipForfeit(ep, p);
    for (const p of POWERS) {
      const a = inp.actions[p];
      if (a !== undefined) ep = dipAct(ep, p, a);
    }
    ep = dipTick(ep).ep;
  }
  return ep;
}

/** Oracle hook (Phase 8 B4). The engine only hashes the verdict vector the hook returns. */
export type DipOracleHook = (ep: DipEpisode) => readonly unknown[];

export function dipEvaluate(ep: DipEpisode, hook: DipOracleHook = () => []): { verdicts: readonly unknown[]; evaluationHash: string } {
  const verdicts = hook(ep);
  return { verdicts, evaluationHash: evaluationHash(verdicts) };
}
