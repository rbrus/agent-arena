/**
 * The edge between a peer's answer and the table core: the same steps, in the
 * same order, as the CLI applies to a target's `diplomacy_action` frame
 * (arena-cli runner.ts + diplomacy.ts, arena-scenarios edge.ts and
 * `DiplomacyScenario.act`):
 *
 *   1. envelope: the harness wraps the payload in the frame the target would
 *      have sent (`t`, protocol_version, episode_id, turn_id, nonce, power) and
 *      serialises it; an unserialisable answer is `unparseable`;
 *   2. `parseDiplomacyActionFrame` (arena-scenarios): too_large (16 KiB) →
 *      unparseable → unknown_frame → wrong_protocol_version → schema_invalid
 *      (whole frame) → bad_echo / stale_turn → not_your_seat; `thought` dropped;
 *   3. local signature attestation: no wire signature byte reaches the engine;
 *      `session` passes, anything else becomes the CLI's fixed sentinel, which
 *      the engine refuses in place as `signature_invalid`;
 *   4. whole-frame re-validation after attestation (as `act()` does);
 *   5. deadlines: past Dh the frame is dropped (`late_frame_dropped`, hard
 *      miss); past Ds it is applied and counted as a soft miss.
 *
 * Press redaction of credential-shaped spans (the CLI's G-40 step) is not
 * applied here: this package writes no file, and model output is redacted by
 * Sixi's connector before it is returned (NEUTRAL-GROUND.md, open items).
 */

import { dipValidators, parseDiplomacyActionFrame, DIP_PROTOCOL_VERSION, type DiplomacyActionPayload } from 'arena-scenarios';
import type { Power } from 'wot-engine';
import type { Miss } from './table.ts';

/** arena-cli `DIP_UNVERIFIED_SIGNATURE`: schema-valid, refused by the engine as `signature_invalid`. */
export const UNVERIFIED_SIGNATURE = 'unverified_local..no_passport_keys';

export interface EdgeExpectation {
  episodeId: string;
  turnId: number;
  nonce: string;
  power: Power;
}

export type EdgeResult =
  | { kind: 'accepted'; payload: DiplomacyActionPayload; miss: Miss; latencyMs: number; frameBytes: number }
  | { kind: 'rejected'; reason: string; miss: 'hard'; latencyMs: number; frameBytes: number | null };

function attest(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.press)) return payload;
  const press = payload.press.map((m: unknown) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
    const o = m as Record<string, unknown>;
    if (o.signature === undefined || o.signature === 'session') return o;
    return { ...o, signature: UNVERIFIED_SIGNATURE };
  });
  return { ...payload, press };
}

/** One peer answer → what the core applies. Pure. */
export function edgeAccept(answer: unknown, expect: EdgeExpectation, latencyMs: number, deadlines: { softMs: number; hardMs: number }): EdgeResult {
  const reject = (reason: string, frameBytes: number | null): EdgeResult => ({ kind: 'rejected', reason, miss: 'hard', latencyMs, frameBytes });
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return reject('schema_invalid', null);
  const frame = {
    ...(answer as Record<string, unknown>),
    t: 'diplomacy_action',
    protocol_version: DIP_PROTOCOL_VERSION,
    episode_id: expect.episodeId,
    turn_id: expect.turnId,
    nonce: expect.nonce,
    power: expect.power,
  };
  let raw: string;
  try {
    raw = JSON.stringify(frame);
  } catch {
    return reject('unparseable', null);
  }
  if (typeof raw !== 'string') return reject('unparseable', null);
  const sub = parseDiplomacyActionFrame(raw, expect, latencyMs);
  if (sub.kind === 'rejected') return reject(sub.reason, sub.frameBytes ?? null);
  if (sub.kind !== 'action') return reject('schema_invalid', null);
  const frameBytes = sub.frameBytes ?? Buffer.byteLength(raw, 'utf8');
  if (latencyMs > deadlines.hardMs) return reject('late_frame_dropped', frameBytes);
  const payload = attest(sub.payload as Record<string, unknown>) as DiplomacyActionPayload;
  const v = dipValidators.diplomacy_action;
  if (!v({ t: 'diplomacy_action', protocol_version: DIP_PROTOCOL_VERSION, episode_id: expect.episodeId, turn_id: expect.turnId, nonce: expect.nonce, power: expect.power, ...payload })) {
    return reject('schema_invalid', frameBytes);
  }
  return { kind: 'accepted', payload: structuredClone(payload), miss: latencyMs > deadlines.softMs ? 'soft' : 'none', latencyMs, frameBytes };
}
