/**
 * Phase-4 raid-channel validators (contract v1.3.0), compiled from the same
 * single source of truth as the play-loop validators (`../../contracts/schemas`).
 * Kept in a SEPARATE module + AJV instance (like `webhook-validators.ts`) so the
 * frozen Phase-1 frame catalog and its exhaustive tests stay untouched while the
 * additive raid frames — `raid_hello`/`raid_observation`/`raid_action`/`raid_ack`/
 * `raid_end` — get first-class edge validation and byte caps.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { findSchemasDir } from './contracts-dir.ts';
import type { FrameSchema } from './validators.ts';

export const RAID_FRAME_NAMES = [
  'raid_hello',
  'raid_observation',
  'raid_action',
  'raid_ack',
  'raid_end',
] as const;

export type RaidFrameName = (typeof RAID_FRAME_NAMES)[number];

const RAID_FRAME_FILES: Record<RaidFrameName, string> = {
  raid_hello: 'raid_hello.schema.json',
  raid_observation: 'raid_observation.schema.json',
  raid_action: 'raid_action.schema.json',
  raid_ack: 'raid_ack.schema.json',
  raid_end: 'raid_end.schema.json',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = findSchemasDir(HERE);

function loadSchema(file: string): FrameSchema {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as FrameSchema;
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', (s: string) => !Number.isNaN(Date.parse(s)));
ajv.addFormat('uri', (s: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s));

const raidSchemas = {} as Record<RaidFrameName, FrameSchema>;
const raidValidatorMap = {} as Record<RaidFrameName, ValidateFunction>;

for (const name of RAID_FRAME_NAMES) {
  const schema = loadSchema(RAID_FRAME_FILES[name]);
  raidSchemas[name] = schema;
  raidValidatorMap[name] = ajv.compile(schema);
}

/** Compiled AJV validators for the Phase-4 raid frames. */
export const raidValidators: Record<RaidFrameName, ValidateFunction> = raidValidatorMap;

/** Max byte size (`x-max-frame-bytes`) for a raid frame. */
export function raidMaxBytes(name: RaidFrameName): number {
  const cap = raidSchemas[name]['x-max-frame-bytes'];
  if (typeof cap !== 'number') {
    throw new Error(`schema for frame "${name}" has no numeric x-max-frame-bytes`);
  }
  return cap;
}

/** Raw schema by raid frame name. */
export function raidSchemaByName(name: RaidFrameName): FrameSchema {
  return raidSchemas[name];
}
