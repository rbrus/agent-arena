/**
 * Pure journal planners (no clock, no ids, no IO — the store stamps those).
 *
 * Each planner turns a typed budget event into a BALANCED set of legs (Σ == 0)
 * plus the `LedgerRef` it accounts for. Every plan references an episode and a
 * tick: the grant is tick 0, a consumption is the tick it was incurred on.
 */

import type { JournalLegInput, LedgerRef } from 'wot-store';
import { BUDGET_FAUCET, CONSUMED_SINK, assertLocalPart, budget } from './accounts.ts';

export interface Plan {
  ref: LedgerRef;
  legs: JournalLegInput[];
  memo?: string;
}

function requirePositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw new RangeError(`${name} must be a positive integer, got ${v}`);
}

function requireNonNegativeInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

export interface BudgetGrantInput {
  episodeId: string;
  seat: string;
  /** The seat's allowance for the episode (the tier's `action_allowance`). */
  amount: number;
}

/** Issue a seat's allowance at the start of an episode: faucet → budget, tick 0. */
export function planBudgetGrant(input: BudgetGrantInput): Plan {
  requirePositiveInt('amount', input.amount);
  assertLocalPart('seat', input.seat);
  return {
    ref: { kind: 'episode', episode_id: input.episodeId, tick: 0, seat: input.seat },
    legs: [
      { account: BUDGET_FAUCET, amount: -input.amount, type: 'grant' },
      { account: budget(input.episodeId, input.seat), amount: input.amount, type: 'grant' },
    ],
    memo: `grant ${input.amount} to ${input.seat} in ${input.episodeId}`,
  };
}

export interface BudgetConsumeInput {
  episodeId: string;
  seat: string;
  /** The tick the spend was incurred on. */
  tick: number;
  /** Units spent on that tick (> 0; a tick with no spend posts nothing). */
  amount: number;
}

/** Record one tick's spend: budget → consumption sink, referencing (episode, tick). */
export function planBudgetConsume(input: BudgetConsumeInput): Plan {
  requirePositiveInt('amount', input.amount);
  requireNonNegativeInt('tick', input.tick);
  assertLocalPart('seat', input.seat);
  return {
    ref: { kind: 'episode', episode_id: input.episodeId, tick: input.tick, seat: input.seat },
    legs: [
      { account: budget(input.episodeId, input.seat), amount: -input.amount, type: 'consume' },
      { account: CONSUMED_SINK, amount: input.amount, type: 'consume' },
    ],
    memo: `${input.seat} spent ${input.amount} at tick ${input.tick} in ${input.episodeId}`,
  };
}
