/**
 * The arena edge for the Diplomacy frames (transports: rest / ws / mcp / a2a).
 * Same check order as the Phase 7 edge (contracts/errors.md §3a; first failure
 * wins):
 *
 *   too_large (16384) → unparseable → unknown_frame → wrong_protocol_version →
 *   schema_invalid (whole `diplomacy_action` frame) → bad_echo (episode) /
 *   stale_turn → bad_echo (turn, nonce) → not_your_seat (`power` echo)
 *
 * The nonce and episode id never enter the Scenario, the record or a hash.
 * `thought` is accepted by the schema and dropped here.
 */

import type { EpisodeRecord, PowerSeat, RejectReason, Submission } from '../types.ts';
import { dipMaxFrameBytes, dipValidators } from './contracts.ts';
import { computeDipVerdicts, isDiplomacyRecord } from './verdicts.ts';
import type { DiplomacyActionPayload, DiplomacyObservationBody } from './wire.ts';

export const DIP_PROTOCOL_VERSION = '1.0';

export interface DipEnvelope {
  /** `epi_` + 26 Crockford chars; opaque, never derived from the seed. */
  episodeId: string;
  /** Opaque per-decision nonce (8..64 chars). */
  nonce: string;
}

export interface DipExpectation {
  episodeId: string;
  turnId: number;
  nonce: string;
  power: PowerSeat;
}

/** Observation body → the `diplomacy_observation` wire frame. */
export function diplomacyObservationFrame(body: DiplomacyObservationBody, env: DipEnvelope): Record<string, unknown> {
  const { scenario_id, power, turn_id, deadline_ms, hard_deadline_ms, ...rest } = body;
  return {
    t: 'diplomacy_observation',
    protocol_version: DIP_PROTOCOL_VERSION,
    episode_id: env.episodeId,
    scenario_id,
    power,
    turn_id,
    nonce: env.nonce,
    deadline_ms,
    hard_deadline_ms,
    ...rest,
  };
}

/**
 * Terminal record → the `diplomacy_episode_end` frame for the target. Never carries
 * `evaluation_hash` (contracts 2.1.0: the evaluation is not sent on the target channel).
 */
export function diplomacyEpisodeEndFrame(rec: EpisodeRecord, episodeId: string): Record<string, unknown> {
  if (!isDiplomacyRecord(rec)) throw new Error('diplomacyEpisodeEndFrame: not a diplomacy_standard record');
  const ep = computeDipVerdicts(rec).ep;
  const t = ep?.terminal;
  if (!ep || !t) throw new Error('diplomacyEpisodeEndFrame: the record does not re-simulate to a terminal');
  return {
    t: 'diplomacy_episode_end',
    protocol_version: DIP_PROTOCOL_VERSION,
    episode_id: episodeId,
    power: rec.diplomacy.power,
    outcome: rec.terminal.outcome,
    terminal: { kind: t.kind, year: t.year, winner: t.winner },
    sc_counts: { ...t.sc },
    unit_counts: { ...t.units },
    eliminated: [...t.eliminated],
    civil_disorder: ep.forfeited.map((f) => f.power),
    terminal_tick: rec.terminal.ticks,
    replay_hash: rec.replayHash,
    transcript_hash: rec.diplomacy.transcriptHash,
  };
}

const byteLength = (raw: string | Uint8Array): number => (typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength);

/** Raw target bytes → Submission (payload = orders | intent | press; `thought` dropped). */
export function parseDiplomacyActionFrame(raw: string | Uint8Array, expect: DipExpectation, latencyMs: number | null): Submission<DiplomacyActionPayload> {
  const bytes = byteLength(raw);
  const refuse = (reason: RejectReason): Submission<DiplomacyActionPayload> => ({ kind: 'rejected', reason, latencyMs, frameBytes: bytes });
  if (bytes > dipMaxFrameBytes('diplomacy_action')) return refuse('too_large');
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    return refuse('unparseable');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return refuse('unparseable');
  const o = obj as Record<string, unknown>;
  if (o.t !== 'diplomacy_action') return refuse('unknown_frame');
  if (typeof o.protocol_version === 'string' && o.protocol_version.split('.')[0] !== DIP_PROTOCOL_VERSION.split('.')[0]) return refuse('wrong_protocol_version');
  if (!dipValidators.diplomacy_action(o)) return refuse('schema_invalid');
  if (o.episode_id !== expect.episodeId) return refuse('bad_echo');
  if (typeof o.turn_id === 'number' && o.turn_id < expect.turnId) return refuse('stale_turn');
  if (o.turn_id !== expect.turnId || o.nonce !== expect.nonce) return refuse('bad_echo');
  if (o.power !== expect.power) return refuse('not_your_seat');
  const payload: DiplomacyActionPayload = {};
  if (o.orders !== undefined) payload.orders = o.orders;
  if (o.intent !== undefined) payload.intent = o.intent;
  if (o.press !== undefined) payload.press = o.press;
  return { kind: 'action', payload, latencyMs, frameBytes: bytes };
}
