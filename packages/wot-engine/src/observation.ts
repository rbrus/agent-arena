/**
 * `buildObservation` — the fog-of-war projection (A1 §7). THE #1 security
 * surface (threat-model §3). The frame is built by WHITELIST PROJECTION from
 * scratch: hidden enemy units are ABSENT (never present-but-null), and no byte
 * is derived from a cell outside V(P), an enemy outside V(P), or the opponent's
 * current-tick action. The public block (§7.4) is the only, fixed fog exception.
 */

import type { Observation } from 'wot-contracts';
import { cheb, DIR_DELTA, key, onBoard } from './board.ts';
import { OBJECTIVES, ROSTER } from './constants.ts';
import { impassableSet } from './legalize.ts';
import type { Cell, MatchState, Player, Unit, UnitType } from './types.ts';

interface UnitView {
  unit_id: string;
  type: UnitType;
  cell: Cell;
  hp: number;
  max_hp: number;
}

const toView = (u: Unit): UnitView => ({
  unit_id: u.unitId,
  type: u.type,
  cell: [u.x, u.y],
  hp: u.hp,
  max_hp: ROSTER[u.type].hp,
});

/** Is `cell` inside player P's visible set V(P)? (union of P units' vision squares) */
function isVisible(units: Unit[], player: Player, cx: number, cy: number): boolean {
  for (const u of units) {
    if (u.owner !== player) continue;
    if (cheb(u.x, u.y, cx, cy) <= ROSTER[u.type].vision) return true;
  }
  return false;
}

/** V(P): every cell within Chebyshev vision of at least one of P's living units. */
function visibleCells(units: Unit[], player: Player): Cell[] {
  const out: Cell[] = [];
  for (let x = 0; x < 9; x++) {
    for (let y = 0; y < 9; y++) {
      if (isVisible(units, player, x, y)) out.push([x, y]);
    }
  }
  return out;
}

/** Advisory legal move destinations for one unit (straight runs up to speed). */
function reachableFor(state: MatchState, unit: Unit): Cell[] {
  const blocked = impassableSet(state);
  const out: Cell[] = [];
  const seen = new Set<string>();
  const speed = ROSTER[unit.type].move;
  for (const dir of ['N', 'E', 'S', 'W'] as const) {
    const [dx, dy] = DIR_DELTA[dir];
    let x = unit.x;
    let y = unit.y;
    for (let step = 0; step < speed; step++) {
      x += dx;
      y += dy;
      if (!onBoard(x, y) || blocked.has(key(x, y))) break;
      const k = key(x, y);
      if (!seen.has(k)) {
        seen.add(k);
        out.push([x, y]);
      }
    }
  }
  return out.slice(0, 8);
}

/**
 * Build player P's fog-filtered observation for the given tick (A1 §7.6).
 * `turnId`, `nonce`, `deadlineMs`, `hardDeadlineMs` are supplied by the arena
 * (tick-synchronized emission; the nonce is unpredictable, anti-replay §7.5).
 */
export function buildObservation(
  state: MatchState,
  player: Player,
  turnId: number,
  nonce: string,
  deadlineMs: number,
  hardDeadlineMs?: number,
): Observation {
  const enemy = player === 'A' ? 'B' : 'A';
  const ownUnits = state.units.filter((u) => u.owner === player);

  // Whitelist: only enemies currently inside V(P). Hidden enemies are ABSENT.
  const enemyVisible = state.units
    .filter((u) => u.owner === enemy && isVisible(state.units, player, u.x, u.y))
    .map(toView);

  // Objective control is always public (bounded, symmetric fog exception §7.4).
  const objectives = OBJECTIVES.map((obj) => {
    const occ = state.units.find((u) => u.x === obj.cell[0] && u.y === obj.cell[1]);
    return {
      id: obj.id,
      cell: obj.cell,
      controller: (occ ? occ.owner : 'none') as Player | 'none',
    };
  });

  const ticksRemaining = Math.max(0, state.config.tickCap - state.tick);

  const corrupted = [...state.corruptedRings].sort((a, b) => a - b);
  const nextIndex = corrupted.length;
  const nextRingTick =
    nextIndex <= 3 ? state.config.collapseStart + nextIndex * state.config.collapseInterval : null;

  // Own vision footprint (fog-safe: derived only from P's own units).
  const vis = visibleCells(state.units, player);

  // Advisory convenience fields (all fog-safe by construction).
  const reachable: Record<string, Cell[]> = {};
  const attacks: Record<string, Cell[]> = {};
  for (const u of ownUnits) {
    reachable[u.unitId] = reachableFor(state, u);
    const range = ROSTER[u.type].range;
    const targets: Cell[] = [];
    for (const ev of enemyVisible) {
      if (cheb(u.x, u.y, ev.cell[0], ev.cell[1]) <= range) targets.push(ev.cell);
    }
    attacks[u.unitId] = targets.slice(0, 8);
  }

  const obs: Record<string, unknown> = {
    t: 'observation',
    protocol_version: '1.0',
    match_id: state.matchId,
    turn_id: turnId,
    nonce,
    deadline_ms: deadlineMs,
    phase: 'grid_tactics',
    you: {
      player_id: player,
      ascension_points: state.scores[player],
      action_tokens_remaining: state.remaining[player],
      action_tokens_spent: state.spent[player],
      units: ownUnits.map(toView),
    },
    enemy_visible: enemyVisible,
    objectives,
    scoreboard: {
      A: { points: state.scores.A, tokens_remaining: state.remaining.A },
      B: { points: state.scores.B, tokens_remaining: state.remaining.B },
      ticks_remaining: ticksRemaining,
    },
    collapse: {
      active: corrupted.length > 0,
      corrupted_rings: corrupted,
      next_ring_tick: nextRingTick,
    },
    map: { width: 9, height: 9, obstacles: state.obstacles },
    visible_cells: vis,
    reachable,
    attacks,
  };
  if (typeof hardDeadlineMs === 'number') obs.hard_deadline_ms = hardDeadlineMs;

  // The shape is built to satisfy the contract; the generated tuple types are
  // stricter than the runtime data, so we assert through unknown. The engine's
  // schema test validates every frame against the wot-contracts validator.
  return obs as unknown as Observation;
}
