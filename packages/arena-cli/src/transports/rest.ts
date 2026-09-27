/**
 * `rest` binding: POST each frame as application/json to target.url; a 2xx
 * body is the action frame. Non-2xx, a refused redirect, or a non-JSON body is
 * a rejected submission (the units Hold). Terminal frames are POSTed too and
 * their answer ignored. Target text in `detail` is redacted whole, then cut
 * (`targetExcerpt`, G-19).
 */

import { httpRequest, type HttpResponse, type NetContext } from '../net/index.ts';
import { targetExcerpt } from '../redact.ts';
import { parseRetryAfter, RESPONSE_CAP_BYTES, type Answer, type TargetSession, type Transport } from './types.ts';

export function answerFromHttp(res: HttpResponse): Answer {
  if (res.truncated) return { kind: 'too_large', bytes: res.bytes };
  if (res.redirectRefused) {
    return { kind: 'refused', why: 'redirect', status: res.status, detail: `redirect to ${res.redirectRefused.location === undefined ? '(no location)' : targetExcerpt(res.redirectRefused.location, 256)} refused${res.redirectRefused.crossOrigin ? ' (cross-origin)' : ''}` };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'refused', why: 'auth', status: res.status, detail: targetExcerpt(res.body, 512) };
  if (res.status === 429 || res.status === 503) {
    return { kind: 'refused', why: 'rate_limited', status: res.status, retryAfterMs: parseRetryAfter(res.headers.retryAfter), detail: targetExcerpt(res.body, 512) };
  }
  if (res.status < 200 || res.status >= 300) return { kind: 'refused', why: 'status', status: res.status, detail: targetExcerpt(res.body, 512) };
  return { kind: 'frame', raw: res.body.toString('utf8'), bytes: res.bytes };
}

export class RestTransport implements Transport {
  readonly name = 'rest' as const;
  constructor(
    private readonly ctx: NetContext,
    private readonly url: URL,
  ) {}

  async connect(): Promise<void> {
    /* REST has no handshake: the first decision is the first request. */
  }

  async openEpisode(): Promise<TargetSession> {
    const post = (frame: Record<string, unknown>, deadline: number) =>
      httpRequest(this.ctx, { method: 'POST', url: this.url, body: JSON.stringify(frame), deadline, maxBytes: RESPONSE_CAP_BYTES });
    return {
      decide: async (frame, deadline) => answerFromHttp(await post(frame, deadline)),
      end: async (frame, deadline) => {
        await post(frame, deadline);
      },
      close: () => {},
    };
  }

  async close(): Promise<void> {
    this.ctx.close();
  }
}
