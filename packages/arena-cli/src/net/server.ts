/**
 * The one inbound listener the CLI ever opens: `serve-reference` (the included
 * reference agents served as a local target over REST, WS, MCP and A2A). Lives
 * in `net/` so that every socket the package touches is in one reviewed module.
 *
 * Binds 127.0.0.1 by default (threat model N-9); request bodies are capped and
 * read with a deadline (`bodyTimeoutMs`, answered 408), and the server's own
 * `headersTimeout` / `requestTimeout` are set explicitly (G-27); WebSocket
 * frames are capped and never decompressed.
 *
 * G-39: a loopback listener is still reachable from any web page the developer
 * opens (a CORS-simple `text/plain` POST is processed even though its answer is
 * opaque, and WebSocket has no CORS at all). Arena clients never send `Origin`;
 * browsers always do on cross-origin requests and WebSocket upgrades. So every
 * request, and every upgrade, carrying an `Origin` that is not on the explicit
 * allowlist (`allowedOrigins`, default: none) is refused with 403 before its
 * body is read.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface InboundRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface OutboundResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface ServeOptions {
  host?: string;
  port: number;
  maxBodyBytes?: number;
  /** Deadline for reading one request body (default 10 s). */
  bodyTimeoutMs?: number;
  onRequest(req: InboundRequest): Promise<OutboundResponse> | OutboundResponse;
  /**
   * G-39: `Origin` values a request or WebSocket upgrade may carry (exact match,
   * e.g. `http://localhost:5173`). Default: none, so any request with an `Origin`
   * header is refused (403). Requests without `Origin` (every arena client) pass.
   */
  allowedOrigins?: readonly string[];
  /** One WebSocket per episode; each text message is answered by the returned string (or nothing). */
  onWsMessage?(text: string): Promise<string | null> | string | null;
  /**
   * Admission of every request and WebSocket upgrade, BEFORE its body is read
   * (serve-reference --hosted: Host allowlist, run-token check). null = admitted;
   * otherwise the refusal status and a machine code (no detail: no verification oracle).
   */
  admit?(req: { method: string; path: string; headers: Record<string, string | undefined> }): { status: 401 | 403 | 421; error: string; headers?: Record<string, string> } | null;
}

function flatHeaders(h: IncomingMessage['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

export interface RunningServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

export const DEFAULT_BODY_TIMEOUT_MS = 10_000;

type Body = { ok: true; text: string } | { ok: false; status: 408 | 413 | 400 };

function readBody(req: IncomingMessage, max: number, timeoutMs: number): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let settled = false;
    const done = (b: Body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(b);
    };
    const timer = setTimeout(() => done({ ok: false, status: 408 }), timeoutMs);
    req.on('data', (c: Buffer) => {
      n += c.byteLength;
      if (n > max) {
        req.pause();
        done({ ok: false, status: 413 });
      } else chunks.push(c);
    });
    req.on('end', () => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => done({ ok: false, status: 400 }));
  });
}

/** G-39: true when the request carries no `Origin`, or one on the allowlist. */
export function originAllowed(origin: string | string[] | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  return allowed.includes(origin);
}

export async function serve(o: ServeOptions): Promise<RunningServer> {
  const host = o.host ?? '127.0.0.1';
  const max = o.maxBodyBytes ?? 512 * 1024;
  const bodyTimeout = o.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const allowed = [...(o.allowedOrigins ?? [])];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!originAllowed(req.headers.origin, allowed)) {
      // Before the body is read: a browser page cannot drive the agent or grow its memory.
      res.writeHead(403, { 'content-type': 'application/json', connection: 'close' }).end('{"error":"origin_not_allowed"}');
      req.socket.destroySoon?.();
      return;
    }
    if (o.admit) {
      const refusal = o.admit({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], headers: flatHeaders(req.headers) });
      if (refusal) {
        res.writeHead(refusal.status, { 'content-type': 'application/json', connection: 'close', ...(refusal.headers ?? {}) }).end(JSON.stringify({ error: refusal.error }));
        req.socket.destroySoon?.();
        return;
      }
    }
    const read = await readBody(req, max, bodyTimeout);
    if (!read.ok) {
      const error = read.status === 408 ? 'body_timeout' : read.status === 413 ? 'too_large' : 'bad_request';
      res.writeHead(read.status, { 'content-type': 'application/json', connection: 'close' }).end(`{"error":"${error}"}`);
      req.socket.destroySoon?.();
      return;
    }
    const body = read.text;
    let out: OutboundResponse;
    try {
      out = await o.onRequest({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], headers: flatHeaders(req.headers), body });
    } catch {
      out = { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"internal"}' };
    }
    res.writeHead(out.status, out.headers ?? {});
    res.end(out.body ?? '');
  });
  server.keepAliveTimeout = 5000;
  // Explicit, not Node's defaults (300 s request timeout): a slow-loris client is cut off.
  server.headersTimeout = Math.min(10_000, bodyTimeout + 1000);
  server.requestTimeout = bodyTimeout + 2000;
  if (o.onWsMessage) {
    const handler = o.onWsMessage;
    const wss = new WebSocketServer({
      server,
      maxPayload: max,
      perMessageDeflate: false,
      // G-39: a browser always sends Origin on an upgrade; WebSocket has no CORS, so refuse it here.
      verifyClient: (info: { req: IncomingMessage }, cb: (ok: boolean, code?: number, message?: string) => void) => {
        if (!originAllowed(info.req.headers.origin, allowed)) return cb(false, 403, 'origin not allowed');
        const refusal = o.admit?.({ method: 'GET', path: (info.req.url ?? '/').split('?')[0], headers: flatHeaders(info.req.headers) });
        return refusal ? cb(false, refusal.status, refusal.error) : cb(true);
      },
    });
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', async (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        try {
          const reply = await handler(data.toString('utf8'));
          if (reply !== null && ws.readyState === ws.OPEN) ws.send(reply);
        } catch {
          /* a reference agent that cannot answer simply stays silent (a miss) */
        }
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
