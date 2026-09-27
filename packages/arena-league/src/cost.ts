/**
 * Cost metering (HOSTED-PROFILE §6.5). Model tokens and CHF only: the
 * engine's `tokens` are action-allowance units and never enter here (Pillar 4).
 *
 * Per game (`GameMeter`):
 *  - a baseline of every peer's cumulative counters is taken when the game is
 *    admitted; after each decision the harness reads the counters again and
 *    meters the DELTA (so an connector object can be reused across games);
 *  - a counter that decreases, or is not a finite number >= 0, is a broken
 *    meter: the game stops with `cost_meter_invalid` (never "assume zero");
 *  - the running total is checked once per tick, after every live peer's
 *    decision for that tick is in and BEFORE the tick is applied: a total
 *    above the per-game budget stops the game (`budget_exceeded`, recorded as
 *    an aborted episode). The worst overshoot is one tick of decisions;
 *  - after the game, one final sweep reads every peer again (answers that
 *    arrived after Dh, cancelled calls still billed) into `late_chf`.
 *
 * Per calendar month (`MonthlyCostCap`, default CHF 300):
 *  - admission: a game starts only if month-to-date spend plus every open
 *    reservation plus this game's reservation (its per-game budget, the
 *    worst-case bound) fits under the cap; otherwise `CapExhaustedError` and
 *    no peer is called;
 *  - every metered delta is added to the month as it happens; alerts fire once
 *    per month per threshold (default 50%, 80%, 100%) through `onAlert`;
 *  - a running game always finishes its own budget (its reservation covered
 *    it); closing the reservation releases the unspent remainder;
 *  - the month key is the UTC calendar month of `now()` at admission; a new
 *    month starts from zero. This accumulator is an in-process MIRROR: the
 *    source of truth is Sixi's in-region ledger, which seeds it through
 *    `state` and reads it back with `snapshot()`.
 */

import type { Power } from 'wot-engine';
import type { PeerCost } from './peer.ts';

export const DEFAULT_MONTHLY_CAP_CHF = 300;
export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [0.5, 0.8, 1];

export interface CapAlert {
  month: string;
  threshold: number;
  spent_chf: number;
  cap_chf: number;
  table_id: string;
}

export interface CapState {
  month: string;
  spent_chf: number;
  alerted: number[];
}

export class CapExhaustedError extends Error {
  readonly code = 'cap_exhausted';
  constructor(
    message: string,
    readonly detail: { month: string; spent_chf: number; reserved_chf: number; requested_chf: number; cap_chf: number },
  ) {
    super(message);
    this.name = 'CapExhaustedError';
  }
}

export interface MonthlyCapOptions {
  capChf?: number;
  alertThresholds?: readonly number[];
  onAlert?: (a: CapAlert) => void;
  now?: () => Date;
  /** Seed from Sixi's ledger. */
  state?: CapState;
}

const monthOf = (d: Date): string => d.toISOString().slice(0, 7);

export interface Reservation {
  readonly table_id: string;
  readonly month: string;
  readonly reserved_chf: number;
  spend(chf: number): void;
  close(): void;
}

export class MonthlyCostCap {
  readonly capChf: number;
  private readonly thresholds: number[];
  private readonly onAlert?: (a: CapAlert) => void;
  private readonly now: () => Date;
  private month: string;
  private spent: number;
  private alerted: Set<number>;
  private readonly open = new Map<symbol, number>();

  constructor(opts: MonthlyCapOptions = {}) {
    this.capChf = opts.capChf ?? DEFAULT_MONTHLY_CAP_CHF;
    if (!Number.isFinite(this.capChf) || this.capChf <= 0) throw new Error('cap: capChf must be a positive number');
    this.thresholds = [...(opts.alertThresholds ?? DEFAULT_ALERT_THRESHOLDS)].sort((a, b) => a - b);
    if (this.thresholds.some((t) => !(t > 0 && t <= 1))) throw new Error('cap: alert thresholds must be in (0, 1]');
    this.onAlert = opts.onAlert;
    this.now = opts.now ?? (() => new Date());
    const st = opts.state;
    this.month = st?.month ?? monthOf(this.now());
    this.spent = st?.spent_chf ?? 0;
    this.alerted = new Set(st?.alerted ?? []);
    if (!Number.isFinite(this.spent) || this.spent < 0) throw new Error('cap: state.spent_chf must be a finite number >= 0');
  }

  private roll(): void {
    const m = monthOf(this.now());
    if (m !== this.month) {
      this.month = m;
      this.spent = 0;
      this.alerted = new Set();
    }
  }

  private reserved(): number {
    let s = 0;
    for (const v of this.open.values()) s += v;
    return s;
  }

  /** Admission control: reserve `reservationChf` for a game, or throw `CapExhaustedError`. */
  admit(tableId: string, reservationChf: number): Reservation {
    if (!Number.isFinite(reservationChf) || reservationChf <= 0) throw new Error('cap: the reservation must be a positive number (the per-game budget)');
    this.roll();
    const reserved = this.reserved();
    if (this.spent + reserved + reservationChf > this.capChf) {
      throw new CapExhaustedError(
        `cap_exhausted: CHF ${this.spent.toFixed(2)} spent and CHF ${reserved.toFixed(2)} reserved in ${this.month}; a CHF ${reservationChf.toFixed(2)} game does not fit under the CHF ${this.capChf.toFixed(2)} cap`,
        { month: this.month, spent_chf: this.spent, reserved_chf: reserved, requested_chf: reservationChf, cap_chf: this.capChf },
      );
    }
    const key = Symbol(tableId);
    this.open.set(key, reservationChf);
    const month = this.month;
    let left = reservationChf;
    let closed = false;
    return {
      table_id: tableId,
      month,
      reserved_chf: reservationChf,
      spend: (chf: number) => {
        if (!Number.isFinite(chf) || chf < 0) throw new Error('cap: spend must be a finite number >= 0');
        this.spent += chf;
        left = Math.max(0, left - chf);
        if (!closed) this.open.set(key, left);
        this.check(tableId);
      },
      close: () => {
        closed = true;
        this.open.delete(key);
      },
    };
  }

  private check(tableId: string): void {
    for (const t of this.thresholds) {
      if (this.alerted.has(t)) continue;
      if (this.spent >= t * this.capChf) {
        this.alerted.add(t);
        this.onAlert?.({ month: this.month, threshold: t, spent_chf: this.spent, cap_chf: this.capChf, table_id: tableId });
      }
    }
  }

  snapshot(): CapState & { reserved_chf: number; cap_chf: number } {
    return { month: this.month, spent_chf: this.spent, alerted: [...this.alerted].sort((a, b) => a - b), reserved_chf: this.reserved(), cap_chf: this.capChf };
  }
}

/** The per-game meter over cumulative peer counters. */
export class GameMeter {
  private readonly last = new Map<Power, PeerCost>();
  private readonly byPower = new Map<Power, PeerCost & { decisions: number }>();
  total = 0;
  late = 0;

  constructor(
    readonly budgetChf: number,
    private readonly reservation?: Reservation,
  ) {
    if (!Number.isFinite(budgetChf) || budgetChf <= 0) throw new Error('meter: the per-game budget must be a positive number of CHF');
  }

  static valid(c: unknown): c is PeerCost {
    const o = c as Partial<PeerCost> | null;
    return !!o && typeof o === 'object' && (['input_tokens', 'output_tokens', 'chf'] as const).every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0);
  }

  baseline(p: Power, c: unknown): void {
    if (!GameMeter.valid(c)) throw new Error(`meter: ${p} reports no valid cost counters`);
    this.last.set(p, { input_tokens: c.input_tokens, output_tokens: c.output_tokens, chf: c.chf });
    this.byPower.set(p, { input_tokens: 0, output_tokens: 0, chf: 0, decisions: 0 });
  }

  /** Meter one read. Returns the delta, or null when the counters are invalid or went backwards. */
  read(p: Power, c: unknown, opts: { decision: boolean; late?: boolean }): PeerCost | null {
    const prev = this.last.get(p);
    if (!prev || !GameMeter.valid(c)) return null;
    const d: PeerCost = { input_tokens: c.input_tokens - prev.input_tokens, output_tokens: c.output_tokens - prev.output_tokens, chf: c.chf - prev.chf };
    if (d.input_tokens < 0 || d.output_tokens < 0 || d.chf < 0) return null;
    this.last.set(p, { input_tokens: c.input_tokens, output_tokens: c.output_tokens, chf: c.chf });
    const acc = this.byPower.get(p)!;
    acc.input_tokens += d.input_tokens;
    acc.output_tokens += d.output_tokens;
    acc.chf += d.chf;
    if (opts.decision) acc.decisions++;
    this.total += d.chf;
    if (opts.late) this.late += d.chf;
    if (d.chf > 0) this.reservation?.spend(d.chf);
    return d;
  }

  exceeded(): boolean {
    return this.total > this.budgetChf;
  }

  ledger(): { budget_chf: number; total_chf: number; late_chf: number; by_power: Partial<Record<Power, PeerCost & { decisions: number }>> } {
    const by: Partial<Record<Power, PeerCost & { decisions: number }>> = {};
    for (const [p, v] of this.byPower) by[p] = { ...v };
    return { budget_chf: this.budgetChf, total_chf: this.total, late_chf: this.late, by_power: by };
  }
}
