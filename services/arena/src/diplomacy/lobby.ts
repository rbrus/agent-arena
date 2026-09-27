/**
 * The Diplomacy lobby on the arena WSS path (`/v1/arena`): tables, the
 * Diplomacy `hello`, and the `diplomacy_action` edge. The arena's connection
 * handling (connect-storm caps, rate limits, frame-size ceiling, hello timer,
 * rolling revocation) stays in arena.ts; a `hello` carrying
 * `scenario_id: "diplomacy_standard"` is routed here.
 *
 *   hello {t, protocol_version, token, scenario_id, table_id}
 *     → token verified (wot-auth), scope `negotiate:a2a`, passport active,
 *       the agent is seated at the table (the seat binds the power; the client
 *       never names it), one live session per seat (a newer one supersedes)
 *     → session ack (`wot:ack:diplomacy:1`) → observations once every agent
 *       seat is connected.
 *   The hello is `wot:hello:diplomacy:1` (contracts 2.4.0): 2048-byte cap, then
 *   the contract schema (additionalProperties false: no `dpop`, no power).
 *   diplomacy_action → 16384-byte cap → contract schema → table.submit (echo
 *       checks, signature verification, latest-replaces) → action ack, or the
 *       generic `reject` (bad_echo / stale_turn / schema_invalid / not_your_seat).
 *   Press refusals are NOT separate frames: they arrive in the next
 *   observation's `press_rejects` (asyncapi round-close contract, rule 4).
 *
 * Signing keys (signing.md §7.5): the seat's passport key is re-resolved for
 * every frame that carries a signed press move, never cached from the hello, so
 * a rotated or revoked key stops verifying on the next move without a
 * reconnect. Frames of one session are processed in arrival order (a per-session
 * queue), so latest-frame-wins is unaffected by the async key lookup.
 *
 * Tables are created server-side (`createTable`): seed, eval class, seats,
 * `episodeId` and `secret` are never taken from a client.
 *
 * Lifecycle (Phase 9 hardening, docs/phase-9/CHAOS-DIPLOMACY.md):
 *   - seat arrival: a table whose agent seats have not ALL connected within
 *     `seatTimeoutMs` (default 120 s) is aborted: every connected seat is closed
 *     4408 (`CLOSE.SEAT_TIMEOUT`), no observation was ever sent, and the table is
 *     released like any ended table (O-1).
 *   - end: whatever ends a table (terminal, seat timeout, shutdown), its summary goes
 *     to the `TableResultSink` and the table is deleted after `endGraceMs`
 *     (default 30 s; 0 when WOT_ENV=test). `getTable()` then answers from the sink
 *     (D-2: ended tables were retained forever).
 *   - a `diplomacy_action` that fails the schema reports to `conn.onSchemaInvalid`,
 *     so the arena counts it toward the same 4400 escalation as a duel frame (D-1).
 */

import { randomBytes, randomInt } from 'node:crypto';
import { hasScope, resolveDeployEnv, SIGNED_PRESS_MOVES, TokenExpired, verifyAccessToken, type AccessClaims, type Ed25519PublicJwk, type PassportKeyResolver } from 'wot-auth';
import { POWERS, type DipEvalClass, type Power } from 'wot-engine';
import type { Stores } from 'wot-store';
import { CLOSE } from '../config.ts';
import type { LogFields } from '../log.ts';
import { memoryResultSink, type TableResultSink, type TableResultSummary } from './results.ts';
import { signaturePolicy } from './signatures.ts';
import { DiplomacyTable, type DipSeatSide, type DipSeatSpec } from './table.ts';
import { dipFirstError, dipMaxBytes, dipValidators } from './validators.ts';
import { DIPLOMACY_SCENARIO_ID } from './wire.ts';

/** Ds / Dh per eval class; mirrors arena-scenarios/src/tiers.ts (Phase 7 A3). */
export const DIP_DEADLINES: Readonly<Record<DipEvalClass, { softMs: number; hardMs: number }>> = Object.freeze({
  edge: { softMs: 800, hardMs: 1600 },
  core: { softMs: 1500, hardMs: 3000 },
  frontier: { softMs: 3000, hardMs: 6000 },
});

/** Seat-arrival deadline: every agent seat must connect within this window (O-1). */
export const DEFAULT_SEAT_TIMEOUT_MS = 120_000;
/** How long an ended table stays readable in full before it is released (D-2). */
export const DEFAULT_END_GRACE_MS = 30_000;

/** The ended-table grace for an environment: 0 under WOT_ENV=test, else 30 s. */
export function defaultEndGraceMs(env: NodeJS.ProcessEnv): number {
  return resolveDeployEnv(env.WOT_ENV) === 'test' ? 0 : DEFAULT_END_GRACE_MS;
}

/** The scope a Diplomacy seat requires (the negotiation scope; a default passport scope). */
export const DIPLOMACY_SCOPE = 'negotiate:a2a';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** `<prefix>_` + 26 Crockford base32 characters (time-ordered like a ULID). */
function ulidLike(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i] % 32];
  return `${prefix}_${time}${r}`;
}
export const newEpisodeId = (): string => ulidLike('epi');
export const newTableId = (): string => ulidLike('dtb');
const newSessionId = (): string => ulidLike('ses');
const EPISODE_ID_RE = /^epi_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A connection as the arena hands it to the lobby. */
export interface DipConn {
  send(frame: unknown): void;
  close(code: number, reason: string): void;
  /** Called once the hello is accepted (the arena clears its hello timer and records identity). */
  onAuthed(info: { clientId: string; agentId: string; ownerId: string; sessionId: string }): void;
  /**
   * Called after a `diplomacy_action` is refused `schema_invalid` (the reject is already sent).
   * The arena counts it toward MAX_SCHEMA_INVALID and closes 4400, exactly like a duel `action`.
   */
  onSchemaInvalid?(): void;
  /** Bound seat (set by the lobby). */
  seat?: { table: DiplomacyTable; power: Power; side: DipSeatSide; clientId: string; agentId: string; sessionId: string };
}

export interface CreateTableInput {
  seats: Readonly<Record<Power, DipSeatSpec>>;
  cls?: DipEvalClass;
  seed?: number;
  horizonYear?: number;
  seatPowers?: readonly Power[];
  /** Allow `signature: "session"` (honoured only when WOT_ENV=development|test). Default true. */
  allowSessionSignatures?: boolean;
  /** Test/host hook: fix the run identity (default: fresh `epi_` id and 256-bit secret). */
  episode?: { episodeId: string; secret: string };
  /** Per-table seat-arrival deadline (ms); default the lobby's `seatTimeoutMs`. */
  seatTimeoutMs?: number;
}

export interface DiplomacyLobbyOptions {
  stores: Stores;
  /**
   * Passport → public Ed25519 signing key (G-11). Without a key a seat can only sign in `session` mode.
   * Called at hello (for the ack's `signature_modes`) and again for every frame with a JWS-signed move
   * (signing.md §7.5: a rotated or revoked key stops verifying at once).
   */
  keys: PassportKeyResolver;
  env: NodeJS.ProcessEnv;
  log: (f: LogFields) => void;
  /** Explicit Ds/Dh (tests); otherwise per eval class. */
  deadlines?: { softMs?: number; hardMs?: number };
  /** Seat-arrival deadline (ms). Default DEFAULT_SEAT_TIMEOUT_MS (120 s). */
  seatTimeoutMs?: number;
  /** How long an ended table stays in the lobby before release (ms). Default `defaultEndGraceMs(env)`. */
  endGraceMs?: number;
  /** Where ended tables' results go. Default: an in-memory ring (`memoryResultSink()`). */
  results?: TableResultSink;
}

/** A live (or ended, within its grace) table, or the result summary of a released one. */
export type TableLookup = DiplomacyTable | TableResultSummary;

export interface DiplomacyLobby {
  createTable(input: CreateTableInput): DiplomacyTable;
  /**
   * The table while it is live or inside its end grace; after release, the sink's
   * `TableResultSummary` (hashes, terminal, cause) if the sink still holds it; else undefined.
   */
  getTable(tableId: string): TableLookup | undefined;
  /** The result summary of an ended table (from the sink), whether or not it is released yet. */
  getResult(tableId: string): TableResultSummary | undefined;
  /** Tables currently held (live or in their end grace). */
  readonly liveTables: number;
  isDiplomacyHello(obj: unknown): boolean;
  handleHello(conn: DipConn, obj: Record<string, unknown>, bytes: number): Promise<void>;
  /** Frames of one connection are handled in arrival order; the promise settles when this one is done. */
  handleAction(conn: DipConn, obj: unknown, bytes: number): Promise<void>;
  onClose(conn: DipConn): void;
  /** Re-check every bound seat's passport (rolling revocation); returns the closed count. */
  revalidate(): Promise<number>;
  close(): void;
}

export function createDiplomacyLobby(opts: DiplomacyLobbyOptions): DiplomacyLobby {
  const tables = new Map<string, DiplomacyTable>();
  const bound = new Map<string, DipConn>(); // `${tableId}:${power}` → live conn
  const { log } = opts;
  const results = opts.results ?? memoryResultSink();
  const seatTimeoutDefault = opts.seatTimeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  const endGraceMs = opts.endGraceMs ?? defaultEndGraceMs(opts.env);
  /** Per table: the seat-arrival timer (until start) or the release timer (after the end). */
  const timers = new Map<string, NodeJS.Timeout>();
  let closing = false;

  const clearTimer = (tableId: string): void => {
    const t = timers.get(tableId);
    if (t) clearTimeout(t);
    timers.delete(tableId);
  };
  const unrefd = (t: NodeJS.Timeout): NodeJS.Timeout => {
    if (typeof t.unref === 'function') t.unref();
    return t;
  };

  const startIfReady = (table: DiplomacyTable): void => {
    if (!table.allConnected() || table.isStarted || table.isEnded) return;
    clearTimer(table.tableId); // the seat-arrival deadline is met
    table.start();
  };

  /** Whatever ended the table: summary → sink, seat bindings dropped, table released after the grace. */
  const onTableEnd = (t: DiplomacyTable): void => {
    for (const p of POWERS) bound.delete(`${t.tableId}:${p}`);
    clearTimer(t.tableId);
    const r = t.result();
    const why = t.endCause ?? { cause: 'shutdown' as const, closeCode: 1012 };
    const summary: TableResultSummary = Object.freeze({
      kind: 'diplomacy_table_result',
      tableId: t.tableId,
      episodeId: t.episodeId,
      cls: r.cls,
      cause: why.cause,
      closeCode: why.closeCode,
      terminal: why.cause === 'terminal' ? r.terminal : null,
      ticks: r.ticks,
      phases: r.phases,
      replayHash: r.replayHash,
      transcriptHash: r.transcriptHash,
      forfeited: Object.freeze(t.episode.forfeited.map((f) => f.power)),
      endedAt: new Date().toISOString(),
    });
    const sinkError = (err: unknown): void =>
      log({ event: 'diplomacy_result_sink_error', match_id: t.tableId, reason: err instanceof Error ? err.message.slice(0, 200) : 'error' });
    try {
      const p = results.put(summary, { result: r, recording: t.recording() });
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(sinkError);
    } catch (err) {
      sinkError(err); // a broken consumer never breaks the table's end
    }
    if (closing) return; // close() clears the Map itself
    if (endGraceMs <= 0) {
      tables.delete(t.tableId);
      return;
    }
    timers.set(
      t.tableId,
      unrefd(
        setTimeout(() => {
          timers.delete(t.tableId);
          tables.delete(t.tableId);
        }, endGraceMs),
      ),
    );
  };

  const createTable = (input: CreateTableInput): DiplomacyTable => {
    for (const p of POWERS) if (!input.seats[p]) throw new Error(`createTable: no seat for ${p}`);
    if (input.horizonYear !== undefined && (!Number.isInteger(input.horizonYear) || input.horizonYear < 1901 || input.horizonYear > 1908)) {
      throw new Error('createTable: horizonYear must be 1901..1908 (contracts 2.1.0)');
    }
    const cls = input.cls ?? 'core';
    const d = DIP_DEADLINES[cls];
    const tableId = newTableId();
    const episode = input.episode ?? { episodeId: newEpisodeId(), secret: randomBytes(32).toString('hex') };
    if (!EPISODE_ID_RE.test(episode.episodeId)) throw new Error('createTable: episodeId must be a contract epi_ id');
    const table = new DiplomacyTable({
      tableId,
      seed: input.seed ?? randomInt(1, 2 ** 31 - 1),
      cls,
      episodeId: episode.episodeId,
      secret: episode.secret,
      ...(input.horizonYear !== undefined ? { horizonYear: input.horizonYear } : {}),
      ...(input.seatPowers ? { seatPowers: input.seatPowers } : {}),
      seats: input.seats,
      softMs: opts.deadlines?.softMs ?? d.softMs,
      hardMs: opts.deadlines?.hardMs ?? d.hardMs,
      policy: signaturePolicy(opts.env, input.allowSessionSignatures ?? true),
      log,
      onEnd: onTableEnd,
    });
    tables.set(tableId, table);
    const seatTimeoutMs = input.seatTimeoutMs ?? seatTimeoutDefault;
    log({ event: 'diplomacy_table_created', match_id: tableId, detail: { cls, agents: table.agentSeats().length, seat_timeout_ms: seatTimeoutMs } });
    // A table with no agent seat plays out immediately (house-only).
    if (table.allConnected()) {
      table.start();
      return table;
    }
    // Seat-arrival deadline (O-1): not every agent seat connected in time → close the ones that did (4408), release.
    timers.set(
      tableId,
      unrefd(
        setTimeout(() => {
          timers.delete(tableId);
          if (table.isStarted || table.isEnded) return;
          const missing = table.agentSeats().filter((p) => !bound.has(`${tableId}:${p}`));
          log({ event: 'diplomacy_seat_timeout', match_id: tableId, code: CLOSE.SEAT_TIMEOUT, detail: { missing, seat_timeout_ms: seatTimeoutMs } });
          table.abort(CLOSE.SEAT_TIMEOUT, 'seat_timeout', 'seat_timeout');
        }, seatTimeoutMs),
      ),
    );
    return table;
  };

  const handleHello = async (conn: DipConn, obj: Record<string, unknown>, bytes: number): Promise<void> => {
    if (conn.seat) {
      conn.send({ t: 'reject', turn_id: null, reason: 'unknown_frame', hint: 'already authenticated', retryable: false });
      return;
    }
    // wot:hello:diplomacy:1 — x-max-frame-bytes 2048, then the contract schema (no `dpop`, no power).
    if (bytes > dipMaxBytes('diplomacy_hello')) {
      conn.send({ t: 'reject', turn_id: null, reason: 'too_large', hint: `diplomacy hello exceeds ${dipMaxBytes('diplomacy_hello')} bytes`, retryable: false });
      return;
    }
    if (!dipValidators.diplomacy_hello(obj)) {
      conn.send({ t: 'reject', turn_id: null, reason: 'schema_invalid', hint: dipFirstError('diplomacy_hello'), retryable: false });
      return;
    }
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(obj.token as string);
    } catch (err) {
      log({ event: 'auth_failed', code: CLOSE.UNAUTHENTICATED, reason: err instanceof TokenExpired ? 'token_expired' : 'token_invalid' });
      conn.close(CLOSE.UNAUTHENTICATED, 'unauthenticated');
      return;
    }
    if (!hasScope(claims, DIPLOMACY_SCOPE)) {
      log({ event: 'forbidden', client_id: claims.client_id, code: CLOSE.FORBIDDEN, reason: 'missing_scope' });
      conn.close(CLOSE.FORBIDDEN, `missing ${DIPLOMACY_SCOPE} scope`);
      return;
    }
    const passport = await opts.stores.passports.getByClientId(claims.client_id);
    if (!passport || passport.status !== 'active') {
      log({ event: 'forbidden', client_id: claims.client_id, code: CLOSE.FORBIDDEN, reason: 'passport_or_owner_revoked' });
      conn.close(CLOSE.FORBIDDEN, 'passport revoked or not active');
      return;
    }
    // An unknown table and a table without this agent are refused identically (no enumeration oracle).
    const table = tables.get(obj.table_id as string);
    const power = table && !table.isEnded ? table.powerOf(claims.agent_id) : null;
    if (!table || !power) {
      log({ event: 'forbidden', client_id: claims.client_id, code: CLOSE.FORBIDDEN, reason: 'not_seated' });
      conn.close(CLOSE.FORBIDDEN, 'no seat for this passport at that table');
      return;
    }
    const publicJwk = await opts.keys(claims.agent_id);
    const sessionId = newSessionId();
    const key = `${table.tableId}:${power}`;
    const prior = bound.get(key);
    const side: DipSeatSide = { send: (f) => conn.send(f), close: (c, r) => conn.close(c, r ?? '') };
    conn.seat = { table, power, side, clientId: claims.client_id, agentId: claims.agent_id, sessionId };
    bound.set(key, conn);
    if (prior && prior !== conn) {
      prior.send({ t: 'session_superseded', session_id: prior.seat?.sessionId ?? sessionId, superseded_by: sessionId, reason: 'another connection authenticated for this seat', ts: new Date().toISOString() });
      if (prior.seat) table.detach(prior.seat.power, prior.seat.side);
      prior.seat = undefined;
      prior.close(CLOSE.SUPERSEDED, 'session superseded');
    }
    conn.onAuthed({ clientId: claims.client_id, agentId: claims.agent_id, ownerId: claims.owner_id, sessionId });
    const cfg = table.config;
    // Session ack: wot:ack:diplomacy:1 (contracts 2.4.0). `key` reflects the key resolved now; every
    // signed move re-resolves it (signing.md §7.5).
    conn.send({
      t: 'ack',
      ack_type: 'session',
      session_id: sessionId,
      mode: 'diplomacy',
      scenario_id: DIPLOMACY_SCENARIO_ID,
      table_id: table.tableId,
      episode_id: table.episodeId,
      power,
      signature_modes: [...(publicJwk ? ['key'] : []), ...(cfg.sessionSignatures ? ['session'] : [])],
      config: { soft_deadline_ms: cfg.softMs, hard_deadline_ms: cfg.hardMs, press_rounds: cfg.pressRounds, eval_class: cfg.cls },
    });
    table.attach(power, side);
    log({ event: 'diplomacy_seat_bound', match_id: table.tableId, client_id: claims.client_id, session_id: sessionId, player: power, detail: { signing_key: publicJwk ? 'passport' : 'none' } });
    startIfReady(table);
  };

  /** True when a schema-valid batch carries a JWS (not `session`) on a signed move: only then is a key needed. */
  const needsKey = (obj: Record<string, unknown>): boolean =>
    Array.isArray(obj.press) &&
    obj.press.some((m: unknown) => {
      const x = (typeof m === 'object' && m !== null ? m : {}) as { move?: unknown; signature?: unknown };
      return (SIGNED_PRESS_MOVES as readonly unknown[]).includes(x.move) && typeof x.signature === 'string' && x.signature !== 'session';
    });

  const processAction = async (conn: DipConn, obj: unknown, bytes: number): Promise<void> => {
    const seat = conn.seat;
    const turnId = typeof (obj as { turn_id?: unknown })?.turn_id === 'number' ? (obj as { turn_id: number }).turn_id : null;
    if (!seat) {
      conn.send({ t: 'reject', turn_id: turnId, reason: 'no_active_match', hint: 'no Diplomacy seat on this session', retryable: false });
      return;
    }
    if (bytes > dipMaxBytes('diplomacy_action')) {
      conn.send({ t: 'reject', turn_id: turnId, reason: 'too_large', hint: 'diplomacy_action exceeds 16384 bytes', retryable: true });
      return;
    }
    if (!dipValidators.diplomacy_action(obj)) {
      conn.send({ t: 'reject', turn_id: turnId, reason: 'schema_invalid', hint: dipFirstError('diplomacy_action'), retryable: true });
      conn.onSchemaInvalid?.(); // D-1: same MAX_SCHEMA_INVALID → 4400 escalation as a duel action
      return;
    }
    const frame = obj as Record<string, unknown>;
    // signing.md §7.5: resolve the seat's CURRENT passport key for this move (never the hello-time key).
    let publicJwk: Ed25519PublicJwk | null = null;
    if (needsKey(frame)) {
      try {
        publicJwk = (await opts.keys(seat.agentId)) ?? null;
      } catch {
        publicJwk = null; // fail closed: the signed moves are refused signature_invalid
      }
      // The session may have been superseded or closed while the key was resolved: drop the frame.
      if (conn.seat !== seat) return;
    }
    const r = seat.table.submit(seat.power, frame, publicJwk);
    if (!r.ok) {
      conn.send({ t: 'reject', turn_id: turnId, reason: r.reason, hint: r.hint, retryable: r.reason === 'bad_echo' });
      return;
    }
    // Diplomacy has no token cost: the action ack reports zero spend (contract `ack` action form).
    conn.send({ t: 'ack', ack_type: 'action', turn_id: turnId ?? 0, tokens_spent: 0, tokens_remaining: 0 });
  };

  // One FIFO per connection: the key lookup is async, and latest-frame-wins needs arrival order.
  const queues = new WeakMap<DipConn, Promise<void>>();
  const handleAction = (conn: DipConn, obj: unknown, bytes: number): Promise<void> => {
    const next = (queues.get(conn) ?? Promise.resolve()).then(() => processAction(conn, obj, bytes)).catch((err: unknown) => {
      log({ event: 'diplomacy_action_error', reason: err instanceof Error ? err.message.slice(0, 200) : 'error' });
    });
    queues.set(conn, next);
    return next;
  };

  const onClose = (conn: DipConn): void => {
    const seat = conn.seat;
    if (!seat) return;
    seat.table.detach(seat.power, seat.side);
    const key = `${seat.table.tableId}:${seat.power}`;
    if (bound.get(key) === conn) bound.delete(key);
    conn.seat = undefined;
  };

  const revalidate = async (): Promise<number> => {
    let closed = 0;
    for (const conn of [...bound.values()]) {
      const seat = conn.seat;
      if (!seat) continue;
      try {
        const passport = await opts.stores.passports.getByClientId(seat.clientId);
        if (!passport || passport.status !== 'active') {
          conn.send({ t: 'session_revoked', session_id: seat.sessionId, reason: 'passport_or_owner_revoked', ts: new Date().toISOString() });
          conn.close(CLOSE.REVOKED, 'session revoked');
          closed++;
        }
      } catch {
        /* transient store error — re-checked next interval */
      }
    }
    return closed;
  };

  return {
    createTable,
    getTable: (id) => tables.get(id) ?? results.get(id),
    getResult: (id) => results.get(id),
    get liveTables() {
      return tables.size;
    },
    isDiplomacyHello: (obj) => typeof obj === 'object' && obj !== null && (obj as { scenario_id?: unknown }).scenario_id !== undefined,
    handleHello,
    handleAction,
    onClose,
    revalidate,
    close: () => {
      closing = true;
      for (const t of [...tables.values()]) t.forceClose(CLOSE.SERVICE_RESTART);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      tables.clear();
      bound.clear();
    },
  };
}
