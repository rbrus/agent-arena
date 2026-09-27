/**
 * Initial-state construction + deep clone (A1 §1–§3). Pure: given a seed the
 * board, obstacles, and both mirrored squads are fully determined.
 */

import { generateObstacles } from './board.ts';
import { DEFAULT_CONFIG, ROSTER, SPAWNS, UNIT_TYPES_ORDER } from './constants.ts';
import type { MatchConfig, MatchState, Player, Unit } from './types.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Deterministic placeholder match_id (`mat_` + 26 Crockford base32 chars) for
 * standalone engine use, so `buildObservation` output validates against the
 * contract even without the arena. The arena always injects a real `mat_…` id.
 */
export function deterministicMatchId(seed: number): string {
  let n = (seed >>> 0) || 1;
  let s = '';
  for (let i = 0; i < 26; i++) {
    s += CROCKFORD[n % 32];
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
  }
  return `mat_${s}`;
}

export interface CreateInitialStateOptions {
  matchId?: string;
  config?: Partial<MatchConfig>;
}

/** Build the tick-0 authoritative state for a match (A1 §1–§3). */
export function createInitialState(seed: number, opts: CreateInitialStateOptions = {}): MatchState {
  const config: MatchConfig = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const obstacles = generateObstacles(seed);

  const units: Unit[] = [];
  for (const owner of ['A', 'B'] as Player[]) {
    for (const type of UNIT_TYPES_ORDER) {
      const [x, y] = SPAWNS[owner][type];
      units.push({
        unitId: `${owner}-${type}`,
        owner,
        type,
        x,
        y,
        hp: ROSTER[type].hp,
      });
    }
  }

  return {
    matchId: opts.matchId ?? deterministicMatchId(seed),
    seed,
    tick: 0,
    obstacles,
    units,
    scores: { A: 0, B: 0 },
    remaining: { A: config.allowance, B: config.allowance },
    spent: { A: 0, B: 0 },
    corruptedRings: [],
    config,
    events: [],
  };
}

/** Deep clone of the mutable parts of a state (obstacles/config are shared: immutable). */
export function cloneState(s: MatchState): MatchState {
  return {
    matchId: s.matchId,
    seed: s.seed,
    tick: s.tick,
    obstacles: s.obstacles,
    units: s.units.map((u) => ({ ...u })),
    scores: { ...s.scores },
    remaining: { ...s.remaining },
    spent: { ...s.spent },
    corruptedRings: [...s.corruptedRings],
    config: s.config,
    events: [],
  };
}
