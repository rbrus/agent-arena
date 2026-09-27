/**
 * Retreat-phase adjudication (design §3.2). Retreat options were fixed at the
 * end of movement (resolve.ts); here only collisions matter: two or more
 * retreats to one PROVINCE all fail (6.H.7, 6.H.8). No supports, no convoys.
 */

import { provinceOf } from './map.ts';
import { formatOrder } from './orders.ts';
import type { DipEvent, Dislodged, Order, OrderResult, Unit } from './types.ts';

export function resolveRetreats(
  dislodged: readonly Dislodged[],
  orders: readonly Order[],
): { placed: Unit[]; results: OrderResult[]; events: DipEvent[] } {
  const retreats = orders.filter((o): o is Extract<Order, { k: 'retreat' }> => o.k === 'retreat');
  const count = new Map<string, number>();
  for (const r of retreats) count.set(provinceOf(r.to), (count.get(provinceOf(r.to)) ?? 0) + 1);
  const placed: Unit[] = [];
  const results: OrderResult[] = [];
  const events: DipEvent[] = [];
  const handled = new Set<string>();
  for (const o of orders) {
    if (o.k !== 'retreat' && o.k !== 'disband') continue;
    handled.add(provinceOf(o.unit.at));
    if (o.k === 'retreat' && count.get(provinceOf(o.to)) === 1) {
      placed.push({ ...o.unit, at: o.to });
      results.push({ power: o.unit.power, order: formatOrder(o), result: 'success' });
    } else {
      results.push({ power: o.unit.power, order: formatOrder(o), result: o.k === 'disband' ? 'success' : 'failure' });
      events.push({ kind: 'retreat_disbanded', unit: o.unit });
    }
  }
  for (const d of dislodged) {
    if (!handled.has(provinceOf(d.unit.at))) events.push({ kind: 'retreat_disbanded', unit: d.unit });
  }
  return { placed, results, events };
}
