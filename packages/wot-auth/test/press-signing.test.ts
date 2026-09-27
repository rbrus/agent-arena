/**
 * G-11: Ed25519 signatures for negotiation moves (press-signing.ts).
 *  - JCS reproduces the contract's signing vectors (contracts/fixtures/signing_vectors.json);
 *  - deterministic keys match RFC 8032 §7.1 TEST 1;
 *  - a valid press signature verifies; forged, cross-episode replayed, tampered-clause,
 *    wrong-position, wrong-sender and header-injection variants are refused;
 *  - the key registry refuses private keys and non-Ed25519 keys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  jcs,
  jwkThumbprint,
  mintPassportSigningKey,
  PassportKeyRegistry,
  pressTermsHash,
  signingKeyFromLabel,
  signingKeyFromSeed,
  signDetachedJws,
  signPressMove,
  verifyDetachedJws,
  verifyPressSignature,
  DETACHED_JWS_RE,
  type PressSignedFields,
} from '../src/index.ts';
import { contractsDir } from 'wot-contracts/contracts-dir';

// Private (ascension/../contracts) and public (<repo>/contracts) layouts.
const CONTRACTS = contractsDir();

test('jcs reproduces the contract signing vectors (RFC 8785 over the signed examples)', () => {
  const vectors = JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'signing_vectors.json'), 'utf8')) as {
    vectors: { document: string; jcs_bytes: number; jcs_sha256: string }[];
  };
  assert.ok(vectors.vectors.length >= 3);
  for (const v of vectors.vectors) {
    const [file, pointer] = v.document.split('#');
    const schema = JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) as Record<string, unknown>;
    const idx = Number(pointer.split('/').pop());
    const doc = structuredClone((schema.examples as Record<string, unknown>[])[idx]);
    delete (doc.signing as Record<string, unknown>).signature;
    const bytes = jcs(doc);
    assert.equal(Buffer.byteLength(bytes, 'utf8'), v.jcs_bytes, v.document);
    assert.equal('sha256:' + createHash('sha256').update(bytes, 'utf8').digest('hex'), v.jcs_sha256, v.document);
  }
});

test('jcs: sorted by UTF-16 code units, no whitespace, refuses non-JSON', () => {
  assert.equal(jcs({ b: 1, a: [true, null, 'x'], 'é': 2, Z: { y: 1, x: 2 } }), '{"Z":{"x":2,"y":1},"a":[true,null,"x"],"b":1,"é":2}');
  assert.equal(jcs({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => jcs({ n: Infinity }));
  assert.throws(() => jcs('\ud800'));
  assert.throws(() => jcs(10n));
});

test('signingKeyFromSeed matches RFC 8032 §7.1 TEST 1; thumbprint is the kid', () => {
  const k = signingKeyFromSeed(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
  assert.equal(Buffer.from(k.publicJwk.x, 'base64url').toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(k.publicJwk.kid, jwkThumbprint(k.publicJwk));
  assert.equal('d' in k.publicJwk, false);
  // deterministic
  assert.deepEqual(signingKeyFromLabel('ref:1:austria'), signingKeyFromLabel('ref:1:austria'));
  assert.notEqual(signingKeyFromLabel('ref:1:austria').publicJwk.x, signingKeyFromLabel('ref:1:england').publicJwk.x);
});

const base = (over: Partial<PressSignedFields> = {}): PressSignedFields => ({
  episodeId: 'epi_01J9ZZZZZZZZZZZZZZZZZZZZZZ',
  msgIdExpected: 'prs:S1901M:r1:france:1',
  from: 'france',
  to: { kind: 'private', power: 'germany' },
  move: 'offer',
  respondTo: null,
  terms: {
    give: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: 'F1901M', provinces: ['bur'] }],
    want: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: 'F1901M', provinces: ['bur'] }],
  },
  ...over,
});

test('press signature: valid verifies; the wire form is the contract detached JWS', () => {
  const k = mintPassportSigningKey();
  const sig = signPressMove(k, base());
  assert.match(sig, DETACHED_JWS_RE);
  assert.ok(sig.length <= 600);
  assert.deepEqual(verifyPressSignature(k.publicJwk, sig, base()), { ok: true, kid: k.publicJwk.kid });
  // Ed25519 is deterministic: the same payload signs to the same bytes.
  assert.equal(signPressMove(k, base()), sig);
});

test('press signature: forged, replayed across episodes, tampered clause, moved, re-attributed → refused', () => {
  const k = mintPassportSigningKey();
  const other = mintPassportSigningKey();
  const sig = signPressMove(k, base());
  // forged: signed by another key
  assert.deepEqual(verifyPressSignature(k.publicJwk, signPressMove({ privateJwk: { ...other.privateJwk, kid: k.publicJwk.kid } }, base()), base()), { ok: false, reason: 'bad_signature' });
  // a garbage signature of the right shape
  assert.equal(verifyPressSignature(k.publicJwk, `${sig.split('..')[0]}..${'A'.repeat(86)}`, base()).ok, false);
  // replayed into another episode
  assert.deepEqual(verifyPressSignature(k.publicJwk, sig, base({ episodeId: 'epi_01J9YYYYYYYYYYYYYYYYYYYYYY' })), { ok: false, reason: 'bad_signature' });
  // tampered clause (province), tampered phase span, tampered note
  const t = base().terms as { give: { provinces: string[]; to_phase: string }[]; want: unknown[] };
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ terms: { ...t, give: [{ ...t.give[0], provinces: ['pic'] }] } })).ok, false);
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ terms: { ...t, give: [{ ...t.give[0], to_phase: 'S1902M' }] } })).ok, false);
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ terms: { ...t, note: 'x' } })).ok, false);
  // a different batch position / round, sender, recipient, move
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ msgIdExpected: 'prs:S1901M:r1:france:2' })).ok, false);
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ msgIdExpected: 'prs:S1901M:r2:france:1' })).ok, false);
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ from: 'italy' })).ok, false);
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ to: { kind: 'private', power: 'italy' } })).ok, false);
  assert.equal(verifyPressSignature(k.publicJwk, sig, base({ move: 'counter' })).ok, false);
  // `session` and other non-JWS strings are not signatures
  assert.deepEqual(verifyPressSignature(k.publicJwk, 'session', base()), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyPressSignature(k.publicJwk, 'x'.repeat(40), base()), { ok: false, reason: 'malformed' });
});

test('press signature: header allow-list and kid binding; key shape checks', () => {
  const k = mintPassportSigningKey();
  const payload = { a: 1 };
  const [, s] = signDetachedJws(k.privateJwk, payload).split('..');
  const hdr = (h: unknown): string => Buffer.from(JSON.stringify(h)).toString('base64url');
  for (const h of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'EdDSA', crit: ['b64'] }, { alg: 'EdDSA', b64: false }, { alg: 'EdDSA', jwk: k.publicJwk }, [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
    assert.deepEqual(verifyDetachedJws(k.publicJwk, `${hdr(h)}..${s}`, payload), { ok: false, reason: 'bad_header' }, JSON.stringify(h));
  }
  const wrongKid = signDetachedJws(k.privateJwk, payload, { kid: 'someone-else' });
  assert.deepEqual(verifyDetachedJws(k.publicJwk, wrongKid, payload), { ok: false, reason: 'kid_mismatch' });
  assert.deepEqual(verifyDetachedJws({ ...k.privateJwk }, signDetachedJws(k.privateJwk, payload), payload), { ok: false, reason: 'bad_key' });
  assert.deepEqual(verifyDetachedJws({ kty: 'EC', crv: 'P-256', x: k.publicJwk.x }, signDetachedJws(k.privateJwk, payload), payload), { ok: false, reason: 'bad_key' });
  assert.equal(pressTermsHash(null), null);
  assert.match(pressTermsHash({ give: [], want: [] })!, /^sha256:[0-9a-f]{64}$/);
});

test('PassportKeyRegistry: registers public keys only; resolver returns null for unknown agents', async () => {
  const dir = new PassportKeyRegistry();
  const k = mintPassportSigningKey();
  assert.throws(() => dir.register('agt_A', k.privateJwk));
  assert.throws(() => dir.register('agt_A', { kty: 'RSA', n: 'x', e: 'AQAB' }));
  const stored = dir.register('agt_A', k.publicJwk);
  assert.equal(stored.kid, k.jkt);
  assert.deepEqual(await dir.resolver('agt_A'), stored);
  assert.equal(await dir.resolver('agt_B'), null);
  dir.revoke('agt_A');
  assert.equal(dir.get('agt_A'), null);
});
