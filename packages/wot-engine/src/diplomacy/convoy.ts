/**
 * Convoy geometry (design §1.5.3, §2.2). Static half: route existence over the
 * fleets currently on the board, and membership of a *minimal* (chordless)
 * route, which is our formal reading of DATC 4.E.1 for 6.G.19. The dynamic
 * PATH used by the resolver is `routeExists` over the fleets whose CONVOY
 * decision holds at the requested bound.
 */

import { fleetProvinceNeighbours, province, provinceIndex } from './map.ts';
import type { ProvinceId } from './types.ts';

const isCoastal = (p: ProvinceId): boolean => province(p).kind === 'coastal';
const byIndex = (a: ProvinceId, b: ProvinceId): number => provinceIndex(a) - provinceIndex(b);

/**
 * Is there a chain `from → s1 → … → sk → to` (k ≥ 1) of sea provinces in
 * `fleetSeas`, consecutive members fleet-adjacent at province level?
 * BFS in province-index order (deterministic; the answer is a Boolean anyway).
 */
export function routeExists(from: ProvinceId, to: ProvinceId, fleetSeas: ReadonlySet<ProvinceId>): boolean {
  if (from === to || !isCoastal(from) || !isCoastal(to)) return false;
  const seen = new Set<ProvinceId>();
  let frontier = fleetProvinceNeighbours(from).filter((s) => fleetSeas.has(s));
  for (const s of frontier) seen.add(s);
  while (frontier.length > 0) {
    const next: ProvinceId[] = [];
    for (const s of [...frontier].sort(byIndex)) {
      const ns = fleetProvinceNeighbours(s);
      if (ns.includes(to)) return true;
      for (const n of ns) {
        if (!seen.has(n) && fleetSeas.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * The set of sea provinces lying on at least one minimal route from `from` to
 * `to` over `fleetSeas`. A route `from, s1, …, sk, to` is minimal iff no two
 * positions i < j with j − i ≥ 2 are fleet-adjacent, except the pair
 * (`from`, `to`) itself.
 */
export function minimalRouteSeas(
  from: ProvinceId,
  to: ProvinceId,
  fleetSeas: ReadonlySet<ProvinceId>,
): ReadonlySet<ProvinceId> {
  const out = new Set<ProvinceId>();
  if (from === to || !isCoastal(from) || !isCoastal(to)) return out;
  const adj = (a: ProvinceId, b: ProvinceId): boolean => fleetProvinceNeighbours(a).includes(b);
  const path: ProvinceId[] = [from];
  const walk = (): void => {
    const last = path[path.length - 1];
    if (path.length >= 2 && adj(last, to)) {
      // Closing with `to`: `to` must not be adjacent to s1..s(k-1).
      let ok = true;
      for (let j = 1; j < path.length - 1; j++) if (adj(path[j], to)) ok = false;
      if (ok) for (let j = 1; j < path.length; j++) out.add(path[j]);
      // Any extension would make (last, to) a chord; stop here.
      return;
    }
    for (const n of fleetProvinceNeighbours(last)) {
      if (!fleetSeas.has(n) || path.includes(n)) continue;
      let chord = false;
      for (let j = 0; j < path.length - 1; j++) if (adj(path[j], n)) chord = true;
      if (chord) continue;
      path.push(n);
      walk();
      path.pop();
    }
  };
  walk();
  return out;
}
