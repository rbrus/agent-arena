/**
 * Diplomacy adjudicator (Phase 8, ADR-002): clean-room, DATC-validated,
 * pure and deterministic. See ./README.md and docs/design/diplomacy-adjudicator.md.
 * Names are prefixed or Diplomacy-specific so the flat re-export from
 * wot-engine/src/index.ts cannot collide with Grid Tactics / raid exports.
 */

export { POWERS } from './types.ts';
export type {
  Power,
  ProvinceId,
  CoastTag,
  NodeId,
  Season,
  PhaseKind,
  PhaseId,
  ProvinceDef,
  Dislodged,
  DipState,
  RawLoc,
  RawOrder,
  Order as DipOrder,
  ParseError as DipParseError,
  ParseErrorCode as DipParseErrorCode,
  IllegalReason as DipIllegalReason,
  OrderReport as DipOrderReport,
  LegalizeResult as DipLegalizeResult,
  Submissions as DipSubmissions,
  OrderResult as DipOrderResult,
  DipEvent,
  PhaseOutcome as DipPhaseOutcome,
} from './types.ts';
export { MAP, MAP_DIGEST, armyNeighbours, fleetNeighbours, reach, unionDistance, provinceOf, canArmyOccupy, canFleetOccupy } from './map.ts';
export { parseOrder, rawFromJson, isParseError, MAX_ORDERS, MAX_ORDER_CHARS } from './parse.ts';
export { formatRaw, formatOrder } from './orders.ts';
export { legalize as legalizeDip } from './legalize.ts';
export { adjudicate as adjudicateDip, initialState as dipInitialState, assertInvariants as assertDipInvariants, phaseId as dipPhaseId, RULESET as DIP_RULESET } from './state.ts';
export { canonicalizeDip, stateHash as dipStateHash, ordersDigest, genesisHash as dipGenesisHash, chainStart as dipChainStart, chainStep as dipChainStep } from './hash.ts';
export { replayDip, type DipReplay } from './simulate.ts';

// ---- Phase 8 B2b: scenario layer (press, observation, terminal, game loop). Additive.
export {
  PRESS_QUOTAS as DIP_PRESS_QUOTAS,
  POWER_ABBR as DIP_POWER_ABBR,
  sanitizePressText,
  codewordFor as dipCodewordFor,
  settleClause as dipSettleClause,
  transcriptGenesis as dipTranscriptGenesis,
  transcriptStep as dipTranscriptStep,
  evaluationHash as dipEvaluationHash,
  clauseStatus as dipClauseStatus,
  contractClauseStatus as dipContractClauseStatus,
  contractSettlementStatus as dipContractSettlementStatus,
  commitmentEnded as dipCommitmentEnded,
  type ContractClauseStatus as DipContractClauseStatus,
  type EvalClass as DipEvalClass,
  type PressQuotas as DipPressQuotas,
  type PressIn as DipPressIn,
  type Recipients as DipRecipients,
  type PressMove as DipPressMove,
  type Clause as DipClause,
  type OfferTerms as DipOfferTerms,
  type DeliveredMessage as DipDeliveredMessage,
  type Offer as DipOffer,
  type Commitment as DipCommitment,
  type ClauseStatus as DipClauseStatus,
  type IntentIn as DipIntentIn,
  type IntentVersion as DipIntentVersion,
  type Reject as DipReject,
  type RejectCode as DipRejectCode,
  type PressState as DipPressState,
  // Phase 8 B3a: shared limits, stable reject codes, the signature-mode check, phase arithmetic.
  DIP_LIMITS,
  PRESS_REJECT_CODES as DIP_PRESS_REJECT_CODES,
  SIG_MODES as DIP_SIG_MODES,
  isSigMode as isDipSigMode,
  movementIndex as dipMovementIndex,
  movementPhaseAt as dipMovementPhaseAt,
  type PressRejectCode as DipPressRejectCode,
  type SigMode as DipSigMode,
} from './press.ts';
export { checkTerminal as dipCheckTerminal, SOLO_CENTRES as DIP_SOLO_CENTRES, type DipTerminal, type DipStanding } from './terminal.ts';
export { buildDipObservation, canonicalObservation as canonicalDipObservation, type DipObservation, type DipProjection, type DipStepKind } from './observation.ts';
export {
  DIP_SCENARIO_VERSION,
  dipInit,
  dipAct,
  dipTick,
  dipMiss,
  dipForfeit,
  dipObserve,
  dipResult,
  dipEvaluate,
  resimulateDip,
  settledSubmissions as dipSettledSubmissions,
  seatPowers as dipSeatPowers,
  projectForPower as dipProjectForPower,
  type DipConfig,
  type DipAction,
  type DipEpisode,
  type DipStep,
  type PhaseRecord as DipPhaseRecord,
  type TickInput as DipTickInput,
  type DipResult,
  type DipOracleHook,
} from './scenario.ts';

// ---- Phase 8 B4/B5: the six oracles and the scripted reference agents. Additive.
// Namespaced so the flat re-export from wot-engine/src/index.ts cannot collide; the most
// used entry points are also exported under Diplomacy-prefixed names. The test-only
// `collude-with` fixture is deliberately not exported.
export * as dipOracles from './oracles/index.ts';
export * as dipReference from './reference/index.ts';
export {
  evaluateDiplomacy,
  diplomacyOracleHook,
  episodeValidity as dipEpisodeValidity,
  ORACLE as DIP_ORACLE,
  ORACLE_ORDER as DIP_ORACLE_ORDER,
  type DipVerdict,
  type DipEvalContext,
  type Canary as DipCanary,
  type SeatInfo as DipSeatInfo,
} from './oracles/index.ts';
export {
  houseDiplomat,
  robustDiplomat,
  credulousDiplomat,
  injector as dipInjector,
  injectorPlan as dipInjectorPlan,
  runTable as runDipTable,
  rebuildRegistry as rebuildDipRegistry,
  type SeatSpec as DipSeatSpec,
  type TableSpec as DipTableSpec,
} from './reference/index.ts';
// Phase 8 B3a: the reference runner's seat → agent setup and its liveness rule, for the
// transport and the Phase 7 scenario wrapper (agents act only while they hold a unit or a centre).
export { agentFor as dipAgentFor, type Agent as DipTableAgent } from './reference/runner.ts';
export { alive as dipAgentAlive } from './reference/board-view.ts';
