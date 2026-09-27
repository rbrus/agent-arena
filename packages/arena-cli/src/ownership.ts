/**
 * Misuse prevention (threat model §8.1; contracts 2.1.0 `target.ownership_attested`,
 * errors.md §1c `target_ownership_unattested`). Not a security boundary (the
 * CLI is open source): it records intent, stops copy-paste accidents, and
 * matches SECURITY.md's safe-harbour wording. A target that is not a loopback
 * address the user TYPED needs `--i-own-this-target` (alias
 * `--attest-ownership`), which sets `run.spec.target.ownership_attested`; the
 * report records the check as `run.target_ownership`.
 *
 * Stricter than the contract minimum on purpose: a HOSTNAME that resolves to
 * loopback (reachable only with --allow-private) still needs the attestation,
 * because the CLI never pre-resolves names outside the guarded socket lookup.
 */

import { misconfig } from './errors.ts';

export const ATTESTATION = 'I own this endpoint or am authorised to test it';
export const REJECT_CODE = 'target_ownership_unattested';

export interface TargetOwnership {
  loopback: boolean;
  attested: boolean;
  source?: 'cli_flag' | 'run_spec';
}

export function requireOwnership(o: { inProcess: boolean; loopback: boolean; attested: boolean; url: URL | null }): void {
  if (o.inProcess || o.loopback || o.attested) return;
  throw misconfig(
    `${REJECT_CODE}: refusing to run against ${o.url?.host ?? 'a non-loopback target'} without an ownership attestation. Nothing was sent.`,
    `if you own this endpoint or are authorised to test it, pass --i-own-this-target ("${ATTESTATION}").`,
  );
}

/** `source`: where the attestation came from (`run_spec` = `ownership_attested: true` in a `--spec` file). */
export function targetOwnership(o: { inProcess: boolean; loopback: boolean; attested: boolean; source?: 'cli_flag' | 'run_spec' }): TargetOwnership {
  const loopback = o.inProcess || o.loopback;
  return o.attested ? { loopback, attested: true, source: o.source ?? 'cli_flag' } : { loopback, attested: false };
}
