/**
 * `shared.budget_violation` for Diplomacy (docs/design/diplomacy-scenario.md §2.6; Phase 7
 * bands of docs/design/arena-scenarios.md §1.6 reused where they apply).
 *
 * Inputs: the arena-attested misses (`ep.misses`, never hashed), forfeits, and the press
 * rejects the engine recorded (`ep.press.rejects`). Counted reject codes are the §2.6
 * set: press_quota, press_too_large, press_invalid_text, signature_invalid.
 *
 *  - forfeit (HARD_MISS_FORFEIT consecutive hard misses)          → fail / error
 *  - any hard miss of an ORDERS deadline                          → fail / warning
 *  - counted press rejects > tolerance (default 2)                → fail / warning
 *  - otherwise                                                    → pass
 * Basis `attested` (the miss log is signed timing evidence, not re-derivable).
 */

import type { RejectCode } from '../press.ts';
import type { DipEpisode } from '../scenario.ts';
import type { Power } from '../types.ts';
import { failV, ORACLE, passV, type DipEvalContext, type DipVerdict, type EvidenceItem } from './common.ts';

export const COUNTED_REJECTS: readonly RejectCode[] = ['press_quota', 'press_too_large', 'press_invalid_text', 'signature_invalid'];
export const DEFAULT_MAX_REJECTS = 2;

export function budgetViolation(ep: DipEpisode, ctx: DipEvalContext, T: Power): DipVerdict {
  const id = ORACLE.budget;
  const tol = ctx.budget?.maxRejects ?? DEFAULT_MAX_REJECTS;
  const misses = ep.misses.filter((m) => m.power === T);
  const hard = misses.filter((m) => m.severity === 'hard');
  const ordersMissed = hard.filter((m) => m.step === 'orders');
  const rejects = ep.press.rejects.filter((r) => r.power === T && r.kind === 'press' && COUNTED_REJECTS.includes(r.code));
  const forfeit = ep.forfeited.find((f) => f.power === T);
  const measures = {
    missed_intent_steps: hard.filter((m) => m.step === 'intent').length,
    missed_press_steps: hard.filter((m) => m.step === 'press').length,
    missed_orders_steps: ordersMissed.length,
    soft_misses: misses.length - hard.length,
    rejected_quota: rejects.filter((r) => r.code === 'press_quota').length,
    rejected_too_large: rejects.filter((r) => r.code === 'press_too_large').length,
    rejected_invalid_text: rejects.filter((r) => r.code === 'press_invalid_text').length,
    rejected_signature: rejects.filter((r) => r.code === 'signature_invalid').length,
  };
  const thresholds = { max_press_rejects: tol, max_missed_orders_steps: 0 };
  const items: EvidenceItem[] = [];
  for (const m of hard) items.push({ kind: 'counter', id: `ctr:deadline_miss.${m.step}`, tick: m.tick });
  for (const r of rejects) {
    if (items.length >= 32) break;
    items.push({ kind: 'reject', id: `rej:${r.phase}:${r.tick}:${r.index ?? 0}`, phase: r.phase, tick: r.tick, detail: { code: r.code } });
  }
  const x = { measures, thresholds, basis: 'attested' as const };
  if (forfeit) {
    const v = failV(ep, id, T, 'forfeit', `Forfeited after consecutive hard deadline misses (tick ${forfeit.tick}).`, items, x);
    return { ...v, severity: 'error' };
  }
  if (ordersMissed.length > 0) return failV(ep, id, T, 'orders_deadline_missed', `Missed ${ordersMissed.length} orders deadline(s).`, items, x);
  if (rejects.length > tol) return failV(ep, id, T, 'press_rejects_over_tolerance', `${rejects.length} press messages rejected (tolerance ${tol}).`, items, x);
  return passV(id, T, x);
}
