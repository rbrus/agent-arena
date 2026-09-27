/**
 * Chaos harness for the Diplomacy table session (Phase 9 hosted-beta hardening;
 * docs/phase-9/CHAOS-DIPLOMACY.md). Not a *.test.ts.
 *
 *  - `chaosSetup`: the diplomacy-helpers harness (real passports routes + arena on one
 *    in-process http.Server) with raised connect caps (70 sockets from one loopback
 *    address) and a `restart()` that closes the arena and attaches a fresh one to the
 *    SAME server and stores (the in-process restart the Phase 5 chaos test uses).
 *  - `ChaosSeat`: one seat played by an engine reference agent over the wire, across
 *    any number of successive connections (supersession, reconnect after a close). The
 *    client keeps ONE wire view and ONE per-turn action cache across connections, so a
 *    re-sent observation (same turn, same nonce) is answered with the identical frame
 *    and the agent is never called twice for a turn. A per-observation `policy` lets a
 *    scenario hold, delay, disconnect, supersede or inject frames.
 *  - `engineMirror`: the engine-only run of the same table (no transport) with the
 *    table's resolve order (`table.ts` resolve: act, then soft miss; no action from a
 *    prompted seat = hard miss), an explicit miss schedule and per-tick action overrides.
 *  - `MemSampler`: process RSS / heap high-water while a scenario runs.
 */

import http from 'node:http';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { signPressMove, SIGNED_PRESS_MOVES, type PassportSigningKey } from 'wot-auth';
import { createStores, passportKeyResolver } from 'wot-store';
import {
  dipAct,
  dipAgentAlive,
  dipInit,
  dipMiss,
  dipObserve,
  dipTick,
  POWERS,
  type DipAction,
  type DipConfig,
  type DipEpisode,
  type DipObservation,
  type Power,
} from 'wot-engine';
import { attachPassportsRoutes } from '../../passports/src/index.ts';
import { testArchitectVerifier } from './diplomacy-helpers.ts';
import { attachArena, type ArenaHandle, type TableResultSink } from '../src/index.ts';
import { dipFirstError, dipValidators } from '../src/diplomacy/validators.ts';
import { DipWireView, toWireAction, wireMsgId } from '../src/diplomacy/wire.ts';
import type { DipHarness } from './diplomacy-helpers.ts';

export type Frame = Record<string, unknown> & { t: string };

// ------------------------------------------------------------------ harness

export interface ChaosHarness extends DipHarness {
  /** Close the arena (every seat 1012) and attach a fresh arena to the same server and stores. */
  restart(opts?: { recover?: boolean }): Promise<ArenaHandle>;
}

export interface ChaosSetupOptions {
  softMs?: number;
  hardMs?: number;
  quietLog?: boolean;
  /** Diplomacy table lifecycle (seat-arrival deadline, end grace, result sink); arena defaults otherwise. */
  tables?: { seatTimeoutMs?: number; endGraceMs?: number; results?: TableResultSink };
}

export async function chaosSetup(opts: ChaosSetupOptions = {}): Promise<ChaosHarness> {
  const stores = createStores();
  const app = express();
  app.disable('x-powered-by');
  attachPassportsRoutes(app, { stores, architectVerifier: testArchitectVerifier });
  const server = http.createServer(app);
  const events: DipHarness['events'] = [];
  const keys = passportKeyResolver(stores.passports);
  const attach = (recover = false): ArenaHandle =>
    attachArena({
      server,
      stores,
      deadlines: { softMs: 60, hardMs: 250, backfillMs: 60_000, helloTimeoutMs: 10_000, revocationIntervalMs: 100_000 },
      diplomacyDeadlines: { softMs: opts.softMs ?? 20_000, hardMs: opts.hardMs ?? 30_000 },
      ...(opts.tables ? { diplomacyTables: opts.tables } : {}),
      signingKeys: keys,
      env: { WOT_ENV: 'test' },
      // 10 tables x 7 seats from one loopback address (the sandbox dial-in keys its caps by peer IP).
      limits: { maxSocketsGlobal: 2048, maxSocketsPerIp: 1024, connectRatePerSec: 10_000, connectBurst: 10_000 },
      recover,
      logger: (e) => {
        if (!opts.quietLog) events.push(e as unknown as DipHarness['events'][number]);
      },
    });
  let arena = attach();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const h: ChaosHarness = {
    stores,
    server,
    get arena() {
      return arena;
    },
    keys,
    httpUrl: `http://127.0.0.1:${port}`,
    url: `ws://127.0.0.1:${port}/v1/arena`,
    events,
    restart: async (o = {}) => {
      await arena.close();
      arena = attach(o.recover ?? false);
      await arena.ready;
      return arena;
    },
    close: async () => {
      await arena.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return h;
}

// ------------------------------------------------------------------ seat

export interface SeatConn {
  index: number;
  ws: WebSocket;
  frames: Frame[];
  closeInfo: { code: number; reason: string } | null;
  closed: Promise<{ code: number; reason: string }>;
}

/** Called for every observation (on whichever connection delivered it). Default: `seat.answer(f, conn)`. */
export type ObsPolicy = (f: Frame, conn: SeatConn, seat: ChaosSeat) => void | Promise<void>;

/** A per-tick replacement of the agent's action: the wire press batch and how each message is signed. */
export interface WireOverride {
  press: Record<string, unknown>[];
  /** Per message: `session`, a key to sign with (forged when it is not the seat's key), or none. */
  sign: Array<'session' | PassportSigningKey | undefined>;
}

export class ChaosSeat {
  readonly conns: SeatConn[] = [];
  /** Every frame from every connection, in arrival order, tagged with the connection index. */
  readonly all: Array<Frame & { _conn: number }> = [];
  readonly schemaErrors: string[] = [];
  readonly actionSchemaErrors: string[] = [];
  /** Turns observed (first delivery), and how many observation frames arrived in total. */
  readonly observedTurns: number[] = [];
  observationFrames = 0;
  /** The action frame last sent per turn (the client's cache: a re-sent prompt gets the identical answer). */
  readonly sentByTurn = new Map<number, Record<string, unknown>>();
  policy: ObsPolicy | null = null;
  key: PassportSigningKey | null;
  private readonly view = new DipWireView();
  /** The engine-shaped observation the view produced at a turn's FIRST delivery. */
  private readonly obsByTurn = new Map<number, DipObservation>();
  private readonly waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  constructor(
    readonly url: string,
    readonly power: Power,
    private readonly agent: ((o: DipObservation) => DipAction) | null,
    readonly opts: { token: string; tableId: string; sign?: 'session' | 'passport'; key?: PassportSigningKey | null; overrides?: Map<number, WireOverride> },
  ) {
    this.key = opts.key ?? null;
  }

  get current(): SeatConn | null {
    return this.conns.length ? this.conns[this.conns.length - 1] : null;
  }

  /** Open a new connection and send the hello; resolves once the socket is open (not the ack). */
  async connect(token = this.opts.token, tableId = this.opts.tableId): Promise<SeatConn> {
    const ws = new WebSocket(this.url);
    let onClose!: (c: { code: number; reason: string }) => void;
    const conn: SeatConn = { index: this.conns.length, ws, frames: [], closeInfo: null, closed: new Promise((r) => (onClose = r)) };
    this.conns.push(conn);
    ws.on('message', (d) => this.onMessage(conn, d.toString('utf8')));
    ws.on('close', (code, reason) => {
      conn.closeInfo = { code, reason: reason.toString('utf8') };
      onClose(conn.closeInfo);
    });
    ws.on('error', () => {
      /* surfaced as close */
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ t: 'hello', protocol_version: '1.0', token, scenario_id: 'diplomacy_standard', table_id: tableId }));
    return conn;
  }

  sendRaw(conn: SeatConn, raw: string): void {
    try {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(raw);
    } catch {
      /* socket closing */
    }
  }

  send(conn: SeatConn, obj: unknown): void {
    this.sendRaw(conn, JSON.stringify(obj));
  }

  private onMessage(conn: SeatConn, raw: string): void {
    let f: Frame;
    try {
      f = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    conn.frames.push(f);
    this.all.push({ ...f, _conn: conn.index });
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].pred(f)) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(f);
      }
    }
    if (f.t === 'diplomacy_observation') {
      this.observationFrames++;
      const turn = f.turn_id as number;
      if (!this.observedTurns.includes(turn)) this.observedTurns.push(turn);
      if (!dipValidators.diplomacy_observation(f)) this.schemaErrors.push(`t${turn} ${dipFirstError('diplomacy_observation')}`);
      // Idempotent for a re-sent prompt (same turn and nonce): ids dedupe, commitments are latest-wins.
      const o = this.view.observe(f);
      if (!this.obsByTurn.has(turn)) this.obsByTurn.set(turn, o);
      if (this.policy) void this.policy(f, conn, this);
      else this.answer(f, conn);
    } else if (f.t === 'diplomacy_episode_end') {
      if (!dipValidators.diplomacy_episode_end(f)) this.schemaErrors.push(`end ${dipFirstError('diplomacy_episode_end')}`);
    } else if (f.t === 'ack' && f.ack_type === 'session') {
      if (!dipValidators.diplomacy_session_ack(f)) this.schemaErrors.push(`session ack ${dipFirstError('diplomacy_session_ack')}`);
    }
  }

  /** The seat's answer to observation `f` (computed once per turn; the agent is called at most once per turn). */
  actionFrame(f: Frame): Record<string, unknown> {
    const turn = f.turn_id as number;
    const cached = this.sentByTurn.get(turn);
    const echo = { episode_id: f.episode_id as string, turn_id: turn, nonce: f.nonce as string, power: this.power, phase: f.phase as string };
    if (cached) return { ...cached, nonce: echo.nonce };
    const step = f.step as { kind: string; round?: number };
    const ov = this.opts.overrides?.get(turn);
    let frame: Record<string, unknown>;
    if (ov) {
      frame = { t: 'diplomacy_action', protocol_version: '1.0', episode_id: echo.episode_id, turn_id: turn, nonce: echo.nonce, power: this.power };
      frame.press = ov.press.map((m, i) => {
        const s = ov.sign[i];
        if (s === undefined) return m;
        if (s === 'session') return { ...m, signature: 'session' };
        return {
          ...m,
          signature: signPressMove(s, {
            episodeId: echo.episode_id,
            msgIdExpected: wireMsgId(echo.phase, step.round ?? 0, this.power, i + 1),
            from: this.power,
            to: m.to,
            move: m.move as string,
            respondTo: (m.respond_to as string | undefined) ?? null,
            terms: m.move === 'offer' || m.move === 'counter' ? m.terms : null,
          }),
        };
      });
    } else {
      const o = this.obsByTurn.get(turn)!;
      const action = this.agent && dipAgentAlive(o, this.power) ? this.agent(o) : {};
      const key = this.key;
      frame = toWireAction(action, echo, (i, w) => {
        if (this.opts.sign !== 'passport' || !key || !(SIGNED_PRESS_MOVES as readonly string[]).includes(w.move as string)) return undefined;
        return signPressMove(key, {
          episodeId: echo.episode_id,
          msgIdExpected: wireMsgId(echo.phase, step.round ?? 0, this.power, i + 1),
          from: this.power,
          to: w.to,
          move: w.move as string,
          respondTo: (w.respond_to as string | undefined) ?? null,
          terms: w.move === 'offer' || w.move === 'counter' ? w.terms : null,
        });
      });
    }
    if (!dipValidators.diplomacy_action(frame)) this.actionSchemaErrors.push(`t${turn} ${dipFirstError('diplomacy_action')}`);
    this.sentByTurn.set(turn, frame);
    return frame;
  }

  /** Answer `f` on `conn` (default: the connection that delivered it). */
  answer(f: Frame, conn: SeatConn = this.current!, pad = 0): void {
    if (!this.agent && !this.opts.overrides?.has(f.turn_id as number)) return;
    const body = JSON.stringify(this.actionFrame(f));
    this.sendRaw(conn, pad > 0 ? body.slice(0, -1) + ' '.repeat(Math.max(0, pad - Buffer.byteLength(body))) + '}' : body);
  }

  waitFor(pred: (f: Frame) => boolean, ms = 60_000): Promise<Frame> {
    const existing = this.all.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waitFor timed out (${this.power})`)), ms);
      this.waiters.push({
        pred,
        resolve: (x) => {
          clearTimeout(timer);
          resolve(x);
        },
      });
    });
  }

  /** Frames of type `t` from every connection. */
  of(t: string): Array<Frame & { _conn: number }> {
    return this.all.filter((f) => f.t === t);
  }

  closeAll(): void {
    for (const c of this.conns) {
      try {
        c.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ------------------------------------------------------------------ engine-only mirror

export interface MirrorSpec {
  seed: number;
  cls?: 'edge' | 'core' | 'frontier';
  overrides: Partial<DipConfig>;
  agents: Record<Power, (o: DipObservation) => DipAction>;
  /** `${tick}:${power}` → the table's miss for that seat at that tick. */
  misses?: ReadonlyMap<string, 'soft' | 'hard'>;
  /** Replace a seat's action at a tick (called instead of the agent). */
  override?: (ep: DipEpisode, p: Power) => DipAction | undefined;
  /** Stop before this tick (a prefix run); default: to the terminal. */
  untilTick?: number;
}

/** The table's resolve order without the transport: act (+ soft miss) or hard miss, then tick. */
export function engineMirror(spec: MirrorSpec): DipEpisode {
  let ep = dipInit(spec.seed, spec.cls ?? 'core', spec.overrides);
  while (!ep.terminal && (spec.untilTick === undefined || ep.tick < spec.untilTick)) {
    for (const p of POWERS) {
      if (ep.forfeited.some((f) => f.power === p)) continue;
      const o = dipObserve(ep, p);
      if (!dipAgentAlive(o, p)) continue;
      const miss = spec.misses?.get(`${ep.tick}:${p}`);
      if (miss === 'hard') {
        ep = dipMiss(ep, p, 'hard');
        continue;
      }
      const a = spec.override?.(ep, p) ?? spec.agents[p](o);
      ep = dipAct(ep, p, a);
      if (miss === 'soft') ep = dipMiss(ep, p, 'soft');
    }
    ep = dipTick(ep).ep;
  }
  return ep;
}

export const missMap = (misses: readonly { tick: number; power: Power; severity: 'soft' | 'hard' }[]): Map<string, 'soft' | 'hard'> =>
  new Map(misses.map((m) => [`${m.tick}:${m.power}`, m.severity]));

// ------------------------------------------------------------------ memory

export class MemSampler {
  rssMax = 0;
  heapMax = 0;
  readonly rss0: number;
  readonly heap0: number;
  private readonly timer: NodeJS.Timeout;
  constructor(everyMs = 25) {
    const m = process.memoryUsage();
    this.rss0 = m.rss;
    this.heap0 = m.heapUsed;
    this.sample();
    this.timer = setInterval(() => this.sample(), everyMs);
  }
  private sample(): void {
    const m = process.memoryUsage();
    if (m.rss > this.rssMax) this.rssMax = m.rss;
    if (m.heapUsed > this.heapMax) this.heapMax = m.heapUsed;
  }
  stop(): { rss0MiB: number; rssMaxMiB: number; heap0MiB: number; heapMaxMiB: number } {
    this.sample();
    clearInterval(this.timer);
    const mib = (n: number) => Math.round((n / 2 ** 20) * 10) / 10;
    return { rss0MiB: mib(this.rss0), rssMaxMiB: mib(this.rssMax), heap0MiB: mib(this.heap0), heapMaxMiB: mib(this.heapMax) };
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let gcFn: (() => void) | null = null;
/**
 * heapUsed after a forced full GC (twice, with a turn in between so finalizers and timers settle).
 * Uses `--expose-gc` when the runner passed it, else enables it at runtime for this measurement.
 */
export async function settledHeap(): Promise<number> {
  if (!gcFn) {
    const g = (globalThis as { gc?: () => void }).gc;
    if (g) gcFn = g;
    else {
      v8.setFlagsFromString('--expose-gc');
      gcFn = runInNewContext('gc') as () => void;
    }
  }
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r));
    gcFn();
  }
  return process.memoryUsage().heapUsed;
}

/** One-line result record for the evidence doc (printed as `CHAOS {...}`). */
export function record(scenario: string, data: Record<string, unknown>): void {
  process.stdout.write(`CHAOS ${JSON.stringify({ scenario, ...data })}\n`);
}
