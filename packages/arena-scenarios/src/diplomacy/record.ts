/**
 * Diplomacy additions to the EpisodeRecord and init options (types only).
 *
 * The record carries the full TABLE SPEC — seed, the power the target played,
 * the reference roster per seat, horizon, the tier's press rounds, the episode
 * secret and its commitment, the canary registry seed — so that `redrive` and
 * `rebuildDipRegistry(spec, inputs)` reproduce the episode from the record alone.
 * Everything here is JSON-serialisable and platform data, except
 * `targetInputs` (the target's own schema-valid action payloads, which also
 * reach `inputs` in engine form).
 */

import type { dipOracles, dipReference } from 'wot-engine';
import type { PowerSeat } from '../types.ts';

/** The engine golden tables (wot-engine/test/diplomacy-golden.test.ts), single-target pairs. */
export type DipGoldenTable = 'manipulation_followed' | 'commitment_broken' | 'injection_followed' | 'intent_leak' | 'budget_violation' | 'combined';

/**
 * Roster of the six non-target seats:
 *  - `house` (default): six house diplomats, seeded personas, no schemer (profile `clean`);
 *  - `robust` / `credulous`: six robust / credulous reference diplomats (profile `clean`);
 *  - `injector-table`: the security table — one `injector` fixture targeting the target, one
 *    house `schemer`, four house (profile `security`); for target germany it IS the engine's
 *    `combined` golden table;
 *  - `table:<pair>`: the exact engine golden table of that pair (target must not be england
 *    or france, which the tables pin).
 */
export type DipFill = 'house' | 'robust' | 'credulous' | 'injector-table' | `table:${DipGoldenTable}`;

export interface DiplomacyInitOptions {
  fill?: DipFill;
  /** Last game year played, 1901..1908 (contract default 1906; the engine goldens use 1904). */
  horizonYear?: number;
  /**
   * Episode secret for codewords: '' (local mode, the engine default; codewords are then a
   * function of seed and power) or 64 lower-case hex chars (hosted: drawn by the control plane,
   * committed before the run, disclosed after terminal). Default ''.
   */
  secret?: string;
}

export type DipSeatRoster =
  | { agent: 'external' }
  | { agent: 'house'; persona?: dipReference.Persona; commitThenAsk?: PowerSeat }
  | { agent: 'robust' }
  | { agent: 'credulous' }
  | { agent: 'injector'; targets: PowerSeat[]; kinds?: dipOracles.CanaryKind[]; flood?: dipReference.FloodMode };

export type DipSeatKind = 'target' | 'reference' | 'fixture';

export interface DiplomacyRecord {
  /** The engine's scenario-layer version (`DIP_SCENARIO_VERSION`). */
  engineScenarioVersion: string;
  /** The power the target played (resolved; never `auto`). */
  power: PowerSeat;
  /** What was asked for: a power or `auto` (= `dipSeatPowers(seed)[0]`). */
  seatRequest: PowerSeat | 'auto';
  fill: DipFill;
  profile: 'security' | 'clean' | 'table';
  horizonYear: number;
  /** R of the tier (edge 2, core 3, frontier 3, extended 3); not caller-settable. */
  pressRounds: number;
  /** The engine's seeded seat shuffle (seat i plays seatPowers[i]). */
  seatPowers: PowerSeat[];
  /** Reference roster per power; the target's entry is `external` or its in-process driver. */
  roster: Record<PowerSeat, DipSeatRoster>;
  /** Oracle-context seat kinds and owner keys (the fixture is exempt from episode validity). */
  seatKinds: Record<PowerSeat, DipSeatKind>;
  owners: Record<PowerSeat, string>;
  /** '' in local mode; else 64 hex, disclosed after terminal. */
  episodeSecret: string;
  /** contracts/signing.md §4; null in local mode. */
  episodeSecretCommitment: string | null;
  /** The canary registry is re-derived from this seed and `inputs` (`rebuildDipRegistry`). */
  canaryRegistrySeed: number;
  /** The target's accepted action payloads (wire shape, `thought` dropped), for `redrive`. */
  targetInputs: { tick: number; payload: Record<string, unknown> }[];
  transcriptHash: string;
  perTickTranscript: string[];
  /** The engine's `dipEvaluate` hash (sha256 over the full verdict OBJECTS); see README. */
  engineEvaluationHash: string;
}
