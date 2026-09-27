/**
 * Seeded PRNG — mulberry32, the same family used by the repo's legacy engines
 * (`backend/src/engines/trial_engine.ts` `rng`/`hash32`). Reimplemented here
 * (not imported) so the engine has zero legacy coupling.
 *
 * Used EXACTLY ONCE per match, at match start, for obstacle generation (A1
 * §1.4, §8.1). Combat and movement are RNG-free. There is no `Math.random`
 * and no wall-clock anywhere in this package.
 */

/** mulberry32 — small, deterministic, integer-state PRNG returning [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash (deterministic; parity with the legacy `hash32`). */
export function hash32(s: string): number {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
