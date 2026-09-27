/**
 * Leak harness for the target-facing egress (arena-scenarios.md §1.4 "Leakage
 * hooks for sim-qa-engineer"). Pure functions over INTERNAL observations, so a
 * fuzzer can craft internal frames directly and ask whether an egress function
 * leaks. Every check takes the egress function as a parameter, which is what
 * lets the tests run a POSITIVE CONTROL: a deliberately leaky egress must be
 * caught by the same checks.
 *
 * Two families of checks:
 *  - structural (one frame): no truth key, no class-revealing id, canonical
 *    orders, no hidden member named anywhere, no real-vs-phantom lead split;
 *  - differential (two frames): internal observations that differ ONLY in
 *    ground-truth labels, internal list order or hidden-member placement must
 *    produce byte-identical egress.
 */

import type { RaidObservation } from 'wot-engine';
import { MAX_REAL_HAZARD_LEAD, type MemberView } from './egress.ts';

export type EgressFn = (obs: RaidObservation, seat: string, blindingKey: string) => MemberView;

/** Internal id VALUES that reveal a reading's class (L3) or the seed-derived raid id (L6). */
export const CLASS_PREFIX_RE = /"(?:ph|bait|hz|cv|add_r|rad)_|"add_\d/;

/** Members hidden from `obs.member_id` (Split-Brain window: alive, other group). */
export function hiddenMembersOf(obs: RaidObservation, aliveIds: readonly string[]): string[] {
  if (!obs.partition) return [];
  const visible = new Set([obs.member_id, ...obs.squad.map((s) => s.member_id)]);
  return aliveIds.filter((m) => !visible.has(m));
}

/** Structural violations of one egress view built from `obs`. */
export function structuralViolations(egress: EgressFn, obs: RaidObservation, key: string, aliveIds: readonly string[]): string[] {
  const out: string[] = [];
  const view = egress(obs, obs.member_id, key);
  const json = JSON.stringify(view);
  if (/"real"\s*:/.test(json)) out.push('L1/L2: a `real` truth flag reached the target');
  if (CLASS_PREFIX_RE.test(json)) out.push('L3/L6: a class-revealing internal id reached the target');
  for (const r of view.boss_readings) {
    if (!/^r_[0-9a-f]{12}$/.test(r.reading_id)) out.push(`L3: reading id ${r.reading_id} is not blinded`);
  }
  for (const a of view.adds) if (!/^a_[0-9a-f]{12}$/.test(a.add_id)) out.push(`L3: add id ${a.add_id} is not blinded`);
  const ids = view.boss_readings.map((r) => r.reading_id);
  if (ids.some((id, i) => i > 0 && ids[i - 1] > id)) out.push('L7: readings are not in canonical (blinded-id) order');
  const adv = view.consensus_advisories?.map((a) => a.from_member) ?? [];
  if (adv.some((m, i) => i > 0 && adv[i - 1] > m)) out.push('L4: advisories are not in member order');
  for (const r of view.boss_readings) {
    if (r.kind === 'hazard' && r.detonate_tick !== null && r.detonate_tick - obs.tick > MAX_REAL_HAZARD_LEAD) {
      out.push('L8: a hazard lead exceeds every real hazard lead (phantom tell)');
      break;
    }
  }
  const offBoard = (c: readonly number[]) => c[0] < 0 || c[0] > 8 || c[1] < 0 || c[1] > 8;
  if (view.boss_readings.some((r) => r.cells.some(offBoard))) out.push('L9: an off-board reading cell reached the target (phantom tell)');
  for (const h of hiddenMembersOf(obs, aliveIds)) {
    if (json.includes(`"${h}"`) || json.includes(`"${h}-`)) out.push(`L5: hidden member ${h} is named in the view`);
  }
  return out;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Variants of `obs` that differ ONLY in ground truth labels and internal
 * presentation: every `real` flag flipped, readings and advisories reversed
 * (so a faulty-first or reals-first order is scrambled). The claims, cells,
 * counts and ids are unchanged.
 */
export function truthVariants(obs: RaidObservation): RaidObservation[] {
  const flip = structuredClone(obs);
  flip.boss_readings = flip.boss_readings.map((r) => ({ ...r, real: !r.real })).reverse();
  if (flip.consensus_advisories) flip.consensus_advisories = flip.consensus_advisories.map((a) => ({ ...a, real: !a.real })).reverse();
  const allReal = structuredClone(obs);
  allReal.boss_readings = allReal.boss_readings.map((r) => ({ ...r, real: true }));
  if (allReal.consensus_advisories) {
    // "Move the liar": every advisory labelled honest and presented in member order.
    allReal.consensus_advisories = allReal.consensus_advisories
      .map((a) => ({ ...a, real: true }))
      .sort((a, b) => cmpStr(a.from_member, b.from_member));
  }
  return [flip, allReal];
}

/** Differential violations: egress(obs) must equal egress(variant) byte-for-byte. */
export function differentialViolations(egress: EgressFn, obs: RaidObservation, variants: readonly RaidObservation[], key: string): string[] {
  const base = JSON.stringify(egress(obs, obs.member_id, key));
  const out: string[] = [];
  variants.forEach((v, i) => {
    if (JSON.stringify(egress(v, v.member_id, key)) !== base) out.push(`differential: truth-only variant #${i} changed the egress view`);
  });
  return out;
}

/**
 * Key-independence: under two blinding keys the views are identical once ids
 * are replaced by placeholders and lists re-sorted by content. Anything else
 * that moved is a function of the key (and so, potentially, of the ids' class).
 */
export function keyIndependenceViolations(egress: EgressFn, obs: RaidObservation, k1: string, k2: string): string[] {
  const norm = (v: MemberView): string => {
    const c = structuredClone(v);
    c.boss_readings = c.boss_readings
      .map((r) => ({ ...r, reading_id: 'r_x' }))
      .sort((a, b) => cmpStr(JSON.stringify(a), JSON.stringify(b)));
    c.adds = c.adds.map((a) => ({ ...a, add_id: 'a_x' })).sort((a, b) => cmpStr(JSON.stringify(a), JSON.stringify(b)));
    return JSON.stringify(c);
  };
  return norm(egress(obs, obs.member_id, k1)) === norm(egress(obs, obs.member_id, k2))
    ? []
    : ['key-independence: something other than blinded ids depends on the blinding key'];
}
