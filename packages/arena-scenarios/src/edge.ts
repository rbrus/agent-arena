/**
 * The arena edge for evaluation frames (for B1 transports: rest / ws / mcp / a2a).
 * Wraps a Scenario's pure egress body into the wire frame, and turns the raw
 * bytes a target returns into a `Submission` BEFORE anything reaches the
 * engine. Check order (first failure wins, contracts/errors.md §3a):
 *
 *   too_large → unparseable → unknown_frame → wrong_protocol_version →
 *   schema_invalid (whole-frame contract schema) → bad_echo / stale_turn
 *
 * Seat ownership (`not_your_seat`), one-order-per-unit and the adapter speed
 * rule are then enforced by Scenario.act(). The nonce and episode id live only
 * here: they never enter a Scenario, the record, or the hash.
 */

import type { Observation } from 'wot-contracts';
import { evalValidators, maxFrameBytes } from './contracts.ts';
import type { EvalRaidObservationBody } from './raid-scenario.ts';
import type { EpisodeRecord, RejectReason, Submission } from './types.ts';

export const PROTOCOL_VERSION = '1.0';

export interface Envelope {
  /** `epi_` + 26 Crockford chars; opaque, never derived from the seed (L6). */
  episodeId: string;
  /** Opaque per-decision nonce (8..64 chars). */
  nonce: string;
}

export function evalRaidObservationFrame(body: EvalRaidObservationBody, env: Envelope): Record<string, unknown> {
  const { scenario_id, mode, seat, turn_id, deadline_ms, hard_deadline_ms, ...rest } = body;
  return {
    t: 'eval_raid_observation',
    protocol_version: PROTOCOL_VERSION,
    episode_id: env.episodeId,
    scenario_id,
    mode,
    seat,
    turn_id,
    nonce: env.nonce,
    deadline_ms,
    hard_deadline_ms,
    ...rest,
  };
}

/** The duel frame is the v1 `observation` with the real nonce + match id stamped in. */
export function duelObservationFrame(obs: Observation, env: { matchId?: string; nonce: string }): Observation {
  return { ...obs, nonce: env.nonce, ...(env.matchId ? { match_id: env.matchId } : {}) };
}

export function evalEpisodeEndFrame(rec: EpisodeRecord, episodeId: string): Record<string, unknown> {
  return {
    t: 'eval_episode_end',
    protocol_version: PROTOCOL_VERSION,
    episode_id: episodeId,
    outcome: rec.terminal.outcome,
    terminal_tick: rec.terminal.ticks,
    replay_hash: rec.replayHash,
  };
}

export interface Expectation {
  /** raid: the episode id; duel: the match id. */
  id: string;
  turnId: number;
  nonce: string;
}

type Parsed<P> = Submission<P>;

function refuse<P>(reason: RejectReason, latencyMs: number | null, frameBytes: number | null): Parsed<P> {
  return { kind: 'rejected', reason, latencyMs, frameBytes };
}

function byteLength(raw: string | Uint8Array): number {
  return typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
}

function parseCommon(
  raw: string | Uint8Array,
  frame: 'eval_raid_action' | 'action',
  expect: Expectation,
  latencyMs: number | null,
): { ok: true; obj: Record<string, unknown>; bytes: number } | { ok: false; sub: Parsed<never> } {
  const bytes = byteLength(raw);
  if (bytes > maxFrameBytes(frame)) return { ok: false, sub: refuse('too_large', latencyMs, bytes) };
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    return { ok: false, sub: refuse('unparseable', latencyMs, bytes) };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { ok: false, sub: refuse('unparseable', latencyMs, bytes) };
  const o = obj as Record<string, unknown>;
  if (o.t !== frame) return { ok: false, sub: refuse('unknown_frame', latencyMs, bytes) };
  if (typeof o.protocol_version === 'string' && o.protocol_version.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
    return { ok: false, sub: refuse('wrong_protocol_version', latencyMs, bytes) };
  }
  const v = evalValidators[frame];
  if (!v(o)) return { ok: false, sub: refuse('schema_invalid', latencyMs, bytes) };
  const idField = frame === 'eval_raid_action' ? 'episode_id' : 'match_id';
  if (o[idField] !== expect.id) return { ok: false, sub: refuse('bad_echo', latencyMs, bytes) };
  if (typeof o.turn_id === 'number' && o.turn_id < expect.turnId) return { ok: false, sub: refuse('stale_turn', latencyMs, bytes) };
  if (o.turn_id !== expect.turnId || o.nonce !== expect.nonce) return { ok: false, sub: refuse('bad_echo', latencyMs, bytes) };
  return { ok: true, obj: o, bytes };
}

/** Raw target bytes → Submission for a raid scenario (payload = units | members | thought). */
export function parseEvalRaidActionFrame(
  raw: string | Uint8Array,
  expect: Expectation,
  latencyMs: number | null,
): Submission<{ units?: unknown; members?: unknown; thought?: unknown }> {
  const r = parseCommon(raw, 'eval_raid_action', expect, latencyMs);
  if (!r.ok) return r.sub;
  const payload: { units?: unknown; members?: unknown } = {};
  if (r.obj.units !== undefined) payload.units = r.obj.units;
  if (r.obj.members !== undefined) payload.members = r.obj.members;
  // `thought` is accepted by the schema and DROPPED here: it never reaches the scenario.
  return { kind: 'action', payload, latencyMs, frameBytes: r.bytes };
}

/** Raw target bytes → Submission for the duel (the v1 `action` frame). */
export function parseDuelActionFrame(raw: string | Uint8Array, expect: Expectation, latencyMs: number | null): Submission<{ units?: unknown }> {
  const r = parseCommon(raw, 'action', expect, latencyMs);
  if (!r.ok) return r.sub;
  return { kind: 'action', payload: { units: r.obj.units }, latencyMs, frameBytes: r.bytes };
}
