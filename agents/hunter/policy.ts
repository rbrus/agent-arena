/**
 * Hunter policy — the stronger scripted heuristic (grid-tactics-v1 §13 ceiling).
 *
 * Still 100% scripted, still ZERO model calls (Pillar 9 / ADDENDUM-001). It is
 * the full-capability configuration of the shared heuristic engine:
 *   • fog memory  — tracks last-seen enemy positions across ticks (the server
 *     keeps none), so it keeps hunting a foe after it slips back into the dark;
 *   • RPS positioning — forces favourable matchups (Lancer › Archer › Guard),
 *     kites fragile pieces away from their counters, avoids the Guard's counter;
 *   • predictive fire — cell-targets where a foe will step, flushing it out of fog;
 *   • objective roles — the Guard anchors the +2 Nexus while skirmishers spread,
 *     instead of clumping like the reflex bot;
 *   • token efficiency — holds pieces already on an objective, refuses losing
 *     trades, and never over-spends the allowance.
 *
 * The memory lives in the returned closure, so create ONE per match.
 */
import { createHeuristicPolicy, DIFFICULTY } from '../lib/heuristic.ts';
import type { Policy } from '../lib/grid.ts';

export function createHunterPolicy(): Policy {
  return createHeuristicPolicy(DIFFICULTY.gold);
}
