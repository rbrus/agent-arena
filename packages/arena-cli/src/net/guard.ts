/**
 * The outbound address policy (docs/security/threat-model-arena.md §2.1). The
 * blocklist is the shared `wot-store/net-blocklist` (G-25; no local copy). Every
 * transport reaches the network through
 * `net/client.ts` / `net/ws-client.ts`, which call `checkAddress` inside the
 * socket's `lookup` hook (every new connection, every returned address) and
 * `checkUrl` before dialing an IP literal (Node skips `lookup` for literals).
 *
 * Port of rbrus/redwire `ssrf` (resolve-and-check every address, pin at dial
 * time, no proxy), extended with the arena's loopback-literal rule (decision S1):
 * a loopback host TYPED by the user (`localhost`, `127.x.y.z`, `[::1]`) is an
 * explicit, logged, loopback-only opt-in; a hostname that merely resolves to a
 * private or loopback address stays blocked unless `--allow-private`.
 *
 * CIDR logic (in the shared module) is byte arithmetic over parsed addresses;
 * the WHATWG URL parser normalises `0177.0.0.1`, `2130706433`, `0x7f.1` first.
 */

import { isIP } from 'node:net';
import { classifyAddress, type AddressClass } from 'wot-store/net-blocklist';

// G-25: the blocklist and the classifier are THE shared ones (`wot-store/net-blocklist`,
// dependency-free, also used by webhook egress). No local copy: a range added there
// (fec0::/10 was the last drift) applies to the CLI in the same change.
export { classifyAddress, type AddressClass };

export interface NetPolicy {
  /** `--allow-private`: loopback / RFC 1918 / ULA / CGNAT / v6 transition forms, logged per connection. */
  allowPrivate: boolean;
  /** `--allow-link-local`: link-local incl. cloud metadata. Separate flag on purpose (§2.1). */
  allowLinkLocal: boolean;
  /** Set when the user TYPED a loopback host (S1): loopback addresses only, nothing else private. */
  loopbackLiteral: boolean;
  /**
   * Hosted mode only (`hosted-v1`, threat-model-hosted §2.1/§2.3): the ONLY origins
   * (`scheme://host:port`, default port explicit, see `exactOrigin`) this run may dial.
   * Set = allowlist mode: every URL outside it is refused before any socket, and only
   * https/wss are allowed. Never set by a flag; built from the signed run manifest.
   */
  allowOrigins?: readonly string[];
}

export const DEFAULT_POLICY: Readonly<NetPolicy> = Object.freeze({ allowPrivate: false, allowLinkLocal: false, loopbackLiteral: false });

/** The frozen hosted network policy id (hosted_context `net_policy`). */
export const HOSTED_NET_POLICY = 'hosted-v1';

/**
 * `hosted-v1`: public unicast only (no loopback, typed or not; no private, link-local,
 * metadata or reserved address), https/wss only, allowlist of the manifest's origins,
 * no redirects (NetContext forces `followRedirects: false` when `allowOrigins` is set).
 * No field comes from a flag, a RunSpec or the environment.
 */
export function hostedPolicy(origins: readonly string[]): NetPolicy {
  if (!origins.length) throw new Error('hosted-v1 needs at least one allowlisted origin');
  return Object.freeze({ allowPrivate: false, allowLinkLocal: false, loopbackLiteral: false, allowOrigins: Object.freeze([...origins]) });
}

/**
 * The exact origin of a URL for the hosted allowlist: the scheme as written
 * (https and wss are NOT folded together), the lower-case host, and the port with
 * the default (443 for https/wss, 80 for http/ws) made explicit.
 */
export function exactOrigin(url: URL): string {
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  return `${url.protocol}//${bareHost(url.hostname).toLowerCase()}:${port}`;
}

/** Is `url` on the hosted allowlist? An https origin also admits wss on the same host and port (the WebSocket upgrade is an HTTPS request) and vice versa. */
export function originAllowlisted(url: URL, origins: readonly string[]): boolean {
  const o = exactOrigin(url);
  const twin = o.startsWith('wss:') ? `https:${o.slice(4)}` : o.startsWith('https:') ? `wss:${o.slice(6)}` : o;
  return origins.includes(o) || origins.includes(twin);
}

export class NetBlockedError extends Error {
  readonly code = 'EARENA_BLOCKED';
  constructor(
    readonly host: string,
    readonly address: string | null,
    readonly addressClass: AddressClass | 'name' | 'scheme' | 'userinfo',
    message: string,
  ) {
    super(message);
    this.name = 'NetBlockedError';
  }
}

/** Why an address is (not) allowed under a policy. `null` = allowed. */
export function addressVerdict(ip: string, policy: NetPolicy): { cls: AddressClass; allowed: boolean; optIn: boolean } {
  const cls = classifyAddress(ip);
  switch (cls) {
    case 'public':
      return { cls, allowed: true, optIn: false };
    case 'loopback':
      return { cls, allowed: policy.loopbackLiteral || policy.allowPrivate, optIn: true };
    case 'private':
    case 'ipv6_transition':
      return { cls, allowed: policy.allowPrivate, optIn: true };
    case 'link_local':
      return { cls, allowed: policy.allowLinkLocal, optIn: true };
    default:
      return { cls, allowed: false, optIn: false };
  }
}

const HINT: Record<AddressClass, string> = {
  public: '',
  loopback: 'type the loopback address literally (http://127.0.0.1:PORT or http://localhost:PORT) or pass --allow-private',
  private: 'pass --allow-private if you really mean to test an agent on your private network',
  ipv6_transition: 'IPv6 transition forms (v4-mapped, NAT64, 6to4, Teredo) need --allow-private',
  link_local: 'link-local and cloud-metadata addresses need --allow-link-local (not implied by --allow-private)',
  reserved: 'multicast, broadcast, documentation and reserved ranges are never dialed',
};

export function checkAddress(host: string, ip: string, policy: NetPolicy): void {
  const v = addressVerdict(ip, policy);
  if (!v.allowed) {
    if (policy.allowOrigins) {
      // errors.md target_forbidden: never says what the address was, and names no opt-in (hosted-v1 has none).
      // G-45: hosted-v1 texts reach the hosted job's log stream; they name neither the host nor the address.
      throw new NetBlockedError(host, ip, v.cls, `target_forbidden: refused to connect to the verified origin: the hosted-v1 network policy dials public unicast addresses only. Next: the verified origin must resolve to public addresses only; fix its DNS and start a new run.`);
    }
    throw new NetBlockedError(host, ip, v.cls, `refused to connect to ${host} (${ip}): ${v.cls.replace('_', '-')} address. Next: ${HINT[v.cls]}.`);
  }
}

// ───────────────────────────── names and URLs ─────────────────────────────

const LOOPBACK_NAMES = new Set(['localhost']);
const PRIVATE_NAMES = (h: string) => h === 'localhost.localdomain' || h.endsWith('.localhost');
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data']);

/** Strip IPv6 brackets from a WHATWG `hostname`. */
export function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Did the user TYPE a loopback host (decision S1)? Only `localhost`, an IPv4 in 127/8, or `::1`. */
export function isLoopbackLiteral(url: URL): boolean {
  const h = bareHost(url.hostname).toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  const fam = isIP(h);
  // IPv4 127/8, or IPv6 ::1 in any spelling (::1/128 is the only v6 loopback class).
  return fam !== 0 && classifyAddress(h) === 'loopback';
}

const SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Pre-dial URL check: scheme allowlist, no userinfo, name blocklist, and the
 * full address check for IP literals (Node does not call `lookup` for them).
 * Hostnames are checked again, per resolved address, inside `lookup`.
 */
export function checkUrl(url: URL, policy: NetPolicy): void {
  if (policy.allowOrigins) {
    // hosted-v1 (threat-model-hosted §2.3): TLS schemes only, allowlisted origins only, then the full address rules below.
    if (url.protocol !== 'https:' && url.protocol !== 'wss:') {
      throw new NetBlockedError(url.hostname, null, 'scheme', `refused ${url.protocol}// under the hosted-v1 network policy: only https and wss are dialed.`);
    }
    if (!originAllowlisted(url, policy.allowOrigins)) {
      // G-45: neither the foreign origin (it may be a customer's other host) nor the allowlist is printed.
      throw new NetBlockedError(url.hostname, null, 'name', `target_forbidden: refused a URL that is not on the verified origin of this run (hosted-v1 allowlist: the verified origin only). Nothing was sent there.`);
    }
    const h = bareHost(url.hostname).toLowerCase();
    if (LOOPBACK_NAMES.has(h) || PRIVATE_NAMES(h) || METADATA_NAMES.has(h)) {
      throw new NetBlockedError(h, null, 'name', `target_forbidden: refused the verified origin: its host is a local or metadata name, which is never dialed under the hosted-v1 network policy, even when allowlisted.`);
    }
  }
  if (!SCHEMES.has(url.protocol)) {
    throw new NetBlockedError(url.hostname, null, 'scheme', `refused scheme ${url.protocol} (allowed: http, https, ws, wss).`);
  }
  if (url.username || url.password) {
    throw new NetBlockedError(url.hostname, null, 'userinfo', 'refused a URL with user:password@ in it; use --auth env:NAME instead.');
  }
  const host = bareHost(url.hostname).toLowerCase();
  if (isIP(host)) {
    checkAddress(host, host, policy);
    return;
  }
  if (METADATA_NAMES.has(host)) {
    if (!policy.allowLinkLocal) throw new NetBlockedError(host, null, 'link_local', `refused ${host}: cloud metadata name. Next: ${HINT.link_local}.`);
    return;
  }
  if (LOOPBACK_NAMES.has(host)) {
    if (!policy.loopbackLiteral && !policy.allowPrivate) throw new NetBlockedError(host, null, 'loopback', `refused ${host}. Next: ${HINT.loopback}.`);
    return;
  }
  if (PRIVATE_NAMES(host) && !policy.allowPrivate) {
    throw new NetBlockedError(host, null, 'name', `refused ${host}: a local-only name. Next: ${HINT.private}.`);
  }
}

/** `scheme://host:port` with the default port made explicit (credential origin binding, C-5). */
export function originOf(url: URL): string {
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  const scheme = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return `${scheme}//${bareHost(url.hostname).toLowerCase()}:${port}`;
}

/** Policy for a user-typed target URL plus the user's flags. */
export function policyFor(target: URL, flags: { allowPrivate?: boolean; allowLinkLocal?: boolean }): NetPolicy {
  return {
    allowPrivate: !!flags.allowPrivate,
    allowLinkLocal: !!flags.allowLinkLocal,
    loopbackLiteral: isLoopbackLiteral(target),
  };
}

/** The report's `network_policy` stamp (threat model §2.1, S1). */
export function networkPolicyLabel(p: NetPolicy): string {
  if (p.allowOrigins) return HOSTED_NET_POLICY;
  const parts: string[] = [];
  if (p.loopbackLiteral) parts.push('loopback-literal');
  if (p.allowPrivate) parts.push('allow-private');
  if (p.allowLinkLocal) parts.push('allow-link-local');
  return parts.length ? parts.join('+') : 'public-only';
}
