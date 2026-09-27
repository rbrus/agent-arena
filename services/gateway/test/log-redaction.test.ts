/**
 * G-5 + G-6 for the gateway's copy of the management-plane helpers (lib.ts is
 * duplicated per service, ADR-000): redaction at depth and in header values,
 * errorHandler never logs a raw error message, and the limiter is bounded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateClientSecret, registerLogSecret } from 'wot-auth';
import { RATE_LIMITER_MAX_KEYS, RateLimiter, errorHandler, log, setLogSink } from '../src/lib.ts';

const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJjaWRfMDFKMFRFU1QifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2ln'; // EXAMPLE: synthetic value for this test, not a credential

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const prev = setLogSink((_l, line) => lines.push(line));
  try {
    fn();
  } finally {
    setLogSink(prev);
  }
  return lines;
}

test('gateway log(): depth-3 secrets, header values and registered keys never reach the sink', () => {
  const sk = generateClientSecret();
  const signingKey = 'sIgNiNgKeY-scalar-0123456789abcdef';
  registerLogSecret(signingKey);
  const lines = capture(() =>
    log('info', 'webhook_attempt', {
      a: { b: { c: { password: 'p@ssw0rd-long', text: `sk=${sk} d=${signingKey}` } } },
      headers: { authorization: `Bearer ${JWT}`, 'x-forward': `token ${JWT}`, 'x-hub-signature-256': 'sha256=abcdef0123456789' },
      webhook_id: 'whk_01J0TESTTESTTESTTESTTESTTE',
    }),
  );
  const out = lines.join('\n');
  for (const s of [sk, JWT, signingKey, 'p@ssw0rd-long', 'sha256=abcdef0123456789']) assert.ok(!out.includes(s), `${s} leaked: ${out}`);
  assert.equal(JSON.parse(lines[0]).webhook_id, 'whk_01J0TESTTESTTESTTESTTESTTE');
});

test('gateway errorHandler: the error message is redacted, request options are not logged', () => {
  const res = { headersSent: false, locals: {}, setHeader() {}, status() { return this; }, json() {} };
  const lines = capture(() =>
    errorHandler(
      Object.assign(new Error(`upstream said Bearer ${JWT}`), { options: { headers: { authorization: JWT } } }),
      { method: 'GET', path: '/v1/x' } as never,
      res as never,
      () => {},
    ),
  );
  const out = lines.join('\n');
  assert.ok(out.includes('unhandled_error'));
  assert.ok(!out.includes(JWT), out);
});

test('gateway RateLimiter: 1e6 distinct keys stay bounded', () => {
  const rl = new RateLimiter(10, 60_000);
  for (let i = 0; i < 1_000_000; i++) rl.take(`k${i}`);
  assert.ok(rl.size <= RATE_LIMITER_MAX_KEYS, `size ${rl.size}`);
});
