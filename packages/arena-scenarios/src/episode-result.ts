/**
 * EpisodeRecord + verdicts → `EpisodeResult` (contracts/schemas/episode_result.schema.json).
 * Produced by the arena, never by the target. Every string here is platform
 * text (oracle templates, engine codes); no target-supplied byte is copied in.
 */

import { computeDipVerdicts, isDiplomacyRecord } from './diplomacy/verdicts.ts';
import { toDipEpisodeResult } from './diplomacy/result.ts';
import { computeGridVerdicts } from './oracles/grid.ts';
import { computeRaidVerdicts } from './oracles/raid.ts';
import type { BudgetCounters } from './oracles/shared.ts';
import type { EpisodeRecord, OracleVerdict, SeatId } from './types.ts';

export interface ContractVerdict {
  oracle_id: string;
  seat?: SeatId;
  verdict: 'pass' | 'fail' | 'not_assessed';
  severity: 'error' | 'warning' | 'note';
  basis: 'resim' | 'attested';
  reason_code?: string;
  measures?: Record<string, number>;
  thresholds?: Record<string, number>;
  evidence_ref?: { replay_hash: string; ticks: number[]; code?: string; message?: string; items?: Record<string, unknown>[] };
  /** diplomacy_standard.collusion (contracts 2.1.0). */
  review_required?: boolean;
}

export interface EpisodeResultJson {
  episode_index: number;
  seed: number;
  scenario_id: string;
  mode: 'duel' | 'squad' | 'member' | 'power';
  seat: SeatId;
  fill?: 'coordinated' | 'naive';
  status: 'completed';
  outcome: string;
  outcome_reason?: string;
  terminal_tick: number;
  replay_hash: string;
  /** diplomacy_standard (contracts 2.1.0): head of the press/intent transcript chain. */
  transcript_hash?: string;
  /** diplomacy_standard: the contract 5-tuple hash over `oracles` (src/diplomacy/verdicts.ts). */
  evaluation_hash?: string;
  replay_ref?: string;
  trajectory_class: string;
  blinding_key?: string;
  budget: BudgetCounters & { press?: Record<string, number> };
  oracles: ContractVerdict[];
  duration_ms?: number;
  /** diplomacy_standard: the reported (never scored) table block. */
  diplomacy?: Record<string, unknown>;
}

export function toContractVerdict(v: OracleVerdict, replayHash: string): ContractVerdict {
  const out: ContractVerdict = { oracle_id: v.oracleId, seat: v.seat, verdict: v.status, severity: v.severity, basis: v.basis };
  if (v.status === 'not_assessed') out.reason_code = v.reason ?? 'precondition_not_reached';
  if (Object.keys(v.measure).length) out.measures = { ...v.measure };
  if (Object.keys(v.thresholds).length) out.thresholds = { ...v.thresholds };
  if (v.status === 'fail') {
    out.evidence_ref = {
      replay_hash: replayHash,
      ticks: [...v.evidenceTicks],
      ...(v.code ? { code: v.code } : {}),
      ...(v.message ? { message: v.message } : {}),
      ...(v.evidenceItems?.length ? { items: v.evidenceItems.map((i) => ({ ...i })) } : {}),
    };
  }
  if (v.reviewRequired) out.review_required = true;
  return out;
}

export function computeVerdicts(rec: EpisodeRecord): { verdicts: OracleVerdict[]; budget: BudgetCounters; replayHash: string } {
  if (rec.scenarioId === 'grid_tactics') return computeGridVerdicts(rec);
  if (isDiplomacyRecord(rec)) {
    const d = computeDipVerdicts(rec);
    return { verdicts: d.verdicts, budget: d.budget, replayHash: d.replayHash };
  }
  const r = computeRaidVerdicts(rec);
  return { verdicts: r.verdicts, budget: r.budget, replayHash: r.tap.replayHash };
}

export interface EpisodeResultOptions {
  episodeIndex: number;
  replayRef?: string;
  /** Default true (open runs). A hosted profile may withhold the key (§6 q9). */
  discloseBlindingKey?: boolean;
  durationMs?: number;
}

export function toEpisodeResult(rec: EpisodeRecord, opts: EpisodeResultOptions): EpisodeResultJson {
  if (isDiplomacyRecord(rec)) return toDipEpisodeResult(rec, opts);
  const { verdicts, budget } = computeVerdicts(rec);
  const r: EpisodeResultJson = {
    episode_index: opts.episodeIndex,
    seed: rec.seed,
    scenario_id: rec.scenarioId,
    mode: rec.mode,
    seat: rec.targetSeat,
    ...(rec.mode === 'member' && rec.fill ? { fill: rec.fill } : {}),
    status: 'completed',
    outcome: rec.terminal.outcome,
    ...(rec.terminal.reason ? { outcome_reason: rec.terminal.reason } : {}),
    terminal_tick: rec.terminal.ticks,
    replay_hash: rec.replayHash,
    ...(opts.replayRef ? { replay_ref: opts.replayRef } : {}),
    trajectory_class: rec.trajectoryClass,
    ...(opts.discloseBlindingKey === false ? {} : { blinding_key: rec.blindingKey }),
    budget,
    oracles: verdicts.map((v) => toContractVerdict(v, rec.replayHash)),
    ...(opts.durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(opts.durationMs)) } : {}),
  };
  return r;
}
