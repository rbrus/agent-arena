/**
 * Contracts 2.11.0 end to end on a real hosted bundle (a byzantine run against the reference target):
 *   - signing.md §5.2 in `verify --hosted-seal` and `verify --hosted`: a bundle sealed with every mix of raw and
 *     digest-statement forms verifies, `--json` carries `signed_forms`, the human output names the form per file,
 *     and each tampering is `signature_invalid` exit 2 naming its reason token;
 *   - `verify --hosted-seal --result <path>` (the Sixi verifier job, docs/phase-9/pr/PR6.md): the file is the
 *     `--json` document, for every exit, create-only, outside the bundle;
 *   - signing.md §3.3 rule 2: `--manifest-key` refused on `verify --hosted` and `verify --hosted-seal` by a
 *     pinning release, before anything is read.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalizeForSigning, embeddedSignedMessage, jcs, REPORT_PAYLOAD_TYPE, signReport, toFileJson, type Report, type SignedForm } from 'arena-report';
import { verifyCommand, verifyHostedSeal } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { BUNDLE_PAYLOAD_TYPE, DIGEST_STATEMENT_PAYLOAD_TYPE, SARIF_PAYLOAD_TYPE } from '../src/hosted/digest-statement.ts';
import { main } from '../src/main.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { dsseEnvelope, hostedEnv, MANIFEST_KID, NO_PIN, PLATFORM, PRIV, PUB, pubJwk, REPORT_KID, runHosted, runSpec, signManifest, unsignedManifest, viaReference, writeInputs } from './hosted-fixtures.ts';
import { scratch } from './helpers.ts';

const SEALED_AT = '2026-11-10T14:07:00Z';
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

let srv: ReferenceServer;
let unsealed: string;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
  const spec = runSpec({ seeds: [20260720], episodes: 1 });
  const dir = scratch();
  const inputs = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec)), spec);
  unsealed = join(dir, 'out');
  const r = await runHosted({ ...inputs, manifestKey: pubJwk(MANIFEST_KID), out: unsealed }, { env: hostedEnv(), platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, {}) });
  assert.equal(r.exitCode, 0);
});
after(async () => {
  await srv.close();
});

/** A copy of the runner's output (each test gets its own bundle). */
function bundle(): string {
  const out = join(scratch(), 'out');
  const copy = (from: string, to: string) => {
    for (const n of readdirSync(from)) {
      const p = join(from, n);
      if (statSync(p).isDirectory()) copy(p, join(to, n));
      else {
        mkdirSync(to, { recursive: true });
        writeFileSync(join(to, n), readFileSync(p));
      }
    }
  };
  copy(unsealed, out);
  return out;
}

/** The detached envelope of `file` in the chosen form (signing.md §5.2 "Where the statement lives"). */
function detached(bytes: Buffer, T: string, form: SignedForm, sealed: Report, over: (s: Record<string, any>) => void = () => {}): string {
  if (form === 'raw') return dsseEnvelope(bytes, T, REPORT_KID);
  const st: Record<string, any> = {
    statement_version: '1.0',
    subject: { payload_type: T, sha256: sha(bytes), bytes: bytes.length },
    run_id: sealed.run.run_id,
    run_manifest_digest: sealed.signing!.run_manifest_digest,
    signing: { algorithm: 'ed25519', signing_key_id: REPORT_KID, canonicalization: 'jcs-rfc8785', payload_type: DIGEST_STATEMENT_PAYLOAD_TYPE, excluded: ['/signing/signature'], sealed_at: sealed.signing!.sealed_at },
  };
  over(st);
  return dsseEnvelope(Buffer.from(jcs(st), 'utf8'), DIGEST_STATEMENT_PAYLOAD_TYPE, REPORT_KID);
}

/** What the Sixi seal step writes, per file in the form asked for (the RFC 8032 test key stands in for the KMS key). */
function seal(out: string, forms: { report: SignedForm; sarif: SignedForm; bundle: SignedForm }): Report {
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
  const sealed = signReport(report, PRIV, REPORT_KID, { sealedAt: SEALED_AT, signedForm: forms.report });
  writeFileSync(join(out, 'report.json'), toFileJson(sealed));
  const m = embeddedSignedMessage(sealed, REPORT_PAYLOAD_TYPE);
  writeFileSync(join(out, 'report.json.dsse.json'), `${JSON.stringify({ payloadType: m.paeType, payload: m.body.toString('base64'), signatures: [{ keyid: REPORT_KID, sig: sealed.signing!.signature }] })}\n`);
  writeFileSync(join(out, 'report.sarif.dsse.json'), detached(readFileSync(join(out, 'report.sarif')), SARIF_PAYLOAD_TYPE, forms.sarif, sealed));
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(out, p);
        if (/^(report\.json|report\.sarif|run-manifest\.json|episodes\/\d+\.(record|replay)\.json)$/.test(rel)) {
          const b = readFileSync(p);
          files.push({ path: rel, sha256: sha(b), bytes: b.length });
        }
      }
    }
  };
  walk(out);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const bm = Buffer.from(`${JSON.stringify({ bundle_version: '1.0', run_id: sealed.run.run_id, signing_key_id: REPORT_KID, files }, null, 2)}\n`);
  writeFileSync(join(out, 'bundle-manifest.json'), bm);
  writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), detached(bm, BUNDLE_PAYLOAD_TYPE, forms.bundle, sealed));
  return sealed;
}

/** Everything written to stdout while `fn` runs, with the output mode set as main() would. */
function capture(fn: () => unknown, mode: { json?: boolean; quiet?: boolean } = {}): { text: string; value: unknown; error?: unknown } {
  const ow = process.stdout.write;
  let text = '';
  process.stdout.write = ((c: string | Uint8Array) => ((text += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')), true)) as typeof process.stdout.write;
  setOutputMode(mode);
  let value: unknown;
  let error: unknown;
  try {
    value = fn();
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = ow;
    setOutputMode({ quiet: true });
  }
  return { text, value, ...(error !== undefined ? { error } : {}) };
}

const KEY = { pinnedKeys: NO_PIN, key: pubJwk(REPORT_KID), manifestKey: pubJwk(MANIFEST_KID) };

describe('signing.md §5.2 in verify --hosted-seal and verify --hosted', () => {
  const FORMS: SignedForm[] = ['raw', 'digest_statement'];
  for (const report of FORMS) {
    for (const sarif of FORMS) {
      for (const bm of FORMS) {
        test(`a bundle sealed report=${report} sarif=${sarif} bundle-manifest=${bm} verifies; --json signed_forms and the human lines name each form`, () => {
          const out = bundle();
          seal(out, { report, sarif, bundle: bm });
          const j = capture(() => verifyHostedSeal(out, KEY), { json: true });
          assert.equal(j.value, 0, j.text);
          const doc = JSON.parse(j.text);
          assert.equal(doc.status, 'verified');
          assert.deepEqual(doc.signed_forms, { 'report.json': report, 'report.sarif': sarif, 'bundle-manifest.json': bm });
          const h = capture(() => verifyHostedSeal(out, KEY));
          assert.equal(h.value, 0);
          const name = (f: SignedForm) => (f === 'raw' ? 'raw signature \\(\\d+ bytes\\)' : 'digest statement \\(\\d+ bytes, sha256:[0-9a-f]{64}\\)');
          assert.match(h.text, new RegExp(`^report\\.json: ${name(report)} verified with ${REPORT_KID}$`, 'm'));
          assert.match(h.text, new RegExp(`^report\\.sarif: ${name(sarif)} verified with ${REPORT_KID}$`, 'm'));
          assert.match(h.text, new RegExp(`^bundle-manifest\\.json: ${name(bm)} verified with ${REPORT_KID}$`, 'm'));
        });
      }
    }
  }

  test('verify --hosted reports signed_forms with the single member report.json, in both forms', () => {
    for (const form of FORMS) {
      const out = bundle();
      seal(out, { report: form, sarif: 'raw', bundle: 'raw' });
      const j = capture(() => verifyCommand(join(out, 'report.json'), { ...KEY, hosted: true }), { json: true });
      assert.equal(j.value, 0, j.text);
      assert.deepEqual(JSON.parse(j.text).signed_forms, { 'report.json': form });
      const h = capture(() => verifyCommand(join(out, 'report.json'), { ...KEY, hosted: true }));
      assert.match(h.text, new RegExp(`^report\\.json: ${form === 'raw' ? 'raw signature' : 'digest statement'} \\(`, 'm'));
    }
  });

  const refusals: [string, (out: string, sealed: Report) => void, RegExp][] = [
    ['report.sarif edited after sealing (statement form)', (out) => writeFileSync(join(out, 'report.sarif'), readFileSync(join(out, 'report.sarif'), 'utf8').replace('"results"', '"results" ')), /signature_invalid: length_mismatch: report\.sarif: /],
    ['one byte of report.sarif flipped (statement form)', (out) => writeFileSync(join(out, 'report.sarif'), readFileSync(join(out, 'report.sarif'), 'utf8').replace('"version": "2.1.0"', '"version": "2.1.1"')), /signature_invalid: digest_mismatch: report\.sarif: /],
    ['a SARIF statement presented as the bundle-manifest envelope', (out) => writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), readFileSync(join(out, 'report.sarif.dsse.json'))), /signature_invalid: subject_type: bundle-manifest\.json: /],
    ['a bundle statement naming another run', (out, sealed) => writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), detached(readFileSync(join(out, 'bundle-manifest.json')), BUNDLE_PAYLOAD_TYPE, 'digest_statement', sealed, (s) => (s.run_id = 'run_01JB5H0STED0TEST000000000B'))), /signature_invalid: binding: bundle-manifest\.json: /],
    ['a bundle statement with a member outside the schema', (out, sealed) => writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), detached(readFileSync(join(out, 'bundle-manifest.json')), BUNDLE_PAYLOAD_TYPE, 'digest_statement', sealed, (s) => (s.note = 'x'))), /signature_invalid: statement_malformed: bundle-manifest\.json: /],
    ['a run-manifest envelope in place of the SARIF envelope', (out) => {
      const e = JSON.parse(readFileSync(join(out, 'report.sarif.dsse.json'), 'utf8'));
      writeFileSync(join(out, 'report.sarif.dsse.json'), JSON.stringify({ ...e, payloadType: 'application/vnd.sixi.arena-run-manifest+json' }));
    }, /signature_invalid: payload_type: report\.sarif: /],
    ['the digest-form report with a raw report.json.dsse.json', (out) => {
      const r = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
      const body = Buffer.from(canonicalizeForSigning(r), 'utf8');
      writeFileSync(join(out, 'report.json.dsse.json'), JSON.stringify({ payloadType: REPORT_PAYLOAD_TYPE, payload: body.toString('base64'), signatures: [{ keyid: REPORT_KID, sig: r.signing.signature }] }));
    }, /signature_invalid: form_mismatch: report\.json\.dsse\.json: /],
    ['signed_form switched to raw in report.json (the form is inside the signed body)', (out) => {
      const r = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
      r.signing.signed_form = 'raw';
      writeFileSync(join(out, 'report.json'), toFileJson(r));
    }, /signature_invalid: form_mismatch: report\.json\.dsse\.json: /],
  ];
  for (const [name, mutate, re] of refusals) {
    test(`refused, exit 2: ${name}`, () => {
      const out = bundle();
      const sealed = seal(out, { report: 'digest_statement', sarif: 'digest_statement', bundle: 'digest_statement' });
      mutate(out, sealed);
      const h = capture(() => verifyHostedSeal(out, KEY));
      assert.equal(h.value, 2, h.text);
      assert.match(h.text, re);
      const j = capture(() => verifyHostedSeal(out, KEY), { json: true });
      const doc = JSON.parse(j.text);
      assert.equal(doc.exitCode, 2);
      assert.ok(doc.hosted_seal.seal.some((e: string) => re.test(e)), doc.hosted_seal.seal.join('\n'));
    });
  }

  test('verify --hosted: a digest-form report whose signed_form was removed is signature_invalid (signature), exit 2', () => {
    const out = bundle();
    seal(out, { report: 'digest_statement', sarif: 'raw', bundle: 'raw' });
    const r = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    delete r.signing.signed_form;
    writeFileSync(join(out, 'report.json'), toFileJson(r));
    const h = capture(() => verifyCommand(join(out, 'report.json'), { ...KEY, hosted: true }));
    assert.equal(h.value, 2);
    assert.match(h.text, /^signature_invalid: signature: report\.json: the Ed25519 signature does not verify/m);
  });

  test('a pinned report key outside its window at sealed_at is signature_invalid (key) on every file', () => {
    const out = bundle();
    seal(out, { report: 'digest_statement', sarif: 'raw', bundle: 'digest_statement' });
    const t = Date.parse(SEALED_AT);
    const expired = [{ key: PUB, kid: REPORT_KID, not_before: t - 90 * 86_400_000, not_after: t }];
    const h = capture(() => verifyHostedSeal(out, { pinnedKeys: NO_PIN, manifestKey: pubJwk(MANIFEST_KID), key: 'pinned', pinnedReportKeys: expired }));
    assert.equal(h.value, 2);
    for (const f of ['report.json', 'report.sarif', 'bundle-manifest.json']) assert.match(h.text, new RegExp(`^signature_invalid: key: ${f.replace('.', '\\.')}: the key ${REPORT_KID} does not cover the signing time`, 'm'));
  });
});

describe('verify --hosted-seal --result <path> (the Sixi verifier job)', () => {
  test('pre-seal, exit 0: the file is byte-identical to the --json document, whether or not --json is given', () => {
    const out = bundle();
    const dir = scratch();
    const j = capture(() => verifyHostedSeal(out, { ...KEY, key: undefined, result: join(dir, 'a.json') }), { json: true });
    assert.equal(j.value, 0, j.text);
    assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), j.text);
    const h = capture(() => verifyHostedSeal(out, { ...KEY, key: undefined, result: join(dir, 'b.json') }));
    assert.equal(h.value, 0);
    assert.match(h.text, /^result written: .*b\.json$/m);
    const doc = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8'));
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.status, 'verified');
    assert.equal(doc.ok, true);
    assert.equal(doc.hosted_seal.sealed, false);
    assert.equal(doc.hosted_seal.sarif_equal, true);
    assert.deepEqual(doc.hosted_seal.seal, []);
    assert.deepEqual(doc.hosted_seal.mismatch, []);
    assert.deepEqual(doc.signed_forms, {});
    assert.deepEqual(readFileSync(join(dir, 'a.json')), readFileSync(join(dir, 'b.json')));
  });

  test('--expect-manifest-digest and the verifier job arguments of PR 6: the issued digest verifies, another is exit 2 with the result written', () => {
    const out = bundle();
    const dir = scratch();
    const issued = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).run.hosted.run_manifest.digest;
    assert.equal(capture(() => verifyHostedSeal(out, { ...KEY, key: undefined, expectManifestDigest: issued, result: join(dir, 'ok.json') }), { json: true }).value, 0);
    assert.equal(capture(() => verifyHostedSeal(out, { ...KEY, key: undefined, expectManifestDigest: `sha256:${'0'.repeat(64)}`, result: join(dir, 'bad.json') }), { json: true }).value, 2);
    const bad = JSON.parse(readFileSync(join(dir, 'bad.json'), 'utf8'));
    assert.equal(bad.exitCode, 2);
    assert.equal(bad.status, 'unverifiable');
    assert.ok(bad.hosted_seal.seal.some((e: string) => /--expect-manifest-digest differs/.test(e)));
  });

  test('mismatch, exit 1: the SARIF edited after the run; the result says so', () => {
    const out = bundle();
    const dir = scratch();
    writeFileSync(join(out, 'report.sarif'), readFileSync(join(out, 'report.sarif'), 'utf8').replace('"results"', '"results" '));
    assert.equal(capture(() => verifyHostedSeal(out, { ...KEY, key: undefined, result: join(dir, 'r.json') })).value, 1);
    const doc = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
    assert.equal(doc.exitCode, 1);
    assert.equal(doc.status, 'mismatch');
    assert.equal(doc.hosted_seal.sarif_equal, false);
  });

  test('misuse after the path is accepted (a sealed bundle without --key): exit 3, and the result records it', () => {
    const out = bundle();
    seal(out, { report: 'raw', sarif: 'raw', bundle: 'raw' });
    const dir = scratch();
    const r = capture(() => verifyHostedSeal(out, { pinnedKeys: NO_PIN, manifestKey: pubJwk(MANIFEST_KID), result: join(dir, 'r.json') }));
    assert.ok(r.error instanceof CliError && r.error.exitCode === 3);
    const doc = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
    assert.deepEqual({ ok: doc.ok, status: doc.status, exitCode: doc.exitCode }, { ok: false, status: 'misuse', exitCode: 3 });
    assert.match(doc.errors[0], /needs the report-signing public key/);
  });

  test('the path: an existing file, a symbolic link, a path inside the bundle and a missing directory are refused (exit 3) before the bundle is read, and nothing is written', () => {
    const out = bundle();
    const dir = scratch();
    writeFileSync(join(dir, 'exists.json'), 'keep\n');
    symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'link.json'));
    const cases: [string, RegExp][] = [
      [join(dir, 'exists.json'), /already exists/],
      [join(dir, 'link.json'), /already exists/],
      [join(out, 'verify.json'), /inside the bundle/],
      [join(out, 'episodes', 'verify.json'), /inside the bundle/],
      [join(dir, 'no-such-dir', 'verify.json'), /does not exist/],
    ];
    for (const [p, re] of cases) {
      // A path that is not a bundle proves the refusal comes first: nothing is read.
      const r = capture(() => verifyHostedSeal(out, { ...KEY, result: p }));
      assert.ok(r.error instanceof CliError && r.error.exitCode === 3 && re.test(r.error.message), `${p}: ${String(r.error)}`);
    }
    assert.equal(readFileSync(join(dir, 'exists.json'), 'utf8'), 'keep\n');
    assert.equal(existsSync(join(dir, 'elsewhere.json')), false);
    assert.equal(existsSync(join(out, 'verify.json')), false);
  });

  test('through the command line: --result needs --hosted-seal (exit 3); with it, the job arguments of PR 6 work', async () => {
    const out = bundle();
    const dir = scratch();
    const r = capture(() => main(['verify', join(out, 'report.json'), '--result', join(dir, 'x.json')]));
    await assert.rejects(r.value as Promise<number>, (e: unknown) => e instanceof CliError && e.exitCode === 3 && /needs --hosted-seal/.test(e.message));
    const ok = capture(() => main(['verify', '--hosted-seal', out, '--manifest-key', pubJwk(MANIFEST_KID), '--json', '--result', join(dir, 'verify.json')], { pinnedManifestKeys: NO_PIN }));
    assert.equal(await (ok.value as Promise<number>), 0);
    assert.equal(readFileSync(join(dir, 'verify.json'), 'utf8'), ok.text);
  });
});

describe('signing.md §3.3 rule 2: --manifest-key refused on verify by a pinning release, before anything is read', () => {
  const refused = (e: unknown) => e instanceof CliError && e.exitCode === 3 && /^hosted_context_invalid \(--manifest-key\): this release pins the control-plane manifest key set/.test(e.message);
  test('verify --hosted-seal (the production pinned set; the path does not exist)', () => {
    assert.throws(() => verifyHostedSeal('/nonexistent/bundle', { manifestKey: pubJwk(MANIFEST_KID) }), refused);
    assert.throws(() => verifyHostedSeal('/nonexistent/bundle', { manifestKey: pubJwk(MANIFEST_KID), result: '/nonexistent/verify.json' }), refused);
  });
  test('verify --hosted', () => {
    assert.throws(() => verifyCommand('/nonexistent/report.json', { hosted: true, key: pubJwk(REPORT_KID), manifestKey: pubJwk(MANIFEST_KID) }), refused);
  });
  test('through the command line, with a pinned test set', async () => {
    const pinned = { pinnedManifestKeys: [{ key: PUB, kid: MANIFEST_KID }] };
    await assert.rejects(main(['verify', '--hosted-seal', '/nonexistent', '--manifest-key', pubJwk(MANIFEST_KID)], pinned), refused);
    await assert.rejects(main(['verify', '/nonexistent/report.json', '--hosted', '--key', pubJwk(REPORT_KID), '--manifest-key', pubJwk(MANIFEST_KID)], pinned), refused);
  });
});

describe('SECURITY-REVIEW-HOSTED §8: G-62, G-63 and G-52 on the verify path', () => {
  for (const [name, text] of [['null', 'null'], ['[]', '[]'], ['{}', '{}'], ['{"signing":null}', '{"signing":null}']] as const) {
    test(`G-62: a report.json of ${name} is refused (exit 2, unverifiable) and the result file records exit 2`, () => {
      const out = bundle();
      writeFileSync(join(out, 'report.json'), `${text}\n`);
      const dir = scratch();
      const r = capture(() => verifyHostedSeal(out, { ...KEY, result: join(dir, 'r.json') }), { json: true });
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.value, 2);
      const doc = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
      assert.deepEqual({ ok: doc.ok, status: doc.status, exitCode: doc.exitCode }, { ok: false, status: 'unverifiable', exitCode: 2 });
      assert.equal(readFileSync(join(dir, 'r.json'), 'utf8'), r.text);
    });
  }

  const OSC8 = '\u001b]8;;https://evil.example/\u0007click\u001b]8;;\u0007';
  const hostile: [string, (r: Record<string, any>) => void][] = [
    ['a 1 MB signing_key_id holding an OSC 8 link', (r) => (r.signing.signing_key_id = `${REPORT_KID}${OSC8}${'k'.repeat(1_000_000)}`)],
    ['a 1 MB sealed_at holding an OSC 8 link', (r) => (r.signing.sealed_at = `${SEALED_AT}${OSC8}${'9'.repeat(1_000_000)}`)],
  ];
  for (const [name, edit] of hostile) {
    test(`G-63: ${name}: exit 2, and the --json document and the result file stay under 64 KiB with no escape character`, () => {
      const out = bundle();
      seal(out, { report: 'digest_statement', sarif: 'raw', bundle: 'digest_statement' });
      const r = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
      edit(r);
      writeFileSync(join(out, 'report.json'), toFileJson(r));
      const dir = scratch();
      const j = capture(() => verifyHostedSeal(out, { ...KEY, result: join(dir, 'r.json') }), { json: true });
      assert.equal(j.value, 2, String(j.error));
      const file = readFileSync(join(dir, 'r.json'), 'utf8');
      assert.equal(JSON.parse(file).exitCode, 2);
      assert.ok(Buffer.byteLength(file) < 64 * 1024, `result file is ${Buffer.byteLength(file)} bytes`);
      assert.ok(Buffer.byteLength(j.text) < 64 * 1024, `--json document is ${Buffer.byteLength(j.text)} bytes`);
      assert.ok(!file.includes('\u001b') && !j.text.includes('\u001b'));
      assert.ok(JSON.parse(file).hosted_seal.seal.some((e: string) => /^signature_invalid: signature: report\.json: /.test(e)));
      // verify --hosted (the embedded signature alone) is bounded the same way.
      const h = capture(() => verifyCommand(join(out, 'report.json'), { ...KEY, hosted: true }), { json: true });
      assert.equal(h.value, 2);
      assert.ok(Buffer.byteLength(h.text) < 64 * 1024, `verify --hosted --json is ${Buffer.byteLength(h.text)} bytes`);
    });
  }

  test('G-52: a signature spelled in non-canonical base64 (unused bits set) is refused, though it decodes to the valid signature', () => {
    const out = bundle();
    seal(out, { report: 'raw', sarif: 'raw', bundle: 'raw' });
    const p = join(out, 'report.sarif.dsse.json');
    const env = JSON.parse(readFileSync(p, 'utf8'));
    const sig: string = env.signatures[0].sig;
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = sig.length - 3; // 64 bytes = 86 characters + "==": the 86th carries 4 unused bits
    env.signatures[0].sig = `${sig.slice(0, last)}${A[A.indexOf(sig[last]!) ^ 1]}==`;
    assert.ok(Buffer.from(env.signatures[0].sig, 'base64').equals(Buffer.from(sig, 'base64')));
    writeFileSync(p, JSON.stringify(env));
    const h = capture(() => verifyHostedSeal(out, KEY));
    assert.equal(h.value, 2, h.text);
    assert.match(h.text, /^signature_invalid: signature: report\.sarif: the envelope signature is not canonical standard base64/m);
  });
});
