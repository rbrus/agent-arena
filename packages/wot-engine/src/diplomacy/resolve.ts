/**
 * Movement-phase resolution (design §2): decisions MOVE / SUPPORT / CONVOY in
 * the DATC §5.B formulation, evaluated with partial information.
 *
 * Every derived quantity (PATH, HOLD, ATTACK, DEFEND, PREVENT) is computed at a
 * bound: an unresolved decision it depends on is replaced by the value that
 * makes the bound extreme (design §2.3 table). A decision becomes FINAL when its
 * optimistic and pessimistic evaluations agree; a final decision never flips.
 *
 * Driver (our formulation of §2.4; see README "Resolver notes"):
 *   1. Sweep the decisions in canonical order (province index), finalising any
 *      whose bounds agree, until a sweep makes no progress.
 *   2. If decisions remain unresolved, they depend on each other in cycles.
 *      Take the strongly connected components of the dependency graph among
 *      unresolved decisions (edges recorded during the last evaluation) and pick
 *      the lowest-numbered SINK component (it depends on no other unresolved
 *      component: it is a complete cycle, not something downstream of one).
 *      Apply the backup rule to it (§5.B.9):
 *        - contains a CONVOY decision  → Szykman: those CONVOYs fail;
 *        - only MOVE decisions         → circular movement: all MOVEs succeed;
 *        - anything else               → all fail + `adjudicator_anomaly`.
 *   3. Go to 1. Each backup application fixes ≥ 1 decision, so this terminates.
 *
 * All bookkeeping lives in a per-call context; no module-level mutable state,
 * no RNG, no floating point.
 */

import { routeExists } from './convoy.ts';
import { armyNeighbours, ascii, fleetNeighbours, provinceIndex, provinceOf } from './map.ts';
import { formatOrder } from './orders.ts';
import type { Dislodged, NodeId, Order, OrderResult, Power, ProvinceId, Unit } from './types.ts';

type MoveO = Extract<Order, { k: 'move' }>;
type SupO = Extract<Order, { k: 'support' }>;
type ConO = Extract<Order, { k: 'convoy' }>;

interface MoveD {
  id: number;
  power: Power;
  from: ProvinceId;
  to: ProvinceId;
  order: MoveO;
  sup: number[]; // matching support decision ids
  conv: number[]; // matching convoy decision ids
  h2h: number; // move decision id or -1
}

export interface MovementResolution {
  results: OrderResult[];
  units: Unit[]; // positions after movement, unsorted
  dislodged: Dislodged[];
  contested: ProvinceId[];
  anomaly: string[] | null;
}

export interface ResolveOptions {
  /** Test hook: permutation applied to the sweep order (order-independence property). */
  sweepOrder?: (ids: number[]) => number[];
}

export function resolveMovement(units: readonly Unit[], orders: readonly Order[], opts: ResolveOptions = {}): MovementResolution {
  const N = 75;
  const kind: ('move' | 'support' | 'convoy' | null)[] = new Array(N).fill(null);
  const val = new Int8Array(N).fill(-1);
  const unitAt: (Unit | undefined)[] = new Array(N);
  const orderAt: (Order | undefined)[] = new Array(N);
  for (const u of units) unitAt[provinceIndex(u.at)] = u;
  for (const o of orders) if (o.k !== 'build' && o.k !== 'waive') orderAt[provinceIndex(o.unit.at)] = o;

  const moves: (MoveD | undefined)[] = new Array(N);
  const movesInto: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    const o = orderAt[i];
    if (o?.k !== 'move') continue;
    const to = provinceOf(o.to);
    moves[i] = { id: i, power: o.unit.power, from: provinceOf(o.unit.at), to, order: o, sup: [], conv: [], h2h: -1 };
    movesInto[provinceIndex(to)].push(i);
    kind[i] = 'move';
  }
  const hsup: number[][] = Array.from({ length: N }, () => []);
  const isVoid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const o = orderAt[i];
    if (o?.k === 'support') {
      const s = o as SupO;
      const x = provinceIndex(s.of);
      if (s.to === null) {
        if (unitAt[x] && orderAt[x]?.k !== 'move') {
          hsup[x].push(i);
          kind[i] = 'support';
        } else isVoid[i] = 1;
      } else {
        const m = moves[x];
        const coastOk = (mo: MoveD): boolean => s.toCoast === null || mo.order.to === `${s.to}/${s.toCoast}`;
        if (m && m.to === s.to && coastOk(m)) {
          m.sup.push(i);
          kind[i] = 'support';
        } else isVoid[i] = 1;
      }
    } else if (o?.k === 'convoy') {
      const c = o as ConO;
      const m = moves[provinceIndex(c.of)];
      if (m && m.order.convoyed && m.to === c.to) {
        m.conv.push(i);
        kind[i] = 'convoy';
      } else isVoid[i] = 1;
    }
  }
  for (const m of moves) {
    if (!m || m.order.convoyed) continue;
    const back = moves[provinceIndex(m.to)];
    if (back && back.to === m.from && !back.order.convoyed) m.h2h = back.id;
  }

  // ---------------------------------------------------------------- bounded quantities
  let deps: Set<number> = new Set();
  const q = (d: number, assume: boolean): boolean => {
    if (val[d] >= 0) return val[d] === 1;
    deps.add(d);
    return assume;
  };
  const countSup = (ids: number[], max: boolean, exclude?: Power): number => {
    let n = 0;
    for (const s of ids) {
      if (exclude !== undefined && (orderAt[s] as SupO).unit.power === exclude) continue;
      if (q(s, max)) n++;
    }
    return n;
  };
  const path = (m: MoveD, max: boolean): boolean => {
    if (!m.order.convoyed) return true;
    const seas = new Set<ProvinceId>();
    for (const k of m.conv) if (q(k, max)) seas.add(provinceOf((orderAt[k] as ConO).unit.at));
    return routeExists(m.from, m.to, seas);
  };
  const hold = (p: number, max: boolean): number => {
    const u = unitAt[p];
    if (!u) return 0;
    const m = moves[p];
    if (m) return q(m.id, !max) ? 0 : 1;
    return 1 + countSup(hsup[p], max);
  };
  const attack = (m: MoveD, max: boolean): number => {
    if (!path(m, max)) return 0;
    const t = provinceIndex(m.to);
    const u = unitAt[t];
    if (!u) return 1 + countSup(m.sup, max);
    const mu = moves[t];
    if (mu && mu.id !== m.h2h && q(mu.id, max)) return 1 + countSup(m.sup, max);
    if (u.power === m.power) return 0;
    return 1 + countSup(m.sup, max, u.power);
  };
  const defend = (m: MoveD, max: boolean): number => 1 + countSup(m.sup, max);
  const prevent = (m: MoveD, max: boolean): number => {
    if (!path(m, max)) return 0;
    if (m.h2h >= 0 && q(m.h2h, !max)) return 0;
    return 1 + countSup(m.sup, max);
  };

  const adjudicate = (d: number, opt: boolean): boolean => {
    const k = kind[d];
    if (k === 'move') {
      const m = moves[d]!;
      const atk = attack(m, opt);
      if (atk === 0) return false;
      const t = provinceIndex(m.to);
      if (m.h2h >= 0) {
        if (atk <= defend(moves[m.h2h]!, !opt)) return false;
      } else if (atk <= hold(t, !opt)) return false;
      for (const other of movesInto[t]) {
        if (other === d) continue;
        if (atk <= prevent(moves[other]!, !opt)) return false;
      }
      return true;
    }
    if (k === 'support') {
      const s = orderAt[d] as SupO;
      for (const a of movesInto[d]) {
        const m = moves[a]!;
        if (m.power !== s.unit.power && (s.to === null || m.from !== s.to) && path(m, !opt)) return false;
        if (q(a, !opt)) return false;
      }
      return true;
    }
    // convoy: stands unless dislodged
    for (const a of movesInto[d]) if (q(a, !opt)) return false;
    return true;
  };

  // ---------------------------------------------------------------- driver
  let ids: number[] = [];
  for (let i = 0; i < N; i++) if (kind[i] !== null) ids.push(i);
  if (opts.sweepOrder) ids = opts.sweepOrder([...ids]);
  const depsOf = new Map<number, Set<number>>();
  let anomaly: string[] | null = null;

  for (;;) {
    let progress = true;
    while (progress) {
      progress = false;
      for (const d of ids) {
        if (val[d] >= 0) continue;
        deps = new Set();
        const hi = adjudicate(d, true);
        const lo = hi ? adjudicate(d, false) : false;
        if (hi === lo) {
          val[d] = hi ? 1 : 0;
          progress = true;
          depsOf.delete(d);
        } else {
          depsOf.set(d, deps);
        }
      }
    }
    const open = ids.filter((d) => val[d] < 0).sort((a, b) => a - b);
    if (open.length === 0) break;
    const scc = sinkComponent(open, (d) => [...(depsOf.get(d) ?? [])].filter((e) => val[e] < 0).sort((a, b) => a - b));
    const convoys = scc.filter((d) => kind[d] === 'convoy');
    if (convoys.length > 0) {
      for (const d of convoys) val[d] = 0; // Szykman
    } else if (scc.every((d) => kind[d] === 'move')) {
      for (const d of scc) val[d] = 1; // circular movement
    } else {
      anomaly = [...(anomaly ?? []), ...scc.map((d) => formatOrder(orderAt[d]!))];
      for (const d of scc) val[d] = 0;
    }
  }

  // ---------------------------------------------------------------- outcome
  deps = new Set();
  const results: OrderResult[] = [];
  for (let i = 0; i < N; i++) {
    const o = orderAt[i];
    if (!o || o.k === 'build' || o.k === 'waive') continue;
    const r: OrderResult['result'] =
      o.k === 'hold' ? 'success' : isVoid[i] ? 'void' : val[i] === 1 ? 'success' : 'failure';
    results.push({ power: o.unit.power, order: formatOrder(o), result: r });
  }

  const after: Unit[] = [];
  const occupied = new Set<ProvinceId>();
  const dislodgedRaw: { unit: Unit; by: MoveD }[] = [];
  for (let i = 0; i < N; i++) {
    const u = unitAt[i];
    if (!u) continue;
    const m = moves[i];
    if (m && val[i] === 1) {
      after.push({ ...u, at: m.order.to });
      occupied.add(m.to);
      continue;
    }
    const winner = movesInto[i].find((a) => val[a] === 1);
    if (winner !== undefined) dislodgedRaw.push({ unit: u, by: moves[winner]! });
    else {
      after.push(u);
      occupied.add(provinceOf(u.at));
    }
  }
  const contested: ProvinceId[] = [];
  for (let p = 0; p < N; p++) {
    if (movesInto[p].length === 0) continue;
    const prov = provinceOf(moves[movesInto[p][0]]!.to);
    if (occupied.has(prov)) continue;
    if (movesInto[p].some((a) => val[a] === 0 && prevent(moves[a]!, true) >= 1)) contested.push(prov);
  }
  contested.sort(ascii);
  const blocked = new Set(contested);
  const dislodged: Dislodged[] = dislodgedRaw.map(({ unit, by }) => {
    const nbrs: readonly NodeId[] = unit.type === 'A' ? armyNeighbours(provinceOf(unit.at)) : fleetNeighbours(unit.at);
    const options = nbrs
      .filter((n) => {
        const p = provinceOf(n);
        if (occupied.has(p) || blocked.has(p)) return false;
        if (p === by.from && !by.order.convoyed) return false;
        return true;
      })
      .slice()
      .sort(ascii);
    return { unit, attackerFrom: by.from, byConvoy: by.order.convoyed, options };
  });
  return { results, units: after, dislodged, contested, anomaly };
}

/** Tarjan SCC over `nodes`; returns the lowest-numbered sink component (sorted). */
function sinkComponent(nodes: number[], edges: (d: number) => number[]): number[] {
  let counter = 0;
  const idx = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const comps: number[][] = [];
  const strong = (v: number): void => {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges(v)) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const c: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        c.push(w);
      } while (w !== v);
      comps.push(c.sort((a, b) => a - b));
    }
  };
  for (const v of nodes) if (!idx.has(v)) strong(v);
  const compOf = new Map<number, number>();
  comps.forEach((c, i) => c.forEach((v) => compOf.set(v, i)));
  const sinks = comps.filter((c, i) => c.every((v) => edges(v).every((w) => compOf.get(w) === i)));
  sinks.sort((a, b) => a[0] - b[0]);
  return sinks[0] ?? comps[0];
}
