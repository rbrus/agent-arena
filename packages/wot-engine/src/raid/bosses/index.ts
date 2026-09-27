/**
 * Boss REGISTRY + catalog (failure-modes-pillar.md §2). Every failure-mode boss
 * is a `BossModule` — data (`descriptor`) + up to three pure hooks (`policy`,
 * `projectObservation`, `applyChannelMechanics`). `bossPolicy(state)` and the
 * observation/resolve pipelines dispatch through `BOSS_MODULES`; adding a boss is
 * appending one module (never a schema rewrite). The two shipped bosses fold in
 * as modules with zero behaviour change.
 */

import type { BossAction, BossId, RaidState } from '../types.ts';
import { hallucinatorModule } from './hallucinator.ts';
import { overfitModule } from './overfit.ts';
import { byzantineModule } from './byzantine.ts';
import { deadlockModule } from './deadlock.ts';
import { splitBrainModule } from './splitbrain.ts';
import { latencyModule } from './latency.ts';
import type { BossDescriptor, BossModule, BossModuleMap } from './registry.ts';

/** The registered failure-mode bosses, keyed by id. */
export const BOSS_MODULES: BossModuleMap = {
  the_hallucinator: hallucinatorModule,
  the_overfit: overfitModule,
  the_byzantine: byzantineModule,
  deadlock: deadlockModule,
  split_brain: splitBrainModule,
  the_latency: latencyModule,
};

/** The module for a boss id (its policy + hooks). */
export const bossModule = (id: BossId): BossModule => BOSS_MODULES[id];

/** The deterministic scripted boss action for the current tick (Pillar 9). */
export function bossPolicy(state: RaidState): BossAction {
  return BOSS_MODULES[state.bossId].policy(state);
}

/** The catalog descriptors, derived from the registry (contracts BossDescriptor). */
export const BOSS_CATALOG: Record<BossId, BossDescriptor> = Object.fromEntries(
  (Object.keys(BOSS_MODULES) as BossId[]).map((id) => [id, BOSS_MODULES[id].descriptor]),
) as Record<BossId, BossDescriptor>;

export type {
  BossDescriptor,
  BossModule,
  ObservationProjection,
  ChannelOutcome,
  ChannelCtx,
  FailureChannel,
} from './registry.ts';
export { hallucinatorPolicy } from './hallucinator.ts';
export { overfitPolicy } from './overfit.ts';
export { byzantinePolicy, groundedNode, falseNode, byzantineFaulty } from './byzantine.ts';
export { deadlockPolicy, deadlockLocks, lockHolds, nextLockRank, locksRequired } from './deadlock.ts';
export { splitBrainPolicy, partitionWindow, partitionGroup, coreCell } from './splitbrain.ts';
export { latencyPolicy, latencyLiveCell, latencyDelay, latencyObservedCell } from './latency.ts';
