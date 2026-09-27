/**
 * Target transports (asyncapi.yaml channel `eval_target`, bindings rest / ws /
 * mcp / a2a). A transport only moves bytes: one observation frame out, one
 * candidate action frame back, under a deadline. It never interprets a frame;
 * `arena-scenarios/edge.ts` parses and schema-validates every candidate, and
 * the Scenario decides. So the transport cannot change an outcome (gate
 * criterion 2): a deterministic target that answers inside Ds yields the same
 * submissions, hence the same replay hash, over every transport.
 */

export type TransportName = 'rest' | 'ws' | 'mcp' | 'a2a';
export const TRANSPORTS: readonly TransportName[] = ['rest', 'ws', 'mcp', 'a2a'];

export type Answer =
  /** A candidate action frame (raw text, as received or as re-serialised from an RPC envelope). */
  | { kind: 'frame'; raw: string; bytes: number }
  /** The response exceeded the transport byte cap; recorded as `too_large`. */
  | { kind: 'too_large'; bytes: number }
  /** No answer by the hard deadline. */
  | { kind: 'timeout' }
  /** The target answered, but not with an action frame. `detail` is TARGET TEXT (untrusted). */
  | { kind: 'refused'; why: 'status' | 'redirect' | 'protocol' | 'auth' | 'rate_limited'; status?: number; detail?: string; retryAfterMs?: number }
  /** Could not reach the target at all (connection refused, DNS, TLS, blocked by the guard). */
  | { kind: 'unreachable'; error: unknown };

export interface TargetSession {
  /** Send one observation frame; wait for one answer until `deadline` (`performance.now()` clock). */
  decide(frame: Record<string, unknown>, deadline: number): Promise<Answer>;
  /** WS only: the next message after a stale/garbled one, same deadline. */
  more?(deadline: number): Promise<Answer>;
  /** Best-effort terminal notice (`eval_episode_end`); failures are ignored. */
  end(frame: Record<string, unknown>, deadline: number): Promise<void>;
  close(): void;
}

export interface Transport {
  readonly name: TransportName;
  /** One-time handshake (MCP initialize + tool check, A2A agent card). Throws a CliError on failure. */
  connect(deadline: number): Promise<void>;
  openEpisode(episodeId: string, deadline: number): Promise<TargetSession>;
  close(): Promise<void>;
}

/** Bytes a transport accepts in one response before cutting the stream (the frame cap is 8192; RPC envelopes add a little). */
export const RESPONSE_CAP_BYTES = 64 * 1024;

export function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}
