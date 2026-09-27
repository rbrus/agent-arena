/**
 * The boot-time recovery scan (Phase 5 B5) — the spine of "resume XOR clean-fail,
 * never invent" (docs/security/resilience-and-review.md §1.1–§1.3).
 *
 * After an engine restart the in-memory `Match` objects, the queue, and the
 * spectator hubs are gone, but the durable MatchEventStore survives (per-tick
 * input log + lifecycle manifest). This scan reconciles every OPEN match to
 * exactly one of two outcomes, decided once by the lifecycle CAS:
 *
 *   RESUME  — re-fold the durable inputs through the pure engine to the exact
 *             pre-crash state and verify the state-hash chain. If that state is
 *             already terminal, record the outcome once (CAS live → settled). If
 *             it is mid-match and a live-resume hook is available, rebuild the
 *             Match and open the reconnect grace window; otherwise it falls to
 *             clean-fail.
 *   CLEAN-FAIL — mark the match `aborted` (`aborted_conserving`). Never a
 *             fabricated winner.
 *
 * Since ADR-001 nothing is staked, so neither path posts a ledger journal; the
 * CAS alone makes the outcome exactly-once, and re-running the ENTIRE scan (a
 * crash mid-recovery) changes nothing.
 *
 * The scan is a standalone async function so the chaos test can drive it directly
 * against the persisted event log (C1's "simulated in-process restart"). The arena
 * calls it at boot, gated ahead of the upgrade listener.
 */

import {
  resimulate,
  type MatchState,
  type TickActions,
} from 'wot-engine';
import { leagueBudget, type MatchManifest, type Stores } from 'wot-store';
import type { LogFields } from './log.ts';
import type { MatchResumeState } from './match.ts';

/** Context handed to the live-resume hook for a mid-match resumable orphan. */
export interface ResumeContext {
  manifest: MatchManifest;
  /** The reconstructed pre-crash state a re-instantiated `Match` seeds from. */
  resume: MatchResumeState;
}

export interface RecoveryDeps {
  stores: Stores;
  log: (f: LogFields) => void;
  /** Deterministic clock for the terminal timestamps (defaults to Date.now). */
  now?: () => string;
  /**
   * Production hook to RESUME a non-terminal live match: rebuild the live `Match`
   * at the reconstructed state, re-open its spectator hub, and start the reconnect
   * grace window. Return true if it took ownership (the scan leaves the manifest
   * `live`); if the hook is absent or returns false, the match clean-fails (no
   * grace window → conserving abort). See arena.ts.
   */
  resumeLive?: (ctx: ResumeContext) => boolean | Promise<boolean>;
}

export type RecoveryAction = 'settled' | 'aborted' | 'resumed' | 'skipped';

export interface RecoveryOutcome {
  matchId: string;
  action: RecoveryAction;
  reason: string;
}

export interface RecoveryReport {
  scanned: number;
  settled: number;
  aborted: number;
  resumed: number;
  skipped: number;
  outcomes: RecoveryOutcome[];
}

/**
 * Run the recovery scan once. Enumerates orphans from the manifest store (status
 * `starting`|`live`) and reconciles each to resume-or-clean-fail. Safe to re-run
 * (idempotent).
 */
export async function runRecoveryScan(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { stores, log } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const report: RecoveryReport = {
    scanned: 0,
    settled: 0,
    aborted: 0,
    resumed: 0,
    skipped: 0,
    outcomes: [],
  };

  const manifests = await stores.matchEvents.openManifests();
  log({ event: 'recovery_scan_start', detail: { open_manifests: manifests.length } });

  for (const manifest of manifests) {
    report.scanned += 1;
    const at = now();
    const record = (o: RecoveryOutcome): void => {
      report.outcomes.push(o);
      report[o.action] += 1;
      log({ event: `recovery_${o.action}`, match_id: manifest.matchId, detail: { reason: o.reason } });
    };

    const ticks = await stores.matchEvents.loadTicks(manifest.matchId);

    // No live ticks (crashed during bring-up / before the first resolve) → abort.
    if (manifest.status === 'starting' || ticks.length === 0) {
      await cleanFail(deps, manifest, at, 'no_tick_log', record);
      continue;
    }

    // Re-fold the durable inputs through the PURE engine with the SAME config the
    // live match used (the league action allowance), then verify the chain.
    const allowance = leagueBudget(manifest.league).budgets.action_allowance;
    const inputs = ticks.map((t) => t.input as TickActions);
    const resim = resimulate(manifest.seed, inputs, {
      matchId: manifest.matchId,
      config: { allowance },
    });
    const lastHash = ticks[ticks.length - 1].hash;
    if (resim.replayHash !== lastHash) {
      // Un-resumable: the reconstruction does not match the last durable checkpoint.
      // Clean-fail; never guess a winner from a corrupt log.
      log({
        event: 'recovery_hash_mismatch',
        match_id: manifest.matchId,
        detail: { durable: lastHash, resim: resim.replayHash },
      });
      await cleanFail(deps, manifest, at, 'hash_mismatch', record);
      continue;
    }

    if (resim.terminal.over) {
      // The match had DECIDED its outcome pre-crash (crashed in/around finish()).
      // Record it ONCE under CAS(live → settled).
      const winner = resim.terminal.winner ?? 'draw';
      const cas = await stores.matchEvents.casStatus(manifest.matchId, ['live'], 'settled', { winner, settledAt: at });
      if (!cas.ok) {
        record({ matchId: manifest.matchId, action: 'skipped', reason: 'already_terminal' });
        continue;
      }
      await writeTerminalSummary(deps, manifest, 'completed', {
        winner,
        reason: resim.terminal.reason ?? 'timeout',
        replayHash: resim.replayHash,
        endedAt: at,
      });
      record({ matchId: manifest.matchId, action: 'settled', reason: 'resumed_terminal' });
      continue;
    }

    // Mid-match resumable state. Hand it to the live-resume hook if wired; else the
    // resume grace window is unavailable in this scan → conserving abort.
    if (deps.resumeLive) {
      const resume: MatchResumeState = {
        state: resim.finalState as MatchState,
        chain: resim.replayHash,
        perTickHashes: resim.perTickHashes,
        inputs,
        tickLog: resim.tickLog,
      };
      let took = false;
      try {
        took = await deps.resumeLive({ manifest, resume });
      } catch (err) {
        log({ event: 'recovery_resume_error', match_id: manifest.matchId, detail: { message: (err as Error).message } });
      }
      if (took) {
        record({ matchId: manifest.matchId, action: 'resumed', reason: 'live_resume' });
        continue;
      }
    }
    await cleanFail(deps, manifest, at, 'no_resume_window', record);
  }

  log({
    event: 'recovery_scan_done',
    detail: {
      scanned: report.scanned,
      settled: report.settled,
      aborted: report.aborted,
      resumed: report.resumed,
      skipped: report.skipped,
    },
  });
  return report;
}

/** Clean-fail one match: CAS to aborted, write the summary. No winner. */
async function cleanFail(
  deps: RecoveryDeps,
  manifest: MatchManifest,
  at: string,
  reason: string,
  record: (o: RecoveryOutcome) => void,
): Promise<void> {
  const cas = await deps.stores.matchEvents.casStatus(manifest.matchId, ['starting', 'live'], 'aborted', {
    abortReason: 'aborted_conserving',
  });
  if (!cas.ok) {
    record({ matchId: manifest.matchId, action: 'skipped', reason: 'already_terminal' });
    return;
  }
  await writeTerminalSummary(deps, manifest, 'aborted', {
    reason: 'aborted_conserving',
    endedAt: at,
  });
  record({ matchId: manifest.matchId, action: 'aborted', reason });
}

/** Merge a terminal status onto the (possibly live) match summary. */
async function writeTerminalSummary(
  deps: RecoveryDeps,
  manifest: MatchManifest,
  status: 'completed' | 'aborted',
  fields: {
    winner?: 'A' | 'B' | 'draw';
    reason: string;
    replayHash?: string;
    endedAt: string;
  },
): Promise<void> {
  try {
    const existing = (await deps.stores.matches.getSummary(manifest.matchId)) ?? {};
    await deps.stores.matches.saveSummary({
      ...existing,
      matchId: manifest.matchId,
      status,
      reason: fields.reason,
      ended_at: fields.endedAt,
      recovered: true,
      ...(fields.winner ? { winner: fields.winner } : {}),
      ...(fields.replayHash ? { replay_hash: fields.replayHash } : {}),
    });
  } catch {
    /* summary is best-effort; the manifest is the outcome truth */
  }
}
