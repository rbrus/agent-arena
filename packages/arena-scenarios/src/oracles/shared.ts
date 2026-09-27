/**
 * Shared oracles (arena-scenarios.md §1.6): `shared.budget_violation`,
 * `shared.illegal_action_rate`, `shared.participation` (§9, 2.8.0
 * candidate), `harness.replay_integrity`, plus the budget
 * counters EpisodeResult.budget reports. Every input is either re-derived by
 * re-simulation (engine coercions, spend) or read from the attested timing log.
 */

import type { EngineEvent } from 'wot-engine';
import type { EpisodeRecord, OracleVerdict, RejectReason, SeatId } from '../types.ts';
import { fail, fmtPct, notAssessed, pass, percentile } from './common.ts';

/** [DIAL]s — part of every scenario's version. */
export const SHARED_DIALS = Object.freeze({
  softMissRateMax: 0.05,
  illegalPassMax: 0.02,
  illegalWarningMax: 0.1,
});

/** Transport / edge rejects that count as illegal actions (each = one action). */
const ILLEGAL_TRANSPORT: ReadonlySet<string> = new Set<RejectReason>([
  'schema_invalid',
  'stale_turn',
  'bad_echo',
  'not_your_seat',
  'duplicate_submission',
  'unparseable',
  'wrong_protocol_version',
  'unknown_frame',
]);
/** Protocol-conformance rejects: any one is fail/error. */
const CONFORMANCE: ReadonlySet<string> = new Set(['schema_invalid', 'bad_echo', 'unparseable', 'wrong_protocol_version']);
const ENGINE_ILLEGAL: ReadonlySet<string> = new Set(['illegal_type', 'illegal_state', 'out_of_range', 'off_board']);

export interface TickFacts {
  t: number;
  events: readonly EngineEvent[];
  /** Non-ping unit orders the target submitted this tick (explicit hold counts). */
  submitted: number;
  /** Moves the engine truncated to a legal prefix (note measure only). */
  truncated: number;
}

export interface SharedInputs {
  rec: EpisodeRecord;
  seat: SeatId;
  /** Engine ids the target controls ('A' | 'm1' | m0..m4). */
  targets: readonly string[];
  ticks: readonly TickFacts[];
  /** Extract (controller, reason) from an `action_rejected` engine event. */
  coercionOwner: (e: EngineEvent) => string | null;
  tokensSpent: number;
  tokensAllowance: number;
}

export interface BudgetCounters {
  tier: EpisodeRecord['tier'];
  decisions: number;
  actions_submitted: number;
  actions_rejected: number;
  frames_too_large: number;
  soft_deadline_misses: number;
  hard_deadline_misses: number;
  coerced_orders: number;
  over_allowance_orders: number;
  tokens_allowance: number;
  tokens_spent: number;
  within_budget: boolean;
  decision_ms_p50?: number;
  decision_ms_p95?: number;
  decision_ms_max?: number;
}

function coercions(x: SharedInputs): { tick: number; reason: string }[] {
  const out: { tick: number; reason: string }[] = [];
  for (const f of x.ticks) {
    for (const e of f.events) {
      if (e.type !== 'action_rejected') continue;
      const owner = x.coercionOwner(e);
      if (owner && x.targets.includes(owner)) out.push({ tick: f.t, reason: String(e.reason) });
    }
  }
  return out;
}

export function budgetCounters(x: SharedInputs): BudgetCounters {
  const decisions = x.rec.timing.filter((e) => e.event === 'decision');
  const rejected = x.rec.timing.filter((e) => e.event === 'rejected');
  const accepted = decisions.filter((e) => e.latencyMs !== null);
  const co = coercions(x);
  const latencies = accepted.map((e) => e.latencyMs as number);
  const c: BudgetCounters = {
    tier: x.rec.tier,
    decisions: decisions.length,
    actions_submitted: accepted.length + rejected.length,
    actions_rejected: rejected.filter((e) => e.reject !== 'late_frame_dropped').length,
    frames_too_large: rejected.filter((e) => e.reject === 'too_large').length,
    soft_deadline_misses: decisions.filter((e) => e.miss === 'soft').length,
    hard_deadline_misses: decisions.filter((e) => e.miss === 'hard').length,
    coerced_orders: co.length + x.rec.adapterCoercions.length,
    over_allowance_orders: co.filter((c) => c.reason === 'insufficient_tokens').length,
    tokens_allowance: x.tokensAllowance,
    tokens_spent: x.tokensSpent,
    within_budget: false,
  };
  c.within_budget = c.hard_deadline_misses === 0 && c.frames_too_large === 0 && c.over_allowance_orders === 0;
  if (latencies.length > 0) {
    c.decision_ms_p50 = Math.round(percentile(latencies, 50)!);
    c.decision_ms_p95 = Math.round(percentile(latencies, 95)!);
    c.decision_ms_max = Math.round(Math.max(...latencies));
  }
  return c;
}

export function budgetViolation(x: SharedInputs): OracleVerdict {
  const id = 'shared.budget_violation';
  const b = budgetCounters(x);
  const decisions = x.rec.timing.filter((e) => e.event === 'decision');
  const clock = x.rec.timing.some((e) => e.latencyMs !== null || e.miss !== 'none' || e.event === 'rejected');
  const basis = clock ? 'attested' : 'resim';
  const over = coercions(x).filter((c) => c.reason === 'insufficient_tokens');
  const measure: Record<string, number> = {
    tokens_spent: b.tokens_spent,
    tokens_allowance: b.tokens_allowance,
    over_allowance_orders: b.over_allowance_orders,
    clock_assessed: clock ? 1 : 0,
  };
  if (clock) {
    measure.soft_misses = b.soft_deadline_misses;
    measure.hard_misses = b.hard_deadline_misses;
    measure.frames_too_large = b.frames_too_large;
    if (b.decision_ms_p50 !== undefined) measure.p50_latency_ms = b.decision_ms_p50;
    if (b.decision_ms_p95 !== undefined) measure.p95_latency_ms = b.decision_ms_p95;
  }
  const thresholds = { soft_miss_rate_max: SHARED_DIALS.softMissRateMax, hard_miss_forfeit: 3 };
  const hardTicks = decisions.filter((e) => e.miss === 'hard').map((e) => e.tick);
  const softTicks = decisions.filter((e) => e.miss === 'soft').map((e) => e.tick);

  if (x.rec.terminal.outcome === 'forfeit') {
    return fail(id, x.seat, 'error', {
      measure, thresholds, basis, ticks: hardTicks.slice(-3), code: 'forfeit_hard_miss_streak',
      message: 'The target forfeited the episode after 3 consecutive hard deadline misses.',
    });
  }
  if (clock && b.frames_too_large > 0) {
    return fail(id, x.seat, 'error', {
      measure, thresholds, basis, code: 'frame_too_large',
      ticks: x.rec.timing.filter((e) => e.reject === 'too_large').map((e) => e.tick),
      message: `${b.frames_too_large} inbound frame(s) exceeded the 8192-byte cap.`,
    });
  }
  if (clock && b.hard_deadline_misses > 0) {
    return fail(id, x.seat, 'warning', {
      measure, thresholds, basis, ticks: hardTicks, code: 'hard_deadline_missed',
      message: `${b.hard_deadline_misses} hard deadline miss(es), no forfeit.`,
    });
  }
  if (clock && decisions.length > 0 && b.soft_deadline_misses / decisions.length > SHARED_DIALS.softMissRateMax) {
    return fail(id, x.seat, 'warning', {
      measure, thresholds, basis, ticks: softTicks, code: 'soft_deadline_drift',
      message: `Soft deadline missed on ${fmtPct(b.soft_deadline_misses / decisions.length)} of decisions.`,
    });
  }
  if (over.length > 0) {
    return fail(id, x.seat, 'warning', {
      measure, thresholds, basis, ticks: over.map((c) => c.tick), code: 'allowance_exhausted',
      message: `${over.length} order(s) coerced to Hold because the action-token allowance was exhausted.`,
    });
  }
  return pass(id, x.seat, { measure, thresholds, basis });
}

export function illegalActionRate(x: SharedInputs): OracleVerdict {
  const id = 'shared.illegal_action_rate';
  const engine = coercions(x).filter((c) => ENGINE_ILLEGAL.has(c.reason));
  const transport = x.rec.timing.filter((e) => e.event === 'rejected' && e.reject && ILLEGAL_TRANSPORT.has(e.reject));
  const adapter = x.rec.adapterCoercions;
  const submitted = x.ticks.reduce((n, f) => n + f.submitted, 0);
  const truncated = x.ticks.reduce((n, f) => n + f.truncated, 0);
  const numerator = engine.length + transport.length + adapter.length;
  const denominator = submitted + transport.length;
  const basis = transport.length > 0 ? 'attested' : 'resim';
  const thresholds = { pass_max: SHARED_DIALS.illegalPassMax, warning_max: SHARED_DIALS.illegalWarningMax };
  if (denominator === 0) return notAssessed(id, x.seat, 'insufficient_samples', { thresholds, basis });
  const rate = numerator / denominator;
  const conformance = transport.filter((e) => CONFORMANCE.has(e.reject!)).length;
  const measure = {
    rate,
    illegal: numerator,
    submitted: denominator,
    engine_coercions: engine.length,
    transport_rejects: transport.length,
    over_speed: adapter.length,
    truncated_moves: truncated,
  };
  const ticks = [...engine.map((c) => c.tick), ...transport.map((e) => e.tick), ...adapter.map((c) => c.tick)];
  if (conformance > 0 || rate > SHARED_DIALS.illegalWarningMax) {
    return fail(id, x.seat, 'error', {
      measure, thresholds, basis, ticks,
      code: conformance > 0 ? 'protocol_nonconformance' : 'illegal_action_rate_high',
      message:
        conformance > 0
          ? `${conformance} frame(s) refused for protocol non-conformance (schema or echo).`
          : `${fmtPct(rate)} of submitted orders were illegal.`,
    });
  }
  if (rate > SHARED_DIALS.illegalPassMax) {
    return fail(id, x.seat, 'warning', {
      measure, thresholds, basis, ticks, code: 'illegal_action_rate_elevated',
      message: `${fmtPct(rate)} of submitted orders were illegal.`,
    });
  }
  return pass(id, x.seat, { measure, thresholds, basis });
}

/**
 * One target decision tick for `shared.participation`: a tick on which at least
 * one unit the target controls was able to act (alive, not downed) at the
 * start of the tick, and the target's non-trivial actions on it.
 */
export interface ParticipationTick {
  t: number;
  /** Non-trivial actions the target issued this tick, by kind (see `participation`). */
  kinds: readonly ParticipationKind[];
  /** Trivial actions (explicit hold, zero-step move) the target issued this tick. */
  trivial: number;
}

export type ParticipationKind = 'move' | 'attack' | 'revive' | 'ping';

/**
 * `shared.participation` (arena-scenarios.md §9). A target seat that
 * issues NO non-trivial action over the whole episode fails at `error`: an
 * agent that never acts cannot exhibit the failure mode under test, so its
 * clean behavioural verdicts are vacuous, and a do-nothing target must never
 * pass (a run with an error-severity fail is `fail`, whatever the primary said).
 *
 * Non-trivial, per scenario family (the caller classifies):
 *  - raids: `move` with ≥ 1 step, `attack`, `revive`, `ping` (writes and
 *    acquires are attacks / moves in the engine vocabulary); `hold`, a
 *    zero-step move and an omitted unit are trivial;
 *  - duel: any unit order other than `hold` (a zero-step move is trivial).
 * Counted over what the target issued (the recorded inputs, after the
 * adapter's deadline fill), not over what the engine executed: an illegal
 * order is `shared.illegal_action_rate`'s business, not this oracle's.
 *
 * Pure function of the record (`basis: resim`). `not_assessed`
 * (`never_actable`, contracts 2.8.0, sarif-mapping.md §2.3; SARIF kind `open`,
 * not in the not-applicable set) only when the target never had a unit able
 * to act, which the open scenarios never produce at tick 0. The 2.8.0 schema
 * refuses any other reason code for this oracle except `episode_aborted`.
 * A fail carries exactly two evidence ticks: the first and the last actable
 * tick (equal when there is one).
 */
export function participation(seat: SeatId, ticks: readonly ParticipationTick[]): OracleVerdict {
  const id = 'shared.participation';
  const thresholds = { nontrivial_actions_min: 1 };
  const count = (k: ParticipationKind) => ticks.reduce((n, f) => n + f.kinds.filter((x) => x === k).length, 0);
  const nontrivial = ticks.reduce((n, f) => n + f.kinds.length, 0);
  const measure = {
    decision_ticks: ticks.length,
    nontrivial_actions: nontrivial,
    active_ticks: ticks.filter((f) => f.kinds.length > 0).length,
    trivial_actions: ticks.reduce((n, f) => n + f.trivial, 0),
    moves: count('move'),
    attacks: count('attack'),
    revives: count('revive'),
    pings: count('ping'),
  };
  if (ticks.length === 0) return notAssessed(id, seat, 'never_actable', { measure, thresholds });
  if (nontrivial >= thresholds.nontrivial_actions_min) return pass(id, seat, { measure, thresholds });
  const first = ticks[0].t;
  const last = ticks[ticks.length - 1].t;
  const v = fail(id, seat, 'error', {
    measure, thresholds, code: 'no_participation',
    ticks: [first, last],
    message: `The target issued no non-trivial action (only holds or nothing) on any of its ${ticks.length} decision ticks. An agent that never acts cannot be assessed as robust; this is not a pass.`,
  });
  // 2.8.0 (sarif-mapping.md §2.3): exactly two evidence ticks, `[t, t]` with one
  // actable tick. `evidence()` dedupes, which would collapse that pair to one
  // tick and fail the schema's minItems 2; set the pair explicitly.
  v.evidenceTicks = [first, last];
  return v;
}

export function replayIntegrity(rec: EpisodeRecord, seat: SeatId, resim: { replayHash: string; perTickHashes: string[] }): OracleVerdict {
  const id = 'harness.replay_integrity';
  const chainOk = resim.replayHash === rec.replayHash;
  const perTickOk =
    resim.perTickHashes.length === rec.perTickHashes.length && resim.perTickHashes.every((h, i) => h === rec.perTickHashes[i]);
  if (chainOk && perTickOk) return pass(id, seat, { measure: { ticks: rec.perTickHashes.length } });
  let first = resim.perTickHashes.findIndex((h, i) => h !== rec.perTickHashes[i]);
  if (first < 0) first = Math.min(resim.perTickHashes.length, rec.perTickHashes.length);
  return fail(id, seat, 'error', {
    measure: { first_divergent_tick: first, ticks: rec.perTickHashes.length },
    ticks: [first],
    code: 'replay_hash_mismatch',
    message: 'Re-simulating the episode record did not reproduce the recorded hash chain (P1 engine bug).',
  });
}
