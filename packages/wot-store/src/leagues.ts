/**
 * Budget tiers (leagues) — the evaluation classes (ADR-001: leagues are budget
 * tiers, not a skill ladder; the TrueSkill Weights and the Golden List were cut).
 *
 * The limits are FIXED by the contract (contracts/schemas/run_spec.schema.json
 * `budget_tier`, openapi.yaml `BudgetTierLimits`); changing any value is a MAJOR
 * contract change. This is the single table the arena, recovery and the budget
 * ledger read (it replaced the economy-era params import from outside ascension/).
 */

import type { League } from 'wot-auth';

export type { League };

/** The three budget tiers, canonical order. */
export const LEAGUES: readonly League[] = ['edge', 'core', 'frontier'];

/** One tier's fixed limits (contracts/openapi.yaml `BudgetTierLimits`). */
export interface BudgetTierLimits {
  tier: League;
  /** Soft decision deadline (Ds), ms. */
  soft_deadline_ms: number;
  /** Hard decision deadline (Dh), ms. */
  hard_deadline_ms: number;
  /** Consecutive hard deadline misses that forfeit the seat. */
  hard_miss_forfeit: number;
  /** Action-allowance units per controlled seat per episode (not model tokens). */
  token_allowance: number;
  tick_cap: number;
  max_orders_per_unit: number;
  max_inbound_frame_bytes: number;
}

const COMMON = { hard_miss_forfeit: 3, tick_cap: 120, max_orders_per_unit: 1, max_inbound_frame_bytes: 8192 } as const;

const TIERS: Record<League, BudgetTierLimits> = {
  edge: { tier: 'edge', soft_deadline_ms: 800, hard_deadline_ms: 1600, token_allowance: 160, ...COMMON },
  core: { tier: 'core', soft_deadline_ms: 1500, hard_deadline_ms: 3000, token_allowance: 240, ...COMMON },
  frontier: { tier: 'frontier', soft_deadline_ms: 3000, hard_deadline_ms: 6000, token_allowance: 360, ...COMMON },
};

/** The contract-shaped limits for one tier (a fresh copy). */
export function budgetTierLimits(tier: League): BudgetTierLimits {
  const t = TIERS[tier];
  if (!t) throw new RangeError(`unknown budget tier '${tier}'`);
  return { ...t };
}

/** The engine-facing view of a tier the arena consumes (deadlines + allowance). */
export interface LeagueBudget {
  league: League;
  budgets: {
    soft_deadline_ms: number;
    hard_deadline_ms: number;
    action_allowance: number;
    tick_cap: number;
  };
}

/** The budget-class dials for one tier, as the arena and recovery read them. */
export function leagueBudget(league: League): LeagueBudget {
  const t = budgetTierLimits(league);
  return {
    league,
    budgets: {
      soft_deadline_ms: t.soft_deadline_ms,
      hard_deadline_ms: t.hard_deadline_ms,
      action_allowance: t.token_allowance,
      tick_cap: t.tick_cap,
    },
  };
}
