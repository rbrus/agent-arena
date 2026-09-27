/**
 * FUZZ-EDGE GUARDS (Phase 5 B5 — resilience-and-review.md §1.6, F1–F7).
 *
 * The enumerated edge-hardening invariants, proven over the reusable guards the
 * untrusted edges (play, raid, negotiation) apply BEFORE any engine/store work:
 *   - AJV-before-processing + layered size caps: a too-large / unparseable /
 *     too-deep frame is rejected at the edge; the engine (here, a spy) is never
 *     invoked.
 *   - Anti-replay: a nonce is accepted exactly once; memory is bounded.
 *   - Constant-time compare: no early exit on the first differing position.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardFrame,
  jsonDepth,
  SubmissionNonceGuard,
  constantTimeEqual,
} from '../src/edgeguard.ts';


test('layered guard rejects at the edge; the engine is NEVER touched on a bad frame', () => {
  let engineCalls = 0;
  const validate = (): boolean => {
    engineCalls += 1; // stands in for "any engine/store work"
    return true;
  };

  // Too large → rejected BEFORE parse/validate (AJV-before-processing ordering).
  const big = JSON.stringify({ t: 'x', pad: 'a'.repeat(5000) });
  assert.equal(guardFrame(big, { maxBytes: 256, validate }).reason, 'too_large');

  // Unparseable → rejected before validate.
  assert.equal(guardFrame('{not json', { maxBytes: 256, validate }).reason, 'unparseable');

  // Deeply-nested "billion-laughs" body → rejected cheaply before validate.
  let deep = '0';
  for (let i = 0; i < 100; i++) deep = `[${deep}]`;
  assert.equal(guardFrame(deep, { maxBytes: 4096, maxDepth: 32, validate }).reason, 'too_deep');

  assert.equal(engineCalls, 0, 'validate/engine never invoked on a rejected frame');

  // A well-formed small frame reaches validate exactly once and passes.
  const ok = guardFrame(JSON.stringify({ t: 'caster.say', text: 'gg' }), { maxBytes: 256, validate });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, 'ok');
  assert.equal(engineCalls, 1, 'validate invoked only for the accepted frame');

  // A schema-invalid frame is rejected AFTER the cheap layers (validate says no).
  const bad = guardFrame(JSON.stringify({ t: 'nope' }), { maxBytes: 256, validate: () => false });
  assert.equal(bad.reason, 'schema_invalid');
});

test('jsonDepth measures nesting iteratively and bounds cheaply', () => {
  assert.equal(jsonDepth(5, 32), 1);
  assert.equal(jsonDepth({ a: { b: { c: 1 } } }, 32), 4);
  assert.equal(jsonDepth([[[[]]]], 32), 4);
  // A pathological deep body short-circuits above the cap rather than scanning all.
  let deep: unknown = 0;
  for (let i = 0; i < 10_000; i++) deep = [deep];
  assert.ok(jsonDepth(deep, 32) > 32);
});

test('anti-replay: a nonce is accepted exactly once; memory is bounded', () => {
  const guard = new SubmissionNonceGuard(2);
  assert.equal(guard.accept('n1'), true);
  assert.equal(guard.accept('n1'), false, 'replay rejected');
  assert.equal(guard.accept('n2'), true);
  // Bounded memory: adding a third key evicts the oldest (n1).
  assert.equal(guard.accept('n3'), true);
  assert.equal(guard.has('n1'), false, 'oldest key evicted under the cap');
  assert.equal(guard.accept('n2'), false, 'n2 still remembered (rejected on replay)');
});

test('constantTimeEqual: length- and position-independent equality', () => {
  assert.equal(constantTimeEqual('abcabc', 'abcabc'), true);
  assert.equal(constantTimeEqual('abcabc', 'abcabd'), false); // differ at the end
  assert.equal(constantTimeEqual('abcabc', 'xbcabc'), false); // differ at the start
  assert.equal(constantTimeEqual('abc', 'abcdef'), false); // length differs
});
