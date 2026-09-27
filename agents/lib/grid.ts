/**
 * Grid Tactics helpers shared by the scripted policies.
 *
 * Pure geometry + the unit roster + the emergent rock-paper-scissors, all
 * transcribed from docs/design/grid-tactics-v1.md §1–§4. No I/O, no randomness,
 * no model calls (Pillar 9 / ADDENDUM-001 — these bots are deterministic
 * scripts). Types come from the generated `wot-contracts` wire models so the
 * policies can never drift from the contract.
 */
import type { Observation, Action } from 'wot-contracts';

export type Cell = [number, number];
export type Dir = 'N' | 'E' | 'S' | 'W';
export type UnitType = 'scout' | 'lancer' | 'archer' | 'guard';
/** One entry in an action-set's `units[]` (Hold | Move | Attack). */
export type UnitAction = Action['units'][number];
/** A scripted policy: an observation in, a full (echoing) action out. */
export type Policy = (obs: Observation) => Action;

/** N=+y, E=+x, S=-y, W=-x (grid-tactics-v1 §4.1). Origin (0,0) is bottom-left. */
export const STEP: Record<Dir, Cell> = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
export const DIRS: Dir[] = ['N', 'E', 'S', 'W'];

/** The three objective cells on the y=4 midline, with per-tick payout (§1.3). */
export const OBJECTIVES: { id: 'nexus' | 'relay_w' | 'relay_e'; cell: Cell; points: number }[] = [
  { id: 'nexus', cell: [4, 4], points: 2 },
  { id: 'relay_w', cell: [2, 4], points: 1 },
  { id: 'relay_e', cell: [6, 4], points: 1 },
];

export interface UnitStat {
  hp: number;
  speed: number; // cells/tick (max move-step-list length)
  range: number; // Chebyshev attack range
  damage: number;
  vision: number; // Chebyshev
}
/** The v1 roster (§2). Invariant used everywhere: vision >= range. */
export const UNIT_STATS: Record<UnitType, UnitStat> = {
  scout: { hp: 3, speed: 2, range: 1, damage: 1, vision: 3 },
  lancer: { hp: 6, speed: 2, range: 1, damage: 4, vision: 2 },
  archer: { hp: 3, speed: 1, range: 2, damage: 2, vision: 2 },
  guard: { hp: 10, speed: 1, range: 1, damage: 3, vision: 1 },
};

/**
 * Emergent RPS: Lancer > Archer > Guard > Lancer (§2.1). Scout is outside the
 * triangle and loses a straight fight to everything.
 */
export const BEATS: Record<UnitType, UnitType | null> = {
  lancer: 'archer',
  archer: 'guard',
  guard: 'lancer',
  scout: null,
};
/** True when `a` holds a favourable matchup over `b`. */
export const beats = (a: UnitType, b: UnitType): boolean => BEATS[a] === b;

export const cheb = (a: Cell, b: Cell): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
export const manh = (a: Cell, b: Cell): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
export const eq = (a: Cell, b: Cell): boolean => a[0] === b[0] && a[1] === b[1];
export const onBoard = (c: Cell): boolean => c[0] >= 0 && c[0] <= 8 && c[1] >= 0 && c[1] <= 8;
export const keyOf = (c: Cell): string => `${c[0]},${c[1]}`;

/** Typed action constructors (keep the tuple/union shapes honest for tsc). */
export const hold = (unit_id: string): UnitAction => ({ unit_id, verb: 'hold' });
export const move = (unit_id: string, steps: Dir[]): UnitAction => ({
  unit_id,
  verb: 'move',
  steps: steps.slice(0, 2) as [Dir] | [Dir, Dir],
});
export const attack = (unit_id: string, target: Cell): UnitAction => ({ unit_id, verb: 'attack', target });

/** Convenience-field readers (advisory hints the server ships in the observation). */
export const reachableOf = (obs: Observation, id: string): Cell[] => (obs.reachable?.[id] ?? []) as Cell[];
export const attacksOf = (obs: Observation, id: string): Cell[] => (obs.attacks?.[id] ?? []) as Cell[];

/**
 * Wrap an action-set into a full frame, echoing the observation's `turn_id` +
 * `nonce` + `match_id` (the anti-replay contract, asyncapi.yaml). Every policy
 * returns through here so the echo is impossible to forget.
 */
export function buildAction(obs: Observation, units: UnitAction[], thought?: string): Action {
  const action: Action = {
    t: 'action',
    protocol_version: '1.0',
    match_id: obs.match_id,
    turn_id: obs.turn_id,
    nonce: obs.nonce,
    units: units.slice(0, 4) as Action['units'],
  };
  if (thought) action.thought = thought;
  return action;
}

/** Greedy orthogonal directions from `from` toward `target`, up to `maxSteps`. */
export function greedyDirs(from: Cell, target: Cell, maxSteps: number): Dir[] {
  const dirs: Dir[] = [];
  let x = from[0];
  let y = from[1];
  for (let i = 0; i < maxSteps; i++) {
    const dx = target[0] - x;
    const dy = target[1] - y;
    if (dx === 0 && dy === 0) break;
    let dir: Dir;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) dir = dx > 0 ? 'E' : 'W';
    else if (dy !== 0) dir = dy > 0 ? 'N' : 'S';
    else dir = dx > 0 ? 'E' : 'W';
    dirs.push(dir);
    x += STEP[dir][0];
    y += STEP[dir][1];
  }
  return dirs;
}

/**
 * Build a legal move toward `target`, validated against `reachable` so the step
 * list never truncates or wastes a token on an obstacle/edge. Prefers the
 * longest legal prefix (fastest tempo) and falls back to the best single-step
 * neighbour. Returns null when no legal step makes progress.
 */
export function moveToward(obs: Observation, id: string, from: Cell, target: Cell, maxSteps: number): UnitAction | null {
  const dests = reachableOf(obs, id);
  if (dests.length === 0) return null;
  const dirs = greedyDirs(from, target, Math.max(1, maxSteps));
  for (let n = dirs.length; n >= 1; n--) {
    let cell: Cell = [from[0], from[1]];
    for (let i = 0; i < n; i++) cell = [cell[0] + STEP[dirs[i]][0], cell[1] + STEP[dirs[i]][1]];
    if (dests.some((d) => eq(d, cell))) return move(id, dirs.slice(0, n));
  }
  // Fallback: the reachable orthogonal neighbour that best reduces distance.
  let best: UnitAction | null = null;
  let bestD = cheb(from, target);
  for (const dir of DIRS) {
    const nc: Cell = [from[0] + STEP[dir][0], from[1] + STEP[dir][1]];
    if (!dests.some((d) => eq(d, nc))) continue;
    const d = cheb(nc, target);
    if (d < bestD) {
      bestD = d;
      best = move(id, [dir]);
    }
  }
  return best;
}

/**
 * Step to increase distance from `threat` (kiting), optionally biased toward a
 * fallback objective. Returns null when no reachable neighbour is safer.
 */
export function moveAway(obs: Observation, id: string, from: Cell, threat: Cell, prefer: Cell | null): UnitAction | null {
  const dests = reachableOf(obs, id);
  let best: UnitAction | null = null;
  let bestScore = 0; // must strictly increase distance to move
  for (const dir of DIRS) {
    const nc: Cell = [from[0] + STEP[dir][0], from[1] + STEP[dir][1]];
    if (!dests.some((d) => eq(d, nc))) continue;
    let score = cheb(nc, threat) - cheb(from, threat);
    if (prefer) score -= 0.1 * manh(nc, prefer);
    if (score > bestScore) {
      bestScore = score;
      best = move(id, [dir]);
    }
  }
  return best;
}
