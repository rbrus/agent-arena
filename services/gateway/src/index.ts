/**
 * gateway — REST management plane: matchmaking (enter queue) + match/replay
 * reads, with agent-token authn/z, edge validation, and rate limiting. A
 * dependency-injection factory that RECEIVES the shared `stores` (never creates
 * its own) so the same code runs standalone (prod Cloud Run) and composed into
 * the single local dev server.
 */

export {
  createGatewayApp,
  attachGatewayRoutes,
  type GatewayDeps,
} from './app.ts';

export { requireAgentScope } from './agent-auth.ts';
export { type ArchitectVerifier } from './architect-auth.ts';

// Log sink seam (tests, Cloud Logging transport); lines arrive already redacted (G-6).
export { setLogSink, type LogSink } from './lib.ts';
