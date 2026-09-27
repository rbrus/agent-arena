/**
 * AJV edge-validation for the passports request bodies.
 *
 * The management-plane REST bodies (RegisterAgentRequest, TokenRequest) live as
 * inline component schemas in contracts/openapi.yaml (no standalone schema file
 * to import from wot-contracts, which only compiles the 11 WSS/error frames).
 * They are transcribed here verbatim from openapi.yaml so the edge validator
 * matches the published contract. One strict AJV 2020-12 instance, matching
 * wot-contracts' validator setup.
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

const LEAGUE = { enum: ['edge', 'core', 'frontier'] } as const;

/** contracts/openapi.yaml #/components/schemas/RegisterAgentRequest */
export const registerAgentRequestSchema = {
  $id: 'wot:req:register_agent',
  type: 'object',
  additionalProperties: false,
  required: ['display_name'],
  properties: {
    display_name: { type: 'string', minLength: 1, maxLength: 32 },
    league: LEAGUE,
    // DEPRECATED in contracts 2.2.0 (G-10) and IGNORED: accepted so existing
    // clients keep working, never read, stored or turned into a token claim.
    // Removed at the next MAJOR.
    device_binding: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: {
        enabled: { type: 'boolean' },
        jwk: { type: 'object' },
      },
    },
  },
} as const;

/** contracts/openapi.yaml #/components/schemas/TokenRequest (form-urlencoded). */
export const tokenRequestSchema = {
  $id: 'wot:req:token',
  type: 'object',
  required: ['grant_type', 'client_id', 'client_secret'],
  properties: {
    grant_type: { const: 'client_credentials' },
    client_id: { type: 'string' },
    client_secret: { type: 'string' },
    scope: { type: 'string' },
  },
} as const;

/**
 * contracts/openapi.yaml #/components/schemas/TokenExchangeRequest (JSON body).
 * The RFC 8693 token-exchange (batch/squad) profile served at
 * POST /v1/oauth/token/exchange. Transcribed verbatim so the edge validator
 * matches the published contract — the parent is a hostile client too, so its
 * exchange body is schema-checked at the edge like every other request.
 */
export const tokenExchangeRequestSchema = {
  $id: 'wot:req:token_exchange',
  type: 'object',
  additionalProperties: false,
  required: ['grant_type', 'subject_token', 'scope', 'squad'],
  properties: {
    grant_type: { const: 'urn:ietf:params:oauth:grant-type:token-exchange' },
    subject_token: { type: 'string', minLength: 20, maxLength: 1500 },
    subject_token_type: {
      enum: [
        'urn:ietf:params:oauth:token-type:access_token',
        'urn:ietf:params:oauth:token-type:jwt',
      ],
    },
    requested_token_type: { const: 'urn:ietf:params:oauth:token-type:jwt' },
    scope: { type: 'string', maxLength: 256 },
    audience: { type: 'string', maxLength: 256 },
    squad: {
      type: 'object',
      additionalProperties: false,
      required: ['count'],
      properties: {
        squad_id: { type: 'string', pattern: '^sqd_[0-9A-HJKMNP-TV-Z]{26}$' },
        raid_id: { type: 'string', pattern: '^rad_[0-9A-HJKMNP-TV-Z]{26}$' },
        boss_id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$' },
        count: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });

export const validateRegisterAgent: ValidateFunction = ajv.compile(registerAgentRequestSchema);
export const validateTokenRequest: ValidateFunction = ajv.compile(tokenRequestSchema);
export const validateTokenExchange: ValidateFunction = ajv.compile(tokenExchangeRequestSchema);

/** First AJV error rendered as a short human hint (never echoes secret values). */
export function firstError(v: ValidateFunction): string {
  const e = v.errors?.[0];
  if (!e) return 'Invalid request body.';
  const where = e.instancePath ? e.instancePath.replace(/^\//, '') : (e.params as { missingProperty?: string })?.missingProperty ?? 'body';
  return `${where}: ${e.message ?? 'invalid'}.`;
}
