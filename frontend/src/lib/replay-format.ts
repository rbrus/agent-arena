/**
 * The replay tick log the inspector consumes: `agent-arena replay <report> --episode <n> --json`.
 * Owner of this shape: the inspector (Phase 7 B5); the CLI emits exactly this.
 *
 * Minimal on purpose. Per tick, per TARGET seat: the observation frame body as
 * delivered, the action payload as submitted, and the engine's ack/reject; per
 * tick: the post-resolution state hash, engine events and oracle events.
 *
 *  - `observation` is the target-facing frame body (eval_raid_observation minus
 *    transport envelope, or the duel `observation`); `null` if none was sent.
 *  - `action` is the target's payload after JSON parse, `null` on a miss or an
 *    unparseable frame. It is TARGET-AUTHORED and HOSTILE (ping text, thought,
 *    unknown keys): the inspector renders it only as sanitised text.
 *  - `ack.status`: accepted | rejected (reason = contracts/errors.md §3a code,
 *    or late_frame_dropped) | miss (soft|hard deadline) | none (no decision).
 *  - `engine_events`: the engine's per-tick events minus `tick`/`seq`; values
 *    are scalars or small arrays of scalars. Platform data, but still shown as text.
 *  - `oracle_events`: one row per failing verdict whose evidence_ref.ticks
 *    contains this tick (oracle templates only, never target text).
 *  - Hash chain: fold(initial_state_hash, ticks[0].state_hash, …) with
 *    fold(p, h) = "sha256:" + hex(sha256(utf8(p + ":" + h))) MUST equal
 *    `replay_hash`, which MUST equal the report episode's replay_hash. The
 *    inspector checks this with WebCrypto; it is a consistency check of the
 *    file, not a re-simulation (that is `agent-arena verify`).
 *
 * Caps enforced by the loader: ≤ 121 ticks, ≤ 5 seats per tick, ≤ 64 events
 * per list, file ≤ 64 MiB, JSON depth ≤ 32, no __proto__/constructor/prototype keys.
 */

export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [k: string]: Json };

export interface ReplayAck {
  status: 'accepted' | 'rejected' | 'miss' | 'none';
  reason?: string;
  coercions?: { unit_id: string; reason: string }[];
  late?: boolean;
}

export interface ReplaySeat {
  seat: string;
  observation: Json | null;
  action: Json | null;
  ack: ReplayAck;
}

export interface OracleEvent {
  oracle_id: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
}

export interface ReplayTick {
  /** The turn_id that was played (state.tick before resolution). */
  tick: number;
  /** State hash after resolving this tick ("sha256:<64 hex>"). */
  state_hash: string;
  seats: ReplaySeat[];
  engine_events: { type: string; [k: string]: Json }[];
  oracle_events: OracleEvent[];
}

export interface ReplayFile {
  replay_version: '1.0';
  scenario_id: string;
  episode_index: number;
  seed: number;
  tier: 'edge' | 'core' | 'frontier';
  mode: 'duel' | 'squad' | 'member' | 'power';
  /** The target seat: A | B | m0..m4 | squad | a power (austria … turkey, diplomacy_standard). */
  seat: string;
  replay_hash: string;
  initial_state_hash: string;
  ticks: ReplayTick[];
}

export const REPLAY_LIMITS = { ticks: 121, seats: 5, events: 64 } as const;
