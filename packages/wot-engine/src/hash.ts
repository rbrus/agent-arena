/**
 * Deterministic state hashing + the running replay-hash chain (A1 §8.2, §8.4).
 *
 * `createHash('sha256')` is pure computation (no randomness, no wall-clock, no
 * network/file I/O), so the engine stays deterministic and I/O-free.
 */

import { createHash } from 'node:crypto';
import type { MatchState } from './types.ts';

/**
 * Canonical serialization of the authoritative state (A1 §8.2): tick, every
 * unit {id,type,cell,hp} sorted by id, both scores, both remaining allowances,
 * and the corrupted-rings set (sorted). match_id, obstacles (seed-fixed), and
 * events are deliberately excluded — two matches with the same seed + inputs
 * must hash identically regardless of their match_id.
 */
export function canonicalize(s: MatchState): string {
  const units = [...s.units]
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))
    .map((u) => ({ id: u.unitId, type: u.type, cell: [u.x, u.y], hp: u.hp }));
  const rings = [...s.corruptedRings].sort((a, b) => a - b);
  return JSON.stringify({
    tick: s.tick,
    units,
    scores: { A: s.scores.A, B: s.scores.B },
    allowance: { A: s.remaining.A, B: s.remaining.B },
    corrupted_rings: rings,
  });
}

/** `sha256:<hex>` over the canonical serialization of `state` (A1 §8.2). */
export function stateHash(state: MatchState): string {
  const hex = createHash('sha256').update(canonicalize(state), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Fold one tick's state-hash into the running chain (A1 §8.2 "running chain").
 * chain' = sha256(prevChain || ':' || tickHash). Order-sensitive by design.
 */
export function foldHash(prevChain: string, tickHash: string): string {
  const hex = createHash('sha256')
    .update(`${prevChain}:${tickHash}`, 'utf8')
    .digest('hex');
  return `sha256:${hex}`;
}
