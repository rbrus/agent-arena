/**
 * The table record: everything `verify` needs to re-simulate a Neutral Ground
 * game, and nothing it can regenerate. JSON-serialisable.
 *
 *   inputs    seed, tier, horizon, the seated powers and their roles; the house
 *             seats are NOT recorded (regenerated from the seed);
 *   actions   per peer power, the accepted `diplomacy_action` payload of every
 *             decision it had (null = no valid action by Dh), in decision order:
 *             the array A that `recorded_inputs.digest` = sha256(JCS(A)) commits
 *             to (`record_pointer` `/actions/<power>`);
 *   log       per peer power, the attested timing of the same decisions (miss,
 *             latency, frame bytes, edge refusal, peer fault, metered cost);
 *   abort     the cost meter's hard stop, when it fired (an attested input: the
 *             re-simulation stops where the record says);
 *   cost      the per-game ledger (attested; never hashed, never compared by verify).
 *
 * The seat identity (provider id, model id, region, prompt digest) is Sixi's
 * declaration and is listed by `verify` as unverified.
 */

import type { DiplomacyActionPayload, TierId } from 'arena-scenarios';
import { TIER_IDS } from 'arena-scenarios';
import type { Power } from 'wot-engine';
import type { PeerCost } from './peer.ts';
import type { Miss } from './table.ts';

export const TABLE_RECORD_FORMAT = 'wot-ng-table/1' as const;

/**
 * K7 role of a peer seat when it is NOT the report's primary seat. Contracts
 * 2.8.0 (run_spec `seats[]`, RESERVED.md): a Neutral Ground seat is ALWAYS
 * `driver: target` with `owner` = its provider slug, never `recorded_peer`;
 * Neutral Ground is not a pack and has no pack id (no `sx-neutral-ground`).
 */
export type SeatRole = 'target';

/**
 * Budget tiers a table may be played on: the RunSpec `budget_tier` enum
 * (edge, core, frontier). The `league` tier is RESERVED in contracts 2.8.0
 * (a 2.9.0 candidate, pending the Architect's ruling) and a RunSpec naming it
 * is `schema_invalid`, so a table on it is refused until it is specified.
 */
export const TABLE_TIERS: readonly TierId[] = TIER_IDS;

export function assertTableTier(tier: unknown): asserts tier is TierId {
  if (tier === 'league') throw new Error('budget tier "league" is reserved (contracts 2.8.0, RESERVED.md) and not usable until it is specified; play league tables on core or frontier');
  if (!(TABLE_TIERS as readonly unknown[]).includes(tier)) throw new Error(`unknown budget tier: ${String(tier)} (one of ${TABLE_TIERS.join(', ')})`);
}

export interface TableSeatRecord {
  power: Power;
  role: SeatRole;
  provider_id: string;
  model_id: string;
  region: string;
  prompt_digest?: string;
  connector_version?: string;
  /** target: the connector's origin as a RunSpec target descriptor (no credential; a reference at most). */
  endpoint: { transport: 'rest' | 'ws' | 'mcp' | 'a2a'; url: string };
}

export type PeerFault = 'timeout' | 'error';

export interface DecisionLog {
  tick: number;
  miss: Miss;
  /** Harness-measured latency (attested). null when the peer faulted. */
  latency_ms: number | null;
  frame_bytes: number | null;
  /** The edge refusal (arena-scenarios reject reason), when the answer was refused. */
  reject?: string;
  /** The peer did not answer by Dh (`timeout`) or threw (`error`). */
  fault?: PeerFault;
  /** Metered cost of this decision (delta of the peer's cumulative counters). */
  cost: PeerCost;
}

export type AbortReason = 'budget_exceeded' | 'cost_meter_invalid';

export interface TableCostLedger {
  budget_chf: number;
  total_chf: number;
  /** Spend read after the game ended (late answers past Dh, the final sweep); included in total_chf. */
  late_chf: number;
  by_power: Partial<Record<Power, PeerCost & { decisions: number }>>;
}

export interface TableRecord {
  format: typeof TABLE_RECORD_FORMAT;
  table_id: string;
  seed: number;
  tier: TierId;
  horizon_year: number;
  secret: '';
  /** Peer seats in POWERS order. */
  seats: TableSeatRecord[];
  actions: Partial<Record<Power, (DiplomacyActionPayload | null)[]>>;
  log: Partial<Record<Power, DecisionLog[]>>;
  abort: null | { tick: number; reason: AbortReason };
  cost: TableCostLedger;
}

export const recordPointer = (p: Power): string => `/actions/${p}`;

export function assertTableRecord(r: unknown): asserts r is TableRecord {
  const o = r as Partial<TableRecord> | null;
  if (!o || typeof o !== 'object') throw new Error('table record: not an object');
  if (o.format !== TABLE_RECORD_FORMAT) throw new Error(`table record: format must be ${TABLE_RECORD_FORMAT}`);
  if (!Array.isArray(o.seats) || o.seats.length < 1 || o.seats.length > 7) throw new Error('table record: 1..7 seats');
  assertTableTier(o.tier);
  for (const s of o.seats) {
    // 2.8.0: every Neutral Ground seat is driver target (a pre-2.8.0 `recorded_peer` / `sx-neutral-ground` record is refused).
    if (s.role !== 'target') throw new Error(`table record: seat ${String(s.power)} has role ${JSON.stringify(s.role)}; every Neutral Ground seat is driver target (contracts 2.8.0)`);
    if ('pack' in s || 'agent' in s) throw new Error(`table record: seat ${String(s.power)} carries a pack or peer agent id; Neutral Ground is not a pack (contracts 2.8.0)`);
  }
  if (!o.actions || typeof o.actions !== 'object' || !o.log || typeof o.log !== 'object') throw new Error('table record: actions and log are required');
  for (const s of o.seats) {
    const a = o.actions[s.power];
    const l = o.log[s.power];
    if (!Array.isArray(a) || !Array.isArray(l) || a.length !== l.length) throw new Error(`table record: ${String(s.power)} needs aligned actions[] and log[]`);
  }
}
