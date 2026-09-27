/**
 * Board-dependent legality (design §1.5.3; DATC 4.E.1 "legal" vs "valid").
 * Every raw order ends up exactly once as used, illegal(reason) or superseded.
 */

import { delta, dislodgedIndex, fleetSeas, unitIndex } from './board.ts';
import { minimalRouteSeas, routeExists } from './convoy.ts';
import {
  armyNeighbours,
  ascii,
  fleetNeighbours,
  province,
  provinceIndex,
  provinceOf,
  reach,
  reachableCoasts,
} from './map.ts';
import { formatOrder, formatRaw } from './orders.ts';
import { MAX_ORDERS } from './parse.ts';
import type {
  CoastTag,
  DipState,
  IllegalReason,
  LegalizeResult,
  NodeId,
  Order,
  OrderReport,
  Power,
  ProvinceId,
  RawLoc,
  RawOrder,
  Submissions,
  Unit,
} from './types.ts';
import { POWERS } from './types.ts';


type Verdict = { ok: true; order: Order } | { ok: false; reason: IllegalReason };
const bad = (reason: IllegalReason): Verdict => ({ ok: false, reason });
const good = (order: Order): Verdict => ({ ok: true, order });

const PHASE_KINDS: Record<'M' | 'R' | 'A', readonly RawOrder['k'][]> = {
  M: ['hold', 'move', 'support', 'convoy'],
  R: ['retreat', 'disband'],
  A: ['build', 'waive', 'disband'],
};

const realCoast = (p: ProvinceId, c: RawLoc['coast']): c is CoastTag =>
  c !== undefined && c !== 'wc' && province(p).coasts.includes(c);

/**
 * Resolve a fleet's destination node inside split-coast province `to.p` given
 * the set of reachable coasts. Implements 4.B.1–4.B.3 and 4.B.6.
 */
function resolveCoast(to: RawLoc, reachable: readonly CoastTag[], missing: IllegalReason): NodeId | IllegalReason {
  if (realCoast(to.p, to.coast)) return reachable.includes(to.coast) ? `${to.p}/${to.coast}` : 'bad_coast';
  if (reachable.length === 1) return `${to.p}/${reachable[0]}`;
  if (reachable.length >= 2) return 'coast_required';
  return missing;
}

interface Ctx {
  state: DipState;
  units: Map<ProvinceId, Unit>;
  seas: Set<ProvinceId>;
}

function checkMove(ctx: Ctx, u: Unit, o: Extract<RawOrder, { k: 'move' }>): Verdict {
  const from = provinceOf(u.at);
  const to = o.to.p;
  if (to === from) return bad('move_to_self');
  if (u.type === 'A') {
    if (province(to).kind === 'sea') return bad('army_to_sea');
    const adjacent = armyNeighbours(from).includes(to);
    if (!adjacent || o.via) {
      if (!routeExists(from, to, ctx.seas)) return bad('no_convoy_route');
      return good({ k: 'move', unit: u, to, convoyed: true });
    }
    return good({ k: 'move', unit: u, to, convoyed: false });
  }
  if (o.via) return bad('fleet_convoy');
  if (province(to).coasts.length > 0) {
    const r = resolveCoast(o.to, reachableCoasts(u.at, to), 'not_adjacent');
    if (!r.includes('/')) return bad(r as IllegalReason);
    return good({ k: 'move', unit: u, to: r, convoyed: false });
  }
  if (!fleetNeighbours(u.at).includes(to)) return bad('not_adjacent');
  return good({ k: 'move', unit: u, to, convoyed: false });
}

function checkSupport(ctx: Ctx, u: Unit, o: Extract<RawOrder, { k: 'support' }>): Verdict {
  const own = provinceOf(u.at);
  const x = ctx.units.get(o.of.p);
  if (!x) return bad('no_unit');
  const target = o.to ? o.to.p : o.of.p;
  if (target === own) return bad('support_own_area');
  if (!reach(u.type, u.at).includes(target)) return bad('support_unreachable');
  if (!o.to) return good({ k: 'support', unit: u, ofType: x.type, of: o.of.p, to: null, toCoast: null });
  const to = o.to.p;
  if (to === o.of.p) return bad('unsupportable_move');
  let toCoast: CoastTag | null = null;
  if (x.type === 'F') {
    if (province(to).coasts.length > 0) {
      const rc = reachableCoasts(x.at, to);
      if (rc.length === 0) return bad('unsupportable_move');
      if (realCoast(to, o.to.coast)) {
        if (!rc.includes(o.to.coast)) return bad('unsupportable_move');
        toCoast = o.to.coast;
      }
    } else if (!fleetNeighbours(x.at).includes(to)) {
      return bad('unsupportable_move');
    }
  } else {
    if (province(to).kind === 'sea') return bad('unsupportable_move');
    if (!armyNeighbours(o.of.p).includes(to)) {
      const seas = new Set(ctx.seas);
      seas.delete(own); // the supporter cannot also convoy (6.D.31)
      if (!routeExists(o.of.p, to, seas)) return bad('unsupportable_move');
    }
  }
  return good({ k: 'support', unit: u, ofType: x.type, of: o.of.p, to, toCoast });
}

function checkConvoy(ctx: Ctx, u: Unit, o: Extract<RawOrder, { k: 'convoy' }>): Verdict {
  const own = provinceOf(u.at);
  if (u.type !== 'F' || province(own).kind !== 'sea') return bad('convoy_from_coast');
  const x = ctx.units.get(o.of.p);
  if (!x) return bad('no_unit');
  if (x.type !== 'A') return bad('convoy_not_army');
  const to = o.to.p;
  if (to === o.of.p || province(to).kind !== 'coastal' || province(o.of.p).kind !== 'coastal') {
    return bad('convoy_bad_destination');
  }
  if (!minimalRouteSeas(o.of.p, to, ctx.seas).has(own)) return bad('convoy_not_needed');
  return good({ k: 'convoy', unit: u, ofType: 'A', of: o.of.p, to });
}

function checkRetreat(u: Unit, options: readonly NodeId[], o: Extract<RawOrder, { k: 'retreat' }>): Verdict {
  const to = o.to.p;
  if (u.type === 'F' && province(to).coasts.length > 0) {
    const coasts = options.filter((n) => provinceOf(n) === to && n.length > 3).map((n) => n.slice(4) as CoastTag);
    const r = resolveCoast(o.to, coasts, 'retreat_not_allowed');
    if (!r.includes('/')) return bad(r === 'bad_coast' ? 'retreat_not_allowed' : (r as IllegalReason));
    return good({ k: 'retreat', unit: u, to: r });
  }
  if (!options.includes(to)) return bad('retreat_not_allowed');
  return good({ k: 'retreat', unit: u, to });
}

function checkBuild(state: DipState, power: Power, occ: Map<ProvinceId, Unit>, o: Extract<RawOrder, { k: 'build' }>): Verdict {
  if (delta(state, power) <= 0) return bad('no_builds');
  const p = o.at.p;
  const def = province(p);
  if (def.home !== power) return bad('build_not_home');
  if (state.sc[p] !== power) return bad('build_not_owned');
  if (occ.has(p)) return bad('build_occupied');
  if (o.type === 'A') return good({ k: 'build', power, type: 'A', at: p });
  if (def.kind !== 'coastal') return bad('build_fleet_inland');
  if (def.coasts.length > 0) {
    if (!realCoast(p, o.at.coast)) return bad('coast_required');
    return good({ k: 'build', power, type: 'F', at: `${p}/${o.at.coast}` });
  }
  return good({ k: 'build', power, type: 'F', at: p });
}

/** One raw order → verdict, against the board only (other orders not consulted). */
function checkOne(ctx: Ctx, power: Power, o: RawOrder, dis: ReturnType<typeof dislodgedIndex>): Verdict {
  const phase = ctx.state.phase;
  if (!PHASE_KINDS[phase].includes(o.k)) return bad('wrong_phase');
  if (o.k === 'build') return checkBuild(ctx.state, power, ctx.units, o);
  if (o.k === 'waive') return delta(ctx.state, power) > 0 ? good({ k: 'waive', power }) : bad('no_builds');

  // Unit resolution: written type and coast of the ordered unit are ignored (4.B.5, 4.C.1/2).
  const at = o.at.p;
  if (phase === 'R') {
    const d = dis.get(at);
    if (!d) return bad('no_unit');
    if (d.unit.power !== power) return bad('not_your_unit');
    if (o.k === 'disband') return good({ k: 'disband', unit: d.unit });
    return checkRetreat(d.unit, d.options, o as Extract<RawOrder, { k: 'retreat' }>);
  }
  const u = ctx.units.get(at);
  if (!u) return bad('no_unit');
  if (u.power !== power) return bad('not_your_unit');
  switch (o.k) {
    case 'hold':
      return good({ k: 'hold', unit: u });
    case 'move':
      return checkMove(ctx, u, o);
    case 'support':
      return checkSupport(ctx, u, o);
    case 'convoy':
      return checkConvoy(ctx, u, o);
    case 'disband':
      return delta(ctx.state, power) < 0 ? good({ k: 'disband', unit: u }) : bad('no_disbands');
    default:
      return bad('wrong_phase');
  }
}

const orderProvince = (o: Order): ProvinceId => {
  if (o.k === 'build') return provinceOf(o.at);
  if (o.k === 'waive') return '';
  return provinceOf(o.unit.at);
};

export function legalize(state: DipState, submissions: Submissions): LegalizeResult {
  const ctx: Ctx = { state, units: unitIndex(state.units), seas: fleetSeas(state.units) };
  const dis = dislodgedIndex(state.dislodged);
  const report: OrderReport[] = [];
  // Candidates for grouped phases (M, R): unit province → [report index, order].
  const groups = new Map<ProvinceId, { ri: number; order: Order; canon: string }[]>();
  const sequential: Order[] = [];

  for (const power of POWERS) {
    const raws = submissions[power] ?? [];
    raws.forEach((raw, index) => {
      const rawText = formatRaw(raw);
      if (index >= MAX_ORDERS) {
        report.push({ power, index, raw: rawText, status: 'illegal', reason: 'too_many_orders' });
        return;
      }
      const v = checkOne(ctx, power, raw, dis);
      if (!v.ok) {
        report.push({ power, index, raw: rawText, status: 'illegal', reason: v.reason });
        return;
      }
      const canon = formatOrder(v.order);
      const ri = report.push({ power, index, raw: rawText, status: 'used', normalised: canon }) - 1;
      if (state.phase === 'A') {
        sequential.push(v.order);
      } else {
        const key = orderProvince(v.order);
        const g = groups.get(key) ?? [];
        g.push({ ri, order: v.order, canon });
        groups.set(key, g);
      }
    });
  }

  if (state.phase === 'A') return { orders: sequential, report };

  // 4.D.3 (c): identical orders collapse; differing orders for one unit are all superseded.
  let used: Order[] = [];
  for (const key of [...groups.keys()].sort(ascii)) {
    const g = groups.get(key)!;
    if (g.every((e) => e.canon === g[0].canon)) {
      used.push(g[0].order);
    } else {
      for (const e of g) {
        report[e.ri] = { ...report[e.ri], status: 'superseded' };
        delete (report[e.ri] as { normalised?: string }).normalised;
      }
    }
  }

  // Adjacent-convoy intent (2023 rules, 4.A.3): an overland-possible army move is
  // convoyed iff VIA was written (already set) or a same-power fleet has a used
  // convoy order for exactly this army and destination.
  if (state.phase === 'M') {
    used = used.map((o) => {
      if (o.k !== 'move' || o.convoyed || o.unit.type !== 'A') return o;
      const from = provinceOf(o.unit.at);
      const intent = used.some(
        (c) => c.k === 'convoy' && c.unit.power === o.unit.power && c.of === from && c.to === o.to,
      );
      if (!intent) return o;
      const conv: Order = { ...o, convoyed: true };
      // Keep the report's normalised text in step with the order actually used.
      for (let i = 0; i < report.length; i++) {
        if (report[i].status === 'used' && report[i].normalised === formatOrder(o) && report[i].power === o.unit.power) {
          report[i] = { ...report[i], normalised: formatOrder(conv) };
        }
      }
      return conv;
    });
  }
  used.sort((a, b) => provinceIndex(orderProvince(a)) - provinceIndex(orderProvince(b)));
  return { orders: used, report };
}
