/**
 * Per-member raid legalization with coerce-to-Hold (raids-v1 §6.2). Mirrors the
 * duel `legalize.ts`: illegal / over-budget actions become Hold (never a forfeit)
 * and what was coerced is reported. Adds the co-op verbs `revive` (legalized like
 * a range-1 attack against a DOWNED ally) and `ping` (free, never affects state).
 * Pure + deterministic; charge order is ascending unit_id.
 */

import { cellsInRing, cheb, DIR_DELTA, key, onBoard } from '../board.ts';
import { ROSTER } from '../constants.ts';
import type { Cell, Coercion, Dir } from '../types.ts';
import { COST_ATTACK, COST_MOVE_PER_STEP, COST_REVIVE } from './constants.ts';
import type { MemberId, RaidState, RaidUnit, RaidUnitAction } from './types.ts';

export type RaidExec =
  | { kind: 'hold'; unit: RaidUnit }
  | {
      kind: 'move';
      unit: RaidUnit;
      steps: Dir[];
      truncated: boolean;
      truncReason?: 'edge' | 'obstacle' | 'collapse';
    }
  | { kind: 'attack'; unit: RaidUnit; target: Cell }
  | { kind: 'revive'; unit: RaidUnit; target: MemberId };

export interface RaidLegalizeResult {
  exec: RaidExec[];
  coercions: Coercion[];
  tokenSpend: number;
}

/** Impassable cells for movement truncation: obstacles ∪ corrupted ∪ boss body. */
export function raidImpassableSet(state: RaidState): Set<string> {
  const set = new Set<string>();
  for (const [x, y] of state.obstacles) set.add(key(x, y));
  for (const r of state.corruptedRings) {
    for (const [x, y] of cellsInRing(r)) set.add(key(x, y));
  }
  for (const [x, y] of state.boss.footprint) set.add(key(x, y));
  return set;
}

/** Truncate a move step-list left-to-right (first blocked/off-board step stops it). */
function truncateSteps(
  state: RaidState,
  unit: RaidUnit,
  steps: Dir[],
): { steps: Dir[]; truncated: boolean; reason?: 'edge' | 'obstacle' | 'collapse' } {
  const blocked = raidImpassableSet(state);
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
    if (blocked.has(key(nx, ny))) {
      truncated = true;
      reason = state.obstacles.some(([ox, oy]) => ox === nx && oy === ny) ? 'obstacle' : 'collapse';
      break;
    }
    legal.push(step);
    x = nx;
    y = ny;
  }
  return { steps: legal, truncated, reason };
}

const livingActingUnit = (state: RaidState, memberId: MemberId): RaidUnit | undefined =>
  state.units.find((u) => u.memberId === memberId && !u.downed && u.hp > 0);

const downedUnit = (state: RaidState, memberId: MemberId): RaidUnit | undefined =>
  state.units.find((u) => u.memberId === memberId && u.downed);

/** Legalize + charge one member's submitted action-set for this tick. */
export function legalizeRaidMember(
  state: RaidState,
  memberId: MemberId,
  raw: RaidUnitAction[],
): RaidLegalizeResult {
  const coercions: Coercion[] = [];
  const exec: RaidExec[] = [];
  let remaining = state.remaining[memberId] ?? 0;
  let tokenSpend = 0;

  const unit = livingActingUnit(state, memberId);
  // A downed / dead / forfeited member: everything is coerced to Hold (§2.4).
  if (!unit) {
    return { exec, coercions, tokenSpend: 0 };
  }

  // Deterministic charge order; first occurrence of a unit_id wins.
  const seen = new Set<string>();
  const ordered = [...raw]
    .filter((a) => a.verb !== 'ping') // ping is free + never affects state (handled elsewhere)
    .sort((a, b) => {
      const ua = (a as { unit_id?: string }).unit_id ?? '';
      const ub = (b as { unit_id?: string }).unit_id ?? '';
      return ua < ub ? -1 : ua > ub ? 1 : 0;
    });

  for (const action of ordered) {
    const unitId = (action as { unit_id?: string }).unit_id ?? unit.unitId;
    if (seen.has(unitId)) continue;
    seen.add(unitId);

    // A member only controls its OWN single Avatar.
    if (unitId !== unit.unitId) {
      coercions.push({ unit_id: unitId, reason: 'illegal_state', hint: 'not your unit' });
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
        coercions.push({ unit_id: unitId, reason: 'insufficient_tokens', hint: 'move unaffordable' });
        exec.push({ kind: 'hold', unit });
        continue;
      }
      remaining -= cost;
      tokenSpend += cost;
      exec.push({ kind: 'move', unit, steps: t.steps, truncated: t.truncated, truncReason: t.reason });
      continue;
    }

    if (action.verb === 'attack') {
      const target = action.target;
      if (!onBoard(target[0], target[1])) {
        coercions.push({ unit_id: unitId, reason: 'off_board', hint: 'attack off board' });
        exec.push({ kind: 'hold', unit });
        continue;
      }
      const range = ROSTER[unit.type].range;
      if (cheb(unit.x, unit.y, target[0], target[1]) > range) {
        coercions.push({ unit_id: unitId, reason: 'out_of_range', hint: 'target beyond range' });
        exec.push({ kind: 'hold', unit });
        continue;
      }
      if (COST_ATTACK > remaining) {
        coercions.push({ unit_id: unitId, reason: 'insufficient_tokens', hint: 'attack unaffordable' });
        exec.push({ kind: 'hold', unit });
        continue;
      }
      remaining -= COST_ATTACK;
      tokenSpend += COST_ATTACK;
      exec.push({ kind: 'attack', unit, target: [target[0], target[1]] });
      continue;
    }

    // revive
    const targetMember = action.target_member;
    const target = downedUnit(state, targetMember);
    if (!target || target.forfeited) {
      coercions.push({ unit_id: unitId, reason: 'illegal_state', hint: 'target not a revivable downed ally' });
      exec.push({ kind: 'hold', unit });
      continue;
    }
    if (cheb(unit.x, unit.y, target.x, target.y) > 1) {
      coercions.push({ unit_id: unitId, reason: 'out_of_range', hint: 'downed ally not adjacent' });
      exec.push({ kind: 'hold', unit });
      continue;
    }
    if (COST_REVIVE > remaining) {
      coercions.push({ unit_id: unitId, reason: 'insufficient_tokens', hint: 'revive unaffordable' });
      exec.push({ kind: 'hold', unit });
      continue;
    }
    remaining -= COST_REVIVE;
    tokenSpend += COST_REVIVE;
    exec.push({ kind: 'revive', unit, target: targetMember });
  }

  return { exec, coercions, tokenSpend };
}
