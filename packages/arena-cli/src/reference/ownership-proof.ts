/**
 * `serve-reference --ownership-token` (env `ARENA_OWNERSHIP_TOKEN`): the Sixi Arena
 * target-ownership proof, well-known-file method, served by the reference target itself.
 *
 * Why: the hosted cross-check (docs/phase-9/CROSSCHECK.md, ruling XCHECK-2) scans reference
 * origins on Cloud Run `run.app` hostnames. Sixi's admission runs the ownership gate on every
 * scan and re-checks every 24 h; a `run.app` host has no DNS zone we control, so the only
 * proof possible is the well-known file, and it has to come from this process.
 *
 * What the Sixi gate accepts (sixi-scanner go/arena/origins.go `checkWellKnown`, the exact
 * check; the scanner's looser go/api/routes_domains.go `checkDomainProof` accepts a superset):
 *   GET https://<host>/.well-known/sixi-verify  (exact origin, port 443, no redirect followed)
 *   200, Content-Type text/plain (parameters allowed), body <= 256 bytes whose trimmed value
 *   EQUALS the token; the token is `sixi-verify=` + 32 lower-case hex digits (16 random bytes).
 * We serve exactly the token bytes (no newline), so both checks pass.
 *
 * The token proves control of the host to the Sixi Arena control plane and nothing else: it is
 * not a credential for this server or for Sixi. It is still never logged, echoed or written to
 * any file by the CLI, and an error about it names only what is wrong, never the value.
 */

import { misconfig } from '../errors.ts';
import type { OutboundResponse } from '../net/index.ts';

/** The gate's path (sixi-scanner `WellKnownPath` / `wellKnownVerifyPath`). */
export const OWNERSHIP_PROOF_PATH = '/.well-known/sixi-verify';
/** The gate's token format (sixi-scanner `newToken` / `newDomainToken`: `sixi-verify=` + hex of 16 bytes). */
export const OWNERSHIP_TOKEN_FORMAT = /^sixi-verify=[0-9a-f]{32}$/;
export const OWNERSHIP_TOKEN_ENV = 'ARENA_OWNERSHIP_TOKEN';

/**
 * The token to serve, or undefined when neither the flag nor the env variable is set (no route).
 * The flag wins over the env. Set but empty or malformed is a misconfiguration (exit 3) that
 * never quotes the value.
 */
export function resolveOwnershipToken(flag: string | undefined, env: Record<string, string | undefined>): string | undefined {
  const fromFlag = flag !== undefined;
  const value = fromFlag ? flag : env[OWNERSHIP_TOKEN_ENV];
  if (value === undefined) return undefined;
  const source = fromFlag ? '--ownership-token' : OWNERSHIP_TOKEN_ENV;
  const issued = 'use the token Sixi issued for this host (POST /api/arena/origins), exactly as issued.';
  if (value === '') throw misconfig(`${source} is empty.`, `${issued} Unset ${fromFlag ? 'the flag' : 'the variable'} to serve no ownership proof.`);
  if (value !== value.trim()) {
    throw misconfig(`${source} has leading or trailing whitespace (${value.length} characters; the value is not shown).`, `${issued} A trailing newline usually comes from echo; store it with printf '%s'.`);
  }
  if (!OWNERSHIP_TOKEN_FORMAT.test(value)) {
    throw misconfig(
      `${source} is not a Sixi ownership token (${value.length} characters; the value is not shown): it must be "sixi-verify=" followed by 32 lower-case hex digits.`,
      issued,
    );
  }
  return value;
}

/** The proof route: GET (and HEAD) answer the token as text/plain; any other method is 405. */
export function ownershipProofResponse(method: string, token: string): OutboundResponse {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(token)), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (method === 'GET') return { status: 200, headers, body: token };
  if (method === 'HEAD') return { status: 200, headers };
  return { status: 405, headers: { 'content-type': 'application/json', allow: 'GET, HEAD' }, body: '{"error":"method_not_allowed"}' };
}
