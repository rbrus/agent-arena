/**
 * AJV edge-validation for the gateway request bodies.
 *
 * QueueRequest lives as an inline component schema in contracts/openapi.yaml
 * (there is no standalone schema file), transcribed here verbatim so the edge
 * validator matches the published contract. Strict AJV 2020-12, matching
 * wot-contracts' validator setup.
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

const LEAGUE = { enum: ['edge', 'core', 'frontier'] } as const;

/** contracts/openapi.yaml #/components/schemas/QueueRequest */
export const queueRequestSchema = {
  $id: 'wot:req:queue',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { const: 'duel' },
    league: LEAGUE,
  },
} as const;

/** contracts/openapi.yaml #/components/schemas/RegisterWebhookRequest */
export const registerWebhookSchema = {
  $id: 'wot:req:register_webhook',
  type: 'object',
  additionalProperties: false,
  required: ['url', 'events'],
  properties: {
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    events: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['match.found', 'match.end'] },
    },
    description: { type: 'string', maxLength: 200 },
  },
} as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat('uri', (s: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s));

export const validateQueueRequest: ValidateFunction = ajv.compile(queueRequestSchema);
export const validateRegisterWebhook: ValidateFunction = ajv.compile(registerWebhookSchema);

/** First AJV error rendered as a short human hint. */
export function firstError(v: ValidateFunction): string {
  const e = v.errors?.[0];
  if (!e) return 'Invalid request body.';
  const where = e.instancePath
    ? e.instancePath.replace(/^\//, '')
    : (e.params as { missingProperty?: string })?.missingProperty ?? 'body';
  return `${where}: ${e.message ?? 'invalid'}.`;
}
