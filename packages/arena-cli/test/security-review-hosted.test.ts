/**
 * Phase 9 security review of `run --hosted` (docs/phase-9/SECURITY-REVIEW-HOSTED.md).
 *
 * Two kinds of test:
 *  - plain tests pin a control the review found holding (abuse case → refusal);
 *  - the tests that were `{ todo: 'G-4x …' }` at review time (G-45…G-53) are plain
 *    tests since workstream C2m closed those findings; the closure tests for the
 *    same findings (and the 2.5.0/2.6.0 CLI follow-ups) are in
 *    security-review-hosted-closure.test.ts.
 *
 * Every signature is made with the RFC 8032 §7.1 TEST 1 key or a key derived from
 * a fixed label (test material only, never a Sixi key).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, sign as edSign } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { canonicalizeForSigning, pae, REPORT_PAYLOAD_TYPE, RUN_MANIFEST_PAYLOAD_TYPE, signDocument, signedBodyDigest, toFileJson, toPrivateKey, toPublicKey, type Report } from 'arena-report';
import { runHostedCommand, type HostedOptions } from '../src/commands/run-hosted.ts';
import { verifyHostedSeal } from '../src/commands/verify.ts';
import { CliError, formatError } from '../src/errors.ts';
import { assertHostedEnvironment } from '../src/hosted/env.ts';
import { diagnosticFlags } from '../src/hardening.ts';
import { verifyManifest } from '../src/hosted/manifest.ts';
import { loadPacks, PACK_ENVELOPE_FILE } from '../src/hosted/packs.ts';
import { renderSarif } from '../src/hosted/seal.ts';
import { loadPublicKeySet } from '../src/keys.ts';
import { main, refuseCustomerRunFlags } from '../src/main.ts';
import { checkUrl, hostedPolicy, NetBlockedError, NetContext } from '../src/net/index.ts';
import { verifyRunToken } from '../src/reference/run-token.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { engineBuildFor } from '../src/build-info.ts';
import { errorLine, info, setOutputMode, targetText, writeStderr } from '../src/ui.ts';
import { addHostedPeerAddress, hostedLogFilterActive, installHostedLogFilter, type HostedLogFilter } from '../src/hosted/log-filter.ts';
import {
  commitmentsFor,
  dipSecret,
  dsseEnvelope,
  hostedEnv,
  MANIFEST_KID,
  ORIGIN,
  OTHER_PRIV,
  packManifest,
  PLATFORM,
  PRIV,
  pubJwk,
  REPORT_KID,
  runSpec,
  sha256Of,
  signManifest,
  unsignedManifest,
  VARIANT_PARAMS,
  viaReference,
  writeInputs,
  writePack,
  runHosted,
} from './hosted-fixtures.ts';
import { PKG, runCli, scratch } from './helpers.ts';

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

/** A report-signing key that is NOT the manifest key (the shared fixtures use one key for both). */
const REPORT_PRIV = toPrivateKey(new Uint8Array(createHash('sha256').update('security-review: report key').digest()));
const REPORT_PUB_JWK = JSON.stringify({ ...(toPublicKey(REPORT_PRIV).export({ format: 'jwk' }) as object), kid: REPORT_KID });
const HOST = new URL(ORIGIN).hostname;

const noTransport = () => {
  throw new Error('a transport was created: the refusal came too late');
};

const refusedWith = async (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof CliError, `expected a CliError, got ${String(e)}`);
    assert.match(e.message, re);
    return true;
  });

function setup(o: { mutate?: (m: ReturnType<typeof unsignedManifest>) => void; spec?: ReturnType<typeof runSpec>; key?: typeof PRIV } = {}) {
  const spec = o.spec ?? runSpec({ seeds: [20260720], episodes: 1 });
  const m = unsignedManifest(spec);
  o.mutate?.(m);
  const dir = scratch();
  return { dir, spec, manifest: m, inputs: writeInputs(join(dir, 'in'), signManifest(m, o.key ?? PRIV), spec) };
}
const runSetup = (s: ReturnType<typeof setup>, o: { env?: NodeJS.ProcessEnv; key?: string; transportFactory?: HostedOptions['transportFactory']; resolver?: HostedOptions['resolver'] } = {}) =>
  runHosted(
    { ...s.inputs, manifestKey: o.key ?? pubJwk(MANIFEST_KID), out: join(s.dir, 'out') },
    { env: o.env ?? hostedEnv(), platform: PLATFORM, transportFactory: o.transportFactory ?? (o.resolver ? undefined : noTransport), ...(o.resolver ? { resolver: o.resolver } : {}) },
  );

// ───────────────────────── 1. customer input refused before any read ─────────────────────────

describe('SR-1 customer-controlled argv is refused before anything is read', () => {
  const MISSING = '/nonexistent/security-review/manifest.json';
  for (const extra of [
    ['--allow-link-local'],
    ['--proxy', 'http://10.0.0.1:3128'],
    ['--allow-insecure-transport'],
    ['--allow-query-secret'],
    ['--insecure-file-mode'],
    ['--a2a-follow-card-origin'],
    ['--transport', 'ws'],
    ['--quiet'],
    ['-q'],
    ['--hosted=false'],
    ['--', '--target', 'https://127.0.0.1'],
    ['--Manifest', 'x'],
  ]) {
    test(`run --hosted … ${extra.join(' ')} → hosted_context_invalid, the (missing) manifest file is never opened`, async () => {
      await assert.rejects(main(['run', '--hosted', '--manifest', MISSING, '--run-spec', MISSING, ...extra]), (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.equal(e.exitCode, 3);
        assert.match(e.message, /^hosted_context_invalid: run --hosted takes its whole configuration/);
        assert.doesNotMatch(e.message, /manifest_source|cannot be opened/);
        return true;
      });
    });
  }
  test('refusal messages name flags, never their values', () => {
    assert.throws(
      () => refuseCustomerRunFlags(['--hosted', '--token=sk-live-SECRET-VALUE-123456']),
      (e: unknown) => e instanceof CliError && !e.message.includes('SECRET-VALUE') && /--token/.test(e.message),
    );
  });
});

// ───────────────────────── 2. manifest signature, kid, clock ─────────────────────────

describe('SR-2 run manifest: signature, key namespace, payload type, clock', () => {
  test('a manifest signed with the REPORT key (separate key material) is refused when the pinned set is the manifest JWKS', async () => {
    await refusedWith(runSetup(setup({ key: REPORT_PRIV })), /hosted_context_invalid \(\/signing\/signature\)/);
  });
  test('a report-type signature over the manifest body (payload-type confusion) is refused', () => {
    const m = unsignedManifest(runSpec());
    const body = canonicalizeForSigning({ ...m, signing: { ...m.signing } } as never);
    const sig = edSign(null, pae(REPORT_PAYLOAD_TYPE, Buffer.from(body, 'utf8')), PRIV).toString('base64');
    const doc = { ...m, signing: { ...m.signing, signature: sig } };
    assert.throws(() => verifyManifest(JSON.stringify(doc), loadPublicKeySet(pubJwk(MANIFEST_KID), '--manifest-key')), /signature does not verify/);
  });
  test('issued_at more than 5 minutes in the future is refused', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    await refusedWith(runSetup(setup({ mutate: (m) => (m.issued_at = future) })), /\/issued_at/);
  });
  test('the egress allowlist target must equal the verified origin', async () => {
    await refusedWith(runSetup(setup({ mutate: (m) => (m.egress_allowlist = [{ origin: 'https://other.example.com', role: 'target' }]) })), /\/egress_allowlist/);
  });
  test('a hostile manifest key (__proto__) is refused before the schema', () => {
    assert.throws(() => verifyManifest('{"__proto__":{"net_policy":"x"}}', []), /hostile/);
  });
  test(
    'G-47: a pinned PEM (no kid) must not accept an arbitrary kid; hosted mode requires a kid-bound JWKS',
    async () => {
      const pem = toPublicKey(PRIV).export({ type: 'spki', format: 'pem' }).toString();
      await refusedWith(runSetup(setup({ mutate: (m) => (m.signing.signing_key_id = 'anything-goes-here') }), { key: pem }), /kid/);
    },
  );
  test(
    'G-51: the ownership proof must be fresh (verified_origin.checked_at within 24 h of now)',
    async () => {
      await refusedWith(runSetup(setup({ mutate: (m) => (m.verified_origin.checked_at = '2020-01-01T00:00:00Z') })), /checked_at/);
    },
  );
});

// ───────────────────────── 3. hosted-v1 cannot be widened ─────────────────────────

describe('SR-3 hosted-v1 network policy', () => {
  const policy = hostedPolicy(['https://agent.example.com:443']);
  test('look-alike, encoded and transition forms are refused; case and the wss twin are the same origin', () => {
    checkUrl(new URL('https://AGENT.example.com/x'), policy);
    checkUrl(new URL('wss://agent.example.com:443/ws'), policy);
    for (const u of [
      'https://agent.example.com.evil.net/',
      'https://evil.net/?https://agent.example.com',
      'https://2130706433/',
      'https://0x7f.1/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[fd00::1]/',
      'https://metadata/',
      'ftp://agent.example.com/',
      'ws://agent.example.com/',
    ]) {
      assert.throws(() => checkUrl(new URL(u), policy), NetBlockedError, u);
    }
  });
  test('a DNS answer that mixes a public and a private address is refused (no partial dial)', async () => {
    const ctx = new NetContext({ policy, target: new URL(ORIGIN), userAgent: 'x', runId: 'run_x', rps: 0, resolver: async () => [{ address: '203.0.113.9', family: 4 }, { address: '127.0.0.1', family: 4 }] });
    const err = await new Promise<Error | null>((res) => ctx.lookup(HOST, {}, (e) => res(e)));
    assert.ok(err instanceof NetBlockedError);
  });
  test('link-local metadata and IPv6 transition answers are refused in the lookup', async () => {
    for (const address of ['169.254.169.254', 'fe80::1', '64:ff9b::a00:1', '100.64.0.1']) {
      const ctx = new NetContext({ policy, target: new URL(ORIGIN), userAgent: 'x', runId: 'run_x', rps: 0, resolver: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      const err = await new Promise<Error | null>((res) => ctx.lookup(HOST, {}, (e) => res(e)));
      assert.ok(err instanceof NetBlockedError, address);
    }
  });
  test('the credential attaches only to the verified origin (not to a second origin even if it were allowlisted)', () => {
    const ctx = new NetContext({ policy: hostedPolicy(['https://agent.example.com:443', 'https://peers.example.net:443']), target: new URL(ORIGIN), credential: { header: 'authorization', value: 'Bearer x-credential-value' }, userAgent: 'x', runId: 'run_x', rps: 0 });
    assert.deepEqual(ctx.credentialFor(new URL('https://peers.example.net/x')), {});
    assert.ok(ctx.credentialFor(new URL(`${ORIGIN}/act`)).authorization);
  });
});

// ───────────────────────── 4. credentials ─────────────────────────

describe('SR-4 credentials', () => {
  test('a header scheme may not target a hop-by-hop or arena header', async () => {
    const spec = runSpec({ seeds: [20260720], episodes: 1, target: { transport: 'rest', url: `${ORIGIN}/act`, auth: { scheme: 'header', ref: 'env:ARENA_TARGET_CREDENTIAL', header_name: 'X-Agent-Arena-Run' } } });
    await refusedWith(runSetup(setup({ spec })), /target\.auth\.header_name/);
  });
  test(
    'G-46: a credential-looking query parameter in the hosted RunSpec target is refused (C-1), not recorded in the report',
    async () => {
      const spec = runSpec({ seeds: [20260720], episodes: 1, target: { transport: 'rest', url: `${ORIGIN}/act?api_key=abcdefgh12345678`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } });
      await refusedWith(runSetup(setup({ spec })), /query/);
    },
  );
});

// ───────────────────────── 5. hosted logs never name the customer origin ─────────────────────────

describe('SR-5 hosted error text does not name the customer origin (HT-2.9)', () => {
  test(
    'G-45: a verified origin that resolves to a private address: the refusal names the run, not the host',
    async () => {
      await assert.rejects(runSetup(setup(), { resolver: async () => [{ address: '10.1.2.3', family: 4 }] }), (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.ok(!e.message.includes(HOST), `the error names the customer host: ${e.message}`);
        return true;
      });
    },
  );
  test(
    'G-45: pre-run refusals (origin mismatch) do not print either origin',
    async () => {
      await assert.rejects(runSetup(setup({ mutate: (m) => (m.egress_allowlist = [{ origin: 'https://other.example.com', role: 'target' }]) })), (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.ok(!e.message.includes(HOST) && !e.message.includes('other.example.com'), e.message);
        return true;
      });
    },
  );
});

// ───────────────────────── 6. environment ─────────────────────────

describe('SR-6 environment', () => {
  test('an explicitly empty or blank NODE_OPTIONS is accepted; a non-empty one is refused', () => {
    assertHostedEnvironment({ NODE_OPTIONS: '' });
    assertHostedEnvironment({ NODE_OPTIONS: '   ' });
    assert.throws(() => assertHostedEnvironment({ NODE_OPTIONS: '--use-env-proxy' }), /NODE_OPTIONS/);
  });
  for (const k of ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'OPENSSL_CONF', 'NODE_COMPILE_CACHE']) {
    test(`G-50: ${k} is refused in hosted mode`, () => {
      assert.throws(() => assertHostedEnvironment({ [k]: '1' }), new RegExp(k));
    });
  }
  test(
    'G-50: runtime profiling flags named by signing.md §3.1.1 (2.6.0 draft) are refused as diagnostics',
    () => {
      assert.deepEqual(diagnosticFlags(['--cpu-prof', '--heap-prof', '--prof'], undefined).length, 3);
    },
  );
  test(
    'G-48: under ARENA_HOSTED=1 a local (non-manifest) run is refused',
    async () => {
      const out = scratch();
      const r = await runCli(['run', '--scenario', 'byzantine', '--target', 'ref:coordinated', '--seat', 'squad', '--seeds', '1', '--episodes', '1', '--out', out], { ARENA_HOSTED: '1' });
      assert.equal(r.code, 3, r.stderr);
    },
  );
});

// ───────────────────────── 7. Diplomacy commit-then-reveal ─────────────────────────

describe('SR-7 Diplomacy secrets never appear in a refusal', () => {
  test('a wrong secret is refused before any I/O and the message quotes neither secret', async () => {
    const spec = runSpec({ scenario_id: 'diplomacy_standard', seeds: [20261115], episodes: 1, seat: { mode: 'power', position: 'germany' }, diplomacy: { profile: 'clean', horizon_year: 1901, fill: 'house' } } as never);
    const committed = dipSecret('committed');
    const delivered = dipSecret('delivered-instead');
    const s = setup({ spec, mutate: (m) => (m.episode_secret_commitments = commitmentsFor([committed])) });
    const env = hostedEnv({ ARENA_DIP_SECRET_0: delivered });
    await assert.rejects(runSetup(s, { env }), (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.match(e.message, /commit-then-reveal/);
      assert.ok(!e.message.includes(delivered) && !e.message.includes(committed));
      return true;
    });
    assert.equal(env.ARENA_DIP_SECRET_0, undefined, 'scrubbed even on refusal');
  });
});

// ───────────────────────── 8. packs ─────────────────────────

describe('SR-8 pack loader', () => {
  const build = (s: string) => engineBuildFor(s).digest;
  const keys = () => loadPublicKeySet(pubJwk(MANIFEST_KID), '--manifest-key');
  test('a symlinked pack envelope is refused (O_NOFOLLOW)', () => {
    const dir = scratch();
    const pm = packManifest({}, sha256Of(VARIANT_PARAMS));
    const digest = writePack(dir, pm);
    const real = join(dir, 'real.dsse.json');
    writeFileSync(real, readFileSync(join(dir, pm.id, PACK_ENVELOPE_FILE)));
    const p = join(dir, pm.id, PACK_ENVELOPE_FILE);
    // replace the envelope with a symlink to identical bytes
    unlinkSync(p);
    symlinkSync(real, p);
    assert.throws(() => loadPacks([{ id: pm.id, version: pm.version, digest }], dir, keys(), build, 'byzantine'), /symbolic link/);
  });
  test('a pack envelope signed under the RUN-MANIFEST payload type is refused (domain separation)', () => {
    const dir = scratch();
    const pm = packManifest({}, sha256Of(VARIANT_PARAMS));
    mkdirSync(join(dir, pm.id, 'variants'), { recursive: true });
    writeFileSync(join(dir, pm.id, 'variants', 'deadlock-hard.json'), VARIANT_PARAMS);
    const payload = Buffer.from(JSON.stringify(pm), 'utf8');
    const sig = edSign(null, pae(RUN_MANIFEST_PAYLOAD_TYPE, payload), PRIV).toString('base64');
    const env = `${JSON.stringify({ payloadType: 'application/vnd.sixi.arena-pack+json', payload: payload.toString('base64'), signatures: [{ keyid: MANIFEST_KID, sig }] })}\n`;
    writeFileSync(join(dir, pm.id, PACK_ENVELOPE_FILE), env);
    assert.throws(() => loadPacks([{ id: pm.id, version: pm.version, digest: sha256Of(env) }], dir, keys(), build, 'byzantine'), /signature does not verify/);
  });
  test('a pack id or data ref that tries to leave the packs directory fails the signed schemas', () => {
    const m = unsignedManifest(runSpec(), { packs: [{ id: 'sx-../../etc', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` }] as never });
    assert.throws(() => verifyManifest(JSON.stringify(signManifest(m)), keys()), /hosted_context_invalid \(\/packs/);
    const dir = scratch();
    const pm = packManifest({}, sha256Of(VARIANT_PARAMS));
    (pm.scenarios![0].data as { ref: string }).ref = 'variants/../../../../etc/passwd';
    const digest = writePack(dir, pm);
    assert.throws(() => loadPacks([{ id: pm.id, version: pm.version, digest }], dir, keys(), build, 'byzantine'), /pack_manifest\.schema\.json/);
  });
  test('variant parameters cannot carry net policy, credential mode or code', () => {
    const dir = scratch();
    const variant = `${JSON.stringify({ format: 'arena-pack-variant/1', net_policy: 'allow-private', credential_mode: 'none' })}\n`;
    const pm = packManifest({}, sha256Of(variant));
    const digest = writePack(dir, pm, { variant });
    assert.throws(() => loadPacks([{ id: pm.id, version: pm.version, digest }], dir, keys(), build, 'byzantine'), /outside the variant parameter surface/);
  });
});

// ───────────────────────── 9. verify --hosted-seal ─────────────────────────

describe('SR-9 verify --hosted-seal', () => {
  async function hostedOut(): Promise<string> {
    const s = setup();
    const r = await runSetup(s, { transportFactory: viaReference(srv.urls.rest, {}) });
    assert.equal(r.exitCode, 0);
    return join(s.dir, 'out');
  }
  function seal(out: string): void {
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
    const sealed = signDocument({ ...report, signing: { algorithm: 'ed25519', signing_key_id: REPORT_KID, canonicalization: 'jcs-rfc8785', payload_type: REPORT_PAYLOAD_TYPE, excluded: ['/signing/signature'], run_manifest_digest: report.run.hosted!.run_manifest.digest, sealed_at: '2026-11-10T14:07:00Z', signature: `${'A'.repeat(86)}==` } } as never, REPORT_PRIV, REPORT_PAYLOAD_TYPE) as Report;
    writeFileSync(join(out, 'report.json'), toFileJson(sealed));
    writeFileSync(join(out, 'report.json.dsse.json'), JSON.stringify({ payloadType: REPORT_PAYLOAD_TYPE, payload: Buffer.from(canonicalizeForSigning(sealed), 'utf8').toString('base64'), signatures: [{ keyid: REPORT_KID, sig: sealed.signing!.signature }] }));
    writeFileSync(join(out, 'report.sarif.dsse.json'), dsseEnvelope(readFileSync(join(out, 'report.sarif')), 'application/vnd.sixi.arena-sarif+json', REPORT_KID, REPORT_PRIV));
    const files = ['episodes/0.record.json', 'episodes/0.replay.json', 'report.json', 'report.sarif', 'run-manifest.json'].map((p) => {
      const b = readFileSync(join(out, p));
      return { path: p, sha256: sha256Of(b), bytes: b.length };
    });
    const bm = `${JSON.stringify({ bundle_version: '1.0', run_id: sealed.run.run_id, signing_key_id: REPORT_KID, files }, null, 2)}\n`;
    writeFileSync(join(out, 'bundle-manifest.json'), bm);
    writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), dsseEnvelope(Buffer.from(bm), 'application/vnd.sixi.arena-bundle+json', REPORT_KID, REPORT_PRIV));
  }
  /** Flip the two unused low bits of the last significant base64 character: same 64 bytes, different text. */
  const reencode = (sig: string) => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const i = sig.length - 3;
    const v = A.indexOf(sig[i]);
    return `${sig.slice(0, i)}${A[(v & ~3) | ((v + 1) & 3)]}${sig.slice(i + 1)}`;
  };

  test('sealed bundle with separate report and manifest keys verifies; a missing run-manifest.json is exit 2', async () => {
    const out = await hostedOut();
    seal(out);
    assert.equal(verifyHostedSeal(out, { key: REPORT_PUB_JWK, manifestKey: pubJwk(MANIFEST_KID) }), 0);
    const mp = join(out, 'run-manifest.json');
    const mt = readFileSync(mp, 'utf8');
    unlinkSync(mp);
    assert.equal(verifyHostedSeal(out, { key: REPORT_PUB_JWK }), 2);
    writeFileSync(mp, mt);
  });
  test('the manifest key cannot stand in for the report key', async () => {
    const out = await hostedOut();
    seal(out);
    assert.equal(verifyHostedSeal(out, { key: pubJwk(REPORT_KID) }), 2);
  });
  test('a re-encoded report signature (same bytes, other base64 text) is refused: the envelope must be byte-identical and report.json is digest-listed', async () => {
    const out = await hostedOut();
    seal(out);
    const rp = join(out, 'report.json');
    const r = JSON.parse(readFileSync(rp, 'utf8')) as Report;
    const alt = reencode(r.signing!.signature);
    assert.equal(Buffer.from(alt, 'base64').equals(Buffer.from(r.signing!.signature, 'base64')), true, 'test premise: same signature bytes');
    writeFileSync(rp, toFileJson({ ...r, signing: { ...r.signing!, signature: alt } }));
    assert.equal(verifyHostedSeal(out, { key: REPORT_PUB_JWK }), 2);
  });
  test('G-52 (info): a re-encoded SARIF envelope signature still verifies (base64 decoding is lenient); harmless, noted', async () => {
    const out = await hostedOut();
    seal(out);
    const ep = join(out, 'report.sarif.dsse.json');
    const env = JSON.parse(readFileSync(ep, 'utf8'));
    env.signatures[0].sig = reencode(env.signatures[0].sig);
    writeFileSync(ep, JSON.stringify(env));
    assert.equal(verifyHostedSeal(out, { key: REPORT_PUB_JWK }), 0);
  });
  test('pre-seal with --manifest-key: a run-manifest.json re-signed by another key is exit 2', async () => {
    const out = await hostedOut();
    const mp = join(out, 'run-manifest.json');
    writeFileSync(mp, `${JSON.stringify(signManifest(JSON.parse(readFileSync(mp, 'utf8')), OTHER_PRIV), null, 2)}\n`);
    assert.equal(verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID) }), 2);
  });
  test(
    'G-49: pre-seal (the verifier job) refuses to pass without the manifest key: a forged manifest + matching report must not exit 0',
    async () => {
      const out = await hostedOut();
      const mp = join(out, 'run-manifest.json');
      const forged = JSON.parse(readFileSync(mp, 'utf8'));
      forged.org_ref = 'org_FORGED0000001';
      const signedForged = signManifest(forged, OTHER_PRIV);
      writeFileSync(mp, `${JSON.stringify(signedForged, null, 2)}\n`);
      const rp = join(out, 'report.json');
      const r = JSON.parse(readFileSync(rp, 'utf8')) as Report;
      r.run.hosted!.org_ref = forged.org_ref;
      r.run.hosted!.run_manifest.digest = signedBodyDigest(signedForged);
      writeFileSync(rp, toFileJson(r));
      writeFileSync(join(out, 'report.sarif'), renderSarif(r));
      assert.notEqual(verifyHostedSeal(out, {}), 0);
    },
  );
});

// ───────────────────────── 10. serve-reference --hosted run tokens ─────────────────────────

describe('SR-10 run tokens and Host', () => {
  const AUD = 'https://xcheck-ref.example.com';
  const RUN = 'run_01JB5H0STED0TEST000000000A';
  const KID = 'sixi-arena-runtoken-ed25519-20261101';
  const keys = () => loadPublicKeySet(pubJwk(KID), '--run-token-key');
  const mint = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'at+jwt', kid: KID }, sig?: string) => {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify({ aud: AUD, sub: RUN, iat: now, exp: now + 600, jti: 'jti-0123456789abcdef', ...claims })).toString('base64url');
    return `${h}.${p}.${sig ?? edSign(null, Buffer.from(`${h}.${p}`), PRIV).toString('base64url')}`;
  };
  test('alg none / HS256 / JWT typ / extra header members (jku, crit) / an empty signature are refused', () => {
    for (const header of [{ alg: 'none', typ: 'at+jwt' }, { alg: 'HS256', typ: 'at+jwt' }, { alg: 'EdDSA', typ: 'JWT' }, { alg: 'EdDSA', typ: 'at+jwt', jku: 'https://evil/jwks' }, { alg: 'EdDSA', typ: 'at+jwt', crit: ['exp'] }]) {
      assert.equal(verifyRunToken(mint({}, header), { keys: keys(), audience: AUD }).ok, false, JSON.stringify(header));
    }
    const t = mint();
    assert.equal(verifyRunToken(`${t.split('.').slice(0, 2).join('.')}.`, { keys: keys(), audience: AUD }).ok, false);
  });
  test('Origin refusal (G-39) still applies before the token check; Host with a trailing dot is 421', async () => {
    const s = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine', hosted: { verifiedOrigin: AUD, runTokenKeys: keys(), requireToken: true } });
    try {
      const call = (headers: Record<string, string>) =>
        new Promise<number>((res, rej) => {
          const req = request({ host: '127.0.0.1', port: s.port, path: '/.well-known/agent-card.json', headers }, (r) => {
            r.resume();
            res(r.statusCode ?? 0);
          });
          req.on('error', rej);
          req.end();
        });
      const good = { host: 'xcheck-ref.example.com', authorization: `Bearer ${mint()}`, 'x-agent-arena-run': RUN };
      assert.equal(await call(good), 200);
      assert.equal(await call({ ...good, origin: 'https://evil.example.net' }), 403);
      assert.equal(await call({ ...good, host: 'xcheck-ref.example.com.' }), 421);
      assert.equal(await call({ ...good, 'x-agent-arena-run': 'run_01JB5H0STED0TEST000000000B' }), 401);
    } finally {
      await s.close();
    }
  });
  test('by design a run token is reusable within its lifetime (one token per run); X-Agent-Arena-Run adds consistency, not secrecy', () => {
    const t = mint();
    assert.equal(verifyRunToken(t, { keys: keys(), audience: AUD }).ok, true);
    assert.equal(verifyRunToken(t, { keys: keys(), audience: AUD }).ok, true);
  });
  test(
    'G-53: a token whose lifetime exceeds the run-token profile (exp far in the future) is refused',
    () => {
      const now = Math.floor(Date.now() / 1000);
      assert.equal(verifyRunToken(mint({ exp: now + 365 * 86400 }), { keys: keys(), audience: AUD }).ok, false);
    },
  );
});

// ───────────────────────── 11. observed_connections ─────────────────────────

describe('SR-11 observed_connections comes from the dial, not from the target', () => {
  test('the origin is the URL we dialed, the address is the socket peer; the certificate subject is never read', () => {
    const ctx = new NetContext({ policy: hostedPolicy(['https://agent.example.com:443']), target: new URL(ORIGIN), userAgent: 'x', runId: 'run_x', rps: 0 });
    let subjectRead = false;
    const fake = { get subject() { subjectRead = true; return 'CN=evil.example.net'; } };
    // A socket whose "certificate" is not an X509Certificate the runtime issued is ignored entirely.
    ctx.observe(new URL(`${ORIGIN}/act`), { remoteAddress: '203.0.113.5', getPeerX509Certificate: () => fake, once() {} } as never);
    assert.deepEqual(ctx.observedConnections(), []);
    assert.equal(subjectRead, false);
  });
});

// ───────────────────────── 12. Counter-signature pass (after C2m, 8836ca5) ─────────────────────────

describe('SR-12 counter-signature: log-filter spellings and the cut', () => {
  /** Everything ui.ts writes to the process streams while `fn` runs; a thrown error is printed as cli() does. */
  const capture = async (fn: () => unknown): Promise<string> => {
    const ow = process.stdout.write;
    const ew = process.stderr.write;
    let t = '';
    const grab = ((c: string | Uint8Array) => ((t += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')), true)) as typeof process.stdout.write;
    process.stdout.write = grab;
    process.stderr.write = grab;
    try {
      await fn();
    } catch (e) {
      errorLine(formatError(e));
    } finally {
      process.stdout.write = ow;
      process.stderr.write = ew;
    }
    return t;
  };

  test('G-45: an IPv6-literal verified origin is filtered bracketed, bare, with port and in a URL; a multi-line (stack) text too', async () => {
    setOutputMode({ quiet: false });
    const f = installHostedLogFilter('https://[2606:4700:4700::1111]:8443');
    try {
      for (const v of ['[2606:4700:4700::1111]:8443', 'https://[2606:4700:4700::1111]:8443/act', '2606:4700:4700::1111', '[2606:4700:4700::1111]', '2606:4700:4700::1111'.toUpperCase()]) {
        const t = await capture(() => info(`dial ${v} now`));
        assert.ok(!/2606:4700/i.test(t), `${v} -> ${t}`);
      }
    } finally {
      f.uninstall();
    }
    const g = installHostedLogFilter(ORIGIN);
    try {
      const t = await capture(() => info('Error: boom agent.example.com\n    at TLSSocket.onConnectSecure (node:_tls_wrap:1)\n    at https://agent.example.com:443/x'));
      assert.ok(!/agent\.example\.com/i.test(t), t);
    } finally {
      g.uninstall();
      setOutputMode({ quiet: true });
    }
  });

  test('G-57: a line cut at its cap never prints a prefix of the verified host (filter, cut, filter) at every cap and straddle offset', async () => {
    setOutputMode({ quiet: false });
    const f = installHostedLogFilter(ORIGIN);
    addHostedPeerAddress('203.0.113.5');
    try {
      // Each sink with its cap: info/warn/error lines (2000), target text (200), error text (1000).
      const sinks: [string, number, (s: string) => unknown][] = [
        ['info', 2000, (s) => info(s)],
        ['target text', 200, (s) => writeStderr(`${targetText(s)}\n`)],
        ['error', 1000, (s) => {
          throw new Error(s);
        }],
      ];
      const spellings = ['agent.example.com', 'https://agent.example.com:443', 'AGENT.EXAMPLE.COM', '203.0.113.5'];
      for (const [name, cap, sink] of sinks) {
        for (const host of spellings) {
          // The host starts before the cap and ends after it, at every split point (and just inside / outside).
          for (let before = -1; before <= host.length + 1; before++) {
            // A space before it: the address pattern needs a boundary (`x203.0.113.5` is not the address).
            const t = await capture(() => sink(`${'a'.repeat(cap - before - 1)} ${host} ${'z'.repeat(8)}`));
            assert.ok(!/agent\.e|agent\.…|203\.0\.11|203\.0\.…/i.test(t), `${name} cap ${cap}, ${before} chars of ${host} before the cut: ${t.slice(-60)}`);
            assert.ok(!t.includes('agent.') && !t.includes('203.0.'), `${name}: ${t.slice(-60)}`);
          }
        }
      }
      // The reviewer's probe lines, verbatim.
      for (const t of [
        await capture(() => info(`${'a'.repeat(1994)}agent.example.com`)),
        await capture(() => writeStderr(`${targetText(`${'b'.repeat(192)}agent.example.com`)}\n`)),
        await capture(() => {
          throw new Error(`${'c'.repeat(994)}agent.example.com`);
        }),
      ]) {
        assert.ok(!/agent\.e/i.test(t), t.slice(-60));
        // The placeholder may itself be cut (`<verif…`): it names nothing.
        assert.match(t, /<verif/, t.slice(-60));
      }
      // A host joined only once escapes/invisibles are stripped, or by NFKC (fullwidth), is filtered too.
      for (const t of [
        await capture(() => info(`${'a'.repeat(1990)}agent.\u001b[0mexample.com`)),
        await capture(() => info(`${'a'.repeat(1990)}agent.\u200bexample.com`)),
        await capture(() => writeStderr(`${targetText(`${'b'.repeat(190)}ａｇｅｎｔ.example.com`)}\n`)),
      ]) assert.ok(!/agent\.e/i.test(t), t.slice(-60));
    } finally {
      f.uninstall();
      setOutputMode({ quiet: true });
    }
  });

  test('G-58: a hosted run leaves its filter installed; a late error printed as cli() does is filtered until the handle is released', async () => {
    const s = setup();
    let handle: HostedLogFilter | undefined;
    assert.equal(hostedLogFilterActive(), false);
    await refusedWith(
      runHostedCommand({ ...s.inputs, manifestKey: pubJwk(MANIFEST_KID), out: join(s.dir, 'out') }, { env: hostedEnv({ ARENA_IMAGE_DIGEST: `sha256:${'c3'.repeat(32)},sha256:${'d4'.repeat(32)}` }), platform: PLATFORM, transportFactory: noTransport, onLogFilter: (h) => (handle = h) }),
      /image/i,
    );
    try {
      assert.ok(handle, 'the run hands out its filter');
      assert.equal(hostedLogFilterActive(), true, 'G-58: the filter outlives the run');
      setOutputMode({ quiet: false });
      // What cli()'s crash handler prints: errorLine(`internal error: ${formatError(e)}`).
      const late = await capture(() => errorLine(`internal error: ${formatError(new Error(`socket hang up https://${HOST}:443/arena/act`))}`));
      assert.ok(!late.includes(HOST), late);
      assert.match(late, /<verified origin>/);
      const coded = await capture(() => errorLine(`internal error: ${formatError(Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { code: 'ENOTFOUND' }))}`));
      assert.equal(coded.trim(), 'error: internal error: name not found (ENOTFOUND)');
    } finally {
      handle?.uninstall();
      setOutputMode({ quiet: true });
    }
    assert.equal(hostedLogFilterActive(), false, 'only the handle removes it');
  });

  test('G-58: through cli(), an uncaught error after the hosted run returned reaches the crash handler filtered (child process)', async () => {
    const s = setup();
    const dir = scratch();
    const script = join(dir, 'late-crash.mts');
    // The run is refused after the manifest verified (image digest), i.e. after the filter is installed;
    // then an error naming the verified host is thrown from a timer, after cli() has returned.
    writeFileSync(
      script,
      [
        `import { cli } from ${JSON.stringify(join(PKG, 'src', 'main.ts'))};`,
        'await cli(process.argv.slice(2));',
        `setTimeout(() => { throw new Error('late failure dialing https://${HOST}:443/arena/act from ${HOST}'); }, 20);`,
        '',
      ].join('\n'),
    );
    const r = await new Promise<{ code: number | null; stderr: string; stdout: string }>((res) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, 'run', '--hosted', '--manifest', s.inputs.manifest, '--run-spec', s.inputs.runSpec, '--manifest-key', pubJwk(MANIFEST_KID), '--out', join(s.dir, 'out')], {
        cwd: PKG,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...hostedEnv({ ARENA_IMAGE_DIGEST: `sha256:${'c3'.repeat(32)},sha256:${'d4'.repeat(32)}` }) } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => res({ code, stderr, stdout }));
    });
    const all = r.stderr + r.stdout;
    assert.equal(r.code, 2, all);
    assert.match(r.stderr, /image/i, 'the run itself was refused first');
    assert.match(r.stderr, /internal error: late failure dialing <verified origin>\/arena\/act from <verified origin>/, all);
    assert.ok(!all.includes(HOST), all);
  });
});
