/**
 * Phase-7 C2f: the CLI on contracts 2.2.0/2.3.0 and the upstream APIs.
 *
 *   - rerun = arena-scenarios `redrive(record)`; two regressions of the old
 *     local re-driver: `orderedLockSquad.disciplined` records were rejected, and
 *     an accepted frame with `latencyMs: null` was replayed as a hard miss;
 *   - ADR-004 seat provenance: `seats[]` with recorded_inputs digests, recorded
 *     actions returned to verify, regenerated seats asserted against the record;
 *   - target_ownership from buildReport; scoped engine build hash;
 *   - `verify --key` / `--hosted` over a sealed report;
 *   - diplomacy_standard listed and runnable (C2g);
 *   - the bundle and the dev path agree on the engine build hash.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createScenario, REFERENCE, toEpisodeResult, type EpisodeRecord } from 'arena-scenarios';
import { engineBuildDigest, engineBuildDigestOf, recordedInputsDigest, signReport, toSarif, toFileJson, ENGINE_BUILD_SCOPES, type Report } from 'arena-report';
import { engineBuildFor, engineBuildHash } from '../src/build-info.ts';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { referenceNames } from '../src/reference/policy.ts';
import { makeRerun, regenerate } from '../src/rerun.ts';
import { setOutputMode } from '../src/ui.ts';
import { runCli, scratch } from './helpers.ts';
import { NO_PIN } from './hosted-fixtures.ts';

setOutputMode({ quiet: true });

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

test('regression: a Deadlock coordinated record (driver:ref:orderedLockSquad.disciplined) re-simulates and verifies', async () => {
  const out = scratch();
  const r = await runCommand({ scenario: 'deadlock', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out }, []);
  assert.equal(r.exitCode, 0);
  const rec = readJson<EpisodeRecord>(join(out, 'report.episode-0.record.json'));
  assert.equal(rec.seats.find((s) => s.role === 'target')?.policyRef, `driver:ref:${REFERENCE.deadlock.coordinated.name}`);
  assert.equal(REFERENCE.deadlock.coordinated.name, 'orderedLockSquad.disciplined');
  assert.equal(verifyCommand(join(out, 'report.json')), 0);
  assert.equal(referenceNames().deadlock.coordinated, 'orderedLockSquad.disciplined');
});

test('regression: an accepted frame with latencyMs null is replayed as accepted, not as a hard miss', () => {
  const scn = createScenario('byzantine');
  scn.init(20260720, 'core', { mode: 'member', targetSeat: 'm1', fill: 'coordinated', targetDriver: 'external', blindingKey: '5c'.repeat(32) });
  let t = 0;
  while (!scn.terminal()) {
    // Every decision: an accepted (empty) action with no measured latency. Three hard misses in a row would forfeit.
    const receipt = scn.act('m1', { kind: 'action', payload: { units: [] }, latencyMs: null, frameBytes: 64 });
    assert.ok(receipt.accepted, `tick ${t}: ${receipt.reason}`);
    scn.tick();
    t++;
  }
  const rec = scn.record();
  assert.ok(rec.inputs.length > 3, 'longer than the three-miss forfeit');
  assert.notEqual(rec.terminal.outcome, 'forfeit');
  const decisions = rec.timing.filter((e) => e.event === 'decision');
  assert.ok(decisions.length > 3 && decisions.every((e) => e.miss === 'none' && e.latencyMs === null));
  const re = regenerate(rec);
  assert.equal(re.replayHash, rec.replayHash);
  assert.deepEqual(re.timing, rec.timing);
  assert.deepEqual(toEpisodeResult(re, { episodeIndex: 0 }), toEpisodeResult(rec, { episodeIndex: 0 }));
});

test('report: target_ownership from buildReport, seats[] with recorded_inputs digests, scoped engine build, not_assessed present', async () => {
  const out = scratch();
  assert.equal((await runCommand({ scenario: 'byzantine', seat: 'member', seeds: '20260720,1', target: 'ref:coordinated', out }, [])).exitCode, 0);
  const rep = readJson<Report>(join(out, 'report.json'));
  assert.deepEqual(rep.run.target_ownership, { loopback: true, attested: false });
  assert.equal(rep.engine.build_hash, engineBuildHash('core'));
  const eng = rep.engine as Report['engine'] & { build_scope?: string; source_manifest_digest?: string };
  assert.equal(eng.build_scope, 'core');
  assert.equal(eng.source_manifest_digest, engineBuildFor('byzantine').manifestDigest);
  assert.equal(engineBuildFor('byzantine').scope, 'core');
  assert.ok(Array.isArray(rep.not_assessed));
  for (const [i, ep] of rep.episodes.entries()) {
    const rec = readJson<EpisodeRecord>(join(out, `report.episode-${i}.record.json`));
    assert.deepEqual(ep.seats?.map((s) => `${s.seat}:${s.driver}:${s.inputs_source}`), ['m0:engine:seed_regenerated', 'm1:target:recorded', 'm2:engine:seed_regenerated', 'm3:engine:seed_regenerated', 'm4:engine:seed_regenerated']);
    const m1 = ep.seats!.find((s) => s.seat === 'm1')!;
    const actions = rec.inputs.map((t) => (t as Record<string, unknown>).m1 ?? null);
    assert.deepEqual(m1.recorded_inputs, { decisions: actions.length, digest: recordedInputsDigest(actions) });
  }
  // verify recomputes the digest from the actions the rerun replayed: a forged commitment is a mismatch.
  const path = join(out, 'report.json');
  setOutputMode({ quiet: true, json: true });
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
  try {
    assert.equal(verifyCommand(path), 0);
  } finally {
    process.stdout.write = write;
    setOutputMode({ quiet: true });
  }
  const v = JSON.parse(lines.join('')) as { provenance: { seat: string; label: string; inputs_digest: string }[]; recorded_seats: unknown[] };
  assert.ok(v.provenance.some((p) => p.seat === 'm1' && p.label === 'recorded, replayed' && p.inputs_digest === 'match'));
  assert.ok(v.provenance.some((p) => p.seat === 'm0' && p.label === 'regenerated from seed' && p.inputs_digest === 'not_applicable'));
  assert.deepEqual(v.recorded_seats, []);
  const forged = readJson<Report>(path);
  forged.episodes[0].seats![1].recorded_inputs!.digest = `sha256:${'1'.repeat(64)}`;
  writeFileSync(path, JSON.stringify(forged));
  assert.equal(verifyCommand(path), 1);
});

test('rerun: returns recordedActions for ctx.recordedSeats and refuses a regenerated seat the record has as the target', async () => {
  const out = scratch();
  await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out }, []);
  const path = join(out, 'report.json');
  const rep = readJson<Report>(path);
  const rerun = makeRerun(path);
  const base = { episodeIndex: 0, seed: 20260720, seat: 'squad' as const, mode: 'squad' as const, tier: 'core' as const, blindingKey: rep.episodes[0].blinding_key, replayRef: rep.episodes[0].replay_ref };
  const recorded = ['m0', 'm1', 'm2', 'm3', 'm4'].map((seat) => ({ seat: seat as 'm0', driver: 'target' as const, inputs_source: 'recorded' as const }));
  const o = rerun(rep.run.spec, 20260720, { ...base, recordedSeats: recorded, regeneratedSeats: [] });
  assert.ok('result' in o && o.recordedActions);
  const rec = readJson<EpisodeRecord>(join(out, 'report.episode-0.record.json'));
  assert.deepEqual(o.recordedActions!.m3, rec.inputs.map((t) => (t as Record<string, unknown>).m3 ?? null));
  assert.throws(() => rerun(rep.run.spec, 20260720, { ...base, recordedSeats: recorded.slice(1), regeneratedSeats: ['m0'] }), /regenerated from the seed per the RunSpec/);
});

test('diplomacy_standard: listed with power seating and its references, runnable (C2g); the in-process pair aliases work', async () => {
  const l = await runCli(['list-scenarios', '--json']);
  assert.equal(l.code, 0, l.stderr);
  const dip = (JSON.parse(l.stdout) as { scenarios: { scenario_id: string; seats: string[]; runnable: boolean; reference_pair: { coordinated: string; naive: string } | null }[] }).scenarios.find((s) => s.scenario_id === 'diplomacy_standard');
  assert.ok(dip, 'listed');
  assert.deepEqual(dip.seats, ['power']);
  assert.equal(dip.runnable, true);
  assert.deepEqual(dip.reference_pair, { coordinated: 'robust-diplomat', naive: 'credulous-diplomat' });
  const human = await runCli(['list-scenarios']);
  assert.match(human.stdout, /diplomacy_standard .* seatings: power/);
  // ref:coordinated is the robust-diplomat alias; one short game.
  const out = scratch();
  const r = await runCli(['run', '--scenario', 'diplomacy_standard', '--seat', 'germany', '--horizon', '1901', '--seeds', '3', '--target', 'ref:coordinated', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const rep = readJson<Report>(join(out, 'report.json'));
  assert.equal(rep.episodes[0].seat, 'germany');
  assert.equal(rep.run.spec.target.url, 'http://in-process.invalid/ref:coordinated');
});

/** A local report turned into a sealed hosted one (the shape the Sixi seal step emits). */
async function sealedFixture() {
  const out = scratch();
  await runCommand({ scenario: 'byzantine', seat: 'squad', seeds: '20260720', target: 'ref:coordinated', out }, []);
  const path = join(out, 'report.json');
  const hostedExample = readJson<Report>(join(import.meta.dirname, '..', '..', 'arena-report', 'test', 'fixtures', 'hosted-report.json'));
  const hosted = JSON.parse(JSON.stringify(hostedExample.run.hosted)) as NonNullable<Report['run']['hosted']>;
  delete hosted.run_manifest.path;
  const rep = readJson<Report>(path);
  rep.run.mode = 'hosted';
  rep.run.hosted = hosted;
  rep.run.target_ownership = { loopback: false, attested: true, source: 'sixi_verified' };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const sealed = signReport(rep, privateKey, hosted.signing_key_id, { sealedAt: '2026-11-10T14:07:15Z' });
  writeFileSync(path, toFileJson(sealed));
  writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(sealed)));
  const pub = join(out, 'pub.pem');
  writeFileSync(pub, publicKey.export({ format: 'pem', type: 'spki' }) as string);
  const priv = join(out, 'priv.pem');
  writeFileSync(priv, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
  return { out, path, pub, priv, sealed, jwk: JSON.stringify(publicKey.export({ format: 'jwk' })) };
}

test('verify --key: a sealed report verifies (PEM file or JWK); tampering or a foreign key is signature_invalid (exit 2); a private key is refused (exit 3)', async () => {
  const f = await sealedFixture();
  assert.equal(verifyCommand(f.path, { key: f.pub }), 0);
  assert.equal(verifyCommand(f.path, { key: f.jwk }), 0);
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }) as string;
  assert.equal(verifyCommand(f.path, { key: other }), 2);
  const v = await runCli(['verify', f.path, '--key', f.pub]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /signature: valid/);
  assert.match(v.stdout, /seats: m0 recorded, replayed/);
  assert.match(v.stdout, /recorded seats: none besides the target/);
  assert.throws(() => verifyCommand(f.path, { key: f.priv }), /PRIVATE key/);
  const tampered = JSON.parse(JSON.stringify(f.sealed)) as Report;
  (tampered.disclosure as { conflict_of_interest: string }).conflict_of_interest += ' ';
  writeFileSync(f.path, JSON.stringify(tampered));
  const t = await runCli(['verify', f.path, '--key', f.pub]);
  assert.equal(t.code, 2, t.stdout);
  assert.match(t.stdout, /signature_invalid/);
});

test('verify --hosted: needs --key; cross-checks the SARIF key id against the DSSE seal and the run-manifest digest', async () => {
  const f = await sealedFixture();
  assert.throws(() => verifyCommand(f.path, { pinnedKeys: NO_PIN, hosted: true }), /needs the public key/);
  // Phase 9 B1: --hosted requires the run manifest beside the report (run.hosted.run_manifest.path = run-manifest.json);
  // this fixture carries none, so the seal cannot be tied to a manifest. The full positive path is in hosted.test.ts.
  assert.equal(verifyCommand(f.path, { pinnedKeys: NO_PIN, hosted: true, key: f.pub }), 2);
  const sarif = readJson<{ runs: { properties: { agentArena: Record<string, unknown> } }[] }>(join(f.out, 'report.sarif'));
  sarif.runs[0].properties.agentArena.signing_key_id = 'sixi-arena-ed25519-other';
  writeFileSync(join(f.out, 'report.sarif'), JSON.stringify(sarif));
  const r = await runCli(['verify', f.path, '--hosted', '--key', f.pub]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /signature_invalid: the SARIF signing_key_id differs from the DSSE seal/);
  // A manifest path in run.hosted is resolved inside the bundle and digested.
  writeFileSync(join(f.out, 'report.sarif'), toFileJson(toSarif(f.sealed)));
  const rep = JSON.parse(JSON.stringify(f.sealed)) as Report;
  rep.run.hosted!.run_manifest.path = 'run-manifest.json';
  writeFileSync(f.path, JSON.stringify(rep));
  const m = await runCli(['verify', f.path, '--hosted', '--key', f.pub]);
  assert.equal(m.code, 2);
  assert.match(m.stdout, /run manifest run-manifest.json beside the report cannot be checked/);
});

test('engine build hash: the bundle embeds the source manifest and agrees with the dev path in every scope; its report verifies in dev', { timeout: 180_000 }, async () => {
  const { bundle, bundleDefines } = await import('../build.ts');
  const defines = bundleDefines();
  assert.equal(defines.__ARENA_ENGINE_DIGEST__, undefined, 'the old single-digest define is gone');
  const manifest = JSON.parse(defines.__ARENA_ENGINE_SOURCES__);
  for (const scope of ENGINE_BUILD_SCOPES) assert.equal(engineBuildDigestOf(manifest, scope).digest, engineBuildDigest({ scope }).digest, scope);
  const dir = scratch('arena-bundle-');
  const b = await bundle(join(dir, 'agent-arena.cjs'));
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const v = JSON.parse(execFileSync(process.execPath, [b.outfile, 'version', '--json'], { cwd: dir, env, encoding: 'utf8' })) as { engine_builds: Record<string, string> };
  for (const scope of ENGINE_BUILD_SCOPES) assert.equal(v.engine_builds[scope], engineBuildHash(scope), `bundle vs dev, scope ${scope}`);
  const out = join(dir, 'out');
  execFileSync(process.execPath, [b.outfile, 'run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', 'ref:coordinated', '--out', out, '--quiet'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(readJson<Report>(join(out, 'report.json')).engine.build_hash, engineBuildHash('core'));
  assert.equal(verifyCommand(join(out, 'report.json')), 0, 'a bundle-produced report verifies on the dev path');
});
