/**
 * Terminal conditions and the outcome record (docs/design/diplomacy-adjudicator.md §6.5).
 * Pure; evaluated by the scenario after every adjudicated phase.
 *
 * Precedence when several hold at once: solo > last_standing > horizon.
 * Solo and horizon are only evaluated right after a Fall SC update (the phase
 * just adjudicated was a Fall phase and the next state has left Fall), because
 * only then can SC counts change. Last-standing is evaluated after every phase.
 */

import { scCount, unitCount } from './board.ts';
import type { DipState, PhaseId, Power } from './types.ts';
import { POWERS } from './types.ts';

export const SOLO_CENTRES = 18;
export const DEFAULT_HORIZON_YEAR = 1908;

export type DipTerminalKind = 'solo' | 'horizon' | 'last_standing';

export interface DipStanding {
  power: Power;
  sc: number;
  units: number;
  /** 1-based; equal (sc, units) share a rank. Default ranking pending A2 (design §8). */
  rank: number;
}

export interface DipTerminal {
  kind: DipTerminalKind;
  /** The phase whose adjudication ended the game. */
  phaseId: PhaseId;
  year: number;
  winner: Power | null;
  sc: Readonly<Record<Power, number>>;
  units: Readonly<Record<Power, number>>;
  eliminated: readonly Power[];
  standings: readonly DipStanding[];
}

export function centreCounts(s: DipState): Record<Power, number> {
  const out = {} as Record<Power, number>;
  for (const p of POWERS) out[p] = scCount(s, p);
  return out;
}

export function unitCounts(s: DipState): Record<Power, number> {
  const out = {} as Record<Power, number>;
  for (const p of POWERS) out[p] = unitCount(s, p) + s.dislodged.filter((d) => d.unit.power === p).length;
  return out;
}

/** Powers that still have a unit (incl. dislodged) or a supply centre, POWERS order. */
export function alivePowers(s: DipState): Power[] {
  const sc = centreCounts(s);
  const units = unitCounts(s);
  return POWERS.filter((p) => sc[p] > 0 || units[p] > 0);
}

export function standings(s: DipState): DipStanding[] {
  const sc = centreCounts(s);
  const units = unitCounts(s);
  const rows = POWERS.map((p) => ({ power: p, sc: sc[p], units: units[p], rank: 0 }));
  const sorted = [...rows].sort((a, b) => b.sc - a.sc || b.units - a.units || POWERS.indexOf(a.power) - POWERS.indexOf(b.power));
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    r.rank = prev && prev.sc === r.sc && prev.units === r.units ? prev.rank : i + 1;
  });
  return sorted;
}

const yearOf = (ph: PhaseId): number => Number(ph.slice(1, 5));

/** True iff adjudicating `adjudicated` (a phase id) just applied the Fall SC update to reach `next`. */
export function fallUpdateHappened(adjudicated: PhaseId, next: DipState): boolean {
  return adjudicated.startsWith('F') && next.season !== 'F';
}

/**
 * The terminal check after adjudicating phase `adjudicated`, whose result is `next`.
 * Horizon: the year just finished is ≥ `horizonYear` (W<horizon>A is not played).
 */
export function checkTerminal(adjudicated: PhaseId, next: DipState, horizonYear: number): DipTerminal | null {
  const sc = centreCounts(next);
  const units = unitCounts(next);
  const alive = alivePowers(next);
  const eliminated = POWERS.filter((p) => !alive.includes(p));
  const year = yearOf(adjudicated);
  const make = (kind: DipTerminalKind, winner: Power | null): DipTerminal => ({
    kind,
    phaseId: adjudicated,
    year,
    winner,
    sc,
    units,
    eliminated,
    standings: standings(next),
  });
  const fall = fallUpdateHappened(adjudicated, next);
  if (fall) {
    const solo = POWERS.find((p) => sc[p] >= SOLO_CENTRES);
    if (solo) return make('solo', solo);
  }
  if (alive.length <= 1) return make('last_standing', alive[0] ?? null);
  if (fall && year >= horizonYear) return make('horizon', null);
  return null;
}
