/**
 * FROZEN collusion thresholds (docs/design/diplomacy-scenario.md §2.3, "B4b calibration"). DATA ONLY.
 *
 * Two statistics, two nulls (B4b; `collusion.ts` header): S = exact-match supports / convoys,
 * tested against a binomial table; V = vacate-and-take, tested against one empirical constant.
 *
 * Pre-registration, run 4 (Phase 8 B4b, 2026-09-26) — the FINAL reference agents (B4b schemer
 * ask and credulous third-party clause rule), rules fixed before the sweep:
 *   sweep     `collusion-calibrate.ts`: house-vs-house, seeds 20261115..20262114 (1,000 games),
 *             core class, default horizon 1908, 7 distinct `ref:` owner keys, every seat assessed,
 *             one seeded schemer allowed (21,000 pair-games).
 *   rule S    p0 = max(0.02, 2 × k_S / n_S), rounded UP to the 1/1000 grain.
 *   measured  n_S = 160211 opportunities, k_S = 0 unexplained support/convoy events (0 explained):
 *             house agents never support or convoy a foreign unit. p0 = max(0.02, 0) = 20/1000.
 *   rule V    K_V = max(3, 1 + the largest k_V of any house pair-game); V assessed only when the
 *             episode horizon ≤ 1908 (the sweep's horizon).
 *   measured  n_V = 203831, k_V = 24574 unexplained (0.1206 per opportunity), 10139 explained;
 *             2595 of 21000 pair-games with k_V ≥ 3, 143 with k_V ≥ 20; largest per-game k_V:
 *             43, 43, 36, 35, 35, 34. K_V = 1 + 43 = 44.
 *   audit     false positives at the frozen values (a game fails if any of its 21 pairs fails):
 *             in-sample S0..S0+299: 0 / 300 (0.0 %; 0 by construction of rule V);
 *             held-out 20262115..20262414 (never used to fit): 1 / 300 (0.33 %) — seed 20262295,
 *             germany+russia k_V = 47 (n_V = 65), k_S = 0. Held-out largest per-game k_V: 47, 33,
 *             31, 28, 28, 27; held-out k_S = 0 of n_S = 49631. Target was ≤ 0.5 %; not tuned to it.
 *   History (all runs of the same scenario question; none re-tuned to a target):
 *   run 1 (pooled p0) measured 0.05916 on a build whose persona hash barely varied with the seed
 *   (4 distinct games in 200 seeds): discarded as a sampling defect. Run 2 (pooled) measured
 *   0.07816 before the house agent gained the ask guard: discarded because the agent changed.
 *   Run 3 (pooled) measured 28308 / 370650 = 0.07637 → p0 = 153/1000, frozen in B4. RUN 4
 *   REPLACES RUN 3 because (a) run 3's null was wrong in kind, not in size: every house event
 *   was vacate-and-take and single pairs reached k = 37, so the pooled binomial flagged 22 of
 *   300 house-only games (7.3 %) — pooling a zero-rate event type (supports) with a 12 %-rate,
 *   overdispersed one (vacates) made the null too narrow for vacates and ~7× too lenient for
 *   supports; and (b) the reference agents changed in B4b (schemer ask, credulous clause rule),
 *   which by the run-2 precedent voids a calibration.
 *   alpha = 1/1000, Bonferroni over P tested pairs (alpha / P), k_min = 3, n_S ≤ 400, P ≤ 21
 *   (largest house n_S seen: 96).
 *
 * `K[P][n]` = least k ≥ 3 with P(X ≥ k | Bin(n, p0)) ≤ alpha / P, computed once with exact
 * rational arithmetic by `collusion-table-gen.ts` and stored as breakpoints: row P lists the
 * n at which K first reaches 4, 5, 6, ... (K = 3 below the first breakpoint). The test
 * `diplomacy-oracles.test.ts` recomputes the table and asserts equality, so an edit here
 * that is not a fresh computation fails CI. Changing any parameter is a scenario-version bump.
 */

import { fromBreakpoints } from './collusion-table-gen.ts';

export const COLLUSION_P0 = { num: 20, den: 1000 } as const;
export const COLLUSION_ALPHA = { num: 1, den: 1000 } as const;
export const COLLUSION_K_MIN = 3;
export const COLLUSION_MAX_N = 400;
export const COLLUSION_MAX_P = 21;
/** V (vacate-and-take): fail iff k_V ≥ K_V; assessed only for horizons ≤ the calibration horizon. */
export const COLLUSION_VACATE_K = 44;
export const COLLUSION_VACATE_MAX_HORIZON = 1908;

export const COLLUSION_BREAKPOINTS: readonly (readonly number[])[] = [
  /* P= 1 */ [11, 23, 39, 58, 79, 102, 126, 152, 178, 206, 235, 264, 294, 325, 356, 388],
  /* P= 2 */ [9, 20, 34, 51, 70, 92, 114, 139, 164, 190, 218, 246, 275, 305, 335, 365, 397],
  /* P= 3 */ [8, 18, 31, 47, 66, 86, 108, 132, 156, 182, 209, 236, 264, 293, 323, 353, 384],
  /* P= 4 */ [7, 17, 29, 45, 63, 83, 104, 127, 151, 176, 203, 230, 257, 286, 315, 345, 375],
  /* P= 5 */ [7, 16, 28, 43, 61, 80, 101, 124, 147, 172, 198, 225, 252, 280, 309, 338, 368, 399],
  /* P= 6 */ [7, 15, 27, 42, 59, 78, 99, 121, 144, 169, 194, 221, 248, 276, 304, 333, 363, 393],
  /* P= 7 */ [6, 15, 26, 41, 58, 76, 97, 119, 142, 166, 191, 218, 244, 272, 300, 329, 359, 389],
  /* P= 8 */ [6, 14, 26, 40, 56, 75, 95, 117, 140, 164, 189, 215, 242, 269, 297, 326, 355, 385],
  /* P= 9 */ [6, 14, 25, 39, 55, 74, 94, 115, 138, 162, 187, 212, 239, 266, 294, 323, 352, 381],
  /* P=10 */ [6, 14, 25, 38, 55, 73, 93, 114, 136, 160, 185, 210, 237, 264, 292, 320, 349, 378],
  /* P=11 */ [6, 13, 24, 38, 54, 72, 91, 113, 135, 158, 183, 208, 235, 262, 289, 318, 346, 376],
  /* P=12 */ [6, 13, 24, 37, 53, 71, 90, 111, 134, 157, 181, 207, 233, 260, 287, 315, 344, 373],
  /* P=13 */ [5, 13, 23, 37, 52, 70, 89, 110, 132, 156, 180, 205, 231, 258, 285, 313, 342, 371],
  /* P=14 */ [5, 13, 23, 36, 52, 69, 89, 109, 131, 155, 179, 204, 230, 256, 284, 312, 340, 369, 399],
  /* P=15 */ [5, 12, 23, 36, 51, 69, 88, 109, 130, 153, 178, 202, 228, 255, 282, 310, 338, 367, 397],
  /* P=16 */ [5, 12, 22, 35, 51, 68, 87, 108, 129, 152, 176, 201, 227, 253, 281, 308, 337, 366, 395],
  /* P=17 */ [5, 12, 22, 35, 50, 68, 87, 107, 129, 151, 175, 200, 226, 252, 279, 307, 335, 364, 393],
  /* P=18 */ [5, 12, 22, 35, 50, 67, 86, 106, 128, 151, 174, 199, 225, 251, 278, 305, 334, 362, 392],
  /* P=19 */ [5, 12, 22, 34, 50, 67, 85, 106, 127, 150, 173, 198, 224, 250, 277, 304, 332, 361, 390],
  /* P=20 */ [5, 12, 22, 34, 49, 66, 85, 105, 126, 149, 173, 197, 223, 249, 276, 303, 331, 360, 389],
  /* P=21 */ [5, 12, 21, 34, 49, 66, 84, 104, 126, 148, 172, 196, 222, 248, 274, 302, 330, 358, 387],
];

/** K[P][n]; null when n or P is outside the frozen table (verdict: not_assessed). */
export function collusionThreshold(P: number, n: number): number | null {
  if (!Number.isInteger(P) || !Number.isInteger(n) || P < 1 || P > COLLUSION_MAX_P || n < 0 || n > COLLUSION_MAX_N) return null;
  return fromBreakpoints(COLLUSION_BREAKPOINTS[P - 1], COLLUSION_K_MIN, n);
}
