/**
 * Small shared, pure helpers over `RaidState` used by the boss policies, the
 * resolution pipeline, and the observation builder. Iteration is always by
 * ascending member id so every derived quantity is order-independent.
 */

import { hash32 } from '../rng.ts';
import type { Cell } from '../types.ts';
import type { MemberId, RaidState, RaidUnit } from './types.ts';

/** A member's single Avatar unit (living or downed), if it still exists. */
export const unitOf = (s: RaidState, m: MemberId): RaidUnit | undefined =>
  s.units.find((u) => u.memberId === m);

/** Members that are alive AND not downed (contribute threat/corroboration). */
export function aliveMembers(s: RaidState): RaidUnit[] {
  return s.units
    .filter((u) => !u.downed && u.hp > 0)
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/** Count of alive-and-not-downed members — the corroboration `squad_alive`. */
export const squadAlive = (s: RaidState): number => aliveMembers(s).length;

/** Highest-threat alive member (tie → lowest member id); null if none alive. */
export function topThreat(s: RaidState): MemberId | null {
  const alive = aliveMembers(s);
  if (alive.length === 0) return null;
  let best = alive[0].memberId;
  let bestT = s.threat[best] ?? 0;
  for (const u of alive) {
    const t = s.threat[u.memberId] ?? 0;
    if (t > bestT) {
      bestT = t;
      best = u.memberId;
    }
  }
  return best;
}

/**
 * The deterministic subset of alive members a reading is delivered to (§3.2).
 * Members are ranked by a seeded hash of (seed, tick, reading_id, member) and the
 * first `count` taken — pure, reproducible, and independent of the phantom salt
 * except through `reading_id`. Returns the ordered member ids.
 */
export function deliveredSubset(
  seed: number,
  tick: number,
  readingId: string,
  alive: MemberId[],
  count: number,
): MemberId[] {
  const ranked = [...alive].sort((a, b) => {
    const ha = hash32(`${seed}:${tick}:${readingId}:${a}`);
    const hb = hash32(`${seed}:${tick}:${readingId}:${b}`);
    return ha - hb || (a < b ? -1 : 1);
  });
  return ranked.slice(0, Math.max(0, Math.min(count, ranked.length)));
}

/** Board third of a cell's x (0=west,1=centre,2=east) — the Overfit `region`. */
export const regionOf = (c: Cell): number => (c[0] <= 2 ? 0 : c[0] <= 5 ? 1 : 2);

/** Column bucket of a cell's x (the Overfit `lane`). */
export const laneOf = (c: Cell): number => c[0];
