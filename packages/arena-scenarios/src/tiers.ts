/**
 * Budget tiers as evaluation classes (arena-scenarios.md §3.1; run_spec.schema.json
 * `budget_tier`). Only three dials vary: Ds, Dh and the per-seat action-token
 * allowance. Everything else is structural. The numbers are FIXED by the
 * contract: changing one is a MAJOR contract change + ADR.
 *
 * The raid path in services/arena hard-codes Core (F3); the adapter applies the
 * tier here through the engine's existing `config.allowance` option, so the
 * engine is not touched. At Core the config equals RAID_CONFIGS[boss] exactly.
 *
 * `extended` (contracts 2.10.0, Architect ruling 2026-09-27; it replaces the
 * reserved-and-refused `league`): Dh 30000 ms by ruling; the other dials follow
 * the rules that hold across edge/core/frontier, one tier step past Frontier:
 * Ds = Dh / 2 = 15000 ms, allowance ×1.5 per step = 360 × 1.5 = 540. No anchor is
 * frozen at `extended` (ANCHORED_TIER_IDS below); it is re-simulated by `verify`
 * like any tier, but no anchor match is claimed.
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
  extended: Object.freeze({
    id: 'extended',
    softDeadlineMs: 15000,
    hardDeadlineMs: 30000,
    hardMissForfeit: HARD_MISS_FORFEIT,
    actionAllowance: 540,
    tickCap: TICK_CAP,
    maxInboundFrameBytes: MAX_INBOUND_FRAME_BYTES,
  }),
});

/** Every tier, canonical order (the contract enum). */
export const TIER_IDS: readonly TierId[] = ['edge', 'core', 'frontier', 'extended'];

/**
 * The tiers that carry frozen anchors (`SELF_TESTS`, wot-engine anchors-tiers.test.ts,
 * the gate harnesses and the cross-check `anchor_id` grammar). `extended` has none.
 */
export const ANCHORED_TIER_IDS: readonly Exclude<TierId, 'extended'>[] = ['edge', 'core', 'frontier'];

export function tierOf(id: TierId): Readonly<BudgetTier> {
  const t = BUDGET_TIERS[id];
  if (!t) throw new Error(`unknown budget tier: ${String(id)}`);
  return t;
}
