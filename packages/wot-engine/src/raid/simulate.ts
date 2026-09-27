/**
 * Raid simulation + re-simulation (raids-v1 §8). `runRaid` drives a squad policy
 * against a boss and records the per-tick action sets; `resimulateRaid` replays
 * those recorded actions and reproduces every state hash bit-for-bit — the C1
 * determinism assertion. Nothing but `(seed, per-tick squad action sets)` is
 * needed; the boss action, phantoms, and observations are all re-derivable.
 */

import { foldHash, raidStateHash } from './hash.ts';
import { buildRaidObservation, type RaidObservation } from './observation.ts';
import { resolveRaidTick } from './resolve.ts';
import { createInitialRaidState, type CreateRaidStateOptions } from './state.ts';
import { isRaidTerminal } from './terminal.ts';
import type { BossId, RaidState, RaidTerminal, RaidTickActions, SquadSpec } from './types.ts';
import type { RaidSquadPolicy } from './reference-agents.ts';

export interface RaidRunResult {
  finalState: RaidState;
  perTickHashes: string[];
  replayHash: string;
  terminal: RaidTerminal;
  /** The recorded per-tick squad action sets (the replay input). */
  inputs: RaidTickActions[];
  ticks: number;
}

/**
 * The C1 gate helper: run `bossId` against `squad` on `seed` (reference comp),
 * returning the full result (outcome, ticks, replay_hash, per-tick chain, inputs).
 * One call → one golden anchor; `runBossWithSquad(b, coord, S) .terminal.outcome`
 * is `clear`, `runBossWithSquad(b, naive, S)` is `wipe`, and their `replayHash`
 * differ (the "lesson is real" regression). Thin wrapper over `runRaid`.
 */
export function runBossWithSquad(
  bossId: BossId,
  squad: RaidSquadPolicy,
  seed: number,
  spec?: SquadSpec,
  opts: CreateRaidStateOptions & { phantomSalt?: number; maxTicks?: number } = {},
): RaidRunResult {
  return runRaid(seed, bossId, squad, spec, opts);
}

/** Run a raid from `seed` driving `policy`, recording each tick's action sets. */
export function runRaid(
  seed: number,
  bossId: BossId,
  policy: RaidSquadPolicy,
  spec?: SquadSpec,
  opts: CreateRaidStateOptions & { phantomSalt?: number; maxTicks?: number } = {},
): RaidRunResult {
  let state = createInitialRaidState(seed, bossId, spec, opts);
  let chain = raidStateHash(state);
  const perTickHashes: string[] = [];
  const inputs: RaidTickActions[] = [];
  const maxTicks = opts.maxTicks ?? state.config.tickCap;

  for (let i = 0; i < maxTicks; i++) {
    const observations: RaidObservation[] = state.members.map((m) =>
      buildRaidObservation(state, m, { phantomSalt: opts.phantomSalt ?? 0 }),
    );
    const actions = policy(observations);
    inputs.push(actions);
    state = resolveRaidTick(state, actions);
    const h = raidStateHash(state);
    perTickHashes.push(h);
    chain = foldHash(chain, h);
    if (isRaidTerminal(state).over) break;
  }

  return {
    finalState: state,
    perTickHashes,
    replayHash: chain,
    terminal: isRaidTerminal(state),
    inputs,
    ticks: state.tick,
  };
}

export interface RaidResimResult {
  finalState: RaidState;
  perTickHashes: string[];
  replayHash: string;
  terminal: RaidTerminal;
}

/** Re-simulate a raid from `(seed, inputs)`. Reproduces every hash bit-for-bit. */
export function resimulateRaid(
  seed: number,
  bossId: BossId,
  inputs: RaidTickActions[],
  spec?: SquadSpec,
  opts: CreateRaidStateOptions = {},
): RaidResimResult {
  let state = createInitialRaidState(seed, bossId, spec, opts);
  let chain = raidStateHash(state);
  const perTickHashes: string[] = [];
  for (const actions of inputs) {
    state = resolveRaidTick(state, actions);
    const h = raidStateHash(state);
    perTickHashes.push(h);
    chain = foldHash(chain, h);
    if (isRaidTerminal(state).over) break;
  }
  return { finalState: state, perTickHashes, replayHash: chain, terminal: isRaidTerminal(state) };
}
