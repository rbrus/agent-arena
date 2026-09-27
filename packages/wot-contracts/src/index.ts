/**
 * wot-contracts — generated wire types + AJV validators for the Agent Arena
 * contracts.
 *
 * Types are generated from contracts/schemas/*.schema.json (see codegen.mjs);
 * validators are compiled from the same files at runtime (validators.ts).
 */

// Generated wire types (the exact shapes on the wire).
export type {
  Hello,
  Observation,
  Action,
  Ack,
  Reject,
  MatchEnd,
  Thought,
  SessionSuperseded,
  SessionRevoked,
  ErrorEnvelope,
  OAuthError,
} from './generated/frames.ts';

// Validators + schema helpers.
export {
  validators,
  maxBytes,
  schemaById,
  schemaByName,
  type FrameSchema,
} from './validators.ts';

// Contracts location (private and public layouts; WOT_CONTRACTS_DIR override).
export { contractsDir, findContractsDir, findSchemasDir, workspaceRoot } from './contracts-dir.ts';

// Frame catalog.
export {
  FRAME_NAMES,
  FRAME_FILES,
  FRAME_TYPES,
  type FrameName,
} from './frames-manifest.ts';

// Webhook envelope validator (webhook_event).
export {
  webhookValidators,
  webhookMaxBytes,
  WEBHOOK_FRAME_NAMES,
  type WebhookFrameName,
} from './webhook-validators.ts';

// Phase-4 raid-channel validators (additive; contract v1.3.0).
export {
  raidValidators,
  raidMaxBytes,
  raidSchemaByName,
  RAID_FRAME_NAMES,
  type RaidFrameName,
} from './raid-validators.ts';

