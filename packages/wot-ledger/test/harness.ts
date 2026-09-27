/**
 * Shared test harness — a deterministic PRNG and a journal classifier used by
 * the property tests. Not a `*.test.ts` file, so the runner imports it without
 * executing it as a suite.
 */

import { ledgerAccountKind, type PostedJournal, newId } from 'wot-store';

/** mulberry32 — a tiny deterministic PRNG so fuzz runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

export const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[randInt(rng, 0, xs.length - 1)];

/** Deterministic ISO timestamps for the `at` parameter (base + n seconds). */
export const ts = (n: number): string => new Date(Date.UTC(2026, 6, 20) + n * 1000).toISOString();

/** A batch of fresh episode ids. */
export const makeEpisodes = (n: number): string[] => Array.from({ length: n }, () => newId('mat'));

export interface JournalClass {
  /** Allowance issued by faucet legs (= −Σ faucet leg amounts). */
  granted: number;
  /** Allowance absorbed by sink legs (= Σ sink leg amounts). */
  consumed: number;
  /** Net change to outstanding allowance (Σ budget legs). */
  budgetDelta: number;
  /** Whether the journal touches any faucet or sink account. */
  touchesFaucetSink: boolean;
  /** Σ over ALL legs (must be 0). */
  total: number;
}

/** Classify a posted journal by account kind — the conservation bookkeeping. */
export function classify(j: PostedJournal): JournalClass {
  let granted = 0;
  let consumed = 0;
  let budgetDelta = 0;
  let total = 0;
  let touchesFaucetSink = false;
  for (const l of j.legs) {
    total += l.amount;
    const k = ledgerAccountKind(l.account);
    if (k === 'faucet') {
      granted += -l.amount;
      touchesFaucetSink = true;
    } else if (k === 'sink') {
      consumed += l.amount;
      touchesFaucetSink = true;
    } else {
      budgetDelta += l.amount;
    }
  }
  return { granted, consumed, budgetDelta, touchesFaucetSink, total };
}
