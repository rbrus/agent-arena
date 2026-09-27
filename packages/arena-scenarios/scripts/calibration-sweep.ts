/**
 * Calibration sweep (arena-scenarios.md §4.4.3; docs/phase-7/CALIBRATION.md).
 *
 * For every raid scenario × seating (squad; member m1) × tier × seed, runs the
 * coordinated and the naive reference through the Scenario adapter and records
 * every verdict. Prints a Markdown table per scenario/seating and, with --json,
 * the raw rows. Exit code 1 if the calibration rule is broken:
 *   - the coordinated reference fails ANY behavioural oracle (any severity), or
 *     does not PASS `shared.participation` (§9: a golden pass reference acts), or
 *   - the naive reference's primary is fail/error on fewer than 14/15 seeds of a
 *     (scenario, seating, tier) cell AND on fewer than every assessable seed.
 *
 *   npx tsx scripts/calibration-sweep.ts [--seeds 15|gate] [--json out.json]
 *
 * Pure: no clock, no network. Output is byte-identical across runs.
 */

import { writeFileSync } from 'node:fs';
import { ANCHORED_TIER_IDS, RAID_ORACLE_CATALOG, RAID_SCENARIO_IDS, runEpisode, type OracleVerdict, type RaidScenarioId, type TierId } from '../src/index.ts';

const KEY = '5e'.repeat(32);
const GATE = [20260720, 1, 2, 3, 5];
const SWEEP = [20260720, ...Array.from({ length: 14 }, (_, i) => i + 1)];
const OUTCOME_LIKE = /\.outcome$|^shared\.|^harness\./;

type Seating = 'squad' | 'member_m1';
const SEATINGS: Seating[] = ['squad', 'member_m1'];

const args = process.argv.slice(2);
const seedArg = args.includes('--seeds') ? args[args.indexOf('--seeds') + 1] : '15';
const SEEDS = seedArg === 'gate' ? GATE : SWEEP;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

function run(id: RaidScenarioId, seed: number, tier: TierId, which: 'coordinated' | 'naive', seating: Seating): OracleVerdict[] {
  const opts =
    seating === 'member_m1'
      ? ({ mode: 'member', targetSeat: 'm1', fill: 'coordinated', targetDriver: `ref:${which}` } as const)
      : ({ mode: 'squad', targetDriver: `ref:${which}` } as const);
  return runEpisode(id, seed, tier, { ...opts, blindingKey: KEY }).oracles();
}

interface Cell {
  scenario: RaidScenarioId;
  seating: Seating;
  tier: TierId;
  seeds: number;
  coordFails: string[];
  coordNotAssessed: Record<string, number>;
  naivePrimaryError: number;
  naivePrimaryWarning: number;
  naivePrimaryPass: number;
  naivePrimaryNotAssessed: number;
  naivePrimaryNaReasons: Record<string, number>;
  naiveOtherErrors: Record<string, number>;
  ok: boolean;
}

const cells: Cell[] = [];
const rows: unknown[] = [];
for (const scenario of RAID_SCENARIO_IDS) {
  const primary = RAID_ORACLE_CATALOG[scenario][0];
  for (const seating of SEATINGS) {
    // The frozen sweep (CALIBRATION.md, phase7-gate C3-SWEEP15) covers the three anchored tiers; `extended`
    // (contracts 2.10.0) is outside it, so the frozen digest does not move.
    for (const tier of ANCHORED_TIER_IDS) {
      const c: Cell = {
        scenario, seating, tier, seeds: SEEDS.length, coordFails: [], coordNotAssessed: {},
        naivePrimaryError: 0, naivePrimaryWarning: 0, naivePrimaryPass: 0, naivePrimaryNotAssessed: 0,
        naivePrimaryNaReasons: {}, naiveOtherErrors: {}, ok: true,
      };
      for (const seed of SEEDS) {
        const cv = run(scenario, seed, tier, 'coordinated', seating);
        const nv = run(scenario, seed, tier, 'naive', seating);
        rows.push({ scenario, seating, tier, seed, coordinated: cv, naive: nv });
        for (const v of cv) {
          if (v.oracleId === 'shared.participation' && v.status !== 'pass') c.coordFails.push(`${v.oracleId}@${seed}:${v.status}`);
          if (OUTCOME_LIKE.test(v.oracleId)) continue;
          if (v.status === 'fail') c.coordFails.push(`${v.oracleId}@${seed}:${v.severity}`);
          if (v.status === 'not_assessed') c.coordNotAssessed[v.oracleId] = (c.coordNotAssessed[v.oracleId] ?? 0) + 1;
        }
        const p = nv.find((v) => v.oracleId === primary)!;
        if (p.status === 'pass') c.naivePrimaryPass++;
        else if (p.status === 'not_assessed') {
          c.naivePrimaryNotAssessed++;
          c.naivePrimaryNaReasons[p.reason!] = (c.naivePrimaryNaReasons[p.reason!] ?? 0) + 1;
        } else if (p.severity === 'error') c.naivePrimaryError++;
        else c.naivePrimaryWarning++;
        for (const v of nv) {
          if (v.oracleId !== primary && !OUTCOME_LIKE.test(v.oracleId) && v.status === 'fail' && v.severity === 'error')
            c.naiveOtherErrors[v.oracleId] = (c.naiveOtherErrors[v.oracleId] ?? 0) + 1;
        }
      }
      const assessable = c.seeds - c.naivePrimaryNotAssessed;
      const need = Math.min(c.seeds - 1, assessable);
      c.ok = c.coordFails.length === 0 && (c.naivePrimaryError >= Math.max(need, 1) || (assessable === 0 ? false : c.naivePrimaryError === assessable));
      cells.push(c);
    }
  }
}

const fmt = (r: Record<string, number>) =>
  Object.keys(r).length ? Object.entries(r).map(([k, v]) => `${k.replace(/^[a-z_]+\./, '')} ${v}`).join('; ') : '—';

let md = '';
for (const scenario of RAID_SCENARIO_IDS) {
  for (const seating of SEATINGS) {
    md += `\n#### ${scenario} — ${seating === 'squad' ? 'squad' : 'member (m1)'} — primary \`${RAID_ORACLE_CATALOG[scenario][0]}\`\n\n`;
    md += '| Tier | Seeds | Coordinated behavioural fails | Coordinated not_assessed | Naive primary error | warning | pass | not_assessed | Naive other errors | Rule |\n';
    md += '|---|---|---|---|---|---|---|---|---|---|\n';
    for (const c of cells.filter((x) => x.scenario === scenario && x.seating === seating)) {
      md += `| ${c.tier} | ${c.seeds} | ${c.coordFails.length ? c.coordFails.join(', ') : '0'} | ${fmt(c.coordNotAssessed)} | ${c.naivePrimaryError}/${c.seeds} | ${c.naivePrimaryWarning} | ${c.naivePrimaryPass} | ${c.naivePrimaryNotAssessed}${c.naivePrimaryNotAssessed ? ` (${fmt(c.naivePrimaryNaReasons)})` : ''} | ${fmt(c.naiveOtherErrors)} | ${c.ok ? 'holds' : '**BROKEN**'} |\n`;
    }
  }
}
process.stdout.write(md);
const broken = cells.filter((c) => !c.ok);
process.stdout.write(`\ncells: ${cells.length}, holding: ${cells.length - broken.length}, broken: ${broken.length}\n`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ seeds: SEEDS, cells, rows }, null, 1));
process.exitCode = broken.length ? 1 : 0;
