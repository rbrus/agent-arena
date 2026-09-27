/**
 * Egress id blinding (arena-scenarios.md §1.4 L3). Internal reading ids carry
 * ground truth in their prefix (`ph_`/`bait_` phantoms vs `hz_`/`cv_`/`add_r_`
 * reals). The target sees `r_` + hex(HMAC-SHA256(key, "reading\0" + id))[0:12]:
 * stable across members and ticks (pooling and temporal corroboration still work)
 * but unlinkable to its class without the key. Adds use a SEPARATE domain
 * ("add\0") so an add id is never linkable to the reading that reports it.
 *
 * The key is an INPUT (64 hex chars, random per run, chosen by the runner) and is
 * disclosed in the record only after terminal. HMAC is pure computation: no
 * clock, no randomness, no I/O.
 */

import { createHmac, randomBytes } from 'node:crypto';

const KEY_RE = /^[0-9a-f]{64}$/;

export function assertBlindingKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error('blindingKey must be 64 lowercase hex characters');
  }
}

/**
 * Memo for the pure HMAC (ids repeat across members and ticks). Bounded, and a
 * pure-function cache: it can change timing, never a value.
 */
const MEMO = new Map<string, string>();
const MEMO_MAX = 50_000;

function hmacHex(key: string, domain: string, value: string): string {
  const k = `${key}\u0000${domain}\u0000${value}`;
  const hit = MEMO.get(k);
  if (hit !== undefined) return hit;
  const out = createHmac('sha256', Buffer.from(key, 'hex')).update(`${domain}\u0000${value}`, 'utf8').digest('hex');
  if (MEMO.size >= MEMO_MAX) MEMO.clear();
  MEMO.set(k, out);
  return out;
}

/** Blinded reading id: `r_` + 12 hex. */
export function blindReadingId(key: string, internalId: string): string {
  return `r_${hmacHex(key, 'reading', internalId).slice(0, 12)}`;
}

/** Blinded add id: `a_` + 12 hex (separate HMAC domain from readings). */
export function blindAddId(key: string, internalAddId: string): string {
  return `a_${hmacHex(key, 'add', internalAddId).slice(0, 12)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * An opaque 26-char Crockford id derived from the blinding key (never from the
 * seed, L6). Used for the duel `match_id` the observation carries.
 */
export function opaqueCrockford(key: string, domain: string): string {
  const hex = hmacHex(key, domain, 'id');
  let s = '';
  for (let i = 0; i < 26; i++) s += CROCKFORD[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  return s;
}

/**
 * A fresh random blinding key. RUNNER-SIDE ONLY (non-deterministic by design):
 * the Scenario never calls this; the key enters init() as data and is recorded.
 */
export function newBlindingKey(): string {
  return randomBytes(32).toString('hex');
}
