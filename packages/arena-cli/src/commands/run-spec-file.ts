/**
 * `agent-arena run --spec <run.json>`: the whole RunSpec from a file (contracts
 * run_spec.schema.json; contracts/README.md "local CLI: run --spec run.json").
 *
 * The file is read with the hostile-file refusals (no symlink, regular file, size
 * cap, bounded structure), checked against the schema, and then translated into
 * the SAME RunFlags a flag-driven run builds, so every later check (misuse guard,
 * network policy, credentials, Diplomacy seating) is the one code path of
 * `runCommand`. Only --out, --json, --quiet (output only), --i-own-this-target and --auth combine with it
 * (main.ts refuses the rest by name before this runs).
 *
 * `ownership_attested: true` in the file is the caller's attestation (recorded with
 * `source: run_spec`); `--i-own-this-target` gives the same. `--auth` supplies a
 * credential REFERENCE when the file has none, and must equal the file's when both
 * are given. A RunSpec the CLI wrote itself (`<out>/report.run-spec.json`,
 * `.agent-arena/<scenario>.run.json`) runs again as it was, in-process references
 * included (`http://in-process.invalid/ref:…`).
 */

import { relative, resolve, sep } from 'node:path';
import { SCENARIO_IDS, scenarioModule, type ScenarioId } from 'arena-scenarios';
import { misconfig } from '../errors.ts';
import { HostileFileError, readHostileJson } from '../files.ts';
import { validateRunSpecSchema } from '../report.ts';
import type { RunSpecContract } from '../generated/contracts.ts';
import type { RunFlags } from './run.ts';

/** A RunSpec is small; 256 KiB is far above any valid one (16 labels, 1000 seeds, 7 seats). */
export const RUN_SPEC_FILE_MAX_BYTES = 256 * 1024;
/** Where the CLI records an in-process reference target in the RunSpec (run.ts): this prefix + `ref:<name>`. */
const IN_PROCESS_PREFIX = 'http://in-' + 'process.invalid/';
const inProcessRef = (url: string): string | undefined => {
  if (!url.startsWith(IN_PROCESS_PREFIX)) return undefined;
  const ref = url.slice(IN_PROCESS_PREFIX.length);
  return /^ref:[a-z]{1,16}$/.test(ref) ? ref : undefined;
};
/** The flags `--spec` combines with (main.ts refuses every other run flag). */
export const SPEC_COMPATIBLE_FLAGS = ['spec', 'out', 'json', 'quiet', 'i-own-this-target', 'attest-ownership', 'auth'] as const;
/** Labels the CLI writes itself; a spec file's values for them are replaced, not trusted. */
const CLI_LABELS = /^arena\./;

export interface SpecFileExtras {
  out?: string;
  auth?: string;
  ownTarget?: boolean;
}

/** Read and schema-check a RunSpec file; returns the document. Exit 3 with the path and what to fix. */
export function readRunSpecDocument(path: string): RunSpecContract {
  let doc: unknown;
  try {
    doc = readHostileJson(path, RUN_SPEC_FILE_MAX_BYTES, '--spec file');
  } catch (e) {
    if (e instanceof HostileFileError) throw misconfig(e.message, 'pass --spec <run.json>: a RunSpec file (contracts/schemas/run_spec.schema.json).');
    throw e;
  }
  if (!validateRunSpecSchema(doc)) {
    const why = (validateRunSpecSchema.errors ?? []).slice(0, 3).map((x) => `${x.instancePath || '/'} ${x.message}`).join('; ');
    throw misconfig(`--spec ${path.slice(0, 200)} is invalid against run_spec.schema.json: ${why}.`, 'fix the file (the scenario pages show a valid RunSpec per scenario), or run with flags.');
  }
  return doc as RunSpecContract;
}

/** The RunFlags a RunSpec file stands for (plus the few flags --spec combines with). */
export function runSpecFlags(spec: RunSpecContract, x: SpecFileExtras = {}): { flags: RunFlags; labels: Record<string, string> } {
  const s = spec as RunSpecContract & { seats?: unknown[]; diplomacy?: { profile?: string; fill?: string; horizon_year?: number } };
  if (s.seats?.length) throw misconfig('--spec: seats[] (the Diplomacy table profile, one target per power) runs only on the hosted runner.', 'drop seats[] to play one target at one power locally.');
  if (s.diplomacy?.profile === 'table') throw misconfig('--spec: diplomacy.profile table needs seats[], which runs only on the hosted runner.', 'use profile security (the default) or clean, or set diplomacy.fill.');

  if (s.scenario_version !== undefined && (SCENARIO_IDS as readonly string[]).includes(s.scenario_id)) {
    const have = scenarioModule(s.scenario_id as ScenarioId).describe().version;
    if (s.scenario_version !== have) throw misconfig(`--spec asks for ${s.scenario_id} ${String(s.scenario_version).slice(0, 20)}, but this build runs ${s.scenario_id} ${have}.`, 'drop scenario_version (the build\'s version is recorded), or use the CLI release that runs that version.');
  }
  const flags: RunFlags = {
    scenario: s.scenario_id,
    seeds: s.seeds.join(','),
    episodes: String(s.episodes),
    tier: s.budget_tier,
    ...(x.out !== undefined ? { out: x.out } : {}),
  };
  if (s.scenario_id === 'diplomacy_standard') {
    const seat = s.seat as { mode: string; position?: string } | undefined;
    if (seat && seat.mode !== 'power') throw misconfig(`--spec: diplomacy_standard seats the target at a power (seat.mode power), not ${seat.mode}.`);
    if (seat?.position) flags.seat = seat.position;
    const d = s.diplomacy;
    // Without a fill the profile decides (contracts 2.4.0): security (and absent) = injector-table, clean = house.
    if (d?.fill !== undefined) flags.fill = d.fill;
    else if (d?.profile === 'clean') flags.fill = 'house';
    if (d?.horizon_year !== undefined) flags.horizon = String(d.horizon_year);
  } else if (s.seat) {
    const seat = s.seat as { mode: string; position?: string; fill?: string };
    flags.seat = seat.mode;
    if (seat.position !== undefined) flags.position = seat.position;
    if (seat.fill !== undefined) flags.fill = seat.fill;
  }

  const t = s.target as RunSpecContract['target'] & { auth?: { scheme: string; ref: string; header_name?: string }; label?: string; ownership_attested?: boolean };
  const inProc = inProcessRef(t.url);
  flags.target = inProc ?? t.url;
  if (!inProc) flags.transport = t.transport;
  if (t.label !== undefined) flags.label = t.label;
  if (t.auth) {
    if (x.auth !== undefined && x.auth !== t.auth.ref) throw misconfig(`--auth ${x.auth.slice(0, 80)} differs from the --spec file's target.auth.ref ${t.auth.ref}.`, 'drop --auth, or make the two references the same.');
    flags.auth = t.auth.ref;
    if (t.auth.scheme === 'header') flags.authHeader = t.auth.header_name;
  } else if (x.auth !== undefined) flags.auth = x.auth;
  if (x.ownTarget) flags.ownTarget = true;
  else if (t.ownership_attested === true) {
    flags.ownTarget = true;
    flags.ownershipSource = 'run_spec';
  }
  // The caller's labels, minus the ones the CLI writes itself (arena.network_policy, arena.diplomacy_fill, …).
  const labels = Object.fromEntries(Object.entries(s.labels ?? {}).filter(([k]) => !CLI_LABELS.test(k)));
  return { flags, labels };
}

/**
 * The spec file as a repo-relative path for the SARIF location (sarif-mapping.md §4), when it
 * is under the working directory and a plain relative path; otherwise undefined (the run then
 * writes `.agent-arena/<scenario>.run.json` like a flag-driven run).
 */
export function specFileLocation(path: string, cwd = process.cwd()): string | undefined {
  const rel = relative(cwd, resolve(cwd, path)).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || rel.startsWith('/') || rel.includes('/../')) return undefined;
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/.test(rel) ? rel : undefined;
}
