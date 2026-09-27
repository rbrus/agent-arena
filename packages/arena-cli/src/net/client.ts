/**
 * The guarded HTTP client. Every HTTP byte the CLI sends (rest, mcp, a2a) goes
 * through `httpRequest`: URL pre-check, the context's guarded agent (address
 * check inside `lookup`, per socket), redirects refused (or same-origin only,
 * ≤ 3 hops, each re-checked, with `--follow-redirects`), credentials only on the
 * user's origin, identity encoding only, a streaming byte cap and a hard
 * deadline. Proxy environment variables are never consulted.
 */

import { request as httpReq, type IncomingMessage } from 'node:http';
import { request as httpsReq } from 'node:https';
import { checkUrl, originOf } from './guard.ts';
import { originLabel, type NetContext } from './context.ts';
import { targetExcerpt } from '../redact.ts';

export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_REDIRECT_HOPS = 3;

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: URL;
  headers?: Record<string, string>;
  body?: string;
  /** Absolute deadline, `performance.now()` clock. */
  deadline: number;
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  /** Only the headers the transports need; everything else is dropped unread. */
  headers: { contentType: string; location?: string; retryAfter?: string; mcpSessionId?: string };
  body: Buffer;
  /** Bytes received (may exceed body.length when the cap cut the stream). */
  bytes: number;
  truncated: boolean;
  /** Set when a 3xx was refused; the caller records a target error. */
  redirectRefused?: { location: string | undefined; crossOrigin: boolean };
  url: URL;
}

export class NetTimeoutError extends Error {
  readonly code = 'EARENA_TIMEOUT';
  /** `label`: how to name the target in the text (G-45: `the verified origin` under hosted-v1). */
  constructor(
    readonly url: URL,
    label: string = url.origin,
  ) {
    super(`no answer from ${label} before the deadline`);
  }
}

export class NetProtocolError extends Error {
  readonly code = 'EARENA_PROTOCOL';
}

function once(ctx: NetContext, r: HttpRequest, url: URL): Promise<HttpResponse> {
  checkUrl(url, ctx.policy);
  const maxBytes = r.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const remaining = Math.max(1, Math.floor(r.deadline - performance.now()));
  const secure = url.protocol === 'https:';
  const headers: Record<string, string> = {
    ...ctx.baseHeaders(),
    accept: 'application/json',
    'accept-encoding': 'identity',
    ...(r.headers ?? {}),
    ...ctx.credentialFor(url),
  };
  const body = r.body !== undefined ? Buffer.from(r.body, 'utf8') : undefined;
  if (body) {
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(body.byteLength);
  }
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = (secure ? httpsReq : httpReq)(
      url,
      { method: r.method, headers, agent: ctx.agentFor(url), lookup: ctx.lookup as never },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const h = res.headers;
        const out: HttpResponse['headers'] = { contentType: String(h['content-type'] ?? '') };
        if (typeof h.location === 'string') out.location = h.location;
        if (typeof h['retry-after'] === 'string') out.retryAfter = h['retry-after'];
        if (typeof h['mcp-session-id'] === 'string') out.mcpSessionId = h['mcp-session-id'];
        const rawEnc = String(h['content-encoding'] ?? 'identity');
        const enc = rawEnc.toLowerCase();
        if (enc !== 'identity' && enc !== '') {
          res.destroy();
          // Quote the header as sent (redacted whole, then cut), never a transformed copy the redactor cannot match.
          return done(() => reject(new NetProtocolError(`${originLabel(ctx.policy, url)} answered with Content-Encoding ${targetExcerpt(rawEnc, 32)}; the arena accepts identity only (no decompression of target output).`)));
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          bytes += c.byteLength;
          if (bytes > maxBytes) {
            truncated = true;
            res.destroy();
            return done(() => resolve({ status, headers: out, body: Buffer.concat(chunks), bytes, truncated, url }));
          }
          chunks.push(c);
        });
        res.on('end', () => done(() => resolve({ status, headers: out, body: Buffer.concat(chunks), bytes, truncated, url })));
        res.on('error', (e) => done(() => reject(e)));
        res.on('close', () => done(() => resolve({ status, headers: out, body: Buffer.concat(chunks), bytes, truncated, url })));
      },
    );
    req.on('socket', (sock) => ctx.observe(url, sock));
    const timer = setTimeout(() => {
      done(() => reject(new NetTimeoutError(url, originLabel(ctx.policy, url))));
      req.destroy();
    }, remaining);
    req.on('error', (e) => done(() => reject(e)));
    if (body) req.end(body);
    else req.end();
  });
}

/**
 * One guarded request. 3xx is never followed by default (N-3); with
 * `ctx.followRedirects` only same-origin hops are followed, at most 3, each
 * re-validated by `once` (URL + lookup).
 */
export async function httpRequest(ctx: NetContext, r: HttpRequest): Promise<HttpResponse> {
  await ctx.limiter.take();
  let url = r.url;
  for (let hop = 0; ; hop++) {
    const res = await once(ctx, r, url);
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    let next: URL | undefined;
    try {
      next = res.headers.location ? new URL(res.headers.location, url) : undefined;
    } catch {
      next = undefined;
    }
    const crossOrigin = !!next && originOf(next) !== originOf(url);
    if (!ctx.followRedirects || !next || crossOrigin || hop >= MAX_REDIRECT_HOPS) {
      return { ...res, redirectRefused: { location: res.headers.location, crossOrigin } };
    }
    url = next;
    await ctx.limiter.take();
  }
}
