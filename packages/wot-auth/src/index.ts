/**
 * wot-auth — shared agent-passport auth for mint (passports service) and verify
 * (gateway/arena). Implements docs/security/agent-passports.md §2 (tokens),
 * §2.4 (keys/JWKS), §3 (secret hashing).
 */

export {
  mintAccessToken,
  verifyAccessToken,
  getPublicJwks,
  hasScope,
  authorizeAffordance,
  isRootToken,
  narrowChildScope,
  type MintAccessTokenInput,
  type AccessClaims,
  type DelegationClaim,
  type ScopeNarrowing,
  type AffordanceRequirement,
  type AffordanceDecision,
  type League,
} from './tokens.ts';

export {
  hashSecret,
  verifySecret,
  generateClientSecret,
} from './secrets.ts';

export {
  getKeyMaterial,
  _resetKeyCache,
  type KeyMaterial,
} from './keys.ts';

export {
  jcs,
  sha256Tagged,
  isEd25519PublicJwk,
  jwkThumbprint,
  mintPassportSigningKey,
  signingKeyFromSeed,
  signingKeyFromLabel,
  signDetachedJws,
  verifyDetachedJws,
  DETACHED_JWS_RE,
  SIGNED_PRESS_MOVES,
  pressTermsHash,
  pressSigningPayload,
  signPressMove,
  verifyPressSignature,
  PassportKeyRegistry,
  type Ed25519PublicJwk,
  type Ed25519PrivateJwk,
  type PassportSigningKey,
  type JwsVerdict,
  type JwsFailure,
  type SignedPressMove,
  type PressSignedFields,
  type PassportKeyResolver,
} from './press-signing.ts';

export {
  REDACTED,
  redactForLog,
  redactText,
  serializeLogRecord,
  registerLogSecret,
  isSensitiveKey,
  _clearLogSecrets,
} from './redact.ts';

export {
  TokenExpired,
  TokenInvalid,
  type AuthError,
} from './errors.ts';

export {
  ISSUER,
  AUDIENCE,
  DEFAULT_TTL_SECONDS,
  DELEGABLE_SCOPES,
  MAX_SQUAD_SIZE,
  MAX_DELEGATION_DEPTH,
  DELEGATED_TTL_CAP_SECONDS,
  DELEGATION_GRANT_TTL_SECONDS,
  DEPLOY_ENV,
  IS_PRODUCTION,
  resolveDeployEnv,
  assertDevAuthAllowed,
  devAuthEnabled,
  type DeployEnv,
} from './config.ts';
