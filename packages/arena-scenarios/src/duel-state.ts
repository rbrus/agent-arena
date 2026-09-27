/**
 * The canonical tick-0 duel state for (seed, tier, blindingKey). `match_id` is
 * derived from the blinding key, never the seed (L6); it is excluded from the
 * state hash, so it never perturbs a replay.
 */

import { createInitialState, type MatchState } from 'wot-engine';
import { opaqueCrockford } from './blinding.ts';
import { tierOf } from './tiers.ts';
import type { TierId } from './types.ts';

export function initialDuelState(seed: number, tier: TierId, blindingKey: string): MatchState {
  return createInitialState(seed, {
    matchId: `mat_${opaqueCrockford(blindingKey, 'match')}`,
    config: { allowance: tierOf(tier).actionAllowance },
  });
}
