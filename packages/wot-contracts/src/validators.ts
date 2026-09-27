/**
 * AJV validators compiled from the contract schemas.
 *
 * The schema JSON is loaded at runtime from the single source of truth,
 * `../../contracts/schemas` (repo root), so there is exactly one place a frame
 * shape or a byte cap is defined (contracts/README.md). One strict AJV 2020-12
 * instance compiles all 11 schemas; a `validators` map is keyed by frame name.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { findSchemasDir } from './contracts-dir.ts';
import { FRAME_NAMES, FRAME_FILES, type FrameName } from './frames-manifest.ts';

/** Minimal view of the parts of a contract schema this package reads. */
export interface FrameSchema {
  $id: string;
  $schema?: string;
  title?: string;
  'x-max-frame-bytes'?: number;
  'x-frame-name'?: string;
  'x-direction'?: string;
  examples?: unknown[];
  [key: string]: unknown;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Walks up to the first ancestor holding contracts/schemas (private or public layout).
const SCHEMAS_DIR = findSchemasDir(HERE);

function loadSchema(file: string): FrameSchema {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as FrameSchema;
}

// One strict instance for the whole catalog.
const ajv = new Ajv2020({ strict: true, allErrors: true });

// The contracts use `x-*` annotation keywords; register them as no-ops so the
// schemas compile under strict mode (they carry metadata, not validation).
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) {
  ajv.addKeyword({ keyword: kw });
}
// Register the two string formats used by the schemas (permissive but real
// enough to keep the examples honest); strict mode rejects unknown formats.
ajv.addFormat('date-time', (s: string) => !Number.isNaN(Date.parse(s)));
ajv.addFormat('uri', (s: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s));

const schemasByName = {} as Record<FrameName, FrameSchema>;
const schemasByIdMap = new Map<string, FrameSchema>();
const validatorMap = {} as Record<FrameName, ValidateFunction>;

for (const name of FRAME_NAMES) {
  const schema = loadSchema(FRAME_FILES[name]);
  schemasByName[name] = schema;
  schemasByIdMap.set(schema.$id, schema);
  validatorMap[name] = ajv.compile(schema);
}

/** Compiled AJV validator per frame, keyed by frame name. */
export const validators: Record<FrameName, ValidateFunction> = validatorMap;

/** Max byte size for a frame, read from the schema's `x-max-frame-bytes`. */
export function maxBytes(frameName: FrameName): number {
  const schema = schemasByName[frameName];
  const cap = schema['x-max-frame-bytes'];
  if (typeof cap !== 'number') {
    throw new Error(`schema for frame "${frameName}" has no numeric x-max-frame-bytes`);
  }
  return cap;
}

/** Look up a raw schema by its `$id` (e.g. "wot:observation:grid_tactics:1"). */
export function schemaById($id: string): FrameSchema | undefined {
  return schemasByIdMap.get($id);
}

/** Look up a raw schema by frame name. */
export function schemaByName(frameName: FrameName): FrameSchema {
  return schemasByName[frameName];
}
