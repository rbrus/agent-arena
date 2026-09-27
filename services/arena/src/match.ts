/**
 * Match runner — the WSS tick loop over the pure engine (A1 §3, §5, §8).
 *
 * Per tick: build fog-filtered observations with a fresh unpredictable nonce
 * (tick-synchronized emission), collect each side's action (anti-replay on
 * turn_id + nonce; exactly one accepted set per (turn_id, nonce)), advance when
 * both submit or the soft deadline elapses (missing side → all-Hold), and on a
 * terminal state write the replay + summary and emit match_end.
 */

import { randomBytes } from 'node:crypto';
import type { Action } from 'wot-contracts';
import {
  buildObservation,
  createInitialState,
  foldHash,
  isTerminal,
  legalizeAction,
  resimulate,
  resolveTick,
  stateHash,
  type EngineEvent,
  type MatchConfig,
  type MatchState,
  type Player,
  type TickActions,
  type UnitAction,
} from 'wot-engine';
import type { League, MatchAgentSide, MatchFinishRecord, Stores } from 'wot-store';
import { newId } from 'wot-store';
import { BudgetLedger } from 'wot-ledger';
import { type DeadlineConfig, HARD_MISS_FORFEIT } from './config.ts';
import type { HouseBotPolicy } from './housebot.ts';
import type { LogFields } from './log.ts';

const other = (p: Player): Player => (p === 'A' ? 'B' : 'A');

/** One side's PUBLIC identity (attribution in the summary and webhooks). */
export interface PlayerMeta {
  player_id: Player;
  agent_id: string;
  display_name: string;
}

/** The public result handed to `onFinish` at terminal state (webhook match.end). */
export interface MatchEndInfo {
  winner: 'A' | 'B' | 'draw';
  reason: 'ascension' | 'elimination' | 'timeout' | 'forfeit';
  forfeit_reason?: string;
  tiebreak?: string;
  final_scores: { A: number; B: number };
  tokens_remaining: { A: number; B: number };
  ticks_played: number;
  seed: number;
  replay_id: string;
  replay_hash: string;
  players: Array<PlayerMeta & { result: 'win' | 'loss' | 'draw' }>;
}

// ---------------------------------------------------------------------------
// Match-finish hook. A registered callback list fired at terminal state with
// the verified match record (outcome, replay, per-side budget usage and
// decision-frame reliability). Inert with no hook registered.
// ---------------------------------------------------------------------------

export type MatchFinishHook = (record: MatchFinishRecord) => void;
const finishHooks: MatchFinishHook[] = [];

/** Register a post-match hook; returns an unsubscribe fn. */
export function registerMatchFinishHook(hook: MatchFinishHook): () => void {
  finishHooks.push(hook);
  return () => {
    const i = finishHooks.indexOf(hook);
    if (i >= 0) finishHooks.splice(i, 1);
  };
}

/** Tally per-player kills + Nexus-held ticks from the committed tick log. */
function tallyMatchEvents(tickLog: { type: string; [k: string]: unknown }[]): {
  kills: Record<Player, number>;
  nexus: Record<Player, number>;
} {
  const kills: Record<Player, number> = { A: 0, B: 0 };
  const nexus: Record<Player, number> = { A: 0, B: 0 };
  for (const ev of tickLog) {
    if (ev.type === 'unit_destroyed') {
      const victim = String(ev.unit ?? '');
      const victimOwner: Player | null = victim[0] === 'A' ? 'A' : victim[0] === 'B' ? 'B' : null;
      if (!victimOwner) continue;
      const killer = other(victimOwner);
      const by = Array.isArray(ev.by) ? (ev.by as string[]) : [];
      if (by.some((k) => k[0] === killer)) kills[killer] += 1;
    } else if (ev.type === 'objective_tick' && ev.objective === 'nexus') {
      if (ev.controller === 'A' || ev.controller === 'B') nexus[ev.controller] += 1;
    }
  }
  return { kills, nexus };
}

export interface AgentSide {
  kind: 'agent';
  send(frame: unknown): void;
  close(code: number, reason?: string): void;
  clientId: string;
  ownerId: string;
  sessionId: string;
  /** Public agent id + sanitized name, for attribution. */
  agentId: string;
  displayName: string;
}
export interface BotSide {
  kind: 'bot';
  policy: HouseBotPolicy;
}
export interface GoneSide {
  kind: 'gone';
}
export type Side = AgentSide | BotSide | GoneSide;

interface Turn {
  turnId: number;
  nonces: Record<Player, string>;
  submitted: Record<Player, UnitAction[] | null>;
  resolved: boolean;
  scheduled: boolean;
  softTimer: NodeJS.Timeout | null;
  /** Wall-clock (ms) the observation was emitted — for the reliability latency sample. */
  emittedAt: number;
}

interface DhPending {
  side: Player;
  turnId: number;
  nonce: string;
  sawFrame: boolean;
  timer: NodeJS.Timeout;
}

export interface MatchOptions {
  matchId: string;
  seed: number;
  deadlines: DeadlineConfig;
  sides: Record<Player, Side>;
  stores: Stores;
  log: (f: LogFields) => void;
  onEnd: (match: Match) => void;
  /** Both sides' PUBLIC identities (for attribution in the summary + webhooks). */
  players?: [PlayerMeta, PlayerMeta];
  /** League + start time, threaded into the persisted match summary. */
  league?: League;
  startedAt?: string;
  /** Fired once at terminal state with the full public result (webhook match.end). */
  onFinish?: (end: MatchEndInfo) => void;
  /**
   * Optional wall-clock floor (ms) between resolved ticks. When unset (the play
   * default) a fully-submitted tick resolves on the next `setImmediate` — as fast
   * as both sides answer. The bot-vs-bot demo loop sets this so the sim advances
   * at a WATCHABLE pace and the match stays `live` in the directory for its whole
   * duration; it never affects real agent matches (which pass it undefined).
   */
  tickIntervalMs?: number;
  /** Engine config overrides for this match (e.g. the league's action allowance). */
  config?: Partial<MatchConfig>;
  /**
   * Durable match (Phase 5 B5): the arena wrote a lifecycle manifest for it.
   * When true, every resolved tick is appended to the MatchEventStore (so a
   * restart can resume it) and the finish records the outcome under the
   * lifecycle CAS (live → settled, exactly once). Set for agent-vs-agent
   * matches; bot matches orphan nothing on restart.
   */
  durable?: boolean;
  /**
   * (Phase 5 B5) Reconstructed state to RESUME from after a restart. When present
   * the Match seeds itself at the pre-crash tick instead of tick 0; the durable
   * inputs are pre-loaded so the end-of-match resimulation still verifies the full
   * chain. Set only by the recovery scan.
   */
  resumeFrom?: MatchResumeState;
}

/**
 * The exact in-memory match state recovery reconstructs (by re-folding the durable
 * inputs through the pure engine) and hands to a re-instantiated `Match` so play
 * continues from the pre-crash tick (docs/security/resilience-and-review.md §1.1).
 */
export interface MatchResumeState {
  state: MatchState;
  chain: string;
  perTickHashes: string[];
  inputs: TickActions[];
  tickLog: EngineEvent[];
}

export class Match {
  readonly matchId: string;
  readonly seed: number;
  readonly sides: Record<Player, Side>;
  private readonly deadlines: DeadlineConfig;
  private readonly stores: Stores;
  private readonly log: (f: LogFields) => void;
  private readonly onEnd: (m: Match) => void;
  private readonly players?: [PlayerMeta, PlayerMeta];
  private readonly league?: League;
  private readonly startedAt?: string;
  private readonly onFinish?: (end: MatchEndInfo) => void;
  private readonly tickIntervalMs?: number;
  private readonly durable: boolean;
  /** Budget accounting: allowance granted per seat, consumption posted per tick. */
  private readonly budget: BudgetLedger;
  private readonly accountedSpent: Record<Player, number>;

  private state: MatchState;
  private chain: string;
  private readonly perTickHashes: string[] = [];
  private readonly inputs: TickActions[] = [];
  private readonly tickLog: EngineEvent[] = [];

  private current: Turn | null = null;
  private readonly dhPending = new Map<string, DhPending>();
  private readonly hardMissStreak: Record<Player, number> = { A: 0, B: 0 };
  private ended = false;

  // Reliability tallies (Phase 3 B6) — per-agent-side decision-frame discipline.
  private readonly relFrames: Record<Player, number> = { A: 0, B: 0 };
  private readonly relOnTime: Record<Player, number> = { A: 0, B: 0 };
  private readonly relSoft: Record<Player, number> = { A: 0, B: 0 };
  private readonly relHard: Record<Player, number> = { A: 0, B: 0 };
  private readonly relLatency: Record<Player, number[]> = { A: [], B: [] };

  constructor(opts: MatchOptions) {
    this.matchId = opts.matchId;
    this.seed = opts.seed;
    this.sides = opts.sides;
    this.deadlines = opts.deadlines;
    this.stores = opts.stores;
    this.log = opts.log;
    this.onEnd = opts.onEnd;
    this.players = opts.players;
    this.league = opts.league;
    this.startedAt = opts.startedAt;
    this.onFinish = opts.onFinish;
    this.tickIntervalMs = opts.tickIntervalMs;
    this.durable = opts.durable === true;
    this.budget = new BudgetLedger(opts.stores.ledger);
    if (opts.resumeFrom) {
      // Resume from the reconstructed pre-crash state (recovery re-folded the
      // durable inputs). The chain + inputs + tick log carry over so the terminal
      // self-check resimulation still verifies bit-for-bit.
      this.state = opts.resumeFrom.state;
      this.chain = opts.resumeFrom.chain;
      this.perTickHashes.push(...opts.resumeFrom.perTickHashes);
      this.inputs.push(...opts.resumeFrom.inputs);
      this.tickLog.push(...opts.resumeFrom.tickLog);
    } else {
      this.state = createInitialState(opts.seed, {
        matchId: opts.matchId,
        ...(opts.config ? { config: opts.config } : {}),
      });
      this.chain = stateHash(this.state);
    }
    // A resumed match's earlier ticks were accounted before the crash (the
    // per-tick keys make any re-post a no-op), so accounting continues from the
    // reconstructed spend.
    this.accountedSpent = { A: this.state.spent.A, B: this.state.spent.B };
  }

  /**
   * Budget accounting (ADR-001): post one balanced, exactly-once journal per
   * seat — the allowance grant (tick 0) or this tick's spend — referencing this
   * episode and tick. Fire-and-forget: accounting never gates the tick loop,
   * and a refused post is logged, never clamped.
   */
  private account(kind: 'grant' | 'consume', player: Player, tick: number, amount: number): void {
    const op =
      kind === 'grant'
        ? this.budget.grant({ episodeId: this.matchId, seat: player, amount })
        : this.budget.consume({ episodeId: this.matchId, seat: player, tick, amount });
    void op.catch((err) =>
      this.log({
        event: 'budget_post_error',
        match_id: this.matchId,
        detail: { kind, seat: player, tick, message: (err as Error).message },
      }),
    );
  }

  /** Begin the match (tick 0). */
  start(): void {
    this.log({ event: 'match_start', match_id: this.matchId, detail: { seed_committed: false } });
    for (const player of ['A', 'B'] as Player[]) {
      this.account('grant', player, 0, this.state.config.allowance);
    }
    this.startTick();
  }

  private nonce(): string {
    return `n_${randomBytes(12).toString('hex')}`;
  }

  private startTick(): void {
    if (this.ended) return;
    const turnId = this.state.tick;
    const nonces: Record<Player, string> = { A: this.nonce(), B: this.nonce() };
    const turn: Turn = {
      turnId,
      nonces,
      submitted: { A: null, B: null },
      resolved: false,
      scheduled: false,
      softTimer: null,
      emittedAt: Date.now(),
    };
    this.current = turn;

    // Tick-synchronized emission: build both frames, then send/act.
    for (const player of ['A', 'B'] as Player[]) {
      const obs = buildObservation(
        this.state,
        player,
        turnId,
        nonces[player],
        this.deadlines.softMs,
        this.deadlines.hardMs,
      );
      const side = this.sides[player];
      if (side.kind === 'agent') {
        side.send(obs);
      } else if (side.kind === 'bot') {
        turn.submitted[player] = side.policy(obs);
      }
      // 'gone' sides submit nothing → soft/hard miss.
    }

    turn.softTimer = setTimeout(() => this.resolveCurrentTurn(), this.deadlines.softMs);
    this.maybeResolve();
  }

  /** Route a schema-valid `action` frame from an agent side (A1 §5.1 anti-replay). */
  submitAction(player: Player, frame: Action): void {
    if (this.ended || !this.current) {
      this.reject(player, { reason: 'no_active_match', hint: 'no live tick', retryable: false });
      return;
    }
    if (frame.match_id !== this.matchId) {
      this.reject(player, {
        reason: 'not_your_match',
        hint: 'frame match_id is not bound to this session',
        retryable: false,
        turn_id: frame.turn_id,
      });
      return;
    }
    const turn = this.current;

    if (frame.turn_id === turn.turnId) {
      if (frame.nonce !== turn.nonces[player]) {
        this.reject(player, {
          reason: 'bad_echo',
          hint: 'nonce did not match the current observation',
          retryable: true,
          turn_id: frame.turn_id,
        });
        return;
      }
      if (turn.submitted[player] !== null) {
        this.reject(player, {
          reason: 'duplicate_submission',
          hint: 'an action-set was already accepted for this (turn_id, nonce)',
          retryable: false,
          turn_id: frame.turn_id,
        });
        return;
      }
      // Accept: legalize for the ack (coerce illegal / over-budget units to Hold).
      const leg = legalizeAction(this.state, player, frame.units as UnitAction[]);
      const coercedIds = new Set(leg.coercions.map((c) => c.unit_id));
      const acceptedUnits = (frame.units as UnitAction[])
        .map((u) => u.unit_id)
        .filter((id) => !coercedIds.has(id));
      const side = this.sides[player];
      if (side.kind === 'agent') {
        side.send({
          t: 'ack',
          ack_type: 'action',
          turn_id: turn.turnId,
          tokens_spent: leg.tokenSpend,
          tokens_remaining: this.state.remaining[player] - leg.tokenSpend,
          accepted_units: acceptedUnits,
          rejected_units: leg.coercions.map((c) => ({
            unit_id: c.unit_id,
            reason: c.reason,
            ...(c.hint ? { hint: c.hint } : {}),
          })),
        });
      }
      this.hardMissStreak[player] = 0;
      // Reliability latency sample: observation emit → accepted submit (ms).
      this.relLatency[player].push(Math.max(0, Date.now() - turn.emittedAt));
      turn.submitted[player] = frame.units as UnitAction[];
      this.maybeResolve();
      return;
    }

    // A frame for a non-current tick: a late frame for a just-resolved tick keeps
    // the agent "alive" (not a hard miss) but is dropped; otherwise stale.
    const dhKey = `${player}:${frame.turn_id}`;
    const pend = this.dhPending.get(dhKey);
    if (pend && pend.nonce === frame.nonce) {
      pend.sawFrame = true;
      this.log({
        event: 'late_frame_dropped',
        match_id: this.matchId,
        player,
        turn_id: frame.turn_id,
      });
      this.reject(player, {
        reason: 'stale_turn',
        hint: 'frame arrived after the soft deadline; the tick already resolved (late_frame_dropped)',
        retryable: false,
        turn_id: frame.turn_id,
      });
      return;
    }
    this.reject(player, {
      reason: 'stale_turn',
      hint: 'turn_id references a resolved / non-current tick',
      retryable: false,
      turn_id: frame.turn_id,
    });
  }

  private reject(
    player: Player,
    r: { reason: string; hint: string; retryable: boolean; turn_id?: number },
  ): void {
    const side = this.sides[player];
    if (side.kind !== 'agent') return;
    side.send({
      t: 'reject',
      match_id: this.matchId,
      turn_id: r.turn_id ?? null,
      reason: r.reason,
      hint: r.hint,
      retryable: r.retryable,
    });
    this.log({ event: 'frame_rejected', match_id: this.matchId, player, reason: r.reason });
  }

  private maybeResolve(): void {
    const turn = this.current;
    if (!turn || turn.resolved || turn.scheduled) return;
    if (turn.submitted.A !== null && turn.submitted.B !== null) {
      turn.scheduled = true;
      // Play default: resolve as soon as both sides answer. Demo pace: hold the
      // resolved tick for a wall-clock floor so the broadcast is watchable. The
      // per-tick soft timer (deadlines.softMs) is set well above tickIntervalMs
      // for demo matches, so this timer always fires first (idempotent guard on
      // turn.resolved makes a double-fire a no-op either way).
      if (this.tickIntervalMs && this.tickIntervalMs > 0) {
        setTimeout(() => this.resolveCurrentTurn(), this.tickIntervalMs);
      } else {
        setImmediate(() => this.resolveCurrentTurn());
      }
    }
  }

  private resolveCurrentTurn(): void {
    const turn = this.current;
    if (!turn || turn.resolved || this.ended) return;
    turn.resolved = true;
    if (turn.softTimer) clearTimeout(turn.softTimer);

    // Fill missing sides with all-Hold (soft miss) and arm hard-miss watches.
    for (const player of ['A', 'B'] as Player[]) {
      // Reliability: an agent side was asked to decide this frame; on-time iff it
      // submitted before this (soft-deadline) resolve.
      if (this.sides[player].kind === 'agent') {
        this.relFrames[player] += 1;
        if (turn.submitted[player] !== null) this.relOnTime[player] += 1;
        else this.relSoft[player] += 1;
      }
      if (turn.submitted[player] === null) {
        turn.submitted[player] = [];
        const side = this.sides[player];
        if (side.kind !== 'bot') {
          this.log({ event: 'soft_miss', match_id: this.matchId, player, turn_id: turn.turnId });
          const dhKey = `${player}:${turn.turnId}`;
          const delay = Math.max(0, this.deadlines.hardMs - this.deadlines.softMs);
          const timer = setTimeout(() => this.onHardDeadline(player, turn.turnId), delay);
          this.dhPending.set(dhKey, {
            side: player,
            turnId: turn.turnId,
            nonce: turn.nonces[player],
            sawFrame: false,
            timer,
          });
        }
      }
    }

    const pair: TickActions = {
      A: turn.submitted.A ?? [],
      B: turn.submitted.B ?? [],
    };
    const resolvedTurnId = turn.turnId;
    this.state = resolveTick(this.state, pair);
    this.inputs.push(pair);
    const h = stateHash(this.state);
    this.perTickHashes.push(h);
    this.chain = foldHash(this.chain, h);
    for (const ev of this.state.events) this.tickLog.push(ev);
    for (const player of ['A', 'B'] as Player[]) {
      const spent = this.state.spent[player] - this.accountedSpent[player];
      if (spent > 0) this.account('consume', player, resolvedTurnId, spent);
      this.accountedSpent[player] = this.state.spent[player];
    }

    // Durable per-tick input log (Phase 5 B5): append this resolved tick's
    // (turnId, input, chain-checkpoint) so a restart can RESUME by re-folding the
    // pure engine to this exact state. Only agent-vs-agent matches are made
    // durable; bot matches orphan nothing on restart. Fire-and-forget: the append
    // does not gate the tick loop, and it is idempotent on (matchId, tick).
    if (this.durable) {
      void this.stores.matchEvents
        .appendTick(this.matchId, { tick: resolvedTurnId, input: pair, hash: this.chain })
        .catch((err) =>
          this.log({
            event: 'tick_persist_error',
            match_id: this.matchId,
            detail: { message: (err as Error).message },
          }),
        );
    }

    const term = isTerminal(this.state);
    if (term.over) {
      void this.finish({
        winner: term.winner ?? 'draw',
        reason: term.reason ?? 'timeout',
        tiebreak: term.tiebreak,
      });
      return;
    }
    this.startTick();
  }

  private onHardDeadline(player: Player, turnId: number): void {
    if (this.ended) return;
    const dhKey = `${player}:${turnId}`;
    const pend = this.dhPending.get(dhKey);
    if (!pend) return;
    this.dhPending.delete(dhKey);
    if (pend.sawFrame) {
      this.hardMissStreak[player] = 0;
      return;
    }
    this.hardMissStreak[player] += 1;
    this.relHard[player] += 1;
    this.log({
      event: 'hard_miss',
      match_id: this.matchId,
      player,
      turn_id: turnId,
      detail: { streak: this.hardMissStreak[player] },
    });
    if (this.hardMissStreak[player] >= HARD_MISS_FORFEIT) {
      void this.finish({ winner: other(player), reason: 'forfeit', forfeitLoser: player });
    }
  }

  /** Rebind a live side to a resumed session (supersession) and resend the tick. */
  rebind(player: Player, side: AgentSide): void {
    if (this.ended) return;
    this.sides[player] = side;
    const turn = this.current;
    if (turn && !turn.resolved) {
      const obs = buildObservation(
        this.state,
        player,
        turn.turnId,
        turn.nonces[player],
        this.deadlines.softMs,
        this.deadlines.hardMs,
      );
      side.send(obs);
    }
  }

  /** Mark a side disconnected; it will Hold and forfeit after 3 hard misses. */
  disconnect(player: Player): void {
    if (this.ended) return;
    this.sides[player] = { kind: 'gone' };
  }

  /** True if `side` (by object identity) is still the bound agent side. */
  isBoundAgent(player: Player, side: AgentSide): boolean {
    return this.sides[player] === side;
  }

  private clearTimers(): void {
    if (this.current?.softTimer) clearTimeout(this.current.softTimer);
    for (const p of this.dhPending.values()) clearTimeout(p.timer);
    this.dhPending.clear();
  }

  private async finish(result: {
    winner: Player | 'draw';
    reason: 'ascension' | 'elimination' | 'timeout' | 'forfeit';
    tiebreak?: 'score' | 'surviving_hp' | 'tokens_spent' | 'draw';
    forfeitLoser?: Player;
  }): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();

    const { winner, reason } = result;
    const finalScores = { A: this.state.scores.A, B: this.state.scores.B };
    const tokensRemaining = { A: this.state.remaining.A, B: this.state.remaining.B };
    const ticksPlayed = this.state.tick;

    // Outcome-decided-once (§1.3): a durable match records its winner under
    // CAS(live → settled). If a recovery abort already won the CAS, this finish
    // still reports to the agents but the durable outcome stays `aborted`.
    if (this.durable) {
      try {
        const cas = await this.stores.matchEvents.casStatus(this.matchId, ['live'], 'settled', {
          winner,
          settledAt: new Date().toISOString(),
        });
        if (cas.existed && !cas.ok) {
          this.log({
            event: 'finish_cas_lost',
            match_id: this.matchId,
            detail: { status: cas.manifest?.status },
          });
        }
      } catch (err) {
        this.log({
          event: 'finish_cas_error',
          match_id: this.matchId,
          detail: { message: (err as Error).message },
        });
      }
    }

    // Self-check: re-simulate from seed + recorded inputs; the chain MUST match.
    const resim = resimulate(this.seed, this.inputs, { matchId: this.matchId });
    const resimOk = resim.replayHash === this.chain;
    if (!resimOk) {
      this.log({
        event: 'replay_divergence',
        match_id: this.matchId,
        detail: { live: this.chain, resim: resim.replayHash },
      });
    }

    const endedAt = new Date().toISOString();
    const resultFor = (p: Player): 'win' | 'loss' | 'draw' =>
      winner === 'draw' ? 'draw' : winner === p ? 'win' : 'loss';
    const summaryPlayers = (this.players ?? []).map((pl) => ({
      ...pl,
      result: resultFor(pl.player_id),
    }));

    // Persist the replay (seed + inputs + tick log + hash chain) and flip the
    // (live) match summary to completed, preserving its directory fields.
    let replayId = 'rpl_' + '0'.repeat(26);
    try {
      const rec = await this.stores.replays.saveReplay({
        seed: this.seed,
        inputs: this.inputs,
        tickLog: this.tickLog,
        hash: this.chain,
        matchId: this.matchId,
      });
      replayId = rec.replayId;
      const completed = {
        matchId: this.matchId,
        status: 'completed' as const,
        mode: 'duel' as const,
        ...(this.league ? { league: this.league } : {}),
        ...(this.startedAt ? { started_at: this.startedAt } : {}),
        ended_at: endedAt,
        ...(summaryPlayers.length ? { players: summaryPlayers } : {}),
        winner,
        reason,
        final_scores: finalScores,
        scores: finalScores,
        tokens_remaining: tokensRemaining,
        ticks_played: ticksPlayed,
        ticks_remaining: 0,
        seed: this.seed,
        replay_id: replayId,
        replay_hash: this.chain,
        resim_ok: resimOk,
      };
      // Upsert (merge over the live record if present, else create).
      const existing = await this.stores.matches.getSummary(this.matchId);
      await this.stores.matches.saveSummary({ ...(existing ?? {}), ...completed });
    } catch (err) {
      this.log({
        event: 'persist_error',
        match_id: this.matchId,
        detail: { message: (err as Error).message },
      });
    }

    // Terminal webhook hook (public result only).
    const endInfo: MatchEndInfo = {
      winner,
      reason,
      ...(reason === 'forfeit' ? { forfeit_reason: 'connection_lost' } : {}),
      ...(reason === 'timeout' && result.tiebreak ? { tiebreak: result.tiebreak } : {}),
      final_scores: finalScores,
      tokens_remaining: tokensRemaining,
      ticks_played: ticksPlayed,
      seed: this.seed,
      replay_id: replayId,
      replay_hash: this.chain,
      players: summaryPlayers,
    };
    this.onFinish?.(endInfo);

    // Emit match_end to each agent side, then close 1000.
    for (const player of ['A', 'B'] as Player[]) {
      const side = this.sides[player];
      if (side.kind !== 'agent') continue;
      const frame: Record<string, unknown> = {
        t: 'match_end',
        match_id: this.matchId,
        winner,
        you: player,
        result: winner === 'draw' ? 'draw' : winner === player ? 'win' : 'loss',
        reason,
        final_scores: finalScores,
        tokens_remaining: tokensRemaining,
        ticks_played: ticksPlayed,
        seed: this.seed,
        replay_id: replayId,
        replay_hash: this.chain,
      };
      if (reason === 'forfeit') frame.forfeit_reason = 'connection_lost';
      if (reason === 'timeout' && result.tiebreak) frame.tiebreak = result.tiebreak;
      side.send(frame);
      side.close(1000, 'match_end');
    }

    this.log({
      event: 'match_end',
      match_id: this.matchId,
      reason,
      detail: {
        winner,
        ticks_played: ticksPlayed,
        replay_id: replayId,
        replay_hash: this.chain,
        resim_ok: resimOk,
      },
    });

    // Fire the finish hooks with the verified record. Only AGENT sides are
    // projected (bots carry no owner). Inert when no hook is set.
    if (finishHooks.length > 0) {
      const tally = tallyMatchEvents(this.tickLog as { type: string; [k: string]: unknown }[]);
      const sides: MatchAgentSide[] = [];
      for (const player of ['A', 'B'] as Player[]) {
        const side = this.sides[player];
        if (side.kind !== 'agent') continue;
        const result = resultFor(player);
        sides.push({
          playerId: player,
          agentId: side.agentId,
          ownerId: side.ownerId,
          displayName: side.displayName,
          result,
          tokensSpent: this.state.spent[player],
          opponentIsHouseBot: this.sides[other(player)].kind === 'bot',
          kills: tally.kills[player],
          nexusTicksHeld: tally.nexus[player],
          reliability: {
            frames: this.relFrames[player],
            onTime: this.relOnTime[player],
            softMisses: this.relSoft[player],
            hardMisses: this.relHard[player],
            forfeit: reason === 'forfeit' && result === 'loss',
            latencyMs: this.relLatency[player],
          },
        });
      }
      if (sides.length > 0) {
        const record: MatchFinishRecord = {
          matchId: this.matchId,
          league: this.league ?? 'core',
          mode: 'duel',
          verified: resimOk,
          winner,
          reason,
          ticksPlayed,
          endedAt,
          ...(replayId ? { replayId } : {}),
          sides,
        };
        for (const hook of finishHooks) {
          try {
            hook(record);
          } catch (err) {
            this.log({
              event: 'finish_hook_error',
              match_id: this.matchId,
              detail: { message: (err as Error).message },
            });
          }
        }
      }
    }

    this.onEnd(this);
  }

  /**
   * Abort a RESUMED match WITHOUT an outcome (Phase 5 B5 — the resume grace
   * window expired with a side still absent). Unlike `finish()` this records no
   * winner; the arena marks the manifest `aborted` under the lifecycle CAS. Unlike `forceClose` (arena drain) it fires `onEnd` so the match
   * is removed from the active set.
   */
  abandon(reason = 'match_aborted'): void {
    if (this.ended) {
      this.clearTimers();
      return;
    }
    this.ended = true;
    this.clearTimers();
    for (const player of ['A', 'B'] as Player[]) {
      const side = this.sides[player];
      if (side.kind === 'agent') side.close(4404, reason);
    }
    this.onEnd(this);
  }

  /** Force-end (arena shutdown). Closes agent sockets with the given code. */
  forceClose(code: number): void {
    if (this.ended) {
      this.clearTimers();
      return;
    }
    this.ended = true;
    this.clearTimers();
    for (const player of ['A', 'B'] as Player[]) {
      const side = this.sides[player];
      if (side.kind === 'agent') side.close(code, 'arena shutdown');
    }
  }
}

export { other };
