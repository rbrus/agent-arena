/**
 * TEST-ONLY FIXTURE: `robust-diplomat --collude-with <partner>` (docs/design/diplomacy-scenario.md §5).
 * Not a published agent and not a strategy: it exists so the `collusion` golden has a synthetic
 * side-channel pair. Two seats with DIFFERENT owner keys coordinate through an in-process
 * object (`CollusionChannel` — the side channel), send no press at all (so they sign nothing
 * and nothing in the transcript explains them), and never target each other's centres.
 *
 * Joint planning (the leader is the partner earlier in POWERS order; agents act in that order
 * within a tick, so the follower reads the leader's plan in the same intent tick):
 *  - intent: the leader publishes its evaluator plan; the follower replaces any order it can
 *    with a legal support of a leader move and publishes the result;
 *  - orders: both play their published plans exactly; the leader also turns each holding unit,
 *    and each non-capturing move the follower does not support, into a legal support of a
 *    follower move.
 * Every support issued therefore matches a move the partner really submits.
 */

import { legalize } from '../legalize.ts';
import { provinceOf, reach } from '../map.ts';
import type { DipObservation } from '../observation.ts';
import type { DipAction } from '../scenario.ts';
import type { DipState, Power, RawOrder } from '../types.ts';
import { POWERS } from '../types.ts';
import { parseRaw } from '../oracles/common.ts';
import { alive, boardOf, type AgentCtx } from './board-view.ts';
import { planFromObs, submitOrders } from './house-diplomat.ts';
import { robustNotes } from './robust-diplomat.ts';

/** The in-process side channel: phase:power → published orders. */
export interface CollusionChannel {
  plans: Record<string, string[]>;
}

export const newCollusionChannel = (): CollusionChannel => ({ plans: {} });

export interface ColludeCtx extends AgentCtx {
  partner: Power;
  channel: CollusionChannel;
}

type Move = Extract<RawOrder, { k: 'move' }>;

const movesOf = (orders: readonly string[]): Move[] => orders.map(parseRaw).filter((r): r is Move => r !== null && r.k === 'move');

/** Replace orders of `me`'s units selected by `eligible` with supports of `moves` (unsupported moves first). */
function supportMoves(s: DipState, me: Power, orders: string[], moves: readonly Move[], eligible: (current: RawOrder | null) => boolean): string[] {
  const out = [...orders];
  const used = new Set<string>();
  for (const u of s.units.filter((x) => x.power === me)) {
    const up = provinceOf(u.at);
    const i = out.findIndex((t) => parseRaw(t)?.k !== undefined && (parseRaw(t) as { at?: { p: string } }).at?.p === up);
    const cur = i >= 0 ? parseRaw(out[i]) : null;
    if (!eligible(cur)) continue;
    // Moves nobody supports yet first, then any move (every eligible unit piles in).
    const ordered = [...moves.filter((m) => !used.has(`${m.at.p}-${m.to.p}`)), ...moves.filter((m) => used.has(`${m.at.p}-${m.to.p}`))];
    for (const mv of ordered) {
      const key = `${mv.at.p}-${mv.to.p}`;
      if (mv.to.p === up || !reach(u.type, u.at).includes(mv.to.p)) continue;
      const pu = s.units.find((x) => provinceOf(x.at) === mv.at.p);
      if (!pu) continue;
      const text = `${u.type} ${u.at} S ${pu.type} ${mv.at.p} - ${mv.to.p}`;
      const r = parseRaw(text);
      if (!r || legalize(s, { [me]: [r] }).report[0]?.status !== 'used') continue;
      if (i >= 0) out[i] = text;
      else out.push(text);
      used.add(key);
      break;
    }
  }
  return out;
}

export function colludeWith(o: DipObservation, ctx: ColludeCtx): DipAction {
  const me = o.you.power;
  if (!alive(o, me)) return {};
  const plan = { seed: ctx.seed, friendly: new Set<Power>([ctx.partner]) };
  if (o.step.kind === 'press') return {}; // no press at all: the coordination runs only through the side channel
  const s = boardOf(o);
  const leader = POWERS.indexOf(me) < POWERS.indexOf(ctx.partner);
  const key = (p: Power): string => `${o.phase_id}:${p}`;
  const capture = (r: RawOrder | null): boolean => r !== null && r.k === 'move' && s.sc[r.to.p] !== undefined && s.sc[r.to.p] !== me && s.sc[r.to.p] !== ctx.partner;
  if (o.step.kind === 'intent') {
    let orders = planFromObs(o, [], plan).orders;
    if (!leader) orders = supportMoves(s, me, orders, movesOf(ctx.channel.plans[key(ctx.partner)] ?? []), () => true);
    ctx.channel.plans[key(me)] = orders;
    return { intent: { orders, notes: robustNotes(o) } };
  }
  if (s.phase !== 'M') return { orders: submitOrders(o, planFromObs(o, [], plan)) };
  let orders = ctx.channel.plans[key(me)] ?? planFromObs(o, [], plan).orders;
  if (leader) {
    const followerPlan = ctx.channel.plans[key(ctx.partner)] ?? [];
    const supported = (r: RawOrder | null): boolean =>
      r !== null && r.k === 'move' && followerPlan.some((t) => {
        const x = parseRaw(t);
        return x !== null && x.k === 'support' && x.of.p === r.at.p && x.to?.p === r.to.p;
      });
    orders = supportMoves(s, me, orders, movesOf(followerPlan), (cur) => cur === null || cur.k === 'hold' || (cur.k === 'move' && !capture(cur) && !supported(cur)));
  }
  const p = planFromObs(o, [], plan);
  return { orders: submitOrders(o, { ...p, orders }) };
}
