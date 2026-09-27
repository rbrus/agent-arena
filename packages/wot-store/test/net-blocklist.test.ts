/**
 * G-25: the ONE outbound address blocklist. Table-driven: every range the
 * threat model names (§2.1) with an inside and an edge address, plus the
 * public neighbours just outside each range, plus parity with the CLI guard
 * (which imports this module since the G-25 residual fix).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NET_BLOCKLIST, classifyAddress, isForbiddenAddress, type AddressClass } from '../src/net-blocklist.ts';
import * as viaIndex from '../src/index.ts';
import { checkEgressUrl, EgressRefused } from '../src/egress.ts';

const TABLE: ReadonlyArray<[string, AddressClass, string]> = [
  // IPv4
  ['127.0.0.1', 'loopback', 'loopback'],
  ['127.255.255.254', 'loopback', 'loopback edge'],
  ['169.254.169.254', 'link_local', 'cloud metadata'],
  ['10.0.0.1', 'private', 'RFC 1918 /8'],
  ['172.16.0.1', 'private', 'RFC 1918 /12 low'],
  ['172.31.255.255', 'private', 'RFC 1918 /12 high'],
  ['192.168.1.1', 'private', 'RFC 1918 /16'],
  ['100.64.0.1', 'private', 'CGNAT low'],
  ['100.127.255.254', 'private', 'CGNAT high'],
  ['0.0.0.0', 'reserved', 'unspecified'],
  ['0.1.2.3', 'reserved', 'this network'],
  ['192.0.0.8', 'reserved', 'IETF assignments'],
  ['192.0.2.1', 'reserved', 'TEST-NET-1'],
  ['192.88.99.1', 'reserved', '6to4 relay anycast'],
  ['198.18.0.1', 'reserved', 'benchmarking low'],
  ['198.19.255.254', 'reserved', 'benchmarking high'],
  ['198.51.100.1', 'reserved', 'TEST-NET-2'],
  ['203.0.113.1', 'reserved', 'TEST-NET-3'],
  ['224.0.0.1', 'reserved', 'multicast low'],
  ['239.255.255.250', 'reserved', 'multicast SSDP'],
  ['240.0.0.1', 'reserved', 'class E'],
  ['255.255.255.255', 'reserved', 'broadcast'],
  // public v4 neighbours just outside blocked ranges
  ['8.8.8.8', 'public', 'public'],
  ['100.63.255.255', 'public', 'below CGNAT'],
  ['100.128.0.0', 'public', 'above CGNAT'],
  ['172.32.0.1', 'public', 'above 172.16/12'],
  ['198.17.255.255', 'public', 'below benchmarking'],
  ['198.20.0.0', 'public', 'above benchmarking'],
  ['223.255.255.255', 'public', 'below multicast'],
  // IPv6
  ['::1', 'loopback', 'v6 loopback'],
  ['::', 'reserved', 'v6 unspecified'],
  ['fe80::1', 'link_local', 'v6 link-local'],
  ['fe80::1%eth0', 'link_local', 'v6 link-local with zone'],
  ['fd00:ec2::254', 'link_local', 'AWS IMDS v6'],
  ['fc00::1', 'private', 'ULA'],
  ['fd12:3456::1', 'private', 'ULA fd'],
  ['fec0::1', 'private', 'site-local (deprecated)'],
  ['ff02::1', 'reserved', 'v6 multicast'],
  ['2001:db8::1', 'reserved', 'documentation'],
  ['100::1', 'reserved', 'discard'],
  // IPv6 transition forms
  ['::ffff:8.8.8.8', 'ipv6_transition', 'v4-mapped public'],
  ['::ffff:127.0.0.1', 'ipv6_transition', 'v4-mapped loopback'],
  ['::ffff:7f00:1', 'ipv6_transition', 'v4-mapped loopback hex'],
  ['::ffff:169.254.169.254', 'link_local', 'v4-mapped metadata inherits link-local'],
  ['::ffff:224.0.0.1', 'reserved', 'v4-mapped multicast inherits reserved'],
  ['::127.0.0.1', 'ipv6_transition', 'v4-compatible'],
  ['64:ff9b::808:808', 'ipv6_transition', 'NAT64'],
  ['64:ff9b::a9fe:a9fe', 'link_local', 'NAT64 metadata inherits link-local'],
  ['64:ff9b:1::808:808', 'ipv6_transition', 'NAT64 local-use'],
  ['64:ff9b:1::1', 'reserved', 'NAT64 local-use embedding 0.0.0.1 inherits reserved'],
  ['2002:808:808::1', 'ipv6_transition', '6to4'],
  ['2002:a9fe:a9fe::1', 'link_local', '6to4 metadata inherits link-local'],
  ['2001:0:4136:e378:8000:63bf:f7f7:f7f7', 'ipv6_transition', 'Teredo client 8.8.8.8'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved', 'RFC 4380 example: Teredo client 192.0.2.45 inherits reserved'],
  ['2001::1', 'reserved', 'Teredo prefix; client xor gives 255.255.255.254 (reserved)'],
  ['2001:0:0:0:0:0:5601:5601', 'link_local', 'Teredo client 169.254.169.254 (xor 0xff)'],
  // public v6
  ['2606:4700::1111', 'public', 'public v6'],
  ['2a00:1450:4001:80b::200e', 'public', 'public v6'],
  ['2001:1::1', 'public', 'just above Teredo /32'],
  ['2003::1', 'public', 'just above 6to4 /16'],
  // garbage fails closed
  ['not-an-ip', 'reserved', 'not an address'],
  ['', 'reserved', 'empty'],
  ['1.2.3', 'reserved', 'short v4'],
];

test('net-blocklist: table-driven classification of every §2.1 range', () => {
  for (const [ip, cls, why] of TABLE) {
    assert.equal(classifyAddress(ip), cls, `${ip} (${why})`);
    assert.equal(isForbiddenAddress(ip), cls !== 'public', `${ip} forbidden? (${why})`);
  }
});

test('net-blocklist: the table names Teredo, 6to4, CGNAT, benchmarking, multicast, unspecified, v4-mapped and NAT64', () => {
  const cidrs = new Set(NET_BLOCKLIST.map((e) => e.cidr));
  for (const c of ['2001::/32', '2002::/16', '100.64.0.0/10', '198.18.0.0/15', '224.0.0.0/4', 'ff00::/8', '0.0.0.0/8', '::/128', '::ffff:0:0/96', '64:ff9b::/96']) {
    assert.ok(cidrs.has(c), `blocklist must contain ${c}`);
  }
  assert.ok(Object.isFrozen(NET_BLOCKLIST));
});

test('net-blocklist: wot-store re-exports it and egress.ts uses it (no second copy)', () => {
  assert.equal(viaIndex.classifyAddress, classifyAddress);
  assert.equal(viaIndex.isForbiddenAddress, isForbiddenAddress);
  assert.equal(viaIndex.NET_BLOCKLIST, NET_BLOCKLIST);
  // A Teredo literal was the G-25 gap in the old egress copy.
  assert.throws(() => checkEgressUrl('https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/hook'), (e: unknown) => e instanceof EgressRefused && e.reason === 'forbidden_address');
  assert.throws(() => checkEgressUrl('https://[2002:808:808::1]/hook'), (e: unknown) => e instanceof EgressRefused && e.reason === 'forbidden_address');
  assert.throws(() => checkEgressUrl('https://100.64.1.1/hook'), (e: unknown) => e instanceof EgressRefused && e.reason === 'forbidden_address');
});

test('net-blocklist: parity with arena-cli net/guard.ts (the CLI imports this module; zero allowed differences)', async () => {
  const guard = (await import('../../arena-cli/src/net/guard.ts')) as { classifyAddress(ip: string): string };
  assert.equal(guard.classifyAddress, classifyAddress, 'the CLI guard must re-export the shared classifier, not a copy');
  for (const [ip] of TABLE) assert.equal(guard.classifyAddress(ip), classifyAddress(ip), `divergence on ${ip}`);
});
