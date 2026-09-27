/**
 * wot-engine — the pure, deterministic, seeded, I/O-free Grid Tactics v1 state
 * machine (docs/design/grid-tactics-v1.md). "The sim is the spec."
 *
 * No `Date.now()`, no `Math.random()`, no I/O anywhere in this package: given
 * `(seed, per-tick action pairs)` the entire match — including every fog-
 * filtered observation and the state-hash chain — is fully determined.
 */

export { createInitialState, cloneState, deterministicMatchId } from './state.ts';
export type { CreateInitialStateOptions } from './state.ts';
export { resolveTick } from './resolve.ts';
export { buildObservation } from './observation.ts';
export { legalizeAction, impassableSet, truncateSteps } from './legalize.ts';
export { stateHash, foldHash, canonicalize } from './hash.ts';
export { isTerminal, evaluateState } from './terminal.ts';
export { resimulate, type ResimResult } from './simulate.ts';

export {
  BOARD_SIZE,
  ROSTER,
  SPAWNS,
  OBJECTIVES,
  DEFAULT_CONFIG,
  COST_MOVE_PER_STEP,
  COST_ATTACK,
  COST_HOLD,
  UNIT_TYPES_ORDER,
  OBSTACLE_COUNT,
  type UnitStats,
  type ObjectiveDef,
} from './constants.ts';

export {
  generateObstacles,
  cheb,
  ring,
  cellsInRing,
  rho,
  onBoard,
  DIR_DELTA,
} from './board.ts';

export { mulberry32, hash32 } from './rng.ts';

// Phase-4 raid engine (co-op squad-vs-boss; docs/design/raids-v1.md). Additive.
export * from './raid/index.ts';

export type {
  Player,
  UnitType,
  Dir,
  Cell,
  Unit,
  UnitAction,
  HoldAction,
  MoveAction,
  AttackAction,
  TickActions,
  Coercion,
  CoercionReason,
  LegalizeResult,
  MatchConfig,
  MatchState,
  EngineEvent,
  TerminalResult,
} from './types.ts';

// Phase-8 Diplomacy adjudicator (ADR-002; docs/design/diplomacy-adjudicator.md). Additive.
export * from './diplomacy/index.ts';
