/**
 * Per-unit legalization with coerce-to-Hold (A1 §4.2, §5.1). Illegal or
 * over-budget unit actions become Hold (never a turn forfeit); what was coerced
 * is reported for the `ack.rejected_units` field. Pure + deterministic.
 *
 * This is the single source of truth for legality + charging, shared by the
 * public `legalizeAction` (arena ack preview) and `resolveTick` (Stage 1) so
 * the two can never disagree.
 */

import { cellsInRing, cheb, DIR_DELTA, key, onBoard, ring } from './board.ts';
import { COST_ATTACK, COST_MOVE_PER_STEP, ROSTER } from './constants.ts';
import type {
  Cell,
  Coercion,
  Dir,
  LegalizeResult,
  MatchState,
  Player,
  Unit,
  UnitAction,
} from './types.ts';

/** Normalized executable instruction (post-truncation / post-coercion). */
export type ExecUnit =
  | { kind: 'hold'; unit: Unit }
  | {
      kind: 'move';
      unit: Unit;
      steps: Dir[];
      truncated: boolean;
      truncReason?: 'edge' | 'obstacle' | 'collapse';
      stoppedAt?: Cell;
    }
  | { kind: 'attack'; unit: Unit; target: Cell };

export interface LegalizeInternal {
  exec: ExecUnit[];
  coercions: Coercion[];
  tokenSpend: number;
}

/** Set of impassable cells this tick: obstacles ∪ currently-corrupted cells. */
export function impassableSet(state: MatchState): Set<string> {
  const set = new Set<string>();
  for (const [x, y] of state.obstacles) set.add(key(x, y));
  for (const r of state.corruptedRings) {
    for (const [x, y] of cellsInRing(r)) set.add(key(x, y));
  }
  return set;
}

/**
 * Truncate a move step-list left-to-right from the unit's cell (A1 §4.2):
 * the first step leaving the board or entering an impassable cell truncates.
 */
export function truncateSteps(
  state: MatchState,
  unit: Unit,
  steps: Dir[],
): { steps: Dir[]; truncated: boolean; reason?: 'edge' | 'obstacle' | 'collapse'; stoppedAt: Cell } {
  const blocked = impassableSet(state);
  let x = unit.x;
  let y = unit.y;
  const legal: Dir[] = [];
  let truncated = false;
  let reason: 'edge' | 'obstacle' | 'collapse' | undefined;
  for (const step of steps) {
    const [dx, dy] = DIR_DELTA[step];
    const nx = x + dx;
    const ny = y + dy;
    if (!onBoard(nx, ny)) {
      truncated = true;
      reason = 'edge';
      break;
    }
    const k = key(nx, ny);
    if (blocked.has(k)) {
      truncated = true;
      // Distinguish an obstacle from a collapse wall for the event log.
      reason = state.obstacles.some(([ox, oy]) => ox === nx && oy === ny)
        ? 'obstacle'
        : 'collapse';
      break;
    }
    legal.push(step);
    x = nx;
    y = ny;
  }
  return { steps: legal, truncated, reason, stoppedAt: [x, y] };
}

function findOwnUnit(state: MatchState, player: Player, unitId: string): Unit | undefined {
  return state.units.find((u) => u.unitId === unitId && u.owner === player && u.hp > 0);
}

/**
 * Legalize + charge one player's submitted action-set (deterministic). Actions
 * are charged in ascending unit_id order so affordability against the running
 * allowance is order-independent of the submission order (A1 §5.1).
 */
export function legalizeInternal(
  state: MatchState,
  player: Player,
  raw: UnitAction[],
): LegalizeInternal {
  const coercions: Coercion[] = [];
  const exec: ExecUnit[] = [];
  let remaining = state.remaining[player];
  let tokenSpend = 0;

  // Deterministic charge order; first occurrence of a unit_id wins (a duplicate
  // unit_id in one set is a schema_invalid frame reject at the edge, so by here
  // there are none — this is defensive).
  const seen = new Set<string>();
  const ordered = [...raw].sort((a, b) =>
    a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0,
  );

  for (const action of ordered) {
    if (seen.has(action.unit_id)) continue;
    seen.add(action.unit_id);

    const unit = findOwnUnit(state, player, action.unit_id);
    if (!unit) {
      coercions.push({
        unit_id: action.unit_id,
        reason: 'illegal_state',
        hint: 'unit does not exist, is dead, or is not owned by you',
      });
      continue;
    }

    if (action.verb === 'hold') {
      exec.push({ kind: 'hold', unit });
      continue;
    }

    if (action.verb === 'move') {
      const t = truncateSteps(state, unit, action.steps);
      const cost = t.steps.length * COST_MOVE_PER_STEP;
      if (cost > remaining) {
        coercions.push({
          unit_id: action.unit_id,
          reason: 'insufficient_tokens',
          hint: `move costs ${cost}; remaining allowance ${remaining} — unit held`,
        });
        exec.push({ kind: 'hold', unit });
        continue;
      }
      remaining -= cost;
      tokenSpend += cost;
      exec.push({
        kind: 'move',
        unit,
        steps: t.steps,
        truncated: t.truncated,
        truncReason: t.reason,
        stoppedAt: t.stoppedAt,
      });
      continue;
    }

    // attack
    const target = action.target;
    if (!onBoard(target[0], target[1])) {
      coercions.push({
        unit_id: action.unit_id,
        reason: 'off_board',
        hint: 'attack target is off the 9x9 board',
      });
      exec.push({ kind: 'hold', unit });
      continue;
    }
    const range = ROSTER[unit.type].range;
    if (cheb(unit.x, unit.y, target[0], target[1]) > range) {
      coercions.push({
        unit_id: action.unit_id,
        reason: 'out_of_range',
        hint: `target beyond attack range ${range} (Chebyshev)`,
      });
      exec.push({ kind: 'hold', unit });
      continue;
    }
    if (COST_ATTACK > remaining) {
      coercions.push({
        unit_id: action.unit_id,
        reason: 'insufficient_tokens',
        hint: `attack costs ${COST_ATTACK}; remaining allowance ${remaining} — unit held`,
      });
      exec.push({ kind: 'hold', unit });
      continue;
    }
    remaining -= COST_ATTACK;
    tokenSpend += COST_ATTACK;
    exec.push({ kind: 'attack', unit, target: [target[0], target[1]] });
  }

  return { exec, coercions, tokenSpend };
}

/** Map an ExecUnit back to a wire-shaped UnitAction (fully-truncated move → Hold). */
export function execToUnitAction(e: ExecUnit): UnitAction {
  if (e.kind === 'hold') return { unit_id: e.unit.unitId, verb: 'hold' };
  if (e.kind === 'attack') return { unit_id: e.unit.unitId, verb: 'attack', target: e.target };
  if (e.steps.length === 0) return { unit_id: e.unit.unitId, verb: 'hold' };
  return { unit_id: e.unit.unitId, verb: 'move', steps: e.steps };
}

/**
 * Public per-unit legality preview (A1 §5.1). Coerces illegal / over-budget
 * units to Hold and returns what was coerced (for `ack.rejected_units`) plus
 * the token cost this set will spend. `resolveTick` re-derives this internally,
 * so the ack and the resolution can never diverge.
 */
export function legalizeAction(
  state: MatchState,
  player: Player,
  raw: UnitAction[],
): LegalizeResult {
  const { exec, coercions, tokenSpend } = legalizeInternal(state, player, raw);
  return { units: exec.map(execToUnitAction), coercions, tokenSpend };
}

/** Ring index helper re-exported for callers building collapse convenience data. */
export { ring };
