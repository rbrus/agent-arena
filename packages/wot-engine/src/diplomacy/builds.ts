/**
 * Adjustment phase (design §3.3): sequential, "first legal wins" per power in
 * submission order (4.D.4 b, 4.D.5 b, 4.D.6 b), then the 2023 civil-disorder
 * removal for any shortfall (4.D.8; 6.J.3–6.J.11).
 */

import { delta } from './board.ts';
import { ascii, province, provinceOf, unionDistance } from './map.ts';
import { formatOrder } from './orders.ts';
import type { DipEvent, DipState, Order, OrderResult, Power, ProvinceId, Unit } from './types.ts';
import { POWERS } from './types.ts';

export function resolveAdjustments(
  state: DipState,
  orders: readonly Order[],
): { units: Unit[]; results: OrderResult[]; events: DipEvent[] } {
  let units: Unit[] = [...state.units];
  const results: OrderResult[] = [];
  const events: DipEvent[] = [];

  for (const power of POWERS) {
    const d = delta(state, power);
    const mine = orders.filter((o) =>
      o.k === 'build' || o.k === 'waive' ? o.power === power : o.k === 'disband' && o.unit.power === power,
    );
    if (d > 0) {
      let used = 0;
      const built = new Set<ProvinceId>();
      for (const o of mine) {
        if (o.k === 'waive') {
          const ok = used < d;
          if (ok) used++;
          results.push({ power, order: 'W', result: ok ? 'success' : 'failure' });
        } else if (o.k === 'build') {
          const p = provinceOf(o.at);
          const ok = used < d && !built.has(p);
          if (ok) {
            used++;
            built.add(p);
            const u: Unit = { power, type: o.type, at: o.at };
            units.push(u);
            events.push({ kind: 'built', unit: u });
          }
          results.push({ power, order: formatOrder(o), result: ok ? 'success' : 'failure' });
        }
      }
    } else if (d < 0) {
      const owed = -d;
      let removed = 0;
      for (const o of mine) {
        if (o.k !== 'disband') continue;
        const p = provinceOf(o.unit.at);
        const present = units.some((u) => provinceOf(u.at) === p);
        const ok = removed < owed && present;
        if (ok) {
          removed++;
          units = units.filter((u) => provinceOf(u.at) !== p);
          events.push({ kind: 'removed', unit: o.unit });
        }
        results.push({ power, order: formatOrder(o), result: ok ? 'success' : 'failure' });
      }
      const owned = new Set<ProvinceId>(Object.keys(state.sc).filter((p) => state.sc[p] === power));
      while (removed < owed) {
        const victim = civilDisorderVictim(units, power, owned);
        if (!victim) break;
        units = units.filter((u) => u !== victim);
        removed++;
        events.push({ kind: 'civil_disorder_removed', unit: victim });
      }
    }
  }
  return { units, results, events };
}

/**
 * 2023 rule: greatest union-graph distance to an OWNED supply centre; ties:
 * fleet before army, then the province's English name in ASCII order.
 */
export function civilDisorderVictim(units: readonly Unit[], power: Power, owned: ReadonlySet<ProvinceId>): Unit | null {
  let best: { u: Unit; dist: number; name: string } | null = null;
  for (const u of units) {
    if (u.power !== power) continue;
    const dist = owned.size === 0 ? 0 : unionDistance(provinceOf(u.at), owned);
    const name = province(provinceOf(u.at)).name;
    if (
      !best ||
      dist > best.dist ||
      (dist === best.dist && u.type === 'F' && best.u.type === 'A') ||
      (dist === best.dist && u.type === best.u.type && ascii(name, best.name) < 0)
    ) {
      best = { u, dist, name };
    }
  }
  return best?.u ?? null;
}
