/**
 * Auth configuration, via env with dev-safe defaults so a local demo needs
 * zero setup. Prod overrides every value through the environment.
 *
 * agent-passports.md §2.3 (iss/aud), §2.5 (10-min TTL), §3 (secret hashing).
 */

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerLogSecret } from './redact.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// src -> wot-auth -> packages -> ascension
const ASCENSION_ROOT = join(HERE, '..', '..', '..');

/**
 * Deployment environment — FAIL CLOSED (threat-model-arena G-4). Only an
 * EXPLICIT `WOT_ENV=development` or `WOT_ENV=test` enables the dev defaults
 * (generated pepper, disk-persisted dev signing key, the dev-auth bypass).
 * Anything else — unset, `production`, `staging`, a typo — is treated as
 * production: the security-critical secrets must come from the environment and
 * the dev-auth bypass refuses to start. `NODE_ENV` is deliberately NOT
 * consulted: a forgotten or tool-set NODE_ENV must never open a dev path.
 */
export type DeployEnv = 'development' | 'test' | 'production';

export function resolveDeployEnv(raw: string | undefined): DeployEnv {
  return raw === 'development' || raw === 'test' ? raw : 'production';
}

export const DEPLOY_ENV: DeployEnv = resolveDeployEnv(process.env.WOT_ENV);
export const IS_PRODUCTION = DEPLOY_ENV === 'production';

/** True when the explicit, loudly-logged dev-auth bypass is requested. */
export function devAuthRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WOT_DEV_AUTH === '1';
}

/**
 * Refuse to start with the dev-auth bypass in production (threat-model-arena
 * G-1). Services call this at startup (passports, gateway, the sandbox server);
 * the per-request resolvers ALSO ignore the flag in production, so a flag set
 * after startup cannot open the bypass either.
 */
export function assertDevAuthAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (devAuthRequested(env) && resolveDeployEnv(env.WOT_ENV) === 'production') {
    throw new Error(
      '[wot-auth] WOT_DEV_AUTH=1 is set but the deployment environment is production ' +
        `(WOT_ENV=${env.WOT_ENV ?? '<unset>'}; only WOT_ENV=development|test enables dev paths). ` +
        'Refusing to start with the human-auth bypass on. Unset WOT_DEV_AUTH, or set ' +
        'WOT_ENV=development for a local sandbox.',
    );
  }
}

/** The dev-auth bypass is live only when requested AND not in production. */
export function devAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return devAuthRequested(env) && resolveDeployEnv(env.WOT_ENV) !== 'production';
}

/**
 * Resolve a security-critical value: use the env value if set; in production a
 * missing value throws (fail closed); in dev fall back to the supplied default
 * and warn loudly, exactly once, so no one mistakes a dev default for real.
 */
export function requireSecretOrDevDefault(name: string, envValue: string | undefined, devDefault: string): string {
  if (envValue) return envValue;
  if (IS_PRODUCTION) {
    throw new Error(
      `[wot-auth] ${name} is required in production (any WOT_ENV other than development|test) but was unset. ` +
      `Refusing to start on a built-in dev default — that would void the control it protects. ` +
      `Provide ${name} from Secret Manager.`,
    );
  }
  console.warn(
    `[wot-auth] DEV MODE: ${name} is unset — using the built-in dev default. ` +
    `Dev defaults apply only because WOT_ENV=${DEPLOY_ENV}.`,
  );
  return devDefault;
}

/**
 * OAuth2 issuer (RFC 9068 `iss`). The default is a neutral placeholder on the
 * reserved `.invalid` TLD: a real deployment sets WOT_JWT_ISS to its own value.
 */
export const ISSUER = process.env.WOT_JWT_ISS ?? 'https://agent-arena.invalid';

/** Resource-server audience shared by gateway + arena (RFC 9068 `aud`); set WOT_JWT_AUD per deployment. */
export const AUDIENCE = process.env.WOT_JWT_AUD ?? 'agent-arena';

/** Default access-token lifetime in seconds (agent-passports.md §2.5). */
export const DEFAULT_TTL_SECONDS = Number(process.env.WOT_JWT_TTL_SECONDS ?? '600');

// ---------------------------------------------------------------------------
// Delegated squad tokens (Phase 4 B1 — docs/security/delegated-squad-tokens.md)
// ---------------------------------------------------------------------------

/**
 * The ONLY scopes a parent may narrow into a delegated child (§3.1 allowlist).
 * `negotiate:a2a` and `play:duel` are deliberately absent — a child holds NO
 * economic or ranked-1v1 authority even if the parent does, so a squad can
 * never launder stakes or boost a ladder (the anti-laundering spine).
 */
export const DELEGABLE_SCOPES: readonly string[] = ['play:raid', 'spectate:read'];

/** Raid cap: a squad is at most 5 delegated children (§6). */
export const MAX_SQUAD_SIZE = 5;

/** Depth cap = 1: a child cannot mint a grandchild (§4). Delegation is a 2-level star. */
export const MAX_DELEGATION_DEPTH = 1;

/** A child token lives ≤ this AND ≤ the parent's remaining lifetime (§1.3). */
export const DELEGATED_TTL_CAP_SECONDS = Number(process.env.WOT_DELEGATED_TTL_CAP ?? '300');

/** A delegation grant (cascade anchor) lifetime; re-exchange sustains long raids (§5.3). */
export const DELEGATION_GRANT_TTL_SECONDS = Number(process.env.WOT_DELEGATION_GRANT_TTL ?? '3600');

/**
 * Server-side pepper for the keyed secret hash (agent-passports.md §3). In prod
 * this comes from Secret Manager via env (required: startup fails without it).
 * The dev fallback is a RANDOM per-process value, not a source-visible string
 * (threat-model-arena G-4: a published default pepper would be world-known).
 * Stores are in-memory in dev, so nothing outlives the process that hashed it.
 */
export const SECRET_PEPPER = requireSecretOrDevDefault(
  'WOT_SECRET_PEPPER',
  process.env.WOT_SECRET_PEPPER,
  randomBytes(32).toString('base64url'),
);
// G-6: the pepper must never reach a log line, even as a substring.
registerLogSecret(SECRET_PEPPER);

/** Directory holding the persisted dev keypair (gitignored). */
export const DEV_KEYS_DIR =
  process.env.WOT_DEV_KEYS_DIR ?? join(ASCENSION_ROOT, '.dev-keys');

/** Optional remote JWKS URI; when set, verification uses it instead of the local key. */
export const JWKS_URI = process.env.WOT_JWKS_URI ?? null;

/** Optional private JWK (JSON) for the prod signing path. */
export const PRIVATE_JWK_ENV = process.env.WOT_JWT_PRIVATE_JWK ?? null;
registerLogSecret(PRIVATE_JWK_ENV);
