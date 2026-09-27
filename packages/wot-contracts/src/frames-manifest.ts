/**
 * Canonical frame catalog for the Phase-1 contracts.
 *
 * The set of frames is fixed by `contracts/schemas/*.schema.json` (the single
 * source of truth). This tiny hand-written map ties each stable frame NAME to
 * its schema filename and its generated TypeScript type name. Keeping it here
 * (rather than generating it) keeps the runtime `validators` keying decoupled
 * from the codegen step while staying trivially auditable against the schema
 * directory.
 *
 * Frame names match the WSS `t` discriminator for the play-loop frames
 * (`hello`, `observation`, ...) and use `error` / `oauth_error` for the two
 * REST error envelopes, which have no `t` field.
 */

export const FRAME_NAMES = [
  'hello',
  'observation',
  'action',
  'ack',
  'reject',
  'match_end',
  'thought',
  'session_superseded',
  'session_revoked',
  'error',
  'oauth_error',
] as const;

export type FrameName = (typeof FRAME_NAMES)[number];

/** frame name -> schema file basename (in ../../contracts/schemas). */
export const FRAME_FILES: Record<FrameName, string> = {
  hello: 'hello.schema.json',
  observation: 'observation.schema.json',
  action: 'action.schema.json',
  ack: 'ack.schema.json',
  reject: 'reject.schema.json',
  match_end: 'match_end.schema.json',
  thought: 'thought.schema.json',
  session_superseded: 'session_superseded.schema.json',
  session_revoked: 'session_revoked.schema.json',
  error: 'error.schema.json',
  oauth_error: 'oauth_error.schema.json',
};

/** frame name -> generated TypeScript interface name (see src/generated/frames.ts). */
export const FRAME_TYPES: Record<FrameName, string> = {
  hello: 'Hello',
  observation: 'Observation',
  action: 'Action',
  ack: 'Ack',
  reject: 'Reject',
  match_end: 'MatchEnd',
  thought: 'Thought',
  session_superseded: 'SessionSuperseded',
  session_revoked: 'SessionRevoked',
  error: 'ErrorEnvelope',
  oauth_error: 'OAuthError',
};
