/**
 * Batch re-simulation (A1 §8.4): re-run the tick function from seed + the
 * recorded per-tick action pairs and reproduce every state hash bit-for-bit.
 * Used by the arena's match-end self-check and by the determinism test.
 */

import { foldHash, stateHash } from './hash.ts';
import { resolveTick } from './resolve.ts';
import { createInitialState, type CreateInitialStateOptions } from './state.ts';
import { isTerminal } from './terminal.ts';
import type { EngineEvent, MatchState, TerminalResult, TickActions } from './types.ts';

export interface ResimResult {
  finalState: MatchState;
  /** stateHash after each resolved tick (bit-for-bit determinism target). */
  perTickHashes: string[];
  /** The committed replay_hash: the running chain over the per-tick hashes. */
  replayHash: string;
  terminal: TerminalResult;
  /** Concatenated engine events across all ticks (the replay tick log). */
  tickLog: EngineEvent[];
}

/**
 * Re-simulate a full match from `seed` + `inputs` (the stored replay). The
 * running hash chain starts from the initial (tick-0) state hash and folds in
 * each resolved tick's hash — identical to the arena's live incremental chain.
 */
export function resimulate(
  seed: number,
  inputs: TickActions[],
  opts: CreateInitialStateOptions = {},
): ResimResult {
  let state = createInitialState(seed, opts);
  let chain = stateHash(state);
  const perTickHashes: string[] = [];
  const tickLog: EngineEvent[] = [];

  for (const pair of inputs) {
    state = resolveTick(state, pair);
    const h = stateHash(state);
    perTickHashes.push(h);
    chain = foldHash(chain, h);
    tickLog.push(...state.events);
    if (isTerminal(state).over) break;
  }

  return {
    finalState: state,
    perTickHashes,
    replayHash: chain,
    terminal: isTerminal(state),
    tickLog,
  };
}
