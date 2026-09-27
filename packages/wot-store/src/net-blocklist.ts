/**
 * THE outbound address blocklist (threat-model-arena §2.1; finding G-25).
 *
 * One table, one classifier, zero dependencies beyond `node:net`, so every
 * egress path in the repo can share it:
 *   - `wot-store/src/egress.ts` (webhook delivery);
 *   - `arena-cli/src/net/guard.ts` (every CLI target connection) imports it as
 *     `wot-store/net-blocklist` (a dependency-free subpath export, bundled into
 *     the CLI by esbuild); the CLI keeps no copy of its own (G-25 closed). The
 *     table-driven test in `wot-store/test/net-blocklist.test.ts` pins the
 *     classification both use.
 *
 * Classes, most to least permissive:
 *   public            dialable
 *   ipv6_transition   v4-mapped, v4-compatible, NAT64 (64:ff9b::/96, 64:ff9b:1::/48),
 *                     6to4 (2002::/16), Teredo (2001::/32): they tunnel to an IPv4
 *                     the resolver chose, so they are never "public"
 *   private           RFC 1918, CGNAT 100.64.0.0/10, ULA fc00::/7
 *   loopback          127/8, ::1
 *   link_local        169.254/16 (cloud metadata), fe80::/10, fd00:ec2::254
 *   reserved          unspecified, "this network", documentation, benchmarking
 *                     198.18.0.0/15, 6to4 relay anycast, multicast, 240/4,
 *                     broadcast, discard 100::/64, and anything unparseable
 *
 * A transition form whose embedded IPv4 is link-local or reserved inherits that
 * stricter class (`::ffff:169.254.169.254` is link_local), so a policy that
 * opts into private ranges never admits cloud metadata through a v6 wrapper.
 *
 * CIDR logic is byte arithmetic over parsed addresses (no regex IP matching).
 */

import { isIP } from 'node:net';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'reserved'
  | 'ipv6_transition';

export interface BlocklistEntry {
  readonly cidr: string;
  readonly cls: Exclude<AddressClass, 'public'>;
  readonly note: string;
}

/**
 * The blocklist, IPv4 then IPv6. First match wins within a family; narrow
 * classes are listed first. Exported read-only so callers and docs can render it.
 */
export const NET_BLOCKLIST: ReadonlyArray<BlocklistEntry> = Object.freeze([
  // IPv4
  { cidr: '127.0.0.0/8', cls: 'loopback', note: 'loopback' },
  { cidr: '169.254.0.0/16', cls: 'link_local', note: 'link-local, cloud metadata' },
  { cidr: '10.0.0.0/8', cls: 'private', note: 'RFC 1918' },
  { cidr: '172.16.0.0/12', cls: 'private', note: 'RFC 1918' },
  { cidr: '192.168.0.0/16', cls: 'private', note: 'RFC 1918' },
  { cidr: '100.64.0.0/10', cls: 'private', note: 'CGNAT (RFC 6598)' },
  { cidr: '0.0.0.0/8', cls: 'reserved', note: 'unspecified / this network' },
  { cidr: '192.0.0.0/24', cls: 'reserved', note: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', cls: 'reserved', note: 'TEST-NET-1' },
  { cidr: '192.88.99.0/24', cls: 'reserved', note: '6to4 relay anycast' },
  { cidr: '198.18.0.0/15', cls: 'reserved', note: 'benchmarking (RFC 2544)' },
  { cidr: '198.51.100.0/24', cls: 'reserved', note: 'TEST-NET-2' },
  { cidr: '203.0.113.0/24', cls: 'reserved', note: 'TEST-NET-3' },
  { cidr: '224.0.0.0/4', cls: 'reserved', note: 'multicast' },
  { cidr: '240.0.0.0/4', cls: 'reserved', note: 'reserved + limited broadcast' },
  // IPv6
  { cidr: '::1/128', cls: 'loopback', note: 'loopback' },
  { cidr: '::/128', cls: 'reserved', note: 'unspecified' },
  { cidr: 'fe80::/10', cls: 'link_local', note: 'link-local' },
  { cidr: 'fd00:ec2::254/128', cls: 'link_local', note: 'AWS IMDS over IPv6' },
  { cidr: 'fec0::/10', cls: 'private', note: 'site-local (deprecated)' },
  { cidr: 'fc00::/7', cls: 'private', note: 'unique local' },
  { cidr: '::ffff:0:0/96', cls: 'ipv6_transition', note: 'IPv4-mapped' },
  { cidr: '64:ff9b::/96', cls: 'ipv6_transition', note: 'NAT64 well-known prefix' },
  { cidr: '64:ff9b:1::/48', cls: 'ipv6_transition', note: 'NAT64 local-use' },
  { cidr: '2001::/32', cls: 'ipv6_transition', note: 'Teredo' },
  { cidr: '2002::/16', cls: 'ipv6_transition', note: '6to4' },
  { cidr: '::/96', cls: 'ipv6_transition', note: 'IPv4-compatible (deprecated)' },
  { cidr: '100::/64', cls: 'reserved', note: 'discard-only' },
  { cidr: '2001:db8::/32', cls: 'reserved', note: 'documentation' },
  { cidr: 'ff00::/8', cls: 'reserved', note: 'multicast' },
] as const);

// ───────────────────────────── address parsing ─────────────────────────────

function v4Bytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes for any valid IPv6 text (with optional embedded IPv4 tail and zone). */
function v6Bytes(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const b = v4Bytes(maybeV4);
    if (!b) return null;
    tail = b;
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split('::');
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)));
  const head = parse(halves[0]);
  const rest = halves.length > 1 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  const groups = halves.length > 1 ? [...head, ...new Array<number>(fill).fill(0), ...rest] : head;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

interface Cidr {
  bytes: number[];
  bits: number;
  cls: Exclude<AddressClass, 'public'>;
}

function toCidr(e: BlocklistEntry): Cidr {
  const [a, b] = e.cidr.split('/');
  const bytes = a.includes(':') ? v6Bytes(a) : v4Bytes(a);
  if (!bytes) throw new Error(`net-blocklist: bad CIDR ${e.cidr}`);
  return { bytes, bits: Number(b), cls: e.cls };
}

const V4: Cidr[] = NET_BLOCKLIST.filter((e) => !e.cidr.includes(':')).map(toCidr);
const V6: Cidr[] = NET_BLOCKLIST.filter((e) => e.cidr.includes(':')).map(toCidr);

function inCidr(addr: number[], c: Cidr): boolean {
  if (addr.length !== c.bytes.length) return false;
  let bits = c.bits;
  for (let i = 0; i < addr.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((addr[i] & mask) !== (c.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

const RANK: Record<AddressClass, number> = { public: 0, ipv6_transition: 1, private: 2, loopback: 2, link_local: 3, reserved: 4 };

/** The IPv4 address a v6 transition form embeds (mapped, compat, NAT64, 6to4, Teredo). */
export function embeddedV4(b: number[]): number[] | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16); // ::ffff:a.b.c.d
  if (zero(0, 12)) return b.slice(12, 16); // ::a.b.c.d (deprecated compat)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return b.slice(12, 16); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return b.slice(12, 16).map((x) => x ^ 0xff); // Teredo client
  return null;
}

function classifyV4(b: number[]): AddressClass {
  if (b.every((x) => x === 255)) return 'reserved';
  for (const c of V4) if (inCidr(b, c)) return c.cls;
  return 'public';
}

/**
 * Classify one IP address literal. Anything that is not a valid IPv4/IPv6
 * literal is `reserved` (fail closed).
 */
export function classifyAddress(ip: string): AddressClass {
  const fam = isIP(ip.split('%')[0]);
  if (fam === 4) {
    const b = v4Bytes(ip);
    return b ? classifyV4(b) : 'reserved';
  }
  if (fam !== 6) return 'reserved';
  const b = v6Bytes(ip);
  if (!b) return 'reserved';
  let cls: AddressClass = 'public';
  for (const c of V6) {
    if (inCidr(b, c)) {
      cls = c.cls;
      break;
    }
  }
  if (cls === 'ipv6_transition') {
    const e = embeddedV4(b);
    if (e) {
      // Inherit only a STRICTER inner class (link-local, reserved).
      const inner = classifyV4(e);
      if (RANK[inner] > RANK.private) cls = inner;
    }
  }
  return cls;
}

/**
 * True unless the address is plainly `public`. The strict policy for any
 * server-side egress to a user-supplied URL (webhooks, hosted runner): every
 * non-public class, including all IPv6 transition forms, is refused.
 */
export function isForbiddenAddress(ip: string): boolean {
  return classifyAddress(ip) !== 'public';
}
