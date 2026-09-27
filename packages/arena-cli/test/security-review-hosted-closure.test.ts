/**
 * Closure of the Phase 9 hosted-mode review findings (docs/phase-9/SECURITY-REVIEW-HOSTED.md,
 * G-45…G-55; workstream C2m) and the contracts 2.5.0 / 2.6.0 CLI follow-ups
 * (contracts/CHANGELOG.md "Migration notes"). The review's own tests
 * (security-review-hosted.test.ts) state each finding; these pin the rest of each fix:
 * the edges, the contract fixtures replayed against the implementation, and the
 * behaviour that must NOT change.
 *
 * Every signature is made with the RFC 8032 §7.1 TEST 1 key or a key derived from a
 * fixed label (test material only, never a Sixi key).
 */

import assert from 'node:assert/strict';
import { createHash, sign as edSign, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalizeForSigning, REPORT_PAYLOAD_TYPE, signDocument, signedBodyDigest, toFileJson, toPrivateKey, toPublicKey, type Report } from 'arena-report';
import { HOSTED_TARGET_URL_PARTS, type HostedOptions } from '../src/commands/run-hosted.ts';
import { reportSchemaHasHostedMember, OBSERVED_TRUNCATED_IN_CONTRACT } from '../src/commands/run.ts';
import { verifyHostedSeal } from '../src/commands/verify.ts';
import { CliError, describeError, formatError } from '../src/errors.ts';
import { diagnosticFlags } from '../src/hardening.ts';
import { assertHostedEnvironment, HOSTED_ALLOWED_ENV, HOSTED_MUST_BE_ABSENT, HOSTED_SECRET_PATTERNS } from '../src/hosted/env.ts';
import { addHostedPeerAddress, installHostedLogFilter, scrubHostedText, VERIFIED_ORIGIN_PLACEHOLDER } from '../src/hosted/log-filter.ts';
import { checkImage, MANIFEST_MAX_AGE_MS, MANIFEST_MAX_WINDOW_MS } from '../src/hosted/manifest.ts';
import { loadPacks, parseVariantParams, resolveVariant } from '../src/hosted/packs.ts';
import { NO_PINNED_KEY_WARNING, resolveManifestKeys } from '../src/hosted/pinned-keys.ts';
import { BUNDLE_MANIFEST_FILE, BUNDLE_PAYLOAD_TYPE, SARIF_PAYLOAD_TYPE } from '../src/hosted/seal.ts';
import { loadPublicKeySet } from '../src/keys.ts';
import { assertHostedModeCommand } from '../src/main.ts';
import { checkUrl, hostedPolicy, NetContext, NetTimeoutError } from '../src/net/index.ts';
import { allowedHosts, hostedReferenceAdmission, verifyRunToken, RUN_TOKEN_MAX_LIFETIME_S } from '../src/reference/run-token.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import type { Transport } from '../src/transports/index.ts';
import { errorLine, info, setOutputMode } from '../src/ui.ts';
import {
  dsseEnvelope,
  hostedEnv,
  MANIFEST_KID,
  ORIGIN,
  OTHER_PRIV,
  PLATFORM,
  PRIV,
  PUB,
  pubJwk,
  REPORT_KID,
  RFC8032_PUB,
  runSpec,
  sha256Of,
  signManifest,
  unsignedManifest,
  viaReference,
  writeInputs,
  runHosted,
} from './hosted-fixtures.ts';
import { PKG, runCli, scratch, WORKSPACE } from './helpers.ts';
import { contractsDir } from 'wot-contracts/contracts-dir';

const CONTRACTS = contractsDir();
const readContract = (p: string) => JSON.parse(readFileSync(join(CONTRACTS, p), 'utf8'));
const HOST = new URL(ORIGIN).hostname;

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

const noTransport = () => {
  throw new Error('a transport was created: the refusal came too late');
};

function setup(o: { mutate?: (m: ReturnType<typeof unsignedManifest>) => void; spec?: ReturnType<typeof runSpec>; key?: typeof PRIV } = {}) {
  const spec = o.spec ?? runSpec({ seeds: [20260720], episodes: 1 });
  const m = unsignedManifest(spec);
  o.mutate?.(m);
  const dir = scratch();
  return { dir, spec, manifest: m, inputs: writeInputs(join(dir, 'in'), signManifest(m, o.key ?? PRIV), spec) };
}
type Setup = ReturnType<typeof setup>;
const runSetup = (s: Setup, o: Partial<HostedOptions> & { key?: string | null } = {}) =>
  runHosted(
    { ...s.inputs, ...(o.key === null ? {} : { manifestKey: o.key ?? pubJwk(MANIFEST_KID) }), out: join(s.dir, 'out') },
    { env: o.env ?? hostedEnv(), platform: PLATFORM, transportFactory: o.transportFactory ?? (o.resolver ? undefined : noTransport), ...(o.resolver ? { resolver: o.resolver } : {}), ...(o.pinnedKeys ? { pinnedKeys: o.pinnedKeys } : {}), ...(o.now !== undefined ? { now: o.now } : {}) },
  );

/** Everything written to the process streams while `fn` runs (the streams are restored afterwards). */
async function captureStreams<T>(fn: () => Promise<T> | T): Promise<{ text: string; value?: T; error?: unknown }> {
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  let text = '';
  const grab = ((chunk: string | Uint8Array) => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    const value = await fn();
    return { text, value };
  } catch (error) {
    return { text, error };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

const refusedWith = async (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof CliError, `expected a CliError, got ${String(e)}`);
    assert.match(e.message, re);
    return true;
  });

// ───────────────────────── G-45 hosted logs never name the customer origin ─────────────────────────

describe('G-45 the hosted log filter', () => {
  test('replaces the verified origin in every spelling and every address it was seen at; identity when no hosted run is active', () => {
    const f = installHostedLogFilter('https://Agent.Example.com');
    try {
      addHostedPeerAddress('203.0.113.5');
      addHostedPeerAddress('::ffff:198.51.100.7');
      addHostedPeerAddress('2001:db8::5');
      const line = scrubHostedText('dial https://agent.example.com:443/act, AGENT.EXAMPLE.COM., wss://agent.example.com/ws, agent.example.com:8443 -> 203.0.113.5 [2001:db8::5] 198.51.100.7; keep 203.0.113.50 and 1203.0.113.5 and agent.example.org');
      assert.ok(!/agent\.example\.com/i.test(line), line);
      assert.ok(!line.replace('203.0.113.50', '').replace('1203.0.113.5', '').includes('203.0.113.5'), line);
      assert.ok(!line.includes('198.51.100.7') && !line.includes('2001:db8::5'), line);
      assert.ok(line.includes('203.0.113.50') && line.includes('1203.0.113.5') && line.includes('agent.example.org'), `over-matched: ${line}`);
      assert.equal(line.split(VERIFIED_ORIGIN_PLACEHOLDER).length - 1, 7, line);
      assert.equal(f.scrub('x agent.example.com y'), `x ${VERIFIED_ORIGIN_PLACEHOLDER} y`);
    } finally {
      f.uninstall();
    }
    assert.equal(scrubHostedText('agent.example.com'), 'agent.example.com', 'no filter outside a hosted run');
  });

  test('every byte a hosted run writes to stdout/stderr is filtered, including the final error line cli() prints', async () => {
    setOutputMode({ quiet: false });
    try {
      const r = await captureStreams(async () => {
        try {
          await runSetup(setup(), { resolver: async () => [{ address: '10.1.2.3', family: 4 }] });
        } catch (e) {
          errorLine(formatError(e)); // what cli() does with the error that ended the run
          throw e;
        }
      });
      assert.ok(r.error instanceof CliError, String(r.error));
      assert.match(r.text, /target_forbidden/);
      assert.match(r.text, /run run_01JB5H0STED0TEST000000000A/, 'the log names the run');
      assert.ok(!r.text.includes(HOST) && !r.text.includes('10.1.2.3'), r.text);
      // A successful run through the reference: no line names the origin either.
      const ok = await captureStreams(() => runSetup(setup(), { transportFactory: viaReference(srv.urls.rest, {}) }));
      assert.equal((ok.value as { exitCode: number }).exitCode, 0, String(ok.error));
      assert.ok(ok.text.length > 0 && !ok.text.includes(HOST), ok.text);
    } finally {
      setOutputMode({ quiet: true });
    }
  });

  test('the filter is uninstalled after the run; a thrown error is scrubbed at the source', async () => {
    await assert.rejects(runSetup(setup(), { resolver: async () => [{ address: '10.1.2.3', family: 4 }] }));
    assert.equal(scrubHostedText(`x ${HOST}`), `x ${HOST}`);
    const r = await captureStreams(() => info(`local line ${HOST}`));
    assert.equal(r.text, '', 'quiet');
  });

  test("Node's own DNS/TLS texts are described by code only while a hosted run is active", () => {
    const dns = Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { code: 'ENOTFOUND' });
    const tls = Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${HOST}. is not in the cert's altnames`), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    const other = Object.assign(new Error(`write EPIPE to ${HOST}`), { code: 'ERR_SOMETHING_NEW' });
    assert.equal(describeError(other).message, `write EPIPE to ${HOST}`, 'locally the message is kept');
    const f = installHostedLogFilter(ORIGIN);
    try {
      for (const e of [dns, tls, other]) assert.ok(!describeError(e).message.includes(HOST), describeError(e).message);
      assert.equal(describeError(other).message, 'network or TLS error (ERR_SOMETHING_NEW)');
      assert.equal(describeError(dns).message, 'name not found (ENOTFOUND)');
    } finally {
      f.uninstall();
    }
  });

  test('hosted-v1 refusal texts in the net layer name neither the host, the foreign origin, nor the allowlist', async () => {
    const policy = hostedPolicy([`${ORIGIN}:443`]);
    for (const u of ['https://customer-two.example.net/x', `https://${HOST}.evil.net/`, 'https://10.0.0.1/', 'https://metadata/']) {
      assert.throws(
        () => checkUrl(new URL(u), policy),
        (e: Error) => !e.message.includes(HOST) && !e.message.includes('customer-two') && !e.message.includes('10.0.0.1') && /verified origin/.test(e.message),
        u,
      );
    }
    const seen: string[] = [];
    const ctx = new NetContext({ policy, target: new URL(ORIGIN), userAgent: 'x', runId: 'run_x', rps: 0, resolver: async () => [{ address: '203.0.113.9', family: 4 }], onPeerAddress: (a) => seen.push(a) });
    await new Promise<void>((res) => ctx.lookup(HOST, {}, () => res()));
    assert.deepEqual(seen, ['203.0.113.9'], 'resolved addresses are handed to the log filter');
    assert.ok(!new NetTimeoutError(new URL(ORIGIN), 'the verified origin').message.includes(HOST));
  });
});

// ───────────────────────── G-46 no credential in the hosted target URL ─────────────────────────

describe('G-46 the hosted RunSpec target URL carries no userinfo, query or fragment', () => {
  for (const [what, url] of [
    ['a fragment', `${ORIGIN}/act#token=abcdefgh12345678`],
    ['a harmless-looking query', `${ORIGIN}/act?page=1`],
    ['a bare ?', `${ORIGIN}/act?`],
  ] as const) {
    test(`${what} is refused with the fixed text, echoing nothing`, async () => {
      const spec = runSpec({ seeds: [20260720], episodes: 1, target: { transport: 'rest', url, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } });
      await assert.rejects(runSetup(setup({ spec })), (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.ok(e.message.startsWith('run_spec_invalid (target.url): ') && e.message.includes(HOSTED_TARGET_URL_PARTS), e.message);
        assert.ok(!e.message.includes('abcdefgh') && !e.message.includes('page=1'), e.message);
        return true;
      });
    });
  }
  test('userinfo is refused with the same text', async () => {
    const spec = runSpec({ seeds: [20260720], episodes: 1, target: { transport: 'rest', url: `https://user:pw@${HOST}/act`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } });
    // The RunSpec schema already bars '@' in the authority; hostedTarget refuses it too if the schema ever relaxes.
    await refusedWith(runSetup(setup({ spec })), /userinfo, a query or a fragment|\/target\/url must match pattern/);
  });
  test('README: the control-plane admission checklist carries the same rule', () => {
    assert.match(readFileSync(join(PKG, 'README.md'), 'utf8'), /no userinfo, query or fragment/);
  });
});

// ───────────────────────── G-47 the manifest trust anchor ─────────────────────────

describe('G-47 pinned manifest keys versus --manifest-key', () => {
  const pinned = () => loadPublicKeySet(pubJwk(MANIFEST_KID), 'test');
  test('with a non-empty pinned set, --manifest-key is refused (even when it names the same key)', async () => {
    await refusedWith(runSetup(setup(), { pinnedKeys: pinned() }), /hosted_context_invalid \(--manifest-key\): this release pins the control-plane manifest key set/);
  });
  test('with a non-empty pinned set and no flag, the pinned key verifies the manifest; a manifest by another key is refused', async () => {
    const r = await runSetup(setup(), { key: null, pinnedKeys: pinned(), transportFactory: viaReference(srv.urls.rest, {}) });
    assert.equal(r.exitCode, 0);
    await refusedWith(runSetup(setup({ key: OTHER_PRIV }), { key: null, pinnedKeys: pinned() }), /\/signing\/signature/);
  });
  test('an empty pinned set: a kid-less JWK is refused like a PEM; a JWKS with one kid-less key too; no key at all is refused', async () => {
    await refusedWith(runSetup(setup(), { key: pubJwk() }), /kid-bound manifest key/);
    await refusedWith(runSetup(setup(), { key: JSON.stringify({ keys: [JSON.parse(pubJwk(MANIFEST_KID))] }).replace(`"kid":"${MANIFEST_KID}"`, '"kid":"x-kid"') }), /not a pinned control-plane key/);
    await refusedWith(runSetup(setup(), { key: null }), /pins no control-plane manifest key, and --manifest-key was not given/);
  });
  test('an empty pinned set with a kid-bound --manifest-key prints the one-line warning that no key is pinned', async () => {
    const r = await captureStreams(() => resolveManifestKeys(pubJwk(MANIFEST_KID), { required: true, pinned: [] }));
    assert.equal(r.text, `warning: ${NO_PINNED_KEY_WARNING}\n`);
    assert.equal((r.value as unknown[]).length, 1);
  });
});

// ───────────────────────── G-48 ARENA_HOSTED ─────────────────────────

describe('G-48 under ARENA_HOSTED only run --hosted, verify --hosted-seal and version run', () => {
  const env = { ARENA_HOSTED: '1' };
  test('the allowed commands pass the gate; everything else is hosted_mode_only (exit 3)', () => {
    for (const argv of [['version'], ['--version'], ['-v'], ['run', '--hosted', '--manifest', 'm'], ['verify', 'dir', '--hosted-seal']]) assertHostedModeCommand(argv, env);
    for (const argv of [['run', '--scenario', 'byzantine'], ['serve-reference'], ['target', 'reference'], ['verify', 'r.json'], ['verify', 'r.json', '--hosted'], ['replay', 'r.json'], ['list-scenarios'], ['--help'], [], ['frobnicate']]) {
      assert.throws(
        () => assertHostedModeCommand(argv, env),
        (e: unknown) => e instanceof CliError && e.exitCode === 3 && e.message.startsWith('hosted_mode_only:') && !e.message.includes('frobnicate'),
        argv.join(' '),
      );
    }
    assertHostedModeCommand(['serve-reference'], {}); // no ARENA_HOSTED: unchanged
  });
  test('…whatever the value (ARENA_HOSTED= and ARENA_HOSTED=0 are hosted too)', () => {
    for (const v of ['', '0', 'false']) assert.throws(() => assertHostedModeCommand(['serve-reference'], { ARENA_HOSTED: v }), /hosted_mode_only/);
  });
  test('the real binary: serve-reference exits 3 before listening; version still answers', async () => {
    const s = await runCli(['serve-reference', '--port', '0'], env);
    assert.equal(s.code, 3, s.stderr);
    assert.match(s.stderr, /hosted_mode_only/);
    const v = await runCli(['version'], env);
    assert.equal(v.code, 0, v.stderr);
  });
  test('the sandbox arena server refuses to start under ARENA_HOSTED (sandbox/index.ts startDevServer)', async () => {
    const script = join(scratch(), 'start.mts');
    writeFileSync(script, `const m = await import(${JSON.stringify(join(WORKSPACE, 'sandbox', 'index.ts'))});\ntry { const s = await m.startDevServer({ port: 0 }); await s.close(); console.log('STARTED'); } catch (e) { console.log(String(e.message).slice(0, 40)); }\n`);
    const { spawnSync } = await import('node:child_process');
    const out = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: WORKSPACE, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WOT_ENV: 'test', ARENA_HOSTED: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.match(out.stdout, /^hosted_mode_only: ARENA_HOSTED is set/m, out.stdout + out.stderr);
  });
});

// ───────────────────────── G-49 pre-seal manifest signature ─────────────────────────

describe('G-49 verify --hosted-seal checks the run manifest signature before the seal', () => {
  async function hostedOut(): Promise<string> {
    const s = setup();
    const r = await runSetup(s, { transportFactory: viaReference(srv.urls.rest, {}) });
    assert.equal(r.exitCode, 0);
    return join(s.dir, 'out');
  }
  const manifestDigest = (out: string) => signedBodyDigest(JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8')));

  test('pre-seal passes with the kid-bound manifest key, or with a pinned set and no flag', async () => {
    const out = await hostedOut();
    assert.equal(verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID) }), 0);
    assert.equal(verifyHostedSeal(out, { pinnedKeys: loadPublicKeySet(pubJwk(MANIFEST_KID), 'test') }), 0);
    assert.throws(() => verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID), pinnedKeys: loadPublicKeySet(pubJwk(MANIFEST_KID), 'test') }), /cannot replace or extend/);
    assert.throws(() => verifyHostedSeal(out, { manifestKey: pubJwk() }), /kid-bound manifest key/);
  });
  test('--expect-manifest-digest: the issued digest passes, another is exit 2, a malformed one is misuse', async () => {
    const out = await hostedOut();
    assert.equal(verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID), expectManifestDigest: manifestDigest(out) }), 0);
    assert.equal(verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID), expectManifestDigest: `sha256:${'0'.repeat(64)}` }), 2);
    assert.throws(() => verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID), expectManifestDigest: 'sha256:ABC' }), /sha256:<64 lower-case hex>/);
  });
  test('a manifest re-signed with the right key but another engine build is exit 2 (report engine.build_hash ≠ manifest)', async () => {
    const out = await hostedOut();
    const mp = join(out, 'run-manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.engine_build_hash = `sha256:${'e'.repeat(64)}`;
    const signed = signManifest(m);
    writeFileSync(mp, `${JSON.stringify(signed, null, 2)}\n`);
    const rp = join(out, 'report.json');
    const r = JSON.parse(readFileSync(rp, 'utf8')) as Report;
    r.run.hosted!.run_manifest.digest = signedBodyDigest(signed);
    writeFileSync(rp, toFileJson(r));
    setOutputMode({ json: true });
    try {
      const c = await captureStreams(() => verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID) }));
      assert.equal(c.value, 2);
      assert.match(c.text, /engine\.build_hash differs from the run manifest engine_build_hash/);
    } finally {
      setOutputMode({ quiet: true });
    }
  });
  test('the real binary: pre-seal without any manifest key exits 2 and says what to pass', async () => {
    const out = await hostedOut();
    const r = await runCli(['verify', '--hosted-seal', out]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /needs the control-plane manifest key/);
    const bad = await runCli(['verify', join(out, 'report.json'), '--expect-manifest-digest', manifestDigest(out)]);
    assert.equal(bad.code, 3, 'the flag belongs to --hosted-seal');
  });
});

// ───────────────────────── G-50 environment allow-list and runtime flags ─────────────────────────

describe('G-50 the hosted environment: contracts/fixtures/hosted_env.json is the source of truth', () => {
  const fx = readContract('fixtures/hosted_env.json');
  test('the must-be-absent table equals the fixture (name, field, unless, pattern, taken as secret)', () => {
    const mine = HOSTED_MUST_BE_ABSENT.map((r) => ({ name: r.name, field: r.field, ...(r.unless ? { unless: r.unless } : {}), ...(r.pattern ? { pattern: r.pattern.source } : {}), ...(r.takenAsSecret ? { taken_as_secret: true } : {}) }));
    assert.deepEqual(mine, fx.must_be_absent);
  });
  test('the job-template names are allowed, and the secret patterns equal the fixture', () => {
    for (const j of fx.job_template) assert.ok(Object.hasOwn(HOSTED_ALLOWED_ENV, j.name), j.name);
    assert.deepEqual(HOSTED_SECRET_PATTERNS.map((r) => r.source), fx.secrets.map((s: { pattern: string }) => s.pattern));
  });
  test('each environment-field name is refused with (environment) in the text; NODE_OPTIONS only when non-empty', () => {
    for (const r of fx.must_be_absent.filter((x: { field: string }) => x.field === 'environment')) {
      assert.throws(() => assertHostedEnvironment({ [r.name]: 'x' }), (e: Error) => e.message.startsWith('hosted_context_invalid (environment): ') && e.message.includes(r.name), r.name);
      assert.throws(() => assertHostedEnvironment({ [r.name]: r.unless === 'empty' ? 'x' : '' }), /\(environment\)/, `${r.name}: presence counts`);
    }
    assertHostedEnvironment({ NODE_OPTIONS: '' });
  });
  test('allow-list: any other ARENA_*, NODE_*, SSL*, OPENSSL* or proxy name is refused; the image and template names pass', () => {
    for (const k of ['ARENA_FOO', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_DIR', 'OPENSSL_MODULES', 'http_proxy', 'ALL_PROXY', 'no_proxy', 'Node_Compile_Cache']) {
      assert.throws(() => assertHostedEnvironment({ [k]: '1' }), (e: Error) => /\(environment\)/.test(e.message) && e.message.includes(k), k);
    }
    assertHostedEnvironment({ ...hostedEnv(), ARENA_PACKS_DIR: '/packs', NODE_ENV: 'production', NODE_VERSION: '22.20.0', PATH: '/usr/bin', HOME: '/home/nonroot', LANG: 'C.UTF-8', WOT_HOST: '0.0.0.0' });
    assert.throws(() => assertHostedEnvironment({ NODE_ENV: 'development' }), /NODE_ENV/);
    assert.throws(() => assertHostedEnvironment({ ARENA_TOKEN_X: 'sk-live-SECRET-VALUE-123' }), (e: Error) => e.message.includes('ARENA_TOKEN_X') && !e.message.includes('SECRET-VALUE'), 'names, never values');
  });
  test('the image_digest cases of the fixture agree with checkImage', () => {
    const m = unsignedManifest(runSpec());
    m.image_digest = readContract('schemas/hosted_context.schema.json').examples[0].image_digest;
    for (const c of fx.image_digest_cases) {
      if (c.expect === 'accept') checkImage(m, c.value ?? undefined, 'linux/amd64');
      else assert.throws(() => checkImage(m, c.value ?? undefined, 'linux/amd64'), (e: Error) => e.message.startsWith(`hosted_context_invalid (${c.field}):`), c.id);
    }
  });
  test('--cpu-prof, --heap-prof and --prof are diagnostics (any spelling); their *-dir/-interval settings alone are not', () => {
    assert.deepEqual(diagnosticFlags(['--cpu-prof', '--heap_prof', '--prof=x'], undefined), ['--cpu-prof', '--heap_prof', '--prof']);
    assert.deepEqual(diagnosticFlags([], '"--cpu-prof"'), ['--cpu-prof']);
    assert.deepEqual(diagnosticFlags(['--cpu-prof-dir=/tmp', '--heap-prof-interval=1024', '--prof-process'], undefined), []);
  });
});

// ───────────────────────── G-51 manifest freshness ─────────────────────────

describe('G-51 manifest freshness', () => {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  test('issued more than 24 h ago is refused even with a future deadline', async () => {
    const now = Date.now();
    await refusedWith(runSetup(setup({ mutate: (m) => ((m.issued_at = iso(now - MANIFEST_MAX_AGE_MS - 60_000)), (m.wall_clock_deadline = iso(now + 3_600_000))) })), /\(\/issued_at\): the manifest was issued more than 24 h ago/);
  });
  test('a deadline more than 48 h after issue is refused', async () => {
    const now = Date.now();
    await refusedWith(runSetup(setup({ mutate: (m) => (m.wall_clock_deadline = iso(now - 60_000 + MANIFEST_MAX_WINDOW_MS + 3_600_000)) })), /\(\/wall_clock_deadline\): the wall-clock deadline is more than 48 h after issued_at/);
  });
  test('an ownership check dated in the future is refused; one 23 h old is fine', async () => {
    await refusedWith(runSetup(setup({ mutate: (m) => (m.verified_origin.checked_at = iso(Date.now() + 3_600_000)) })), /\/verified_origin\/checked_at/);
    const r = await runSetup(setup({ mutate: (m) => (m.verified_origin.checked_at = iso(Date.now() - 23 * 3_600_000)) }), { transportFactory: viaReference(srv.urls.rest, {}) });
    assert.equal(r.exitCode, 0);
  });
});

// ───────────────────────── G-53 run-token lifetime ─────────────────────────

describe('G-53 run tokens live at most 1 h', () => {
  const AUD = 'https://xcheck-ref.example.com';
  const RUN = 'run_01JB5H0STED0TEST000000000A';
  const KID = 'sixi-arena-runtoken-ed25519-20261101';
  const keys = () => loadPublicKeySet(pubJwk(KID), '--run-token-key');
  const mint = (claims: Record<string, unknown>) => {
    const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ aud: AUD, sub: RUN, jti: 'jti-0123456789abcdef', ...claims })).toString('base64url');
    return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), PRIV).toString('base64url')}`;
  };
  const now = 1_800_000_000;
  const ok = (claims: Record<string, unknown>) => verifyRunToken(mint(claims), { keys: keys(), audience: AUD, now }).ok;
  test('exp − iat over 1 h is refused; exactly 1 h is accepted', () => {
    assert.equal(ok({ iat: now - 10, exp: now - 10 + RUN_TOKEN_MAX_LIFETIME_S }), true);
    assert.equal(ok({ iat: now - 10, exp: now - 10 + RUN_TOKEN_MAX_LIFETIME_S + 1 }), false);
  });
  test('without iat, exp − now over 1 h (plus skew) is refused', () => {
    assert.equal(ok({ exp: now + RUN_TOKEN_MAX_LIFETIME_S }), true);
    assert.equal(ok({ exp: now + RUN_TOKEN_MAX_LIFETIME_S + 61 }), false);
  });
  test('an old iat cannot stretch the window: iat an hour ago, exp an hour ahead is refused', () => {
    assert.equal(ok({ iat: now - 3600, exp: now + 3600 }), false);
  });
});

// ───────────────────────── G-54 wall-clock deadline inside an episode ─────────────────────────

describe('G-54 the wall-clock deadline is checked per decision', () => {
  /** A target that never answers: every decision runs to its deadline. */
  const silent = (): Transport => ({
    name: 'rest',
    connect: async () => {},
    openEpisode: async () => ({
      decide: (_f: Record<string, unknown>, deadline: number) => new Promise((res) => setTimeout(() => res({ kind: 'timeout' }), Math.max(0, deadline - performance.now()) + 2)),
      end: async () => {},
      close: () => {},
    }),
    close: async () => {},
  });
  test('the in-flight decision is cut at the deadline as a hard miss and the episode aborts as deadline_exceeded, naming Dh and the overshoot; nothing is written', async () => {
    const s = setup();
    const deadline = Date.parse(s.manifest.wall_clock_deadline);
    const t0 = performance.now();
    await assert.rejects(runSetup(s, { transportFactory: () => silent(), now: deadline - 300 }), (e: unknown) => {
      assert.ok(e instanceof CliError, String(e));
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /^deadline_exceeded: the run reached its wall-clock deadline \(manifest wall_clock_deadline .+\) during episode 0 at tick \d+; the in-flight decision was cut at the deadline and recorded as a hard miss \(core tier Dh \d+ ms\), \d+ ms past it\. The episode was aborted; no report was written\./);
      return true;
    });
    assert.ok(performance.now() - t0 < 2500, 'the decision did not run to Dh past the deadline');
    assert.equal(existsSync(join(s.dir, 'out', 'report.json')), false);
  });
});

// ───────────────────────── G-55 observed_connections truncation ─────────────────────────

describe('G-55 observed_connections says when it is cut', () => {
  const TEST_CERT = readFileSync(join(PKG, 'test', 'hosted.test.ts'), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/)![0];
  const sock = (addr: string) => Object.assign(new EventEmitter(), { remoteAddress: addr, getPeerX509Certificate: () => new X509Certificate(TEST_CERT) });
  test('a 17th origin/key pair or a 9th address marks the list truncated; 16 and 8 do not', () => {
    const ctx = new NetContext({ policy: hostedPolicy([`${ORIGIN}:443`]), target: new URL(ORIGIN), userAgent: 'x', runId: 'run_x', rps: 0 });
    for (let i = 0; i < 8; i++) ctx.observe(new URL(`${ORIGIN}/act`), sock(`203.0.113.${i + 1}`) as never);
    for (let p = 1; p < 16; p++) ctx.observe(new URL(`${ORIGIN}:${8000 + p}/act`), sock('203.0.113.1') as never);
    assert.equal(ctx.observedConnections().length, 16);
    assert.equal(ctx.observedTruncated(), false);
    ctx.observe(new URL(`${ORIGIN}/act`), sock('203.0.113.99') as never);
    assert.equal(ctx.observedTruncated(), true, 'a 9th address');
    const ctx2 = new NetContext({ policy: hostedPolicy([`${ORIGIN}:443`]), target: new URL(ORIGIN), userAgent: 'x', runId: 'run_x', rps: 0 });
    for (let p = 0; p < 17; p++) ctx2.observe(new URL(`${ORIGIN}:${8000 + p}/act`), sock('203.0.113.1') as never);
    assert.equal(ctx2.observedConnections().length, 16);
    assert.equal(ctx2.observedTruncated(), true, 'a 17th pair');
  });
  test('the report marker is written only once the contract carries it (feature check on report.schema.json run.hosted)', () => {
    assert.equal(reportSchemaHasHostedMember('observed_connections'), true);
    assert.equal(OBSERVED_TRUNCATED_IN_CONTRACT, reportSchemaHasHostedMember('observed_truncated'));
  });
  test('2.7.0: the contract carries the marker, so a cut list is written as run.hosted.observed_truncated: true in report.json', async () => {
    assert.equal(OBSERVED_TRUNCATED_IN_CONTRACT, true, 'contracts 2.7.0 report.schema.json declares run.hosted.observed_truncated');
    for (const cut of [true, false]) {
      const s = setup();
      const via = viaReference(srv.urls.rest, {});
      // The hosted NetContext is the one the run reads observed_connections from: 17 origin/key pairs cut it to 16.
      const factory: HostedOptions['transportFactory'] = (ctx, url, name) => {
        for (let p = 0; p < (cut ? 17 : 3); p++) ctx.observe(new URL(`${ORIGIN}:${8000 + p}/act`), sock('203.0.113.1') as never);
        return via(ctx, url, name);
      };
      const c = await captureStreams(() => runSetup(s, { transportFactory: factory }));
      assert.equal((c.value as { exitCode: number } | undefined)?.exitCode, 0, String(c.error ?? c.text));
      const report = JSON.parse(readFileSync(join(s.dir, 'out', 'report.json'), 'utf8')) as Report;
      const hosted = report.run.hosted as unknown as { observed_connections?: unknown[]; observed_truncated?: boolean };
      assert.equal(hosted.observed_connections?.length, cut ? 16 : 3);
      if (cut) {
        assert.equal(hosted.observed_truncated, true);
        assert.match(c.text, /observed_connections is truncated/);
      } else assert.equal('observed_truncated' in hosted, false, 'written only as true');
    }
  });
});

// ───────────────────────── contracts 2.6.0 follow-ups ─────────────────────────

describe('contracts 2.6.0: bundle list, pack fixture and variant format, run-token vectors', () => {
  /** Seal `out` like the Sixi seal step, listing only `listed` of the bundle files. */
  function seal(out: string, drop: string): string {
    const REPORT_PRIV = toPrivateKey(new Uint8Array(createHash('sha256').update('closure: report key').digest()));
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
    const sealed = signDocument({ ...report, signing: { algorithm: 'ed25519', signing_key_id: REPORT_KID, canonicalization: 'jcs-rfc8785', payload_type: REPORT_PAYLOAD_TYPE, excluded: ['/signing/signature'], run_manifest_digest: report.run.hosted!.run_manifest.digest, sealed_at: '2026-11-10T14:07:00Z', signature: `${'A'.repeat(86)}==` } } as never, REPORT_PRIV, REPORT_PAYLOAD_TYPE) as Report;
    writeFileSync(join(out, 'report.json'), toFileJson(sealed));
    writeFileSync(join(out, 'report.json.dsse.json'), JSON.stringify({ payloadType: REPORT_PAYLOAD_TYPE, payload: Buffer.from(canonicalizeForSigning(sealed), 'utf8').toString('base64'), signatures: [{ keyid: REPORT_KID, sig: sealed.signing!.signature }] }));
    writeFileSync(join(out, 'report.sarif.dsse.json'), dsseEnvelope(readFileSync(join(out, 'report.sarif')), SARIF_PAYLOAD_TYPE, REPORT_KID, REPORT_PRIV));
    const files = ['episodes/0.record.json', 'episodes/0.replay.json', 'report.json', 'report.sarif', 'run-manifest.json']
      .filter((p) => p !== drop)
      .map((p) => {
        const b = readFileSync(join(out, p));
        return { path: p, sha256: sha256Of(b), bytes: b.length };
      });
    const bm = `${JSON.stringify({ bundle_version: '1.0', run_id: sealed.run.run_id, signing_key_id: REPORT_KID, files }, null, 2)}\n`;
    writeFileSync(join(out, BUNDLE_MANIFEST_FILE), bm);
    writeFileSync(join(out, `${BUNDLE_MANIFEST_FILE}.dsse.json`), dsseEnvelope(Buffer.from(bm), BUNDLE_PAYLOAD_TYPE, REPORT_KID, REPORT_PRIV));
    return JSON.stringify({ ...(toPublicKey(REPORT_PRIV).export({ format: 'jwk' }) as object), kid: REPORT_KID });
  }
  for (const drop of ['', 'report.json', 'report.sarif', 'run-manifest.json']) {
    test(`sealedBundleProblems: ${drop ? `${drop} missing from bundle-manifest.json is exit 2, named` : 'all three core files listed: exit 0'}`, async () => {
      const s = setup();
      assert.equal((await runSetup(s, { transportFactory: viaReference(srv.urls.rest, {}) })).exitCode, 0);
      const out = join(s.dir, 'out');
      const key = seal(out, drop);
      setOutputMode({ json: true });
      try {
        const c = await captureStreams(() => verifyHostedSeal(out, { key }));
        assert.equal(c.value, drop ? 2 : 0, c.text);
        // bundle_manifest.schema.json `contains` the three paths since 2.6.0; sealedBundleProblems checks them again by name.
        if (drop) assert.ok(c.text.includes(`${drop} is not listed in bundle-manifest.json`) || c.text.includes('fails bundle_manifest.schema.json'), c.text);
      } finally {
        setOutputMode({ quiet: true });
      }
    });
  }

  test('the fixture pack contracts/fixtures/packs/sx-agentic-core replays through loadPacks (pack_vectors)', () => {
    const pv = readContract('fixtures/signing_vectors.json').pack_vectors[0];
    const envelope = readFileSync(join(CONTRACTS, pv.envelope));
    assert.equal(envelope.length, pv.envelope_bytes);
    assert.equal(sha256Of(envelope), pv.envelope_sha256);
    const payload = Buffer.from(JSON.parse(envelope.toString('utf8')).payload, 'base64');
    assert.equal(sha256Of(payload), pv.payload_sha256);
    const pm = JSON.parse(payload.toString('utf8'));
    const keys = loadPublicKeySet(JSON.stringify({ ...readContract('fixtures/signing_vectors.json').key.jwk, kid: pv.keyid }), 'test');
    const packs = loadPacks([{ id: pm.id, version: pm.version, digest: pv.envelope_sha256 }], join(CONTRACTS, 'fixtures', 'packs'), keys, () => pm.engine.builds[0], null);
    const v = resolveVariant(pv.variants[0].scenario_id, packs);
    assert.equal(v.base, pv.variants[0].base);
    const file = readFileSync(join(CONTRACTS, pv.variants[0].file));
    assert.equal(sha256Of(file), pv.variants[0].digest);
    const { format, ...params } = JSON.parse(file.toString('utf8'));
    assert.equal(format, 'arena-pack-variant/1');
    assert.deepEqual(v.params, params);
    // Another key (kid-bound, right kid) does not open it.
    const other = loadPublicKeySet(JSON.stringify({ ...(toPublicKey(OTHER_PRIV).export({ format: 'jwk' }) as object), kid: pv.keyid }), 'test');
    assert.throws(() => loadPacks([{ id: pm.id, version: pm.version, digest: pv.envelope_sha256 }], join(CONTRACTS, 'fixtures', 'packs'), other, () => pm.engine.builds[0], null), /signature does not verify/);
  });

  test('pack variant format (2.6.0 pack_variant.schema.json): a base member is refused; tier is ONE pinned tier; both examples load', () => {
    const load = (v: unknown) => parseVariantParams(Buffer.from(JSON.stringify(v)), 'deadlock', 'variant');
    for (const ex of readContract('schemas/pack_variant.schema.json').examples) load(ex);
    assert.throws(() => load({ format: 'arena-pack-variant/1', base: 'deadlock' }), /base member/);
    assert.throws(() => load({ format: 'arena-pack-variant/1', tier: ['edge', 'core'] }), /tier/);
    assert.throws(() => load({ format: 'arena-pack-variant/1', tier: { core: {} } }), /tier/);
    assert.throws(() => load({ format: 'arena-pack-variant/1', oracle_thresholds: { 'Bad Key': 1 } }), /pack_variant\.schema\.json|not an oracle/);
  });

  test('the 23 run-token vectors (2.7.0: + reject-lifetime-2h, reject-exp-90min-ahead) replay through hostedReferenceAdmission (and verifyRunToken)', () => {
    const fx = readContract('fixtures/signing_vectors.json');
    const vectors = fx.run_token_vectors as { id: string; context: { audience: string; issuer: string | null; x_agent_arena_run: string; now: number; pinned_keys: { key: string; kid: string | null }[] }; token: string; expect: { result: string; sub?: string; jti?: string } }[];
    assert.equal(vectors.length, 23);
    // 2.7.0 signing.md §10 "Lifetime": the two must-reject vectors the 1 h cap adds (G-59).
    for (const id of ['reject-lifetime-2h', 'reject-exp-90min-ahead']) {
      const v = vectors.find((x) => x.id === id);
      assert.ok(v, `vector ${id} is in the fixture`);
      assert.notEqual(v.expect.result, 'accept', id);
      const keys = v.context.pinned_keys.map((k) => ({ key: PUB, ...(k.kid ? { kid: k.kid } : {}) }));
      assert.equal(verifyRunToken(v.token, { keys, audience: v.context.audience, now: v.context.now, ...(v.context.issuer ? { issuer: v.context.issuer } : {}) }).ok, false, id);
    }
    assert.deepEqual(fx.key.jwk.x, RFC8032_PUB.toString('base64url'));
    for (const v of vectors) {
      const keys = v.context.pinned_keys.map((k) => ({ key: PUB, ...(k.kid ? { kid: k.kid } : {}) }));
      const admit = hostedReferenceAdmission({ verifiedOrigin: v.context.audience, runTokenKeys: keys, requireToken: true, ...(v.context.issuer ? { issuer: v.context.issuer } : {}), now: () => v.context.now * 1000 });
      const res = admit({ path: '/act', headers: { host: allowedHosts(v.context.audience)[0], authorization: `Bearer ${v.token}`, 'x-agent-arena-run': v.context.x_agent_arena_run } });
      if (v.expect.result === 'accept') {
        assert.equal(res, null, v.id);
        const t = verifyRunToken(v.token, { keys, audience: v.context.audience, now: v.context.now, ...(v.context.issuer ? { issuer: v.context.issuer } : {}) });
        assert.deepEqual(t, { ok: true, sub: v.expect.sub, jti: v.expect.jti }, v.id);
      } else assert.equal(res?.status, 401, v.id);
    }
  });
});
