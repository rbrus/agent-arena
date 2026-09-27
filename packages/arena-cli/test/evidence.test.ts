/**
 * `agent-arena evidence` (signing.md §5.3 step 4; docs/phase-9/pr/PR7c-evidence.md): the Sixi sealer's evidence
 * job. The fixtures in test/fixtures/sixi-pr7c are the sealer's own inputs and the goldens its driver rendered
 * (PROVENANCE.md there); the command must reproduce the goldens byte for byte, through main() with the exact
 * EvidenceArgs of the PR 7c note.
 */

import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { CROSSCHECK_PAYLOAD_TYPE, signDocument, signedBodyDigest, signReport, toFileJson, TOOL_VERSION, validateEvidenceReportSchema, type Report } from 'arena-report';
import { VERSION } from '../src/build-info.ts';
import { main, assertHostedModeCommand } from '../src/main.ts';
import { createFile, Refused } from '../src/commands/evidence.ts';
import { CliError } from '../src/errors.ts';
import { EVIDENCE_INPUT_MAX_BYTES, EVIDENCE_INPUT_VERSION, validateEvidenceInput } from '../src/hosted/schemas.ts';
import { renderSarif } from '../src/hosted/seal.ts';
import type { PinnedKey } from '../src/keys.ts';
import { setOutputMode } from '../src/ui.ts';
import { MANIFEST_KID, OTHER_PRIV, PRIV, PUB, packManifest, pubJwk, REPORT_KID, sha256Of, VARIANT_PARAMS, writePack } from './hosted-fixtures.ts';
import { PKG, scratch, WORKSPACE } from './helpers.ts';

const FIX = join(PKG, 'test', 'fixtures', 'sixi-pr7c');
const golden = (name: string) => readFileSync(join(FIX, 'golden', name));

/** The PR 7c note's command (Sixi go/arena/evidencejob.go EvidenceArgs), after `/nodejs/bin/node /app/agent-arena.cjs`. */
const EVIDENCE_ARGS = [
  'evidence',
  '--hosted-seal', '/run/arena/seal/report.json',
  '--sarif', '/run/arena/out/report.sarif',
  '--verify-result', '/run/arena/seal/verify.json',
  '--packs', '/run/arena/in/packs',
  '--inputs', '/run/arena/render/input.json',
  '--key', 'pinned',
  '--out', '/run/arena/render',
];

/** The release's pinned report key set, as a test build pins it: the RFC 8032 test key under the fixture's kid. */
const PINNED_REPORT: readonly PinnedKey[] = [{ key: PUB, kid: REPORT_KID }];

/** A mount root laid out as the evidence job sees it: in/ (no packs), out/, seal/, render/ (input.json only). */
function mount(o: { record?: boolean } = {}): string {
  const root = scratch('arena-evidence-');
  for (const d of ['in', 'out', 'seal', 'render']) mkdirSync(join(root, d), { recursive: true });
  cpSync(join(FIX, 'seal', 'report.json'), join(root, 'seal', 'report.json'));
  cpSync(join(FIX, 'seal', 'verify.json'), join(root, 'seal', 'verify.json'));
  cpSync(join(FIX, 'out', 'report.sarif'), join(root, 'out', 'report.sarif'));
  cpSync(join(FIX, 'out', 'run-manifest.json'), join(root, 'out', 'run-manifest.json'));
  if (o.record === false) {
    const input = JSON.parse(readFileSync(join(FIX, 'render', 'input.json'), 'utf8'));
    delete input.crosscheck_record;
    writeFileSync(join(root, 'render', 'input.json'), `${JSON.stringify(input, null, 2)}\n`);
  } else cpSync(join(FIX, 'render', 'input.json'), join(root, 'render', 'input.json'));
  return root;
}

const argsAt = (root: string, over: Record<string, string> = {}): string[] => {
  const a = EVIDENCE_ARGS.map((x) => x.replace('/run/arena', root));
  for (const [k, v] of Object.entries(over)) a[a.indexOf(`--${k}`) + 1] = v;
  return a;
};

const rendered = (root: string) => readdirSync(join(root, 'render')).filter((n) => n.startsWith('evidence')).sort();

async function run(root: string, over: Record<string, string> = {}, o: Parameters<typeof main>[1] = { pinnedReportKeys: PINNED_REPORT }): Promise<number> {
  return main(argsAt(root, over), o);
}

/** Capture stderr for one call (the refusal lines). */
async function withStderr<T>(f: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  (process.stderr as { write: unknown }).write = (c: string | Uint8Array) => {
    buf += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  };
  try {
    return { value: await f(), stderr: buf };
  } finally {
    (process.stderr as { write: unknown }).write = orig;
  }
}

before(() => setOutputMode({ quiet: true }));
after(() => setOutputMode({}));

/** `contracts/schemas` from the nearest ancestor: `ascension/../contracts` in the private layout, `<root>/contracts` in the public one. */
function contractsSchemasDir(): string {
  let dir = WORKSPACE;
  for (;;) {
    const candidate = join(dir, 'contracts', 'schemas');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('contracts/schemas not found');
    dir = parent;
  }
}

test('the Sixi evidence job pins exactly this invocation (EvidenceArgs; fixture copy of the PR 7c note)', () => {
  // The pinned command line ships with the fixtures (PROVENANCE.md names its source), so the check holds in the
  // public layout too, where the private program notes are not present.
  const pinned = readFileSync(join(FIX, 'EvidenceArgs.txt'), 'utf8').trim();
  assert.equal(pinned, `/nodejs/bin/node /app/agent-arena.cjs ${EVIDENCE_ARGS.join(' ')}`, 'the fixture and the test disagree on the command line');
  const note = join(WORKSPACE, '..', 'docs', 'phase-9', 'pr', 'PR7c-evidence.md');
  if (existsSync(note)) assert.ok(readFileSync(note, 'utf8').replace(/\\\n\s+/g, '').includes(pinned), 'the program note and the fixture disagree on the command line');
});

test('EvidenceArgs through main(), --key pinned, with a cross-check record: exit 0, both files byte-equal to the Sixi goldens', async () => {
  const root = mount();
  assert.equal(await run(root), 0);
  assert.deepEqual(rendered(root), ['evidence.json', 'evidence.md']);
  assert.ok(readFileSync(join(root, 'render', 'evidence.json')).equals(golden('evidence.json')), 'evidence.json differs from the Sixi golden');
  assert.ok(readFileSync(join(root, 'render', 'evidence.md')).equals(golden('evidence.md')), 'evidence.md differs from the Sixi golden');
});

test('without a cross-check record: exit 1, evidence.md only, byte-equal to the no-record golden', async () => {
  const root = mount({ record: false });
  const { value, stderr } = await withStderr(() => run(root));
  assert.equal(value, 1);
  assert.deepEqual(rendered(root), ['evidence.md']);
  assert.ok(readFileSync(join(root, 'render', 'evidence.md')).equals(golden('evidence-norecord.md')));
  assert.match(stderr, /evidence\.json withheld: --inputs carries no crosscheck_record/);
});

test('--key <file> (the report key as an OKP JWK) renders the same bytes', async () => {
  const root = mount();
  const kf = join(root, 'report-key.jwk.json');
  writeFileSync(kf, pubJwk(REPORT_KID));
  assert.equal(await run(root, { key: kf }, {}), 0);
  assert.ok(readFileSync(join(root, 'render', 'evidence.json')).equals(golden('evidence.json')));
});

test('evidence.json is schema-valid and names report.json and report.sarif by the digests of the bytes read, never bundle-manifest.json', async () => {
  const root = mount();
  assert.equal(await run(root), 0);
  const doc = JSON.parse(readFileSync(join(root, 'render', 'evidence.json'), 'utf8')) as { signature: { files: { path: string; sha256: string; envelope: string }[]; signing_key_id: string }; producer: { sealed_at: string }; scope: { region: string } };
  assert.ok(validateEvidenceReportSchema(doc), JSON.stringify(validateEvidenceReportSchema.errors));
  const sha = (p: string) => `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
  assert.deepEqual(
    doc.signature.files.map((f: { path: string; sha256: string; envelope: string }) => [f.path, f.sha256, f.envelope]),
    [
      ['report.json', sha(join(root, 'seal', 'report.json')), 'report.json.dsse.json'],
      ['report.sarif', sha(join(root, 'out', 'report.sarif')), 'report.sarif.dsse.json'],
    ],
  );
  const report = JSON.parse(readFileSync(join(root, 'seal', 'report.json'), 'utf8'));
  assert.equal(doc.producer.sealed_at, report.signing.sealed_at);
  assert.equal(doc.signature.signing_key_id, report.signing.signing_key_id);
  assert.equal(doc.scope.region, report.run.hosted.region);
});


/* ------------------------------------------------------------ refusals (exit 2) -- */

async function refused(root: string, over: Record<string, string> = {}, o?: Parameters<typeof main>[1]): Promise<string> {
  const { value, stderr } = await withStderr(() => run(root, over, o));
  assert.equal(value, 2, `expected exit 2, stderr: ${stderr.slice(0, 400)}`);
  assert.deepEqual(rendered(root), [], 'a refusal wrote a file');
  assert.match(stderr, /^error: refused: /m);
  return stderr;
}

const editJson = (p: string, f: (v: Record<string, any>) => void, form: (v: unknown) => string = (v) => JSON.stringify(v)) => {
  const v = JSON.parse(readFileSync(p, 'utf8'));
  f(v);
  writeFileSync(p, form(v));
};

test('refused: a sealed report edited after the seal (signature does not verify)', async () => {
  const root = mount();
  editJson(join(root, 'seal', 'report.json'), (r) => (r.run.hosted.region = 'us-central1'), (v) => toFileJson(v));
  assert.match(await refused(root), /signature_invalid: signature: report\.json/);
});

test('refused: the report checked with a key that did not seal it, and a pinned set without its kid', async () => {
  const root = mount();
  const kf = join(root, 'other.jwk.json');
  writeFileSync(kf, JSON.stringify({ ...createPublicKey(OTHER_PRIV).export({ format: 'jwk' }), kid: REPORT_KID }));
  assert.match(await refused(root, { key: kf }, {}), /signature_invalid/);
  assert.match(await refused(root, {}, { pinnedReportKeys: [{ key: PUB, kid: 'sixi-arena-ed25519-other' }] }), /signature_invalid: key: .*no key for kid/);
});

test('refused: an unsealed report (the runner\'s out/report.json has no signing block)', async () => {
  const root = mount();
  editJson(join(root, 'seal', 'report.json'), (r) => delete r.signing, (v) => toFileJson(v));
  assert.match(await refused(root), /no signing block/);
});

test('refused: a SARIF that is not the one rendered from the sealed report', async () => {
  const root = mount();
  const p = join(root, 'out', 'report.sarif');
  writeFileSync(p, readFileSync(p, 'utf8').replace('"results"', '"results" '));
  assert.match(await refused(root), /--sarif is not byte-equal to the SARIF re-rendered/);
});

test('refused: a verify result that fails its schema, is not JSON, or does not state the seal precondition', async () => {
  let root = mount();
  editJson(join(root, 'seal', 'verify.json'), (v) => (v.extra = 1));
  assert.match(await refused(root), /verify_result\.schema\.json/);
  root = mount();
  writeFileSync(join(root, 'seal', 'verify.json'), '{"ok":');
  assert.match(await refused(root), /not valid UTF-8 JSON/);
  const cases: [(v: Record<string, any>) => void, RegExp][] = [
    [(v) => Object.assign(v, { ok: false, status: 'mismatch', exitCode: 1 }), /seal precondition/],
    // The schema already ties these members to a verified status; either refusal is exit 2 with nothing written.
    [(v) => delete v.hosted_seal, /verify_result\.schema\.json|seal precondition/],
    [(v) => v.hosted_seal.seal.push('signature_invalid: x'), /verify_result\.schema\.json|seal precondition/],
    [(v) => v.hosted_seal.mismatch.push('x'), /verify_result\.schema\.json|seal precondition/],
    [(v) => (v.hosted_seal.sarif_equal = false), /verify_result\.schema\.json|seal precondition/],
  ];
  for (const [edit, re] of cases) {
    root = mount();
    editJson(join(root, 'seal', 'verify.json'), edit);
    assert.match(await refused(root), re);
  }
});

test('refused: an input document for another run, of another version, with an unknown member, or a non-https JWKS URL', async () => {
  const cases: [(v: Record<string, any>) => void, RegExp][] = [
    [(v) => (v.run_id = 'run_01JB5H0STED0TEST000000000B'), /another run_id/],
    [(v) => (v.input_version = '2.0'), /not an evidence input document/],
    [(v) => (v.sealed_at = '2026-11-10T14:05:00Z'), /not an evidence input document/],
    [(v) => (v.jwks_url = 'http://sixi.example/jwks.json'), /not an evidence input document/],
    [(v) => delete v.admission, /not an evidence input document/],
    [(v) => (v.admission.requested_by = { actor_kind: 'user', actor_id: 'x' }), /not an evidence input document/],
    // Seal facts are read from the signed report only: none of them is an input member.
    ...['region', 'organisation', 'origin', 'image_digest', 'engine_build_hash', 'signing_key_id'].map((k): [(v: Record<string, any>) => void, RegExp] => [(v) => (v[k] = 'x'), /not an evidence input document/]),
    [(v) => (v.admission.sealed_at = '2026-11-10T14:05:00Z'), /not an evidence input document/],
    [(v) => (v.corpus = { 'AIACT:2024/1689:Art14': { instrument: 'i', reference: 'r', paraphrase: 'p', url: 'http://x.example/' } }), /not an evidence input document/],
  ];
  for (const [edit, re] of cases) {
    const root = mount();
    editJson(join(root, 'render', 'input.json'), edit);
    assert.match(await refused(root), re);
  }
});

test('contracts 2.13.0: --inputs is evidence_input.schema.json (wot:evidence_input:1), loaded from the contracts; the fixture is its example[0] but for the EXAMPLE signature', () => {
  const schemaPath = join(contractsSchemasDir(), 'evidence_input.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.$id, 'wot:evidence_input:1');
  assert.equal(EVIDENCE_INPUT_MAX_BYTES, schema['x-max-frame-bytes']);
  assert.equal(EVIDENCE_INPUT_VERSION, '1.0');
  for (const [i, ex] of schema.examples.entries()) assert.ok(validateEvidenceInput(ex), `example[${i}] is refused by the CLI`);
  const fixture = JSON.parse(readFileSync(join(FIX, 'render', 'input.json'), 'utf8'));
  fixture.crosscheck_record.signing.signature = schema.examples[0].crosscheck_record.signing.signature;
  assert.deepEqual(schema.examples[0], fixture);
  // No schema is defined in code any more: the validator is compiled from the file above.
  assert.doesNotMatch(readFileSync(join(PKG, 'src', 'hosted', 'schemas.ts'), 'utf8'), /evidenceInputSchema = \{/);
});

test('refused: a cross-check record that fails crosscheck_record.schema.json (an unknown member, no signing block) is input_invalid before its signature is checked', async () => {
  const cases: ((v: Record<string, any>) => void)[] = [(v) => (v.crosscheck_record.note = 'x'), (v) => delete v.crosscheck_record.signing, (v) => (v.crosscheck_record = { signing: {} })];
  for (const edit of cases) {
    const root = mount();
    editJson(join(root, 'render', 'input.json'), edit);
    assert.match(await refused(root), /input_invalid: --inputs crosscheck_record fails crosscheck_record\.schema\.json/);
  }
});

test('refused: a cross-check record edited after it was signed', async () => {
  const root = mount();
  editJson(join(root, 'render', 'input.json'), (v) => (v.crosscheck_record.job_verdict = 'fail'));
  assert.match(await refused(root), /signature_invalid: signature: cross-check record/);
});

test('refused by the renderer: a validly signed cross-check record of another image digest', async () => {
  const root = mount();
  editJson(join(root, 'render', 'input.json'), (v) => {
    v.crosscheck_record.image_digest.index = `sha256:${'d4'.repeat(32)}`;
    v.crosscheck_record = signDocument(v.crosscheck_record, PRIV, CROSSCHECK_PAYLOAD_TYPE);
  });
  assert.match(await refused(root), /renderer_refused: input: the cross-check record is for image sha256:d4/);
});

test('G-63: hostile strings in the report and the record are refused unquoted, and every message stays bounded', async () => {
  const osc = `\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007`;
  const big = osc + 'x'.repeat(1 << 20);
  let root = mount();
  editJson(join(root, 'seal', 'report.json'), (r) => (r.signing.signing_key_id = big), (v) => toFileJson(v));
  let err = await refused(root);
  assert.ok(err.length < 8192 && !err.includes('\u001b') && !err.includes('evil.example'), 'report kid quoted or unbounded');
  root = mount();
  editJson(join(root, 'render', 'input.json'), (v) => (v.crosscheck_record.signing.signing_key_id = big));
  err = await refused(root);
  assert.ok(err.length < 8192 && !err.includes('\u001b') && !err.includes('evil.example'), 'record kid quoted or unbounded');
  root = mount();
  editJson(join(root, 'render', 'input.json'), (v) => (v.crosscheck_record[big] = 1));
  err = await refused(root);
  assert.ok(err.length < 8192 && !err.includes('\u001b'), 'record member name quoted or unbounded');
});

/* ------------------------------------------------------------ packs -- */

/**
 * A report that mounts one pack: the fixture's run manifest and report re-pointed at the pack and re-sealed with
 * the test key (standing in for the Sixi keys), its SARIF re-rendered.
 */
function mountWithPack(o: { writePackDir: boolean }): string {
  const root = mount({ record: false });
  const packsDir = join(root, 'in', 'packs');
  const pm = packManifest({}, sha256Of(VARIANT_PARAMS));
  const digest = o.writePackDir ? writePack(packsDir, pm) : `sha256:${'c3'.repeat(32)}`;
  const entry = { id: pm.id, version: pm.version, digest };
  const mPath = join(root, 'out', 'run-manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  m.packs = [entry];
  writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`);
  const r = JSON.parse(readFileSync(join(root, 'seal', 'report.json'), 'utf8')) as Report;
  r.run.hosted!.packs = [entry];
  r.run.hosted!.run_manifest.digest = signedBodyDigest(m);
  const sealed = signReport(r, PRIV, REPORT_KID);
  writeFileSync(join(root, 'seal', 'report.json'), toFileJson(sealed));
  writeFileSync(join(root, 'out', 'report.sarif'), renderSarif(sealed));
  return root;
}

const PINNED_BOTH = { pinnedReportKeys: PINNED_REPORT, pinnedManifestKeys: [{ key: PUB, kid: MANIFEST_KID }] };

test('packs: a mounted pack is opened as the runner opens it; without a corpus the renderer withholds evidence.json (exit 1)', async () => {
  const root = mountWithPack({ writePackDir: true });
  const { value, stderr } = await withStderr(() => run(root, {}, PINNED_BOTH));
  assert.equal(value, 1, stderr);
  assert.deepEqual(rendered(root), ['evidence.md']);
  assert.match(readFileSync(join(root, 'render', 'evidence.md'), 'utf8'), /sx-test-core@1\.0\.0/);
  assert.match(stderr, /no corpus snapshot/);
});

test('packs: a pack the signed report pins but --packs does not hold, or one signed by another key, is refused (exit 2)', async () => {
  let root = mountWithPack({ writePackDir: false });
  assert.match(await refused(root, {}, PINNED_BOTH), /--packs: scenario_pack_unavailable/);
  root = mountWithPack({ writePackDir: true });
  assert.match(await refused(root, {}, { pinnedReportKeys: PINNED_REPORT, pinnedManifestKeys: [{ key: createPublicKey(OTHER_PRIV), kid: MANIFEST_KID }] }), /--packs: scenario_pack_unavailable/);
});

/* ------------------------------------------------------------ misuse (exit 3) -- */

async function misuse(argv: string[], re: RegExp, root?: string): Promise<void> {
  await assert.rejects(main(argv, { pinnedReportKeys: PINNED_REPORT }), (e: unknown) => e instanceof CliError && e.exitCode === 3 && re.test(e.message));
  if (root) assert.deepEqual(rendered(root), []);
}

test('misuse: a missing flag, a positional argument, an unknown flag, or a --key that is not a key', async () => {
  const root = mount();
  const a = argsAt(root);
  for (const flag of ['--hosted-seal', '--sarif', '--verify-result', '--packs', '--inputs', '--key', '--out']) {
    const i = a.indexOf(flag);
    await misuse([...a.slice(0, i), ...a.slice(i + 2)], new RegExp(`evidence needs ${flag}`), root);
  }
  await misuse([...a, 'extra'], /no positional argument/, root);
  await misuse([...a, '--hosted'], /Unknown option/, root);
  await misuse(argsAt(root, { key: join(root, 'no-such-key.pem') }), /--key/, root);
});

test('misuse: --out missing, not a directory, a symbolic link, or already holding an output (create-only, links included)', async () => {
  const root = mount();
  await misuse(argsAt(root, { out: join(root, 'nope') }), /--out: the directory does not exist/);
  await misuse(argsAt(root, { out: join(root, 'render', 'input.json') }), /--out is not a directory/);
  symlinkSync(join(root, 'render'), join(root, 'render-link'));
  await misuse(argsAt(root, { out: join(root, 'render-link') }), /--out is a symbolic link/, root);
  writeFileSync(join(root, 'render', 'evidence.md'), 'old');
  await misuse(argsAt(root), /--out already holds evidence\.md/);
  assert.equal(readFileSync(join(root, 'render', 'evidence.md'), 'utf8'), 'old');
  rmSync(join(root, 'render', 'evidence.md'));
  symlinkSync(join(root, 'nowhere'), join(root, 'render', 'evidence.json'));
  await misuse(argsAt(root), /--out already holds evidence\.json/);
  assert.equal(existsSync(join(root, 'nowhere')), false);
});

test('an empty pinned report set is misuse; ARENA_HOSTED still admits only run --hosted, verify --hosted-seal and version (G-48)', async () => {
  const root = mount();
  await assert.rejects(main(argsAt(root), { pinnedReportKeys: [] }), (e: unknown) => e instanceof CliError && e.exitCode === 3 && /pins no report key/.test(e.message));
  assert.throws(() => assertHostedModeCommand(argsAt(root), { ARENA_HOSTED: '1' }), (e: unknown) => e instanceof CliError && e.exitCode === 3 && /hosted_mode_only/.test(e.message));
});

test('the report fallback tool version (arena-report TOOL_VERSION: league reports, scripts/golden.ts) is this CLI\'s version', () => {
  assert.equal(TOOL_VERSION, VERSION);
});

test('the writer is create-only at the moment of writing too (a file or link that appears after the --out check is never replaced or followed)', () => {
  const root = mount();
  const dir = join(root, 'render');
  const phys = realpathSync.native(dir);
  writeFileSync(join(dir, 'evidence.md'), 'raced');
  assert.throws(() => createFile(dir, phys, 'evidence.md', 'new'), (e: unknown) => e instanceof Refused && /evidence_not_written/.test(e.message));
  assert.equal(readFileSync(join(dir, 'evidence.md'), 'utf8'), 'raced');
  symlinkSync(join(root, 'elsewhere.json'), join(dir, 'evidence.json'));
  assert.throws(() => createFile(dir, phys, 'evidence.json', '{}'), Refused);
  assert.equal(existsSync(join(root, 'elsewhere.json')), false);
});
