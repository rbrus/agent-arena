/**
 * Webhook envelope validator (contracts/schemas/webhook_event.schema.json),
 * compiled from the same single source of truth as the play-loop validators.
 * Kept in a SEPARATE module + AJV instance from the frozen play-loop catalog.
 *
 * (Until Phase 7 B0-21 this module also compiled the live spectator frames;
 * the live spectator plane is cut by ADR-001 §6.)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { findSchemasDir } from './contracts-dir.ts';
import type { FrameSchema } from './validators.ts';

export const WEBHOOK_FRAME_NAMES = ['webhook_event'] as const;

export type WebhookFrameName = (typeof WEBHOOK_FRAME_NAMES)[number];

const WEBHOOK_FRAME_FILES: Record<WebhookFrameName, string> = {
  webhook_event: 'webhook_event.schema.json',
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

const webhookSchemas = {} as Record<WebhookFrameName, FrameSchema>;
const webhookValidatorMap = {} as Record<WebhookFrameName, ValidateFunction>;

for (const name of WEBHOOK_FRAME_NAMES) {
  const schema = loadSchema(WEBHOOK_FRAME_FILES[name]);
  webhookSchemas[name] = schema;
  webhookValidatorMap[name] = ajv.compile(schema);
}

/** Compiled AJV validators for the webhook envelope. */
export const webhookValidators: Record<WebhookFrameName, ValidateFunction> = webhookValidatorMap;

/** Max byte size (`x-max-frame-bytes`) for a webhook envelope. */
export function webhookMaxBytes(name: WebhookFrameName): number {
  const cap = webhookSchemas[name]['x-max-frame-bytes'];
  if (typeof cap !== 'number') {
    throw new Error(`schema for frame "${name}" has no numeric x-max-frame-bytes`);
  }
  return cap;
}
