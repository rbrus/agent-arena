/**
 * Reflex policy — the ≤50-line reference bot (grid-tactics-v1 §13 floor).
 *
 * Scripted, deterministic, ZERO model calls (Pillar 9 / ADDENDUM-001). The whole
 * competitive loop: attack if something is in range, else step one cell toward the
 * nearest objective (validated against `reachable`), else hold. It plays a full
 * match and occasionally beats the weakest house bot — but it clumps, walks blind
 * into fog, ignores the RPS triangle, and wastes tokens. That gap is the whole
 * game: "I can improve this." The stronger `hunter` bot shows the ceiling.
 */
import type { Observation, Action } from 'wot-contracts';

type Dir = 'N' | 'E' | 'S' | 'W';
const STEP: Record<Dir, [number, number]> = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
const OBJECTIVES: [number, number][] = [[4, 4], [2, 4], [6, 4]]; // nexus, relay_w, relay_e

export function reflexPolicy(obs: Observation): Action {
  const units: Action['units'][number][] = [];
  for (const u of obs.you.units) {
    const target = obs.attacks?.[u.unit_id]?.[0]; // a visible enemy in attack range?
    if (target) {
      units.push({ unit_id: u.unit_id, verb: 'attack', target });
      continue;
    }
    const [ux, uy] = u.cell;
    let goal = OBJECTIVES[0];
    let bestD = Infinity;
    for (const o of OBJECTIVES) {
      const d = Math.abs(o[0] - ux) + Math.abs(o[1] - uy); // greedy Manhattan
      if (d < bestD) {
        bestD = d;
        goal = o;
      }
    }
    const dx = goal[0] - ux;
    const dy = goal[1] - uy;
    const tries: Dir[] = Math.abs(dx) >= Math.abs(dy) ? [dx > 0 ? 'E' : 'W', dy > 0 ? 'N' : 'S'] : [dy > 0 ? 'N' : 'S', dx > 0 ? 'E' : 'W'];
    const dests = obs.reachable?.[u.unit_id] ?? [];
    let acted = false;
    for (const dir of tries) {
      if ((dir === 'E' || dir === 'W') && dx === 0) continue;
      if ((dir === 'N' || dir === 'S') && dy === 0) continue;
      const nx = ux + STEP[dir][0];
      const ny = uy + STEP[dir][1];
      if (dests.some((c) => c[0] === nx && c[1] === ny)) {
        units.push({ unit_id: u.unit_id, verb: 'move', steps: [dir] });
        acted = true;
        break;
      }
    }
    if (!acted) units.push({ unit_id: u.unit_id, verb: 'hold' });
  }
  // Echo turn_id + nonce + match_id — the anti-replay contract (asyncapi.yaml).
  return { t: 'action', protocol_version: '1.0', match_id: obs.match_id, turn_id: obs.turn_id, nonce: obs.nonce, units: units.slice(0, 4) as Action['units'] };
}
