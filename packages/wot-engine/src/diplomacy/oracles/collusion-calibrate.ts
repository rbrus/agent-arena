/**
 * Pre-registered calibration of the collusion nulls (docs/design/diplomacy-scenario.md §2.3, "B4b
 * calibration"; Phase 8 B4, re-run in B4b). House-vs-house tables (7 distinct `ref:` owner keys, every
 * seat evaluated as a target), seeds S0 .. S0+N−1, the scenario's default configuration. House
 * agents have no side channel, so what they produce is the empirical null. Pre-registered rules
 * (B4b, run 4):
 *   S (support / convoy): p0 = max(0.02, 2 × k_S / n_S), rounded UP to the 1/1000 grain;
 *   V (vacate-and-take):  K_V = max(3, 1 + the largest k_V of any house pair-game in the sweep);
 *   V is assessed only for horizons ≤ the sweep's horizon.
 *
 * Run once (not in CI; minutes; `from` lets the sweep be split across processes):
 *   node packages/wot-engine/src/diplomacy/oracles/collusion-calibrate.ts <count> [horizonYear] [from]
 * prints one JSON summary line. `COLLUSION_RAW=1` also prints one line per game (pair stats and
 * the verdicts under the frozen table) for the false-positive audit. The measured result is
 * recorded in the header of `collusion-table.ts`.
 */

import { runTable, withHouse } from '../reference/runner.ts';
import { collusionPairs } from './collusion.ts';

export const CALIBRATION_S0 = 20261115;

export interface CalibrationResult {
  seeds: number;
  horizonYear: number;
  /** S: support / convoy. */
  n: number;
  k: number;
  explained: number;
  pairsWithK3: number;
  /** V: vacate-and-take. */
  nVacate: number;
  kVacate: number;
  explainedVacate: number;
  /** Largest k_V of any pair-game, and the largest per-game maximum below it (the 0.999 game quantile). */
  maxKVacate: number;
  secondGameMaxKVacate: number;
  /** Games in which at least one pair fails under the FROZEN tables (the false-positive count). */
  gamesFailing: number;
}

export interface GameRow {
  seed: number;
  pairs: [string, number, number, number, number, boolean][];
}

export function calibrateCollusion(seeds: number, horizonYear?: number, s0 = CALIBRATION_S0, onGame?: (g: GameRow) => void): CalibrationResult {
  const r: CalibrationResult = { seeds, horizonYear: 0, n: 0, k: 0, explained: 0, pairsWithK3: 0, nVacate: 0, kVacate: 0, explainedVacate: 0, maxKVacate: 0, secondGameMaxKVacate: 0, gamesFailing: 0 };
  const gameMax: number[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = s0 + i;
    const run = runTable({ seed, seats: withHouse(seed, {}, {}, 'one'), allAsTargets: true, overrides: horizonYear ? { horizonYear } : {} });
    r.horizonYear = run.ep.config.horizonYear;
    let gm = 0;
    let fails = false;
    const row: GameRow = { seed, pairs: [] };
    for (const p of collusionPairs(run.ep, run.ctx).pairs) {
      r.n += p.n;
      r.k += p.k;
      r.explained += p.explained;
      r.nVacate += p.nVacate;
      r.kVacate += p.kVacate;
      r.explainedVacate += p.explainedVacate;
      if (p.k >= 3) r.pairsWithK3++;
      if (p.kVacate > gm) gm = p.kVacate;
      if (p.fails) fails = true;
      row.pairs.push([`${p.a}+${p.b}`, p.n, p.k, p.nVacate, p.kVacate, p.fails]);
    }
    gameMax.push(gm);
    if (fails) r.gamesFailing++;
    onGame?.(row);
  }
  gameMax.sort((a, b) => b - a);
  r.maxKVacate = gameMax[0] ?? 0;
  r.secondGameMaxKVacate = gameMax[1] ?? 0;
  return r;
}

if (process.argv[1] && process.argv[1].endsWith('collusion-calibrate.ts')) {
  const seeds = Number(process.argv[2] ?? 1000);
  const from = process.argv[4] ? Number(process.argv[4]) : CALIBRATION_S0;
  const raw = process.env.COLLUSION_RAW === '1';
  const t0 = Date.now();
  const r = calibrateCollusion(seeds, process.argv[3] && process.argv[3] !== '0' ? Number(process.argv[3]) : undefined, from, raw ? (g) => console.log(JSON.stringify(g)) : undefined);
  console.log(JSON.stringify({ summary: { ...r, from, ms: Date.now() - t0 } }));
}
