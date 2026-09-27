import { SCENARIO_IDS, scenarioModule } from 'arena-scenarios';
import { DIP_IN_PROCESS } from '../diplomacy.ts';
import { referenceNames } from '../reference/policy.ts';
import { DIP_SERVED_POLICIES } from '../reference/diplomacy.ts';
import { EXIT_CODES, type ExitCode } from '../report.ts';
import { CLI_SCENARIOS } from '../rerun.ts';
import { isJson, out, outJson } from '../ui.ts';

/**
 * Every scenario the engine registers. diplomacy_standard (power seating) is
 * listed with its reference pair, its fixture, the table fills `--fill` takes,
 * the in-process targets and the policies `serve-reference` serves. A scenario
 * whose descriptor this build does not understand is listed from what it does
 * carry, never a crash.
 */
export function listScenariosCommand(): ExitCode {
  const refs = referenceNames();
  const rows = SCENARIO_IDS.map((id) => {
    const d = scenarioModule(id).describe();
    const described = d.references as { pass?: string; fail?: string; fixtures?: string[]; fills?: string[] } | undefined;
    const pair = refs[id] ?? (described?.pass && described.fail ? { coordinated: described.pass, naive: described.fail } : null);
    const power = (d.modes ?? []).includes('power');
    return {
      scenario_id: id,
      version: d.version,
      seats: [...(d.modes ?? [])],
      runnable: CLI_SCENARIOS.includes(id),
      primary_oracle: d.oracles?.find((o) => o.primary)?.oracleId ?? null,
      oracles: (d.oracles ?? []).map((o) => o.oracleId),
      reference_pair: pair,
      ...(described?.fixtures?.length ? { reference_fixtures: [...described.fixtures] } : {}),
      ...(described?.fills?.length ? { fills: [...described.fills] } : {}),
      ...(power ? { in_process_targets: Object.keys(DIP_IN_PROCESS), serve_policies: [...DIP_SERVED_POLICIES] } : {}),
      capability: d.capability,
    };
  });
  if (isJson()) {
    outJson({ scenarios: rows });
    return EXIT_CODES.ok;
  }
  for (const r of rows) {
    out(`${r.scenario_id.padEnd(18)} v${r.version}  seatings: ${r.seats.join('|').padEnd(13)} primary: ${r.primary_oracle ?? '-'}`);
    out(`${' '.repeat(20)}${r.capability}`);
    out(`${' '.repeat(20)}${r.reference_pair ? `reference pair: ${r.reference_pair.coordinated} (passes) / ${r.reference_pair.naive} (fails)` : 'reference pair: none'}${r.runnable ? '' : '  [not runnable from this CLI version yet]'}`);
    if (r.fills) out(`${' '.repeat(20)}--seat <power>|auto  --fill ${r.fills.join(' | ')}  --horizon 1901..1908 (default 1906)`);
  }
  return EXIT_CODES.ok;
}
