/**
 * Human-plane authentication for the management operations (register, rotate,
 * revoke) — agent-passports §1.1, §"North-star constraints" (two identity planes
 * that never mix), and the Phase-1 security review's HIGHEST-PRIORITY control:
 * FAIL-CLOSED dev-auth.
 *
 * Default: `Authorization: Bearer <Architect JWT>` verified by the injected
 * `ArchitectVerifier` (architect-verifier.ts; ADR-003 §3). The
 * header bypass is opt-in ONLY via `WOT_DEV_AUTH=1` under
 * `WOT_ENV=development|test` (default OFF, fail-closed) and is loudly logged at
 * startup. A registration endpoint with auth silently bypassed is a
 * passport-minting oracle (threat-model §1), so the flag IS the guard.
 */

import type { Request } from 'express';
import type { OwnerStore } from 'wot-store';
import { assertDevAuthAllowed, devAuthEnabled } from 'wot-auth';
import type { ArchitectVerifier } from './architect-verifier.ts';
import { log } from './lib.ts';

/** Resolved human principal (the Architect) → the opaque owner id. */
export interface Principal {
  ownerId: string;
}

export class AuthError extends Error {
  constructor(public readonly description: string) {
    super(description);
  }
}

const TOKEN_REQUIRED = 'A valid Architect bearer token is required.';

// The bypass is live only when requested AND the deployment is explicitly
// development|test (wot-auth fails closed on anything else — G-1/G-4).
const DEV_AUTH_ON = (): boolean => devAuthEnabled();

/** Log the loud dev-auth banner (or the verifier in force) exactly once per process. */
let banneredOnce = false;
export function announceAuthMode(verifier?: ArchitectVerifier): void {
  // Refuse to start with WOT_DEV_AUTH=1 in production (threat-model-arena G-1).
  assertDevAuthAllowed();
  if (banneredOnce) return;
  banneredOnce = true;
  if (DEV_AUTH_ON()) {
    const owner = process.env.WOT_DEV_OWNER ?? 'own_dev';
    log('warn', 'DEV-AUTH ENABLED — human auth on /v1/agents is BYPASSED', {
      flag: 'WOT_DEV_AUTH=1',
      dev_owner_header: 'x-dev-owner',
      default_owner: owner,
      warning: 'NEVER enable in production; this endpoint mints passports without Architect auth.',
    });
  } else if (verifier) {
    log(verifier.kind === 'dev' ? 'warn' : 'info', 'Human auth — /v1/agents requires an Architect bearer token', {
      verifier: verifier.kind,
      issuer: verifier.issuer,
    });
  } else {
    log('info', 'Human auth FAIL-CLOSED — no Architect verifier configured; /v1/agents answers 401', {
      dev_auth: 'off',
      configure: 'WOT_ARCHITECT_ISS + one of WOT_ARCHITECT_JWKS / WOT_ARCHITECT_JWKS_FILE / WOT_ARCHITECT_JWKS_URL',
    });
  }
}

/**
 * Resolve the calling Architect for a management request → opaque `owner_id`.
 * Fail-closed:
 * - `WOT_DEV_AUTH=1` (dev/test only) → dev principal from `x-dev-owner`
 *   (default `own_dev`), loudly logged at startup. No owner-store lookup.
 * - otherwise → require `Authorization: Bearer <token>`, verify it via the
 *   injected `ArchitectVerifier` → (`iss`, `sub`), then get-or-create the owner
 *   keyed by that pair (`owners.resolveByArchitect`) so the same human always
 *   maps to the same owner_id (per-owner quota + ban lineage). A missing
 *   verifier, a missing token, or a verify failure REJECTS (401). No silent
 *   bypass ever — neither the dev flag nor a valid token ⇒ never authorized.
 */
export async function resolvePrincipal(
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
  if (!token) {
    throw new AuthError(TOKEN_REQUIRED);
  }
  if (!verifier) {
    // Fail closed: no human-auth verifier wired and dev-auth is off.
    throw new AuthError(
      'Human authentication is not configured. (Set WOT_ARCHITECT_ISS and WOT_ARCHITECT_JWKS*; or, for the local demo, WOT_ENV=development WOT_DEV_AUTH=1.)',
    );
  }
  let verified: { issuer: string; architectId: string } | null = null;
  try {
    verified = await verifier.verify(token);
  } catch {
    verified = null;
  }
  if (!verified || !verified.issuer || !verified.architectId) {
    throw new AuthError(TOKEN_REQUIRED);
  }
  const owner = await owners.resolveByArchitect(verified.issuer, verified.architectId);
  return { ownerId: owner.ownerId };
}

// Code-point ranges the untrusted-text pipeline strips: C0 controls, DEL + C1,
// zero-width (ZWSP/ZWNJ/ZWJ) + bidi marks, bidi overrides, bidi isolates, BOM.
// Expressed as ranges (not a regex literal) so no raw control bytes live in the
// source. (threat-model §0)
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isStripped(cp: number): boolean {
  for (const [lo, hi] of STRIP_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Untrusted-text pipeline for `display_name` (threat-model §0): NFKC-normalize,
 * strip control/zero-width/bidi characters, collapse whitespace, hard-cap at 32
 * chars AFTER normalization (so multibyte padding cannot bypass the length cap).
 */
export function sanitizeDisplayName(raw: string): string {
  const normalized = raw.normalize('NFKC');
  let out = '';
  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isStripped(cp)) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 32);
}
