/**
 * Core engine types for Grid Tactics v1 (docs/design/grid-tactics-v1.md).
 * All coordinates are integers; the origin (0,0) is bottom-left (South-West).
 */

export type Player = 'A' | 'B';
export type UnitType = 'scout' | 'lancer' | 'archer' | 'guard';
export type Dir = 'N' | 'E' | 'S' | 'W';
/** Board coordinate [x, y], x,y in [0,8]. */
export type Cell = [number, number];

/** Authoritative, server-only unit record. */
export interface Unit {
  unitId: string;
  owner: Player;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
}

// --- Action vocabulary (structurally identical to the wire `action.units[]`) ---
export interface HoldAction {
  unit_id: string;
  verb: 'hold';
}
export interface MoveAction {
  unit_id: string;
  verb: 'move';
  steps: Dir[];
}
export interface AttackAction {
  unit_id: string;
  verb: 'attack';
  target: Cell;
}
export type UnitAction = HoldAction | MoveAction | AttackAction;

/** Both players' submitted action-sets for one tick. */
export interface TickActions {
  A: UnitAction[];
  B: UnitAction[];
}

/** Per-unit coercion (illegal/over-budget action forced to Hold, A1 §5.1). */
export type CoercionReason =
  | 'illegal_type'
  | 'illegal_state'
  | 'out_of_range'
  | 'off_board'
  | 'insufficient_tokens';

export interface Coercion {
  unit_id: string;
  reason: CoercionReason;
  hint?: string;
}

export interface LegalizeResult {
  /** The per-unit actions that will actually execute (coerced units become Hold). */
  units: UnitAction[];
  /** What was coerced, for the `ack.rejected_units` field. */
  coercions: Coercion[];
  /** Token cost of the surviving move/attack actions this set will spend. */
  tokenSpend: number;
}

/** Tunable dials (A1 marks these `[DIAL]`); v1/Core defaults in constants.ts. */
export interface MatchConfig {
  ascensionTarget: number; // 100
  tickCap: number; // 120
  collapseStart: number; // 80
  collapseInterval: number; // 10
  allowance: number; // 240
  refundRate: number; // 0.5
}

/** An engine event (A1 §8.3). `tick` + monotonic `seq`; extra fields per type. */
export interface EngineEvent {
  tick: number;
  seq: number;
  type: string;
  [k: string]: unknown;
}

/** The full authoritative match state (server-only; never sent to an agent). */
export interface MatchState {
  matchId: string;
  seed: number;
  /** The tick that will be played NEXT (advances by 1 each resolveTick). */
  tick: number;
  obstacles: Cell[];
  units: Unit[];
  scores: Record<Player, number>;
  /** Token allowance REMAINING per player. */
  remaining: Record<Player, number>;
  /** Token allowance SPENT per player (for the timeout tiebreak + observation). */
  spent: Record<Player, number>;
  /** Corrupted rings (Fog Collapse), ascending. */
  corruptedRings: number[];
  config: MatchConfig;
  /** Events produced by the LAST resolveTick (empty on the initial state). Not hashed. */
  events: EngineEvent[];
}

export interface TerminalResult {
  over: boolean;
  winner?: Player | 'draw';
  reason?: 'ascension' | 'elimination' | 'timeout';
  /** Which rung of the timeout tiebreak ladder decided it (A1 §6.2). */
  tiebreak?: 'score' | 'surviving_hp' | 'tokens_spent' | 'draw';
}
