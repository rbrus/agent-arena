/**
 * Budget tiers as evaluation classes (arena-scenarios.md §3.1; run_spec.schema.json
 * `budget_tier`). Only three dials vary: Ds, Dh and the per-seat action-token
 * allowance. Everything else is structural. The numbers are FIXED by the
 * contract: changing one is a MAJOR contract change + ADR.
 *
 * The raid path in services/arena hard-codes Core (F3); the adapter applies the
 * tier here through the engine's existing `config.allowance` option, so the
 * engine is not touched. At Core the config equals RAID_CONFIGS[boss] exactly.
 */

import type { BudgetTier, TierId } from './types.ts';

export const HARD_MISS_FORFEIT = 3;
export const TICK_CAP = 120;
export const MAX_INBOUND_FRAME_BYTES = 8192;

export const BUDGET_TIERS: Readonly<Record<TierId, Readonly<BudgetTier>>> = Object.freeze({
  edge: Object.freeze({
    id: 'edge',
    softDeadlineMs: 800,
    hardDeadlineMs: 1600,
    hardMissForfeit: HARD_MISS_FORFEIT,
    actionAllowance: 160,
    tickCap: TICK_CAP,
    maxInboundFrameBytes: MAX_INBOUND_FRAME_BYTES,
  }),
  core: Object.freeze({
    id: 'core',
    softDeadlineMs: 1500,
    hardDeadlineMs: 3000,
    hardMissForfeit: HARD_MISS_FORFEIT,
    actionAllowance: 240,
    tickCap: TICK_CAP,
    maxInboundFrameBytes: MAX_INBOUND_FRAME_BYTES,
  }),
  frontier: Object.freeze({
    id: 'frontier',
    softDeadlineMs: 3000,
    hardDeadlineMs: 6000,
    hardMissForfeit: HARD_MISS_FORFEIT,
    actionAllowance: 360,
    tickCap: TICK_CAP,
    maxInboundFrameBytes: MAX_INBOUND_FRAME_BYTES,
  }),
});

export const TIER_IDS: readonly TierId[] = ['edge', 'core', 'frontier'];

export function tierOf(id: TierId): Readonly<BudgetTier> {
  const t = BUDGET_TIERS[id];
  if (!t) throw new Error(`unknown budget tier: ${String(id)}`);
  return t;
}
