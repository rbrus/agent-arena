/**
 * `serve-reference`: the included reference agent as a local target over all
 * four bindings on ONE port (asyncapi.yaml channel `eval_target`):
 *
 *   GET  /healthz                              liveness (CI waits on it)
 *   POST /  or  /act                           rest
 *   WS   any path (e.g. /ws)                   ws
 *   POST /mcp                                  mcp (streamable HTTP, JSON responses; tool `arena_act`)
 *   GET  /.well-known/agent-card.json          a2a agent card (also /.well-known/agent.json)
 *   POST /a2a                                  a2a JSON-RPC (`message/send`)
 *   GET  /.well-known/sixi-verify              Sixi ownership proof, ONLY with --ownership-token
 *                                              (reference/ownership-proof.ts); 404 otherwise
 *
 * Every endpoint calls the same `ReferenceAgent.respond()`, so the transport
 * cannot change a decision. Binds 127.0.0.1 unless told otherwise, and refuses
 * (403) any request or WebSocket upgrade whose `Origin` is not explicitly
 * allowed (G-39: a web page cannot drive it).
 */

import { randomUUID } from 'node:crypto';
import { serve, type InboundRequest, type OutboundResponse, type RunningServer } from '../net/index.ts';
import { VERSION } from '../build-info.ts';
import { ReferenceAgent, type ServePolicy } from './policy.ts';
import { OWNERSHIP_PROOF_PATH, ownershipProofResponse } from './ownership-proof.ts';
import { hostedReferenceAdmission, type HostedReferenceOptions } from './run-token.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): OutboundResponse => ({ status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

export interface ReferenceServerOptions {
  port: number;
  host?: string;
  policy: ServePolicy;
  scenario?: string;
  /** diplomacy_standard: the served agents' tie-break salt (reference/diplomacy.ts). */
  agentSeed?: number;
  /** MCP sessions kept at once; the least recently used is evicted beyond this (default 64). */
  maxMcpSessions?: number;
  /** Idle time after which an MCP session expires (default 10 min). */
  mcpSessionTtlMs?: number;
  /** Deadline for reading a request body (default 10 s). */
  bodyTimeoutMs?: number;
  /** G-39: browser origins allowed to call the server (net/server.ts); default none, so any request with `Origin` gets 403. */
  allowedOrigins?: readonly string[];
  /**
   * `serve-reference --hosted` (I-7, SIXI-INTEGRATION §1.14): Host allowlist of the
   * verified origin and `sixi_run_token` verification (reference/run-token.ts). The
   * A2A card then names the endpoint on the verified origin (TLS terminates in front).
   */
  hosted?: HostedReferenceOptions;
  /**
   * The Sixi ownership token (already validated: resolveOwnershipToken). When set, GET
   * /.well-known/sixi-verify answers it as text/plain, without auth; when unset there is no
   * such route. Never logged and never part of the returned server object.
   */
  ownershipToken?: string;
}

export const DEFAULT_MAX_MCP_SESSIONS = 64;
export const DEFAULT_MCP_SESSION_TTL_MS = 10 * 60 * 1000;

/** JSON-RPC 2.0 ids are a string, a number or null; anything else is an invalid request (G-27). */
export function validRpcId(id: unknown): boolean {
  return id === null || (typeof id === 'string' && id.length <= 128) || (typeof id === 'number' && Number.isFinite(id));
}

/** MCP session ids with LRU eviction and an idle TTL (a Map keeps insertion order: oldest first). */
export class SessionStore {
  private readonly seen = new Map<string, number>();
  constructor(
    readonly max: number,
    readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private sweep(): void {
    const t = this.now();
    for (const [sid, at] of this.seen) {
      if (t - at <= this.ttlMs) break; // later entries were used more recently
      this.seen.delete(sid);
    }
  }

  add(sid: string): void {
    this.sweep();
    this.seen.set(sid, this.now());
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
  }

  /** True (and refreshed) when the session is live. */
  touch(sid: string): boolean {
    this.sweep();
    if (!this.seen.has(sid)) return false;
    this.seen.delete(sid);
    this.seen.set(sid, this.now());
    return true;
  }

  delete(sid: string): void {
    this.seen.delete(sid);
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface ReferenceServer extends RunningServer {
  agent: ReferenceAgent;
  urls: Record<'rest' | 'ws' | 'mcp' | 'a2a' | 'healthz', string>;
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function rpcError(id: unknown, code: number, message: string): OutboundResponse {
  return json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export async function startReferenceServer(o: ReferenceServerOptions): Promise<ReferenceServer> {
  const agent = new ReferenceAgent(o.policy, o.scenario, o.agentSeed);
  const mcpSessions = new SessionStore(o.maxMcpSessions ?? DEFAULT_MAX_MCP_SESSIONS, o.mcpSessionTtlMs ?? DEFAULT_MCP_SESSION_TTL_MS);

  const mcp = (req: InboundRequest): OutboundResponse => {
    const msg = parse(req.body) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: { frame?: unknown } } } | undefined;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(null, -32600, 'invalid request');
    if (msg.id === undefined) return { status: 202 }; // notification
    if (!validRpcId(msg.id)) return rpcError(null, -32600, 'invalid request: id must be a string, a number or null');
    if (msg.method === 'initialize') {
      const sid = randomUUID();
      mcpSessions.add(sid);
      return json(
        200,
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-arena-reference', version: VERSION } } },
        { 'mcp-session-id': sid },
      );
    }
    const sid = req.headers['mcp-session-id'];
    if (!sid || !mcpSessions.touch(sid)) return json(404, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'unknown session' } });
    if (msg.method === 'tools/list') {
      return json(200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'arena_act',
              description: 'Answer one agent-arena observation frame with one action frame.',
              inputSchema: { type: 'object', properties: { frame: { type: 'object' } }, required: ['frame'] },
            },
          ],
        },
      });
    }
    if (msg.method === 'tools/call') {
      if (msg.params?.name !== 'arena_act') return rpcError(msg.id, -32602, 'unknown tool');
      const out = agent.respond(msg.params.arguments?.frame);
      if (!out) return json(200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'no action for this frame' }] } });
      return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out } });
    }
    return rpcError(msg.id, -32601, 'method not found');
  };

  const a2a = (req: InboundRequest): OutboundResponse => {
    const msg = parse(req.body) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { message?: { parts?: { kind?: unknown; data?: unknown }[] } } } | undefined;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(null, -32600, 'invalid request');
    if (!validRpcId(msg.id ?? null)) return rpcError(null, -32600, 'invalid request: id must be a string, a number or null');
    if (msg.method !== 'message/send') return rpcError(msg.id, -32601, 'method not found');
    const parts = msg.params?.message?.parts;
    const data = Array.isArray(parts) ? parts.find((p) => p && p.kind === 'data')?.data : undefined;
    const out = agent.respond(data);
    if (!out) return rpcError(msg.id, -32602, 'no action for this frame');
    return json(200, { jsonrpc: '2.0', id: msg.id, result: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'data', data: out }] } });
  };

  const ownershipToken = o.ownershipToken;
  let port = o.port;
  const host = o.host ?? '127.0.0.1';
  const card = (req: InboundRequest): OutboundResponse => {
    // The card names the endpoint on the origin the client used (Host), so a client
    // that typed `localhost` and one that typed `127.0.0.1` both stay same-origin.
    const h = req.headers.host && /^[A-Za-z0-9.[\]:-]{1,255}$/.test(req.headers.host) ? req.headers.host : `${host}:${port}`;
    const endpoint = o.hosted ? `${new URL(o.hosted.verifiedOrigin).origin.replace(/^wss:/, 'https:')}/a2a` : `http://${h}/a2a`;
    return json(200, {
      protocolVersion: '0.3.0',
      name: `agent-arena reference (${o.policy})`,
      description: 'Scripted reference agent for agent-arena evaluation runs (no model).',
      url: endpoint,
      version: VERSION,
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [{ id: 'arena_act', name: 'arena_act', description: 'Answer one observation frame with one action frame.', tags: ['agent-arena'] }],
    });
  };

  const server = await serve({
    host,
    port: o.port,
    bodyTimeoutMs: o.bodyTimeoutMs,
    allowedOrigins: o.allowedOrigins ?? [],
    ...(o.hosted ? { admit: hostedReferenceAdmission(o.hosted, o.ownershipToken !== undefined ? [OWNERSHIP_PROOF_PATH] : []) } : {}),
    onRequest(req) {
      if (ownershipToken !== undefined && req.path === OWNERSHIP_PROOF_PATH) return ownershipProofResponse(req.method, ownershipToken);
      if (req.method === 'GET' && req.path === '/healthz') return json(200, { ok: true, policy: o.policy, scenario: o.scenario ?? 'any', decisions: agent.decisions });
      if (req.method === 'GET' && (req.path === '/.well-known/agent-card.json' || req.path === '/.well-known/agent.json')) return card(req);
      if (req.method === 'POST' && req.path === '/mcp') return mcp(req);
      if (req.method === 'DELETE' && req.path === '/mcp') {
        const sid = req.headers['mcp-session-id'];
        if (sid) mcpSessions.delete(sid);
        return { status: 204 };
      }
      if (req.method === 'POST' && req.path === '/a2a') return a2a(req);
      if (req.method === 'POST' && (req.path === '/' || req.path === '/act')) {
        const out = agent.respond(parse(req.body));
        return out ? json(200, out) : json(400, { error: 'no action for this frame' });
      }
      return json(404, { error: 'not found' });
    },
    onWsMessage(text) {
      const out = agent.respond(parse(text));
      return out && out.ok !== true ? JSON.stringify(out) : null;
    },
  });
  port = server.port;
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const base = `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`;
  return {
    ...server,
    agent,
    urls: {
      rest: `${base}/`,
      ws: `${base.replace('http:', 'ws:')}/ws`,
      mcp: `${base}/mcp`,
      a2a: `${base}/.well-known/agent-card.json`,
      healthz: `${base}/healthz`,
    },
  };
}
