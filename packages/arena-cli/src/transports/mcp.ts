/**
 * `mcp` binding: target.url is an MCP server (streamable HTTP). connect() runs
 * `initialize` + `notifications/initialized` and checks that `tools/list`
 * offers `arena_act`. Per decision: `tools/call arena_act {frame}`; the result's
 * `structuredContent` is the action frame (a tool error or a missing
 * `structuredContent` is a rejected submission). The session id header the
 * server issues is echoed back; the endpoint never changes (no second hop).
 */

import { misconfig, runError } from '../errors.ts';
import { httpRequest, type NetContext } from '../net/index.ts';
import { VERSION } from '../build-info.ts';
import { targetExcerpt } from '../redact.ts';
import { frameAnswer, notify, rpc } from './jsonrpc.ts';
import type { Answer, TargetSession, Transport } from './types.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const ARENA_TOOL = 'arena_act';

export class McpTransport implements Transport {
  readonly name = 'mcp' as const;
  private session: string | undefined;
  private protocol = MCP_PROTOCOL_VERSION;

  constructor(
    private readonly ctx: NetContext,
    private readonly url: URL,
  ) {}

  private headers(): Record<string, string> {
    return { 'mcp-protocol-version': this.protocol, ...(this.session ? { 'mcp-session-id': this.session } : {}) };
  }

  async connect(deadline: number): Promise<void> {
    const where = this.ctx.policy.allowOrigins ? 'the MCP server on the verified origin' : `MCP server ${this.url.origin}${this.url.pathname}`;
    const init = await rpc(
      this.ctx,
      this.url,
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'agent-arena', version: VERSION } },
      deadline,
      { 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
    );
    if (!init.ok) {
      const a = init.answer;
      throw runError(`${where} did not complete the MCP initialize handshake (${a.kind === 'refused' ? `${a.why}${a.status ? ` HTTP ${a.status}` : ''}` : a.kind}).`, 'check that --target points at the MCP endpoint (usually .../mcp) and that it speaks streamable HTTP.');
    }
    this.session = init.res.headers.mcpSessionId;
    const r = init.result as { protocolVersion?: unknown } | null;
    if (r && typeof r.protocolVersion === 'string' && /^[0-9-]{4,16}$/.test(r.protocolVersion)) this.protocol = r.protocolVersion;
    await notify(this.ctx, this.url, 'notifications/initialized', undefined, deadline, this.headers());
    const list = await rpc(this.ctx, this.url, 'tools/list', {}, deadline, this.headers());
    const tools = list.ok ? ((list.result as { tools?: { name?: unknown }[] } | null)?.tools ?? []) : [];
    if (!Array.isArray(tools) || !tools.some((t) => t && t.name === ARENA_TOOL)) {
      throw misconfig(`${where} does not expose the \`${ARENA_TOOL}\` tool.`, `add a tool named ${ARENA_TOOL} taking {frame} and returning the action frame as structuredContent (asyncapi.yaml, channel eval_target).`);
    }
  }

  private async call(frame: Record<string, unknown>, deadline: number): Promise<Answer> {
    const out = await rpc(this.ctx, this.url, 'tools/call', { name: ARENA_TOOL, arguments: { frame } }, deadline, this.headers());
    if (!out.ok) return out.answer;
    const r = out.result as { structuredContent?: unknown; isError?: unknown; content?: { type?: unknown; text?: unknown }[] } | null;
    if (!r || typeof r !== 'object') return { kind: 'refused', why: 'protocol', detail: 'tools/call returned no result' };
    if (r.isError === true) {
      const text = Array.isArray(r.content) ? r.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text : undefined;
      return { kind: 'refused', why: 'protocol', detail: `arena_act reported an error${typeof text === 'string' ? `: ${targetExcerpt(text, 256)}` : ''}` };
    }
    return frameAnswer(r.structuredContent);
  }

  async openEpisode(): Promise<TargetSession> {
    return {
      decide: (frame, deadline) => this.call(frame, deadline),
      end: async (frame, deadline) => {
        await this.call(frame, deadline);
      },
      close: () => {},
    };
  }

  async close(): Promise<void> {
    if (this.session) {
      try {
        await httpRequest(this.ctx, { method: 'DELETE', url: this.url, headers: this.headers(), deadline: performance.now() + 1000, maxBytes: 4096 });
      } catch {
        /* best effort */
      }
    }
    this.ctx.close();
  }
}
