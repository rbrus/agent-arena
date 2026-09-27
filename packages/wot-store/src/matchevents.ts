/**
 * MatchEventStore (Phase 5 B5) — the durable event log + lifecycle manifest that
 * makes a match RECOVERABLE after an engine restart (docs/security/resilience-and-
 * review.md §1.8).
 *
 * Two things become durable so recovery can "resume XOR clean-fail, never invent":
 *
 *  1. A per-match **tick log** — every resolved tick's `(tick, input, hash)` is
 *     appended at turn resolution (not only at `finish()`). Because the engine is
 *     a pure `(seed, inputs) → state` fold, re-folding the durable inputs
 *     reconstructs the EXACT pre-crash state, and the recorded `hash` (the running
 *     state-hash chain) is the checkpoint recovery verifies against.
 *
 *  2. A per-match **manifest + lifecycle status** with a compare-and-set (CAS)
 *     transition. The manifest records everything recovery needs to resume or
 *     retire a match (seed, league, both sides' agent/owner ids). The CAS is the
 *     "outcome-decided-once" guard (§1.3): the happy-path finish does
 *     `CAS(live → settled)` and records the winner; the recovery abort does
 *     `CAS(starting|live → aborted)` — so exactly one terminal outcome is ever
 *     recorded, structurally. (No Token legs since ADR-001: nothing is staked.)
 *
 * Interface-first (ADR-000): the in-memory impl here is what the chaos restart
 * test drives (re-instantiate from the event log, run the recovery scan); a
 * persistent impl (a record per manifest + a table of tick rows, the CAS
 * a transaction) slots behind the SAME interface for real cross-process restarts.
 */

import type { League } from 'wot-auth';

export type { League };

/**
 * Match lifecycle (the CAS state machine, §1.3):
 *   starting — the manifest is written, the match is being brought up (crash
 *              here → recovery aborts: nothing was played).
 *   live     — the tick loop is running (crash here → recovery resumes from the
 *              tick log, or clean-fails to `aborted`).
 *   settled  — the outcome (winner) is recorded. Terminal.
 *   aborted  — clean-failed with no winner. Terminal.
 * Exactly one of {settled, aborted} is ever reached, via the CAS.
 */
export type MatchLifecycleStatus = 'starting' | 'live' | 'settled' | 'aborted';

/** One side's durable identity — everything a resume/reconnect needs. */
export interface MatchManifestSide {
  player: 'A' | 'B';
  /** Public agent id = the reconnect binding key. */
  agentId: string;
  ownerId?: string;
  ticketId?: string;
}

/**
 * The durable pointer a recovery scan reconciles. Written before the match is
 * brought up, so a crash during bring-up still leaves a recoverable record
 * (status `starting` → recovery aborts).
 */
export interface MatchManifest {
  matchId: string;
  mode: 'duel' | 'raid';
  seed: number;
  league: League;
  sides: MatchManifestSide[];
  status: MatchLifecycleStatus;
  startedAt: string;
  updatedAt: string;
  /** Set on the settle CAS — the durable, replay-backed outcome. */
  winner?: 'A' | 'B' | 'draw';
  settledAt?: string;
  /** Set on the abort CAS — why the match clean-failed (`aborted_conserving`, …). */
  abortReason?: string;
}

/** One durable resolved tick. `input` is the opaque `TickActions` the engine folds. */
export interface MatchTickRecord {
  /** The turn id (== the sim tick index) this input resolved. */
  tick: number;
  input: unknown;
  /** The running state-hash chain AFTER this tick — the recovery checkpoint. */
  hash: string;
}

/** Result of a CAS attempt — distinguishes "no manifest" from "lost the race". */
export interface CasResult {
  /** A manifest existed at all (false → legacy/casual path, no CAS guard). */
  existed: boolean;
  /** This caller won the transition (only the winner performs the terminal post). */
  ok: boolean;
  manifest: MatchManifest | null;
}

/** Fields the CAS may set atomically with the status transition. */
export interface CasPatch {
  winner?: 'A' | 'B' | 'draw';
  settledAt?: string;
  abortReason?: string;
}

/**
 * Durable match event log + lifecycle. In-memory for the demo/chaos test; a
 * persistent impl slots behind this interface (ADR-000). Append-only tick log +
 * an atomic CAS on the manifest status.
 */
export interface MatchEventStore {
  /** Create/overwrite the manifest (write it before the match is brought up). */
  putManifest(manifest: MatchManifest): Promise<void>;
  getManifest(matchId: string): Promise<MatchManifest | null>;
  /**
   * Atomically transition `status` from one of `from` to `to` (optionally setting
   * `patch`). Returns whether a manifest existed and whether THIS call won. The
   * event-loop-atomic in-memory check-and-set mirrors the one-session-per-passport
   * supersession; a persistent impl makes it a transaction on the manifest row.
   */
  casStatus(
    matchId: string,
    from: MatchLifecycleStatus[],
    to: MatchLifecycleStatus,
    patch?: CasPatch,
  ): Promise<CasResult>;
  /** Append one resolved tick. Idempotent on (matchId, tick) — a re-append is a no-op. */
  appendTick(matchId: string, rec: MatchTickRecord): Promise<void>;
  /** The durable inputs (oldest→newest) to re-fold on resume. */
  loadTicks(matchId: string): Promise<MatchTickRecord[]>;
  /** Manifests still open (status `starting`|`live`) — the recovery scan's worklist. */
  openManifests(): Promise<MatchManifest[]>;
  /** Every manifest (offline batch reads of settled outcomes). */
  allManifests(): Promise<MatchManifest[]>;
}

/** In-memory MatchEventStore — Maps; every mutation is event-loop-atomic. */
export class InMemoryMatchEventStore implements MatchEventStore {
  private manifests = new Map<string, MatchManifest>();
  private ticks = new Map<string, MatchTickRecord[]>();

  async putManifest(manifest: MatchManifest): Promise<void> {
    this.manifests.set(manifest.matchId, { ...manifest, sides: manifest.sides.map((s) => ({ ...s })) });
  }

  async getManifest(matchId: string): Promise<MatchManifest | null> {
    const m = this.manifests.get(matchId);
    return m ? { ...m, sides: m.sides.map((s) => ({ ...s })) } : null;
  }

  async casStatus(
    matchId: string,
    from: MatchLifecycleStatus[],
    to: MatchLifecycleStatus,
    patch: CasPatch = {},
  ): Promise<CasResult> {
    const m = this.manifests.get(matchId);
    if (!m) return { existed: false, ok: false, manifest: null };
    if (!from.includes(m.status)) {
      return { existed: true, ok: false, manifest: { ...m, sides: m.sides.map((s) => ({ ...s })) } };
    }
    m.status = to;
    m.updatedAt = new Date().toISOString();
    if (patch.winner !== undefined) m.winner = patch.winner;
    if (patch.settledAt !== undefined) m.settledAt = patch.settledAt;
    if (patch.abortReason !== undefined) m.abortReason = patch.abortReason;
    return { existed: true, ok: true, manifest: { ...m, sides: m.sides.map((s) => ({ ...s })) } };
  }

  async appendTick(matchId: string, rec: MatchTickRecord): Promise<void> {
    const arr = this.ticks.get(matchId);
    if (!arr) {
      this.ticks.set(matchId, [{ ...rec }]);
      return;
    }
    // Idempotent on (matchId, tick): a resumed match must not double-append a tick
    // that was already durable before the crash.
    if (arr.some((t) => t.tick === rec.tick)) return;
    arr.push({ ...rec });
  }

  async loadTicks(matchId: string): Promise<MatchTickRecord[]> {
    const arr = this.ticks.get(matchId) ?? [];
    return [...arr].sort((a, b) => a.tick - b.tick).map((t) => ({ ...t }));
  }

  async openManifests(): Promise<MatchManifest[]> {
    return [...this.manifests.values()]
      .filter((m) => m.status === 'starting' || m.status === 'live')
      .map((m) => ({ ...m, sides: m.sides.map((s) => ({ ...s })) }));
  }

  async allManifests(): Promise<MatchManifest[]> {
    return [...this.manifests.values()].map((m) => ({ ...m, sides: m.sides.map((s) => ({ ...s })) }));
  }
}
