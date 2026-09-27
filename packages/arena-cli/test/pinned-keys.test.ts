/**
 * S-1 / OQ-3 / A8: the Sixi control-plane keys this open release pins
 * (src/hosted/pinned-keys.json). The file's shape; the production default
 * (no test seam): a manifest by a key the release does not pin is refused with
 * hosted_context_invalid, and --manifest-key cannot replace the set; the key
 * window [not_before, not_after) is checked at the manifest's issued_at.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { runHostedCommand } from '../src/commands/run-hosted.ts';
import { verifyManifest } from '../src/hosted/manifest.ts';
import { contractsDir } from 'wot-contracts/contracts-dir';
import {
  deriveKid,
  jwkThumbprint,
  KID_PATTERN,
  PINNED_KEY_ARG,
  PINNED_MANIFEST_JWKS,
  pinnedKeyFile,
  pinnedKeyFileProblems,
  pinnedManifestKeys,
  pinnedReportKeys,
  resolveManifestKeys,
} from '../src/hosted/pinned-keys.ts';
import type { PinnedKey } from '../src/keys.ts';
import { setOutputMode } from '../src/ui.ts';
import { pinnedReportKeyFor } from '../src/commands/verify.ts';
import { hostedEnv, MANIFEST_KID, PLATFORM, PUB, pubJwk, REPORT_KID, runSpec, signManifest, unsignedManifest, writeInputs } from './hosted-fixtures.ts';
import { PKG, scratch } from './helpers.ts';

const FILE = join(PKG, 'src', 'hosted', 'pinned-keys.json');
const raw = () => JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, any>;
const LIVE_MANIFEST_KID = 'sixi-arena-manifest-ed25519-86c88a43cdcdb910e8f4';
const LIVE_REPORT_KID = 'sixi-arena-ed25519-c2f84888ae5d69e9f7df';
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
const DAY = 86_400_000;

before(() => setOutputMode({ quiet: true }));

describe('the bundled key file', () => {
  test('is valid: format, source, fetch date, the manifest and report keys with their windows, no run-token key', () => {
    const doc = raw();
    assert.deepEqual(pinnedKeyFileProblems(doc), []);
    assert.equal(doc.format, 'agent-arena-pinned-keys/1');
    assert.equal(doc.source, 'https://sixi.ch/.well-known/arena-jwks.json');
    assert.equal(doc.fetched_at, '2026-09-27T16:00:31Z');
    assert.deepEqual(doc.manifest.keys.map((k: { kid: string }) => k.kid), [LIVE_MANIFEST_KID]);
    assert.deepEqual(doc.report.keys.map((k: { kid: string }) => k.kid), [LIVE_REPORT_KID]);
    for (const k of [...doc.manifest.keys, ...doc.report.keys]) {
      assert.match(k.kid, KID_PATTERN);
      assert.equal(k.kty, 'OKP');
      assert.equal(k.crv, 'Ed25519');
      assert.equal(k.use, 'sig');
      assert.equal(k.alg, 'EdDSA');
      assert.ok(!('d' in k), 'public keys only');
      assert.equal(k.not_before, '2026-09-27T00:00:00Z');
      assert.equal(k.not_after, '2026-12-26T00:00:00Z');
    }
    assert.ok(!JSON.stringify(doc).includes('runtoken-ed25519'), 'the run-token key is not bundled');
    assert.equal(doc.runtoken, undefined);
  });

  test('keeps each served JWKS exactly: JSON.stringify(set) + LF reproduces the recorded sha256 of the ?purpose= body', () => {
    const doc = raw();
    for (const p of ['manifest', 'report'] as const) {
      const body = `${JSON.stringify({ keys: doc[p].keys })}\n`;
      assert.equal(`sha256:${createHash('sha256').update(body).digest('hex')}`, doc[p].source_sha256, p);
      assert.equal(doc[p].source, `https://sixi.ch/.well-known/arena-jwks.json?purpose=${p}`);
    }
    // The ETag the server sent is the first 128 bits of the unfiltered body's sha256.
    assert.equal(doc.source_etag, `"${doc.source_sha256.slice('sha256:'.length, 'sha256:'.length + 32)}"`);
  });

  test('loads as frozen PinnedKeys with windows in epoch ms', () => {
    const m = pinnedManifestKeys();
    assert.equal(m.length, 1);
    assert.equal(m[0]!.kid, LIVE_MANIFEST_KID);
    assert.equal(m[0]!.not_before, Date.parse('2026-09-27T00:00:00Z'));
    assert.equal(m[0]!.not_after, Date.parse('2026-12-26T00:00:00Z'));
    assert.equal(pinnedReportKeys()[0]!.kid, LIVE_REPORT_KID);
    assert.equal(PINNED_MANIFEST_JWKS.keys[0]!.kid, LIVE_MANIFEST_KID);
    assert.ok(Object.isFrozen(pinnedKeyFile().manifest.keys[0]));
  });

  const mutate = (f: (d: Record<string, any>) => void) => {
    const d = raw();
    f(d);
    return pinnedKeyFileProblems(d).join('; ');
  };
  const cases: [string, (d: Record<string, any>) => void, RegExp][] = [
    ['a kid outside the contract pattern', (d) => (d.manifest.keys[0].kid = 'Sixi Manifest'), /kid does not match/],
    ['an RSA key', (d) => (d.manifest.keys[0].kty = 'RSA'), /not an OKP Ed25519 key/],
    ['an X25519 key', (d) => (d.report.keys[0].crv = 'X25519'), /not an OKP Ed25519 key/],
    ['use enc', (d) => (d.manifest.keys[0].use = 'enc'), /use must be "sig"/],
    ['use missing', (d) => delete d.manifest.keys[0].use, /use must be "sig"/],
    ['private material', (d) => (d.manifest.keys[0].d = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A'), /private key material/],
    ['a short x', (d) => (d.manifest.keys[0].x = 'kRhdxwyUXuJOwPwo8Gx0dXQXvhRweSkJ'), /x is not a canonical/],
    ['a report key in the manifest set', (d) => d.manifest.keys.push(d.report.keys[0]), /sixi_purpose report is not manifest|kid appears twice/],
    ['a run-token set', (d) => (d.runtoken = { keys: [] }), /run-token key is not bundled/],
    ['an empty manifest set', (d) => (d.manifest.keys = []), /manifest\.keys must hold 1\.\.16/],
    ['not_after before not_before', (d) => (d.manifest.keys[0].not_after = '2026-09-01T00:00:00Z'), /not_after is not after not_before/],
    ['a window without a time zone', (d) => (d.manifest.keys[0].not_before = '2026-09-27T00:00:00'), /RFC 3339 UTC/],
    ['a window over 120 days', (d) => (d.manifest.keys[0].not_after = '2027-09-27T00:00:00Z'), /longer than 120 days/],
    ['a thumbprint of another key', (d) => (d.manifest.keys[0].sixi_thumbprint = d.report.keys[0].sixi_thumbprint), /RFC 7638 thumbprint/],
    ['an unknown member', (d) => (d.manifest.keys[0].jku = 'https://example.com/keys'), /unknown member/],
    ['another format', (d) => (d.format = 'jwks'), /format must be/],
    // contracts 2.11.0, signing.md §3.3 rule 1 (contract-check §15), now also checked by the CLI itself:
    ['a kid that is not derived from its key', (d) => (d.manifest.keys[0].kid = 'sixi-arena-manifest-ed25519-20261101'), /kid is not sixi-arena-manifest-ed25519- followed by the first 80 bits/],
    ['a report kid in the manifest namespace', (d) => (d.report.keys[0].kid = `sixi-arena-manifest-ed25519-${d.report.keys[0].kid.slice(-20)}`), /report\.keys\[0\]: kid is not sixi-arena-ed25519-/],
    ['a key changed after it was served (the body no longer hashes to source_sha256)', (d) => (d.manifest.keys[0].status = 'valid'), /manifest\.keys do not reproduce the served body/],
    ['the served members reordered', (d) => (d.report.keys[0] = Object.fromEntries(Object.entries(d.report.keys[0]).reverse())), /report\.keys do not reproduce the served body/],
    ['a set source without ?purpose=', (d) => (d.manifest.source = d.source), /manifest\.source must be the file's source followed by \?purpose=manifest/],
    ['a set source of the other purpose', (d) => (d.report.source = `${d.source}?purpose=manifest`), /report\.source must be/],
    ['a file source with a query', (d) => (d.source = `${d.source}?purpose=manifest`), /without a query/],
    ['a missing source_sha256', (d) => delete d.report.source_sha256, /report\.source_sha256 must be/],
    ['one public key in both sets', (d) => (d.report.keys[0].x = d.manifest.keys[0].x), /also in the manifest set/],
    ['revoked_at before not_before', (d) => (d.manifest.keys[0].revoked_at = '2026-09-26T00:00:00Z'), /revoked_at is before not_before/],
    ['an unknown status', (d) => (d.manifest.keys[0].status = 'active'), /status must be/],
    ['a third set', (d) => (d.extra = { source: 'x', keys: [] }), /unknown top-level member/],
    ['an unknown member in a set', (d) => (d.manifest.jku = 'https://example.com'), /manifest: unknown member/],
    ['a file over 65536 bytes', (d) => (d.note = 'x'.repeat(70_000)), /over 65536 bytes/],
  ];
  for (const [name, f, re] of cases) test(`refuses ${name}`, () => assert.match(mutate(f), re));

  test('kid derivation (signing.md §3.3 rule 1): both bundled kids and the schema example recompute from their keys', () => {
    const doc = raw();
    assert.equal(deriveKid('manifest', doc.manifest.keys[0].x), LIVE_MANIFEST_KID);
    assert.equal(deriveKid('report', doc.report.keys[0].x), LIVE_REPORT_KID);
    assert.equal(jwkThumbprint(doc.manifest.keys[0].x).toString('base64url'), doc.manifest.keys[0].sixi_thumbprint);
    const example = JSON.parse(readFileSync(join(contractsDir(), 'schemas', 'pinned_keys.schema.json'), 'utf8')).examples[0];
    assert.deepEqual(pinnedKeyFileProblems(example), []);
  });
});

describe('run --hosted against the bundled set (the production default, no test seam)', () => {
  function inputs(o: Parameters<typeof unsignedManifest>[1] = {}) {
    const spec = runSpec({ seeds: [20260720], episodes: 1 });
    const dir = scratch();
    return { dir, inputs: writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec, o)), spec) };
  }
  const run = (s: ReturnType<typeof inputs>, manifestKey?: string) =>
    runHostedCommand({ ...s.inputs, ...(manifestKey ? { manifestKey } : {}), out: join(s.dir, 'out') }, { env: hostedEnv(), platform: PLATFORM });

  test('the release pins the Sixi manifest kid and refuses --manifest-key, even naming another key', async () => {
    assert.deepEqual(resolveManifestKeys(undefined, { required: true }).map((k) => k.kid), [LIVE_MANIFEST_KID]);
    await assert.rejects(run(inputs(), pubJwk(MANIFEST_KID)), (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 3);
      assert.match(e.message, /^hosted_context_invalid \(--manifest-key\): this release pins the control-plane manifest key set \(sixi-arena-manifest-ed25519-86c88a43cdcdb910e8f4\)/);
      return true;
    });
  });

  test('a manifest signed by a key the release does not pin is refused: hosted_context_invalid (/signing/signing_key_id), exit 3, nothing sent', async () => {
    await assert.rejects(run(inputs()), (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 3);
      assert.match(e.message, /^hosted_context_invalid \(\/signing\/signing_key_id\): the manifest is signed by key sixi-arena-manifest-ed25519-20261101, which is not a pinned control-plane key \(pinned: sixi-arena-manifest-ed25519-86c88a43cdcdb910e8f4\)\. Nothing was sent\./);
      return true;
    });
  });

  test('a manifest that names the pinned kid but is signed by another key is refused (/signing/signature)', async () => {
    const m = unsignedManifest(runSpec({ seeds: [20260720], episodes: 1 }));
    const s = inputs({ signing: { ...m.signing, signing_key_id: LIVE_MANIFEST_KID } });
    await assert.rejects(run(s), /hosted_context_invalid \(\/signing\/signature\): the Ed25519 signature does not verify against the pinned control-plane key for kid sixi-arena-manifest-ed25519-86c88a43cdcdb910e8f4/);
  });
});

describe('the key window [not_before, not_after), checked at issued_at', () => {
  const spec = runSpec({ seeds: [20260720], episodes: 1 });
  const windowed = (nb: number, na: number, extra: Partial<PinnedKey> = {}): PinnedKey[] => [{ key: PUB, kid: MANIFEST_KID, not_before: nb, not_after: na, ...extra }];
  const signedAt = (t: number) => JSON.stringify(signManifest(unsignedManifest(spec, { issued_at: iso(t) })));
  const now = Date.now();

  test('inside the window: verifies', () => {
    assert.equal(verifyManifest(signedAt(now - 60_000), windowed(now - 10 * DAY, now + 80 * DAY)).kid, MANIFEST_KID);
  });
  test('after not_after: refused (/signing/signing_key_id), naming both times', () => {
    assert.throws(() => verifyManifest(signedAt(now - 60_000), windowed(now - 90 * DAY, now - 3_600_000)), /hosted_context_invalid \(\/signing\/signing_key_id\): the manifest is signed by pinned key sixi-arena-manifest-ed25519-20261101 outside that key's window \(signed at .*Z, at or after the key's not_after .*Z\)/);
  });
  test('before not_before: refused', () => {
    assert.throws(() => verifyManifest(signedAt(now - 60_000), windowed(now + DAY, now + 90 * DAY)), /hosted_context_invalid \(\/signing\/signing_key_id\).*before the key's not_before/);
  });
  test('not_after is exclusive', () => {
    const t = Date.parse('2026-12-26T00:00:00Z');
    assert.throws(() => verifyManifest(signedAt(t), windowed(t - 90 * DAY, t)), /at or after the key's not_after 2026-12-26T00:00:00Z/);
    assert.equal(verifyManifest(signedAt(t - 1000), windowed(t - 90 * DAY, t)).kid, MANIFEST_KID);
  });
  test('revoked_at ends the window', () => {
    assert.throws(() => verifyManifest(signedAt(now - 60_000), windowed(now - DAY, now + DAY, { revoked_at: now - 3_600_000 })), /at or after the key's revoked_at/);
  });
  test('a run whose key window has closed is refused by run --hosted before any I/O', async () => {
    const dir = scratch();
    const inp = writeInputs(join(dir, 'in'), JSON.parse(signedAt(now - 60_000)), spec);
    await assert.rejects(
      runHostedCommand({ ...inp, out: join(dir, 'out') }, { env: hostedEnv(), platform: PLATFORM, pinnedKeys: windowed(now - 90 * DAY, now - 3_600_000) }),
      /hosted_context_invalid \(\/signing\/signing_key_id\).*outside that key's window/,
    );
  });
});

describe('--key pinned: the bundled report keys, by kid, inside their window at sealed_at', () => {
  const sealedReport = (kid: string, sealedAt: string) => ({ signing: { signing_key_id: kid, sealed_at: sealedAt } });
  test('the argument value is the word "pinned"', () => assert.equal(PINNED_KEY_ARG, 'pinned'));
  test('a report sealed by the pinned report kid inside the window selects that key', () => {
    const r = pinnedReportKeyFor(sealedReport(LIVE_REPORT_KID, '2026-11-10T14:07:15Z'), pinnedReportKeys());
    assert.equal(r.error, undefined);
    assert.equal(r.key!.export({ format: 'jwk' }).x, 'JUtusRmM32aPz9FiVlgVeDaDhFGbV1zHA7hwpxbISTo');
  });
  test('an unpinned kid, a kid outside its window, the manifest kid, and an unsealed report are signature_invalid', () => {
    assert.match(pinnedReportKeyFor(sealedReport(REPORT_KID, '2026-11-10T14:07:15Z'), pinnedReportKeys()).error!, /^signature_invalid: key: the report is sealed by key sixi-arena-ed25519-20261101, which is not a report key this release pins/);
    assert.match(pinnedReportKeyFor(sealedReport(LIVE_REPORT_KID, '2027-01-10T00:00:00Z'), pinnedReportKeys()).error!, /outside that key's window \(signed at 2027-01-10T00:00:00Z, at or after the key's not_after 2026-12-26T00:00:00Z\)/);
    assert.match(pinnedReportKeyFor(sealedReport(LIVE_MANIFEST_KID, '2026-11-10T14:07:15Z'), pinnedReportKeys()).error!, /not a report key this release pins/);
    assert.match(pinnedReportKeyFor({}, pinnedReportKeys()).error!, /carries no signing block/);
  });
});
