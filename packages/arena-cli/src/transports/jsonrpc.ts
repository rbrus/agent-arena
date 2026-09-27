/**
 * JSON-RPC 2.0 over the guarded HTTP client, shared by the MCP (streamable
 * HTTP) and A2A bindings. Responses may be `application/json` or a
 * `text/event-stream` carrying the response as an SSE `data:` event. Nothing
 * here follows a URL the target names; the endpoint is fixed by the caller.
 */

import { httpRequest, type HttpResponse, type NetContext } from '../net/index.ts';
import { targetExcerpt } from '../redact.ts';
import { answerFromHttp } from './rest.ts';
import { RESPONSE_CAP_BYTES, type Answer } from './types.ts';

export type RpcOutcome =
  | { ok: true; result: unknown; res: HttpResponse }
  | { ok: false; answer: Answer; res?: HttpResponse };

let nextId = 1;

function fromSse(text: string, id: number): unknown {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as { id?: unknown };
      if (msg && typeof msg === 'object' && msg.id === id) return msg;
    } catch {
      /* skip non-JSON events */
    }
  }
  return undefined;
}

export async function rpc(
  ctx: NetContext,
  url: URL,
  method: string,
  params: unknown,
  deadline: number,
  headers: Record<string, string> = {},
): Promise<RpcOutcome> {
  const id = nextId++;
  const res = await httpRequest(ctx, {
    method: 'POST',
    url,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    headers: { accept: 'application/json, text/event-stream', ...headers },
    deadline,
    maxBytes: RESPONSE_CAP_BYTES,
  });
  const http = answerFromHttp(res);
  if (http.kind !== 'frame') return { ok: false, answer: http, res };
  let msg: unknown;
  if (res.headers.contentType.toLowerCase().startsWith('text/event-stream')) msg = fromSse(http.raw, id);
  else {
    try {
      msg = JSON.parse(http.raw);
    } catch {
      msg = undefined;
    }
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, answer: { kind: 'refused', why: 'protocol', status: res.status, detail: `not a JSON-RPC response to ${method}` }, res };
  }
  const m = msg as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (m.id !== id) return { ok: false, answer: { kind: 'refused', why: 'protocol', status: res.status, detail: `JSON-RPC id mismatch on ${method}` }, res };
  if (m.error) {
    const detail = `JSON-RPC error ${typeof m.error.code === 'number' ? m.error.code : '?'}: ${typeof m.error.message === 'string' ? targetExcerpt(m.error.message, 256) : ''}`;
    return { ok: false, answer: { kind: 'refused', why: 'protocol', status: res.status, detail }, res };
  }
  return { ok: true, result: m.result, res };
}

export async function notify(ctx: NetContext, url: URL, method: string, params: unknown, deadline: number, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return httpRequest(ctx, {
    method: 'POST',
    url,
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    headers: { accept: 'application/json, text/event-stream', ...headers },
    deadline,
    maxBytes: RESPONSE_CAP_BYTES,
  });
}

/** Deepest nesting an action frame may have once taken out of an RPC envelope (a real frame is < 10 deep). */
export const MAX_FRAME_DEPTH = 64;

/** Iterative depth check: never recurses, so a hostile 30k-deep result cannot blow the stack. */
function deeperThan(v: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d >= max) return true;
    for (const k of Object.keys(x)) stack.push([(x as Record<string, unknown>)[k], d + 1]);
  }
  return false;
}

/**
 * Re-serialise an action object taken out of an RPC envelope: the bytes the
 * edge parser measures. A result nested deeper than MAX_FRAME_DEPTH, or one
 * that cannot be serialised, is a MALFORMED answer (rejected, the units Hold),
 * never an exception that would read as "target unreachable" (G-28a).
 */
export function frameAnswer(obj: unknown): Answer {
  if (obj === undefined) return { kind: 'refused', why: 'protocol', detail: 'no action frame in the response' };
  if (deeperThan(obj, MAX_FRAME_DEPTH)) return { kind: 'refused', why: 'protocol', detail: `the action frame is nested deeper than ${MAX_FRAME_DEPTH} levels (malformed)` };
  let raw: string;
  try {
    raw = JSON.stringify(obj);
  } catch {
    return { kind: 'refused', why: 'protocol', detail: 'the action frame cannot be serialised (malformed)' };
  }
  if (typeof raw !== 'string') return { kind: 'refused', why: 'protocol', detail: 'no action frame in the response' };
  return { kind: 'frame', raw, bytes: Buffer.byteLength(raw, 'utf8') };
}
