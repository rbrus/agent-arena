/**
 * Passport client-secret handling (agent-passports.md §1, §3).
 *
 * Secrets are 256-bit CSPRNG values, so a peppered HMAC-SHA256 keyed hash is
 * sufficient and fast enough for the hot token endpoint. The stored form is
 * tagged with algorithm + pepper version. We NEVER persist a recoverable
 * secret; verification is constant-time.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SECRET_PEPPER } from './config.ts';

const PREFIX = 'wotk_sk_';
const HASH_TAG = 'hmac_sha256:v1:';

/** Generate a passport client secret: `wotk_sk_<43-char base64url>` (32 bytes). */
export function generateClientSecret(): string {
  return PREFIX + randomBytes(32).toString('base64url');
}

function hmacHex(secret: string): string {
  return createHmac('sha256', SECRET_PEPPER).update(secret, 'utf8').digest('hex');
}

/** Keyed hash of a secret for storage: `hmac_sha256:v1:<hex>`. */
export function hashSecret(secret: string): string {
  return HASH_TAG + hmacHex(secret);
}

/** Constant-time verify a presented secret against a stored keyed hash. */
export function verifySecret(secret: string, stored: string): boolean {
  if (typeof stored !== 'string' || !stored.startsWith(HASH_TAG)) return false;
  const storedHex = stored.slice(HASH_TAG.length);
  const candidateHex = hmacHex(secret);
  if (storedHex.length !== candidateHex.length) return false;
  const a = Buffer.from(storedHex, 'hex');
  const b = Buffer.from(candidateHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
