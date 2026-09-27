/**
 * Guarded outbound HTTP for webhook delivery (threat-model-arena G-3).
 *
 * A webhook URL is supplied by an Architect, so delivering to it is a
 * server-side request to an attacker-chosen destination (SSRF). The guard:
 *
 *   - accepts `https:` only, with no userinfo;
 *   - resolves the host and refuses the request if ANY resolved address is
 *     not public under the shared blocklist (`./net-blocklist.ts`, G-25):
 *     loopback, private, CGNAT, link-local (incl. cloud metadata), multicast,
 *     reserved, unspecified, benchmarking, and every IPv6 transition form
 *     (v4-mapped, NAT64, 6to4, Teredo);
 *   - checks the address INSIDE the socket's `lookup`, so the address that is
 *     validated is the address that is connected to (no DNS-rebinding window
 *     between a pre-check and the connect);
 *   - never follows redirects (a 3xx is a failed delivery, not a hop to a new,
 *     unchecked destination);
 *   - bounds time (connect + response) and the response body it reads.
 *
 * `allowPrivateTargets` (plain http, loopback/private addresses) exists for the
 * local sandbox and tests only; it is IGNORED unless WOT_ENV is explicitly
 * development|test (wot-auth fails closed on anything else).
 *
 * The address table lives in `./net-blocklist.ts`, the single copy shared with
 * the CLI's `net/guard.ts` (G-25).
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { IS_PRODUCTION } from 'wot-auth';
import { isForbiddenAddress } from './net-blocklist.ts';

export class EgressRefused extends Error {
  constructor(public readonly reason: string) {
    super(`egress refused: ${reason}`);
    this.name = 'EgressRefused';
  }
}

// ---------------------------------------------------------------------------
// Address policy: the ONE shared blocklist (G-25), see ./net-blocklist.ts.
// Webhook egress is strict: every non-public class is refused, including all
// IPv6 transition forms (v4-mapped, NAT64, 6to4, Teredo) whatever they embed.
// ---------------------------------------------------------------------------

export { isForbiddenAddress };

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

export interface EgressOptions {
  /** Local sandbox/tests only; ignored in production (see module doc). */
  allowPrivateTargets?: boolean;
  /** Overall deadline for connect + response, ms. */
  timeoutMs?: number;
  /** Max response body bytes read (the rest is discarded). */
  maxResponseBytes?: number;
}

const privateAllowed = (opts: EgressOptions): boolean => opts.allowPrivateTargets === true && !IS_PRODUCTION;

/** Validate a webhook URL before any network activity. Throws EgressRefused. */
export function checkEgressUrl(raw: string, opts: EgressOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressRefused('malformed_url');
  }
  const allowHttp = privateAllowed(opts);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new EgressRefused('scheme_not_https');
  }
  if (url.username || url.password) throw new EgressRefused('userinfo_in_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isForbiddenAddress(host) && !privateAllowed(opts)) {
    throw new EgressRefused('forbidden_address');
  }
  return url;
}

/** A socket `lookup` that refuses forbidden resolved addresses at connect time. */
function guardedLookup(opts: EgressOptions): LookupFunction {
  return ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as LookupAddress[];
      if (list.length === 0) return callback(new EgressRefused('no_address'));
      if (!privateAllowed(opts) && list.some((a) => isForbiddenAddress(a.address))) {
        return callback(new EgressRefused('forbidden_address'));
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

export interface EgressResponse {
  status: number;
}

/**
 * POST `body` to `rawUrl` under the egress policy. Resolves with the status
 * (a 3xx is returned as-is and NOT followed); rejects with EgressRefused on a
 * policy violation, or a network/timeout error.
 */
export function guardedPost(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  opts: EgressOptions = {},
): Promise<EgressResponse> {
  const url = checkEgressUrl(rawUrl, opts);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxResponseBytes ?? 64 * 1024;
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise<EgressResponse>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: guardedLookup(opts),
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > maxBytes) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('egress_timeout')), timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    req.on('timeout', () => req.destroy(new Error('egress_timeout')));
    req.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.on('close', () => clearTimeout(deadline));
    req.end(body);
  });
}
