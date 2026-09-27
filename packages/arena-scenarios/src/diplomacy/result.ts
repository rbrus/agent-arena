/**
 * Diplomacy EpisodeRecord + verdicts → `EpisodeResult` (episode_result.schema.json,
 * contracts 2.1.0-2.3.0): mode `power`, the power as seat, `transcript_hash`,
 * the contract `evaluation_hash`, `budget.press`, and the `diplomacy` block
 * (reported, never scored), which carries the engine's own
 * `engine_evaluation_hash` (2.3.0). Every string is platform text or an engine id.
 */

import { dipOracles, POWERS, type DipEpisode, type Power } from 'wot-engine';
import { toContractVerdict, type EpisodeResultJson, type EpisodeResultOptions } from '../episode-result.ts';
import type { DiplomacyEpisodeRecord, PowerSeat } from '../types.ts';
import { AGENT_NAME } from './tables.ts';
import { computeDipVerdicts } from './verdicts.ts';

/** episode_result.schema.json `diplomacy.engine_evaluation_hash`. */
const ENGINE_EVALUATION_HASH = /^sha256:[0-9a-f]{64}$/;

const stripVia = (s: string): string => (s.endsWith(' VIA') ? s.slice(0, -4) : s);

export function engagementOf(ep: DipEpisode, me: Power): Record<string, number> {
  const ps = ep.press;
  const mine = ps.commitments.filter((c) => c.parties[0] === me || c.parties[1] === me);
  let kept = 0;
  let broken = 0;
  let voided = 0;
  for (const c of mine) {
    for (const cl of c.clauses) {
      if (cl.obligor !== me) continue;
      for (const s of cl.settlements) {
        if (s.status === 'kept') kept++;
        else if (s.status === 'broken') broken++;
        else if (s.status === 'void') voided++;
      }
    }
  }
  let requestsReceived = 0;
  let requestsGranted = 0;
  for (const m of ps.log) {
    if (!m.asks || !m.recipients.includes(me) || m.from === me) continue;
    const submitted = new Set((ep.history.find((h) => h.phaseId === m.phase)?.submissions[me] ?? []).map(stripVia));
    for (const a of m.asks) {
      requestsReceived++;
      if (submitted.has(stripVia(a))) requestsGranted++;
    }
  }
  return {
    messages_sent: ps.log.filter((m) => m.from === me).length,
    messages_received: ps.log.filter((m) => m.from !== me && m.recipients.includes(me)).length,
    offers_made: ps.offers.filter((o) => o.from === me).length,
    offers_received: ps.offers.filter((o) => o.to === me).length,
    commitments_bound: mine.length,
    clauses_kept: kept,
    clauses_broken: broken,
    clauses_void: voided,
    renounces_sent: mine.filter((c) => c.renounced?.by === me).length,
    requests_received: requestsReceived,
    requests_granted: requestsGranted,
  };
}

export function toDipEpisodeResult(rec: DiplomacyEpisodeRecord, opts: EpisodeResultOptions): EpisodeResultJson {
  const v = computeDipVerdicts(rec);
  const ep = v.ep;
  const t = ep?.terminal;
  if (!ep || !t) throw new Error('diplomacy_standard: the record does not re-simulate to a terminal (see harness.replay_integrity via verifyRecord)');
  const d = rec.diplomacy;
  const me = d.power;
  const keyed = ep.press.log.some((m) => m.from === me && m.sig_mode === 'key');
  const roster = (POWERS as readonly PowerSeat[]).map((p) => {
    const r = d.roster[p];
    const row: Record<string, unknown> = { power: p, seat_kind: d.seatKinds[p] === 'target' ? 'target' : 'reference' };
    if (r.agent !== 'external') row.agent = AGENT_NAME[r.agent];
    if (r.agent === 'house' && r.persona) row.persona = r.persona;
    row.owner_key_hash = dipOracles.ownerHash(d.owners[p]);
    return row;
  });
  const diplomacy: Record<string, unknown> = {
    power: me,
    profile: d.profile,
    horizon_year: d.horizonYear,
    press_rounds: d.pressRounds,
    sig_mode: keyed ? 'key' : 'session',
    ...(d.episodeSecret !== '' && d.episodeSecretCommitment ? { episode_secret: d.episodeSecret, episode_secret_commitment: d.episodeSecretCommitment } : {}),
    terminal: { kind: t.kind, year: t.year, winner: t.winner },
    sc_counts: { ...t.sc },
    unit_counts: { ...t.units },
    eliminated: [...t.eliminated],
    civil_disorder: ep.forfeited.map((f) => f.power),
    roster,
    engagement: engagementOf(ep, me),
    // contracts 2.3.0: the engine's verdict-object hash, as RECORDED (the claim). `computeDipVerdicts`
    // re-derives it on every verify; a difference is harness.replay_integrity / evaluation_hash_mismatch.
    ...(ENGINE_EVALUATION_HASH.test(d.engineEvaluationHash) ? { engine_evaluation_hash: d.engineEvaluationHash } : {}),
  };
  return {
    episode_index: opts.episodeIndex,
    seed: rec.seed,
    scenario_id: rec.scenarioId,
    mode: 'power',
    seat: me,
    status: 'completed',
    outcome: rec.terminal.outcome,
    ...(rec.terminal.reason ? { outcome_reason: rec.terminal.reason } : {}),
    terminal_tick: rec.terminal.ticks,
    replay_hash: rec.replayHash,
    transcript_hash: d.transcriptHash,
    evaluation_hash: v.evaluationHash,
    ...(opts.replayRef ? { replay_ref: opts.replayRef } : {}),
    trajectory_class: rec.trajectoryClass,
    budget: v.budget,
    oracles: v.verdicts.map((x) => toContractVerdict(x, rec.replayHash)),
    diplomacy,
    ...(opts.durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(opts.durationMs)) } : {}),
  };
}
