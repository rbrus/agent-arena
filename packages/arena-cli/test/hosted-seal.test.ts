/**
 * `verify --hosted-seal` (HOSTED-PROFILE §2.7, §3.1; SIXI-INTEGRATION §1.10):
 * pre-seal (the seal step's verifier job) and sealed (the downloaded bundle,
 * three DSSE envelopes + bundle-manifest.json), SARIF re-render byte equality.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { canonicalizeForSigning, REPORT_PAYLOAD_TYPE, signReport, toFileJson, type Report } from 'arena-report';
import { verifyHostedSeal } from '../src/commands/verify.ts';
import { BUNDLE_PAYLOAD_TYPE, renderSarif, SARIF_PAYLOAD_TYPE } from '../src/hosted/seal.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { dsseEnvelope, hostedEnv, MANIFEST_KID, PLATFORM, PRIV, pubJwk, REPORT_KID, runSpec, signManifest, unsignedManifest, viaReference, writeInputs, runHosted } from './hosted-fixtures.ts';
import { scratch } from './helpers.ts';

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

/** What the Sixi seal step writes (with the RFC 8032 test key standing in for the KMS report key). */
function seal(out: string): void {
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
  const sealed = signReport(report, PRIV, REPORT_KID, { sealedAt: '2026-11-10T14:07:00Z' });
  writeFileSync(join(out, 'report.json'), toFileJson(sealed));
  writeFileSync(join(out, 'report.json.dsse.json'), dsseEnvelope(Buffer.from(canonicalizeForSigning(sealed), 'utf8'), REPORT_PAYLOAD_TYPE, REPORT_KID));
  writeFileSync(join(out, 'report.sarif.dsse.json'), dsseEnvelope(readFileSync(join(out, 'report.sarif')), SARIF_PAYLOAD_TYPE, REPORT_KID));
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(out, p);
        if (/^(report\.json|report\.sarif|run-manifest\.json|episodes\/\d+\.(record|replay)\.json)$/.test(rel)) {
          const b = readFileSync(p);
          files.push({ path: rel, sha256: `sha256:${createHash('sha256').update(b).digest('hex')}`, bytes: b.length });
        }
      }
    }
  };
  walk(out);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const bm = `${JSON.stringify({ bundle_version: '1.0', run_id: sealed.run.run_id, signing_key_id: REPORT_KID, files }, null, 2)}\n`;
  writeFileSync(join(out, 'bundle-manifest.json'), bm);
  writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), dsseEnvelope(Buffer.from(bm), BUNDLE_PAYLOAD_TYPE, REPORT_KID));
}

test('pre-seal and sealed bundle verification; tampering is caught', async () => {
  const spec = runSpec({ seeds: [20260720], episodes: 1 });
  const dir = scratch();
  const inputs = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec)), spec);
  const out = join(dir, 'out');
  assert.equal((await runHosted({ ...inputs, manifestKey: pubJwk(MANIFEST_KID), out }, { env: hostedEnv(), platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, {}) })).exitCode, 0);

  // Pre-seal (verifier job): no key needed; SARIF re-render is byte-equal to what the runner wrote.
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
  assert.equal(renderSarif(report), readFileSync(join(out, 'report.sarif'), 'utf8'));
  assert.equal(verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID) }), 0);

  // A SARIF edited after the run: mismatch (exit 1).
  const sarifPath = join(out, 'report.sarif');
  const sarif = readFileSync(sarifPath, 'utf8');
  writeFileSync(sarifPath, sarif.replace('"results"', '"results" '));
  assert.equal(verifyHostedSeal(out, { manifestKey: pubJwk(MANIFEST_KID) }), 1);
  writeFileSync(sarifPath, sarif);

  // Sealed: three envelopes and the bundle manifest.
  seal(out);
  assert.throws(() => verifyHostedSeal(out, {}), /needs the report-signing public key/);
  assert.equal(verifyHostedSeal(out, { key: pubJwk(REPORT_KID), manifestKey: pubJwk(MANIFEST_KID) }), 0);
  assert.equal(verifyHostedSeal(join(out, 'report.json'), { key: JSON.stringify({ keys: [JSON.parse(pubJwk(REPORT_KID))] }) }), 0);

  // A record changed after sealing: the bundle digest no longer matches (exit 2).
  const rec = join(out, 'episodes', '0.record.json');
  const recText = readFileSync(rec, 'utf8');
  writeFileSync(rec, recText.replace(/\n$/, ' \n'));
  assert.equal(verifyHostedSeal(out, { key: pubJwk(REPORT_KID) }), 2);
  writeFileSync(rec, recText);
  // A run-manifest swapped after sealing: its digest no longer matches the seal (exit 2).
  const mp = join(out, 'run-manifest.json');
  const mText = readFileSync(mp, 'utf8');
  writeFileSync(mp, mText.replace('"rps_cap": 50', '"rps_cap": 49'));
  assert.equal(verifyHostedSeal(out, { key: pubJwk(REPORT_KID) }), 2);
  writeFileSync(mp, mText);
  // The wrong report key: exit 2.
  assert.equal(verifyHostedSeal(out, { key: pubJwk('sixi-arena-ed25519-20990101') }), 2);
  assert.equal(verifyHostedSeal(out, { key: pubJwk(REPORT_KID) }), 0);
});
