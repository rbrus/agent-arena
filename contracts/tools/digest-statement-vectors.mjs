// Regenerate contracts/fixtures/digest_statement_vectors.json and the large payload it uses,
// contracts/fixtures/digest_statement/bundle-manifest.json (signing.md §5.2, contracts 2.11.0).
//
// Every signature is made with the Ed25519 key of RFC 8032 §7.1 TEST 1 (reject-other-key: TEST 2). Those keys are
// PUBLISHED TEST VECTORS; they are not, and must never become, Sixi keys. Ed25519 is deterministic, so a rerun writes
// byte-identical files. contract-check.mjs §16 replays every vector with a verifier written from signing.md §5.2.
// fixtures/signing_vectors.json is not touched: the 2.2.0-2.10.0 vectors stay byte-identical.
//
// Run from the repo root: node contracts/tools/digest-statement-vectors.mjs

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const jcs = (v) => {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('JCS: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
};
const pae = (type, body) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

export const ARENA_SIGN_MAX_MESSAGE_BYTES = 65536;
const ST = 'application/vnd.sixi.arena-digest-statement+json';
const TYPE = {
  'report.json': 'application/vnd.sixi.arena-report+json',
  'report.sarif': 'application/vnd.sixi.arena-sarif+json',
  'bundle-manifest.json': 'application/vnd.sixi.arena-bundle+json',
  crosscheck: 'application/vnd.sixi.arena-crosscheck+json',
};

const keyPair = (seedHex, pubHex) => {
  const x = Buffer.from(pubHex, 'hex').toString('base64url');
  return {
    x,
    priv: createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(seedHex, 'hex').toString('base64url'), x }, format: 'jwk' }),
    pub: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }),
  };
};
const K1 = keyPair('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
const K2 = keyPair('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c');

const example = (f, i) => JSON.parse(readFileSync(join(CONTRACTS, 'schemas', f), 'utf8')).examples[i];
const report = example('report.schema.json', 2);
const xrec = example('crosscheck_record.schema.json', 0);
const kid = report.signing.signing_key_id;
const ctx = { run_id: report.run.run_id, run_manifest_digest: report.signing.run_manifest_digest, sealed_at: report.signing.sealed_at, signing_key_id: kid };

// The large payload: a schema-valid bundle manifest of a 240-episode run, over the threshold in the file form
// (2-space JSON + LF). Digests and sizes are synthetic and deterministic.
const EPISODES = 240;
const paths = ['report.json', 'report.sarif', 'run-manifest.json'];
for (let n = 0; n < EPISODES; n++) paths.push(`episodes/${n}.record.json`, `episodes/${n}.replay.json`);
paths.sort();
const bundle = { bundle_version: '1.0', run_id: ctx.run_id, signing_key_id: kid, files: paths.map((p, i) => ({ path: p, sha256: sha(`digest-statement-fixture|${p}`), bytes: 4096 + i })) };
const large = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
if (pae(TYPE['bundle-manifest.json'], large).length <= ARENA_SIGN_MAX_MESSAGE_BYTES) throw new Error('the large payload must be over the threshold');
mkdirSync(join(CONTRACTS, 'fixtures', 'digest_statement'), { recursive: true });
writeFileSync(join(CONTRACTS, 'fixtures', 'digest_statement', 'bundle-manifest.json'), large);
const sarif = readFileSync(join(CONTRACTS, 'fixtures', 'hosted_report.sarif'));

const PAYLOADS = {
  sarif: { ref: 'fixtures/hosted_report.sarif', bytes: sarif },
  large: { ref: 'fixtures/digest_statement/bundle-manifest.json', bytes: large },
};

const statementFor = (subjectType, covered, over = {}) => {
  const s = {
    statement_version: '1.0',
    subject: { payload_type: subjectType, sha256: sha(covered), bytes: covered.length },
    run_id: ctx.run_id,
    run_manifest_digest: ctx.run_manifest_digest,
    signing: { algorithm: 'ed25519', signing_key_id: kid, canonicalization: 'jcs-rfc8785', payload_type: ST, excluded: ['/signing/signature'], sealed_at: ctx.sealed_at },
  };
  return over.edit ? (over.edit(s), s) : s;
};
const envelope = (payloadType, payload, sig, keyid = kid) => ({ payloadType, payload: payload.toString('base64'), signatures: [{ keyid, sig: sig.toString('base64') }] });
const signRaw = (type, payload, key = K1) => sign(null, pae(type, payload), key.priv);
const statementBody = (s) => Buffer.from(jcs(s), 'utf8');

const vectors = [];
const detached = (id, description, file, payloadKey, env, expect, mutation) => vectors.push({
  id, description, kind: 'detached', file,
  served: { ref: PAYLOADS[payloadKey].ref, ...(mutation ? { mutation } : {}) },
  envelope: env, expect,
});

// --- the pair over one small payload (raw, and the statement form, which is allowed below the threshold)
{
  const t = TYPE['report.sarif'];
  detached('accept-raw-sarif', 'report.sarif, raw form: the envelope payload is the exact file bytes (PAE message under the threshold)', 'report.sarif', 'sarif', envelope(t, sarif, signRaw(t, sarif)), { result: 'accept', form: 'raw' });
  const s = statementFor(t, sarif);
  const b = statementBody(s);
  detached('accept-digest-sarif', 'the same report.sarif, digest-statement form: allowed at any size', 'report.sarif', 'sarif', envelope(ST, b, signRaw(ST, b)), { result: 'accept', form: 'digest_statement' });
}
// --- the pair over the large payload (raw is refused above the threshold; the statement is mandatory)
let largeStatement;
{
  const t = TYPE['bundle-manifest.json'];
  const s = statementFor(t, large);
  const b = statementBody(s);
  const sig = signRaw(ST, b);
  // Schema examples carry a placeholder signature (contract-check §5 lint); the real one is in the vector.
  largeStatement = { ...clone(s), signing: { ...s.signing, signature: `EXAMPLE${'0'.repeat(79)}==` } };
  detached('accept-digest-large-bundle-manifest', `bundle-manifest.json of ${large.length} bytes (PAE message ${pae(t, large).length} > ${ARENA_SIGN_MAX_MESSAGE_BYTES}), digest-statement form`, 'bundle-manifest.json', 'large', envelope(ST, b, sig), { result: 'accept', form: 'digest_statement' });
  detached('reject-raw-over-threshold', 'the same file in the raw form, with a valid Ed25519 signature: refused because the PAE message is over ARENA_SIGN_MAX_MESSAGE_BYTES', 'bundle-manifest.json', 'large', envelope(t, large, signRaw(t, large)), { result: 'reject', reason: 'raw_over_threshold' });
  detached('reject-digest-mismatch', 'served bytes differ from the statement in one byte, same length', 'bundle-manifest.json', 'large', envelope(ST, b, sig), { result: 'reject', reason: 'digest_mismatch' }, { xor_byte: { offset: 4000, mask: 1 } });
  detached('reject-length-mismatch', 'served bytes carry one extra LF', 'bundle-manifest.json', 'large', envelope(ST, b, sig), { result: 'reject', reason: 'length_mismatch' }, { append_hex: '0a' });
  const other = statementFor(TYPE['report.sarif'], large);
  const ob = statementBody(other);
  detached('reject-subject-type', 'a valid statement whose subject is the SARIF payload type, presented for bundle-manifest.json', 'bundle-manifest.json', 'large', envelope(ST, ob, signRaw(ST, ob)), { result: 'reject', reason: 'subject_type' });
  detached('reject-statement-under-bundle-type', 'the statement bytes signed under the bundle payload type instead of the statement type (domain separation)', 'bundle-manifest.json', 'large', envelope(ST, b, signRaw(t, b)), { result: 'reject', reason: 'signature' });
  detached('reject-statement-in-raw-envelope', 'a valid statement placed in an envelope that claims the bundle payload type (raw form): the payload is not the file', 'bundle-manifest.json', 'large', envelope(t, b, sig), { result: 'reject', reason: 'payload_mismatch' });
  detached('reject-envelope-type', 'an envelope of the run-manifest payload type', 'bundle-manifest.json', 'large', envelope('application/vnd.sixi.arena-run-manifest+json', b, sig), { result: 'reject', reason: 'payload_type' });
  for (const [id, desc, edit] of [
    ['reject-binding-run-id', 'a valid statement naming another run', (x) => { x.run_id = 'run_01JB5H0STED0EXAMP1E00000R9'; }],
    ['reject-binding-manifest-digest', 'a valid statement naming another run manifest', (x) => { x.run_manifest_digest = `sha256:${'1'.repeat(64)}`; }],
    ['reject-binding-sealed-at', 'a valid statement with a sealed_at other than the report\'s', (x) => { x.signing.sealed_at = '2026-11-10T14:07:16Z'; }],
  ]) {
    const bb = statementBody(statementFor(t, large, { edit }));
    detached(id, desc, 'bundle-manifest.json', 'large', envelope(ST, bb, signRaw(ST, bb)), { result: 'reject', reason: 'binding' });
  }
  {
    const bb = statementBody(statementFor(t, large, { edit: (x) => { x.signing.signing_key_id = 'sixi-arena-ed25519-20261102'; } }));
    detached('reject-binding-kid', 'a valid statement whose signing_key_id differs from the envelope keyid and the report kid', 'bundle-manifest.json', 'large', envelope(ST, bb, signRaw(ST, bb)), { result: 'reject', reason: 'binding' });
  }
  {
    const pretty = Buffer.from(JSON.stringify(s, null, 2), 'utf8');
    detached('reject-statement-not-jcs', 'the statement pretty-printed and signed over those bytes: the payload must be the JCS form', 'bundle-manifest.json', 'large', envelope(ST, pretty, signRaw(ST, pretty)), { result: 'reject', reason: 'statement_malformed' });
    const extra = statementBody({ ...clone(s), note: 'extra' });
    detached('reject-statement-extra-member', 'a statement with a member outside the schema, signed', 'bundle-manifest.json', 'large', envelope(ST, extra, signRaw(ST, extra)), { result: 'reject', reason: 'statement_malformed' });
  }
  detached('reject-other-key', 'the statement signed with another key (RFC 8032 TEST 2) under the pinned kid', 'bundle-manifest.json', 'large', envelope(ST, b, signRaw(ST, b, K2)), { result: 'reject', reason: 'signature' });
}

// --- embedded signatures: the report (and a cross-check record), raw and digest, derived statement
const unsigned = (doc) => { const d = clone(doc); delete d.signing.signature; return d; };
const derive = (doc, kind) => {
  const body = Buffer.from(jcs(unsigned(doc)), 'utf8');
  return {
    statement_version: '1.0',
    subject: { payload_type: doc.signing.payload_type, sha256: sha(body), bytes: body.length },
    ...(kind === 'report' ? { run_id: doc.run.run_id, run_manifest_digest: doc.signing.run_manifest_digest } : {}),
    signing: { algorithm: 'ed25519', signing_key_id: doc.signing.signing_key_id, canonicalization: 'jcs-rfc8785', payload_type: ST, excluded: ['/signing/signature'], sealed_at: kind === 'report' ? doc.signing.sealed_at : doc.finished_at },
  };
};
const embedded = (id, description, file, ref, signedForm, signature, env, expect) => vectors.push({
  id, description, kind: 'embedded', file, document: { ref, ...(signedForm ? { signed_form: signedForm } : {}), signature }, ...(env ? { envelope: env } : {}), expect,
});
{
  const t = TYPE['report.json'];
  const raw = Buffer.from(jcs(unsigned(report)), 'utf8');
  const rawSig = signRaw(t, raw);
  embedded('accept-embedded-report-raw', 'report examples[2] as sealed in 2.2.0 (no signed_form): the signature equals fixtures/signing_vectors.json vectors[0]', 'report.json', 'schemas/report.schema.json#/examples/2', null, rawSig.toString('base64'), envelope(t, raw, rawSig), { result: 'accept', form: 'raw' });
  const d = clone(report); d.signing.signed_form = 'digest_statement';
  const st = derive(d, 'report');
  const sb = statementBody(st);
  const sig = signRaw(ST, sb);
  embedded('accept-embedded-report-digest', 'report examples[2] with signing.signed_form = digest_statement: the signature is over the statement derived from the report', 'report.json', 'schemas/report.schema.json#/examples/2', 'digest_statement', sig.toString('base64'), envelope(ST, sb, sig), { result: 'accept', form: 'digest_statement', statement_jcs_sha256: sha(sb) });
  embedded('reject-embedded-form-mismatch', 'the digest-form report with a report.json.dsse.json in the raw form (payloadType = report type)', 'report.json', 'schemas/report.schema.json#/examples/2', 'digest_statement', sig.toString('base64'), envelope(t, Buffer.from(jcs(unsigned(d)), 'utf8'), sig), { result: 'reject', reason: 'form_mismatch' });
  embedded('reject-embedded-form-removed', 'the digest signature on the report with signed_form removed: the raw check fails', 'report.json', 'schemas/report.schema.json#/examples/2', null, sig.toString('base64'), null, { result: 'reject', reason: 'signature' });
  embedded('reject-embedded-form-raw-with-digest-signature', 'signed_form raw with the digest signature (the form is inside the signed body, so it cannot be switched)', 'report.json', 'schemas/report.schema.json#/examples/2', 'raw', sig.toString('base64'), null, { result: 'reject', reason: 'signature' });
}
{
  const d = clone(xrec); d.signing.signed_form = 'digest_statement';
  const sb = statementBody(derive(d, 'crosscheck'));
  const sig = signRaw(ST, sb);
  embedded('accept-embedded-crosscheck-digest', 'crosscheck_record examples[0] with signed_form digest_statement: no run binding, sealed_at = finished_at', 'crosscheck', 'schemas/crosscheck_record.schema.json#/examples/0', 'digest_statement', sig.toString('base64'), null, { result: 'accept', form: 'digest_statement' });
}

for (const v of vectors) if (v.expect.result === 'accept' && v.envelope) {
  const p = Buffer.from(v.envelope.payload, 'base64');
  if (!verify(null, pae(v.envelope.payloadType, p), K1.pub, Buffer.from(v.envelope.signatures[0].sig, 'base64'))) throw new Error(`self-check failed: ${v.id}`);
}

const out = {
  description: 'Contract test vectors for signing.md section 5.2 (signed digest statements, contracts 2.11.0). Signatures use the Ed25519 key of RFC 8032 section 7.1 TEST 1 (reject-other-key: TEST 2), published test vectors and never Sixi keys, under the example report kid. A verifier is given: the served bytes (served.ref, then served.mutation if present: xor_byte flips bits of one byte, append_hex appends bytes), the envelope, the binding context (the report the files belong to) and the pinned key (no window), and must reach expect. For kind embedded, the document is document.ref with signing.signed_form set (or left absent) and signing.signature replaced. Every reject is caused by the rule its reason names; every other check passes. Regenerate with node contracts/tools/digest-statement-vectors.mjs.',
  constants: { ARENA_SIGN_MAX_MESSAGE_BYTES, statement_payload_type: ST, maps_from: 'SIXI_ARENA_KMS_SIGN_MAX_BYTES (Sixi control plane) <= ARENA_SIGN_MAX_MESSAGE_BYTES' },
  key: { source: 'RFC 8032 section 7.1 TEST 1', jwk: { kty: 'OKP', crv: 'Ed25519', x: K1.x, kid, alg: 'EdDSA', use: 'sig' } },
  context: ctx,
  payloads: Object.fromEntries(Object.entries(PAYLOADS).map(([k, v]) => [k, { ref: v.ref, bytes: v.bytes.length, sha256: sha(v.bytes) }])),
  reasons: ['payload_type', 'raw_over_threshold', 'payload_mismatch', 'statement_malformed', 'subject_type', 'length_mismatch', 'digest_mismatch', 'binding', 'form_mismatch', 'key', 'signature'],
  vectors,
};
writeFileSync(join(CONTRACTS, 'fixtures', 'digest_statement_vectors.json'), `${JSON.stringify(out, null, 2)}\n`);
// The schema example is the statement of accept-digest-large-bundle-manifest with a placeholder signature
// (contract-check §16 keeps the signed body equal).
const schemaPath = join(CONTRACTS, 'schemas', 'digest_statement.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
schema.examples = [largeStatement];
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`wrote ${vectors.length} digest-statement vectors; large payload ${large.length} bytes (${sha(large)})`);
