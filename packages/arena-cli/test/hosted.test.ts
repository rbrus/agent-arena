/**
 * Phase 9 B1: `run --hosted` is driven only by a signed run manifest
 * (threat-model-hosted §2.1, §10.2; HOSTED-PROFILE §2.4; contracts signing.md).
 *
 * Round trip with the RFC 8032 test key; tampered manifest, wrong kid, wrong
 * image digest / platform, typed loopback and private resolution, customer
 * flags, credential scrubbing and origin binding, Diplomacy commit-then-reveal
 * (runner and verify), and the report's hosted section.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { signedBodyDigest, signReport, toFileJson, toSarif, validateReportSchema, type Report } from 'arena-report';
import { SELF_TESTS } from 'arena-scenarios';
import { verifyCommand } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { takeHostedSecrets } from '../src/hosted/env.ts';
import { main, refuseCustomerRunFlags } from '../src/main.ts';
import { checkUrl, hostedPolicy, NetBlockedError, NetContext } from '../src/net/index.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import {
  CANARY,
  commitmentsFor,
  dipSecret,
  hostedEnv,
  MANIFEST_KID,
  ORIGIN,
  OTHER_PRIV,
  PLATFORM,
  PRIV,
  pubJwk,
  PUB_PEM,
  REPORT_KID,
  runSpec,
  signManifest,
  unsignedManifest,
  viaReference,
  writeInputs,
  runHosted,
  NO_PIN,
} from './hosted-fixtures.ts';
import { allFiles, assertNoLeak, scratch } from './helpers.ts';

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

const refused = async (p: Promise<unknown>, re: RegExp, code = 3) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof CliError, `expected a CliError, got ${String(e)}`);
    assert.equal(e.exitCode, code, e.message);
    assert.match(e.message, re);
    return true;
  });
};

/** A factory that must never be reached: the refusal has to happen before any transport exists. */
const noTransport = () => {
  throw new Error('a transport was created: the refusal came too late');
};

describe('run --hosted: the round trip', () => {
  test('signed manifest (RFC 8032 key) → report with run.hosted, sixi_verified, not_assessed; hashes equal the frozen anchors; verify --hosted passes after sealing', async () => {
    const spec = runSpec();
    const manifest = signManifest(unsignedManifest(spec));
    const dir = scratch();
    const inputs = writeInputs(join(dir, 'in'), manifest, spec);
    const env = hostedEnv();
    const seen: Parameters<typeof viaReference>[1] = {};
    const out = join(dir, 'out');
    const r = await runHosted({ ...inputs, manifestKey: pubJwk(MANIFEST_KID), out }, { env, platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, seen) });
    assert.equal(r.exitCode, 0);

    // The hosted NetContext: hosted-v1 allowlist of exactly the verified origin, no redirects, credential bound to it.
    assert.deepEqual(seen.ctx!.policy.allowOrigins, ['https://agent.example.com:443']);
    assert.equal(seen.ctx!.policy.allowPrivate, false);
    assert.equal(seen.ctx!.policy.loopbackLiteral, false);
    assert.equal(seen.ctx!.followRedirects, false);
    assert.equal(seen.ctx!.runId, manifest.run_id);
    assert.match(seen.ctx!.userAgent, /sixi-hosted/);
    assert.deepEqual(Object.keys(seen.ctx!.credentialFor(new URL(`${ORIGIN}/arena/act`))), ['authorization']);
    assert.deepEqual(seen.ctx!.credentialFor(new URL('https://evil.example.net/')), {});
    // Credential scrubbed from the environment on load.
    assert.equal(env.ARENA_TARGET_CREDENTIAL, undefined);

    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
    assert.ok(validateReportSchema(report));
    assert.equal(report.run.mode, 'hosted');
    assert.equal(report.run.run_id, manifest.run_id);
    assert.deepEqual(report.run.target_ownership, { loopback: false, attested: true, source: 'sixi_verified' });
    assert.deepEqual(report.run.spec, spec, 'the RunSpec is recorded byte-for-byte as bound (no label added)');
    const h = report.run.hosted as Record<string, unknown>;
    for (const k of ['signing_key_id', 'region', 'image_digest', 'verified_origin', 'org_ref', 'scan_id', 'credential_mode', 'seed_source', 'packs', 'retention'] as const) {
      assert.deepEqual(h[k], (manifest as unknown as Record<string, unknown>)[k], `run.hosted.${k}`);
    }
    assert.deepEqual(h.run_manifest, { digest: signedBodyDigest(manifest), signing_key_id: MANIFEST_KID, path: 'run-manifest.json' });
    assert.equal(report.signing, undefined, 'the runner never signs: the seal step does');
    const ids = (report.not_assessed ?? []).map((e) => `${e.kind}:${e.id}:${e.reason_code}`);
    for (const want of ['property:robustness.seed_recovery:seed_recovery_not_modelled', 'property:target.model_identity:out_of_scope_by_design', 'property:target.production_equivalence:out_of_scope_by_design']) {
      assert.ok(ids.includes(want), want);
    }
    // Bundle layout: the manifest exactly as received, episodes/<i>.{record,replay}.json.
    assert.equal(readFileSync(join(out, 'run-manifest.json'), 'utf8'), readFileSync(inputs.manifest, 'utf8'));
    for (const [i] of report.episodes.entries()) {
      assert.equal(report.episodes[i].replay_ref, `episodes/${i}.replay.json`);
      assert.ok(existsSync(join(out, 'episodes', `${i}.record.json`)));
    }
    // Transport invariance with the open CLI: the same hashes as the frozen local anchors.
    for (const ep of report.episodes) {
      const a = SELF_TESTS.find((c) => c.scenario === 'byzantine' && c.tier === 'core' && c.seed === ep.seed && c.opts.mode === 'squad' && c.opts.targetDriver === 'ref:coordinated')!.expect;
      assert.equal(ep.replay_hash, a.replayHash);
    }
    // No credential anywhere in the output.
    assertNoLeak(CANARY, allFiles(out).map((f) => ({ where: f.path, text: f.text })));

    // Unsealed: verify --hosted-style checks need a seal; the plain re-simulation passes.
    assert.equal(verifyCommand(join(out, 'report.json')), 0);
    // Seal (what the Sixi seal step does, here with the test key) and verify --hosted with the manifest key.
    const sealed = signReport(report, PRIV, REPORT_KID, { sealedAt: '2026-11-10T14:07:00Z' });
    writeFileSync(join(out, 'report.json'), toFileJson(sealed));
    writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(sealed, { specPath: '.agent-arena/byzantine.run.json' })));
    assert.equal(verifyCommand(join(out, 'report.json'), { pinnedKeys: NO_PIN, key: pubJwk(), hosted: true, manifestKey: pubJwk(MANIFEST_KID) }), 0);
  });

  test('G-47: a PEM manifest key (no kid) is refused in hosted mode: a kid-less key would match every kid', async () => {
    const spec = runSpec({ seeds: [20260720], episodes: 1 });
    const dir = scratch();
    const inputs = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec)), spec);
    await assert.rejects(
      runHosted({ ...inputs, manifestKey: PUB_PEM, out: join(dir, 'out') }, { env: hostedEnv(), platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, {}) }),
      /hosted_context_invalid \(--manifest-key\): hosted mode needs a kid-bound manifest key/,
    );
  });
});

describe('run --hosted: the manifest is the only trusted input', () => {
  const setup = (mutate: (m: ReturnType<typeof unsignedManifest>) => void = () => {}, o: { sign?: boolean; after?: (m: Record<string, unknown>) => void; spec?: ReturnType<typeof runSpec> } = {}) => {
    const spec = o.spec ?? runSpec();
    const m = unsignedManifest(spec);
    mutate(m);
    const signed = o.sign === false ? m : signManifest(m);
    o.after?.(signed as unknown as Record<string, unknown>);
    const dir = scratch();
    return { dir, inputs: writeInputs(join(dir, 'in'), signed, spec), spec };
  };
  const run = (s: ReturnType<typeof setup>, env = hostedEnv(), key = pubJwk(MANIFEST_KID), platform: string | null = PLATFORM) =>
    runHosted({ ...s.inputs, manifestKey: key, out: join(s.dir, 'out') }, { env, platform, transportFactory: noTransport });

  test('a tampered manifest (a field changed after signing) is refused', async () => {
    await refused(run(setup(undefined, { after: (m) => (m.rps_cap = 49) })), /hosted_context_invalid \(\/signing\/signature\)/);
  });
  test('a manifest signed by another key is refused', async () => {
    const s = setup();
    const m = JSON.parse(readFileSync(s.inputs.manifest, 'utf8'));
    writeFileSync(s.inputs.manifest, JSON.stringify(signManifest(m, OTHER_PRIV)));
    await refused(run(s), /signature does not verify/);
  });
  test('a kid the pinned key set does not name is refused, and the report kid cannot sign a manifest', async () => {
    await refused(run(setup(), hostedEnv(), pubJwk('sixi-arena-manifest-ed25519-20990101')), /not a pinned control-plane key/);
    await refused(run(setup((m) => (m.signing.signing_key_id = REPORT_KID))), /separate keys/);
  });
  test('a schema-invalid manifest (net_policy relaxed) is refused before the signature is even checked', async () => {
    await refused(run(setup((m) => ((m as unknown as Record<string, unknown>).net_policy = 'allow-private'))), /hosted_context_invalid \(\/net_policy\)/);
  });
  test('the RunSpec file must be the one the manifest binds (run_spec_digest)', async () => {
    const s = setup();
    writeFileSync(s.inputs.runSpec, JSON.stringify(runSpec({ seeds: [7], episodes: 1 })));
    await refused(run(s), /run_spec_digest differs/);
  });
  test('an expired manifest is refused', async () => {
    await refused(run(setup((m) => (m.wall_clock_deadline = '2020-01-01T00:00:00Z'))), /wall-clock deadline .* has passed/);
  });
  test('image digest: not on ARENA_IMAGE_DIGEST, unset, or another platform → refused', async () => {
    await refused(run(setup((m) => (m.image_digest.index = `sha256:${'c3'.repeat(32)}`))), /is not the running image/);
    await refused(run(setup(), hostedEnv({ ARENA_IMAGE_DIGEST: undefined })), /ARENA_IMAGE_DIGEST is not set/);
    await refused(run(setup((m) => (m.image_digest.platform_manifest = `sha256:${'d4'.repeat(32)}`))), /platform manifest/);
    await refused(run(setup(), hostedEnv(), pubJwk(MANIFEST_KID), PLATFORM === 'linux/amd64' ? 'linux/arm64' : 'linux/amd64'), /image_digest\/platform/);
  });
  test('engine build: a manifest admitted for another build is refused', async () => {
    await refused(run(setup((m) => (m.engine_build_hash = `sha256:${'e5'.repeat(32)}`))), /engine_build_hash/);
  });
  test('typed loopback, localhost and metadata origins are refused before any socket, even when "verified"', async () => {
    for (const origin of ['https://127.0.0.1', 'https://localhost', 'https://169.254.169.254', 'https://10.0.0.8', 'https://metadata.google.internal']) {
      const spec = runSpec({ target: { transport: 'rest', url: `${origin}/act`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } });
      const s = setup(
        (m) => {
          m.verified_origin.origin = origin;
          m.egress_allowlist = [{ origin, role: 'target' }];
        },
        { spec },
      );
      await refused(run(s), /target_forbidden/);
    }
  });
  test('the RunSpec target must be exactly the verified origin (scheme, host, port)', async () => {
    for (const url of ['https://agent.example.com:8443/act', 'https://other.example.com/act', 'http://agent.example.com/act']) {
      const spec = runSpec({ target: { transport: 'rest', url, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } });
      await refused(run(setup(undefined, { spec })), /verified origin|must be https/);
    }
  });
  test('credential refs: only env:ARENA_TARGET_CREDENTIAL; secret: and other env names refused; mode none refuses a delivered value', async () => {
    for (const ref of ['secret:target', 'env:TARGET_TOKEN']) {
      const spec = runSpec({ target: { transport: 'rest', url: `${ORIGIN}/act`, auth: { scheme: 'bearer', ref } } });
      await refused(run(setup(undefined, { spec })), /run_spec_invalid \(target\.auth\.ref\)/);
    }
    const spec = runSpec({ target: { transport: 'rest', url: `${ORIGIN}/act` } });
    await refused(run(setup((m) => (m.credential_mode = 'none'), { spec })), /credential_mode is none, but ARENA_TARGET_CREDENTIAL was delivered/);
    await refused(run(setup(), hostedEnv({ ARENA_TARGET_CREDENTIAL: undefined })), /was not delivered/);
  });
  test('relaxing variables are refused: secrets dir, debug override, TLS trust, key log, NODE_OPTIONS; the env form of the documents (manifest_source)', async () => {
    for (const [k, v] of Object.entries({ AGENT_ARENA_SECRETS_DIR: '/tmp', ARENA_DEBUG: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: '/x.pem', SSLKEYLOGFILE: '/tmp/k', NODE_OPTIONS: '--require /x.js', ARENA_RUN_SPEC: '{}', ARENA_HOSTED_CONTEXT: '{}' })) {
      await refused(run(setup(), hostedEnv({ [k]: v })), new RegExp(k));
    }
    await refused(run(setup(), hostedEnv({ ARENA_RUN_SPEC: '{}' })), /hosted_context_invalid \(manifest_source\)/);
  });
  test('input files: missing, a symlink, or over the contract caps (8192 / 16384 bytes) → manifest_source', async () => {
    const s = setup();
    await refused(runHosted({ manifest: join(s.dir, 'nope.json'), runSpec: s.inputs.runSpec, manifestKey: pubJwk(MANIFEST_KID), out: join(s.dir, 'out') }, { env: hostedEnv(), platform: PLATFORM, transportFactory: noTransport }), /manifest_source/);
    writeFileSync(s.inputs.manifest, `${readFileSync(s.inputs.manifest, 'utf8')}${' '.repeat(8192)}`);
    await refused(run(s), /manifest_source.*cap 8192/);
    const s2 = setup();
    writeFileSync(s2.inputs.runSpec, `${readFileSync(s2.inputs.runSpec, 'utf8')}${' '.repeat(16384)}`);
    await refused(run(s2), /manifest_source.*cap 16384/);
  });
  test('the credential is scrubbed from the environment even when the run is refused', async () => {
    const env = hostedEnv({ ARENA_SEAT_CREDENTIAL_FRANCE: 'seat-secret-value-123', ARENA_DIP_SECRET_0: dipSecret('x') });
    await refused(run(setup(undefined, { after: (m) => (m.rps_cap = 1) }), env), /signature/);
    assert.equal(env.ARENA_TARGET_CREDENTIAL, undefined);
    assert.equal(env.ARENA_SEAT_CREDENTIAL_FRANCE, undefined);
    assert.equal(env.ARENA_DIP_SECRET_0, undefined);
    const s = takeHostedSecrets({ ARENA_TARGET_CREDENTIAL: CANARY });
    assert.equal(JSON.stringify(s).includes(CANARY), false);
  });
  test('LLM peer seats are refused (blocked on K7)', async () => {
    await refused(
      run(
        setup((m) => {
          m.egress_allowlist = [{ origin: ORIGIN, role: 'target' }, { origin: 'https://peers.example.net', role: 'peer_gateway' }];
          m.peers = [{ seat: 'france', pack: 'sx-test-core', agent: 'sixi-attack/negotiator@1.0.0', gateway_origin: 'https://peers.example.net', provider: 'p', model_reported: 'm', inference_region: 'europe-west6', prompt_digest: `sha256:${'0'.repeat(64)}`, max_output_tokens: 1, token_budget: 1 }];
        }),
      ),
      /K7/,
    );
  });
});

describe('run --hosted: customer flags are refused', () => {
  for (const extra of [['--target', 'http://127.0.0.1:1'], ['--allow-private'], ['--scenario', 'byzantine'], ['--seeds', '1'], ['--auth', 'env:X'], ['--follow-redirects'], ['--i-own-this-target'], ['--token=abc'], ['positional']]) {
    test(`run --hosted ${extra.join(' ')}`, async () => {
      assert.throws(() => refuseCustomerRunFlags(['--hosted', '--manifest', 'm.json', '--run-spec', 's.json', ...extra]), (e: unknown) => e instanceof CliError && e.exitCode === 3 && /hosted_context_invalid/.test(e.message));
      await assert.rejects(main(['run', '--hosted', '--manifest', 'm.json', '--run-spec', 's.json', ...extra]), (e: unknown) => e instanceof CliError && e.exitCode === 3);
    });
  }
  test('the allowed set parses (and a value that starts with a dash is not mistaken for a flag)', () => {
    refuseCustomerRunFlags(['--hosted', '--manifest', 'm.json', '--run-spec', 's.json', '--manifest-key', '-----BEGIN PUBLIC KEY-----', '--out', '/out', '--json']);
  });
});

describe('hosted-v1 network policy', () => {
  const policy = hostedPolicy(['https://agent.example.com:443']);
  test('only the allowlisted origin, only https/wss, never loopback/private/metadata', () => {
    checkUrl(new URL('https://agent.example.com/a'), policy);
    checkUrl(new URL('wss://agent.example.com/ws'), policy);
    for (const u of ['http://agent.example.com/', 'https://agent.example.com:8443/', 'https://evil.example.net/', 'https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/']) {
      assert.throws(() => checkUrl(new URL(u), policy), NetBlockedError, u);
    }
  });
  test('a verified name that resolves to a private address is refused in the socket lookup, without saying where', async () => {
    const ctx = new NetContext({ policy, target: new URL('https://agent.example.com/'), userAgent: 'x', runId: 'run_x', rps: 0, resolver: async () => [{ address: '10.1.2.3', family: 4 }] });
    const err = await new Promise<Error | null>((res) => ctx.lookup('agent.example.com', {}, (e) => res(e)));
    assert.ok(err instanceof NetBlockedError);
    assert.match(err!.message, /public/);
    const ctx2 = new NetContext({ policy, target: new URL('https://agent.example.com/'), userAgent: 'x', runId: 'run_x', rps: 0, followRedirects: true });
    assert.equal(ctx2.followRedirects, false, 'redirects cannot be turned on under hosted-v1');
  });
});

/** A throwaway self-signed Ed25519 test certificate (CN agent.example.com; public material only). */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBTDCB/6ADAgECAhQcI7SRtU8ushAk8ZU5DHIfN+VuMTAFBgMrZXAwHDEaMBgG
A1UEAwwRYWdlbnQuZXhhbXBsZS5jb20wHhcNMjYwOTI2MTIwMDIzWhcNMzYwOTIz
MTIwMDIzWjAcMRowGAYDVQQDDBFhZ2VudC5leGFtcGxlLmNvbTAqMAUGAytlcAMh
ANcUGMfpjNn/0EqndPbaIJiD7I2M10KHELYeiNFLzG9Fo1MwUTAdBgNVHQ4EFgQU
2E43UcpwAuFTQ6wb18GH3Gm0SywwHwYDVR0jBBgwFoAU2E43UcpwAuFTQ6wb18GH
3Gm0SywwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCaIY33KBxD1b/50CWF3A1v
iOJYcnaAXM0rA61trvzP+sCVFXqXySauco123NGLnJi+QfCE01Cyaxrxz2CrfJAB
-----END CERTIFICATE-----
`;

test('observed_connections: per origin and leaf SPKI, the peer addresses actually dialed (v4-mapped folded)', async () => {
  const { X509Certificate } = await import('node:crypto');
  const { EventEmitter } = await import('node:events');
  const ctx = new NetContext({ policy: hostedPolicy(['https://agent.example.com:443']), target: new URL('https://agent.example.com/'), userAgent: 'x', runId: 'run_x', rps: 0 });
  const cert = new X509Certificate(TEST_CERT);
  const sock = (addr: string, ready: boolean) => Object.assign(new EventEmitter(), { remoteAddress: addr, getPeerX509Certificate: () => (ready ? cert : undefined) });
  ctx.observe(new URL('https://agent.example.com/act'), sock('203.0.113.10', true) as never);
  ctx.observe(new URL('https://agent.example.com/act'), sock('203.0.113.10', true) as never);
  const pending = sock('::ffff:198.51.100.7', false);
  ctx.observe(new URL('wss://agent.example.com/ws'), pending as never);
  (pending as unknown as { getPeerX509Certificate: () => unknown }).getPeerX509Certificate = () => cert;
  pending.emit('secureConnect');
  assert.deepEqual(ctx.observedConnections(), [
    { origin: 'https://agent.example.com', addresses: ['203.0.113.10'], spki_sha256: 'sha256:5ccd71873bd06c5dc7b725e14366066bcd7e72f57d1b91077e58d7c816f50431' },
    { origin: 'wss://agent.example.com', addresses: ['198.51.100.7'], spki_sha256: 'sha256:5ccd71873bd06c5dc7b725e14366066bcd7e72f57d1b91077e58d7c816f50431' },
  ]);
});
