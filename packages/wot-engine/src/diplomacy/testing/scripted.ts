/**
 * Deterministic engine-test policy (design §5.1 testing/scripted.ts): a seeded
 * "busy" player that emits TEXT orders (so the parser is on the path) covering
 * holds, moves, supports, convoys, retreats, builds and waives. Engine tests use
 * this instead of the B5 reference agents. Not a strategy; a coverage driver.
 */

import { hash32, mulberry32 } from '../../rng.ts';
import { buildableSites, delta } from '../board.ts';
import { armyNeighbours, fleetNeighbours, province, provinceOf, reach } from '../map.ts';
import { phaseId } from '../state.ts';
import type { DipState, Power } from '../types.ts';
import { POWERS } from '../types.ts';

export function scriptedOrders(state: DipState, seed: number): Record<Power, string[]> {
  const out = {} as Record<Power, string[]>;
  const ph = phaseId(state);
  for (const power of POWERS) {
    const rng = mulberry32(hash32(`${seed}:${power}:${ph}`));
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
    const orders: string[] = [];
    if (state.phase === 'M') {
      // Coordinated attacks first: a mover and a supporter against a foreign unit.
      const mine = state.units.filter((x) => x.power === power);
      const busy = new Set<string>();
      for (const mover of mine) {
        if (busy.has(mover.at) || rng() < 0.4) continue;
        for (const helper of mine) {
          if (helper === mover || busy.has(helper.at) || busy.has(mover.at)) continue;
          const common = reach(mover.type, mover.at).filter(
            (t) =>
              reach(helper.type, helper.at).includes(t) &&
              (mover.type === 'A' ? armyNeighbours(provinceOf(mover.at)).includes(t) : fleetNeighbours(mover.at).includes(t)) &&
              state.units.some((e) => e.power !== power && provinceOf(e.at) === t),
          );
          if (!common.length) continue;
          const t = pick(common);
          orders.push(`${mover.type} ${mover.at} - ${t}`, `${helper.type} ${helper.at} S ${mover.type} ${provinceOf(mover.at)} - ${t}`);
          busy.add(mover.at);
          busy.add(helper.at);
        }
      }
      for (const u of mine) {
        if (busy.has(u.at)) continue;
        const r = rng();
        const here = provinceOf(u.at);
        if (r < 0.15) orders.push(`${u.type} ${u.at} H`);
        else if (r < 0.7) {
          const ns = u.type === 'A' ? armyNeighbours(here) : fleetNeighbours(u.at);
          if (ns.length) orders.push(`${u.type} ${u.at} - ${pick(ns)}`);
        } else if (r < 0.9) {
          // Support an own unit's likely attack into a province both can reach
          // (produces dislodgements, hence retreat phases), else a hold support.
          const targets = reach(u.type, u.at);
          const mates = state.units.filter((x) => x !== u && x.power === power);
          const attack = mates
            .map((x) => ({ x, t: reach(x.type, x.at).filter((p) => targets.includes(p)) }))
            .find((e) => e.t.length > 0);
          if (attack && rng() < 0.6) {
            orders.push(`${u.type} ${u.at} S ${attack.x.type} ${provinceOf(attack.x.at)} - ${pick(attack.t)}`);
          } else {
            const friend = state.units.find((x) => x !== u && targets.includes(provinceOf(x.at)));
            orders.push(friend ? `${u.type} ${u.at} S ${friend.type} ${provinceOf(friend.at)}` : `${u.type} ${u.at} H`);
          }
        } else if (u.type === 'F' && province(here).kind === 'sea') {
          const army = state.units.find((x) => x.type === 'A' && fleetNeighbours(here).some((n) => provinceOf(n) === provinceOf(x.at)));
          const land = fleetNeighbours(u.at).map(provinceOf).filter((p) => province(p).kind === 'coastal');
          if (army && land.length) orders.push(`F ${here} C A ${provinceOf(army.at)} - ${pick(land)}`);
        } else if (u.type === 'A') {
          const far = pick(['bel', 'hol', 'den', 'nwy', 'lon', 'tun', 'gre', 'con', 'naf', 'por']);
          orders.push(`A ${here} - ${far}`); // often illegal/no route: exercises legalize
        }
      }
    } else if (state.phase === 'R') {
      for (const d of state.dislodged.filter((x) => x.unit.power === power)) {
        if (d.options.length && rng() < 0.8) orders.push(`${d.unit.type} ${d.unit.at} R ${pick(d.options)}`);
        else if (rng() < 0.5) orders.push(`${d.unit.type} ${d.unit.at} D`);
      }
    } else {
      const dl = delta(state, power);
      if (dl > 0) {
        const sites = buildableSites(state, power);
        for (let i = 0; i < dl; i++) {
          if (!sites.length || rng() < 0.2) {
            orders.push('W');
            continue;
          }
          const p = sites.splice(Math.floor(rng() * sites.length), 1)[0];
          const def = province(p);
          if (def.kind === 'coastal' && rng() < 0.5) orders.push(`B F ${def.coasts.length ? `${p}/${def.coasts[0]}` : p}`);
          else orders.push(`B A ${p}`);
        }
      } else if (dl < 0 && rng() < 0.5) {
        // Remove one voluntarily; leave the rest to the civil-disorder rule.
        const u = pick(state.units.filter((x) => x.power === power));
        orders.push(`${u.type} ${u.at} D`);
      }
    }
    out[power] = orders;
  }
  return out;
}
