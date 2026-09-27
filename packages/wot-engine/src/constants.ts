/**
 * Static, normative constants for Grid Tactics v1 (A1 §1–§4). All values are
 * the v1 / Core-league defaults; every `[DIAL]` is captured in DEFAULT_CONFIG.
 */

import type { Cell, MatchConfig, Player, UnitType } from './types.ts';

export const BOARD_SIZE = 9; // 9x9, x,y in [0,8]

/** Per-type unit stats (A1 §2 roster). */
export interface UnitStats {
  hp: number;
  move: number; // cells/tick (max step-list length)
  range: number; // attack range (Chebyshev)
  damage: number;
  vision: number; // Chebyshev
  meleeCounter: boolean;
}

export const ROSTER: Record<UnitType, UnitStats> = {
  scout: { hp: 3, move: 2, range: 1, damage: 1, vision: 3, meleeCounter: false },
  lancer: { hp: 6, move: 2, range: 1, damage: 4, vision: 2, meleeCounter: false },
  archer: { hp: 3, move: 1, range: 2, damage: 2, vision: 2, meleeCounter: false },
  guard: { hp: 10, move: 1, range: 1, damage: 3, vision: 1, meleeCounter: true },
};

/** Deterministic unit ordering used wherever iteration order must be fixed. */
export const UNIT_TYPES_ORDER: UnitType[] = ['archer', 'guard', 'lancer', 'scout'];

/** Spawn cells, 180deg-symmetric about (4,4) (A1 §1.5). */
export const SPAWNS: Record<Player, Record<UnitType, Cell>> = {
  A: {
    guard: [4, 0],
    archer: [2, 0],
    lancer: [6, 0],
    scout: [4, 1],
  },
  B: {
    guard: [4, 8],
    archer: [6, 8],
    lancer: [2, 8],
    scout: [4, 7],
  },
};

export interface ObjectiveDef {
  id: 'nexus' | 'relay_w' | 'relay_e';
  cell: Cell;
  points: number;
}

/** The three midline objectives (A1 §1.3). Order is canonical (nexus, W, E). */
export const OBJECTIVES: ObjectiveDef[] = [
  { id: 'nexus', cell: [4, 4], points: 2 },
  { id: 'relay_w', cell: [2, 4], points: 1 },
  { id: 'relay_e', cell: [6, 4], points: 1 },
];

/** Token costs (A1 §4.1). Canonical server-side; the client never declares cost. */
export const COST_MOVE_PER_STEP = 1;
export const COST_ATTACK = 2;
export const COST_HOLD = 0;

/** v1 / Core-league defaults (every A1 `[DIAL]`). */
export const DEFAULT_CONFIG: MatchConfig = {
  ascensionTarget: 100,
  tickCap: 120,
  collapseStart: 80,
  collapseInterval: 10,
  allowance: 240,
  refundRate: 0.5,
};

/** Number of obstacle cells (A1 §1.4). */
export const OBSTACLE_COUNT = 8;
