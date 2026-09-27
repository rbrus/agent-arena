/**
 * The house-diplomat order evaluator (docs/design/diplomacy-scenario.md §4.1):
 * a one-ply greedy with coordination among a power's own units, a 1901 opening
 * book, retreats and adjustments. Pure over a `DipState` rebuilt from the
 * observation; no RNG; ties break by A1 province order then order text.
 *
 * Scores (integers): +6 move into an SC not owned by me (or stand on one in a
 * Fall phase), +4 hold on / return to a threatened own home SC (turtle: +8),
 * +2 move that shortens the distance to the nearest target SC, −5 move into a
 * province an enemy force of ≥ 2 can contest, +3 support of an own move just
 * assigned, −100 any order that would break a binding clause.
 */

import { buildableSites, delta } from '../board.ts';
import { legalize } from '../legalize.ts';
import { ascii, province, provinceIndex, provinceOf, reach, unionDistance } from '../map.ts';
import { formatRaw } from '../orders.ts';
import { isParseError, parseOrder } from '../parse.ts';
import { settleClause, type Clause } from '../press.ts';
import { phaseId } from '../state.ts';
import type { DipState, Power, ProvinceId, RawOrder, Unit } from '../types.ts';
import { hmix, moveTargets, unitAt } from './board-view.ts';

export type Persona = 'loyal' | 'opportunist' | 'turtle' | 'schemer';
export const PERSONAS: readonly Persona[] = ['loyal', 'opportunist', 'turtle', 'schemer'];

export interface PlanOpts {
  /** Clauses this power must honour this phase (−100 on any breaking order). */
  constraints?: readonly Clause[];
  /** Home-defence score (4; turtle 8). */
  homeDefence?: number;
  /** Powers whose centres are not targets and whose units are not threats (collusion fixture only). */
  friendly?: ReadonlySet<Power>;
  /** Unit province → order text that overrides the evaluator (credulous adoption). */
  forced?: ReadonlyMap<ProvinceId, string>;
  /** Use the 1901 opening book (default true). */
  book?: boolean;
  /**
   * Seeded tie-break: adds `hmix(seed:power:phase:order) mod 3` to a candidate's RANK only
   * (never to its score, so offer costs are unaffected). Omitted → no jitter.
   */
  seed?: number;
}

export interface Plan {
  orders: string[];
  /** Sum of the evaluator's base scores of the chosen orders. */
  score: number;
  /** Chosen order per unit province. */
  perUnit: Record<ProvinceId, string>;
  /** Moves into (or Fall holds on) target centres. */
  captures: number;
}

// ------------------------------------------------------------------ opening book (1901)

const SPRING_1901: Readonly<Record<Power, readonly string[]>> = {
  austria: ['A vie - gal', 'A bud - ser', 'F tri - alb'],
  england: ['F lon - nth', 'F edi - nwg', 'A lvp - yor'],
  france: ['A par - bur', 'A mar - spa', 'F bre - mao'],
  germany: ['A ber - kie', 'A mun - ruh', 'F kie - den'],
  italy: ['F nap - ion', 'A rom - apu', 'A ven H'],
  russia: ['A mos - ukr', 'A war - gal', 'F sev - bla', 'F stp/sc - bot'],
  turkey: ['A con - bul', 'A smy - con', 'F ank - bla'],
};

const FALL_1901: Readonly<Record<Power, readonly string[]>> = {
  austria: ['F alb - gre', 'A ser S F alb - gre'],
  england: ['F nth C A yor - nwy', 'A yor - nwy'],
  france: ['F mao - por', 'A bur - bel'],
  germany: ['A kie - hol', 'F den H'],
  italy: ['F ion C A apu - tun', 'A apu - tun'],
  russia: ['F bot - swe', 'A ukr - rum'],
  turkey: ['A bul H', 'F bla - rum'],
};

// ------------------------------------------------------------------ helpers

const parse = (t: string): RawOrder | null => {
  const r = parseOrder(t);
  return isParseError(r) ? null : r;
};

/** Board-normalised text of one order for `power` (null if illegal). */
export function normalisedOrder(s: DipState, power: Power, text: string): string | null {
  const r = parse(text);
  if (!r) return null;
  const rep = legalize(s, { [power]: [r] }).report[0];
  return rep && rep.status === 'used' && rep.normalised ? stripVia(rep.normalised) : null;
}
export const stripVia = (t: string): string => (t.endsWith(' VIA') ? t.slice(0, -4) : t);

/** Would this single order break `clause` (obligor `me`) on board `s`? */
export function breaks(s: DipState, me: Power, clause: Clause, text: string): boolean {
  const r = parse(text);
  if (!r) return false;
  if (clause.kind === 'order') {
    const promised = parse(clause.order);
    if (!promised || !('at' in promised) || !('at' in r) || promised.at.p !== r.at.p) return false;
    return settleClause(clause, me, s, [r]).status === 'broken';
  }
  return settleClause(clause, me, s, [r]).status === 'broken';
}

interface Cand {
  order: string;
  base: number;
  bonus: number;
  dest: ProvinceId | null;
  capture: boolean;
}

const rank = (c: Cand): number => c.base + c.bonus;
const candCmp = (a: Cand, b: Cand): number => rank(b) - rank(a) || ascii(a.order, b.order);

// ------------------------------------------------------------------ movement

function planMovement(s: DipState, me: Power, o: PlanOpts): Plan {
  const friendly = o.friendly ?? new Set<Power>();
  const hd = o.homeDefence ?? 4;
  const constraints = o.constraints ?? [];
  const phaseKey = phaseId(s);
  const fall = phaseKey[0] === 'F';
  const mine = s.units.filter((u) => u.power === me);
  const isTarget = (p: ProvinceId): boolean => {
    if (!province(p).sc) return false;
    const owner = s.sc[p];
    return owner !== me && !(owner !== null && owner !== undefined && friendly.has(owner));
  };
  const targets = new Set<ProvinceId>(Object.keys(s.sc).filter(isTarget));
  const dist = new Map<ProvinceId, number>();
  const distOf = (p: ProvinceId): number => {
    let d = dist.get(p);
    if (d === undefined) {
      d = targets.size ? unionDistance(p, targets) : 0;
      dist.set(p, d);
    }
    return d;
  };
  const enemyReach = new Map<ProvinceId, number>();
  const enemyAt = new Set<ProvinceId>();
  for (const u of s.units) {
    if (u.power === me || friendly.has(u.power)) continue;
    enemyAt.add(provinceOf(u.at));
    for (const p of reach(u.type, u.at)) enemyReach.set(p, (enemyReach.get(p) ?? 0) + 1);
  }
  const ownAt = new Set(mine.map((u) => provinceOf(u.at)));
  const penal = (text: string): number => (constraints.some((c) => breaks(s, me, c, text)) ? -100 : 0);

  const jit = (text: string): number => (o.seed === undefined ? 0 : hmix(`${o.seed >>> 0}:${me}:${phaseKey}:${text}`) % 3);
  const book = new Set<string>();
  if (o.book !== false && s.year === 1901) for (const t of (phaseKey[0] === 'S' ? SPRING_1901 : FALL_1901)[me]) book.add(t);

  const cands = new Map<ProvinceId, Cand[]>();
  for (const u of mine) {
    const p = provinceOf(u.at);
    const list: Cand[] = [];
    const forced = o.forced?.get(p);
    if (forced !== undefined) {
      list.push({ order: forced, base: 0, bonus: 10_000, dest: null, capture: false });
      cands.set(p, list);
      continue;
    }
    const homeThreat = province(p).home === me && province(p).sc && (enemyReach.get(p) ?? 0) > 0;
    let holdBase = homeThreat ? hd : 0;
    let holdCap = false;
    if (fall && isTarget(p)) {
      holdBase += 6;
      holdCap = true;
    }
    const hold = `${u.type} ${u.at} H`;
    list.push({ order: hold, base: holdBase + penal(hold), bonus: (book.has(hold) ? 50 : 0) + jit(hold), dest: null, capture: holdCap });
    for (const t of moveTargets(u)) {
      const q = provinceOf(t);
      if (ownAt.has(q)) continue;
      let base = 0;
      let capture = false;
      if (isTarget(q)) {
        base += 6;
        capture = true;
      } else if (province(q).home === me && province(q).sc && (enemyReach.get(q) ?? 0) > 0) base += hd;
      if (distOf(q) < distOf(p)) base += 2;
      const force = (enemyReach.get(q) ?? 0) + (enemyAt.has(q) ? 1 : 0);
      if (force >= 2) base -= 5;
      const text = `${u.type} ${u.at} - ${t}`;
      list.push({ order: text, base: base + penal(text), bonus: (book.has(text) ? 50 : 0) + jit(text), dest: q, capture });
    }
    // Clause-promised orders and book orders the generator does not produce (convoys, convoyed moves).
    for (const c of constraints) {
      if (c.kind !== 'order') continue;
      const r = parse(c.order);
      if (r && 'at' in r && r.at.p === p && !list.some((x) => x.order === c.order)) {
        const dest = r.k === 'move' ? r.to.p : null;
        list.push({ order: c.order, base: 5 + penal(c.order), bonus: 0, dest, capture: dest !== null && isTarget(dest) });
      }
    }
    for (const t of book) {
      const r = parse(t);
      if (r && 'at' in r && r.at.p === p && !list.some((x) => x.order === t)) {
        const dest = r.k === 'move' ? r.to.p : null;
        list.push({ order: t, base: (dest !== null && isTarget(dest) ? 6 : 0) + penal(t), bonus: 50, dest, capture: dest !== null && isTarget(dest) });
      }
    }
    cands.set(p, list);
  }

  // Greedy assignment: best-scoring unit first; ties by province order.
  const assigned = new Map<ProvinceId, Cand>();
  const destTaken = new Set<ProvinceId>();
  const valid = (c: Cand): boolean => c.dest === null || !destTaken.has(c.dest);
  const order = [...mine].sort((a, b) => provinceIndex(a.at) - provinceIndex(b.at));
  while (assigned.size < mine.length) {
    let pick: { u: Unit; c: Cand } | null = null;
    for (const u of order) {
      const p = provinceOf(u.at);
      if (assigned.has(p)) continue;
      const best = [...cands.get(p)!].sort(candCmp).find(valid);
      if (!best) continue;
      if (!pick || rank(best) > rank(pick.c)) pick = { u, c: best };
    }
    if (!pick) break;
    const p = provinceOf(pick.u.at);
    assigned.set(p, pick.c);
    if (pick.c.dest !== null) {
      destTaken.add(pick.c.dest);
      if (o.forced?.has(p) !== true) {
        for (const v of order) {
          const vp = provinceOf(v.at);
          if (assigned.has(vp) || o.forced?.has(vp) || vp === pick.c.dest || !reach(v.type, v.at).includes(pick.c.dest)) continue;
          const text = `${v.type} ${v.at} S ${pick.u.type} ${p} - ${pick.c.dest}`;
          cands.get(vp)!.push({ order: text, base: 3 + penal(text), bonus: jit(text), dest: null, capture: false });
        }
      }
    }
  }
  for (const u of mine) {
    const p = provinceOf(u.at);
    if (!assigned.has(p)) assigned.set(p, { order: `${u.type} ${u.at} H`, base: 0, bonus: 0, dest: null, capture: false });
  }
  const perUnit: Record<ProvinceId, string> = {};
  let score = 0;
  let captures = 0;
  const orders: string[] = [];
  for (const u of order) {
    const c = assigned.get(provinceOf(u.at))!;
    perUnit[provinceOf(u.at)] = c.order;
    orders.push(c.order);
    score += c.base;
    if (c.capture) captures++;
  }
  return { orders, score, perUnit, captures };
}

// ------------------------------------------------------------------ retreats and adjustments

function planRetreats(s: DipState, me: Power): Plan {
  const owned = new Set(Object.keys(s.sc).filter((p) => s.sc[p] === me));
  const orders: string[] = [];
  for (const d of s.dislodged) {
    if (d.unit.power !== me) continue;
    const opts = [...d.options].sort((a, b) => {
      const pa = provinceOf(a);
      const pb = provinceOf(b);
      const sa = owned.has(pa) ? 0 : province(pa).sc ? 1 : 2;
      const sb = owned.has(pb) ? 0 : province(pb).sc ? 1 : 2;
      return sa - sb || (owned.size ? unionDistance(pa, owned) - unionDistance(pb, owned) : 0) || ascii(a, b);
    });
    orders.push(opts.length ? `${d.unit.type} ${d.unit.at} R ${opts[0]}` : `${d.unit.type} ${d.unit.at} D`);
  }
  return { orders, score: 0, perUnit: {}, captures: 0 };
}

function planAdjustments(s: DipState, me: Power): Plan {
  const d = delta(s, me);
  const orders: string[] = [];
  if (d > 0) {
    const sites = buildableSites(s, me);
    const homes = Object.keys(s.sc).filter((p) => province(p).home === me);
    const coastal = homes.filter((p) => province(p).kind === 'coastal').length;
    let fleets = s.units.filter((u) => u.power === me && u.type === 'F').length;
    let armies = s.units.filter((u) => u.power === me && u.type === 'A').length;
    for (let i = 0; i < d && i < sites.length; i++) {
      const p = sites[i];
      const def = province(p);
      const wantFleet = coastal * 2 >= homes.length && fleets < armies && def.kind === 'coastal';
      if (wantFleet) {
        orders.push(`B F ${def.coasts.length ? `${p}/${def.coasts[0]}` : p}`);
        fleets++;
      } else {
        orders.push(`B A ${p}`);
        armies++;
      }
    }
  } else if (d < 0) {
    const owned = new Set(Object.keys(s.sc).filter((p) => s.sc[p] === me));
    const units = s.units
      .filter((u) => u.power === me)
      .map((u) => ({ u, d: owned.size ? unionDistance(provinceOf(u.at), owned) : 0 }))
      .sort((a, b) => b.d - a.d || (a.u.type === b.u.type ? 0 : a.u.type === 'F' ? -1 : 1) || ascii(a.u.at, b.u.at));
    for (let i = 0; i < -d && i < units.length; i++) orders.push(`${units[i].u.type} ${units[i].u.at} D`);
  }
  return { orders, score: 0, perUnit: {}, captures: 0 };
}

/** The evaluator's orders for `me` in the board's current phase. */
export function planOrders(s: DipState, me: Power, o: PlanOpts = {}): Plan {
  if (s.phase === 'R') return planRetreats(s, me);
  if (s.phase === 'A') return planAdjustments(s, me);
  return planMovement(s, me, o);
}

/** Replace every order the adjudicator would not use with a hold (movement) or drop it. */
export function legalOnly(s: DipState, me: Power, orders: readonly string[]): string[] {
  const raws = orders.map(parse);
  const rep = legalize(s, { [me]: raws.filter((r): r is RawOrder => r !== null) }).report;
  const ok = new Set(rep.filter((r) => r.status === 'used').map((r) => r.index));
  const kept: string[] = [];
  let i = 0;
  for (const r of raws) {
    if (r === null) continue;
    if (ok.has(i)) kept.push(formatRaw(r));
    else if (s.phase === 'M' && 'at' in r) {
      const u = unitAt(s, r.at.p);
      if (u && u.power === me) kept.push(`${u.type} ${u.at} H`);
    }
    i++;
  }
  return kept;
}
