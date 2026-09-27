/**
 * Passport signing keys in the store (Phase 8 B3c, threat-model-arena G-11).
 *
 * The passports service mints a per-passport Ed25519 key pair at registration
 * (`wot-auth` `mintPassportSigningKey`), returns the private half to the caller
 * once, and hands ONLY the public JWK to the store. This module:
 *
 *   - `toSigningKeyRecord` normalises and validates that public JWK before it is
 *     persisted: an Ed25519 public JWK only (a private `d`, another curve, an
 *     extra member is refused), `kid` = its RFC 7638 thumbprint;
 *   - `passportKeyResolver` is the persistent `PassportKeyResolver` the arena
 *     (Diplomacy press) and the gateway (Negotiation Chambers) verify against:
 *     agent id → public key, and only while the passport is `active` and the
 *     key is not revoked. One resolver instance serves both planes.
 */

import { isEd25519PublicJwk, jwkThumbprint, type Ed25519PublicJwk, type PassportKeyResolver } from 'wot-auth';
import type { PassportRecord, PassportSigningKeyRecord, PassportStore } from './types.ts';

export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

/** Validate + normalise a PUBLIC Ed25519 JWK into the stored record. Throws SigningKeyError. */
export function toSigningKeyRecord(publicJwk: unknown, createdAt: string): PassportSigningKeyRecord {
  if (!isEd25519PublicJwk(publicJwk)) throw new SigningKeyError('signing key must be a public Ed25519 JWK (a private key is refused)');
  const kid = jwkThumbprint(publicJwk);
  if (publicJwk.kid !== undefined && publicJwk.kid !== kid) throw new SigningKeyError('signing key kid must be the RFC 7638 thumbprint of the key');
  return {
    kid,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid, alg: 'EdDSA', use: 'sig' },
    createdAt,
    revokedAt: null,
  };
}

/** The resolvable public key of a passport record, or null (no key, key revoked, passport not active). */
export function activeSigningKey(record: PassportRecord | null | undefined): Ed25519PublicJwk | null {
  if (!record || record.status !== 'active') return null;
  const k = record.signingKey;
  if (!k || k.revokedAt !== null) return null;
  return { ...k.publicJwk };
}

/**
 * Store-backed `PassportKeyResolver`: agent id → the passport's active public
 * signing key. Reads through on every call, so a revoke, rotation or owner ban
 * takes effect on the very next signed move (no cache to invalidate). A lookup
 * failure resolves to null (the verifier then refuses: fail closed).
 */
export function passportKeyResolver(passports: Pick<PassportStore, 'getByAgentId'>): PassportKeyResolver {
  return async (agentId: string) => {
    if (typeof agentId !== 'string' || agentId.length === 0) return null;
    try {
      return activeSigningKey(await passports.getByAgentId(agentId));
    } catch {
      return null;
    }
  };
}
