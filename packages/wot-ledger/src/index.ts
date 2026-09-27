/**
 * wot-ledger — budget accounting (ADR-001: the Token ledger survives ONLY as
 * budget accounting; no economy, no stakes, no faucets/sinks beyond the budget
 * pair).
 *
 * A seat's allowance is granted from `faucet:budget` at the start of an episode
 * and consumed into `sink:consumed` tick by tick, as balanced, exactly-once
 * journals through wot-store's `LedgerStore`. Every journal references an
 * episode and a tick; usage totals are derived by folding, never stored.
 */

export { budget, BUDGET_FAUCET, CONSUMED_SINK } from './accounts.ts';

export {
  BUDGET_TIERS,
  budgetTierLimits,
  type BudgetTier,
  type BudgetTierLimits,
} from './budget.ts';

export {
  planBudgetGrant,
  planBudgetConsume,
  type Plan,
  type BudgetGrantInput,
  type BudgetConsumeInput,
} from './plan.ts';

export { BudgetLedger, ledgerConserves, type BudgetUsage } from './service.ts';

// Re-exported store surface (so callers can build a ledger from one import)
export {
  InMemoryLedgerStore,
  accountId,
  ledgerAccountKind,
  LedgerError,
  UnbalancedJournalError,
  InsufficientBalanceError,
  type LedgerStore,
  type LedgerRef,
  type LedgerEntryType,
  type LedgerQuery,
  type PostedJournal,
  type PostedLeg,
  type PostJournalInput,
  type JournalLegInput,
} from 'wot-store';
