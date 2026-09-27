/**
 * AJV validators for the Diplomacy frames (contracts 2.1.0; the table-session
 * hello and session ack since 2.4.0), compiled from the
 * single source of truth `contracts/schemas`. Kept here (not in wot-contracts,
 * whose frame catalog and codegen are frozen for Phase 1) in their own AJV
 * instance, like the raid and webhook validators.
 *
 * Inbound frames are validated at the edge, after their byte cap and before
 * anything else: the Diplomacy hello (2048 bytes) and `diplomacy_action`
 * (16384 bytes). Outbound frames are validated in tests (every
 * observation of the e2e game) so the wire mapping cannot drift from the
 * contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

export const DIP_FRAMES = ['diplomacy_hello', 'diplomacy_session_ack', 'diplomacy_action', 'diplomacy_observation', 'diplomacy_episode_end'] as const;
export type DipFrameName = (typeof DIP_FRAMES)[number];

function schemasDir(): string {
  const override = process.env.WOT_CONTRACTS_DIR;
  if (override) return join(resolve(override), 'schemas');
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'contracts', 'schemas');
    if (existsSync(join(candidate, 'diplomacy_action.schema.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error('diplomacy validators: contracts/schemas not found (set WOT_CONTRACTS_DIR)');
    dir = up;
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: false });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', (s: string) => !Number.isNaN(Date.parse(s)));

const DIR = schemasDir();
const compiled = {} as Record<DipFrameName, ValidateFunction>;
const caps = {} as Record<DipFrameName, number>;
for (const name of DIP_FRAMES) {
  const schema = JSON.parse(readFileSync(join(DIR, `${name}.schema.json`), 'utf8')) as Record<string, unknown>;
  compiled[name] = ajv.compile(schema);
  caps[name] = typeof schema['x-max-frame-bytes'] === 'number' ? (schema['x-max-frame-bytes'] as number) : 16384;
}

export const dipValidators: Readonly<Record<DipFrameName, ValidateFunction>> = compiled;
export const dipMaxBytes = (name: DipFrameName): number => caps[name];

/** First AJV error as `path: message` (never echoes the offending value). */
export function dipFirstError(name: DipFrameName): string {
  const e = compiled[name].errors?.[0];
  if (!e) return 'schema_invalid';
  return `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`.slice(0, 200);
}
