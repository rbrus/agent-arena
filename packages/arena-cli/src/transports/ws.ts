/**
 * `ws` binding: one WebSocket to target.url per episode; frames are text
 * messages. Anything still queued when a new observation goes out is a late
 * answer to an earlier decision and is dropped unread. A target that floods
 * the socket (more unread frames or bytes than `net/ws-client.ts` allows) is
 * disconnected with 1008; that decision is recorded as `too_large` (G-20).
 */

import { openWebSocket, type GuardedSocket, type NetContext, type WsEvent } from '../net/index.ts';
import { RESPONSE_CAP_BYTES, type Answer, type TargetSession, type Transport } from './types.ts';

function toAnswer(e: WsEvent): Answer {
  if (e.kind === 'timeout') return { kind: 'timeout' };
  if (e.kind === 'closed') {
    if (e.code === 1009 || e.overflow) return { kind: 'too_large', bytes: RESPONSE_CAP_BYTES + 1 };
    return { kind: 'unreachable', error: Object.assign(new Error(`the target closed the WebSocket connection with code ${e.code}`), { code: 'EARENA_WS_CLOSED' }) };
  }
  return { kind: 'frame', raw: e.data.toString('utf8'), bytes: e.bytes };
}

export class WsTransport implements Transport {
  readonly name = 'ws' as const;
  constructor(
    private readonly ctx: NetContext,
    private readonly url: URL,
  ) {}

  async connect(): Promise<void> {
    /* per-episode sockets; the first openEpisode is the handshake */
  }

  async openEpisode(_episodeId: string, deadline: number): Promise<TargetSession> {
    const sock: GuardedSocket = await openWebSocket(this.ctx, this.url, { deadline, maxPayload: RESPONSE_CAP_BYTES });
    return {
      decide: async (frame, dl) => {
        sock.drain();
        try {
          await sock.send(JSON.stringify(frame));
        } catch (error) {
          return { kind: 'unreachable', error };
        }
        return toAnswer(await sock.next(dl));
      },
      more: async (dl) => toAnswer(await sock.next(dl)),
      end: async (frame) => {
        try {
          await sock.send(JSON.stringify(frame));
        } catch {
          /* best effort */
        }
      },
      close: () => sock.close(),
    };
  }

  async close(): Promise<void> {
    this.ctx.close();
  }
}
