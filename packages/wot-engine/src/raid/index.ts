/**
 * wot-engine/raid — the pure, deterministic, seeded co-op raid state machine
 * (docs/design/raids-v1.md). A DELTA on the duel engine: N squad members + 1
 * scripted boss, threat/aggro, downed/revive, and a corroboration observation
 * layer whose PHANTOM readings never enter the state hash. "The sim is the spec."
 */

export type {
  BossId,
  MemberId,
  RaidState,
  RaidBoss,
  RaidUnit,
  RaidAdd,
  ActiveHazard,
  RaidConfig,
  RaidTickActions,
  RaidUnitAction,
  RaidHold,
  RaidMove,
  RaidAttack,
  RaidRevive,
  RaidPing,
  BossAction,
  RaidTerminal,
  SquadSpec,
  FeatureCounts,
} from './types.ts';

export {
  createInitialRaidState,
  cloneRaidState,
  deterministicRaidId,
  type CreateRaidStateOptions,
} from './state.ts';
export { resolveRaidTick } from './resolve.ts';
export { canonicalizeRaid, raidStateHash } from './hash.ts';
export { isRaidTerminal } from './terminal.ts';
export { legalizeRaidMember, raidImpassableSet, type RaidLegalizeResult, type RaidExec } from './legalize.ts';
export {
  buildRaidObservation,
  readingsFor,
  type RaidObservation,
  type RaidReading,
  type RaidSquadView,
  type BuildRaidObservationOptions,
} from './observation.ts';
export {
  bossPolicy,
  bossModule,
  BOSS_MODULES,
  BOSS_CATALOG,
  type BossDescriptor,
  type BossModule,
  type ObservationProjection,
  type ChannelOutcome,
  type ChannelCtx,
  type FailureChannel,
  hallucinatorPolicy,
  overfitPolicy,
  byzantinePolicy,
  groundedNode,
  falseNode,
  byzantineFaulty,
  deadlockPolicy,
  deadlockLocks,
  lockHolds,
  nextLockRank,
  locksRequired,
  splitBrainPolicy,
  partitionWindow,
  partitionGroup,
  coreCell,
  latencyPolicy,
  latencyLiveCell,
  latencyDelay,
  latencyObservedCell,
} from './bosses/index.ts';
export { runRaid, resimulateRaid, runBossWithSquad, type RaidRunResult, type RaidResimResult } from './simulate.ts';
export {
  consensusSquad,
  naiveSquad,
  diverseSquad,
  greedySquad,
  bftQuorumSquad,
  credulousSquad,
  orderedLockSquad,
  greedyGrabSquad,
  quorumPrimarySquad,
  dualPrimarySquad,
  leadingSquad,
  staleReactSquad,
  type RaidSquadPolicy,
} from './reference-agents.ts';
export {
  ANCHORS,
  BOSS_FOOTPRINT,
  SQUAD_SPAWNS,
  RAID_CONFIGS,
  HALLUCINATOR_CONFIG,
  OVERFIT_CONFIG,
  BYZANTINE_CONFIG,
  DEADLOCK_CONFIG,
  SPLITBRAIN_CONFIG,
  LATENCY_CONFIG,
  LATENCY_DELAY,
  LATENCY_LIVE_CELLS,
  BYZANTINE_NODES,
  BYZANTINE_SHIELD,
  bftQuorum,
  bftFaultCount,
  DEADLOCK_LOCKS,
  DEADLOCK_DIALS,
  SPLITBRAIN_DIALS,
  REFERENCE_COMP,
  referenceSquadSpec,
  realMin,
  RAID_CLEAR_POT,
  RAID_FIRST_CLEAR,
  CONTRIB_W,
  COST_MOVE_PER_STEP as RAID_COST_MOVE,
  COST_ATTACK as RAID_COST_ATTACK,
  COST_REVIVE as RAID_COST_REVIVE,
} from './constants.ts';
export {
  aliveMembers,
  squadAlive,
  topThreat,
  unitOf,
  deliveredSubset,
} from './util.ts';
