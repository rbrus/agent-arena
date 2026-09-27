/**
 * Human-plane (Architect) authentication for the gateway's webhook-management
 * routes — the same fail-closed contract the passports service uses for
 * registration (agent-passports §1.1, ADR-003 §3; the Phase-1 security review's
 * highest-priority control).
 *
 * Token verification is NOT reimplemented here. The gateway takes the same
 * pluggable `ArchitectVerifier` the passports service uses (the sandbox passes
 * ONE shared instance to both planes; a standalone gateway builds its own from
 * the environment with `architectVerifierFromEnv()`). Only the verifier LIBRARY
 * is shared, via the `wot-passports` package entry point; the two services still
 * never call each other or share process state (ADR-000).
 *
 * Default: a valid `architect+jwt` bearer is required (fail closed). With no
 * verifier configured every request answers 401. The demo bypass is opt-in ONLY
 * via `WOT_DEV_AUTH=1` (development|test) and loudly logged. Webhook
 * registration mints a signing secret, so an un-gated endpoint would be an
 * oracle — the gate IS the guard.
 */

import type { Request } from 'express';
import type { OwnerStore } from 'wot-store';
import { assertDevAuthAllowed, devAuthEnabled } from 'wot-auth';
import { architectVerifierFromEnv, type ArchitectVerifier } from 'wot-passports';
import { log } from './lib.ts';

export type { ArchitectVerifier };

export interface Principal {
  ownerId: string;
}

export class ArchitectAuthError extends Error {
  constructor(public readonly description: string) {
    super(description);
  }
}

const TOKEN_REQUIRED = 'A valid Architect bearer token is required.';

/**
 * Resolve the verifier in force (same semantics as passports' `architectVerifier`):
 * `undefined` → `architectVerifierFromEnv()` (no JWKS configured ⇒ none ⇒ 401;
 * a malformed configuration THROWS at startup); `null` → explicitly none.
 */
export function resolveGatewayArchitectVerifier(
  configured: ArchitectVerifier | null | undefined,
): ArchitectVerifier | undefined {
  if (configured !== undefined) return configured ?? undefined;
  return architectVerifierFromEnv();
}

// Live only when requested AND explicitly development|test (G-1/G-4).
const DEV_AUTH_ON = (): boolean => devAuthEnabled();

let banneredOnce = false;
export function announceWebhookAuthMode(verifier?: ArchitectVerifier): void {
  // Refuse to start with WOT_DEV_AUTH=1 in production (threat-model-arena G-1).
  assertDevAuthAllowed();
  if (banneredOnce) return;
  banneredOnce = true;
  if (DEV_AUTH_ON()) {
    log('warn', 'DEV-AUTH ENABLED — human auth on /v1/webhooks is BYPASSED', {
      flag: 'WOT_DEV_AUTH=1',
      dev_owner_header: 'x-dev-owner',
      default_owner: process.env.WOT_DEV_OWNER ?? 'own_dev',
    });
  } else if (verifier) {
    log(verifier.kind === 'dev' ? 'warn' : 'info', 'Human auth — /v1/webhooks requires an Architect bearer token', {
      verifier: verifier.kind,
      issuer: verifier.issuer,
    });
  } else {
    log('info', 'Human auth FAIL-CLOSED — no Architect verifier configured; /v1/webhooks answers 401', {
      dev_auth: 'off',
      configure: 'WOT_ARCHITECT_ISS + one of WOT_ARCHITECT_JWKS / WOT_ARCHITECT_JWKS_FILE / WOT_ARCHITECT_JWKS_URL',
    });
  }
}

/**
 * Resolve the calling Architect → opaque `owner_id`. Fail-closed:
 * - `WOT_DEV_AUTH=1` (dev/test only) → dev principal from `x-dev-owner`
 *   (default `own_dev`).
 * - otherwise → verify `Authorization: Bearer <Architect token>` with the
 *   injected `ArchitectVerifier` → (`issuer`, `architectId`), then get-or-create
 *   the owner keyed by that pair, so the human who registers a webhook and the
 *   human who registers a passport share one `owner_id`. Missing verifier,
 *   missing token, or any verify failure → reject.
 */
export async function resolveArchitect(
  req: Request,
  owners: OwnerStore,
  verifier?: ArchitectVerifier,
): Promise<Principal> {
  if (DEV_AUTH_ON()) {
    const headerOwner = req.get('x-dev-owner');
    const ownerId = (headerOwner && headerOwner.trim()) || process.env.WOT_DEV_OWNER || 'own_dev';
    return { ownerId };
  }
  const authz = req.get('authorization');
  const token = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : null;
  if (!token) throw new ArchitectAuthError(TOKEN_REQUIRED);
  if (!verifier) {
    throw new ArchitectAuthError(
      'Human authentication is not configured. (Set WOT_ARCHITECT_ISS and WOT_ARCHITECT_JWKS*; or, for the local demo, WOT_ENV=development WOT_DEV_AUTH=1.)',
    );
  }
  let verified: { issuer: string; architectId: string } | null = null;
  try {
    verified = await verifier.verify(token);
  } catch {
    verified = null;
  }
  if (!verified || !verified.issuer || !verified.architectId) throw new ArchitectAuthError(TOKEN_REQUIRED);
  const owner = await owners.resolveByArchitect(verified.issuer, verified.architectId);
  return { ownerId: owner.ownerId };
}
