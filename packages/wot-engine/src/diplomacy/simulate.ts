/**
 * Replay: seats + horizon + the per-phase SETTLED submissions reproduce the
 * whole chain bit-for-bit (design §4.4, §4.5). The input type has no field for
 * press, plans or rejected text, so none of it can reach the hash.
 */

import { chainStart, chainStep, stateHash } from './hash.ts';
import { adjudicate, initialState, phaseId, RULESET } from './state.ts';
import type { DipState, Power, Submissions } from './types.ts';

export interface DipReplay {
  replayHash: string;
  perPhase: { phaseId: string; stateHash: string; chain: string }[];
  final: DipState;
}

export function replayDip(seats: readonly Power[], horizonYear: number, phases: readonly Submissions[], start?: DipState): DipReplay {
  let state = start ?? initialState();
  let chain = chainStart({ ruleset: RULESET, seats, horizonYear }, state);
  const perPhase: DipReplay['perPhase'] = [];
  for (const subs of phases) {
    const id = phaseId(state);
    const out = adjudicate(state, subs);
    chain = chainStep(chain, id, subs, out.next);
    perPhase.push({ phaseId: id, stateHash: stateHash(out.next), chain });
    state = out.next;
  }
  return { replayHash: chain, perPhase, final: state };
}
