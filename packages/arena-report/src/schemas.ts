/**
 * Contract validators for the Report pipeline, compiled from the single source
 * of truth (`contracts/schemas`, found by walking up from this file, or
 * `$WOT_CONTRACTS_DIR/schemas`). A private AJV instance, so nothing here can
 * perturb another package's catalog. Schema loading is file I/O at module load
 * (configuration), never per call.
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

export const SCHEMAS_DIR = findSchemasDir(dirname(fileURLToPath(import.meta.url)));

/** RFC 3339 date-time (the JSON Schema `date-time` format), strict: a real calendar instant with an offset. */
const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
export function isDateTime(s: string): boolean {
  return DATE_TIME.test(s) && !Number.isNaN(Date.parse(s));
}
/** RFC 3986 absolute URI (scheme ":" hier-part), no whitespace or control characters. */
export function isUri(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/.test(s);
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', isDateTime);
ajv.addFormat('uri', isUri);

function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as Record<string, unknown>;
}

export const reportSchema = load('report.schema.json');
export const validateReportSchema: ValidateFunction = ajv.compile(reportSchema);
export const validateEpisodeResultSchema: ValidateFunction = ajv.compile(load('episode_result.schema.json'));
export const validateRunSpecSchema: ValidateFunction = ajv.compile(load('run_spec.schema.json'));

/** Frame caps declared by the contracts (`x-max-frame-bytes`). */
export const REPORT_MAX_BYTES = Number(reportSchema['x-max-frame-bytes'] ?? 67_108_864);

export function formatErrors(errors: readonly ErrorObject[] | null | undefined, max = 8): string[] {
  return (errors ?? []).slice(0, max).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}${e.params && 'allowedValue' in e.params ? ` (${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)})` : ''}`);
}
