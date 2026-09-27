/**
 * Contract validators for the Diplomacy frames and records (contracts 2.1.0),
 * compiled from `contracts/schemas` in their own AJV instance (like
 * ../contracts.ts, so the Phase 7 catalog is untouched). Schema loading is
 * file I/O at module load (configuration), never on a per-tick path.
 *
 *  - outbound, validated at egress: diplomacy_observation, diplomacy_episode_end;
 *  - inbound, enforced BEFORE anything reaches the engine: diplomacy_action;
 *  - records: diplomacy_press_reject, oracle_evidence, episode_result.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

function findSchemasDir(start: string): string {
  const override = process.env.WOT_CONTRACTS_DIR;
  if (override) {
    const dir = join(resolve(override), 'schemas');
    if (!existsSync(dir)) throw new Error(`WOT_CONTRACTS_DIR=${override} has no schemas/ directory`);
    return dir;
  }
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'contracts', 'schemas');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`contracts/schemas not found in any ancestor of ${start}`);
    dir = parent;
  }
}

const SCHEMAS_DIR = findSchemasDir(dirname(fileURLToPath(import.meta.url)));
/** The resolved `contracts/schemas` directory (WOT_CONTRACTS_DIR, else the nearest ancestor's). */
export const DIP_SCHEMAS_DIR = SCHEMAS_DIR;

const FILES = {
  diplomacy_observation: 'diplomacy_observation.schema.json',
  diplomacy_action: 'diplomacy_action.schema.json',
  diplomacy_episode_end: 'diplomacy_episode_end.schema.json',
  diplomacy_press_reject: 'diplomacy_press_reject.schema.json',
  oracle_evidence: 'oracle_evidence.schema.json',
} as const;

export type DipSchemaName = keyof typeof FILES;

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });

const schemas = {} as Record<DipSchemaName, Record<string, unknown>>;
const compiled = {} as Record<DipSchemaName, ValidateFunction>;
for (const name of Object.keys(FILES) as DipSchemaName[]) {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, FILES[name]), 'utf8')) as Record<string, unknown>;
  schemas[name] = schema;
  compiled[name] = ajv.compile(schema);
}

export const dipValidators: Readonly<Record<DipSchemaName, ValidateFunction>> = compiled;

export function dipMaxFrameBytes(name: DipSchemaName): number {
  const cap = schemas[name]['x-max-frame-bytes'];
  if (typeof cap !== 'number') throw new Error(`schema ${name} has no x-max-frame-bytes`);
  return cap;
}

export function dipSchemaErrors(v: ValidateFunction): string {
  return (v.errors ?? [])
    .slice(0, 4)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
    .join('; ');
}
