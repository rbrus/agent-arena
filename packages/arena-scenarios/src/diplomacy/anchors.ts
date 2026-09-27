/**
 * Diplomacy anchors, computed (never hard-coded) from the engine: the engine's
 * own table runner (`runDipTable`) plays the golden table with the reference
 * target in-process, and its replay / transcript / evaluation hashes are the
 * anchor. wot-engine/test/diplomacy-golden.test.ts freezes those runs, so an
 * upstream re-freeze moves both sides together and nothing here goes stale.
 *
 * Cells: the engine golden tables (seed 20261115, horizon 1904, Core, target
 * germany) × {robust, credulous}. `injector-table` at germany is the `combined`
 * golden table; `table:<pair>` are the isolated pairs. The two-target collusion
 * table has no single-target seating and no anchor here.
 */

import { diplomacyOracleHook, dipEvaluate, runDipTable, type Power } from 'wot-engine';
import type { SelfTestCase } from '../types.ts';
import { outcomeOf } from './diplomacy-scenario.ts';
import type { DipFill } from './record.ts';
import { DIP_GOLDEN_HORIZON, DIP_GOLDEN_SEED, DIP_GOLDEN_TABLES, rosterFor, tableSpecOf } from './tables.ts';

export interface DipAnchor {
  name: string;
  outcome: SelfTestCase['expect']['outcome'];
  ticks: number;
  replayHash: string;
  transcriptHash: string;
  engineEvaluationHash: string;
}

export const DIP_GOLDEN_SEAT = 'germany' as const;
const GOLDEN_FILLS: readonly DipFill[] = ['injector-table', ...DIP_GOLDEN_TABLES.map((t) => `table:${t}` as DipFill)];

const memo = new Map<string, DipAnchor>();

/** Normalise a policy name: robust | credulous (Phase 7 aliases coordinated | naive accepted). */
export function dipPolicy(policy: string): 'robust' | 'credulous' | null {
  if (policy === 'robust' || policy === 'robust-diplomat' || policy === 'coordinated') return 'robust';
  if (policy === 'credulous' || policy === 'credulous-diplomat' || policy === 'naive') return 'credulous';
  return null;
}

export interface DipAnchorKey {
  seat: string;
  tier: string;
  seed: number;
  policy: string;
  fill?: string;
  horizonYear?: number;
}

/** The engine-computed anchor of one golden cell, or undefined when the cell is not a golden table. */
export function dipAnchorFor(k: DipAnchorKey): DipAnchor | undefined {
  const policy = dipPolicy(k.policy);
  const fill = (k.fill ?? 'injector-table') as DipFill;
  if (!policy || k.seat !== DIP_GOLDEN_SEAT || k.tier !== 'core' || k.seed !== DIP_GOLDEN_SEED || (k.horizonYear ?? DIP_GOLDEN_HORIZON) !== DIP_GOLDEN_HORIZON) return undefined;
  if (!GOLDEN_FILLS.includes(fill)) return undefined;
  const key = `${fill}|${policy}`;
  const hit = memo.get(key);
  if (hit) return { ...hit };
  const roster = rosterFor(k.seed, DIP_GOLDEN_SEAT, fill, { agent: policy });
  const spec = tableSpecOf(k.seed, 'core', roster, { horizonYear: DIP_GOLDEN_HORIZON, secret: '' });
  const run = runDipTable(spec);
  const a: DipAnchor = {
    name: `diplomacy_standard core seed ${k.seed} ${DIP_GOLDEN_SEAT} ${policy} fill ${fill} horizon ${DIP_GOLDEN_HORIZON} (engine golden)`,
    outcome: outcomeOf(run.ep, DIP_GOLDEN_SEAT as Power).outcome,
    ticks: run.ep.tick,
    replayHash: run.ep.chain,
    transcriptHash: run.ep.transcript,
    engineEvaluationHash: dipEvaluate(run.ep, diplomacyOracleHook(run.ctx)).evaluationHash,
  };
  memo.set(key, a);
  return { ...a };
}

/** Self-test rows for every golden cell; expectations computed from the engine at call time. */
export function dipSelfTests(): SelfTestCase[] {
  const out: SelfTestCase[] = [];
  for (const fill of GOLDEN_FILLS) {
    for (const policy of ['robust', 'credulous'] as const) {
      const a = dipAnchorFor({ seat: DIP_GOLDEN_SEAT, tier: 'core', seed: DIP_GOLDEN_SEED, policy, fill, horizonYear: DIP_GOLDEN_HORIZON })!;
      out.push({
        name: a.name,
        seed: DIP_GOLDEN_SEED,
        tier: 'core',
        opts: { mode: 'power', targetSeat: DIP_GOLDEN_SEAT, targetDriver: `ref:${policy}`, diplomacy: { fill, horizonYear: DIP_GOLDEN_HORIZON } },
        expect: { outcome: a.outcome, ticks: a.ticks, replayHash: a.replayHash },
      });
    }
  }
  return out;
}
