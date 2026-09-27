/**
 * Shared test helpers (not a *.test.ts, so the test runner does not execute it).
 * A deterministic "floor" policy (A1 §13) plus a scripted-match driver.
 */

import {
  buildObservation,
  createInitialState,
  foldHash,
  isTerminal,
  resolveTick,
  stateHash,
  type Cell,
  type Dir,
  type MatchState,
  type Player,
  type TickActions,
  type UnitAction,
} from '../src/index.ts';
import type { Observation } from 'wot-contracts';

/** The ~50-line reflex-agent floor policy (A1 §13): attack if able, else greedy step to nearest objective. */
export function floorPolicy(obs: Observation): UnitAction[] {
  const actions: UnitAction[] = [];
  const objectives = obs.objectives.map((o) => o.cell);
  for (const u of obs.you.units) {
    const atk = (obs.attacks?.[u.unit_id] ?? []) as Cell[];
    if (atk.length > 0) {
      actions.push({ unit_id: u.unit_id, verb: 'attack', target: [atk[0][0], atk[0][1]] });
      continue;
    }
    const [ux, uy] = u.cell;
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const c of objectives) {
      const d = Math.abs(c[0] - ux) + Math.abs(c[1] - uy);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || bestD === 0) {
      actions.push({ unit_id: u.unit_id, verb: 'hold' });
      continue;
    }
    const dx = best[0] - ux;
    const dy = best[1] - uy;
    let dir: Dir;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) dir = dx > 0 ? 'E' : 'W';
    else if (dy !== 0) dir = dy > 0 ? 'N' : 'S';
    else dir = dx > 0 ? 'E' : 'W';
    actions.push({ unit_id: u.unit_id, verb: 'move', steps: [dir] });
  }
  return actions;
}

export interface ScriptedMatch {
  inputs: TickActions[];
  hashes: string[];
  replayHash: string;
  finalState: MatchState;
  observations: { A: Observation; B: Observation }[];
  /** Ground-truth authoritative state at each tick (states[i] produced observations[i]). */
  states: MatchState[];
}

const NONCE = 'n_scripted_0000';

/** Drive a full self-play match with the floor policy; deterministic given seed. */
export function runScriptedMatch(seed: number, maxTicks = 130): ScriptedMatch {
  let state = createInitialState(seed);
  let chain = stateHash(state);
  const inputs: TickActions[] = [];
  const hashes: string[] = [];
  const observations: { A: Observation; B: Observation }[] = [];
  const states: MatchState[] = [];

  for (let i = 0; i < maxTicks; i++) {
    // resolveTick returns a fresh state each tick (it never mutates its input),
    // so capturing the pre-resolution reference is a faithful ground-truth snapshot.
    states.push(state);
    const obsA = buildObservation(state, 'A', state.tick, NONCE, 1500, 3000);
    const obsB = buildObservation(state, 'B', state.tick, NONCE, 1500, 3000);
    observations.push({ A: obsA, B: obsB });
    const pair: TickActions = { A: floorPolicy(obsA), B: floorPolicy(obsB) };
    inputs.push(pair);
    state = resolveTick(state, pair);
    const h = stateHash(state);
    hashes.push(h);
    chain = foldHash(chain, h);
    if (isTerminal(state).over) break;
  }

  return { inputs, hashes, replayHash: chain, finalState: state, observations, states };
}

/** Build the tick-20 ground-truth state from the A1 §10 worked example. */
export function workedExampleState(): MatchState {
  const state = createInitialState(2864901733);
  state.tick = 20;
  state.obstacles = [
    [1, 6],
    [7, 2],
    [2, 7],
    [6, 1],
  ];
  state.scores = { A: 44, B: 40 };
  state.remaining = { A: 150, B: 130 };
  state.spent = { A: 90, B: 110 };
  const mk = (unitId: string, owner: Player, type: MatchState['units'][number]['type'], x: number, y: number, hp: number) => ({
    unitId,
    owner,
    type,
    x,
    y,
    hp,
  });
  state.units = [
    mk('A-guard', 'A', 'guard', 4, 4, 10),
    mk('A-archer', 'A', 'archer', 2, 4, 3),
    mk('A-lancer', 'A', 'lancer', 4, 2, 6),
    mk('A-scout', 'A', 'scout', 7, 3, 3),
    mk('B-scout', 'B', 'scout', 6, 4, 3),
    mk('B-lancer', 'B', 'lancer', 5, 7, 6),
    mk('B-archer', 'B', 'archer', 6, 7, 3),
    mk('B-guard', 'B', 'guard', 4, 7, 10),
  ];
  return state;
}
