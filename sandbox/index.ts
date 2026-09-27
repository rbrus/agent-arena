/**
 * sandbox — the arena server: passports REST plane + gateway REST plane + arena
 * WSS dial-in planes (`/v1/arena` duel, `/v1/raid` squad) on ONE HTTP port,
 * sharing ONE `createStores()` instance and the in-process `wot-auth` keypair.
 *
 * This is what the `arena` service of `sandbox/docker-compose.yml` runs (bundled
 * to `/app/arena-server.mjs` by `sandbox/build-server.mjs`), and what the
 * Phase 9 hosted runner reuses from the same image. It is also imported
 * directly by `qa/gate.ts` and `sandbox/demo-match.ts` via `startDevServer`.
 *
 * Safety defaults (threat-model-arena G-1, G-2, G-4): binds 127.0.0.1 unless
 * WOT_HOST says otherwise; refuses to start with WOT_DEV_AUTH=1 unless
 * WOT_ENV=development|test; in production the pepper and signing key must come
 * from the environment (wot-auth fails closed without them).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import cors from 'cors';
import { createStores, passportKeyResolver, type Stores } from 'wot-store';
import { assertDevAuthAllowed, type PassportKeyResolver } from 'wot-auth';
// Relative imports so the demo runs from a clean clone with no extra install
// step (the service package names resolve identically after `npm ci` in CI).
import {
  attachPassportsRoutes,
  errorHandler,
  log,
  notFound,
  requestContext,
  architectVerifierFromEnv,
  type ArchitectVerifier,
} from '../services/passports/src/index.ts';
import { attachGatewayRoutes } from '../services/gateway/src/index.ts';
// Static imports (B4): the image bundles this server with esbuild, which cannot
// follow the computed `import()` specifiers the Phase 1-6 launcher used for
// graceful degradation. Both modules are retained by the B0 cut.
import { attachArena, type AttachArenaOptions, type ArenaHandle } from '../services/arena/src/index.ts';
import { attachRaidArena, type RaidArenaHandle } from '../services/arena/src/raid.ts';

export interface StartOptions {
  /** Port to listen on. Default: `WOT_PORT` env or 8080. */
  port?: number;
  /** Extra options forwarded to `attachArena` (deadlines, limits, recover, ...). */
  arena?: Partial<Omit<AttachArenaOptions, 'server' | 'stores' | 'arenaBaseUrl' | 'signingKeys'>>;
}

export interface DevServer {
  /** Base HTTP URL, e.g. `http://localhost:8080`. */
  url: string;
  port: number;
  /** The shared in-memory stores backing all three planes. */
  stores: Stores;
  /** The one signing-key resolver shared by the gateway and the arena (G-11). */
  signingKeys: PassportKeyResolver;
  /** Graceful shutdown. */
  close: () => Promise<void>;
}

/**
 * Start the combined dev server. Builds one Express app that mounts the
 * passports + gateway routes under a single 404/error tail, wraps it in one
 * `http.Server`, attaches the arena WSS, and listens.
 */
/**
 * G-48 (docs/phase-9/SECURITY-REVIEW-HOSTED.md; threat-model-hosted §2.2): the hosted runner
 * image sets ARENA_HOSTED, and a hosted run never opens a listener. The arena server refuses to
 * start there, whatever command the job template ran. Presence counts, whatever the value.
 */
export function assertNotHostedRunner(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ARENA_HOSTED !== undefined) {
    throw new Error('hosted_mode_only: ARENA_HOSTED is set, so this is the hosted runner; the arena server (passports, gateway, arena planes) never starts there. Next: run the arena server outside the hosted runner, or remove ARENA_HOSTED from its environment.');
  }
}

export async function startDevServer(options: StartOptions = {}): Promise<DevServer> {
  assertNotHostedRunner();
  // Cloud Run injects $PORT; honor it first, then WOT_PORT, then the dev default.
  const port = options.port ?? Number(process.env.PORT ?? process.env.WOT_PORT ?? '8080');
  // Behind TLS termination (Cloud Run), the public WSS origin differs from the
  // local bind — set WOT_PUBLIC_WS_ORIGIN (e.g. wss://host) so the arena_url
  // handed to external agents is reachable. Defaults to local for the dev demo.
  const origin = process.env.WOT_PUBLIC_WS_ORIGIN ?? `ws://localhost:${port}`;
  const arenaWsUrl = `${origin}/v1/arena`;

  // ONE stores instance shared by all three planes. The store builds each
  // ticket's arena_url from this base (the gateway returns a matching value).
  const stores = createStores({ arenaBaseUrl: arenaWsUrl });

  // Human-plane auth (agent-passports §1.1, ADR-003 §3). ONE Architect verifier,
  // built from the environment and shared by the passports register gate and
  // the gateway webhook gate (this server runs all planes in one process):
  //   - WOT_ARCHITECT_ISS + one of WOT_ARCHITECT_JWKS / _FILE / _URL → EdDSA
  //     `architect+jwt` verification (self-hosted key, or the hosted issuer);
  //   - WOT_ARCHITECT_VERIFIER=dev → `Bearer dev:<architect_id>`, refused at
  //     startup unless WOT_ENV=development|test;
  //   - nothing configured → no verifier → both gates fail closed (401).
  // A malformed configuration THROWS here, so the server never starts "open".
  // With WOT_DEV_AUTH=1 (development|test only) both gates use the loudly-logged
  // x-dev-owner bypass and never call the verifier.
  // Refuse to start with WOT_DEV_AUTH=1 unless WOT_ENV=development|test (G-1/G-4).
  assertDevAuthAllowed();
  const architectVerifier: ArchitectVerifier | null = architectVerifierFromEnv() ?? null;

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(requestContext);
  // Liveness probe for the image HEALTHCHECK, compose `--wait` and the hosted
  // runner. Unauthenticated and constant: it reveals nothing but "up".
  app.get('/healthz', (_req, res) => {
    res.set('cache-control', 'no-store').json({ status: 'ok' });
  });
  // G-11 (B3c): ONE passport → public signing key resolver, backed by the shared
  // passport store (keys minted at registration), for BOTH planes that verify
  // signed moves: chamber offers (gateway) and Diplomacy press (arena).
  const signingKeys = passportKeyResolver(stores.passports);
  attachPassportsRoutes(app, { stores, architectVerifier });
  attachGatewayRoutes(app, { stores, arenaBaseUrl: origin, architectVerifier, signingKeys });

  // Raid lobby routes (squad delegation, dial-in plane). The WSS channel is
  // attached after the server is created; requests only arrive after listen().
  let raidHandle: RaidArenaHandle | null = null;
  const raidRouter = express.Router();
  raidRouter.use(express.json({ limit: '64kb' }));
  raidRouter.get('/v1/raids/bosses', (_req, res) => {
    if (!raidHandle) return res.status(503).json({ error: { code: 'unavailable', message: 'raid arena not attached' } });
    return res.json(raidHandle.bosses());
  });
  raidRouter.post('/v1/raids/queue', (req, res) => {
    if (!raidHandle) return res.status(503).json({ error: { code: 'unavailable', message: 'raid arena not attached' } });
    void raidHandle
      .queueRaid((req.body ?? {}) as Record<string, unknown>)
      .then((r) => res.status(r.status).json(r.ok ? r.ticket : { error: r.error }))
      .catch((err) => res.status(500).json({ error: { code: 'internal', message: (err as Error).message } }));
  });
  raidRouter.get('/v1/raids/:raidId', (req, res) => {
    if (!raidHandle) return res.status(503).json({ error: { code: 'unavailable', message: 'raid arena not attached' } });
    void raidHandle
      .getRaidSummary(req.params.raidId)
      .then((s) => (s ? res.json(s) : res.status(404).json({ error: { code: 'not_found', message: 'raid not found' } })))
      .catch((err) => res.status(500).json({ error: { code: 'internal', message: (err as Error).message } }));
  });
  raidRouter.get('/v1/squads/:squadId', (req, res) => {
    if (!raidHandle) return res.status(503).json({ error: { code: 'unavailable', message: 'raid arena not attached' } });
    const s = raidHandle.getSquad(req.params.squadId);
    return s ? res.json(s) : res.status(404).json({ error: { code: 'not_found', message: 'squad not found' } });
  });
  app.use(raidRouter);
  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  const arenaHandle: ArenaHandle = attachArena({ ...(options.arena ?? {}), server, stores, arenaBaseUrl: origin, signingKeys });
  log('info', 'arena attached (WSS /v1/arena)', { arena_base_url: origin });
  raidHandle = attachRaidArena({ server, stores, arenaBaseUrl: arenaWsUrl });
  log('info', 'raid arena attached (WSS /v1/raid + /v1/raids lobby)', {});

  // Bind LOOPBACK by default (threat-model-arena G-2): a sandbox started on a
  // laptop with dev-auth on must not be reachable from the LAN. The container
  // image sets WOT_HOST=0.0.0.0 (inside the container that is required for any
  // port mapping to reach it); exposure is then decided by the host-side
  // mapping, which docker-compose.yml pins to 127.0.0.1. A hosted deploy that
  // must listen on all interfaces (Cloud Run: 0.0.0.0:$PORT) sets WOT_HOST
  // explicitly and runs with WOT_ENV unset/production (no dev-auth).
  const host = process.env.WOT_HOST ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  // The bound port (differs from `port` when 0 asked the OS for a free one; tests).
  const boundPort = (server.address() as AddressInfo).port;
  const url = `http://localhost:${boundPort}`;
  log('info', 'dev server listening', { url });

  return {
    url,
    port: boundPort,
    stores,
    signingKeys,
    close: async () => {
      await raidHandle?.close();
      await arenaHandle.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
