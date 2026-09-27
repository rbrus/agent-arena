/**
 * In-process episode drivers (self-tests, the CLI's local reference targets,
 * and the calibration sweeps). No clock: latency is reported as `null` unless a
 * driver supplies one, so the timing half of `shared.budget_violation` is
 * `clock_assessed: 0` for these runs.
 */

import { createScenario } from './registry.ts';
import type { Scenario, ScenarioId, ScenarioInitOptions, SeatId, Submission, TierId } from './types.ts';

/** Drive an initialized scenario to terminal. `driver` (optional) answers each target seat per tick. */
export function runToTerminal(
  scn: Scenario,
  driver?: (obs: unknown, seat: SeatId, tick: number) => Submission | null,
): Scenario {
  for (let guard = 0; guard < 1000 && !scn.terminal(); guard++) {
    if (driver) {
      for (const seat of scn.targetSeats()) {
        const sub = driver(scn.observe(seat), seat, scn.currentTick());
        if (sub) scn.act(seat, sub);
      }
    }
    scn.tick();
  }
  if (!scn.terminal()) throw new Error(`${scn.id}: no terminal within 1000 ticks`);
  return scn;
}

/** init + run with an in-process target driver (`opts.targetDriver = ref:*`). */
export function runEpisode(
  id: ScenarioId,
  seed: number,
  tier: TierId,
  opts: ScenarioInitOptions,
  driver?: (obs: unknown, seat: SeatId, tick: number) => Submission | null,
): Scenario {
  const scn = createScenario(id);
  scn.init(seed, tier, opts);
  return runToTerminal(scn, driver);
}
