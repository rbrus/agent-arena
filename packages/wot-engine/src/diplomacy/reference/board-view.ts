/**
 * Shared helpers for the scripted reference agents (docs/design/diplomacy-scenario.md §4).
 * Everything here reads a `DipObservation` (never the episode) or pure map data.
 * Randomness is `hmix(seed:power:tick:purpose)` (hash32 + fmix32) only: no RNG state to drift.
 */

import { hash32 } from '../../rng.ts';
import { armyNeighbours, ascii, fleetNeighbours, province, provinceIndex, provinceOf, reach } from '../map.ts';
import type { DipObservation, ObsCommitment } from '../observation.ts';
import { finalMovementIndex, movementIndex, movementPhaseAt, type Clause } from '../press.ts';
import type { DipState, NodeId, PhaseId, Power, ProvinceId, Unit } from '../types.ts';
import { stateFromObservation } from '../testing/scripted-press.ts';
import { POWERS } from '../types.ts';

export type { Clause };

/** Per-seat context every reference agent receives next to its observation. */
export interface AgentCtx {
  /** Episode seed (reference agents are pure functions of seed, power and observations). */
  seed: number;
}

/**
 * murmur3 `fmix32` avalanche over `hash32(s)`. FNV-1a's low bits depend only on the low bits
 * of the input characters, so `hash32(s) % n` for small n barely moves with the seed digits
 * (measured: 4 distinct persona rosters in 200 seeds). Every choice a reference agent derives
 * from a hash goes through this. Integer arithmetic only.
 */
export function hmix(s: string): number {
  let h = hash32(s);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic choice value: `hmix(seed:power:tick:purpose)`. */
export function h32(seed: number, power: Power, tick: number, purpose: string): number {
  return hmix(`${seed >>> 0}:${power}:${tick}:${purpose}`);
}

/** The public board as a `DipState` (all of it is public in Diplomacy): the engine's own rebuild. */
export const boardOf = (o: DipObservation): DipState => stateFromObservation(o);

export const alive = (o: DipObservation, p: Power): boolean => o.board.unit_counts[p] + o.board.sc_counts[p] > 0;

export const unitAt = (s: DipState, p: ProvinceId): Unit | undefined => s.units.find((u) => provinceOf(u.at) === p);

/** Provinces (one step) a unit can move into; armies never to sea. Node ids for fleets. */
export function moveTargets(u: Unit): NodeId[] {
  if (u.type === 'A') return armyNeighbours(provinceOf(u.at)).filter((p) => province(p).kind !== 'sea');
  return [...fleetNeighbours(u.at)];
}

/** Powers with a unit that can reach one of `me`'s units' or centres' provinces, or vice versa. */
export function neighboursOf(s: DipState, me: Power): Power[] {
  const mine = new Set<ProvinceId>();
  for (const u of s.units) if (u.power === me) mine.add(provinceOf(u.at));
  for (const p of Object.keys(s.sc)) if (s.sc[p] === me) mine.add(p);
  const myReach = new Set<ProvinceId>();
  for (const u of s.units) if (u.power === me) for (const p of reach(u.type, u.at)) myReach.add(p);
  const out: Power[] = [];
  for (const q of POWERS) {
    if (q === me) continue;
    const theirs = s.units.filter((u) => u.power === q);
    const touches =
      theirs.some((u) => reach(u.type, u.at).some((p) => mine.has(p) || myReach.has(p))) ||
      Object.keys(s.sc).some((p) => s.sc[p] === q && myReach.has(p));
    if (touches) out.push(q);
  }
  return out;
}

/**
 * The shared border of two powers: provinces both can reach in one step, plus
 * each side's own provinces (centres or occupied) the other can reach. Sorted
 * by map order. Used for mutual `no_enter` offers (a DMZ).
 */
export function border(s: DipState, a: Power, b: Power): ProvinceId[] {
  const reachOf = (p: Power): Set<ProvinceId> => {
    const r = new Set<ProvinceId>();
    for (const u of s.units) if (u.power === p) for (const x of reach(u.type, u.at)) r.add(x);
    return r;
  };
  const owned = (p: Power): Set<ProvinceId> => {
    const r = new Set<ProvinceId>();
    for (const u of s.units) if (u.power === p) r.add(provinceOf(u.at));
    for (const x of Object.keys(s.sc)) if (s.sc[x] === p) r.add(x);
    return r;
  };
  const ra = reachOf(a);
  const rb = reachOf(b);
  const oa = owned(a);
  const ob = owned(b);
  const out = new Set<ProvinceId>();
  for (const p of ra) if (rb.has(p) && !oa.has(p) && !ob.has(p)) out.add(p);
  for (const p of oa) if (rb.has(p)) out.add(p);
  for (const p of ob) if (ra.has(p)) out.add(p);
  return [...out].sort((x, y) => provinceIndex(x) - provinceIndex(y));
}

/** Provinces `owner` holds (centres or units). */
export function holdings(s: DipState, owner: Power): Set<ProvinceId> {
  const r = new Set<ProvinceId>();
  for (const u of s.units) if (u.power === owner) r.add(provinceOf(u.at));
  for (const x of Object.keys(s.sc)) if (s.sc[x] === owner) r.add(x);
  return r;
}

export const nextMovementPhase = (ph: PhaseId): PhaseId => movementPhaseAt(movementIndex(ph)! + 1);

/**
 * End of a two-phase truce starting at `ph` (this phase and the next), clamped to the game's
 * last movement phase F<finalYear>M (F-1, wot-dip-scenario/2: the engine rejects a clause
 * past it as `clause_beyond_horizon`). Without `finalYear`, unclamped (planning-only callers).
 */
export const truceEnd = (ph: PhaseId, finalYear?: number): PhaseId =>
  finalYear === undefined ? nextMovementPhase(ph) : movementPhaseAt(Math.min(movementIndex(ph)! + 1, finalMovementIndex(finalYear)));

/** Does movement phase `ph` fall inside clause `c`'s coverage? */
export function clauseCovers(c: Clause, ph: PhaseId): boolean {
  const i = movementIndex(ph);
  if (i === null) return false;
  if (c.kind === 'order') return c.phase === ph;
  return i >= movementIndex(c.from)! && i <= movementIndex(c.to)!;
}

/** `prs:<phase>:r<n>:<ABBR>:<seq>` → phase and round (engine id form). */
export function msgPhaseRound(id: string): { phase: PhaseId; round: number } | null {
  const m = /^prs:([SF]\d{4}M):r(\d+):/.exec(id);
  return m ? { phase: m[1], round: Number(m[2]) } : null;
}

/**
 * The clauses `me` must honour in movement phase `ph`, from its own view of its
 * commitments (§1.5): escrowed for `ph`, not released by a renounce with notice
 * (delivered by round R−1 of a phase ≤ ph) and not released by the counterparty
 * breaking in an earlier phase.
 */
export function bindingClauses(o: DipObservation, me: Power, ph: PhaseId): Clause[] {
  const idx = movementIndex(ph);
  if (idx === null) return [];
  const R = o.limits.press_rounds || 3;
  const out: Clause[] = [];
  for (const c of o.commitments) {
    if (releasedFrom(c, R) <= idx) continue;
    const peer = c.parties[0] === me ? c.parties[1] : c.parties[0];
    let brokeAt: number | null = null;
    for (const cl of c.clauses) {
      if (cl.obligor !== peer) continue;
      for (const s of cl.settlements) if (s.status === 'broken') brokeAt = Math.min(brokeAt ?? 1e9, movementIndex(s.phase)!);
    }
    if (brokeAt !== null && idx > brokeAt) continue;
    for (const cl of c.clauses) {
      if (cl.obligor !== me || !clauseCovers(cl.clause, ph)) continue;
      if (cl.settlements.some((s) => s.phase === ph)) continue;
      out.push(cl.clause);
    }
  }
  return out;
}

/** First movement index released by the commitment's renounce (∞ if none). */
export function releasedFrom(c: ObsCommitment, rounds: number): number {
  if (!c.renounced) return Number.MAX_SAFE_INTEGER;
  const pr = msgPhaseRound(c.renounced.msg_id);
  if (!pr) return Number.MAX_SAFE_INTEGER;
  const cur = movementIndex(pr.phase)!;
  return pr.round <= rounds - 1 ? cur : cur + 1;
}

/** A commitment still has an unsettled, unreleased clause for `ph` or later. */
export function isActive(c: ObsCommitment, ph: PhaseId, rounds: number): boolean {
  const idx = movementIndex(ph);
  if (idx === null) return false;
  if (releasedFrom(c, rounds) <= idx) return false;
  return c.clauses.some((cl) => cl.status === 'escrowed' && cl.clause && lastIndex(cl.clause) >= idx);
}

export function lastIndex(c: Clause): number {
  return c.kind === 'order' ? movementIndex(c.phase)! : movementIndex(c.to)!;
}

/**
 * Powers `me` will not deal with (§4.1): a power that renounced, or broke a
 * clause of, a commitment with `me` in the last 4 movement windows.
 */
export function distrusted(o: DipObservation, me: Power): Set<Power> {
  const idx = movementIndex(o.phase_id) ?? 0;
  const out = new Set<Power>();
  for (const c of o.commitments) {
    const peer = c.parties[0] === me ? c.parties[1] : c.parties[0];
    if (c.renounced && c.renounced.by === peer) {
      const pr = msgPhaseRound(c.renounced.msg_id);
      if (pr && idx - movementIndex(pr.phase)! <= 4) out.add(peer);
    }
    for (const cl of c.clauses) {
      if (cl.obligor !== peer) continue;
      for (const s of cl.settlements) if (s.status === 'broken' && idx - movementIndex(s.phase)! <= 4) out.add(peer);
    }
  }
  return out;
}

export const sortPowers = (ps: Iterable<Power>): Power[] => [...ps].sort((a, b) => POWERS.indexOf(a) - POWERS.indexOf(b));
export const byMap = (a: ProvinceId, b: ProvinceId): number => provinceIndex(a) - provinceIndex(b) || ascii(a, b);
