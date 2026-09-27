/**
 * Canonical serialisation, state hash, orders digest and the replay chain
 * (design §4.3, §4.4). Same discipline as the Grid Tactics engine: `sha256:<hex>`
 * over a JSON string whose key order is fixed by construction, folded with the
 * shared `foldHash` (re-used, not re-implemented).
 *
 * What enters the chain: the genesis (ruleset, map digest, seats, horizon), the
 * initial state, and for every adjudicated phase the SETTLED orders digest and
 * the resulting state hash. Press, plans and parse-rejected text never do:
 * nothing in this file accepts them.
 */

import { createHash } from 'node:crypto';
import { foldHash } from '../hash.ts';
import { ascii, MAP_DIGEST, provinceOf } from './map.ts';
import { formatRaw } from './orders.ts';
import type { DipState, PhaseId, Power, Submissions } from './types.ts';
import { POWERS } from './types.ts';

const sha = (s: string): string => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

export function canonicalizeDip(s: DipState): string {
  const units = [...s.units]
    .sort((a, b) => ascii(provinceOf(a.at), provinceOf(b.at)))
    .map((u) => [u.at, u.type, u.power]);
  const dislodged = [...s.dislodged]
    .sort((a, b) => ascii(provinceOf(a.unit.at), provinceOf(b.unit.at)))
    .map((d) => [d.unit.at, d.unit.type, d.unit.power, d.attackerFrom, d.byConvoy ? 1 : 0, [...d.options].sort(ascii)]);
  const supply_centers = Object.keys(s.sc)
    .sort(ascii)
    .map((p) => [p, s.sc[p]]);
  return JSON.stringify({
    ruleset: s.ruleset,
    year: s.year,
    season: s.season,
    phase: s.phase,
    units,
    dislodged,
    supply_centers,
  });
}

export function stateHash(s: DipState): string {
  return sha(canonicalizeDip(s));
}

/** Commits to each power's settled (parseable) orders, in submission order. */
export function ordersDigest(phase: PhaseId, subs: Submissions): string {
  return sha(JSON.stringify({ phase, orders: POWERS.map((p) => [p, (subs[p] ?? []).map(formatRaw)]) }));
}

export interface Genesis {
  ruleset: DipState['ruleset'];
  seats: readonly Power[];
  horizonYear: number;
}

export function genesisHash(g: Genesis): string {
  return sha(JSON.stringify({ ruleset: g.ruleset, map: MAP_DIGEST, seats: [...g.seats], horizon_year: g.horizonYear }));
}

/** chain_0 = foldHash(genesis, stateHash(initial)). */
export function chainStart(g: Genesis, initial: DipState): string {
  return foldHash(genesisHash(g), stateHash(initial));
}

/** chain_k = foldHash(foldHash(chain_{k-1}, od_k), stateHash(next_k)). */
export function chainStep(prev: string, phase: PhaseId, subs: Submissions, next: DipState): string {
  return foldHash(foldHash(prev, ordersDigest(phase, subs)), stateHash(next));
}
