/**
 * Webhook signing + best-effort delivery (contracts/webhooks.md).
 *
 * Lives in wot-store because it is shared platform machinery: the gateway
 * REGISTERS webhooks (CRUD via WebhookStore) while the arena FIRES them at
 * match.found / match.end — two separate Cloud Run services that never import
 * each other's source (ADR-000), but both import wot-store.
 *
 * Delivery is `WoT-Signature`-signed (HMAC-SHA256), retried with backoff, and
 * idempotent on the envelope `id`. For the local demo there is no external
 * infra: delivery is fire-and-forget with an in-process, unref'd retry queue and
 * a logged failure trail (webhooks.md §3). A production impl swaps this for a
 * durable queue behind the same call surface.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { newId } from './ids.ts';
import { EgressRefused, guardedPost } from './egress.ts';
import type {
  League,
  MatchSummaryPlayer,
  WebhookEventType,
  WebhookStore,
} from './types.ts';

// ---------------------------------------------------------------------------
// Signing (webhooks.md §2)
// ---------------------------------------------------------------------------

/**
 * Compute the `WoT-Signature` header value for a raw JSON body:
 *   signed_payload = "<t>" + "." + "<raw body bytes>"
 *   v1 = HMAC_SHA256(signing_secret, signed_payload)  (lowercase hex)
 * Returns `t=<unix-seconds>,v1=<hex>`.
 */
export function signWebhook(signingSecret: string, rawBody: string, tSeconds: number): string {
  const v1 = createHmac('sha256', signingSecret).update(`${tSeconds}.${rawBody}`).digest('hex');
  return `t=${tSeconds},v1=${v1}`;
}

/**
 * Reference verifier (mirrors the consumer side in webhooks.md §2). Recomputes
 * the HMAC over the RAW body and compares in constant time, honoring the
 * ±tolerance-seconds replay bound and multiple `v1=` values (rotation overlap).
 */
export function verifyWebhookSignature(
  signingSecret: string,
  rawBody: string,
  header: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = header.split(',').map((p) => p.trim());
  const t = Number((parts.find((p) => p.startsWith('t=')) ?? '').slice(2));
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', signingSecret).update(`${t}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  return sigs.some((s) => {
    const buf = Buffer.from(s, 'hex');
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
}

// ---------------------------------------------------------------------------
// Delivery payload types (webhook_event.schema.json `data`)
// ---------------------------------------------------------------------------

export interface MatchEventPlayer extends MatchSummaryPlayer {
  /** Owner of this side's passport (drives per-owner fan-out; never on the wire). */
  ownerId?: string;
}

export interface MatchFoundEvent {
  matchId: string;
  league: League;
  arenaUrl?: string;
  ticketByOwner?: Record<string, string>;
  players: MatchEventPlayer[];
}

export interface MatchEndEvent {
  matchId: string;
  league: League;
  winner: 'A' | 'B' | 'draw';
  reason: string;
  forfeitReason?: string;
  tiebreak?: string;
  finalScores: { A: number; B: number };
  tokensRemaining?: { A: number; B: number };
  ticksPlayed: number;
  seed?: number;
  replayId: string;
  replayHash: string;
  endedAt?: string;
  players: MatchEventPlayer[];
}

// ---------------------------------------------------------------------------
// Deliverer
// ---------------------------------------------------------------------------

/** Contract MINOR that stamps `api_version` on every envelope (webhook_event.api_version). */
const API_VERSION = '1.1';

/** webhooks.md §3 backoff (first attempt immediate). Compressed heavily so the */
/** in-process demo queue is bounded; a production impl uses the full ~24h ladder. */
const RETRY_BACKOFF_MS = [500, 2000, 8000];
const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookDelivererOptions {
  store: WebhookStore;
  /** Structured logger (never receives the signing secret). */
  log?: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void;
  /**
   * Local sandbox/tests only: allow plain-http and loopback/private receivers.
   * Ignored unless WOT_ENV is explicitly development|test (egress.ts).
   */
  allowPrivateTargets?: boolean;
  /** Backoff schedule override (tests). */
  backoffMs?: number[];
}

interface Envelope {
  id: string;
  type: WebhookEventType;
  api_version: string;
  created_at: string;
  attempt: number;
  webhook_id: string;
  data: Record<string, unknown>;
}

/**
 * Signs + POSTs webhook_event envelopes with retry/backoff. One delivery per
 * (webhook, event) fan-out target; the envelope `id` is stable across retries
 * (idempotency key). All calls are fire-and-forget; failures never surface to
 * the match path.
 */
export class WebhookDeliverer {
  private readonly store: WebhookStore;
  private readonly log: NonNullable<WebhookDelivererOptions['log']>;
  private readonly allowPrivateTargets: boolean;
  private readonly backoff: number[];
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(opts: WebhookDelivererOptions) {
    this.store = opts.store;
    this.log = opts.log ?? (() => undefined);
    this.allowPrivateTargets = opts.allowPrivateTargets === true;
    this.backoff = opts.backoffMs ?? RETRY_BACKOFF_MS;
  }

  /** Fire `match.found` to every owner's active match.found webhooks. */
  matchFound(ev: MatchFoundEvent): void {
    const wirePlayers = ev.players.map(stripOwner);
    for (const owner of ownersOf(ev.players)) {
      const mine = ev.players.find((p) => p.ownerId === owner);
      void this.fanOut(owner, 'match.found', {
        match_id: ev.matchId,
        mode: 'duel',
        league: ev.league,
        your_agent_id: mine?.agent_id ?? wirePlayers[0].agent_id,
        ...(ev.ticketByOwner?.[owner] ? { ticket_id: ev.ticketByOwner[owner] } : {}),
        ...(ev.arenaUrl ? { arena_url: ev.arenaUrl } : {}),
        players: wirePlayers,
      });
    }
  }

  /** Fire `match.end` to every owner's active match.end webhooks. */
  matchEnd(ev: MatchEndEvent): void {
    const wirePlayers = ev.players.map(stripOwner);
    for (const owner of ownersOf(ev.players)) {
      const mine = ev.players.find((p) => p.ownerId === owner);
      void this.fanOut(owner, 'match.end', {
        match_id: ev.matchId,
        mode: 'duel',
        league: ev.league,
        winner: ev.winner,
        reason: ev.reason,
        ...(ev.forfeitReason ? { forfeit_reason: ev.forfeitReason } : {}),
        ...(ev.tiebreak ? { tiebreak: ev.tiebreak } : {}),
        final_scores: ev.finalScores,
        ...(ev.tokensRemaining ? { tokens_remaining: ev.tokensRemaining } : {}),
        your_agent_id: mine?.agent_id ?? wirePlayers[0].agent_id,
        your_result: mine?.result ?? 'draw',
        ticks_played: ev.ticksPlayed,
        ...(ev.seed !== undefined ? { seed: ev.seed } : {}),
        replay_id: ev.replayId,
        replay_hash: ev.replayHash,
        ...(ev.endedAt ? { ended_at: ev.endedAt } : {}),
        players: wirePlayers,
      });
    }
  }

  private async fanOut(
    ownerId: string,
    type: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    let hooks;
    try {
      hooks = await this.store.listForDelivery(ownerId, type);
    } catch {
      return;
    }
    const createdAt = new Date().toISOString();
    for (const hook of hooks) {
      const envelope: Envelope = {
        id: newId('evt'),
        type,
        api_version: API_VERSION,
        created_at: createdAt,
        attempt: 1,
        webhook_id: hook.webhookId,
        data,
      };
      this.attempt(hook.webhookId, hook.url, hook.signingSecret, envelope);
    }
  }

  private attempt(
    webhookId: string,
    url: string,
    signingSecret: string,
    envelope: Envelope,
  ): void {
    if (this.closed) return;
    const rawBody = JSON.stringify(envelope);
    const t = Math.floor(Date.now() / 1000);
    const signature = signWebhook(signingSecret, rawBody, t);
    // Every delivery goes through the egress guard (threat-model-arena G-3):
    // https only, no private/loopback/link-local/metadata destination (checked
    // at connect time), redirects NOT followed, bounded time and body.
    guardedPost(
      url,
      {
        'content-type': 'application/json',
        'WoT-Event': envelope.type,
        'WoT-Webhook-Id': webhookId,
        'WoT-Signature': signature,
        'WoT-Delivery-Attempt': String(envelope.attempt),
      },
      rawBody,
      { timeoutMs: DELIVERY_TIMEOUT_MS, allowPrivateTargets: this.allowPrivateTargets },
    )
      .then((res) => {
        if (res.status >= 200 && res.status < 300) {
          this.log('info', 'webhook_delivered', {
            webhook_id: webhookId,
            event_id: envelope.id,
            type: envelope.type,
            attempt: envelope.attempt,
            status: res.status,
          });
        } else {
          const reason = res.status >= 300 && res.status < 400 ? `redirect ${res.status} not followed` : `status ${res.status}`;
          this.retry(webhookId, url, signingSecret, envelope, reason);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof EgressRefused) {
          // A policy refusal is permanent for this URL: do not retry it.
          this.log('warn', 'webhook_delivery_refused', {
            webhook_id: webhookId,
            event_id: envelope.id,
            type: envelope.type,
            reason: err.reason,
          });
          return;
        }
        this.retry(webhookId, url, signingSecret, envelope, (err as Error)?.message ?? 'error');
      });
  }

  private retry(
    webhookId: string,
    url: string,
    signingSecret: string,
    envelope: Envelope,
    reason: string,
  ): void {
    const nextAttempt = envelope.attempt + 1;
    const delay = this.backoff[envelope.attempt - 1];
    if (this.closed || delay === undefined) {
      this.log('warn', 'webhook_delivery_dropped', {
        webhook_id: webhookId,
        event_id: envelope.id,
        type: envelope.type,
        attempts: envelope.attempt,
        reason,
      });
      return;
    }
    this.log('warn', 'webhook_delivery_retry', {
      webhook_id: webhookId,
      event_id: envelope.id,
      type: envelope.type,
      attempt: envelope.attempt,
      next_attempt: nextAttempt,
      in_ms: delay,
      reason,
    });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // Same envelope id (idempotency), incremented attempt.
      this.attempt(webhookId, url, signingSecret, { ...envelope, attempt: nextAttempt });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.add(timer);
  }

  /** Stop scheduling retries (shutdown). */
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

function ownersOf(players: MatchEventPlayer[]): string[] {
  const set = new Set<string>();
  for (const p of players) if (p.ownerId) set.add(p.ownerId);
  return [...set];
}

function stripOwner(p: MatchEventPlayer): MatchSummaryPlayer {
  const { player_id, agent_id, display_name, result } = p;
  return { player_id, agent_id, display_name, ...(result ? { result } : {}) };
}
