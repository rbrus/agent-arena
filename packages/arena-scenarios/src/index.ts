/**
 * arena-scenarios — the Scenario interface (docs/design/arena-scenarios.md §4)
 * over the UNMODIFIED wot-engine: the Grid Tactics duel and the six
 * failure-mode encounters as evaluations. Pure: no I/O on a per-tick path, no
 * clock, no Math.random. The sim is the spec.
 */

export type * from './types.ts';
export { BUDGET_TIERS, TIER_IDS, tierOf, HARD_MISS_FORFEIT, TICK_CAP, MAX_INBOUND_FRAME_BYTES } from './tiers.ts';
export { blindReadingId, blindAddId, assertBlindingKey, newBlindingKey } from './blinding.ts';
export { egressFromInternal, egressReadings, peerReports, MAX_REAL_HAZARD_LEAD, type MemberView, type EgressReading, type PeerReport } from './egress.ts';
export { RaidScenario, RAID_SCENARIO_VERSION, PHANTOM_SALT, type EvalRaidObservationBody, type RaidActionPayload } from './raid-scenario.ts';
export { GridTacticsScenario, GRID_SCENARIO_VERSION, NONCE_PLACEHOLDER, HOUSE_BOT_REF, type DuelActionPayload } from './grid-scenario.ts';
export { initialRaidState } from './raid-state.ts';
export { initialDuelState } from './duel-state.ts';
export {
  BOSS_OF,
  REFERENCE,
  canonicalMemberActions,
  internalShapeFromEgress,
  egressSquadDriver,
  egressPolicyFor,
  egressCredulousSquad,
  egressNaiveSquad,
  dissentFirst,
  corroboratedFirst,
  lockOrderDiscipline,
  houseBot,
  reflexDriver,
  nullDriver,
  type NamedPolicy,
  type DuelPolicy,
} from './references.ts';
export { parseMemberPayload, parseSquadPayload, parseDuelPayload } from './submission.ts';
export { computeRaidVerdicts, deliveredReadings, raidParticipationTicks, tapRaid, RAID_DIALS, RAID_ORACLE_CATALOG, type RaidTap, type RaidTapTick } from './oracles/raid.ts';
export { computeGridVerdicts, duelParticipationTicks, tapDuel, gridWinRate, GRID_DIALS, GRID_ORACLE_CATALOG } from './oracles/grid.ts';
export { SHARED_DIALS, budgetCounters, participation, type BudgetCounters, type ParticipationKind, type ParticipationTick } from './oracles/shared.ts';
export { toEpisodeResult, toContractVerdict, computeVerdicts, type EpisodeResultJson, type ContractVerdict } from './episode-result.ts';
export {
  evalRaidObservationFrame,
  duelObservationFrame,
  evalEpisodeEndFrame,
  parseEvalRaidActionFrame,
  parseDuelActionFrame,
  PROTOCOL_VERSION,
  type Envelope,
  type Expectation,
} from './edge.ts';
export { trajectoryClass, effectiveEpisodes } from './trajectory.ts';
export { SCENARIO_IDS, RAID_SCENARIO_IDS, createScenario, scenarioModule, verifyRecord } from './registry.ts';
export { runEpisode, runToTerminal } from './run.ts';
export { evalValidators, validateRaidActions, validateDuelUnits } from './contracts.ts';
export { SELF_TESTS, GATE_SEEDS_BYZANTINE, anchorFor, type AnchorKey, type FrozenAnchor } from './anchors.ts';
export {
  redrive,
  targetDriverOf,
  targetPayloadAt,
  targetDriverFromRunSpecTarget,
  RedriveDriverMismatchError,
  IN_PROCESS_TARGET_PREFIX,
  type DecisionTrace,
  type RedriveOptions,
} from './redrive.ts';
export {
  structuralViolations,
  differentialViolations,
  keyIndependenceViolations,
  truthVariants,
  hiddenMembersOf,
  CLASS_PREFIX_RE,
  type EgressFn,
} from './leak-harness.ts';

// ---- Phase 8 B3b: diplomacy_standard (src/diplomacy/). Additive.
export { DiplomacyScenario, DIPLOMACY_SCENARIO_VERSION, DIPLOMACY_TICK_CAP, outcomeOf as dipOutcomeOf, secretCommitment as dipSecretCommitment } from './diplomacy/diplomacy-scenario.ts';
export {
  DIP_FILLS,
  DIP_GOLDEN_TABLES,
  DIP_GOLDEN_SEED,
  DIP_GOLDEN_HORIZON,
  DIP_DEFAULT_HORIZON,
  DIP_MAX_HORIZON,
  DIP_POWERS,
  resolveSeat as resolveDipSeat,
  rosterFor as dipRosterFor,
  profileOf as dipProfileOf,
} from './diplomacy/tables.ts';
export {
  buildWireObservation,
  toEngineAction as dipToEngineAction,
  engineActionToWire as dipEngineActionToWire,
  wireOrderToEngine,
  pressRejectCode,
  orderFeedback as dipOrderFeedback,
  cid as dipContractId,
  eid as dipEngineId,
  DIP_MAX_INBOUND_FRAME_BYTES,
  type DiplomacyObservationBody,
  type DiplomacyActionPayload,
  type OrderFeedback,
} from './diplomacy/wire.ts';
export { diplomacyObservationFrame, diplomacyEpisodeEndFrame, parseDiplomacyActionFrame, DIP_PROTOCOL_VERSION, type DipEnvelope, type DipExpectation } from './diplomacy/edge.ts';
export {
  computeDipVerdicts,
  resimDipRecord,
  contractEvaluationHash,
  isDiplomacyRecord,
  DIPLOMACY_ORACLE_CATALOG,
  type DipVerdictResult,
} from './diplomacy/verdicts.ts';
export { toDipEpisodeResult, engagementOf as dipEngagementOf } from './diplomacy/result.ts';
export { dipAnchorFor, dipSelfTests, dipPolicy, DIP_GOLDEN_SEAT, type DipAnchor, type DipAnchorKey } from './diplomacy/anchors.ts';
export { dipValidators } from './diplomacy/contracts.ts';
export type { DipFill, DipGoldenTable, DipSeatRoster, DipSeatKind } from './diplomacy/record.ts';
