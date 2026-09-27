/**
 * Deterministic house bot (A1 §13 "floor" policy) so lobbies always fill when a
 * single session waits past the backfill timeout. It is a pure function of the
 * observation, so a bot-backed match is as replayable as any other.
 */

import type { Cell, Dir, UnitAction } from 'wot-engine';
import type { Observation } from 'wot-contracts';

export type HouseBotPolicy = (obs: Observation) => UnitAction[];

/**
 * For each own unit: attack the first in-range visible enemy if any, else step
 * greedily (Manhattan) toward the nearest objective. Never publishes a thought.
 */
export const houseBotPolicy: HouseBotPolicy = (obs) => {
  const actions: UnitAction[] = [];
  const objectives = obs.objectives.map((o) => o.cell);
  for (const u of obs.you.units) {
    const atk = (obs.attacks?.[u.unit_id] ?? []) as Cell[];
    if (atk.length > 0) {
      actions.push({ unit_id: u.unit_id, verb: 'attack', target: [atk[0][0], atk[0][1]] });
      continue;
    }
    const [ux, uy] = u.cell;
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const c of objectives) {
      const d = Math.abs(c[0] - ux) + Math.abs(c[1] - uy);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || bestD === 0) {
      actions.push({ unit_id: u.unit_id, verb: 'hold' });
      continue;
    }
    const dx = best[0] - ux;
    const dy = best[1] - uy;
    let dir: Dir;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) dir = dx > 0 ? 'E' : 'W';
    else if (dy !== 0) dir = dy > 0 ? 'N' : 'S';
    else dir = dx > 0 ? 'E' : 'W';
    actions.push({ unit_id: u.unit_id, verb: 'move', steps: [dir] });
  }
  return actions;
};
