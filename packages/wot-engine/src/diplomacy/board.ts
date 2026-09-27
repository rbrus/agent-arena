/**
 * Pure board queries shared by legalize/resolve/builds/state. No phase logic.
 */

import { ascii, MAP, province, provinceOf } from './map.ts';
import type { DipState, Dislodged, Power, ProvinceId, Unit } from './types.ts';
import { POWERS } from './types.ts';

export const byProvince = <T extends { at: string }>(a: T, b: T): number =>
  ascii(provinceOf(a.at), provinceOf(b.at));

/** Units keyed by province id. */
export function unitIndex(units: readonly Unit[]): Map<ProvinceId, Unit> {
  const m = new Map<ProvinceId, Unit>();
  for (const u of units) m.set(provinceOf(u.at), u);
  return m;
}
export function dislodgedIndex(ds: readonly Dislodged[]): Map<ProvinceId, Dislodged> {
  const m = new Map<ProvinceId, Dislodged>();
  for (const d of ds) m.set(provinceOf(d.unit.at), d);
  return m;
}

/** Sea provinces currently holding a fleet (any power, any order). */
export function fleetSeas(units: readonly Unit[]): Set<ProvinceId> {
  const s = new Set<ProvinceId>();
  for (const u of units) if (u.type === 'F' && province(provinceOf(u.at)).kind === 'sea') s.add(provinceOf(u.at));
  return s;
}

export function scCount(state: DipState, power: Power): number {
  let n = 0;
  for (const p of Object.keys(state.sc)) if (state.sc[p] === power) n++;
  return n;
}
export function unitCount(state: DipState, power: Power): number {
  let n = 0;
  for (const u of state.units) if (u.power === power) n++;
  return n;
}
/** Adjustment delta: #owned SCs − #units (derived, never stored). */
export function delta(state: DipState, power: Power): number {
  return scCount(state, power) - unitCount(state, power);
}
/** Owned, unoccupied home centres of `power` (province ids, sorted). */
export function buildableSites(state: DipState, power: Power): ProvinceId[] {
  const occ = unitIndex(state.units);
  return MAP.provinces
    .filter((p) => p.home === power && state.sc[p.id] === power && !occ.has(p.id))
    .map((p) => p.id);
}
export function needsAdjustment(state: DipState): boolean {
  for (const p of POWERS) {
    const d = delta(state, p);
    if (d < 0) return true;
    if (d > 0 && buildableSites(state, p).length > 0) return true;
  }
  return false;
}
