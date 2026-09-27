/**
 * Signature verification BEFORE the engine (G-11; threat-model-hosted X-9, HT-5.7).
 *
 * For every signed press move (offer, counter, accept, renounce) of a batch the
 * transport decides one attestation and hands the engine only that:
 *
 *   - a detached Ed25519 JWS that verifies against the SESSION's passport key over
 *     `pressSigningPayload({episode_id, msg_id_expected, from, to, move,
 *     respond_to, terms_hash})` → `key` (contract `sig_mode: "key"`; the passport
 *     mode of the B3a brief);
 *   - the literal `session`, only when the policy allows it (WOT_ENV
 *     development|test AND the table allows unsigned local play) → `session`;
 *   - anything else → the sentinel `unverified`, which the engine refuses as
 *     `signature_invalid` IN PLACE (the batch keeps its positions, so the ids and
 *     signatures of the later messages stay valid, and a re-simulation from the
 *     recorded inputs reproduces the refusal without key material).
 *
 * `from` is the power the session is bound to, `episode_id` is the run's id set
 * by the session, and `msg_id_expected` is computed from the current phase,
 * round and batch position: a signature cannot be moved to another sender,
 * episode, round or position. The JWS bytes are kept as evidence here (never in
 * the engine, never hashed).
 */

import { resolveDeployEnv, SIGNED_PRESS_MOVES, verifyPressSignature, type Ed25519PublicJwk, type JwsFailure } from 'wot-auth';
import type { Power } from 'wot-engine';
import { UNVERIFIED_SIGNATURE, wireMsgId, type SigAttestation } from './wire.ts';

export interface SignaturePolicy {
  /** True only when WOT_ENV is development|test AND the table allows unsigned play. */
  allowSession: boolean;
}

/** `session` mode is a sandbox convenience: never outside WOT_ENV=development|test. */
export function signaturePolicy(env: NodeJS.ProcessEnv, tableAllowsSession: boolean): SignaturePolicy {
  return { allowSession: tableAllowsSession && resolveDeployEnv(env.WOT_ENV) !== 'production' };
}

export type SigRejectReason = JwsFailure | 'no_passport_key' | 'session_not_allowed' | 'missing';

export interface SignatureEvidence {
  tick: number;
  power: Power;
  /** Batch position (0-based) and the id the engine assigns if the message is accepted. */
  index: number;
  msg_id_expected: string;
  move: string;
  mode: 'key' | 'session' | 'rejected';
  reason?: SigRejectReason;
  kid?: string | null;
  /** The detached JWS as received (public evidence; not hashed). */
  jws?: string;
}

export interface AttestContext {
  episodeId: string;
  phase: string;
  round: number;
  tick: number;
  power: Power;
  publicJwk: Ed25519PublicJwk | null;
  policy: SignaturePolicy;
}

const isSigned = (move: unknown): boolean => typeof move === 'string' && (SIGNED_PRESS_MOVES as readonly string[]).includes(move);

/** Decide the attestation of every message of a schema-valid press batch. */
export function attestBatch(batch: readonly unknown[], ctx: AttestContext): { attest: SigAttestation[]; evidence: SignatureEvidence[] } {
  const attest: SigAttestation[] = [];
  const evidence: SignatureEvidence[] = [];
  batch.forEach((raw, i) => {
    const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const msgIdExpected = wireMsgId(ctx.phase, ctx.round, ctx.power, i + 1);
    const base = { tick: ctx.tick, power: ctx.power, index: i, msg_id_expected: msgIdExpected, move: String(m.move) };
    if (!isSigned(m.move)) {
      // press / withdraw carry no signature; one sent anyway is dropped (the schema forbids it).
      attest.push(undefined);
      return;
    }
    const sig = m.signature;
    const reject = (reason: SigRejectReason): void => {
      attest.push(UNVERIFIED_SIGNATURE as SigAttestation);
      evidence.push({ ...base, mode: 'rejected', reason, ...(typeof sig === 'string' && sig !== 'session' ? { jws: sig } : {}) });
    };
    if (sig === undefined) return reject('missing');
    if (sig === 'session') {
      if (!ctx.policy.allowSession) return reject('session_not_allowed');
      attest.push('session');
      evidence.push({ ...base, mode: 'session' });
      return;
    }
    if (!ctx.publicJwk) return reject('no_passport_key');
    const v = verifyPressSignature(ctx.publicJwk, sig, {
      episodeId: ctx.episodeId,
      msgIdExpected,
      from: ctx.power,
      to: m.to,
      move: m.move as string,
      respondTo: typeof m.respond_to === 'string' ? m.respond_to : null,
      terms: m.move === 'offer' || m.move === 'counter' ? m.terms : null,
    });
    if (!v.ok) return reject(v.reason);
    attest.push('key');
    evidence.push({ ...base, mode: 'key', kid: v.kid, jws: sig as string });
  });
  return { attest, evidence };
}
