/**
 * Runner-owned randomness (never inside a Scenario): run id, episode id and
 * per-decision nonce. Opaque, never derived from the seed (L6). The blinding
 * key comes from arena-scenarios' `newBlindingKey()`.
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockford26(): string {
  const b = randomBytes(26);
  let s = '';
  for (let i = 0; i < 26; i++) s += CROCKFORD[b[i] & 31];
  return s;
}

export const newRunId = (): string => `run_${crockford26()}`;
export const newEpisodeId = (): string => `epi_${crockford26()}`;
/** 8..64 chars per contract; 24 hex chars. */
export const newNonce = (): string => randomBytes(12).toString('hex');
