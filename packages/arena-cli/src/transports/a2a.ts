/**
 * `a2a` binding: target.url is the agent card. connect() fetches it and takes
 * its `url` as the JSON-RPC endpoint, which MUST be on the origin the user
 * typed (threat model C-5 / N-5: a card cannot steer the runner, or the
 * credential, to another host). Per decision: `message/send` with one DataPart
 * whose `data` is the frame; the first DataPart of the reply message, or of the
 * completed task's artifacts / status message, is the action frame. A task
 * still working is polled with `tasks/get` until Dh, then it is a hard miss.
 */

import { randomUUID } from 'node:crypto';
import { misconfig, runError } from '../errors.ts';
import { httpRequest, originOf, type NetContext } from '../net/index.ts';
import { targetExcerpt } from '../redact.ts';
import { frameAnswer, rpc } from './jsonrpc.ts';
import { RESPONSE_CAP_BYTES, type Answer, type TargetSession, type Transport } from './types.ts';

type Part = { kind?: unknown; type?: unknown; data?: unknown };

function firstDataPart(parts: unknown): unknown {
  if (!Array.isArray(parts)) return undefined;
  const p = (parts as Part[]).find((x) => x && typeof x === 'object' && (x.kind === 'data' || x.type === 'data'));
  return p?.data;
}

const TERMINAL_FAIL = new Set(['failed', 'rejected', 'canceled', 'cancelled', 'auth-required', 'input-required', 'unknown']);

export class A2aTransport implements Transport {
  readonly name = 'a2a' as const;
  private endpoint!: URL;

  constructor(
    private readonly ctx: NetContext,
    private readonly cardUrl: URL,
  ) {}

  async connect(deadline: number): Promise<void> {
    const res = await httpRequest(this.ctx, { method: 'GET', url: this.cardUrl, deadline, maxBytes: RESPONSE_CAP_BYTES });
    const hosted = !!this.ctx.policy.allowOrigins;
    // G-45: under hosted-v1 no text names the verified origin or a foreign one.
    const where = hosted ? 'the A2A agent card on the verified origin' : `A2A agent card at ${this.cardUrl.origin}${this.cardUrl.pathname}`;
    if (res.redirectRefused) throw runError(`${where} answered with a redirect; redirects are refused.`, 'point --target at the final agent-card URL (or pass --follow-redirects for same-origin hops).');
    if (res.status !== 200 || res.truncated) throw runError(`${where} answered HTTP ${res.status}${res.truncated ? ' (over the size cap)' : ''}.`, 'point --target at the agent card, usually https://host/.well-known/agent-card.json.');
    let card: { url?: unknown };
    try {
      card = JSON.parse(res.body.toString('utf8')) as { url?: unknown };
    } catch {
      throw runError(`${where} is not JSON.`, 'point --target at the agent card, usually https://host/.well-known/agent-card.json.');
    }
    if (!card || typeof card !== 'object' || typeof card.url !== 'string') throw runError(`${where} has no \`url\` field.`, 'the card must name its JSON-RPC endpoint in `url`.');
    let ep: URL;
    try {
      ep = new URL(card.url, this.cardUrl);
    } catch {
      throw runError(`${where} has an invalid \`url\`.`);
    }
    if (originOf(ep) !== this.ctx.userOrigin) {
      throw misconfig(hosted ? `${where} names an endpoint on another origin; hosted-v1 dials the verified origin only.` : `${where} names an endpoint on another origin (${targetExcerpt(originOf(ep), 120)}); the arena only talks to the origin you typed (${this.ctx.userOrigin}).`, 'serve the JSON-RPC endpoint on the same origin as the card, or pass the endpoint origin as --target.');
    }
    this.endpoint = ep;
  }

  private async send(frame: Record<string, unknown>, deadline: number, contextId: string): Promise<Answer> {
    const message = { kind: 'message', role: 'user', messageId: randomUUID(), contextId, parts: [{ kind: 'data', data: frame }] };
    const out = await rpc(this.ctx, this.endpoint, 'message/send', { message, configuration: { blocking: true, acceptedOutputModes: ['application/json'] } }, deadline);
    if (!out.ok) return out.answer;
    let r = out.result as { kind?: unknown; parts?: unknown; id?: unknown; status?: { state?: unknown; message?: { parts?: unknown } }; artifacts?: { parts?: unknown }[] } | null;
    for (;;) {
      if (!r || typeof r !== 'object') return { kind: 'refused', why: 'protocol', detail: 'message/send returned no result' };
      if (r.kind === 'message' || (r.kind === undefined && Array.isArray(r.parts))) return frameAnswer(firstDataPart(r.parts));
      if (r.kind !== 'task') return { kind: 'refused', why: 'protocol', detail: 'message/send returned neither a message nor a task' };
      const state = typeof r.status?.state === 'string' ? r.status.state : 'unknown';
      if (state === 'completed') {
        for (const a of Array.isArray(r.artifacts) ? r.artifacts : []) {
          const d = firstDataPart(a?.parts);
          if (d !== undefined) return frameAnswer(d);
        }
        return frameAnswer(firstDataPart(r.status?.message?.parts));
      }
      if (TERMINAL_FAIL.has(state)) return { kind: 'refused', why: 'protocol', detail: `task ended in state ${targetExcerpt(state, 32)}` };
      if (typeof r.id !== 'string' || r.id.length > 256) return { kind: 'refused', why: 'protocol', detail: 'working task without an id' };
      if (performance.now() + 50 >= deadline) return { kind: 'timeout' };
      await new Promise((res) => setTimeout(res, 50));
      const poll = await rpc(this.ctx, this.endpoint, 'tasks/get', { id: r.id }, deadline);
      if (!poll.ok) return poll.answer;
      r = poll.result as typeof r;
    }
  }

  async openEpisode(episodeId: string): Promise<TargetSession> {
    return {
      decide: (frame, deadline) => this.send(frame, deadline, episodeId),
      end: async (frame, deadline) => {
        await this.send(frame, deadline, episodeId);
      },
      close: () => {},
    };
  }

  async close(): Promise<void> {
    this.ctx.close();
  }
}
