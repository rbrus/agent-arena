/**
 * contracts/signing.md: RFC 8785 (JCS) canonical form, DSSE PAE, pure Ed25519.
 * Edge cases from RFC 8785 itself (§3.2.2 serialisation, §3.2.3 sorting, the
 * §3.2.4 worked example, Appendix B numbers) and the three contract vectors
 * of contracts/fixtures/signing_vectors.json (RFC 8032 §7.1 TEST 1 key).
 */

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CROSSCHECK_PAYLOAD_TYPE,
  REPORT_PAYLOAD_TYPE,
  RUN_MANIFEST_PAYLOAD_TYPE,
  canonicalize,
  canonicalizeForSigning,
  jcs,
  pae,
  signDocument,
  signReport,
  signedBodyDigest,
  verifyDocumentSignature,
  verifyReportSignature,
  type Report,
} from '../src/index.ts';
import { SCHEMAS_DIR, reportSchema } from '../src/schemas.ts';
import { RFC8032_TEST1_PUBLIC_JWK, RFC8032_TEST1_SEED, buildGoldenReport } from '../scripts/golden.ts';
import { clone } from './helpers.ts';

const CONTRACTS = join(SCHEMAS_DIR, '..');
const vectors = JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'signing_vectors.json'), 'utf8')) as {
  run_manifest_digest: { document: string; digest: string };
  vectors: { document: string; payload_type: string; jcs_bytes: number; jcs_sha256: string; signature: string }[];
};
function docAt(ref: string): Record<string, unknown> {
  const [file, frag] = ref.split('#');
  let v: unknown = JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8'));
  for (const k of frag.split('/').filter(Boolean)) v = (v as Record<string, unknown>)[k];
  return clone(v) as Record<string, unknown>;
}
const sha = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const hostedExample = () => clone((reportSchema.examples as Report[])[2]);
const signedHosted = () => signReport(hostedExample(), RFC8032_TEST1_SEED, 'sixi-arena-ed25519-20261101');

/* ------------------------------------------------------------------ JCS -- */

const C = (...codes: number[]) => String.fromCharCode(...codes);
const BS = C(0x5c);

test('JCS: RFC 8785 \u00a73.2.4 worked example, byte for byte', () => {
  // "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/" decoded, built from code units so no escape is lost in transit.
  const input = {
    numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
    string: C(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f),
    literals: [null, true, false],
  };
  const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${C(0x20ac)}$${BS}u000f${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"}`;
  assert.equal(jcs(input), expected);
  assert.equal(jcs(JSON.parse(expected)), expected, 'idempotent');
});

test('JCS: RFC 8785 \u00a73.2.3 property sorting by UTF-16 code units (not code points, not locale)', () => {
  const euro = C(0x20ac), cr = C(0x0d), dalet = C(0xfb33), grin = String.fromCodePoint(0x1f600), ctl = C(0x80), oe = C(0xf6);
  const input = { [euro]: 'Euro Sign', [cr]: 'Carriage Return', [dalet]: 'Hebrew Letter Dalet With Dagesh', '1': 'One', [grin]: 'Emoji: Grinning Face', [ctl]: 'Control', [oe]: 'Latin Small Letter O With Diaeresis' };
  const expected = `{"${BS}r":"Carriage Return","1":"One","${ctl}":"Control","${oe}":"Latin Small Letter O With Diaeresis","${euro}":"Euro Sign","${grin}":"Emoji: Grinning Face","${dalet}":"Hebrew Letter Dalet With Dagesh"}`;
  assert.equal(jcs(input), expected);
  // U+1F600 (D83D DE00) sorts BEFORE U+FB33 by code units although its code point is larger.
  assert.ok(grin.charCodeAt(0) < dalet.charCodeAt(0) && grin.codePointAt(0)! > dalet.codePointAt(0)!);
  // Upper case before lower case; a prefix before its extensions; nested objects sorted too.
  assert.equal(jcs({ b: 1, a: { d: [], c: {} }, B: 2, aa: 0, '': 'e' }), '{"":"e","B":2,"a":{"c":{},"d":[]},"aa":0,"b":1}');
});

test('JCS: RFC 8785 Appendix B number serialisation (ECMAScript Number::toString)', () => {
  const cases: [number, string][] = [
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [1e21, '1e+21'],
    [1e20, '100000000000000000000'],
    [1e-7, '1e-7'],
    [0.000001, '0.000001'],
    [123456789012345680000, '123456789012345680000'],
    [9007199254740992, '9007199254740992'],
    [-9007199254740992, '-9007199254740992'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
    [Number.MIN_VALUE, '5e-324'],
    [0.1 + 0.2, '0.30000000000000004'],
    [1.5, '1.5'],
    [295147905179352830000, '295147905179352830000'],
  ];
  for (const [n, s] of cases) assert.equal(jcs(n), s, String(n));
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => jcs({ x: bad }), /non-finite/);
});

test('JCS: string escaping (RFC 8785 §3.2.2.2): short escapes, lower-case \\u00xx for other C0, nothing else escaped', () => {
  assert.equal(jcs('\b\t\n\f\r"\\'), String.raw`"\b\t\n\f\r\"\\"`);
  assert.equal(jcs('\u0000\u0001\u001f\u007f'), '"\\u0000\\u0001\\u001f\u007f"');
  assert.equal(jcs('/ < > &     é 😀'), '"/ < > &     é 😀"');
  assert.equal(jcs({ 'k\n': 'v' }), '{"k\\n":"v"}');
});

test('JCS: lone surrogates are refused in strict (signing) mode and escaped otherwise; non-JSON values are refused', () => {
  assert.throws(() => jcs('a\ud800b', { strict: true }), /lone surrogate/);
  assert.throws(() => jcs({ ['\udc00']: 1 }, { strict: true }), /lone surrogate/);
  assert.equal(jcs('a\ud800b'), '"a\\ud800b"');
  assert.equal(jcs('😀', { strict: true }), '"😀"'); // a valid pair is fine
  assert.throws(() => jcs({ d: new Date(0) }), /non-plain object/);
  assert.throws(() => jcs({ m: new Map() }), /non-plain object/);
  assert.throws(() => jcs({ n: 1n }), /bigint is not JSON/);
  assert.throws(() => jcs({ f: () => 1 }), /function is not JSON/);
  assert.throws(() => jcs(undefined), /undefined/);
  assert.equal(jcs({ a: undefined, b: [undefined, 1] }), '{"b":[null,1]}');
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(jcs([, 1, , ]), '[null,1,null]', 'holes of a sparse array serialise as null, like JSON.stringify'); // regression: map() skipped holes
  assert.equal(jcs(Object.assign(Object.create(null), { z: 1, a: 2 })), '{"a":2,"z":1}');
  assert.equal(jcs([]), '[]');
  assert.equal(jcs({}), '{}');
  assert.equal(jcs([[[]], {}]), '[[[]],{}]');
});

test('canonicalize (the digest form) equals JCS and the 12-line contract-check jcs for every contract report example', () => {
  const ref = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(ref).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${ref((v as Record<string, unknown>)[k])}`).join(',')}}`);
  for (const ex of reportSchema.examples as unknown[]) {
    assert.equal(canonicalize(ex), ref(ex));
    assert.equal(jcs(ex, { strict: true }), ref(ex));
  }
  const g = buildGoldenReport();
  assert.equal(canonicalize(g), ref(g));
});

/* -------------------------------------------------------------- vectors -- */

test('signing vectors: JCS bytes, sha256 and all three Ed25519 signatures of contracts/fixtures/signing_vectors.json', () => {
  assert.equal(vectors.vectors.length, 3);
  for (const v of vectors.vectors) {
    const doc = docAt(v.document);
    const body = Buffer.from(canonicalizeForSigning(doc), 'utf8');
    assert.equal(body.length, v.jcs_bytes, v.document);
    assert.equal(sha(body), v.jcs_sha256, v.document);
    // The example carries an EXAMPLE placeholder signature; the vector's goes in its place.
    const signed = { ...doc, signing: { ...(doc.signing as object), signature: v.signature } };
    const c = verifyDocumentSignature(signed, RFC8032_TEST1_PUBLIC_JWK, v.payload_type);
    assert.equal(c.status, 'valid', `${v.document}: ${c.errors.join('; ')}`);
    // Ed25519 is deterministic: signing with the RFC 8032 TEST 1 seed reproduces the vector.
    assert.equal((signDocument(doc, RFC8032_TEST1_SEED, v.payload_type).signing as { signature: string }).signature, v.signature, v.document);
    // Domain separation: never valid under another payload type.
    for (const other of [REPORT_PAYLOAD_TYPE, RUN_MANIFEST_PAYLOAD_TYPE, CROSSCHECK_PAYLOAD_TYPE].filter((t) => t !== v.payload_type)) {
      const forged = { ...signed, signing: { ...(signed.signing as object), payload_type: other } };
      assert.equal(verifyDocumentSignature(forged, RFC8032_TEST1_PUBLIC_JWK, other).ok, false, `${v.document} under ${other}`);
    }
  }
  assert.equal(signedBodyDigest(docAt(vectors.run_manifest_digest.document)), vectors.run_manifest_digest.digest);
});

test('pae: DSSE v1 with byte lengths (multi-byte UTF-8 counted in bytes)', () => {
  assert.equal(pae('t', Buffer.from('é', 'utf8')).toString('utf8'), 'DSSEv1 1 t 2 é');
  assert.equal(pae(REPORT_PAYLOAD_TYPE, Buffer.alloc(0)).toString('utf8'), `DSSEv1 38 ${REPORT_PAYLOAD_TYPE} 0 `);
});

/* --------------------------------------------------- what the seal covers -- */

function leaves(v: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (v !== null && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v);
    if (entries.length === 0) out.push(path);
    for (const [k, x] of entries) leaves(x, [...path, k], out);
  } else out.push(path);
  return out;
}
function mutateAt(doc: unknown, path: (string | number)[]): void {
  let o = doc as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  const k = path[path.length - 1];
  const v = o[k];
  o[k] = typeof v === 'string' ? `${v}x` : typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : v === null ? 0 : Array.isArray(v) ? [0] : { x: 1 };
}

test('the seal covers every member except /signing/signature: changing ANY signed leaf breaks verification', () => {
  const sealed = signedHosted();
  assert.equal(verifyReportSignature(sealed, RFC8032_TEST1_PUBLIC_JWK).status, 'valid');
  const paths = leaves(sealed).filter((p) => p.join('/') !== 'signing/signature');
  assert.ok(paths.length > 400, `${paths.length} leaves`);
  for (const p of paths) {
    const t = clone(sealed);
    mutateAt(t, p);
    assert.equal(verifyReportSignature(t, RFC8032_TEST1_PUBLIC_JWK).ok, false, `/${p.join('/')} is not covered`);
  }
  // Adding or removing a member breaks it too.
  const added = clone(sealed) as Report & { extra?: number };
  added.extra = 1;
  assert.equal(verifyReportSignature(added, RFC8032_TEST1_PUBLIC_JWK).ok, false);
  const removed = clone(sealed);
  delete removed.run.target_ownership;
  assert.equal(verifyReportSignature(removed, RFC8032_TEST1_PUBLIC_JWK).ok, false);
});

test('the seal is independent of whitespace and key order, and of the signature bytes themselves', () => {
  const sealed = signedHosted();
  const reordered = Object.fromEntries(Object.entries(sealed).reverse()) as unknown as Report;
  const reindented = JSON.parse(JSON.stringify(sealed, null, 7)) as Report;
  const deepReversed = JSON.parse(JSON.stringify(sealed), function (this: unknown, _k, v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v;
  }) as Report;
  for (const r of [reordered, reindented, deepReversed]) assert.equal(verifyReportSignature(r, RFC8032_TEST1_PUBLIC_JWK).status, 'valid');
  const other = clone(sealed);
  other.signing!.signature = vectors.vectors[1].signature;
  assert.equal(canonicalizeForSigning(other), canonicalizeForSigning(sealed), 'the signature is outside the signed bytes');
  assert.equal(verifyReportSignature(other, RFC8032_TEST1_PUBLIC_JWK).ok, false);
});

test('seal invariants: kid equality, manifest digest equality, exclusion list, wrong key, unsigned', () => {
  const sealed = signedHosted();
  const { publicKey: stranger } = generateKeyPairSync('ed25519');
  assert.equal(verifyReportSignature(sealed, stranger).status, 'invalid');

  // Re-signed after moving the kid: the signature is good, the kid-equality invariant is not.
  const moved = clone(sealed);
  moved.signing!.signing_key_id = 'attacker-key-0001';
  const resigned = signDocument(moved, RFC8032_TEST1_SEED, REPORT_PAYLOAD_TYPE);
  const c = verifyReportSignature(resigned, RFC8032_TEST1_PUBLIC_JWK);
  assert.equal(c.ok, false);
  assert.match(c.errors.join(), /signing_key_id differs from run.hosted.signing_key_id/);
  const manifest = clone(sealed);
  manifest.signing!.run_manifest_digest = `sha256:${'1'.repeat(64)}`;
  assert.match(verifyReportSignature(signDocument(manifest, RFC8032_TEST1_SEED, REPORT_PAYLOAD_TYPE), RFC8032_TEST1_PUBLIC_JWK).errors.join(), /run_manifest_digest differs/);

  for (const excluded of [[], ['/signing/signature', '/run/hosted'], ['/signing']]) {
    const t = clone(sealed) as unknown as { signing: { excluded: string[] } };
    t.signing.excluded = excluded;
    assert.throws(() => canonicalizeForSigning(t), /excluded must be exactly/);
    assert.equal(verifyReportSignature(t, RFC8032_TEST1_PUBLIC_JWK).ok, false);
  }
  assert.equal(verifyReportSignature(buildGoldenReport(), RFC8032_TEST1_PUBLIC_JWK).status, 'unsigned');
});

test('signReport: seals only hosted reports, refuses a foreign kid, needs a seal time, never mutates its input', () => {
  const ex = hostedExample();
  const before = JSON.stringify(ex);
  const sealed = signReport(ex, RFC8032_TEST1_SEED, 'sixi-arena-ed25519-20261101', { sealedAt: '2026-11-10T14:07:15Z' });
  assert.equal(JSON.stringify(ex), before);
  assert.equal(sealed.signing!.signature, vectors.vectors[0].signature);
  assert.throws(() => signReport(ex, RFC8032_TEST1_SEED, 'some-other-kid'), /differs from run.hosted.signing_key_id/);
  assert.throws(() => signReport(buildGoldenReport(), RFC8032_TEST1_SEED, 'sixi-arena-ed25519-20261101', { sealedAt: '2026-11-10T14:07:15Z' }), /only a hosted report/);
  const unsealed = clone(ex);
  delete unsealed.signing;
  assert.throws(() => signReport(unsealed, RFC8032_TEST1_SEED, 'sixi-arena-ed25519-20261101'), /sealedAt is required/);
  // Keys as PEM and KeyObject work the same as the raw seed.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const byPem = signReport(ex, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, 'sixi-arena-ed25519-20261101');
  assert.equal(verifyReportSignature(byPem, publicKey.export({ format: 'pem', type: 'spki' }) as string).status, 'valid');
  assert.equal(verifyReportSignature(byPem, RFC8032_TEST1_PUBLIC_JWK).status, 'invalid');
});
