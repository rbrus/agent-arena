/**
 * The canonical tick-0 raid state for (scenario, seed, tier), shared by live
 * episodes and every re-simulation. The tier enters ONLY via `config.allowance`
 * (arena-scenarios.md §3.2): at Core the config equals RAID_CONFIGS[boss], so the
 * initial state hash is the one the frozen anchors start from.
 */

import { createInitialRaidState, referenceSquadSpec, type RaidState } from 'wot-engine';
import { BOSS_OF } from './references.ts';
import { tierOf } from './tiers.ts';
import type { RaidScenarioId, TierId } from './types.ts';

export function initialRaidState(scenario: RaidScenarioId, seed: number, tier: TierId): RaidState {
  return createInitialRaidState(seed, BOSS_OF[scenario], referenceSquadSpec(), {
    config: { allowance: tierOf(tier).actionAllowance },
  });
}
