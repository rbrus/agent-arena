/**
 * The thin, framework-agnostic arena client.
 *
 * Implements the "50-line-agent minimal path" from contracts/README.md for real:
 *   POST /v1/oauth/token  → access token
 *   POST /v1/queue        → ticket + arena_url
 *   open WSS → hello      → { observation → policy → action } loop → match_end
 *   GET /v1/replays/{id}  → the gate artifact
 *
 * Everything is driven by the generated `wot-contracts` wire types, so the client
 * cannot drift from the contract. No LLMs, no game logic here — the policy is a
 * pluggable `(observation) => action` function (Pillar 9: scripted policies).
 *
 * Errors say what to do next (sdk-engineer charter): auth failures name the
 * missing scope, dropped sockets explain the reconnect, terminal closes say stop.
 */
import WebSocket from 'ws';
import { validators } from 'wot-contracts';
import type { Observation, Action, Hello, MatchEnd, ErrorEnvelope, OAuthError } from 'wot-contracts';
import type { Policy } from './grid.ts';

export type League = 'edge' | 'core' | 'frontier';
export type { Policy } from './grid.ts';

/** Terminal WSS close codes (asyncapi.yaml servers.arena) — never reconnect on these. */
const TERMINAL_CLOSE = new Set([4400, 4401, 4403, 4409, 4410, 4413, 4429]);

/** An SDK error whose message tells the developer what to do next. */
export class WotError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'WotError';
  }
}
/** Internal marker: a transient socket failure that is eligible for a single reconnect. */
class TransientDrop extends Error {}

/** Structured lifecycle events for logging / a viewer (optional `onEvent` hook). */
export type ClientEvent =
  | { type: 'token'; expiresIn: number }
  | { type: 'queued'; ticketId: string; status: string; matchId: string | null }
  | { type: 'connected'; arenaUrl: string; attempt: number; resume: boolean }
  | { type: 'session_ack'; sessionId: string; matchId: string | null }
  | { type: 'observation'; turnId: number; deadlineMs: number }
  | { type: 'action'; turnId: number; units: number }
  | { type: 'action_ack'; turnId: number; tokensSpent: number; tokensRemaining: number; coerced: number }
  | { type: 'reject'; reason: string; hint: string; turnId: number | null }
  | { type: 'reconnect'; reason: string }
  | { type: 'match_end'; result: string; winner: string; reason: string; replayId: string }
  | { type: 'close'; code: number; reason: string }
  | { type: 'warn'; message: string };

export interface ConnectAndPlayOptions {
  /** Management-plane base URL, e.g. http://localhost:8080 (sandbox) or your deployment's API origin. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Budget league dial (Ds/Dh/allowance). Default 'core'. */
  league?: League;
  /** The scripted decision function. Called once per observation. */
  policy: Policy;
  /** Optional observability hook. */
  onEvent?: (e: ClientEvent) => void;
  /** Requested OAuth scope. Default 'play:duel spectate:read'. */
  scope?: string;
  /** Validate every outgoing action against the contract before sending (dev aid). */
  validateOutgoing?: boolean;
}

export interface PlayResult {
  result: 'win' | 'loss' | 'draw';
  matchEnd: MatchEnd;
  /** The full replay artifact fetched from GET /v1/replays/{id}. */
  replay: unknown;
}

interface QueueTicket {
  ticket_id: string;
  status: 'queued' | 'matched';
  arena_url: string;
  match_id?: string | null;
}

// ─── REST helpers (Node global fetch) ────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return await res.json().catch(() => ({}));
}

async function mintToken(baseUrl: string, clientId: string, clientSecret: string, scope: string): Promise<{ token: string; expiresIn: number }> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
  const res = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await readJson(res);
  if (!res.ok) {
    const e = json as OAuthError;
    const hints: Record<string, string> = {
      invalid_client: 'check WOT_CLIENT_ID / WOT_CLIENT_SECRET — a bad client_id and a bad client_secret return the same "invalid_client" (no enumeration oracle). Re-register or rotate the secret.',
      invalid_scope: `requested scope "${scope}" exceeds this passport's granted scopes; request a subset (e.g. "play:duel spectate:read").`,
      unsupported_grant_type: 'Phase 1 supports only grant_type=client_credentials.',
      invalid_request: 'malformed token request; send grant_type + client_id + client_secret as x-www-form-urlencoded.',
    };
    throw new WotError(`token request failed (${res.status} ${e.error ?? 'error'}): ${hints[e.error ?? ''] ?? e.error_description ?? 'unknown error'}`, e);
  }
  return { token: String(json.access_token), expiresIn: Number(json.expires_in ?? 0) };
}

async function enterQueue(baseUrl: string, token: string, league: League): Promise<QueueTicket> {
  const res = await fetch(`${baseUrl}/v1/queue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'duel', league }),
  });
  const json = await readJson(res);
  if (!res.ok) {
    const e = json as ErrorEnvelope;
    const hints: Record<string, string> = {
      insufficient_scope: 'queue requires the "play:duel" scope; mint a token whose scope includes play:duel.',
      unauthenticated: 'the access token was missing/invalid; re-mint at POST /v1/oauth/token.',
      conflict: 'this passport already holds a ticket or a live match; wait for it to finish/expire before queueing again (one live session per passport).',
      rate_limited: 'queue rate limit hit; retry after the Retry-After delay.',
    };
    throw new WotError(`queue failed (${res.status} ${e.error ?? 'error'}): ${hints[e.error ?? ''] ?? e.error_description ?? 'unknown error'}`, e);
  }
  return json as unknown as QueueTicket;
}

async function fetchReplay(baseUrl: string, token: string, replayId: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/v1/replays/${replayId}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const e = await readJson(res);
    throw new WotError(
      `replay fetch failed (${res.status} ${e.error ?? 'error'}): ${e.error_description ?? 'unknown'} — replays exist only after match end and require the "spectate:read" scope.`,
      e,
    );
  }
  return res.json();
}

// ─── Registration helper (dev-auth mode, for the demo/tests) ─────────────────

export interface RegisterAgentOptions {
  baseUrl: string;
  displayName: string;
  league?: League;
  /**
   * Bearer credential for the register endpoint. Outside local dev this is an
   * Architect token (`architect+jwt`) from the identity issuer the arena is
   * configured to trust (agent-passports §1.1); in the local sandbox (started
   * with WOT_DEV_AUTH=1) any dev token is accepted. Defaults to
   * $WOT_DEV_AUTH_TOKEN or "dev".
   */
  authToken?: string;
}
export interface RegisterAgentResult {
  clientId: string;
  clientSecret: string;
  agentId: string;
}

export async function registerAgent(opts: RegisterAgentOptions): Promise<RegisterAgentResult> {
  const authToken = opts.authToken ?? process.env.WOT_DEV_AUTH_TOKEN ?? 'dev';
  const res = await fetch(`${opts.baseUrl}/v1/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: opts.displayName, ...(opts.league ? { league: opts.league } : {}) }),
  });
  const json = await readJson(res);
  if (!res.ok) {
    const e = json as ErrorEnvelope;
    throw new WotError(
      `agent registration failed (${res.status} ${e.error ?? 'error'}): ${e.error_description ?? 'unknown'} — for local dev the sandbox must run with WOT_ENV=development WOT_DEV_AUTH=1; otherwise pass an Architect token (authToken or WOT_DEV_AUTH_TOKEN) from the issuer the arena trusts (WOT_ARCHITECT_ISS).`,
      e,
    );
  }
  return { clientId: String(json.client_id), clientSecret: String(json.client_secret), agentId: String(json.agent_id) };
}

// ─── The play loop ───────────────────────────────────────────────────────────

/**
 * Full bootstrap + play a single match, returning the result and the fetched
 * replay. Reconnects once on a transient socket drop (re-mints the token and
 * resumes the in-flight match); stops on session supersession/revocation.
 */
export async function connectAndPlay(opts: ConnectAndPlayOptions): Promise<PlayResult> {
  const { baseUrl, clientId, clientSecret } = opts;
  const league = opts.league ?? 'core';
  const scope = opts.scope ?? 'play:duel spectate:read';
  const emit = (e: ClientEvent): void => opts.onEvent?.(e);

  let { token, expiresIn } = await mintToken(baseUrl, clientId, clientSecret, scope);
  emit({ type: 'token', expiresIn });
  const ticket = await enterQueue(baseUrl, token, league);
  emit({ type: 'queued', ticketId: ticket.ticket_id, status: ticket.status, matchId: ticket.match_id ?? null });

  for (let attempt = 1; ; attempt++) {
    try {
      return await playSession({ baseUrl, token, ticket, policy: opts.policy, emit, attempt, resume: attempt > 1, validateOutgoing: !!opts.validateOutgoing });
    } catch (err) {
      if (err instanceof TransientDrop && attempt < 2) {
        emit({ type: 'reconnect', reason: err.message });
        // Budgets are wall-clock and keep running; reconnect buys no thinking
        // time (hello.resume). Re-mint in case the 10-min token expired.
        ({ token } = await mintToken(baseUrl, clientId, clientSecret, scope));
        continue;
      }
      if (err instanceof TransientDrop) throw new WotError(`connection dropped and the single reconnect also failed: ${err.message}`);
      throw err;
    }
  }
}

interface SessionArgs {
  baseUrl: string;
  token: string;
  ticket: QueueTicket;
  policy: Policy;
  emit: (e: ClientEvent) => void;
  attempt: number;
  resume: boolean;
  validateOutgoing: boolean;
}

function playSession(args: SessionArgs): Promise<PlayResult> {
  const { baseUrl, token, ticket, policy, emit, attempt, resume, validateOutgoing } = args;
  return new Promise<PlayResult>((resolve, reject) => {
    const ws = new WebSocket(ticket.arena_url);
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };

    ws.on('open', () => {
      emit({ type: 'connected', arenaUrl: ticket.arena_url, attempt, resume });
      const hello: Hello = {
        t: 'hello',
        protocol_version: '1.0',
        token,
        mode: 'duel',
        ...(ticket.ticket_id ? { ticket_id: ticket.ticket_id } : {}),
        ...(resume ? { resume: true } : {}),
      };
      ws.send(JSON.stringify(hello));
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (done) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        emit({ type: 'warn', message: 'received a non-JSON frame; ignoring' });
        return;
      }
      switch (msg.t) {
        case 'ack': {
          if (msg.ack_type === 'session') {
            emit({ type: 'session_ack', sessionId: String(msg.session_id), matchId: (msg.match_id as string | null) ?? null });
          } else if (msg.ack_type === 'action') {
            const coerced = Array.isArray(msg.rejected_units) ? msg.rejected_units.length : 0;
            emit({ type: 'action_ack', turnId: Number(msg.turn_id), tokensSpent: Number(msg.tokens_spent), tokensRemaining: Number(msg.tokens_remaining), coerced });
          }
          return;
        }
        case 'observation': {
          const obs = msg as unknown as Observation;
          emit({ type: 'observation', turnId: obs.turn_id, deadlineMs: obs.deadline_ms });
          let action: Action;
          try {
            action = policy(obs);
          } catch (e) {
            emit({ type: 'warn', message: `policy threw (${(e as Error).message}); holding this tick` });
            action = { t: 'action', protocol_version: '1.0', match_id: obs.match_id, turn_id: obs.turn_id, nonce: obs.nonce, units: [] };
          }
          // Defensive: guarantee the anti-replay echo even if a policy forgot it.
          action.turn_id = obs.turn_id;
          action.nonce = obs.nonce;
          action.match_id = obs.match_id;
          if (validateOutgoing && !validators.action(action)) {
            emit({ type: 'warn', message: `outgoing action failed contract validation (${JSON.stringify(validators.action.errors)}); holding` });
            action = { t: 'action', protocol_version: '1.0', match_id: obs.match_id, turn_id: obs.turn_id, nonce: obs.nonce, units: [] };
          }
          ws.send(JSON.stringify(action));
          emit({ type: 'action', turnId: action.turn_id, units: action.units.length });
          return;
        }
        case 'reject': {
          emit({ type: 'reject', reason: String(msg.reason), hint: String(msg.hint ?? ''), turnId: (msg.turn_id as number | null) ?? null });
          return; // frame-level problem; the default (all hold) applies for the tick
        }
        case 'session_superseded': {
          settle(() => {
            ws.close();
            reject(new WotError('session superseded: another connection authenticated with this passport (close 4409). One live session per passport — stop; do not reconnect.'));
          });
          return;
        }
        case 'session_revoked': {
          settle(() => {
            ws.close();
            reject(new WotError('session revoked: the passport or its owner was revoked/banned (close 4410). Stop; obtain a new passport.'));
          });
          return;
        }
        case 'match_end': {
          const matchEnd = msg as unknown as MatchEnd;
          emit({ type: 'match_end', result: matchEnd.result, winner: matchEnd.winner, reason: matchEnd.reason, replayId: matchEnd.replay_id });
          settle(() => {
            void fetchReplay(baseUrl, token, matchEnd.replay_id)
              .then((replay) => {
                ws.close(1000);
                resolve({ result: matchEnd.result, matchEnd, replay });
              })
              .catch((e) => {
                ws.close();
                reject(e as Error);
              });
          });
          return;
        }
        default:
          emit({ type: 'warn', message: `unknown frame t=${String(msg.t)}` });
      }
    });

    ws.on('error', (e: Error) => {
      settle(() => reject(new TransientDrop(`socket error: ${e.message}`)));
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      if (done) return;
      const reason = reasonBuf?.toString() ?? '';
      emit({ type: 'close', code, reason });
      if (TERMINAL_CLOSE.has(code)) {
        settle(() => reject(new WotError(`arena closed the session (code ${code})${reason ? ': ' + reason : ''}. This is terminal; not reconnecting. See errors.md for the close-code taxonomy.`)));
      } else {
        settle(() => reject(new TransientDrop(`socket closed early (code ${code})`)));
      }
    });
  });
}
