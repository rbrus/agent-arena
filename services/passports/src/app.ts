/**
 * Passports service (token issuer + passport lifecycle). Prod: a scale-to-zero
 * Cloud Run service (ADR-000). Local demo: composed into the single dev server.
 *
 * Endpoints (contracts/openapi.yaml):
 *   POST   /v1/agents                     register (Architect-JWT/dev-auth gated)
 *   POST   /v1/oauth/token                client_credentials (public, no oracle)
 *   POST   /v1/agents/{client_id}/rotate  rotate secret + signing key (must-own)
 *   DELETE /v1/agents/{client_id}         revoke (must-own; revokes the signing key)
 *
 * Signing keys (Phase 8 B3c, G-11): registration and rotation mint a fresh
 * per-passport Ed25519 key pair. The store receives ONLY the public JWK (+ its
 * RFC 7638 thumbprint as `kid`); the private JWK is returned once in
 * `signing_key`, like `client_secret`, and is never stored or logged.
 *   GET    /.well-known/jwks.json         public signing keys
 */

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import {
  generateClientSecret,
  getPublicJwks,
  mintPassportSigningKey,
  hashSecret,
  isRootToken,
  mintAccessToken,
  narrowChildScope,
  verifyAccessToken,
  verifySecret,
  DELEGATED_TTL_CAP_SECONDS,
  DELEGATION_GRANT_TTL_SECONDS,
  MAX_SQUAD_SIZE,
  type AccessClaims,
  type DelegationClaim,
  type League,
} from 'wot-auth';
import { idPattern, newId, type Stores } from 'wot-store';

/**
 * Pre-auth rate-limit key for a PRESENTED (unauthenticated) client id (G-5).
 * Only a well-formed `cid_<ULID>` gets its own bucket; anything else (missing,
 * malformed, over-long, attacker-invented) shares ONE bucket, so invented
 * strings cannot grow the limiter map or dodge the per-client limit.
 */
const CLIENT_ID_RE = idPattern('cid');
export const UNRECOGNISED_CLIENT_BUCKET = '(unrecognised-client)';
export function preAuthClientKey(presented: unknown): string {
  return typeof presented === 'string' && CLIENT_ID_RE.test(presented) ? presented : UNRECOGNISED_CLIENT_BUCKET;
}
import {
  RateLimiter,
  errorHandler,
  log,
  notFound,
  requestContext,
  sendError,
  sendRateLimited,
} from './lib.ts';
import {
  AuthError,
  announceAuthMode,
  resolvePrincipal,
  sanitizeDisplayName,
} from './auth.ts';
import { architectVerifierFromEnv, type ArchitectVerifier } from './architect-verifier.ts';
import {
  firstError,
  validateRegisterAgent,
  validateTokenExchange,
  validateTokenRequest,
} from './validate.ts';

export interface PassportsDeps {
  stores: Stores;
  /**
   * Human-plane (Architect) verifier (agent-passports §1.1, ADR-003 §3).
   * `undefined` → built from the environment (`architectVerifierFromEnv()`;
   * no JWKS configured ⇒ none ⇒ management routes answer 401).
   * `null` → explicitly none (fail closed).
   */
  architectVerifier?: ArchitectVerifier | null;
}

/** Resolve the verifier in force from the deps (explicit > environment). */
export function resolveArchitectVerifier(deps: Omit<PassportsDeps, 'stores'>): ArchitectVerifier | undefined {
  if (deps.architectVerifier !== undefined) return deps.architectVerifier ?? undefined;
  return architectVerifierFromEnv();
}

const DEFAULT_SCOPES = ['play:duel', 'spectate:read', 'play:raid', 'negotiate:a2a'];
const JSON_LIMIT = '16kb';

// A fixed valid-shaped dummy hash so an unknown client_id burns the same
// constant-time verify path as a wrong secret (no enumeration oracle).
const DUMMY_HASH = hashSecret(generateClientSecret());

/** RFC 6749 §5.2 error body (schemas/oauth_error.schema.json). */
function sendOAuthError(res: Response, status: number, error: string, description: string): void {
  res.setHeader('Cache-Control', 'no-store');
  if (error === 'invalid_client') res.setHeader('WWW-Authenticate', 'Basic realm="passports"');
  res.status(status).json({ error, error_description: description });
}

function parseBasicAuth(header: string | undefined): { id: string; secret: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** Attach the passports routes to an existing app (used by the sandbox). */
export function attachPassportsRoutes(app: Express, deps: PassportsDeps): void {
  const { stores } = deps;
  const architectVerifier = resolveArchitectVerifier(deps);
  announceAuthMode(architectVerifier);

  // Rate-limit buckets (agent-passports §6.1). Per-instance, exact for min=max=1.
  const tokenPerClient = new RateLimiter(30, 60_000); // 30 / min / passport
  const tokenPerOwner = new RateLimiter(120, 60_000); // 120 / min / owner
  // Token-exchange buckets (delegated-squad-tokens §6): bound re-exchange churn
  // per squad (parent) and fleet-wide mint (owner/Sybil).
  const exchangePerClient = new RateLimiter(20, 60_000); // 20 / min / parent passport
  const exchangePerOwner = new RateLimiter(60, 60_000); // 60 / min / owner
  const registerPerOwnerDay = new RateLimiter(10, 24 * 60 * 60_000); // 10 / day / owner
  const adminPerClient = new RateLimiter(10, 60_000); // rotate/revoke 10 / min / passport
  const adminPerOwner = new RateLimiter(30, 60_000); // rotate/revoke 30 / min / owner

  app.use(requestContext);

  const jsonBody = express.json({ limit: JSON_LIMIT });
  const formBody = express.urlencoded({ extended: false, limit: JSON_LIMIT });

  // --- POST /v1/agents (register) ---------------------------------------
  app.post('/v1/agents', jsonBody, async (req: Request, res: Response) => {
    let ownerId: string;
    try {
      ({ ownerId } = await resolvePrincipal(req, stores.owners, architectVerifier));
    } catch (err) {
      const description = err instanceof AuthError ? err.description : 'Authentication failed.';
      sendError(res, 'unauthenticated', description);
      return;
    }

    if (!validateRegisterAgent(req.body)) {
      sendError(res, 'invalid_request', firstError(validateRegisterAgent));
      return;
    }

    // Per-owner Sybil brake: passport-creation quota (agent-passports §6.1).
    const quota = registerPerOwnerDay.take(ownerId);
    if (!quota.allowed) {
      sendRateLimited(res, quota.retryAfterSeconds, 'quota_exceeded');
      return;
    }

    const body = req.body as { display_name: string; league?: League; device_binding?: unknown };
    // contracts 2.2.0 (G-10): device_binding is accepted and IGNORED; nothing of
    // it is stored or minted. One line so operators see who still sends it.
    if (body.device_binding !== undefined) log('info', 'deprecated_field_ignored', { field: 'device_binding', owner_id: ownerId });
    const displayName = sanitizeDisplayName(body.display_name);
    if (displayName.length === 0) {
      sendError(res, 'invalid_request', 'display_name is empty after sanitization.');
      return;
    }
    const league: League = body.league ?? 'core';

    // G-11: the passport's own Ed25519 signing key. Only the public half is stored.
    const signing = mintPassportSigningKey();
    const created = await stores.passports.createPassport({
      ownerId,
      scopes: [...DEFAULT_SCOPES],
      league,
      displayName, // sanitized; surfaced on the public broadcast + live directory
      signingPublicJwk: signing.publicJwk,
    });

    const base = `${req.protocol}://${req.get('host')}`;
    log('info', 'passport_registered', {
      request_id: res.locals.requestId,
      client_id: created.clientId,
      agent_id: created.agentId,
      owner_id: ownerId,
      league,
      signing_kid: signing.jkt, // public thumbprint only
    });

    res.setHeader('Cache-Control', 'no-store'); // the body carries two credentials
    res.status(201).json({
      client_id: created.clientId,
      client_secret: created.secret, // shown ONCE; never logged, never returned again
      agent_id: created.agentId,
      display_name: displayName,
      league,
      scopes: [...DEFAULT_SCOPES],
      token_endpoint: `${base}/v1/oauth/token`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      created_at: new Date().toISOString(),
      // Private Ed25519 JWK (kid = RFC 7638 thumbprint), shown ONCE; never stored, never logged.
      signing_key: signing.privateJwk,
    });
  });

  // --- POST /v1/oauth/token (client_credentials) ------------------------
  app.post('/v1/oauth/token', formBody, async (req: Request, res: Response) => {
    const basic = parseBasicAuth(req.get('authorization'));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = basic?.id ?? (typeof body.client_id === 'string' ? body.client_id : undefined);
    const clientSecret =
      basic?.secret ?? (typeof body.client_secret === 'string' ? body.client_secret : undefined);

    // Grant type first (RFC 6749).
    if (body.grant_type !== 'client_credentials') {
      sendOAuthError(
        res,
        400,
        'unsupported_grant_type',
        "Only 'client_credentials' is supported in Phase 1.",
      );
      return;
    }

    // Rate-limit per presented client_id (pre-auth; bounds a mint-flood on a
    // leaked or guessed id). agent-passports §6.1.
    const perClient = tokenPerClient.take(preAuthClientKey(clientId));
    if (!perClient.allowed) {
      res.setHeader('Retry-After', String(perClient.retryAfterSeconds));
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json({ error: 'invalid_request', error_description: 'Rate limit exceeded; slow down.' });
      return;
    }

    // Shape check via AJV (grant_type/client_id/client_secret required).
    if (!validateTokenRequest({ ...body, client_id: clientId, client_secret: clientSecret })) {
      // Missing client credentials → client auth failure (no oracle, no detail
      // on which half is missing).
      if (!clientId || !clientSecret) {
        sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed.');
        return;
      }
      sendOAuthError(res, 400, 'invalid_request', 'Malformed token request.');
      return;
    }

    const record = await stores.passports.getByClientId(clientId as string);

    // Constant-time verify against the real hash OR a dummy so a bad client_id
    // and a bad secret take the same path (no enumeration oracle §2.1).
    const storedHash = record?.secretHash ?? DUMMY_HASH;
    const secretOk = verifySecret(clientSecret as string, storedHash);
    const active = record?.status === 'active';
    if (!record || !secretOk || !active) {
      sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }

    // Per-owner mint limit (agent-passports §6.1).
    const perOwner = tokenPerOwner.take(record.ownerId);
    if (!perOwner.allowed) {
      res.setHeader('Retry-After', String(perOwner.retryAfterSeconds));
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json({ error: 'invalid_request', error_description: 'Rate limit exceeded; slow down.' });
      return;
    }

    // Requested scope must be ⊆ granted; default to the granted set.
    const granted = record.scopes;
    let scopes = granted;
    if (typeof body.scope === 'string' && body.scope.trim().length > 0) {
      const requested = body.scope.trim().split(/\s+/);
      const disallowed = requested.filter((s) => !granted.includes(s));
      if (disallowed.length > 0) {
        sendOAuthError(
          res,
          400,
          'invalid_scope',
          'Requested scope exceeds the scopes granted to this passport.',
        );
        return;
      }
      scopes = requested;
    }

    const accessToken = await mintAccessToken({
      ownerId: record.ownerId,
      agentId: record.agentId,
      clientId: record.clientId,
      league: record.league,
      scope: scopes,
    });

    log('info', 'token_issued', {
      request_id: res.locals.requestId,
      client_id: record.clientId,
      owner_id: record.ownerId,
      scope: scopes.join(' '),
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 600,
      scope: scopes.join(' '),
    });
  });

  // --- POST /v1/oauth/token/exchange (RFC 8693 delegated squad tokens) ---
  // Mints up to MAX_SQUAD_SIZE child at+jwts from a parent's live token. The
  // parent authenticates AS ITSELF (client_secret_basic) AND presents its own
  // live at+jwt as subject_token — BOTH required (confused-deputy control §1.5:
  // a leaked at+jwt alone can't be exchanged; a valid client can't exchange
  // someone else's subject). Delegation narrows, never widens.
  const sendExchangeRateLimited = (res: Response, retryAfterSeconds: number): void => {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({ error: 'invalid_request', error_description: 'Rate limit exceeded; slow down.' });
  };

  app.post('/v1/oauth/token/exchange', jsonBody, async (req: Request, res: Response) => {
    const basic = parseBasicAuth(req.get('authorization'));
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Grant type first (RFC 8693 / 6749).
    if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange') {
      sendOAuthError(
        res,
        400,
        'unsupported_grant_type',
        'Expected grant_type urn:ietf:params:oauth:grant-type:token-exchange.',
      );
      return;
    }

    // Pre-auth per-presented-client exchange bucket (bounds a mint-flood on a
    // leaked/guessed id BEFORE auth). §6 per-parent bucket.
    const perClient = exchangePerClient.take(preAuthClientKey(basic?.id));
    if (!perClient.allowed) {
      sendExchangeRateLimited(res, perClient.retryAfterSeconds);
      return;
    }

    // Edge schema-validation (the parent is a hostile client too).
    if (!validateTokenExchange(body)) {
      sendOAuthError(res, 400, 'invalid_request', 'Malformed token-exchange request.');
      return;
    }

    // 1. Authenticate the parent CLIENT (constant-time; unknown id burns DUMMY_HASH
    //    so a bad id and a bad secret take the same path — no enumeration oracle).
    if (!basic?.id || !basic?.secret) {
      sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }
    const record = await stores.passports.getByClientId(basic.id);
    const storedHash = record?.secretHash ?? DUMMY_HASH;
    const secretOk = verifySecret(basic.secret, storedHash);
    if (!record || !secretOk || record.status !== 'active') {
      sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }
    // Owner must be active (ban lineage; §1.4 step 1).
    const owner = await stores.owners.getByOwnerId(record.ownerId);
    if (!owner || owner.status !== 'active') {
      sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }

    // Per-owner exchange bucket (fleet-wide mint brake; §6).
    const perOwner = exchangePerOwner.take(record.ownerId);
    if (!perOwner.allowed) {
      sendExchangeRateLimited(res, perOwner.retryAfterSeconds);
      return;
    }

    // 2. Verify the subject_token exactly as any resource server verifies it.
    let subject: AccessClaims;
    try {
      subject = await verifyAccessToken(body.subject_token as string);
    } catch {
      sendOAuthError(res, 401, 'invalid_grant', 'The subject token is invalid or expired.');
      return;
    }

    // 3. Bind subject to client (confused deputy §1.5): a parent may exchange only
    //    its OWN live token. Same coarse code space, no oracle beyond RFC code.
    if (subject.client_id !== record.clientId) {
      sendOAuthError(res, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }

    // 4. No re-delegation (depth cap = 1, §4): the subject MUST be a root token.
    if (!isRootToken(subject)) {
      sendOAuthError(
        res,
        400,
        'invalid_request',
        'A delegated child token cannot mint further children (re-delegation is not permitted).',
      );
      return;
    }

    // 5. Scope narrowing (§3): child ⊆ subject.scope ∩ DELEGABLE_SCOPES. A non-
    //    delegable scope (play:duel / negotiate:a2a) is rejected even if held.
    const requestedScope =
      typeof body.scope === 'string' && body.scope.trim().length > 0
        ? body.scope.trim().split(/\s+/)
        : null;
    const narrowed = narrowChildScope(requestedScope, subject.scopes);
    if (!narrowed.ok) {
      sendOAuthError(
        res,
        400,
        'invalid_scope',
        'Requested child scope is not delegable or not held by the parent passport.',
      );
      return;
    }
    const childScope = narrowed.scopes;

    // 6. TTL: min(DELEGATED_TTL_CAP, parent remaining). Never > parent exp (§1.3).
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.min(DELEGATED_TTL_CAP_SECONDS, subject.exp - now);
    if (ttl <= 0) {
      sendOAuthError(res, 401, 'invalid_grant', 'The subject token is invalid or expired.');
      return;
    }

    // 7. Open/reuse the delegation grant for (parent, squad); reserve slots under
    //    the squad-size cap (a 6th slot is refused; §6).
    const squad = body.squad as { squad_id?: string; raid_id?: string; count: number };
    const grant = await stores.delegations.openOrGet({
      squadId: squad.squad_id,
      raidId: squad.raid_id ?? null,
      parentClientId: record.clientId,
      parentAgentId: subject.agent_id,
      ownerId: subject.owner_id, // inherited; NEVER caller-supplied (§1.4 step 8, T-D8)
      scopes: childScope,
      ttlSeconds: DELEGATION_GRANT_TTL_SECONDS,
    });
    const slots = await stores.delegations.reserveSlots(grant.grantId, squad.count, MAX_SQUAD_SIZE);
    if (!slots) {
      sendOAuthError(
        res,
        400,
        'invalid_request',
        `Squad size would exceed ${MAX_SQUAD_SIZE}; no free slots in this squad.`,
      );
      return;
    }

    // 8. Mint the children. client_id = the PARENT's cid_ (so owner-ban/parent-
    //    revoke cascade falls out of the arena's existing check for free, §5.4);
    //    owner_id/league inherited from the subject (never widened).
    const children = [];
    for (const slot of slots) {
      const childAgentId = newId('agt');
      const memberId = newId('mem');
      const delegation: DelegationClaim = {
        grant_id: grant.grantId,
        parent_client_id: record.clientId,
        parent_agent_id: subject.agent_id,
        parent_jti: subject.jti,
        chain: [subject.agent_id, childAgentId],
        depth: 1,
        squad_id: grant.squadId,
        slot,
        member_id: memberId,
        raid_id: grant.raidId,
      };
      const accessToken = await mintAccessToken({
        ownerId: subject.owner_id,
        agentId: childAgentId,
        clientId: record.clientId,
        league: subject.league,
        scope: childScope,
        ttlSeconds: ttl,
        delegation,
      });
      children.push({
        access_token: accessToken,
        token_type: 'Bearer' as const,
        expires_in: ttl,
        scope: childScope.join(' '),
        member_id: memberId,
        slot,
        // Contract summary projection (DelegationClaim: chain/squad_id/raid_id/
        // member_id/depth only). The full enforcement claim lives IN the token.
        delegation: {
          chain: [subject.agent_id, childAgentId],
          squad_id: grant.squadId,
          raid_id: grant.raidId,
          member_id: memberId,
          depth: 1,
        },
      });
    }

    log('info', 'token_exchanged', {
      request_id: res.locals.requestId,
      client_id: record.clientId,
      owner_id: subject.owner_id,
      squad_id: grant.squadId,
      raid_id: grant.raidId ?? undefined,
      grant_id: grant.grantId,
      count: children.length,
      scope: childScope.join(' '),
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      squad_id: grant.squadId,
      raid_id: grant.raidId,
      children,
    });
  });

  // --- POST /v1/agents/{client_id}/rotate -------------------------------
  app.post('/v1/agents/:client_id/rotate', async (req: Request, res: Response) => {
    const owner = await requireOwner(req, res, stores.owners, architectVerifier);
    if (!owner) return;
    const clientId = String(req.params.client_id);
    if (!rateLimitAdmin(res, adminPerClient, adminPerOwner, clientId, owner.ownerId)) return;

    const record = await stores.passports.getByClientId(clientId);
    if (!record) {
      sendError(res, 'agent_not_found', 'No passport with that client_id.');
      return;
    }
    if (record.ownerId !== owner.ownerId) {
      sendError(res, 'not_owner', 'You do not own this passport.');
      return;
    }

    // The old signing key is revoked with the old secret; a fresh one replaces it.
    const signing = mintPassportSigningKey();
    const previousKid = record.signingKey?.kid ?? null;
    const rotated = await stores.passports.rotateSecret(clientId, { signingPublicJwk: signing.publicJwk });
    if (!rotated) {
      sendError(res, 'agent_not_found', 'No passport with that client_id.');
      return;
    }
    const after = await stores.passports.getByClientId(clientId);
    log('info', 'passport_rotated', {
      request_id: res.locals.requestId,
      client_id: clientId,
      owner_id: owner.ownerId,
      secret_version: after?.secretVersion,
      signing_kid: signing.jkt,
      revoked_signing_kid: previousKid ?? undefined,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      client_id: clientId,
      client_secret: rotated.secret, // shown ONCE
      secret_version: after?.secretVersion ?? 2,
      rotated_at: after?.rotatedAt ?? new Date().toISOString(),
      signing_key: signing.privateJwk, // shown ONCE; the previous key no longer verifies
    });
  });

  // --- DELETE /v1/agents/{client_id} (revoke) ---------------------------
  app.delete('/v1/agents/:client_id', async (req: Request, res: Response) => {
    const owner = await requireOwner(req, res, stores.owners, architectVerifier);
    if (!owner) return;
    const clientId = String(req.params.client_id);
    if (!rateLimitAdmin(res, adminPerClient, adminPerOwner, clientId, owner.ownerId)) return;

    const record = await stores.passports.getByClientId(clientId);
    if (!record) {
      sendError(res, 'agent_not_found', 'No passport with that client_id.');
      return;
    }
    if (record.ownerId !== owner.ownerId) {
      sendError(res, 'not_owner', 'You do not own this passport.');
      return;
    }

    await stores.passports.revoke(clientId);
    const after = await stores.passports.getByClientId(clientId);
    log('info', 'passport_revoked', {
      request_id: res.locals.requestId,
      client_id: clientId,
      owner_id: owner.ownerId,
      revoked_signing_kid: record.signingKey?.kid ?? undefined,
    });
    res.status(200).json({
      client_id: clientId,
      status: 'revoked',
      revoked_at: after?.updatedAt ?? new Date().toISOString(),
    });
  });

  // --- GET /.well-known/jwks.json ---------------------------------------
  app.get('/.well-known/jwks.json', async (_req: Request, res: Response) => {
    const jwks = await getPublicJwks();
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.status(200).json(jwks);
  });
}

async function requireOwner(
  req: Request,
  res: Response,
  owners: Stores['owners'],
  verifier?: ArchitectVerifier,
): Promise<{ ownerId: string } | null> {
  try {
    return await resolvePrincipal(req, owners, verifier);
  } catch (err) {
    const description = err instanceof AuthError ? err.description : 'Authentication failed.';
    sendError(res, 'unauthenticated', description);
    return null;
  }
}

function rateLimitAdmin(
  res: Response,
  perClient: RateLimiter,
  perOwner: RateLimiter,
  clientId: string,
  ownerId: string,
): boolean {
  const c = perClient.take(clientId);
  if (!c.allowed) {
    sendRateLimited(res, c.retryAfterSeconds);
    return false;
  }
  const o = perOwner.take(ownerId);
  if (!o.allowed) {
    sendRateLimited(res, o.retryAfterSeconds);
    return false;
  }
  return true;
}

/** Build a standalone passports Express app (prod Cloud Run service / tests). */
export function createPassportsApp(deps: PassportsDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  attachPassportsRoutes(app, deps);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
