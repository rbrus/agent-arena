/**
 * Phase 7 gate criterion 6 re-review (docs/phase-7/SECURITY-REVIEW.md §8, G-34).
 * G-34 was a `todo` test; C2j closed it (verifyDetachedJws refuses every
 * non-canonical base64url spelling as `malformed`, signing.md §7.1), and the
 * contract press-signature vectors pin the documented results.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintPassportSigningKey, signDetachedJws, verifyDetachedJws, verifyPressSignature } from '../src/index.ts';
import { isCanonicalB64u } from '../src/press-signing.ts';
import { contractsDir } from 'wot-contracts/contracts-dir';

// Private (ascension/../contracts) and public (<repo>/contracts) layouts.
const CONTRACTS = contractsDir();

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

test(
  'G-34: a detached JWS has exactly one accepted encoding (non-canonical base64url is refused)',
  () => {
    const k = mintPassportSigningKey();
    const payload = { scenario: 'negotiation_chamber', negotiation_id: 'neg_review', action: 'offer', from_agent_id: 'agt_review', respond_to: null, terms_hash: 'sha256:00', expires_at: null };
    const jws = signDetachedJws(k.privateJwk, payload, { kid: k.publicJwk.kid });
    assert.equal(verifyDetachedJws(k.publicJwk, jws, payload).ok, true);
    const i = B64URL.indexOf(jws.at(-1)!);
    const variants = [0, 1, 2, 3].map((b) => B64URL[(i & ~3) | b]).filter((c) => c !== jws.at(-1)).map((c) => jws.slice(0, -1) + c);
    const accepted = variants.filter((v) => verifyDetachedJws(k.publicJwk, v, payload).ok);
    assert.equal(accepted.length, 0, `${accepted.length} alternative encodings of the same signature verified`);
  },
);

test('G-34: padding, the standard alphabet and non-zero unused bits are refused in the header and the signature (malformed)', () => {
  const k = mintPassportSigningKey();
  const payload = { scenario: 'diplomacy', n: 1 };
  const jws = signDetachedJws(k.privateJwk, payload, { kid: k.publicJwk.kid });
  const [h, , s] = jws.split('.');
  assert.equal(s.length, 86);
  assert.ok(isCanonicalB64u(h) && isCanonicalB64u(s));
  const std = (x: string) => x.replace(/-/g, '+').replace(/_/g, '/');
  const flipLast = (x: string) => {
    const i = B64URL.indexOf(x.at(-1)!);
    return x.slice(0, -1) + B64URL[(i & ~3) | ((i & 3) ^ 1)];
  };
  const bad = [
    `${h}..${s}==`,
    `${h}=..${s}`,
    `${h}..${flipLast(s)}`,
    ...(h.length % 4 !== 0 ? [`${flipLast(h)}..${s}`] : []),
    ...(/[-_]/.test(s) ? [`${h}..${std(s)}`] : []),
    ...(/[-_]/.test(h) ? [`${std(h)}..${s}`] : []),
  ];
  for (const v of bad) assert.deepEqual(verifyDetachedJws(k.publicJwk, v, payload), { ok: false, reason: 'malformed' }, v);
  assert.equal(isCanonicalB64u('AB'), false, 'unused bits set');
  assert.equal(isCanonicalB64u('AA'), true);
  assert.equal(isCanonicalB64u('A'), false, 'length 1 mod 4');
  assert.equal(isCanonicalB64u('AA=='), false);
  assert.equal(isCanonicalB64u('+/+/'), false);
});

test('contract press-signature vectors (contracts/fixtures/press_signing_vectors.json) give their documented results', () => {
  interface Vector {
    id: string;
    context: { episode_id: string; phase: string; round: number; power: string; index: number };
    message: { move: string; to: unknown; respond_to?: string | null; terms?: unknown };
    jws: string;
    expect: { result: 'accept' | 'reject'; reason?: string };
  }
  const f = JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'press_signing_vectors.json'), 'utf8')) as { key: { jwk: unknown }; vectors: Vector[] };
  assert.equal(f.vectors.length, 15);
  const got: Record<string, string> = {};
  for (const v of f.vectors) {
    const c = v.context;
    // The verifier rebuilds the payload from the session context and the message (signing.md §7.3), never from signed_payload.
    const r = verifyPressSignature(f.key.jwk, v.jws, {
      episodeId: c.episode_id,
      msgIdExpected: `prs:${c.phase}:r${c.round}:${c.power}:${c.index + 1}`,
      from: c.power,
      to: v.message.to,
      move: v.message.move,
      respondTo: v.message.respond_to ?? null,
      terms: v.message.terms ?? null,
    } as never);
    got[v.id] = r.ok ? 'accept' : `reject:${r.reason}`;
  }
  const want = Object.fromEntries(f.vectors.map((v) => [v.id, v.expect.result === 'accept' ? 'accept' : `reject:${v.expect.reason}`]));
  assert.deepEqual(got, want);
  assert.equal(got['reject-noncanonical-signature'], 'reject:malformed');
});
