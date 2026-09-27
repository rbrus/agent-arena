/**
 * passports — OAuth2 token issuer + Agent Passport lifecycle (register / rotate
 * / revoke) + JWKS. A dependency-injection factory that RECEIVES the shared
 * `stores` (never creates its own), so the same code runs as a standalone
 * Cloud Run service (prod) and composed into the single local dev server.
 */

export {
  createPassportsApp,
  attachPassportsRoutes,
  type PassportsDeps,
} from './app.ts';

export {
  type Principal,
  sanitizeDisplayName,
} from './auth.ts';

// Human-plane (Architect) verification — ADR-003 §3, agent-passports §1.1.
// The sandbox builds ONE `architectVerifierFromEnv()` and passes it to the
// passports register gate and the gateway webhook gate.
export {
  type ArchitectVerifier,
  type VerifiedArchitect,
  type LocalJwtArchitectVerifierOptions,
  LocalJwtArchitectVerifier,
  DevArchitectVerifier,
  ArchitectVerifierConfigError,
  architectVerifierFromEnv,
  assertArchitectJwks,
  ARCHITECT_TOKEN_TYP,
  ARCHITECT_ID_RE,
  DEFAULT_ARCHITECT_AUDIENCE,
  ARCHITECT_TOKEN_MAX_AGE_SECONDS,
  DEV_ARCHITECT_ISSUER,
} from './architect-verifier.ts';

// Shared HTTP tail — re-exported so the sandbox can compose passports + gateway
// under one 404/error handler on a single port.
export { notFound, errorHandler, requestContext, log, setLogSink, type LogSink } from './lib.ts';
