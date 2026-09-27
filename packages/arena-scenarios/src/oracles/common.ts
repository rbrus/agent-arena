/**
 * Oracle plumbing (arena-scenarios.md §1.5): verdict constructors that enforce
 * the contract invariants (pass / not_assessed are always `note`; not_assessed
 * carries a reason; evidence ≤ 32 ascending ticks; measure keys are contract
 * safe), percentiles, and the squad "worst member decides" reducer.
 */

import type { OracleVerdict, SeatId, Severity } from '../types.ts';

export interface VerdictExtras {
  measure?: Record<string, number>;
  thresholds?: Record<string, number>;
  ticks?: readonly number[];
  basis?: 'resim' | 'attested';
  code?: string;
  message?: string;
}

const MEASURE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

function cleanNumbers(r: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r ?? {})) {
    if (!MEASURE_KEY.test(k)) throw new Error(`measure key ${k} violates the contract pattern`);
    if (!Number.isFinite(v)) continue;
    out[k] = Math.round(v * 10000) / 10000;
  }
  if (Object.keys(out).length > 16) throw new Error('at most 16 measures/thresholds per verdict');
  return out;
}

export function evidence(ticks: readonly number[] | undefined): number[] {
  return [...new Set(ticks ?? [])].sort((a, b) => a - b).slice(0, 32);
}

export function pass(oracleId: string, seat: SeatId, x: VerdictExtras = {}): OracleVerdict {
  return {
    oracleId,
    seat,
    status: 'pass',
    severity: 'note',
    measure: cleanNumbers(x.measure),
    thresholds: cleanNumbers(x.thresholds),
    evidenceTicks: evidence(x.ticks),
    basis: x.basis ?? 'resim',
  };
}

export function fail(oracleId: string, seat: SeatId, severity: Severity, x: VerdictExtras & { code: string; message: string }): OracleVerdict {
  return {
    oracleId,
    seat,
    status: 'fail',
    severity,
    measure: cleanNumbers(x.measure),
    thresholds: cleanNumbers(x.thresholds),
    evidenceTicks: evidence(x.ticks),
    basis: x.basis ?? 'resim',
    code: x.code,
    message: x.message.slice(0, 280),
  };
}

export function notAssessed(oracleId: string, seat: SeatId, reason: string, x: VerdictExtras = {}): OracleVerdict {
  return {
    oracleId,
    seat,
    status: 'not_assessed',
    severity: 'note',
    measure: cleanNumbers(x.measure),
    thresholds: cleanNumbers(x.thresholds),
    evidenceTicks: [],
    basis: x.basis ?? 'resim',
    reason,
  };
}

/** Nearest-rank percentile over integers (empty → null). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export const fmtPct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Worst-member reducer for squad mode: returns the member whose score is worst
 * (higher = worse), ties → lowest member id. Members with a null score are
 * skipped (not assessable for that member).
 */
export function worst<T>(per: ReadonlyMap<string, T | null>, score: (t: T) => number): { member: string; value: T } | null {
  let best: { member: string; value: T; s: number } | null = null;
  for (const m of [...per.keys()].sort()) {
    const v = per.get(m);
    if (v == null) continue;
    const s = score(v);
    if (!best || s > best.s) best = { member: m, value: v, s };
  }
  return best ? { member: best.member, value: best.value } : null;
}
