/**
 * Board geometry: coordinates, Chebyshev distance, ring index, and the
 * seeded, deterministic obstacle generator (A1 §1.2, §1.4, §6.4).
 * Pure + integer-only; no I/O, no wall-clock, no ambient randomness.
 */

import { BOARD_SIZE, OBJECTIVES, OBSTACLE_COUNT, SPAWNS } from './constants.ts';
import { mulberry32 } from './rng.ts';
import type { Cell, Dir } from './types.ts';

export const DIR_DELTA: Record<Dir, [number, number]> = {
  N: [0, 1],
  E: [1, 0],
  S: [0, -1],
  W: [-1, 0],
};

export const key = (x: number, y: number): string => `${x},${y}`;
export const cellKey = (c: Cell): string => key(c[0], c[1]);

export const onBoard = (x: number, y: number): boolean =>
  x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;

/** Chebyshev distance (used for range + vision, A1 §1.2). */
export const cheb = (ax: number, ay: number, bx: number, by: number): number =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** 180deg rotation about the centre (4,4): rho(x,y) = (8-x, 8-y) (A1 §1.2). */
export const rho = (c: Cell): Cell => [BOARD_SIZE - 1 - c[0], BOARD_SIZE - 1 - c[1]];

/** Fog-Collapse ring index: min(x, 8-x, y, 8-y). ring 4 = the Nexus (A1 §6.4). */
export const ring = (x: number, y: number): number =>
  Math.min(x, BOARD_SIZE - 1 - x, y, BOARD_SIZE - 1 - y);

/** All cells (x,y) with the given ring index. */
export function cellsInRing(r: number): Cell[] {
  const out: Cell[] = [];
  for (let x = 0; x < BOARD_SIZE; x++) {
    for (let y = 0; y < BOARD_SIZE; y++) {
      if (ring(x, y) === r) out.push([x, y]);
    }
  }
  return out;
}

/** The protected set: objectives ∪ spawns ∪ {(4,4)} (never an obstacle). */
function protectedSet(): Set<string> {
  const p = new Set<string>();
  for (const o of OBJECTIVES) p.add(cellKey(o.cell));
  for (const side of ['A', 'B'] as const) {
    for (const c of Object.values(SPAWNS[side])) p.add(cellKey(c));
  }
  p.add(key(4, 4));
  return p;
}

/** BFS 4-connectivity check: are all `open` cells reachable from one another? */
function isConnected(open: Set<string>): boolean {
  if (open.size === 0) return true;
  const start = open.values().next().value as string;
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const [cx, cy] = cur.split(',').map(Number);
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nk = key(nx, ny);
      if (open.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
  return seen.size === open.size;
}

/**
 * Seeded obstacle generator (A1 §1.4, normative reference algorithm). Produces
 * exactly 8 obstacle cells (4 rotational pairs), never on a protected cell,
 * keeping the open board 4-connected. Bit-identical from a given seed.
 */
export function generateObstacles(seed: number): Cell[] {
  const prng = mulberry32(seed);
  const protectedCells = protectedSet();

  // All open (non-obstacle) cells start as the full board.
  const allOpen = new Set<string>();
  for (let x = 0; x < BOARD_SIZE; x++) {
    for (let y = 0; y < BOARD_SIZE; y++) allOpen.add(key(x, y));
  }

  // Candidate south-half cells (y < 4), excluding protected. The mirror
  // supplies the north half. Fixed iteration order for determinism.
  const candidates: Cell[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (!protectedCells.has(key(x, y))) candidates.push([x, y]);
    }
  }

  const obstacles = new Set<string>();
  const obstacleList: Cell[] = [];

  while (obstacleList.length < OBSTACLE_COUNT && candidates.length > 0) {
    const i = Math.floor(prng() * candidates.length);
    const c = candidates.splice(i, 1)[0];
    const m = rho(c);
    const ck = cellKey(c);
    const mk = cellKey(m);

    // Skip if either half of the pair is protected or already an obstacle.
    if (protectedCells.has(ck) || protectedCells.has(mk)) continue;
    if (obstacles.has(ck) || obstacles.has(mk)) continue;

    // Would the open board stay 4-connected after removing this pair?
    const open = new Set(allOpen);
    for (const o of obstacles) open.delete(o);
    open.delete(ck);
    open.delete(mk);
    if (!isConnected(open)) continue;

    obstacles.add(ck);
    obstacles.add(mk);
    obstacleList.push(c, m);
  }

  // Canonical ascending order (x then y) for stable storage.
  return obstacleList.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
