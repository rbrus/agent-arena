/**
 * The guarded WebSocket client (threat model §2.4 `adapters/ws.ts` row): the
 * same URL pre-check and per-socket `lookup` guard as HTTP, no redirects on the
 * upgrade, no per-message deflate (no decompression of target output),
 * `maxPayload` = the byte cap, credentials only on the user's origin.
 *
 * Inbound buffering is bounded (G-20): per frame by `maxPayload`; per
 * connection by the number and bytes of UNREAD messages (the queue) and by
 * the total messages and bytes the connection may deliver over its life (one
 * episode). A target that exceeds any bound is disconnected with close code
 * 1008 and a reason naming the bound; the transport records a `too_large`
 * submission, and later decisions on that socket are hard misses.
 *
 * Outbound writes are time-capped (G-29): a target that completes the
 * handshake and then stops reading (zero TCP window) would otherwise hold a
 * `send()` forever, past every per-decision Dh. Every frame handed to `send()`
 * has a due time: the explicit `deadline` if the caller passes one, else the
 * deadline of the next `next(deadline)` call (the decision's remaining budget),
 * and never later than WS_SEND_TIME_CAP_MS after the send. A frame still not
 * accepted by the socket at its due time terminates the connection
 * (`send_timeout`): a pending `next()` resolves `timeout` (a hard miss for that
 * decision), an explicit-deadline `send()` rejects with WsSendTimeoutError, and
 * later sends on that socket fail like any closed socket (hard misses).
 */

import WebSocket from 'ws';
import { checkUrl } from './guard.ts';
import { originLabel, type NetContext } from './context.ts';
import { NetTimeoutError } from './client.ts';
import { targetExcerpt } from '../redact.ts';

/** Unread inbound messages a connection may hold (a well-behaved target has at most one). */
export const WS_MAX_QUEUED_MESSAGES = 16;
/** Unread inbound bytes a connection may hold, in multiples of `maxPayload`. */
export const WS_MAX_QUEUED_PAYLOADS = 4;
/** Total inbound bytes over one connection (one episode: ≤ 120 ticks × a few frames of ≤ 8 KiB). */
export const WS_MAX_CONNECTION_BYTES = 16 * 1024 * 1024;
/** Total inbound messages over one connection. */
export const WS_MAX_CONNECTION_MESSAGES = 4096;
/**
 * The longest a frame may wait to be accepted by the socket when no decision
 * deadline applies (e.g. the terminal `eval_episode_end` notice): the longest
 * tier hard deadline (Frontier Dh).
 */
export const WS_SEND_TIME_CAP_MS = 6000;

/** A frame was not accepted by the socket before its deadline: the target stopped reading (G-29). */
export class WsSendTimeoutError extends Error {
  readonly code = 'EARENA_WS_SEND_TIMEOUT';
  readonly reason = 'send_timeout' as const;
  constructor(
    readonly origin: string,
    readonly budgetMs: number,
    readonly overshootMs: number,
  ) {
    super(
      `ws: a frame to ${origin} was not accepted within ${budgetMs} ms (+${overshootMs} ms over; the decision's remaining budget, capped at ${WS_SEND_TIME_CAP_MS} ms): the target stopped reading, so the arena closed the connection (send_timeout)`,
    );
    this.name = 'WsSendTimeoutError';
  }
}

export interface WsLimits {
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxConnectionBytes: number;
  maxConnectionMessages: number;
}

export interface WsStats {
  queuedMessages: number;
  queuedBytes: number;
  totalMessages: number;
  totalBytes: number;
  /** Set when the connection was closed for exceeding a bound. */
  overflow?: string;
  /** Frames handed to `send()` and not yet accepted by the socket. */
  pendingSends: number;
  /** Set when the connection was closed because a frame was not accepted in time (G-29). */
  sendTimeout?: boolean;
}

export type WsEvent =
  | { kind: 'message'; data: Buffer; bytes: number }
  | { kind: 'closed'; code: number; reason: string; overflow?: boolean }
  /** `reason: 'send_timeout'`: the deadline passed with our frame still unread by the target (G-29). */
  | { kind: 'timeout'; reason?: 'send_timeout' };

export interface GuardedSocket {
  /**
   * Hand one text frame to the socket. With `deadline` (`performance.now()` clock):
   * resolves once the socket accepted it, or rejects with WsSendTimeoutError at the
   * deadline (capped at WS_SEND_TIME_CAP_MS) after terminating the connection. Without
   * it: resolves once queued; the frame is then due by the next `next(deadline)`.
   */
  send(text: string, deadline?: number): Promise<void>;
  /** The next inbound message, or `timeout` at `deadline` (`performance.now()` clock). */
  next(deadline: number): Promise<WsEvent>;
  /** Drop anything already queued (late answers to an earlier decision). */
  drain(): number;
  /** Buffering counters (tests, diagnostics). */
  stats(): WsStats;
  close(): void;
}

export async function openWebSocket(ctx: NetContext, url: URL, o: { deadline: number; maxPayload: number; limits?: Partial<WsLimits> }): Promise<GuardedSocket> {
  const lim: WsLimits = {
    maxQueuedMessages: o.limits?.maxQueuedMessages ?? WS_MAX_QUEUED_MESSAGES,
    maxQueuedBytes: o.limits?.maxQueuedBytes ?? WS_MAX_QUEUED_PAYLOADS * o.maxPayload,
    maxConnectionBytes: o.limits?.maxConnectionBytes ?? WS_MAX_CONNECTION_BYTES,
    maxConnectionMessages: o.limits?.maxConnectionMessages ?? WS_MAX_CONNECTION_MESSAGES,
  };
  checkUrl(url, ctx.policy);
  await ctx.limiter.take();
  const handshakeTimeout = Math.max(1, Math.floor(o.deadline - performance.now()));
  const ws = new WebSocket(url, {
    headers: { ...ctx.baseHeaders(), ...ctx.credentialFor(url) },
    lookup: ctx.lookup as never,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: o.maxPayload,
    handshakeTimeout,
  });
  // The TLS peer of the upgrade (hosted `observed_connections`); ignored for plain ws.
  ws.once('upgrade', (res) => ctx.observe(url, res.socket));
  const queue: WsEvent[] = [];
  const st: WsStats = { queuedMessages: 0, queuedBytes: 0, totalMessages: 0, totalBytes: 0, pendingSends: 0 };
  let waiter: ((e: WsEvent) => void) | null = null;
  const push = (e: WsEvent) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(e);
      return;
    }
    queue.push(e);
    if (e.kind === 'message') {
      st.queuedMessages++;
      st.queuedBytes += e.bytes;
    }
  };
  const dropMessages = () => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'message') queue.splice(i, 1);
    st.queuedMessages = 0;
    st.queuedBytes = 0;
  };
  let closed: WsEvent | null = null;
  /** Disconnect a flooding target: stop reading, drop what is queued, close 1008 with a reason. */
  const overflow = (why: string) => {
    if (closed) return;
    st.overflow = why;
    dropMessages();
    const reason = `arena: ${why}`.slice(0, 123);
    closed = { kind: 'closed', code: 1008, reason, overflow: true };
    try {
      ws.pause();
    } catch {
      /* not open */
    }
    try {
      ws.close(1008, reason);
    } catch {
      ws.terminate();
    }
    setTimeout(() => ws.terminate(), 200).unref();
    push(closed);
  };

  // ── Outbound write deadlines (G-29) ──
  interface PendingSend {
    sentAt: number;
    due: number;
    fail?: (e: Error) => void;
  }
  const pending = new Set<PendingSend>();
  let watchdog: NodeJS.Timeout | null = null;
  // G-45: under hosted-v1 the text never names the host.
  const origin = originLabel(ctx.policy, url);
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    if (!pending.size || closed) return;
    let first = Infinity;
    for (const p of pending) first = Math.min(first, p.due);
    watchdog = setTimeout(checkSends, Math.max(0, first - performance.now()));
    watchdog.unref();
  };
  /** The target stopped reading: terminate, fail explicit senders, time out a waiting `next()`. */
  const sendTimedOut = (late: PendingSend) => {
    if (closed) return;
    st.sendTimeout = true;
    const now = performance.now();
    const budget = Math.max(0, Math.round(late.due - late.sentAt));
    const err = new WsSendTimeoutError(origin, budget, Math.max(0, Math.round(now - late.due)));
    closed = { kind: 'closed', code: 1006, reason: `arena: ${err.message.replace(/^ws: /, '')}`.slice(0, 240), overflow: false };
    dropMessages();
    for (const p of pending) p.fail?.(err);
    pending.clear();
    st.pendingSends = 0;
    clearWatchdog();
    ws.terminate();
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ kind: 'timeout', reason: 'send_timeout' });
    }
  };
  function checkSends(): void {
    watchdog = null;
    const now = performance.now();
    for (const p of pending) {
      if (p.due <= now) return sendTimedOut(p);
    }
    armWatchdog();
  }

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`WebSocket upgrade refused with HTTP ${res.statusCode ?? 0}${res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? ' (redirects are not followed)' : ''}`));
      res.destroy();
    });
  });
  ws.removeAllListeners('error');
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (closed) return; // after an overflow nothing more is read or kept
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    st.totalMessages++;
    st.totalBytes += buf.byteLength;
    if (st.totalBytes > lim.maxConnectionBytes) return overflow(`more than ${lim.maxConnectionBytes} bytes received on one connection`);
    if (st.totalMessages > lim.maxConnectionMessages) return overflow(`more than ${lim.maxConnectionMessages} messages received on one connection`);
    if (!waiter && (st.queuedMessages + 1 > lim.maxQueuedMessages || st.queuedBytes + buf.byteLength > lim.maxQueuedBytes)) {
      return overflow(`more than ${lim.maxQueuedMessages} unread messages or ${lim.maxQueuedBytes} unread bytes (the target sends without being asked)`);
    }
    push({ kind: 'message', data: buf, bytes: buf.byteLength });
  });
  ws.on('close', (code: number, reason: Buffer) => {
    clearWatchdog();
    if (closed) return;
    closed = { kind: 'closed', code, reason: targetExcerpt(reason, 123) };
    push(closed);
  });
  ws.on('error', () => {
    /* surfaced through `close` */
  });

  return {
    async send(text, deadline) {
      const refuseClosed = () => {
        const c = closed as Extract<WsEvent, { kind: 'closed' }>;
        if (st.sendTimeout) {
          throw Object.assign(new Error(`the arena closed the WebSocket to ${origin}: ${c.reason.replace(/^arena: /, '')}`), { code: 'EARENA_WS_CLOSED', reason: 'send_timeout' });
        }
        throw Object.assign(new Error(c.overflow ? `the arena closed the WebSocket (1008): ${c.reason.replace(/^arena: /, '')}` : `the WebSocket is closed (code ${c.code})`), { code: 'EARENA_WS_CLOSED' });
      };
      if (closed) refuseClosed();
      await ctx.limiter.take();
      if (closed) refuseClosed();
      const sentAt = performance.now();
      const cap = sentAt + WS_SEND_TIME_CAP_MS;
      const entry: PendingSend = { sentAt, due: deadline === undefined ? cap : Math.min(deadline, cap) };
      const accepted = new Promise<void>((resolve, reject) => {
        entry.fail = reject;
        ws.send(text, (err) => {
          if (!pending.delete(entry)) return; // already timed out (or the socket went away)
          st.pendingSends = pending.size;
          armWatchdog();
          if (err) reject(err);
          else resolve();
        });
      });
      pending.add(entry);
      st.pendingSends = pending.size;
      armWatchdog();
      if (deadline === undefined) {
        // Fire and watch: the frame is due by the next decision deadline (next()), or the cap.
        accepted.catch(() => {
          /* surfaced through next() / the closed state */
        });
        return;
      }
      await accepted;
    },
    next(deadline) {
      // Frames still unread by the target are due by this decision's deadline (G-29).
      let tightened = false;
      for (const p of pending) {
        if (deadline < p.due) {
          p.due = deadline;
          tightened = true;
        }
      }
      if (tightened) armWatchdog();
      const q = queue.shift();
      if (q) {
        if (q.kind === 'message') {
          st.queuedMessages--;
          st.queuedBytes -= q.bytes;
        }
        return Promise.resolve(q);
      }
      if (closed) return Promise.resolve(closed);
      return new Promise<WsEvent>((resolve) => {
        const t = setTimeout(() => {
          waiter = null;
          resolve({ kind: 'timeout' });
        }, Math.max(0, deadline - performance.now()));
        waiter = (e) => {
          clearTimeout(t);
          resolve(e);
        };
      });
    },
    drain() {
      const n = queue.filter((e) => e.kind === 'message').length;
      dropMessages();
      return n;
    },
    stats() {
      return { ...st };
    },
    close() {
      clearWatchdog();
      pending.clear();
      st.pendingSends = 0;
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
      setTimeout(() => ws.terminate(), 200).unref();
    },
  };
}

export { NetTimeoutError };
