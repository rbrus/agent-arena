/**
 * One `NetContext` per target: the policy derived from the URL the user typed,
 * the origin credentials are bound to, the per-origin limiter, and the guarded
 * `lookup` every socket of every transport uses. Nothing here is global: two
 * contexts never share a socket, a credential or a DNS answer.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { addressVerdict, bareHost, exactOrigin, NetBlockedError, originOf, type NetPolicy } from './guard.ts';
import { RateLimiter } from './politeness.ts';

/** Resolve every address for a name (all families). Injectable for the rebinding tests. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });

export interface Credential {
  /** Header name, e.g. `Authorization` or the user's `X-Api-Key`. */
  header: string;
  /** Full header value (`Bearer …` for the bearer scheme). Never logged: the redactor knows it. */
  value: string;
}

/**
 * What the runner observed when it connected (contracts 2.2.0 `run.hosted.observed_connections`,
 * threat-model-hosted §5.2): per origin and leaf certificate, the peer addresses actually dialed
 * and the SHA-256 of the leaf certificate's SubjectPublicKeyInfo.
 */
export interface ObservedConnection {
  origin: string;
  addresses: string[];
  spki_sha256: string;
}

/** Contract caps (report.schema.json): 16 entries, 8 addresses each. */
const MAX_OBSERVED = 16;
const MAX_OBSERVED_ADDRESSES = 8;

export interface NetContextOptions {
  policy: NetPolicy;
  /** The URL the user typed. Credentials are attached ONLY to its exact origin (C-5). */
  target: URL;
  credential?: Credential;
  userAgent: string;
  runId: string;
  rps: number;
  followRedirects?: boolean;
  /** Called once per NEW socket that needed an opt-in (loopback / private / link-local). */
  onOptIn?: (line: string) => void;
  resolver?: Resolver;
  /**
   * G-45 (hosted runs): called with every address a lookup returned and every peer address a
   * TLS socket connected to, so the hosted log filter can replace them in log lines.
   */
  onPeerAddress?: (address: string) => void;
}

/** A human label for `url` in an error: never the host under hosted-v1 (G-45), the origin otherwise. */
export function originLabel(policy: NetPolicy, url: URL): string {
  return policy.allowOrigins ? 'the verified origin' : url.origin;
}

export class NetContext {
  readonly policy: NetPolicy;
  readonly userOrigin: string;
  readonly userAgent: string;
  readonly runId: string;
  readonly limiter: RateLimiter;
  readonly followRedirects: boolean;
  /** Number of guarded lookups performed (one per new socket to a name). Test/diagnostic only. */
  lookups = 0;
  private readonly credential?: Credential;
  private readonly resolver: Resolver;
  private readonly onOptIn?: (line: string) => void;
  private readonly onPeerAddress?: (address: string) => void;
  /** G-55: set when an origin/key pair or an address was not recorded because a contract cap was reached. */
  private observedCut = false;
  private httpAgent?: HttpAgent;
  private httpsAgent?: HttpsAgent;
  /** origin + '\n' + spki → addresses (insertion order). Only TLS sockets are observed. */
  private readonly observedMap = new Map<string, { origin: string; spki: string; addresses: string[] }>();

  constructor(o: NetContextOptions) {
    this.policy = { ...o.policy };
    this.userOrigin = originOf(o.target);
    this.userAgent = o.userAgent;
    this.runId = o.runId;
    this.limiter = new RateLimiter(o.rps);
    // hosted-v1: no redirects, even same-origin ones; nothing the caller passes can turn them on.
    this.followRedirects = this.policy.allowOrigins ? false : !!o.followRedirects;
    this.credential = o.credential;
    this.resolver = o.resolver ?? systemResolver;
    this.onOptIn = o.onOptIn;
    this.onPeerAddress = o.onPeerAddress;
  }

  /** The credential header for `url`, or nothing when `url` is not the user's origin. */
  credentialFor(url: URL): Record<string, string> {
    if (!this.credential) return {};
    if (originOf(url) !== this.userOrigin) return {};
    return { [this.credential.header]: this.credential.value };
  }

  /** Headers every request carries (§8.1 identifiable traffic). */
  baseHeaders(): Record<string, string> {
    return { 'user-agent': this.userAgent, 'x-agent-arena-run': this.runId };
  }

  /**
   * The `lookup` hook handed to `net.connect` for every socket (http, https, ws).
   * Resolves ALL addresses, refuses the connection if ANY is outside the policy
   * (mixed answers are refused), and connects to the address that was checked.
   */
  readonly lookup = (
    hostname: string,
    options: LookupOptions | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    const opts: LookupOptions = typeof options === 'number' ? { family: options } : (options ?? {});
    this.lookups++;
    const host = bareHost(hostname);
    this.resolver(host).then(
      (addrs) => {
        if (!addrs.length) return callback(Object.assign(new Error(`no address for ${this.policy.allowOrigins ? 'the verified origin' : host}`), { code: 'ENOTFOUND' }), '');
        if (this.onPeerAddress) for (const a of addrs) this.onPeerAddress(a.address);
        const optIns: string[] = [];
        for (const a of addrs) {
          const v = addressVerdict(a.address, this.policy);
          if (!v.allowed && this.policy.allowOrigins) {
            // hosted-v1 (errors.md target_forbidden): never says what the name resolved to, names no opt-in.
            // G-45: names neither the host nor what it resolved to (the text reaches the hosted log stream).
            const e = new NetBlockedError(host, a.address, v.cls, `target_forbidden: refused to connect to the verified origin: under the hosted-v1 network policy it must resolve to public addresses only.`);
            return callback(e as unknown as NodeJS.ErrnoException, '');
          }
          if (!v.allowed) {
            const e = new NetBlockedError(host, a.address, v.cls, `refused to connect to ${host}: it resolves to ${a.address} (${v.cls.replace('_', '-')}). A hostname that resolves to a private address stays blocked. Next: use the literal address, or pass --allow-private${v.cls === 'link_local' ? ' / --allow-link-local' : ''} if this is really your agent.`);
            return callback(e as unknown as NodeJS.ErrnoException, '');
          }
          if (v.optIn) optIns.push(`${a.address} (${v.cls.replace('_', '-')})`);
        }
        if (optIns.length && this.onOptIn) this.onOptIn(`opt-in connection to ${host} -> ${optIns.join(', ')}`);
        const fam = opts.family === 4 || opts.family === 6 ? opts.family : 0;
        const pool = fam ? addrs.filter((a) => a.family === fam) : addrs;
        if (!pool.length) return callback(Object.assign(new Error(`no IPv${fam} address for ${this.policy.allowOrigins ? 'the verified origin' : host}`), { code: 'ENOTFOUND' }), '');
        if (opts.all) return callback(null, pool.map((a) => ({ address: a.address, family: a.family })));
        return callback(null, pool[0].address, pool[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };

  agentFor(url: URL): HttpAgent | HttpsAgent {
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    // Own agents: never the global agent, so no proxy configuration applies (N-4),
    // and every new socket goes through `lookup` (N-2). keepAlive reuses only
    // sockets whose address was already checked.
    if (secure) {
      this.httpsAgent ??= new HttpsAgent({ keepAlive: true, maxSockets: 4, lookup: this.lookup as never });
      return this.httpsAgent;
    }
    this.httpAgent ??= new HttpAgent({ keepAlive: true, maxSockets: 4, lookup: this.lookup as never });
    return this.httpAgent;
  }

  /**
   * Record the peer of a TLS socket for `url` (called by client.ts / ws-client.ts on
   * every socket they use; a reused keep-alive socket adds nothing new). Plain sockets
   * and sockets without a peer certificate are ignored.
   */
  observe(url: URL, socket: Socket | TLSSocket | null | undefined): void {
    const tls = socket as TLSSocket | null | undefined;
    if (!tls || typeof tls.getPeerX509Certificate !== 'function') return;
    /** false = no peer certificate yet (handshake pending). */
    const record = (): boolean => {
      let spki: string;
      try {
        const cert = tls.getPeerX509Certificate();
        if (!(cert instanceof X509Certificate)) return false;
        spki = `sha256:${createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
      } catch {
        return false;
      }
      // v4-mapped IPv6 (`::ffff:203.0.113.10`) is recorded as the IPv4 address (contract address pattern).
      const address = typeof tls.remoteAddress === 'string' ? tls.remoteAddress.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '') : undefined;
      if (address && this.onPeerAddress) this.onPeerAddress(address);
      const origin = exactOrigin(url).replace(/:443$/, '');
      const key = `${origin}\n${spki}`;
      let e = this.observedMap.get(key);
      if (!e) {
        if (this.observedMap.size >= MAX_OBSERVED) {
          // G-55: never silently: the list is marked incomplete.
          this.observedCut = true;
          return true;
        }
        e = { origin, spki, addresses: [] };
        this.observedMap.set(key, e);
      }
      if (address && !e.addresses.includes(address)) {
        if (e.addresses.length < MAX_OBSERVED_ADDRESSES) e.addresses.push(address);
        else this.observedCut = true;
      }
      return true;
    };
    if (!record()) tls.once('secureConnect', () => void record());
  }

  /** Observed connections so far, in first-seen order; entries without an address are dropped (contract minItems 1). */
  observedConnections(): ObservedConnection[] {
    return [...this.observedMap.values()].filter((e) => e.addresses.length > 0).map((e) => ({ origin: e.origin, addresses: [...e.addresses], spki_sha256: e.spki }));
  }

  /**
   * G-55: true when the contract caps (16 origin/key pairs, 8 addresses each) cut the
   * observed list, i.e. `observedConnections()` is incomplete. The hosted runner reports it.
   */
  observedTruncated(): boolean {
    return this.observedCut;
  }

  close(): void {
    this.httpAgent?.destroy();
    this.httpsAgent?.destroy();
  }
}
