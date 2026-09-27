/**
 * BudgetLedger — posts the budget planners through a `LedgerStore` with natural
 * idempotency keys, and DERIVES usage by folding the journal (never a stored
 * counter).
 *
 * Idempotency keys: `budget-grant:<episode>/<seat>` and
 * `budget-consume:<episode>/<seat>@<tick>`. A retried grant, or a re-posted
 * tick (a resumed episode replaying its log), applies exactly once.
 */

import type { LedgerStore, PostedJournal } from 'wot-store';
import { budget } from './accounts.ts';
import {
  planBudgetConsume,
  planBudgetGrant,
  type BudgetConsumeInput,
  type BudgetGrantInput,
  type Plan,
} from './plan.ts';

/** A seat's allowance usage in one episode, derived from the journal. */
export interface BudgetUsage {
  episodeId: string;
  seat: string;
  granted: number;
  consumed: number;
  /** granted − consumed (equals the budget account's folded balance). */
  remaining: number;
  /** Ticks with a recorded spend, ascending. */
  ticks: number[];
}

export class BudgetLedger {
  constructor(readonly store: LedgerStore) {}

  private post(plan: Plan, idempotencyKey: string, at?: string): Promise<PostedJournal> {
    return this.store.post({
      ...(at ? { ts: at } : {}),
      ref: plan.ref,
      idempotencyKey,
      legs: plan.legs,
      ...(plan.memo ? { memo: plan.memo } : {}),
    });
  }

  /** Issue a seat's allowance for an episode (exactly once per episode+seat). */
  async grant(input: BudgetGrantInput & { at?: string }): Promise<PostedJournal> {
    return this.post(planBudgetGrant(input), `budget-grant:${input.episodeId}/${input.seat}`, input.at);
  }

  /** Record one tick's spend (exactly once per episode+seat+tick). Refused if it would overspend. */
  async consume(input: BudgetConsumeInput & { at?: string }): Promise<PostedJournal> {
    return this.post(
      planBudgetConsume(input),
      `budget-consume:${input.episodeId}/${input.seat}@${input.tick}`,
      input.at,
    );
  }

  /** Derived usage for one seat: a fold over its budget account's legs. */
  async usage(episodeId: string, seat: string): Promise<BudgetUsage> {
    const account = budget(episodeId, seat);
    let granted = 0;
    let consumed = 0;
    const ticks: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.store.entriesFor(account, { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const leg of page.entries) {
        if (leg.type === 'grant') granted += leg.amount;
        else {
          consumed += -leg.amount;
          ticks.push(leg.ref.tick);
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    ticks.sort((a, b) => a - b);
    return { episodeId, seat, granted, consumed, remaining: granted - consumed, ticks };
  }
}

/** Closed-system check: Σ over every account == 0. */
export async function ledgerConserves(store: LedgerStore): Promise<boolean> {
  let sum = 0;
  for (const account of await store.accounts()) sum += await store.balanceOf(account);
  return sum === 0;
}
