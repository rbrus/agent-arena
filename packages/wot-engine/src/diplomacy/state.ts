/**
 * Initial position, phase machine, invariants and THE pure transition
 * `adjudicate(state, submissions)` (design §1.3, §1.4, §3.4).
 */

import { byProvince, needsAdjustment, unitIndex } from './board.ts';
import { resolveAdjustments } from './builds.ts';
import { legalize } from './legalize.ts';
import { ascii, canArmyOccupy, canFleetOccupy, MAP, provinceOf } from './map.ts';
import { resolveMovement, type ResolveOptions } from './resolve.ts';
import { resolveRetreats } from './retreats.ts';
import type { DipEvent, DipState, PhaseId, PhaseOutcome, Power, ProvinceId, Submissions, Unit } from './types.ts';
import { POWERS } from './types.ts';

export const RULESET = 'wot-dip/1' as const;

const START: Record<Power, readonly [Unit['type'], string][]> = {
  austria: [['A', 'vie'], ['A', 'bud'], ['F', 'tri']],
  england: [['F', 'edi'], ['F', 'lon'], ['A', 'lvp']],
  france: [['F', 'bre'], ['A', 'mar'], ['A', 'par']],
  germany: [['F', 'kie'], ['A', 'ber'], ['A', 'mun']],
  italy: [['F', 'nap'], ['A', 'rom'], ['A', 'ven']],
  russia: [['A', 'mos'], ['A', 'war'], ['F', 'sev'], ['F', 'stp/sc']],
  turkey: [['F', 'ank'], ['A', 'con'], ['A', 'smy']],
};

export function standardCenters(): Record<ProvinceId, Power | null> {
  const sc: Record<ProvinceId, Power | null> = {};
  for (const p of MAP.provinces) if (p.sc) sc[p.id] = p.home;
  return sc;
}

export function initialState(): DipState {
  const units: Unit[] = [];
  for (const power of POWERS) for (const [type, at] of START[power]) units.push({ power, type, at });
  return normalise({ ruleset: RULESET, year: 1901, season: 'S', phase: 'M', units, dislodged: [], sc: standardCenters() });
}

export const phaseId = (s: Pick<DipState, 'season' | 'year' | 'phase'>): PhaseId => `${s.season}${s.year}${s.phase}`;

/** Sort units/dislodged by province and freeze the SC map key order. */
export function normalise(s: DipState): DipState {
  const sc: Record<ProvinceId, Power | null> = {};
  for (const k of Object.keys(s.sc).sort(ascii)) sc[k] = s.sc[k];
  return {
    ruleset: s.ruleset,
    year: s.year,
    season: s.season,
    phase: s.phase,
    units: [...s.units].sort(byProvince),
    dislodged: [...s.dislodged]
      .sort((a, b) => ascii(provinceOf(a.unit.at), provinceOf(b.unit.at)))
      .map((d) => ({ ...d, options: [...d.options].sort(ascii) })),
    sc,
  };
}

/** Fail closed on an impossible position (design §1.3; DATC 4.E.6). */
export function assertInvariants(s: DipState): void {
  const seen = new Set<ProvinceId>();
  for (const u of s.units) {
    const p = provinceOf(u.at);
    if (seen.has(p)) throw new Error(`invariant: two units in ${p}`);
    seen.add(p);
    if (u.type === 'A' && !canArmyOccupy(u.at)) throw new Error(`invariant: army cannot stand at ${u.at}`);
    if (u.type === 'F' && !canFleetOccupy(u.at)) throw new Error(`invariant: fleet cannot stand at ${u.at}`);
  }
  const scKeys = Object.keys(s.sc).sort(ascii).join(',');
  const want = MAP.provinces.filter((p) => p.sc).map((p) => p.id).join(',');
  if (scKeys !== want) throw new Error('invariant: sc keys must be exactly the 34 supply centres');
  if (s.phase !== 'R' && s.dislodged.length > 0) throw new Error('invariant: dislodged outside a retreat phase');
  const dseen = new Set<ProvinceId>();
  for (const d of s.dislodged) {
    const p = provinceOf(d.unit.at);
    if (dseen.has(p)) throw new Error(`invariant: two dislodged units from ${p}`);
    dseen.add(p);
  }
}

/** Fall SC update: every SC province occupied by a unit passes to that unit's power. */
function updateCenters(s: DipState, events: DipEvent[]): DipState {
  const sc: Record<ProvinceId, Power | null> = { ...s.sc };
  const occ = unitIndex(s.units);
  for (const p of Object.keys(sc).sort(ascii)) {
    const u = occ.get(p);
    if (u && sc[p] !== u.power) {
      events.push({ kind: 'sc_changed', province: p, from: sc[p], to: u.power });
      sc[p] = u.power;
    }
  }
  return { ...s, sc };
}

/** Advance past a finished M (no dislodgements) / R / A phase. */
function advance(s: DipState, events: DipEvent[]): DipState {
  if (s.season === 'S') return { ...s, season: 'F', phase: 'M', dislodged: [] };
  if (s.season === 'F') {
    const updated = updateCenters({ ...s, dislodged: [] }, events);
    if (needsAdjustment(updated)) return { ...updated, season: 'W', phase: 'A' };
    return { ...updated, year: s.year + 1, season: 'S', phase: 'M' };
  }
  return { ...s, year: s.year + 1, season: 'S', phase: 'M', dislodged: [] };
}

function eliminations(before: DipState, after: DipState, events: DipEvent[]): void {
  const alive = (s: DipState, p: Power): boolean =>
    s.units.some((u) => u.power === p) || s.dislodged.some((d) => d.unit.power === p) || Object.values(s.sc).includes(p);
  for (const p of POWERS) if (alive(before, p) && !alive(after, p)) events.push({ kind: 'eliminated', power: p });
}

/**
 * THE pure transition. The same function serves the DATC runner, the game loop
 * and resimulation. A power absent from `submissions` submits nothing (NMR).
 */
export function adjudicate(state: DipState, submissions: Submissions, opts: ResolveOptions = {}): PhaseOutcome {
  assertInvariants(state);
  const id = phaseId(state);
  const legal = legalize(state, submissions);
  const events: DipEvent[] = [];
  let next: DipState;
  let results;
  let contested: ProvinceId[] = [];

  if (state.phase === 'M') {
    const r = resolveMovement(state.units, legal.orders, opts);
    results = r.results;
    contested = r.contested;
    if (r.anomaly) events.push({ kind: 'adjudicator_anomaly', decisions: r.anomaly });
    for (const d of r.dislodged) events.push({ kind: 'dislodged', unit: d.unit, attackerFrom: d.attackerFrom });
    const moved: DipState = { ...state, units: r.units, dislodged: r.dislodged };
    next = r.dislodged.length > 0 ? { ...moved, phase: 'R' } : advance(moved, events);
  } else if (state.phase === 'R') {
    const r = resolveRetreats(state.dislodged, legal.orders);
    results = r.results;
    events.push(...r.events);
    next = advance({ ...state, units: [...state.units, ...r.placed], dislodged: [] }, events);
  } else {
    const r = resolveAdjustments(state, legal.orders);
    results = r.results;
    events.push(...r.events);
    next = advance({ ...state, units: r.units }, events);
  }
  next = normalise(next);
  eliminations(state, next, events);
  assertInvariants(next);
  return { phaseId: id, legal, results, next, contested, events };
}
