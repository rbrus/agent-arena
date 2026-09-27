/**
 * Budget tiers — the evaluation classes. The table lives in wot-store
 * (`leagues.ts`, fixed by contracts/schemas/run_spec.schema.json); this module
 * re-exports it so budget-accounting callers import from one place.
 */

export {
  LEAGUES as BUDGET_TIERS,
  budgetTierLimits,
  type League as BudgetTier,
  type BudgetTierLimits,
} from 'wot-store';
