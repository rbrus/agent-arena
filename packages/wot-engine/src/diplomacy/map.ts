/**
 * Frozen lookups over the standard map (design §1.2). Built once at module load
 * from the sorted edge lists; every exported list is sorted in ASCII order.
 */

import { createHash } from 'node:crypto';
import { ARMY_EDGES, FLEET_EDGES, PROVINCES } from './map-data.ts';
import type { CoastTag, NodeId, ProvinceDef, ProvinceId, UnitType } from './types.ts';

/** ASCII code-unit comparator. Never localeCompare (design §4.1). */
export const ascii = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byId: Record<ProvinceId, ProvinceDef> = Object.create(null);
const index: Record<ProvinceId, number> = Object.create(null);
PROVINCES.forEach((p, i) => {
  byId[p.id] = p;
  index[p.id] = i;
});

const nodes: NodeId[] = [];
for (const p of PROVINCES) {
  if (p.kind === 'inland') {
    nodes.push(p.id); // armies only; still a node
  } else if (p.coasts.length > 0) {
    // 75 − 3 + 6 = 78 nodes (design §1.2): the bare id of a split-coast province
    // is not a node of its own; an army there stands on the province id.
    for (const c of p.coasts) nodes.push(`${p.id}/${c}`);
  } else {
    nodes.push(p.id);
  }
}
nodes.sort(ascii);

const armyAdj: Record<ProvinceId, ProvinceId[]> = Object.create(null);
const fleetAdj: Record<NodeId, NodeId[]> = Object.create(null);
const fleetProvAdj: Record<ProvinceId, ProvinceId[]> = Object.create(null);
const unionAdj: Record<ProvinceId, ProvinceId[]> = Object.create(null);
for (const p of PROVINCES) {
  armyAdj[p.id] = [];
  fleetProvAdj[p.id] = [];
  unionAdj[p.id] = [];
}
for (const n of nodes) fleetAdj[n] = [];
for (const p of PROVINCES) if (p.coasts.length > 0) fleetAdj[p.id] = [];

const pushUniq = (arr: string[], v: string): void => {
  if (!arr.includes(v)) arr.push(v);
};

for (const [a, b] of ARMY_EDGES) {
  armyAdj[a].push(b);
  armyAdj[b].push(a);
  pushUniq(unionAdj[a], b);
  pushUniq(unionAdj[b], a);
}
for (const [a, b] of FLEET_EDGES) {
  fleetAdj[a].push(b);
  fleetAdj[b].push(a);
  const pa = provinceOf(a);
  const pb = provinceOf(b);
  pushUniq(fleetProvAdj[pa], pb);
  pushUniq(fleetProvAdj[pb], pa);
  pushUniq(unionAdj[pa], pb);
  pushUniq(unionAdj[pb], pa);
}
for (const k of Object.keys(armyAdj)) armyAdj[k].sort(ascii);
for (const k of Object.keys(fleetAdj)) fleetAdj[k].sort(ascii);
for (const k of Object.keys(fleetProvAdj)) fleetProvAdj[k].sort(ascii);
for (const k of Object.keys(unionAdj)) unionAdj[k].sort(ascii);

export const MAP: Readonly<{
  provinces: readonly ProvinceDef[];
  index: Readonly<Record<ProvinceId, number>>;
  nodes: readonly NodeId[];
}> = Object.freeze({ provinces: PROVINCES, index: Object.freeze(index), nodes: Object.freeze(nodes) });

export function provinceOf(n: NodeId): ProvinceId {
  return n.length > 3 ? n.slice(0, 3) : n;
}
export function coastOf(n: NodeId): CoastTag | null {
  return n.length > 3 ? (n.slice(4) as CoastTag) : null;
}
export function isProvince(p: string): boolean {
  return byId[p] !== undefined;
}
export function province(p: ProvinceId): ProvinceDef {
  const d = byId[p];
  if (!d) throw new Error(`unknown province ${p}`);
  return d;
}
export function provinceIndex(p: ProvinceId): number {
  return index[provinceOf(p)];
}
export function isSplitCoast(p: ProvinceId): boolean {
  return byId[p]?.coasts.length > 0;
}
export function armyNeighbours(p: ProvinceId): readonly ProvinceId[] {
  return armyAdj[p] ?? [];
}
export function fleetNeighbours(n: NodeId): readonly NodeId[] {
  return fleetAdj[n] ?? [];
}
/** Province-level fleet adjacency (union over coasts). */
export function fleetProvinceNeighbours(p: ProvinceId): readonly ProvinceId[] {
  return fleetProvAdj[p] ?? [];
}
export function canFleetOccupy(n: NodeId): boolean {
  const d = byId[provinceOf(n)];
  if (!d || d.kind === 'inland') return false;
  if (d.coasts.length > 0) return n.length > 3 && d.coasts.includes(n.slice(4) as CoastTag);
  return n.length === 3;
}
export function canArmyOccupy(p: ProvinceId): boolean {
  const d = byId[p];
  return !!d && d.kind !== 'sea' && p.length === 3;
}
/** Provinces a unit of `type` at node `at` can move into in one step (support reach). */
export function reach(type: UnitType, at: NodeId): readonly ProvinceId[] {
  if (type === 'A') return armyNeighbours(provinceOf(at));
  const out: ProvinceId[] = [];
  for (const n of fleetNeighbours(at)) pushUniq(out, provinceOf(n));
  return out.sort(ascii);
}
/** Coasts of split-coast province `p` a fleet at `from` can reach. */
export function reachableCoasts(from: NodeId, p: ProvinceId): CoastTag[] {
  const out: CoastTag[] = [];
  for (const n of fleetNeighbours(from)) if (provinceOf(n) === p && n.length > 3) out.push(n.slice(4) as CoastTag);
  return out;
}
/**
 * BFS distance over the union graph (army ∪ fleet edges, projected to
 * provinces): DATC 4.D.8 / 2023 civil-disorder rule. 0 if `from` ∈ targets;
 * a large sentinel if unreachable (cannot happen on the connected standard map).
 */
export function unionDistance(from: ProvinceId, targets: ReadonlySet<ProvinceId>): number {
  if (targets.has(from)) return 0;
  const seen = new Set<ProvinceId>([from]);
  let frontier: ProvinceId[] = [from];
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: ProvinceId[] = [];
    for (const p of frontier) {
      for (const q of unionAdj[p]) {
        if (seen.has(q)) continue;
        if (targets.has(q)) return d;
        seen.add(q);
        next.push(q);
      }
    }
    frontier = next;
  }
  return 1_000_000;
}

/** sha256 over the canonical JSON of PROVINCES + both edge lists. */
export const MAP_DIGEST: string =
  'sha256:' +
  createHash('sha256')
    .update(
      JSON.stringify({
        provinces: PROVINCES.map((p) => [p.id, p.name, p.kind, p.sc ? 1 : 0, p.home, [...p.coasts]]),
        army_edges: ARMY_EDGES.map((e) => [e[0], e[1]]),
        fleet_edges: FLEET_EDGES.map((e) => [e[0], e[1]]),
      }),
      'utf8',
    )
    .digest('hex');
