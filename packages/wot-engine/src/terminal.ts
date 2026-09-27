/**
 * Win-condition evaluation (A1 §6.2) — checked by the arena at Stage 8 after
 * each resolveTick. Order: ascension → elimination → timeout. Pure.
 *
 * `state.tick` here is the NEXT tick to play (post-resolve), so after resolving
 * tick 119 it is 120 and the timeout (hard-cap) branch fires.
 */

import type { MatchState, Player, TerminalResult } from './types.ts';

function survivingHp(state: MatchState, player: Player): number {
  return state.units.filter((u) => u.owner === player).reduce((n, u) => n + u.hp, 0);
}

/** Deterministic tiebreak ladder: score → surviving HP → fewer tokens spent → draw. */
function ladder(state: MatchState): {
  winner: Player | 'draw';
  rung: 'score' | 'surviving_hp' | 'tokens_spent' | 'draw';
} {
  if (state.scores.A !== state.scores.B) {
    return { winner: state.scores.A > state.scores.B ? 'A' : 'B', rung: 'score' };
  }
  const hpA = survivingHp(state, 'A');
  const hpB = survivingHp(state, 'B');
  if (hpA !== hpB) return { winner: hpA > hpB ? 'A' : 'B', rung: 'surviving_hp' };
  if (state.spent.A !== state.spent.B) {
    // Fewer tokens spent wins (efficiency, A1 §6.2).
    return { winner: state.spent.A < state.spent.B ? 'A' : 'B', rung: 'tokens_spent' };
  }
  return { winner: 'draw', rung: 'draw' };
}

/** Evaluate terminal state per A1 §6.2. */
export function isTerminal(state: MatchState): TerminalResult {
  const { ascensionTarget, tickCap } = state.config;
  const scoreA = state.scores.A;
  const scoreB = state.scores.B;
  const livingA = state.units.filter((u) => u.owner === 'A').length;
  const livingB = state.units.filter((u) => u.owner === 'B').length;

  // 1. Ascension — first to the target. Simultaneous crossings: higher score,
  //    then the ladder.
  if (scoreA >= ascensionTarget || scoreB >= ascensionTarget) {
    const { winner } = ladder(state);
    return { over: true, winner, reason: 'ascension' };
  }

  // 2. Elimination — a player with 0 surviving units loses.
  if (livingA === 0 || livingB === 0) {
    let winner: Player | 'draw';
    if (livingA === 0 && livingB === 0) winner = ladder(state).winner;
    else winner = livingA === 0 ? 'B' : 'A';
    return { over: true, winner, reason: 'elimination' };
  }

  // 3. Timeout — hard cap reached; higher score (then the ladder) wins.
  if (state.tick >= tickCap) {
    const { winner, rung } = ladder(state);
    return { over: true, winner, reason: 'timeout', tiebreak: rung };
  }

  return { over: false };
}

/**
 * Optional deterministic position heuristic (used later by the Director / house
 * bot). Positive favours A. Not part of the authoritative sim.
 */
export function evaluateState(state: MatchState, player: Player): number {
  const enemy: Player = player === 'A' ? 'B' : 'A';
  const scoreTerm = (state.scores[player] - state.scores[enemy]) * 10;
  const hpTerm = survivingHp(state, player) - survivingHp(state, enemy);
  const unitTerm =
    (state.units.filter((u) => u.owner === player).length -
      state.units.filter((u) => u.owner === enemy).length) *
    5;
  return scoreTerm + hpTerm + unitTerm;
}
