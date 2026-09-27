/**
 * Trajectory classes (arena-scenarios.md §1.7). A class is the sha256 of every
 * SEED-DERIVED input a target could be exposed to, plus the experiment's
 * configuration. Two episodes with equal classes are the same experiment for a
 * deterministic target, so the reporter shows EFFECTIVE episodes (distinct
 * classes) instead of n. Classes are conservative: they may split what a given
 * target cannot tell apart, never merge what it could.
 *
 *  grid_tactics  obstacle layout (seeded).
 *  hallucinator  the seed itself: phantoms and delivery subsets are seeded on every tick.
 *  overfit       nothing: no seed read in the boss, the mechanics or the observation.
 *  byzantine     per phase: grounded node, false node, the two top-ranked faulty
 *                candidates (which fully determine the faulty member for any
 *                alive set of 4 or 5; below 4 there is none).
 *  deadlock      nothing: lock ranks are fixed fixtures.
 *  split_brain   per window: the pairwise partition order of m0..m4, plus the
 *                exposed core cell on every window tick.
 *  latency       the sweep start offset.
 */

import { createHash } from 'node:crypto';
import {
  byzantineFaulty,
  coreCell,
  createInitialRaidState,
  falseNode,
  generateObstacles,
  groundedNode,
  latencyLiveCell,
  partitionGroup,
  SPLITBRAIN_DIALS,
} from 'wot-engine';
import type { ScenarioId, SeatId, SeatMode, TierId } from './types.ts';

const MEMBERS = ['m0', 'm1', 'm2', 'm3', 'm4'];

function seedProjection(scenario: ScenarioId, seed: number): unknown {
  switch (scenario) {
    case 'grid_tactics':
      return generateObstacles(seed);
    case 'hallucinator':
      return { seed };
    case 'overfit':
    case 'deadlock':
      return null;
    case 'byzantine':
      return [0, 1, 2, 3].map((p) => {
        const first = [...byzantineFaulty(seed, p, MEMBERS, 0)];
        const second = [...byzantineFaulty(seed, p, MEMBERS.filter((m) => !first.includes(m)), 0)];
        return { grounded: groundedNode(seed, p).id, false: falseNode(seed, p).id, faulty: [...first, ...second] };
      });
    case 'split_brain': {
      const s = createInitialRaidState(seed, 'split_brain');
      return SPLITBRAIN_DIALS.windows.map(([open, close], w) => {
        const order: string[] = [];
        for (let i = 0; i < MEMBERS.length; i++) {
          for (let j = i + 1; j < MEMBERS.length; j++) {
            const pair = [MEMBERS[i], MEMBERS[j]];
            order.push(partitionGroup(seed, w, pair, MEMBERS[i], 0) === 'A' ? `${pair[0]}<${pair[1]}` : `${pair[1]}<${pair[0]}`);
          }
        }
        const cores: number[][] = [];
        for (let t = open; t < close; t++) cores.push(coreCell({ ...s, tick: t }));
        return { order, cores };
      });
    }
    case 'latency':
      return latencyLiveCell(seed, 0);
    case 'diplomacy_standard':
      // Diplomacy records carry their own class (src/diplomacy/trajectory.ts); the seed decides the stimulus.
      return { seed };
  }
}

export function trajectoryClass(p: {
  scenarioId: ScenarioId;
  scenarioVersion: string;
  seed: number;
  tier: TierId;
  mode: SeatMode;
  targetSeat: SeatId;
  fill?: 'coordinated' | 'naive';
}): string {
  const body = JSON.stringify({
    scenario: p.scenarioId,
    version: p.scenarioVersion,
    tier: p.tier,
    mode: p.mode,
    seat: p.targetSeat,
    fill: p.fill ?? null,
    seeded: seedProjection(p.scenarioId, p.seed),
  });
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/** Distinct trajectory classes among episode results (`summary.effective_episodes`). */
export function effectiveEpisodes(classes: readonly string[]): number {
  return new Set(classes).size;
}
