/**
 * Contracts 2.11.0, signing.md §5.2 (signed digest statements): every vector of
 * contracts/fixtures/digest_statement_vectors.json replayed through the CLI's verifier (D1-D9 detached,
 * E1-E4 embedded), and the embedded ones through arena-report's verifyDocumentSignature, which
 * `verify --key` and the re-simulation use. Plus the rules no vector exercises: the `key` token (an
 * unknown kid, a pinned key outside its window) and a raw embedded signature over the threshold.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ARENA_SIGN_MAX_MESSAGE_BYTES,
  canonicalizeForSigning,
  CROSSCHECK_PAYLOAD_TYPE,
  DIGEST_STATEMENT_PAYLOAD_TYPE,
  embeddedSignedMessage,
  pae,
  REPORT_PAYLOAD_TYPE,
  SIGNATURE_REASONS,
  signReport,
  toPublicKey,
  verifyDocumentSignature,
  verifyReportSignature,
  type Report,
} from 'arena-report';
import { contractsDir } from 'wot-contracts/contracts-dir';
import { createHash, sign as edSign } from 'node:crypto';
import { BUNDLE_PAYLOAD_TYPE, SARIF_PAYLOAD_TYPE, SignatureRefusal, signedFormLine, verifyDetachedEnvelope, verifyEmbeddedSignature, type BindingContext } from '../src/hosted/digest-statement.ts';
import type { PinnedKey } from '../src/keys.ts';
import { PRIV } from './hosted-fixtures.ts';

const CONTRACTS = contractsDir();
const V = JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'digest_statement_vectors.json'), 'utf8')) as {
  constants: { ARENA_SIGN_MAX_MESSAGE_BYTES: number; statement_payload_type: string };
  key: { jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string } };
  context: BindingContext;
  payloads: Record<string, { ref: string; bytes: number; sha256: string }>;
  reasons: string[];
  vectors: Vector[];
};
interface Vector {
  id: string;
  description: string;
  kind: 'detached' | 'embedded';
  file: string;
  served?: { ref: string; mutation?: { xor_byte?: { offset: number; mask: number }; append_hex?: string } };
  document?: { ref: string; signed_form?: string; signature: string };
  envelope?: unknown;
  expect: { result: 'accept' | 'reject'; form?: string; reason?: string; statement_jcs_sha256?: string };
}

const TYPE: Record<string, string> = { 'report.json': REPORT_PAYLOAD_TYPE, 'report.sarif': SARIF_PAYLOAD_TYPE, 'bundle-manifest.json': BUNDLE_PAYLOAD_TYPE, crosscheck: CROSSCHECK_PAYLOAD_TYPE };
const KEYS: PinnedKey[] = [{ key: toPublicKey(V.key.jwk), kid: V.key.jwk.kid }];

function served(v: Vector): Buffer {
  let b = readFileSync(join(CONTRACTS, v.served!.ref));
  const m = v.served!.mutation;
  if (m?.xor_byte) {
    b = Buffer.from(b);
    b[m.xor_byte.offset] = b[m.xor_byte.offset]! ^ m.xor_byte.mask;
  }
  if (m?.append_hex) b = Buffer.concat([b, Buffer.from(m.append_hex, 'hex')]);
  return b;
}

function documentOf(v: Vector): Record<string, any> {
  const [file, pointer] = v.document!.ref.split('#');
  const i = Number(pointer!.split('/').pop());
  const doc = structuredClone(JSON.parse(readFileSync(join(CONTRACTS, file!), 'utf8')).examples[i]) as Record<string, any>;
  if (v.document!.signed_form !== undefined) doc.signing.signed_form = v.document!.signed_form;
  else delete doc.signing.signed_form;
  doc.signing.signature = v.document!.signature;
  return doc;
}

/** The CLI verifier's outcome for one vector: `accept:<form>` or `reject:<reason>`. */
function outcome(v: Vector): string {
  try {
    const r = v.kind === 'detached' ? verifyDetachedEnvelope(v.envelope, served(v), TYPE[v.file]!, V.context, KEYS, v.file) : verifyEmbeddedSignature(documentOf(v), TYPE[v.file]!, KEYS, v.file, v.envelope);
    return `accept:${r.form}`;
  } catch (e) {
    if (e instanceof SignatureRefusal) return `reject:${e.reason}`;
    throw e;
  }
}
const expected = (v: Vector) => (v.expect.result === 'accept' ? `accept:${v.expect.form}` : `reject:${v.expect.reason}`);

test('the vector file is the one this CLI implements: 23 vectors, the constant 65536, the statement type, the eleven reason tokens', () => {
  assert.equal(V.vectors.length, 23);
  assert.equal(V.constants.ARENA_SIGN_MAX_MESSAGE_BYTES, ARENA_SIGN_MAX_MESSAGE_BYTES);
  assert.equal(ARENA_SIGN_MAX_MESSAGE_BYTES, 65536);
  assert.equal(V.constants.statement_payload_type, DIGEST_STATEMENT_PAYLOAD_TYPE);
  assert.deepEqual(V.reasons, [...SIGNATURE_REASONS]);
  for (const [k, p] of Object.entries(V.payloads)) assert.equal(readFileSync(join(CONTRACTS, p.ref)).length, p.bytes, k);
});

for (const v of (JSON.parse(readFileSync(join(contractsDir(), 'fixtures', 'digest_statement_vectors.json'), 'utf8')) as typeof V).vectors) {
  test(`vector ${v.id}: ${v.expect.result === 'accept' ? `accepted, ${v.expect.form}` : `signature_invalid (${v.expect.reason})`}`, () => {
    assert.equal(outcome(v), expected(v), v.description);
  });
}

test('every accepted vector names its form on the verified line; the statement form carries the sha256 of the covered bytes', () => {
  const lines = V.vectors
    .filter((v) => v.expect.result === 'accept')
    .map((v) => signedFormLine(v.kind === 'detached' ? verifyDetachedEnvelope(v.envelope, served(v), TYPE[v.file]!, V.context, KEYS, v.file) : verifyEmbeddedSignature(documentOf(v), TYPE[v.file]!, KEYS, v.file, v.envelope)));
  assert.ok(lines.includes('report.sarif: raw signature (17857 bytes) verified with sixi-arena-ed25519-20261101'));
  assert.ok(lines.includes(`bundle-manifest.json: digest statement (80070 bytes, ${V.payloads.large!.sha256}) verified with sixi-arena-ed25519-20261101`));
  assert.ok(lines.some((l) => /^report\.json: digest statement \(\d+ bytes, sha256:[0-9a-f]{64}\) verified with sixi-arena-ed25519-20261101$/.test(l)));
});

test('the digest-form report: the derived statement is the one the vector signed (statement_jcs_sha256), and it is the envelope payload', () => {
  const v = V.vectors.find((x) => x.id === 'accept-embedded-report-digest')!;
  const m = embeddedSignedMessage(documentOf(v), REPORT_PAYLOAD_TYPE);
  assert.equal(m.form, 'digest_statement');
  assert.equal(m.paeType, DIGEST_STATEMENT_PAYLOAD_TYPE);
  assert.equal(`sha256:${createHash('sha256').update(m.body).digest('hex')}`, v.expect.statement_jcs_sha256);
  assert.equal(Buffer.from((v.envelope as { payload: string }).payload, 'base64').toString('utf8'), m.body.toString('utf8'));
});

test('arena-report verifyDocumentSignature (verify --key, the re-simulation) agrees on every embedded vector that needs no envelope', () => {
  for (const v of V.vectors.filter((x) => x.kind === 'embedded' && x.expect.reason !== 'form_mismatch')) {
    const c = verifyDocumentSignature(documentOf(v), V.key.jwk, TYPE[v.file]!);
    assert.equal(c.ok ? 'accept' : `reject:${c.reason}`, v.expect.result === 'accept' ? 'accept' : `reject:${v.expect.reason}`, v.id);
    if (!c.ok) assert.match(c.errors[0]!, new RegExp(`^${v.expect.reason}: `), v.id);
  }
  const report = documentOf(V.vectors.find((x) => x.id === 'accept-embedded-report-digest')!);
  assert.deepEqual(verifyReportSignature(report, V.key.jwk), { ok: true, status: 'valid', kid: 'sixi-arena-ed25519-20261101', errors: [] });
});

test('key: an unknown kid, a pinned key outside its window at sealed_at, and a revoked key are signature_invalid (key)', () => {
  const v = V.vectors.find((x) => x.id === 'accept-digest-large-bundle-manifest')!;
  const reason = (keys: PinnedKey[]) => {
    try {
      verifyDetachedEnvelope(v.envelope, served(v), BUNDLE_PAYLOAD_TYPE, V.context, keys, v.file);
      return 'accept';
    } catch (e) {
      return (e as SignatureRefusal).reason;
    }
  };
  const t = Date.parse(V.context.sealed_at);
  assert.equal(reason([{ ...KEYS[0]!, kid: 'sixi-arena-ed25519-20990101' }]), 'key');
  assert.equal(reason([{ ...KEYS[0]!, not_before: t - 86_400_000, not_after: t }]), 'key', 'not_after is exclusive');
  assert.equal(reason([{ ...KEYS[0]!, not_before: t + 1000, not_after: t + 86_400_000 }]), 'key');
  assert.equal(reason([{ ...KEYS[0]!, not_before: t - 86_400_000, not_after: t + 86_400_000, revoked_at: t }]), 'key');
  assert.equal(reason([{ ...KEYS[0]!, not_before: t - 86_400_000, not_after: t + 1000 }]), 'accept');
  const embedded = V.vectors.find((x) => x.id === 'accept-embedded-report-raw')!;
  assert.throws(() => verifyEmbeddedSignature(documentOf(embedded), REPORT_PAYLOAD_TYPE, [{ ...KEYS[0]!, not_before: t + 1000, not_after: t + 86_400_000 }], 'report.json'), (e: unknown) => e instanceof SignatureRefusal && e.reason === 'key' && /does not cover the signing time/.test(e.message));
});

test('raw_over_threshold on an embedded signature: a report whose raw PAE message is over 65536 bytes is refused although its signature verifies; the statement form of the same report is accepted', () => {
  const base = documentOf(V.vectors.find((x) => x.id === 'accept-embedded-report-raw')!);
  base.run.spec.labels = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(1500)]));
  delete base.signing.signed_form;
  const raw = Buffer.from(canonicalizeForSigning(base), 'utf8');
  const message = pae(REPORT_PAYLOAD_TYPE, raw);
  assert.ok(message.length > ARENA_SIGN_MAX_MESSAGE_BYTES);
  base.signing.signature = edSign(null, message, PRIV).toString('base64');
  assert.throws(() => verifyEmbeddedSignature(base, REPORT_PAYLOAD_TYPE, KEYS, 'report.json'), (e: unknown) => e instanceof SignatureRefusal && e.reason === 'raw_over_threshold');
  assert.equal(verifyDocumentSignature(base, V.key.jwk, REPORT_PAYLOAD_TYPE).reason, 'raw_over_threshold');
  const digest = { ...base, signing: { ...base.signing, signed_form: 'digest_statement' } };
  digest.signing.signature = edSign(null, embeddedSignedMessage(digest, REPORT_PAYLOAD_TYPE).message, PRIV).toString('base64');
  assert.equal(verifyEmbeddedSignature(digest, REPORT_PAYLOAD_TYPE, KEYS, 'report.json').form, 'digest_statement');
});

test('signReport (the test sealer): raw stays byte-identical to the 2.2.0 vector; digest_statement verifies; a run manifest never takes the statement form', () => {
  const report = JSON.parse(readFileSync(join(CONTRACTS, 'schemas', 'report.schema.json'), 'utf8')).examples[2] as Report;
  const rawVector = V.vectors.find((x) => x.id === 'accept-embedded-report-raw')!;
  const auto = signReport(report, PRIV, report.signing!.signing_key_id, { sealedAt: report.signing!.sealed_at });
  assert.equal(auto.signing!.signed_form, undefined, 'auto picks raw below the threshold');
  assert.equal(auto.signing!.signature, rawVector.document!.signature);
  const digest = signReport(report, PRIV, report.signing!.signing_key_id, { sealedAt: report.signing!.sealed_at, signedForm: 'digest_statement' });
  assert.equal(digest.signing!.signed_form, 'digest_statement');
  assert.equal(digest.signing!.signature, V.vectors.find((x) => x.id === 'accept-embedded-report-digest')!.document!.signature);
  const manifest = JSON.parse(readFileSync(join(CONTRACTS, 'schemas', 'hosted_context.schema.json'), 'utf8')).examples[0];
  manifest.signing.signed_form = 'digest_statement';
  const c = verifyDocumentSignature(manifest, V.key.jwk, 'application/vnd.sixi.arena-run-manifest+json');
  assert.equal(c.reason, 'form_mismatch');
});
