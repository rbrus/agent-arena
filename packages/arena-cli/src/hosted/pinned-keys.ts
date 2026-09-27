/**
 * The control-plane run-manifest keys this open release pins (SIXI-INTEGRATION
 * §1.5 "Pinning the manifest key in the runner"): Sixi never rebuilds the image,
 * so the key `run --hosted` checks a manifest against ships IN the release, as a
 * JWKS of manifest kids. A new manifest key must appear here, in a release with
 * a green cross-check, before the control plane first signs with it.
 *
 * Empty in this build: no Sixi manifest key has been published yet. Until then
 * `run --hosted` and pre-seal `verify --hosted-seal` need `--manifest-key` (a
 * kid-bound JWK or JWKS), which the fixed job template sets, and every such run
 * prints a one-line warning that no key is pinned.
 *
 * G-47 trust-anchor rule (docs/phase-9/SECURITY-REVIEW-HOSTED.md):
 *   - pinned set NOT empty → `--manifest-key` is refused outright (the job
 *     arguments can never replace the release's trust root);
 *   - pinned set empty → `--manifest-key` is accepted only when EVERY key is
 *     bound to a `kid` (a PEM, or a JWK without `kid`, would be tried for any kid
 *     and is refused), with the warning;
 *   - neither → refused.
 */

import { createPublicKey } from 'node:crypto';
import { loadPublicKeySet, type PinnedKey } from '../keys.ts';
import { warn } from '../ui.ts';
import { invalid } from './manifest.ts';

// TODO(release, platform-engineer; SIXI-INTEGRATION §1.16 PR 3 "pin the manifest JWKS"):
// before the hosted beta release is promoted, add the Sixi control-plane manifest JWKS here
// (public keys only, one entry per kid; the kid of the key KMS signs manifests with). From
// that release on, --manifest-key is refused and the job template must stop passing it.
/** OKP Ed25519 public JWKs, each with its `kid`. Public keys only; never a `d`. */
export const PINNED_MANIFEST_JWKS: { keys: readonly { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string }[] } = { keys: [] };

export function pinnedManifestKeys(): PinnedKey[] {
  return PINNED_MANIFEST_JWKS.keys.map((k) => ({ kid: k.kid, key: createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' }) }));
}

export const NO_PINNED_KEY_WARNING =
  'no control-plane manifest key is pinned in this release; the manifest is checked against --manifest-key from the job template (kid-bound). Pin the Sixi manifest JWKS before the hosted beta (hosted/pinned-keys.ts).';

/**
 * The control-plane manifest key set for a hosted run or a pre-seal verification, under
 * the G-47 rule above. `pinned` defaults to this release's set (tests pass their own).
 * Returns [] only when `required` is false and no key is available.
 */
export function resolveManifestKeys(flag: string | undefined, o: { required: boolean; pinned?: readonly PinnedKey[]; flagName?: string }): PinnedKey[] {
  const F = o.flagName ?? '--manifest-key';
  const pinned = o.pinned ?? pinnedManifestKeys();
  if (pinned.length) {
    if (flag !== undefined) {
      throw invalid(F, `this release pins the control-plane manifest key set (${pinned.map((k) => k.kid ?? '?').join(', ')}); ${F} cannot replace or extend it.`, `remove ${F} from the job template; a new manifest key ships in a new release (SIXI-INTEGRATION §1.5).`);
    }
    return [...pinned];
  }
  if (flag === undefined) {
    if (!o.required) return [];
    throw invalid(F, 'this release pins no control-plane manifest key, and --manifest-key was not given.', 'use a release that bundles the Sixi manifest JWKS, or pass the pinned key (OKP JWK with kid, or JWKS) in the job template; never a key supplied by the customer.');
  }
  const keys = loadPublicKeySet(flag, F);
  if (keys.some((k) => k.kid === undefined)) {
    throw invalid(F, 'hosted mode needs a kid-bound manifest key: an OKP JWK with "kid", or a JWKS whose keys all carry one. A PEM (or a JWK without kid) would be tried for every kid and is refused.', 'pass the control-plane manifest key as {"kty":"OKP","crv":"Ed25519","x":"…","kid":"sixi-arena-manifest-ed25519-…"}.');
  }
  warn(NO_PINNED_KEY_WARNING);
  return keys;
}
