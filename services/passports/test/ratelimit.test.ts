/**
 * G-5: the management-plane RateLimiter has bounded memory (LRU max-keys + TTL
 * eviction), normalises and length-caps keys, and pre-auth buckets are keyed
 * only by a well-formed client id (anything else shares one bucket).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMITER_MAX_KEYS, RateLimiter, normalizeRateKey } from '../src/lib.ts';
import { UNRECOGNISED_CLIENT_BUCKET, preAuthClientKey } from '../src/app.ts';

test('1e6 distinct attacker-chosen keys: the map stays bounded by maxKeys', () => {
  const rl = new RateLimiter(30, 60_000);
  for (let i = 0; i < 1_000_000; i++) rl.take(`attacker-${i}`);
  assert.ok(rl.size <= RATE_LIMITER_MAX_KEYS, `size ${rl.size}`);
  assert.ok(rl.size >= RATE_LIMITER_MAX_KEYS * 0.9, 'recent keys are still tracked');
});

test('2e5 distinct keys of 10 KB each: keys are length-capped, map bounded', () => {
  const rl = new RateLimiter(30, 60_000, { maxKeys: 1000 });
  const pad = 'A'.repeat(10_000);
  for (let i = 0; i < 200_000; i++) rl.take(`${i}${pad}`);
  assert.ok(rl.size <= 1000);
  assert.ok(normalizeRateKey(pad).length <= 129);
});

test('TTL eviction: idle buckets are dropped once they would be full again', () => {
  let now = 1_000_000;
  const rl = new RateLimiter(5, 1000, { now: () => now });
  for (let i = 0; i < 100; i++) rl.take(`k${i}`);
  assert.equal(rl.size, 100);
  now += 999;
  rl.take('fresh');
  assert.equal(rl.size, 101, 'nothing expired yet');
  now += 2;
  rl.take('fresh');
  assert.equal(rl.size, 1, 'the 100 idle buckets were swept; the recently used one stays');
});

test('LRU: under a flood far beyond the cap, a key in active use keeps its (depleted) state', () => {
  const rl = new RateLimiter(3, 60_000, { maxKeys: 50 });
  for (let i = 0; i < 3; i++) assert.equal(rl.take('victim').allowed, true);
  for (let i = 0; i < 5000; i++) {
    rl.take(`noise-${i}`);
    if (i % 10 === 0) assert.equal(rl.take('victim').allowed, false, `victim reset at ${i}`);
    assert.ok(rl.size <= 50);
  }
});

test('limits still apply exactly; normalisation merges spellings of one key', () => {
  const rl = new RateLimiter(2, 60_000);
  assert.equal(rl.take('cid_X').allowed, true);
  assert.equal(rl.take('cid_X​').allowed, true, 'zero-width suffix maps to the same bucket');
  assert.equal(rl.take(' cid_X\n').allowed, false);
  assert.equal(normalizeRateKey(''), '(empty)');
  assert.equal(normalizeRateKey('é'), 'é', 'NFC');
});

test('pre-auth key: only a well-formed cid_<ULID> gets its own bucket', () => {
  const good = 'cid_01J0ABCDEFGHJKMNPQRSTVWXYZ';
  assert.equal(preAuthClientKey(good), good);
  for (const bad of [undefined, null, '', 'cid_short', 'x'.repeat(5000), 'cid_01j0abcdefghjkmnpqrstvwxyz', `${good} `, 42, { a: 1 }]) {
    assert.equal(preAuthClientKey(bad), UNRECOGNISED_CLIENT_BUCKET, String(bad).slice(0, 20));
  }
});
