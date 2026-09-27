/**
 * Grid Tactics oracles (arena-scenarios.md §2.1): `grid_tactics.outcome`,
 * `grid_tactics.token_efficiency` (note), the shared oracles and the harness
 * integrity check, all over a re-simulation of the record. The run-level
 * `grid_tactics.win_rate` is computed by the reporter from episode outcomes
 * (`gridWinRate`).
 */

import { foldHash, isTerminal, resolveTick, stateHash, type EngineEvent, type MatchState, type TickActions } from 'wot-engine';
import { initialDuelState } from '../duel-state.ts';
import { tierOf } from '../tiers.ts';
import type { EpisodeRecord, OracleVerdict, Outcome } from '../types.ts';
import { fail, notAssessed, pass } from './common.ts';
import {
  budgetCounters,
  budgetViolation,
  illegalActionRate,
  participation,
  replayIntegrity,
  type BudgetCounters,
  type ParticipationKind,
  type ParticipationTick,
  type SharedInputs,
  type TickFacts,
} from './shared.ts';

export const GRID_DIALS = Object.freeze({ winRatePassMin: 0.5, winRateMinEpisodes: 6 });

export interface DuelTapTick {
  t: number;
  start: MatchState;
  actions: TickActions;
  end: MatchState;
  events: readonly EngineEvent[];
}

export function tapDuel(rec: EpisodeRecord): { ticks: DuelTapTick[]; perTickHashes: string[]; replayHash: string; final: MatchState } {
  let state = initialDuelState(rec.seed, rec.tier, rec.blindingKey);
  let chain = stateHash(state);
  const perTickHashes: string[] = [];
  const ticks: DuelTapTick[] = [];
  for (const pair of rec.inputs as TickActions[]) {
    const start = state;
    state = resolveTick(start, pair);
    const h = stateHash(state);
    perTickHashes.push(h);
    chain = foldHash(chain, h);
    ticks.push({ t: start.tick, start, actions: pair, end: state, events: state.events });
    if (isTerminal(state).over) break;
  }
  return { ticks, perTickHashes, replayHash: chain, final: state };
}

export const GRID_ORACLE_CATALOG = [
  'grid_tactics.outcome',
  'grid_tactics.token_efficiency',
  'shared.budget_violation',
  'shared.illegal_action_rate',
  'shared.participation',
  'harness.replay_integrity',
];

/**
 * `shared.participation` inputs for the duel (§9): every tick on which the
 * seat had a live unit; non-trivial = any unit order other than hold (a
 * zero-step move is trivial).
 */
export function duelParticipationTicks(tap: { ticks: readonly DuelTapTick[] }, seat: 'A' | 'B'): ParticipationTick[] {
  const out: ParticipationTick[] = [];
  for (const k of tap.ticks) {
    if (!k.start.units.some((u) => u.owner === seat && u.hp > 0)) continue;
    const kinds: ParticipationKind[] = [];
    let trivial = 0;
    for (const a of k.actions[seat] ?? []) {
      if (a.verb === 'hold' || (a.verb === 'move' && (a.steps ?? []).length === 0)) trivial++;
      else if (a.verb === 'move' || a.verb === 'attack') kinds.push(a.verb);
    }
    out.push({ t: k.t, kinds, trivial });
  }
  return out;
}

export function computeGridVerdicts(rec: EpisodeRecord): { verdicts: OracleVerdict[]; budget: BudgetCounters; replayHash: string } {
  const tap = tapDuel(rec);
  const seat = rec.targetSeat as 'A' | 'B';
  const opp = seat === 'A' ? 'B' : 'A';
  const final = tap.final;
  const verdicts: OracleVerdict[] = [];

  {
    const id = 'grid_tactics.outcome';
    const measure = { terminal_tick: rec.terminal.ticks, score: final.scores[seat], opponent_score: final.scores[opp] };
    const o = rec.terminal.outcome;
    if (o === 'win') verdicts.push(pass(id, seat, { measure }));
    else
      verdicts.push(
        fail(id, seat, o === 'draw' ? 'note' : 'warning', {
          measure, ticks: [Math.max(0, rec.terminal.ticks - 1)], code: `duel_${o}`,
          message: `The duel against the house bot ended in ${o} (${rec.terminal.reason ?? 'n/a'}) at tick ${rec.terminal.ticks}.`,
        }),
      );
  }
  {
    const id = 'grid_tactics.token_efficiency';
    const spent = final.spent[seat];
    if (spent === 0) verdicts.push(notAssessed(id, seat, 'insufficient_samples', { measure: { tokens_spent: 0 } }));
    else verdicts.push(pass(id, seat, { measure: { points_per_token: final.scores[seat] / spent, tokens_spent: spent, score: final.scores[seat] } }));
  }

  const ticks: TickFacts[] = tap.ticks.map((k) => {
    const acts = k.actions[seat];
    const truncated = k.events.filter((e) => e.type === 'move_truncated' && String(e.unit).startsWith(`${seat}-`)).length;
    return { t: k.t, events: k.events, submitted: acts.length, truncated };
  });
  const shared: SharedInputs = {
    rec,
    seat,
    targets: [seat],
    ticks,
    coercionOwner: (e) => (e.player == null ? null : String(e.player)),
    tokensSpent: final.spent[seat],
    tokensAllowance: tierOf(rec.tier).actionAllowance,
  };
  verdicts.push(budgetViolation(shared), illegalActionRate(shared), participation(seat, duelParticipationTicks(tap, seat)), replayIntegrity(rec, seat, tap));
  if (verdicts.map((v) => v.oracleId).join() !== GRID_ORACLE_CATALOG.join()) throw new Error('grid_tactics: oracle catalog order drifted');
  return { verdicts, budget: budgetCounters(shared), replayHash: tap.replayHash };
}

/**
 * Run-level `grid_tactics.win_rate` (for the reporter, B3): pass iff wins/n ≥ 0.5
 * with n ≥ 6 and both sides played; not_assessed below 6 episodes.
 */
export function gridWinRate(episodes: readonly { outcome: Outcome; seat: 'A' | 'B' }[]): OracleVerdict {
  const id = 'grid_tactics.win_rate';
  const n = episodes.length;
  const wins = episodes.filter((e) => e.outcome === 'win').length;
  const sides = new Set(episodes.map((e) => e.seat)).size;
  const thresholds = { pass_min: GRID_DIALS.winRatePassMin, min_episodes: GRID_DIALS.winRateMinEpisodes };
  const measure = { win_rate: n ? wins / n : 0, wins, episodes: n };
  if (n < GRID_DIALS.winRateMinEpisodes || sides < 2) return notAssessed(id, 'A', 'insufficient_samples', { measure, thresholds });
  if (wins / n >= GRID_DIALS.winRatePassMin) return pass(id, 'A', { measure, thresholds });
  return fail(id, 'A', 'warning', {
    measure, thresholds, code: 'win_rate_low',
    message: `The target won ${wins} of ${n} duels against the house bot.`,
  });
}
