/**
 * Contract validators for the evaluation frames the scenarios emit and accept,
 * compiled from the single source of truth (`contracts/schemas`, v2.0.0). Kept
 * in its own AJV instance so it never perturbs the frozen wot-contracts catalogs.
 *
 *  - outbound, asserted by tests: eval_raid_observation, observation (duel),
 *    eval_episode_end, episode_result;
 *  - inbound, enforced BEFORE anything reaches the engine: eval_raid_action
 *    (whole frame + the `$defs/actions` slice), action (duel; the `units` slice).
 *
 * Schema loading is file I/O at module load (configuration, like the engine's
 * constants), never on a per-tick path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

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

type Schema = Record<string, unknown> & { $id: string; 'x-max-frame-bytes'?: number };

const FILES = {
  eval_raid_observation: 'eval_raid_observation.schema.json',
  eval_raid_action: 'eval_raid_action.schema.json',
  eval_episode_end: 'eval_episode_end.schema.json',
  episode_result: 'episode_result.schema.json',
  observation: 'observation.schema.json',
  action: 'action.schema.json',
} as const;

export type EvalSchemaName = keyof typeof FILES;

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', (s: string) => !Number.isNaN(Date.parse(s)));
ajv.addFormat('uri', (s: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s));

const schemas = {} as Record<EvalSchemaName, Schema>;
const compiled = {} as Record<EvalSchemaName, ValidateFunction>;
for (const name of Object.keys(FILES) as EvalSchemaName[]) {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, FILES[name]), 'utf8')) as Schema;
  schemas[name] = schema;
  compiled[name] = ajv.compile(schema);
}

function sub(name: EvalSchemaName, pointer: string): ValidateFunction {
  const v = ajv.getSchema(`${schemas[name].$id}${pointer}`);
  if (!v) throw new Error(`sub-schema ${name}${pointer} not found`);
  return v;
}

/** Whole-frame validators. */
export const evalValidators: Readonly<Record<EvalSchemaName, ValidateFunction>> = compiled;

/** One raid member's orders (`eval_raid_action.$defs.actions`). */
export const validateRaidActions: ValidateFunction = sub('eval_raid_action', '#/$defs/actions');
/** The duel `units` array (`action.properties.units`). */
export const validateDuelUnits: ValidateFunction = sub('action', '#/properties/units');

export function maxFrameBytes(name: EvalSchemaName): number {
  const cap = schemas[name]['x-max-frame-bytes'];
  if (typeof cap !== 'number') throw new Error(`schema ${name} has no x-max-frame-bytes`);
  return cap;
}

export function schemaErrors(v: ValidateFunction): string {
  return (v.errors ?? [])
    .slice(0, 4)
    .map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
    .join('; ');
}
