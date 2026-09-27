/**
 * gateway service (management plane, REST). Prod: a Cloud Run service that owns
 * authn/z, schema validation, and rate limiting (ADR-000). Local demo: composed
 * into the single dev server.
 *
 * Endpoints (contracts/openapi.yaml 2.0.0):
 *   POST /v1/queue                   enter matchmaking (scope play:duel)
 *   GET  /v1/matches/{id}            match summary   (scope spectate:read)
 *   GET  /v1/replays/{id}            hash-committed replay (scope spectate:read)
 *   /v1/webhooks*                    Architect webhook management
 *   /v1/negotiations*                Negotiation Chambers (scope negotiate:a2a)
 */

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import type {
  League,
  Stores,
  WebhookEventType,
} from 'wot-store';
import { checkEgressUrl, EgressRefused, passportKeyResolver } from 'wot-store';
import type { PassportKeyResolver } from 'wot-auth';
import {
  RateLimiter,
  errorHandler,
  log,
  notFound,
  requestContext,
  sendError,
  sendRateLimited,
} from './lib.ts';
import { requireAgentScope } from './agent-auth.ts';
import {
  ArchitectAuthError,
  announceWebhookAuthMode,
  resolveArchitect,
  resolveGatewayArchitectVerifier,
  type ArchitectVerifier,
} from './architect-auth.ts';
import { firstError, validateQueueRequest, validateRegisterWebhook } from './validate.ts';
import { attachNegotiationRoutes } from './negotiations.ts';

export interface GatewayDeps {
  stores: Stores;
  /**
   * Arena WSS base URL used to build the ticket `arena_url` returned from
   * /v1/queue. May be the origin (`ws://host:port`) or a full arena URL
   * (`ws://host:port/v1/arena`); both are normalized to
   * `<origin>/v1/arena?ticket_id=<id>`.
   */
  arenaBaseUrl: string;
  /**
   * Human-plane (Architect) verifier for the webhook-management routes
   * (agent-passports §1.1, ADR-003 §3). Pass the SAME instance the passports
   * plane uses when both run in one process (the sandbox does).
   * `undefined` → `architectVerifierFromEnv()` (no JWKS configured ⇒ none ⇒
   * 401); `null` → explicitly none (fail closed).
   */
  architectVerifier?: ArchitectVerifier | null;
  /**
   * (Phase 8 B3a, G-11) Passport → public Ed25519 signing key for chamber
   * offers/counters/accepts. Absent: the store-backed resolver over
   * `stores.passports` (keys minted at registration; B3c). A passport without an
   * active key has every signed move refused (fail closed).
   */
  signingKeys?: PassportKeyResolver;
}

const JSON_LIMIT = '16kb';
const TICKET_TTL_MS = 60_000;

/** WSS origin (strips a trailing /v1/arena and slashes). */
function wsOriginOf(base: string): string {
  return base.replace(/\/+$/, '').replace(/\/v1\/arena$/, '');
}

/** Build the ticket arena_url, tolerant of an origin or a full arena URL base. */
function arenaUrlFor(base: string, ticketId: string): string {
  return `${wsOriginOf(base)}/v1/arena?ticket_id=${ticketId}`;
}

/** Attach the gateway routes to an existing app (used by the sandbox). */
export function attachGatewayRoutes(app: Express, deps: GatewayDeps): void {
  const { stores, arenaBaseUrl } = deps;
  const architectVerifier = resolveGatewayArchitectVerifier(deps.architectVerifier);
  announceWebhookAuthMode(architectVerifier);

  // Rate-limit buckets (agent-passports §6.1). /v1/queue is a play-plane write
  // (not itemized in §6.1); sized as a write, reads use the §6.1 read row.
  const queuePerClient = new RateLimiter(30, 60_000);
  const queuePerOwner = new RateLimiter(120, 60_000);
  const readPerClient = new RateLimiter(60, 60_000); // 60 / min / passport
  const readPerOwner = new RateLimiter(300, 60_000); // 300 / min / owner
  // Architect-plane webhook management (per owner).
  const webhookWriteLimiter = new RateLimiter(30, 60_000);
  const webhookReadLimiter = new RateLimiter(120, 60_000);

  app.use(requestContext);
  const jsonBody = express.json({ limit: JSON_LIMIT });

  // Negotiation Chambers — offer/counter/accept/withdraw over scenario-scoped
  // commitments; a signed accept binds the agreement (contracts 2.0.0). Moves are
  // verified Ed25519 signatures by the caller's passport key (G-11).
  attachNegotiationRoutes(app, { stores, signingKeys: deps.signingKeys ?? passportKeyResolver(stores.passports) });

  // --- POST /v1/queue ---------------------------------------------------
  app.post(
    '/v1/queue',
    jsonBody,
    requireAgentScope('play:duel'),
    async (req: Request, res: Response) => {
      const claims = res.locals.claims!;
      const c = queuePerClient.take(claims.client_id);
      if (!c.allowed) return void sendRateLimited(res, c.retryAfterSeconds);
      const o = queuePerOwner.take(claims.owner_id);
      if (!o.allowed) return void sendRateLimited(res, o.retryAfterSeconds);

      if (!validateQueueRequest(req.body)) {
        sendError(res, 'invalid_request', firstError(validateQueueRequest));
        return;
      }
      const body = req.body as { mode: 'duel'; league?: League };
      // `league` is the budget tier (edge | core | frontier). There are no
      // stakes, pots or ratings since ADR-001 (contracts 2.0.0 QueueTicket).
      const league: League = body.league ?? 'core';

      const ticket = await stores.tickets.createTicket({
        ownerId: claims.owner_id,
        agentId: claims.agent_id,
        mode: 'duel',
        league,
      });

      log('info', 'ticket_created', {
        request_id: res.locals.requestId,
        ticket_id: ticket.ticketId,
        client_id: claims.client_id,
        owner_id: claims.owner_id,
        agent_id: claims.agent_id,
        league,
      });

      res.status(202).json({
        ticket_id: ticket.ticketId,
        status: 'queued', // store 'pending' → contract enum [queued, matched]
        mode: 'duel',
        league,
        arena_url: arenaUrlFor(arenaBaseUrl, ticket.ticketId),
        expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
      });
    },
  );

  // --- GET /v1/matches/{match_id} ---------------------------------------
  app.get(
    '/v1/matches/:match_id',
    requireAgentScope('spectate:read'),
    async (req: Request, res: Response) => {
      const claims = res.locals.claims!;
      const c = readPerClient.take(claims.client_id);
      if (!c.allowed) return void sendRateLimited(res, c.retryAfterSeconds);
      const o = readPerOwner.take(claims.owner_id);
      if (!o.allowed) return void sendRateLimited(res, o.retryAfterSeconds);

      const matchId = String(req.params.match_id);
      const summary = await stores.matches.getSummary(matchId);
      if (!summary) {
        sendError(res, 'match_not_found', 'No match with that id.');
        return;
      }
      const { matchId: storedId, ...rest } = summary;
      res.status(200).json({ match_id: storedId, ...rest });
    },
  );

  // --- GET /v1/replays/{replay_id} --------------------------------------
  app.get(
    '/v1/replays/:replay_id',
    requireAgentScope('spectate:read'),
    async (req: Request, res: Response) => {
      const claims = res.locals.claims!;
      const c = readPerClient.take(claims.client_id);
      if (!c.allowed) return void sendRateLimited(res, c.retryAfterSeconds);
      const o = readPerOwner.take(claims.owner_id);
      if (!o.allowed) return void sendRateLimited(res, o.retryAfterSeconds);

      const replayId = String(req.params.replay_id);
      const replay = await stores.replays.getReplay(replayId);
      if (!replay) {
        sendError(res, 'replay_not_found', 'No replay with that id; replays exist only after match end.');
        return;
      }
      // Read-through: the arena assembles the full contract Replay body when it
      // saves the artifact; the gateway maps the store record's field names to
      // the contract's snake_case and returns it verbatim otherwise.
      res.status(200).json({
        replay_id: replay.replayId,
        match_id: replay.matchId,
        seed: replay.seed,
        replay_hash: replay.hash,
        inputs: replay.inputs,
        tick_log: replay.tickLog,
        created_at: replay.createdAt,
      });
    },
  );

  // --- Webhooks (Architect-gated; Architect JWT or dev-auth) ------------
  // Registration mints a signing secret shown EXACTLY ONCE (webhooks.md §2).
  const architect = async (req: Request, res: Response): Promise<string | null> => {
    try {
      const { ownerId } = await resolveArchitect(req, stores.owners, architectVerifier);
      return ownerId;
    } catch (err) {
      sendError(
        res,
        'unauthenticated',
        err instanceof ArchitectAuthError ? err.description : 'Authentication failed.',
      );
      return null;
    }
  };

  app.post('/v1/webhooks', jsonBody, async (req: Request, res: Response) => {
    const ownerId = await architect(req, res);
    if (!ownerId) return;
    const wl = webhookWriteLimiter.take(ownerId);
    if (!wl.allowed) return void sendRateLimited(res, wl.retryAfterSeconds);

    if (!validateRegisterWebhook(req.body)) {
      sendError(res, 'invalid_request', firstError(validateRegisterWebhook));
      return;
    }
    const body = req.body as { url: string; events: WebhookEventType[]; description?: string };
    // Early rejection with the same policy the delivery path enforces at
    // connect time (threat-model-arena G-3): https only, no userinfo, no
    // private/loopback/link-local literal address.
    try {
      checkEgressUrl(body.url);
    } catch (err) {
      const reason = err instanceof EgressRefused ? err.reason : 'malformed_url';
      sendError(res, 'invalid_request', `url is not an allowed webhook endpoint (${reason}).`);
      return;
    }
    const existing = await stores.webhooks.listByOwner(ownerId);
    if (existing.some((w) => w.url === body.url)) {
      sendError(res, 'conflict', 'A webhook with this URL is already registered.');
      return;
    }
    const { record, signingSecret } = await stores.webhooks.create({
      ownerId,
      url: body.url,
      events: body.events,
    });
    log('info', 'webhook_registered', {
      request_id: res.locals.requestId,
      webhook_id: record.webhookId,
      owner_id: ownerId,
    });
    res.status(201).json({
      webhook_id: record.webhookId,
      url: record.url,
      events: record.events,
      signing_secret: signingSecret, // shown ONCE; never returned again, never logged
      status: record.status,
      created_at: record.createdAt,
    });
  });

  app.get('/v1/webhooks', async (req: Request, res: Response) => {
    const ownerId = await architect(req, res);
    if (!ownerId) return;
    const rl = webhookReadLimiter.take(ownerId);
    if (!rl.allowed) return void sendRateLimited(res, rl.retryAfterSeconds);
    const rows = await stores.webhooks.listByOwner(ownerId);
    res.status(200).json({
      webhooks: rows.map((w) => ({
        webhook_id: w.webhookId,
        url: w.url,
        events: w.events,
        status: w.status,
        created_at: w.createdAt,
      })),
    });
  });

  app.delete('/v1/webhooks/:webhook_id', async (req: Request, res: Response) => {
    const ownerId = await architect(req, res);
    if (!ownerId) return;
    const rl = webhookWriteLimiter.take(ownerId);
    if (!rl.allowed) return void sendRateLimited(res, rl.retryAfterSeconds);
    const id = String(req.params.webhook_id);
    const record = await stores.webhooks.getById(id);
    if (!record) {
      sendError(res, 'not_found', 'No webhook with that id.');
      return;
    }
    if (record.ownerId !== ownerId) {
      sendError(res, 'not_owner', 'You do not own this webhook.');
      return;
    }
    await stores.webhooks.delete(id);
    log('info', 'webhook_deleted', { request_id: res.locals.requestId, webhook_id: id, owner_id: ownerId });
    res.status(204).end();
  });

  app.post('/v1/webhooks/:webhook_id/rotate', async (req: Request, res: Response) => {
    const ownerId = await architect(req, res);
    if (!ownerId) return;
    const rl = webhookWriteLimiter.take(ownerId);
    if (!rl.allowed) return void sendRateLimited(res, rl.retryAfterSeconds);
    const id = String(req.params.webhook_id);
    const record = await stores.webhooks.getById(id);
    if (!record) {
      sendError(res, 'not_found', 'No webhook with that id.');
      return;
    }
    if (record.ownerId !== ownerId) {
      sendError(res, 'not_owner', 'You do not own this webhook.');
      return;
    }
    const rotated = await stores.webhooks.rotate(id);
    log('info', 'webhook_rotated', { request_id: res.locals.requestId, webhook_id: id, owner_id: ownerId });
    res.status(200).json({
      webhook_id: id,
      signing_secret: rotated!.signingSecret, // shown ONCE
      rotated_at: new Date().toISOString(),
    });
  });
}

/** Build a standalone gateway Express app (prod Cloud Run service / tests). */
export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  attachGatewayRoutes(app, deps);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
