/**
 * House bot — a scripted, difficulty-tiered backfill policy.
 *
 * Matchmaking backfills empty lobbies with a house bot so tickets always fill
 * (openapi.yaml POST /v1/queue). This is that bot. Difficulty is a heuristic-
 * quality dial — search-quality flags on the shared engine — NEVER a model
 * (Pillar 9 / ADDENDUM-001):
 *   • bronze — greedy: attacks anything in range, walks at the nearest objective,
 *     clumps, no RPS. About as strong as the reflex reference (the "beatable" bot).
 *   • silver — RPS-aware trades + role-based objective spread; no fog memory.
 *   • gold   — the full hunter heuristic (memory + predictive fire + kiting).
 *
 * Exposed two ways: `createHouseBot(difficulty)` for a fresh tiered instance, and
 * a plain ready-to-use `policy(obs) => action` (silver) the arena/demo can drop in.
 */
import { createHeuristicPolicy, DIFFICULTY, type Difficulty } from '../lib/heuristic.ts';
import type { Policy } from '../lib/grid.ts';

export type { Difficulty } from '../lib/heuristic.ts';

/** Build a house bot at the given difficulty tier (default 'silver'). */
export function createHouseBot(difficulty: Difficulty = 'silver'): Policy {
  return createHeuristicPolicy(DIFFICULTY[difficulty]);
}

/** A plain, ready-to-use backfill policy (silver tier). */
export const policy: Policy = createHouseBot('silver');
