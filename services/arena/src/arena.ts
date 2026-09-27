/**
 * The arena: attaches a WSS play loop on /v1/arena to an http.Server and owns
 * session auth, one-session-per-passport supersession, matchmaking, the rolling
 * revocation check, and edge validation (schema + size + rate) BEFORE any engine
 * work. See docs/security/{threat-model,agent-passports}.md and errors.md.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { maxBytes, validators, type Action, type Hello } from 'wot-contracts';
import {
  hasScope,
  resolveDeployEnv,
  TokenExpired,
  TokenInvalid,
  verifyAccessToken,
  type AccessClaims,
  type PassportKeyResolver,
} from 'wot-auth';
import { leagueBudget, newId, passportKeyResolver, WebhookDeliverer, type League, type Stores } from 'wot-store';
import { DEFAULT_CONFIG, type Player } from 'wot-engine';
import type { MatchResumeState } from './match.ts';
import { runRecoveryScan, type RecoveryReport, type ResumeContext } from './recovery.ts';
import {
  ARENA_PATH,
  CLOSE,
  CREDIT_PER_OBSERVATION,
  DEFAULT_CONNECT_LIMITS,
  DEFAULT_DEADLINES,
  MAX_SCHEMA_INVALID,
  MAX_TOO_LARGE,
  RATE_BURST,
  type ConnectLimits,
  type DeadlineConfig,
} from './config.ts';
import { defaultLogger, makeLog, type Logger } from './log.ts';
import { houseBotPolicy, type HouseBotPolicy } from './housebot.ts';
import { type AgentSide, Match, type PlayerMeta, type Side } from './match.ts';
import { RateLimiter } from './ratelimit.ts';
import { sanitizeDisplayName } from './sanitize.ts';
import { createDiplomacyLobby, type DipConn, type DiplomacyLobby } from './diplomacy/lobby.ts';
import type { TableResultSink } from './diplomacy/results.ts';
import { DIP_FRAME_MAX_BYTES } from './diplomacy/wire.ts';

export interface AttachArenaOptions {
  server: HttpServer;
  stores: Stores;
  arenaBaseUrl?: string;
  deadlines?: Partial<DeadlineConfig>;
  /** Pre-auth connect-storm caps (SR-2); merged over DEFAULT_CONNECT_LIMITS. */
  limits?: Partial<ConnectLimits>;
  /** Optional injected house-bot policy (defaults to the A1 §13 floor policy). */
  houseBot?: HouseBotPolicy;
  /**
   * (Phase 5 B5) Run the boot-time recovery scan before accepting traffic. When
   * true, the upgrade listener is registered only AFTER the scan reconciles every
   * open manifest to resume-or-clean-fail, so no new session is
   * served against un-reconciled state (resilience-and-review.md §1.2). Off by
   * default (a fresh store has nothing to recover); a real Cloud-Run boot sets it.
   */
  recover?: boolean;
  /**
   * Grace window (ms) a RESUMED match waits for both agents to reconnect before it
   * conservingly aborts (§1.5). Defaults to a few hard deadlines.
   */
  recoveryGraceMs?: number;
  logger?: Logger;
  /**
   * Environment used for the G-12 dial-in gate (defaults to `process.env`;
   * tests inject it). Only WOT_ENV=development|test serves the anonymous path.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * (Phase 8 B3a, G-11) Passport → public Ed25519 signing key for Diplomacy
   * offers/accepts/renounces. Absent: the store-backed resolver over
   * `stores.passports` (keys minted at registration; B3c). Pass the SAME
   * instance the gateway gets when both planes share a process.
   */
  signingKeys?: PassportKeyResolver;
  /** (Phase 8 B3a) Explicit Diplomacy Ds/Dh (tests); default per eval class. */
  diplomacyDeadlines?: { softMs?: number; hardMs?: number };
  /**
   * (Phase 9 hardening) Diplomacy table lifecycle: the seat-arrival deadline (default 120 s; a
   * table not fully seated in time closes its connected seats 4408 and is released), the grace an
   * ended table stays readable in full before release (default 30 s; 0 under WOT_ENV=test), and
   * the result sink ended tables are handed to (default: an in-memory ring). The hosted seal path
   * passes `memoryResultSink({ onResult })`.
   */
  diplomacyTables?: { seatTimeoutMs?: number; endGraceMs?: number; results?: TableResultSink };
}

/**
 * G-12 remainder: the anonymous, pre-auth WSS dial-in keys its connect-storm
 * caps by `socket.remoteAddress`. That key is only meaningful when clients
 * connect directly (the loopback-bound sandbox). Behind any proxy or load
 * balancer every caller would share the proxy's address (one bucket, trivially
 * exhausted) and a forged forwarding header is not trusted. There is no hosted
 * dial-in (Phase 9 dials OUT to targets), so the path is served ONLY when
 * WOT_ENV is explicitly development|test and refused otherwise (fail closed,
 * like every other dev path in wot-auth).
 */
export function anonymousDialInAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDeployEnv(env.WOT_ENV) !== 'production';
}

export interface ArenaHandle {
  close(): Promise<void>;
  /**
   * Resolves once the boot recovery scan has completed (immediately when
   * `recover` is off). The chaos test awaits this before reconnecting agents.
   */
  ready: Promise<RecoveryReport | null>;
  /** (Phase 8 B3a) Diplomacy tables on this arena path (`hello` with `scenario_id: diplomacy_standard`). */
  diplomacy: DiplomacyLobby;
}

type SessionState = 'awaiting_hello' | 'queued' | 'in_match' | 'closed';

interface SessionCtx {
  ws: WebSocket;
  authed: boolean;
  state: SessionState;
  sessionId?: string;
  claims?: AccessClaims;
  clientId?: string;
  ownerId?: string;
  agentId?: string;
  displayName?: string;
  ticketId?: string;
  /** League this session plays at (from the ticket if present, else the token). */
  league?: League;
  /** Wall-clock enqueue time (FIFO pairing order within a budget tier). */
  enqueuedAt?: number;
  match?: Match;
  side?: Player;
  agentSide?: AgentSide;
  rl: RateLimiter;
  /** Remote IP (for the pre-auth connect-storm caps); '?' until upgrade. */
  ip?: string;
  helloTimer?: NodeJS.Timeout;
  backfillTimer?: NodeJS.Timeout;
  schemaInvalidCount: number;
  tooLargeCount: number;
  rateHits: number;
  /** (Phase 8 B3a) Set once a Diplomacy hello is routed to the lobby. */
  dip?: DipConn;
}

/** Attach the arena WSS play loop to `server` on /v1/arena. */
export function attachArena(opts: AttachArenaOptions): ArenaHandle {
  const deadlines: DeadlineConfig = { ...DEFAULT_DEADLINES, ...(opts.deadlines ?? {}) };
  const limits: ConnectLimits = { ...DEFAULT_CONNECT_LIMITS, ...(opts.limits ?? {}) };
  const houseBot = opts.houseBot ?? houseBotPolicy;
  const log = makeLog(opts.logger ?? defaultLogger);
  const { server, stores } = opts;
  const dialInAllowed = anonymousDialInAllowed(opts.env ?? process.env);
  if (!dialInAllowed) {
    makeLog(opts.logger ?? defaultLogger, 'warn')({
      event: 'dial_in_disabled',
      reason: 'production',
      detail: { note: 'WSS /v1/arena dial-in is sandbox-only (WOT_ENV=development|test); upgrades are refused (G-12)' },
    });
  }

  // Per-league decision deadlines (Ds/Dh) come from the league budget dials.
  // An EXPLICIT soft/hard override (tests) still wins so fast
  // matches stay fast; backfill/hello/revocation stay arena-global.
  const softOverride = opts.deadlines?.softMs;
  const hardOverride = opts.deadlines?.hardMs;
  const deadlinesFor = (league: League): DeadlineConfig => {
    const b = leagueBudget(league).budgets;
    return {
      softMs: softOverride ?? b.soft_deadline_ms,
      hardMs: hardOverride ?? b.hard_deadline_ms,
      backfillMs: deadlines.backfillMs,
      helloTimeoutMs: deadlines.helloTimeoutMs,
      revocationIntervalMs: deadlines.revocationIntervalMs,
    };
  };

  const diplomacy = createDiplomacyLobby({
    stores,
    keys: opts.signingKeys ?? passportKeyResolver(stores.passports),
    env: opts.env ?? process.env,
    log,
    ...(opts.diplomacyDeadlines ? { deadlines: opts.diplomacyDeadlines } : {}),
    ...(opts.diplomacyTables?.seatTimeoutMs !== undefined ? { seatTimeoutMs: opts.diplomacyTables.seatTimeoutMs } : {}),
    ...(opts.diplomacyTables?.endGraceMs !== undefined ? { endGraceMs: opts.diplomacyTables.endGraceMs } : {}),
    ...(opts.diplomacyTables?.results ? { results: opts.diplomacyTables.results } : {}),
  });

  const webhooks = new WebhookDeliverer({
    store: stores.webhooks,
    log: (level, msg, fields) => log({ event: msg, ...(fields ?? {}) } as never),
  });

  // Base WSS origin used to build the arena_url in match.found.
  const wsOrigin = (opts.arenaBaseUrl ?? 'ws://127.0.0.1')
    .replace(/\/+$/, '')
    .replace(/\/v1\/arena$/, '');
  const arenaUrl = `${wsOrigin}${ARENA_PATH}`;

  // maxPayload = the largest frame in the whole protocol (observation, 16 KB) so
  // `ws` drops a truly-huge frame at the protocol layer instead of buffering up
  // to its 100 MiB default before our own size check — the single arena instance
  // is the availability chokepoint (SR-2 MEDIUM; threat-model §9). Frames in the
  // 8–16 KB band still hit the app-level `too_large`/4413 path; a frame ABOVE
  // 16 KB is closed by ws with the RFC 6455 standard code 1009 (message too big),
  // which is the correct protocol-layer signal and needs no app-specific mapping.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const registry = new Map<string, SessionCtx>(); // client_id -> live session
  const queue: SessionCtx[] = [];
  const activeMatches = new Set<Match>();
  const sockets = new Set<WebSocket>();

  // ---- across-restart resume state (Phase 5 B5) ----
  // A recovered live match binds to the agent_ids that must reconnect; a `hello`
  // from a matching passport (after FULL authz) re-binds to its side. A grace
  // timer conservingly aborts a resumed match no side reclaimed in time.
  const recoveredSides = new Map<string, { match: Match; player: Player }>(); // agent_id -> side
  const recoveryGraceTimers = new Map<Match, NodeJS.Timeout>();
  const recoveryGraceMs = opts.recoveryGraceMs ?? Math.max(3000, deadlines.hardMs * 4);

  // ---- pre-auth connect-storm state (SR-2) ----
  const perIpOpen = new Map<string, number>(); // currently-open sockets per IP
  const ipBuckets = new Map<string, RateLimiter>(); // per-IP connect-rate buckets
  // Keyed by the socket peer address: valid only for direct connections, which
  // is why the whole path is gated to development|test (G-12, see above).
  const ipOf = (req: IncomingMessage): string | null => req.socket.remoteAddress ?? null;
  const ipBucket = (ip: string): RateLimiter => {
    let b = ipBuckets.get(ip);
    if (!b) {
      b = new RateLimiter(limits.connectRatePerSec, limits.connectBurst);
      ipBuckets.set(ip, b);
    }
    return b;
  };
  const refuseUpgrade = (socket: Duplex, status: number, text: string): void => {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      /* ignore */
    }
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  // ---- upgrade routing (only our path; leave others for other listeners) ----
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== ARENA_PATH) return; // not ours

    // Connect-storm caps, enforced BEFORE allocating a session (the arena is the
    // trust boundary; it must not assume the LB throttles). Refuse over-limit
    // upgrades with a plain HTTP error and no WSS handshake.
    // G-12: refused outright outside development|test, BEFORE any per-address
    // state is touched; a socket with no peer address never shares a bucket.
    if (!dialInAllowed) {
      log({ event: 'connect_refused', reason: 'dial_in_disabled' });
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const ip = ipOf(req);
    if (ip === null) {
      log({ event: 'connect_refused', reason: 'no_peer_address' });
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (!ipBucket(ip).tryConsume()) {
      log({ event: 'connect_refused', reason: 'connect_rate', detail: { ip } });
      refuseUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    if (sockets.size >= limits.maxSocketsGlobal) {
      log({ event: 'connect_refused', reason: 'global_concurrency', detail: { ip } });
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if ((perIpOpen.get(ip) ?? 0) >= limits.maxSocketsPerIp) {
      log({ event: 'connect_refused', reason: 'per_ip_concurrency', detail: { ip } });
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      perIpOpen.set(ip, (perIpOpen.get(ip) ?? 0) + 1);
      (ws as WebSocket & { _arenaIp?: string })._arenaIp = ip;
      wss.emit('connection', ws, req);
    });
  };
  // The upgrade listener is registered by the readiness gate near the end of
  // attachArena — AFTER the boot recovery scan (§1.2), so no new session is
  // accepted against un-reconciled open manifests when `recover` is on.

  // ---- helpers ----
  const send = (ctx: SessionCtx, frame: unknown): void => {
    if (ctx.ws.readyState === WebSocket.OPEN) ctx.ws.send(JSON.stringify(frame));
  };
  const sendReject = (
    ctx: SessionCtx,
    r: { reason: string; hint: string; turn_id?: number | null; retryable?: boolean },
  ): void => {
    send(ctx, {
      t: 'reject',
      turn_id: r.turn_id ?? null,
      reason: r.reason,
      hint: r.hint,
      ...(r.retryable !== undefined ? { retryable: r.retryable } : {}),
    });
  };
  const makeAgentSide = (ctx: SessionCtx): AgentSide => ({
    kind: 'agent',
    send: (frame) => {
      // Credit the inbound budget by the server's own observation cadence so a
      // legitimate one-action-per-observation agent is never rate-limited.
      if ((frame as { t?: unknown } | null)?.t === 'observation') {
        ctx.rl.credit(CREDIT_PER_OBSERVATION);
      }
      send(ctx, frame);
    },
    close: (code, reason) => {
      try {
        ctx.ws.close(code, reason);
      } catch {
        /* ignore */
      }
    },
    clientId: ctx.clientId!,
    ownerId: ctx.ownerId!,
    sessionId: ctx.sessionId!,
    agentId: ctx.agentId!,
    displayName: ctx.displayName!,
  });

  const removeFromQueue = (ctx: SessionCtx): void => {
    const i = queue.indexOf(ctx);
    if (i >= 0) queue.splice(i, 1);
  };

  /**
   * Common match bring-up: write the `live` match summary, fire the
   * `match.found` webhook, and build the Match wired to fire `match.end` at the
   * end.
   */
  const beginMatch = (params: {
    matchId: string;
    seed: number;
    league: League;
    sides: Record<Player, Side>;
    players: [PlayerMeta, PlayerMeta];
    owners: Partial<Record<Player, string>>;
    ticketByOwner?: Record<string, string>;
    /** Durable (manifest + per-tick log) — set for agent-vs-agent matches. */
    durable?: boolean;
    /** (B5) Reconstructed state to resume from after a restart (recovery only). */
    resumeFrom?: MatchResumeState;
  }): Match => {
    const { matchId, seed, league, sides, players, owners, ticketByOwner } = params;
    const startedAt = new Date().toISOString();

    void stores.matches
      .saveSummary({
        matchId,
        mode: 'duel',
        league,
        status: 'live',
        players,
        started_at: startedAt,
      })
      .catch(() => undefined);

    webhooks.matchFound({
      matchId,
      league,
      arenaUrl,
      ...(ticketByOwner ? { ticketByOwner } : {}),
      players: players.map((p) => ({ ...p, ownerId: owners[p.player_id] })),
    });

    const match = new Match({
      matchId,
      seed,
      deadlines: deadlinesFor(league),
      sides,
      stores,
      log,
      onEnd: (m) => {
        activeMatches.delete(m);
      },
      // League action-allowance budget (Grid Tactics v1 §4.5) for the engine.
      config: { allowance: leagueBudget(league).budgets.action_allowance },
      ...(params.durable ? { durable: true } : {}),
      ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
      players,
      league,
      startedAt,
      onFinish: (end) => {
        webhooks.matchEnd({
          matchId,
          league,
          winner: end.winner,
          reason: end.reason,
          ...(end.forfeit_reason ? { forfeitReason: end.forfeit_reason } : {}),
          ...(end.tiebreak ? { tiebreak: end.tiebreak } : {}),
          finalScores: end.final_scores,
          tokensRemaining: end.tokens_remaining,
          ticksPlayed: end.ticks_played,
          seed: end.seed,
          replayId: end.replay_id,
          replayHash: end.replay_hash,
          endedAt: new Date().toISOString(),
          players: end.players.map((p) => ({ ...p, ownerId: owners[p.player_id] })),
        });
      },
    });
    activeMatches.add(match);
    return match;
  };

  const metaOf = (ctx: SessionCtx, player: Player): PlayerMeta => ({
    player_id: player,
    agent_id: ctx.agentId!,
    display_name: ctx.displayName!,
  });

  /**
   * Write the durable lifecycle manifest for an agent-vs-agent match (Phase 5
   * B5) BEFORE bring-up, so a crash during bring-up still leaves a recoverable
   * record (status `starting` → recovery aborts). Best-effort: a manifest store
   * error must not block the match (it then runs non-durable).
   */
  const openManifest = async (
    matchId: string,
    seed: number,
    league: League,
    a: SessionCtx,
    b: SessionCtx,
  ): Promise<boolean> => {
    const at = new Date().toISOString();
    try {
      await stores.matchEvents.putManifest({
        matchId,
        mode: 'duel',
        seed,
        league,
        status: 'starting',
        startedAt: at,
        updatedAt: at,
        sides: [
          { player: 'A', agentId: a.agentId!, ownerId: a.ownerId, ...(a.ticketId ? { ticketId: a.ticketId } : {}) },
          { player: 'B', agentId: b.agentId!, ownerId: b.ownerId, ...(b.ticketId ? { ticketId: b.ticketId } : {}) },
        ],
      });
      return true;
    } catch (err) {
      log({ event: 'manifest_error', match_id: matchId, detail: { message: (err as Error).message } });
      return false;
    }
  };

  const startMatch = async (a: SessionCtx, b: SessionCtx): Promise<void> => {
    if (a.backfillTimer) clearTimeout(a.backfillTimer);
    if (b.backfillTimer) clearTimeout(b.backfillTimer);
    // Reserve both sides synchronously so a concurrent tryPair cannot re-select
    // them while the manifest write awaits.
    a.side = 'A';
    b.side = 'B';
    a.state = 'in_match';
    b.state = 'in_match';
    const seed = randomInt(1, 2 ** 31 - 1);
    const matchId = newId('mat');
    a.agentSide = makeAgentSide(a);
    b.agentSide = makeAgentSide(b);
    const sides: Record<Player, Side> = { A: a.agentSide, B: b.agentSide };
    const league = a.league ?? b.league ?? 'core';

    const durable = await openManifest(matchId, seed, league, a, b);

    const ticketByOwner: Record<string, string> = {};
    if (a.ownerId && a.ticketId) ticketByOwner[a.ownerId] = a.ticketId;
    if (b.ownerId && b.ticketId) ticketByOwner[b.ownerId] = b.ticketId;
    const match = beginMatch({
      matchId,
      seed,
      league,
      sides,
      players: [metaOf(a, 'A'), metaOf(b, 'B')],
      owners: { A: a.ownerId, B: b.ownerId },
      ticketByOwner,
      durable,
    });
    a.match = match;
    b.match = match;
    for (const c of [a, b]) {
      if (c.ticketId) void stores.tickets.bindMatch(c.ticketId, matchId).catch(() => undefined);
    }
    // Flip the durable lifecycle to `live` before the tick loop begins so a crash
    // now leaves a resumable (not a bring-up-abort) record.
    if (durable) {
      await stores.matchEvents
        .casStatus(matchId, ['starting'], 'live')
        .catch((err) => log({ event: 'manifest_error', match_id: matchId, detail: { message: (err as Error).message } }));
    }
    log({
      event: 'match_paired',
      match_id: matchId,
      detail: { A: a.clientId, B: b.clientId },
    });
    match.start();
  };

  const startBotMatch = (a: SessionCtx): void => {
    const seed = randomInt(1, 2 ** 31 - 1);
    const matchId = newId('mat');
    a.side = 'A';
    a.agentSide = makeAgentSide(a);
    const sides: Record<Player, Side> = {
      A: a.agentSide,
      B: { kind: 'bot', policy: houseBot },
    };
    const botMeta: PlayerMeta = { player_id: 'B', agent_id: newId('agt'), display_name: 'House Bot' };
    const ticketByOwner: Record<string, string> = {};
    if (a.ownerId && a.ticketId) ticketByOwner[a.ownerId] = a.ticketId;
    const match = beginMatch({
      matchId,
      seed,
      league: a.league ?? 'core',
      sides,
      players: [metaOf(a, 'A'), botMeta],
      owners: { A: a.ownerId },
      ticketByOwner,
    });
    a.match = match;
    a.state = 'in_match';
    if (a.ticketId) void stores.tickets.bindMatch(a.ticketId, matchId).catch(() => undefined);
    log({ event: 'match_paired', match_id: matchId, detail: { A: a.clientId, B: 'house_bot' } });
    match.start();
  };

  // ---- across-restart resume (Phase 5 B5) ----
  // Abort a resumed match whose grace window expired with a side still absent:
  // stop WITHOUT an outcome and mark it `aborted` under the lifecycle CAS
  // (exactly-once). Never invents a winner for a no-show match.
  const abortResumed = async (match: Match, matchId: string): Promise<void> => {
    const t = recoveryGraceTimers.get(match);
    if (t) clearTimeout(t);
    recoveryGraceTimers.delete(match);
    for (const [agentId, rs] of [...recoveredSides]) if (rs.match === match) recoveredSides.delete(agentId);
    match.abandon('match_aborted');
    const cas = await stores.matchEvents
      .casStatus(matchId, ['live'], 'aborted', { abortReason: 'aborted_conserving' })
      .catch(() => ({ existed: false, ok: false, manifest: null }));
    if (cas.ok) {
      await stores.matches
        .updateSummary(matchId, {
          status: 'aborted',
          reason: 'aborted_conserving',
          ended_at: new Date().toISOString(),
          recovered: true,
        })
        .catch(() => undefined);
      log({ event: 'recovery_grace_abort', match_id: matchId });
    }
  };

  // The live-resume hook the recovery scan calls for a mid-match resumable orphan:
  // rebuild the live Match at the reconstructed pre-crash state with both sides
  // `gone`, register the reconnect bindings by agent_id (via beginMatch), and
  // start a bounded grace window. Deadlines run from the
  // resumed tick (reconnect buys no think time — threat-model §4).
  const resumeLive = (ctx: ResumeContext): boolean => {
    const { manifest, resume } = ctx;
    const sideA = manifest.sides.find((s) => s.player === 'A');
    const sideB = manifest.sides.find((s) => s.player === 'B');
    if (!sideA || !sideB) return false;
    const players: [PlayerMeta, PlayerMeta] = [
      { player_id: 'A', agent_id: sideA.agentId, display_name: `Agent ${sideA.agentId.slice(4, 12)}` },
      { player_id: 'B', agent_id: sideB.agentId, display_name: `Agent ${sideB.agentId.slice(4, 12)}` },
    ];
    const sides: Record<Player, Side> = { A: { kind: 'gone' }, B: { kind: 'gone' } };
    const match = beginMatch({
      matchId: manifest.matchId,
      seed: manifest.seed,
      league: manifest.league,
      sides,
      players,
      owners: { A: sideA.ownerId, B: sideB.ownerId },
      durable: true,
      resumeFrom: resume,
    });
    recoveredSides.set(sideA.agentId, { match, player: 'A' });
    recoveredSides.set(sideB.agentId, { match, player: 'B' });
    const graceTimer = setTimeout(() => void abortResumed(match, manifest.matchId), recoveryGraceMs);
    if (typeof graceTimer.unref === 'function') graceTimer.unref();
    recoveryGraceTimers.set(match, graceTimer);
    log({ event: 'match_resumed', match_id: manifest.matchId, detail: { tick: resume.state.tick } });
    match.start();
    return true;
  };

  // Matchmaking pairs WITHIN a budget tier (league), first-come first-served.
  // There is no skill ladder since ADR-001: the arena evaluates agents, it does
  // not rank them, so the two longest-waiting sessions of a tier are paired.
  const selectPair = (): [SessionCtx, SessionCtx] | null => {
    const q = queue
      .filter((c) => c.state === 'queued' && c.ws.readyState === WebSocket.OPEN)
      .sort((x, y) => (x.enqueuedAt ?? 0) - (y.enqueuedAt ?? 0));
    for (let i = 0; i < q.length; i++) {
      const j = q.findIndex((c, k) => k > i && c.league === q[i].league);
      if (j < 0) continue;
      const pair: [SessionCtx, SessionCtx] = [q[i], q[j]];
      removeFromQueue(pair[0]);
      removeFromQueue(pair[1]);
      return pair;
    }
    return null;
  };

  const tryPair = (): void => {
    for (;;) {
      const pair = selectPair();
      if (!pair) break;
      void startMatch(pair[0], pair[1]).catch((err) =>
        log({ event: 'handler_error', detail: { message: (err as Error).message } }),
      );
    }
  };

  const enqueue = (ctx: SessionCtx): void => {
    ctx.state = 'queued';
    ctx.enqueuedAt = Date.now();
    queue.push(ctx);
    ctx.backfillTimer = setTimeout(() => {
      if (ctx.state === 'queued' && ctx.ws.readyState === WebSocket.OPEN) {
        removeFromQueue(ctx);
        startBotMatch(ctx);
      }
    }, deadlines.backfillMs);
    tryPair();
  };

  const supersede = (oldCtx: SessionCtx, newCtx: SessionCtx): void => {
    send(oldCtx, {
      t: 'session_superseded',
      session_id: oldCtx.sessionId,
      superseded_by: newCtx.sessionId,
      reason: 'another connection authenticated with this passport',
      ts: new Date().toISOString(),
    });
    if (oldCtx.match && oldCtx.side) {
      // Transfer the live-match binding to the new session (reconnect semantics).
      newCtx.match = oldCtx.match;
      newCtx.side = oldCtx.side;
      newCtx.state = 'in_match';
      newCtx.agentSide = makeAgentSide(newCtx);
      oldCtx.match.rebind(oldCtx.side, newCtx.agentSide);
      oldCtx.match = undefined;
      oldCtx.side = undefined;
    } else if (oldCtx.state === 'queued') {
      removeFromQueue(oldCtx);
    }
    oldCtx.state = 'closed';
    try {
      oldCtx.ws.close(CLOSE.SUPERSEDED, 'session superseded');
    } catch {
      /* ignore */
    }
    log({
      event: 'session_superseded',
      client_id: newCtx.clientId,
      session_id: oldCtx.sessionId,
      code: CLOSE.SUPERSEDED,
    });
  };

  // ---- Diplomacy seat connection (Phase 8 B3a) ----
  const dipConnFor = (ctx: SessionCtx): DipConn => {
    if (ctx.dip) return ctx.dip;
    ctx.dip = {
      send: (frame) => {
        if ((frame as { t?: unknown } | null)?.t === 'diplomacy_observation') ctx.rl.credit(CREDIT_PER_OBSERVATION);
        send(ctx, frame);
      },
      close: (code, reason) => closeSocket(ctx, code, reason),
      onAuthed: (info) => {
        if (ctx.helloTimer) clearTimeout(ctx.helloTimer);
        ctx.authed = true;
        ctx.state = 'in_match';
        ctx.clientId = info.clientId;
        ctx.agentId = info.agentId;
        ctx.ownerId = info.ownerId;
        ctx.sessionId = info.sessionId;
      },
      // D-1 (CHAOS-DIPLOMACY): a schema-invalid diplomacy_action counts toward the SAME per-session
      // escalation as a duel `action` (errors.md: repeated schema_invalid → 4400; "the same codes").
      onSchemaInvalid: () => {
        ctx.schemaInvalidCount += 1;
        if (ctx.schemaInvalidCount >= MAX_SCHEMA_INVALID) closeSocket(ctx, CLOSE.MALFORMED, 'repeated schema_invalid');
      },
    };
    return ctx.dip;
  };

  // ---- hello ----
  const handleHello = async (ctx: SessionCtx, obj: unknown, bytes: number): Promise<void> => {
    if (ctx.authed) {
      sendReject(ctx, { reason: 'unknown_frame', hint: 'already authenticated', retryable: false });
      return;
    }
    if (bytes > maxBytes('hello')) {
      sendReject(ctx, { reason: 'too_large', hint: 'hello exceeds byte cap', retryable: false });
      return;
    }
    if (!validators.hello(obj)) {
      sendReject(ctx, {
        reason: 'schema_invalid',
        hint: 'hello failed schema validation',
        retryable: false,
      });
      return;
    }
    const hello = obj as Hello;

    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(hello.token);
    } catch (err) {
      const code = CLOSE.UNAUTHENTICATED;
      const reason = err instanceof TokenExpired ? 'token_expired' : 'token_invalid';
      log({ event: 'auth_failed', code, reason });
      closeSocket(ctx, code, 'unauthenticated');
      void (err instanceof TokenInvalid); // typed handling; both map to 4401
      return;
    }

    if (!hasScope(claims, 'play:duel')) {
      log({ event: 'forbidden', client_id: claims.client_id, code: CLOSE.FORBIDDEN, reason: 'missing_scope' });
      closeSocket(ctx, CLOSE.FORBIDDEN, 'missing play:duel scope');
      return;
    }

    // Strongly-consistent revocation check at connect (passport/owner status).
    const passport = await stores.passports.getByClientId(claims.client_id);
    if (!passport || passport.status !== 'active') {
      log({
        event: 'forbidden',
        client_id: claims.client_id,
        owner_id: claims.owner_id,
        code: CLOSE.FORBIDDEN,
        reason: 'passport_or_owner_revoked',
      });
      closeSocket(ctx, CLOSE.FORBIDDEN, 'passport revoked or not active');
      return;
    }

    // Resolve a matchmaking ticket if supplied. It was minted by the gateway's
    // rate-limited POST /v1/queue for THIS passport, so match admission stays on
    // the gateway's per-passport/per-owner buckets instead of a direct enqueue
    // that bypasses them. Validate ownership + mode; an unknown ticket and a
    // foreign ticket are refused IDENTICALLY (close 4403, no enumeration oracle).
    // Absent ticket_id keeps the direct-enqueue path (schema marks it optional;
    // the house-bot/test paths rely on it).
    let sessionLeague: League = claims.league;
    if (hello.ticket_id) {
      const ticket = await stores.tickets.getTicket(hello.ticket_id);
      const valid =
        !!ticket &&
        ticket.ownerId === claims.owner_id &&
        ticket.agentId === claims.agent_id &&
        ticket.mode === 'duel' &&
        ticket.status !== 'closed';
      if (!valid) {
        log({
          event: 'forbidden',
          client_id: claims.client_id,
          owner_id: claims.owner_id,
          code: CLOSE.FORBIDDEN,
          reason: 'ticket_invalid',
        });
        closeSocket(ctx, CLOSE.FORBIDDEN, 'ticket is unknown or not valid for this passport');
        return;
      }
      sessionLeague = ticket.league; // authoritative league from the queue path
    }

    if (ctx.helloTimer) clearTimeout(ctx.helloTimer);
    ctx.authed = true;
    ctx.claims = claims;
    ctx.clientId = claims.client_id;
    ctx.ownerId = claims.owner_id;
    ctx.agentId = claims.agent_id;
    // Public broadcast name: the passport's sanitized display name, or a stable
    // fallback derived from the (safe) agent id for fixtures without one.
    ctx.displayName = passport.displayName
      ? sanitizeDisplayName(passport.displayName)
      : `Agent ${claims.agent_id.slice(4, 12)}`;
    ctx.sessionId = newId('ses');
    ctx.ticketId = hello.ticket_id;
    ctx.league = sessionLeague;

    // One live session per passport: supersede any existing session.
    const existing = registry.get(claims.client_id);
    if (existing && existing !== ctx) supersede(existing, ctx);
    registry.set(claims.client_id, ctx);

    // Across-restart resume (§1.5): if this passport's agent_id owns a RECOVERED
    // live match side, re-bind to it (the same rebind path as in-process
    // supersession) instead of joining matchmaking. The passport binds the side —
    // full connect authz already ran above, so a reconnect can never claim a
    // DIFFERENT agent's slot (there is no "resume by match_id alone"). The
    // observation is (re)sent AFTER the ack so the resume cursor follows it.
    let resumedNow = false;
    if (!ctx.match) {
      const recovered = recoveredSides.get(claims.agent_id);
      if (recovered) {
        ctx.match = recovered.match;
        ctx.side = recovered.player;
        ctx.state = 'in_match';
        ctx.agentSide = makeAgentSide(ctx);
        recoveredSides.delete(claims.agent_id);
        resumedNow = true;
        // Both sides reclaimed → cancel the conserving-abort grace window.
        const stillGone = [...recoveredSides.values()].some((rs) => rs.match === recovered.match);
        if (!stillGone) {
          const gt = recoveryGraceTimers.get(recovered.match);
          if (gt) clearTimeout(gt);
          recoveryGraceTimers.delete(recovered.match);
        }
        log({ event: 'session_resumed', client_id: ctx.clientId, session_id: ctx.sessionId, match_id: recovered.match.matchId });
      }
    }

    const budget = leagueBudget(sessionLeague).budgets;
    const md = deadlinesFor(sessionLeague);
    const resumedMatchId = ctx.match ? ctx.match.matchId : null;
    send(ctx, {
      t: 'ack',
      ack_type: 'session',
      session_id: ctx.sessionId,
      mode: 'duel',
      league: sessionLeague,
      match_id: resumedMatchId,
      config: {
        soft_deadline_ms: md.softMs,
        hard_deadline_ms: md.hardMs,
        action_allowance: budget.action_allowance,
        tick_cap: budget.tick_cap,
        collapse_start: DEFAULT_CONFIG.collapseStart,
        ascension_target: DEFAULT_CONFIG.ascensionTarget,
      },
    });
    log({
      event: 'session_bound',
      client_id: ctx.clientId,
      owner_id: ctx.ownerId,
      session_id: ctx.sessionId,
    });

    // A recovered reconnect: after the ack, (re)send the current-tick observation
    // — that observation IS the resume cursor the agent echoes to continue.
    if (resumedNow && ctx.match && ctx.side && ctx.agentSide) {
      ctx.match.rebind(ctx.side, ctx.agentSide);
    }

    // If we did not take over (or resume) a live match, join matchmaking.
    if (!ctx.match) enqueue(ctx);
  };

  // ---- message handling (edge validation before any engine work) ----
  const handleMessage = async (ctx: SessionCtx, data: RawData): Promise<void> => {
    if (!ctx.rl.tryConsume()) {
      ctx.rateHits += 1;
      log({ event: 'frame_rejected', client_id: ctx.clientId, reason: 'rate_limited' });
      sendReject(ctx, { reason: 'rate_limited', hint: 'inbound frame-rate limit exceeded', retryable: true });
      if (ctx.rateHits > RATE_BURST) closeSocket(ctx, CLOSE.RATE_LIMITED, 'sustained rate abuse');
      return;
    }

    const raw = typeof data === 'string' ? data : data.toString('utf8');
    const bytes = Buffer.byteLength(raw, 'utf8');
    // Hard ceiling = the largest inbound cap of this session: action 8 KB, or
    // diplomacy_action 16 KB once a Diplomacy seat is bound. Repeated → 4413.
    if (bytes > (ctx.dip?.seat ? DIP_FRAME_MAX_BYTES : maxBytes('action'))) {
      ctx.tooLargeCount += 1;
      // contracts 2.5.0 (errors.md §3a): a session with no accepted hello can only be sending a
      // hello, and an oversize hello is never retryable. Frames of 8193..16384 bytes reach this
      // guard (above 16384 the ws layer closes 1009); authenticated sessions keep `retryable: true`.
      sendReject(ctx, { reason: 'too_large', hint: 'frame exceeds byte cap', retryable: ctx.authed });
      if (ctx.tooLargeCount >= MAX_TOO_LARGE) closeSocket(ctx, CLOSE.TOO_LARGE, 'repeated oversized frames');
      return;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      // Unparseable is connection-level: cannot extract a turn_id to reject.
      sendReject(ctx, { reason: 'unparseable', hint: 'body is not valid JSON', turn_id: null });
      closeSocket(ctx, CLOSE.MALFORMED, 'unparseable frame');
      return;
    }
    if (typeof obj !== 'object' || obj === null || typeof (obj as { t?: unknown }).t !== 'string') {
      sendReject(ctx, { reason: 'unknown_frame', hint: 'missing frame type discriminator', retryable: false });
      return;
    }

    const t = (obj as { t: string }).t;
    if (t === 'hello') {
      if (diplomacy.isDiplomacyHello(obj) && !ctx.authed) {
        await diplomacy.handleHello(dipConnFor(ctx), obj as Record<string, unknown>, bytes);
        return;
      }
      await handleHello(ctx, obj, bytes);
      return;
    }

    if (t === 'diplomacy_action') {
      if (!ctx.dip) {
        sendReject(ctx, { reason: 'no_active_match', hint: 'no Diplomacy seat on this session', retryable: false });
        return;
      }
      void diplomacy.handleAction(ctx.dip, obj, bytes);
      return;
    }

    if (t === 'action') {
      if (!ctx.authed || !ctx.match || !ctx.side) {
        sendReject(ctx, { reason: 'no_active_match', hint: 'no live match on this session', retryable: false });
        return;
      }
      if (bytes > maxBytes('action')) {
        sendReject(ctx, { reason: 'too_large', hint: 'action exceeds byte cap', retryable: true });
        return;
      }
      if (!validators.action(obj)) {
        ctx.schemaInvalidCount += 1;
        sendReject(ctx, {
          reason: 'schema_invalid',
          hint: 'action failed schema validation',
          turn_id: (obj as { turn_id?: number }).turn_id ?? null,
          retryable: true,
        });
        if (ctx.schemaInvalidCount >= MAX_SCHEMA_INVALID) closeSocket(ctx, CLOSE.MALFORMED, 'repeated schema_invalid');
        return;
      }
      // An optional `thought` on the action is accepted by the schema and
      // dropped: there is no live spectator relay (ADR-001 §6, B0-21). It is
      // NEVER delivered to the opponent and NEVER parsed by the engine.
      ctx.match.submitAction(ctx.side, obj as Action);
      return;
    }

    if (t === 'thought') {
      // Validate + size-cap, then drop: a thought had one consumer, the live
      // spectator relay, which is cut (ADR-001 §6). Never parsed by the engine;
      // NEVER relayed to the opponent.
      if (bytes > maxBytes('thought') || !validators.thought(obj)) {
        sendReject(ctx, { reason: 'schema_invalid', hint: 'thought failed validation', retryable: true });
      }
      return;
    }

    sendReject(ctx, { reason: 'unknown_frame', hint: `unrecognized frame type: ${t}`, retryable: false });
  };

  // ---- connection lifecycle ----
  const closeSocket = (ctx: SessionCtx, code: number, reason: string): void => {
    try {
      ctx.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  };

  const onClose = (ctx: SessionCtx): void => {
    if (ctx.helloTimer) clearTimeout(ctx.helloTimer);
    if (ctx.dip) diplomacy.onClose(ctx.dip);
    if (ctx.backfillTimer) clearTimeout(ctx.backfillTimer);
    removeFromQueue(ctx);
    if (ctx.clientId && registry.get(ctx.clientId) === ctx) registry.delete(ctx.clientId);
    // Only mark the match side gone if THIS session is still the bound agent
    // (a superseded session already transferred its binding).
    if (ctx.match && ctx.side && ctx.agentSide && ctx.match.isBoundAgent(ctx.side, ctx.agentSide)) {
      ctx.match.disconnect(ctx.side);
    }
    ctx.state = 'closed';
    sockets.delete(ctx.ws);
    // Release the per-IP concurrency slot taken at upgrade.
    if (ctx.ip) {
      const n = (perIpOpen.get(ctx.ip) ?? 1) - 1;
      if (n <= 0) perIpOpen.delete(ctx.ip);
      else perIpOpen.set(ctx.ip, n);
    }
  };

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    const ctx: SessionCtx = {
      ws,
      authed: false,
      state: 'awaiting_hello',
      ip: (ws as WebSocket & { _arenaIp?: string })._arenaIp,
      rl: new RateLimiter(),
      schemaInvalidCount: 0,
      tooLargeCount: 0,
      rateHits: 0,
    };
    ctx.helloTimer = setTimeout(() => {
      if (!ctx.authed) closeSocket(ctx, CLOSE.UNAUTHENTICATED, 'no hello');
    }, deadlines.helloTimeoutMs);

    ws.on('message', (data: RawData) => {
      void handleMessage(ctx, data).catch((err) => {
        log({ event: 'handler_error', detail: { message: (err as Error).message } });
      });
    });
    ws.on('close', () => onClose(ctx));
    ws.on('error', () => {
      /* errors surface as a subsequent close; nothing to log that isn't a token */
    });
  });

  // ---- rolling revocation (every 30 s by default) ----
  const revocationTimer = setInterval(() => {
    void (async () => {
      for (const ctx of [...registry.values()]) {
        if (!ctx.clientId) continue;
        try {
          const passport = await stores.passports.getByClientId(ctx.clientId);
          // The existing passport-status gate already cascades owner-ban + parent-
          // revoke for a delegated child too, because a child's client_id IS the
          // parent's cid_ (§5.4). For CHILD sessions only, add the two net-new
          // gates — grant status and the jti denylist — so a grant-dissolve or a
          // single-child kill also closes ≤ 30 s. Roots skip this branch entirely.
          let revokedReason: string | null =
            !passport || passport.status !== 'active' ? 'passport_or_owner_revoked' : null;
          const d = ctx.claims?.delegation;
          if (!revokedReason && d) {
            const grant = await stores.delegations.getGrant(d.grant_id);
            if (!grant || grant.status !== 'active' || Date.parse(grant.expiresAt) <= Date.now()) {
              revokedReason = 'grant_revoked';
            } else if (await stores.delegations.isJtiRevoked(ctx.claims!.jti)) {
              revokedReason = 'jti_revoked';
            }
          }
          if (revokedReason) {
            send(ctx, {
              t: 'session_revoked',
              session_id: ctx.sessionId,
              reason: revokedReason,
              ts: new Date().toISOString(),
            });
            log({
              event: 'session_revoked',
              client_id: ctx.clientId,
              session_id: ctx.sessionId,
              code: CLOSE.REVOKED,
            });
            closeSocket(ctx, CLOSE.REVOKED, 'session revoked');
          }
        } catch {
          /* transient store error — re-checked next interval */
        }
      }
      // Diplomacy seats are not in `registry` (no duel supersession); same status gate.
      await diplomacy.revalidate();
      // Prune idle per-IP connect buckets (fully replenished, no open sockets)
      // so the maps do not grow unbounded across many distinct peers.
      for (const [ip, bucket] of ipBuckets) {
        if (!perIpOpen.has(ip) && bucket.isFull()) ipBuckets.delete(ip);
      }
    })();
  }, deadlines.revocationIntervalMs);
  if (typeof revocationTimer.unref === 'function') revocationTimer.unref();

  // ---- boot recovery gate (Phase 5 B5) ----
  // With `recover` on, the upgrade listener is registered only AFTER the recovery
  // scan reconciles every open manifest — so no session is
  // served against un-reconciled state. Off (default) preserves the prior
  // synchronous-attach behaviour (a fresh store has nothing to recover).
  let closed = false;
  let ready: Promise<RecoveryReport | null>;
  if (opts.recover) {
    ready = (async () => {
      try {
        return await runRecoveryScan({ stores, log, resumeLive });
      } catch (err) {
        log({ event: 'recovery_error', detail: { message: (err as Error).message } });
        return null;
      } finally {
        if (!closed) server.on('upgrade', onUpgrade);
      }
    })();
  } else {
    server.on('upgrade', onUpgrade);
    ready = Promise.resolve(null);
  }

  // ---- shutdown ----
  const close = async (): Promise<void> => {
    closed = true;
    clearInterval(revocationTimer);
    server.removeListener('upgrade', onUpgrade);
    for (const t of recoveryGraceTimers.values()) clearTimeout(t);
    recoveryGraceTimers.clear();
    recoveredSides.clear();
    for (const match of [...activeMatches]) match.forceClose(1012);
    diplomacy.close();
    for (const ws of [...sockets]) {
      try {
        ws.close(1012, 'arena draining');
      } catch {
        /* ignore */
      }
    }
    webhooks.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { close, ready, diplomacy };
}
