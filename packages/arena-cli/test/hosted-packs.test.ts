/**
 * Scenario packs (contracts 2.2.0 K5/K9; HOSTED-PROFILE §5): the open CLI
 * refuses every `sx_` id before any I/O; the hosted runner loads only packs the
 * signed manifest lists, mounted under ARENA_PACKS_DIR, signed with the pinned
 * control-plane key and valid for the running engine build. A variant resolves
 * to base scenario + parameters. A mounted clause-map pack feeds the report's
 * not-assessed clause list.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sign as edSign, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pae, toPublicKey, type Report } from 'arena-report';
import { engineBuildFor } from '../src/build-info.ts';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { loadPacks, PACK_ENVELOPE_FILE, PACK_PAYLOAD_TYPE, packCoverageMissing, parseVariantParams, resolveVariant } from '../src/hosted/packs.ts';
import type { PackManifestContract } from '../src/generated/contracts.ts';
import { contractsDir } from 'wot-contracts/contracts-dir';
import { loadPublicKeySet, type PinnedKey } from '../src/keys.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { hostedEnv, MANIFEST_KID, OTHER_PRIV, packManifest, PLATFORM, PRIV, PUB, pubJwk, runSpec, sha256Of, signManifest, unsignedManifest, VARIANT_PARAMS, viaReference, writeInputs, writePack, runHosted } from './hosted-fixtures.ts';
import { scratch } from './helpers.ts';

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

const KEYS = () => loadPublicKeySet(pubJwk(MANIFEST_KID), '--manifest-key');
const build = (s: string) => engineBuildFor(s).digest;
const isRefusal = (re: RegExp) => (e: unknown) => e instanceof CliError && e.exitCode === 3 && re.test(e.message);

function mountedPack(o: Parameters<typeof writePack>[2] = {}, pmOver = {}) {
  const dir = scratch();
  const pm = packManifest(pmOver, sha256Of(o.variant ?? VARIANT_PARAMS));
  const digest = writePack(dir, pm, o);
  return { dir, pm, entry: { id: pm.id, version: pm.version, digest } };
}

test('open CLI: an sx_ scenario is refused before any I/O with scenario_pack_unavailable (exit 3)', async () => {
  await assert.rejects(runCommand({ scenario: 'sx_deadlock_hard', target: 'http://127.0.0.1:1', seat: 'squad' }, []), isRefusal(/^scenario_pack_unavailable: sx_deadlock_hard is a Sixi Arena pack scenario; this CLI ships the open scenarios only\. Nothing was sent\./));
});

test('pack loader: a locally signed pack manifest loads; its variant registers as base + parameters', () => {
  const p = mountedPack();
  const packs = loadPacks([p.entry], p.dir, KEYS(), build, 'byzantine');
  assert.equal(packs.length, 1);
  const v = resolveVariant('sx_deadlock_hard', packs);
  assert.equal(v.base, 'deadlock');
  assert.deepEqual(v.params, { tier: 'core', oracle_thresholds: {} });
  assert.throws(() => resolveVariant('sx_unknown', packs), isRefusal(/not a variant of any pack/));
});

test('pack loader refusals: no ARENA_PACKS_DIR, digest mismatch, wrong signer, engine build out of range, variant data tampered, parameters outside the surface', () => {
  const p = mountedPack();
  assert.throws(() => loadPacks([p.entry], undefined, KEYS(), build, 'byzantine'), isRefusal(/ARENA_PACKS_DIR is not set/));
  assert.throws(() => loadPacks([{ ...p.entry, digest: `sha256:${'9'.repeat(64)}` }], p.dir, KEYS(), build, 'byzantine'), isRefusal(/digests to/));
  const wrong = mountedPack({ key: OTHER_PRIV });
  assert.throws(() => loadPacks([wrong.entry], wrong.dir, KEYS(), build, 'byzantine'), isRefusal(/signature does not verify/));
  const old = mountedPack({}, { engine: { builds: [`sha256:${'1'.repeat(64)}`], versions: '>=arena@2.0.0', contracts: '^2.2.0' } });
  assert.throws(() => loadPacks([old.entry], old.dir, KEYS(), build, 'byzantine'), isRefusal(/^pack_engine_mismatch: Pack sx-test-core@1\.0\.0 was not validated on the current engine build/));
  const tampered = mountedPack();
  writeFileSync(join(tampered.dir, 'sx-test-core', 'variants', 'deadlock-hard.json'), VARIANT_PARAMS.replace('core', 'edge'));
  assert.throws(() => loadPacks([tampered.entry], tampered.dir, KEYS(), build, 'byzantine'), isRefusal(/does not match its pinned digest/));
  assert.throws(() => parseVariantParams(Buffer.from(JSON.stringify({ format: 'arena-pack-variant/1', code: 'x' })), 'deadlock', 'v'), isRefusal(/outside the variant parameter surface/));
  assert.throws(() => parseVariantParams(Buffer.from(JSON.stringify({ format: 'arena-pack-variant/1', oracle_thresholds: { 'deadlock.invented': 0.5 } })), 'deadlock', 'v'), isRefusal(/a pack never adds an oracle/));
  assert.throws(() => parseVariantParams(Buffer.from(JSON.stringify({ format: 'arena-pack-variant/1', seeds: [-1] })), 'deadlock', 'v'), isRefusal(/uint32/));
});

/* ---- contracts 2.9.0: coverage rule (signing.md §11.3 step 6a), the must-rejects of contract-check.mjs §13 ---- */
const CONTRACTS = contractsDir();
const packExample = (): PackManifestContract => JSON.parse(readFileSync(join(CONTRACTS, 'schemas', 'pack_manifest.schema.json'), 'utf8')).examples[0];
const mountExample = (mutate: (p: PackManifestContract) => void) => {
  const pm = packExample();
  mutate(pm);
  const dir = scratch();
  const digest = writePack(dir, pm, { variant: readFileSync(join(CONTRACTS, 'fixtures', 'packs', 'sx-agentic-core', 'variants', 'deadlock-hard.json'), 'utf8') });
  return { dir, entry: { id: pm.id, version: pm.version, digest } };
};
const placeholderBuild = () => packExample().engine.builds[0];

test('pack loader, coverage rule (§11.3 6a): the three contract-check §13 must-rejects are scenario_pack_unavailable naming the first missing clause', () => {
  const cases: [string, (p: PackManifestContract) => void, RegExp][] = [
    ['a clause-map clause (LLM01) removed from coverage', (p) => { p.coverage.clauses = p.coverage.clauses.filter((c) => c !== 'OWASP:LLMTop10:LLM01') as typeof p.coverage.clauses; }, /coverage\.clauses omits OWASP:LLMTop10:LLM01, which the clause map entry for diplomacy_standard\.injection_followed cites; /],
    ['the 2.8.0 fixture coverage (LLM01 and LLM10 omitted)', (p) => { p.coverage.clauses = p.coverage.clauses.filter((c) => !c.startsWith('OWASP:LLMTop10:')) as typeof p.coverage.clauses; }, /coverage\.clauses omits OWASP:LLMTop10:LLM01, which the clause map entry for diplomacy_standard\.injection_followed cites \(and 1 more: OWASP:LLMTop10:LLM10\)/],
    ['a rule citing a clause outside coverage', (p) => { p.rules![0].clauses.push('OWASP:AgenticTop10:ASI09'); }, /coverage\.clauses omits OWASP:AgenticTop10:ASI09, which rule SXA-BYZ-001 cites; /],
  ];
  for (const [label, mutate, re] of cases) {
    const m = mountExample(mutate);
    assert.throws(
      () => loadPacks([m.entry], m.dir, KEYS(), placeholderBuild, 'byzantine'),
      (e: unknown) => isRefusal(/^scenario_pack_unavailable: pack sx-agentic-core: /)(e) && re.test((e as Error).message) && /signing\.md §11\.3 step 6a/.test((e as Error).message) && /Nothing was sent\./.test((e as Error).message),
      label,
    );
  }
});

test('pack loader, coverage rule: the contracts fixture pack loads as shipped (7 clauses); an extra unmapped coverage clause is allowed', () => {
  const pv = JSON.parse(readFileSync(join(CONTRACTS, 'fixtures', 'signing_vectors.json'), 'utf8')).pack_vectors[0];
  const packs = loadPacks([{ id: 'sx-agentic-core', version: '1.0.0', digest: pv.envelope_sha256 }], join(CONTRACTS, 'fixtures', 'packs'), KEYS(), placeholderBuild, 'byzantine');
  assert.equal(packs[0].manifest.coverage.clauses.length, 7);
  assert.deepEqual(packCoverageMissing(packs[0].manifest), []);
  // The reverse direction is not required: coverage may list a clause no oracle maps (ASI07 in the fixture; ASI10 here).
  const extra = mountExample((p) => { p.coverage.clauses.push('OWASP:AgenticTop10:ASI10'); });
  const loaded = loadPacks([extra.entry], extra.dir, KEYS(), placeholderBuild, 'byzantine');
  assert.equal(loaded[0].manifest.coverage.clauses.length, 8);
  assert.equal(resolveVariant('sx_deadlock_hard', loaded).base, 'deadlock');
});

test('hosted: an sx_ id without a mounted pack is scenario_pack_unavailable; with the signed pack it resolves to its base (execution awaits pack-scenario reports)', async () => {
  const spec = runSpec({ scenario_id: 'sx_deadlock_hard', seat: { mode: 'squad' } } as never);
  const dir = scratch();
  const bare = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec)), spec);
  await assert.rejects(runHosted({ ...bare, manifestKey: pubJwk(MANIFEST_KID), out: join(dir, 'out') }, { env: hostedEnv(), platform: PLATFORM }), isRefusal(/^scenario_pack_unavailable: sx_deadlock_hard is a Sixi Arena pack scenario and the run manifest mounts no pack/));
  const p = mountedPack();
  const dir2 = scratch();
  const withPack = writeInputs(join(dir2, 'in'), signManifest(unsignedManifest(spec, { packs: [p.entry] })), spec);
  await assert.rejects(
    runHosted({ ...withPack, manifestKey: pubJwk(MANIFEST_KID), out: join(dir2, 'out') }, { env: hostedEnv({ ARENA_PACKS_DIR: p.dir }), platform: PLATFORM }),
    isRefusal(/resolves to base deadlock with parameters .*from pack sx-test-core/),
  );
});

test('hosted: a mounted clause-map pack fills not_assessed with the clauses no oracle of this run covers', async () => {
  const p = mountedPack();
  const spec = runSpec({ seeds: [20260720], episodes: 1 });
  const dir = scratch();
  const inputs = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec, { packs: [p.entry] })), spec);
  const out = join(dir, 'out');
  const r = await runHosted({ ...inputs, manifestKey: pubJwk(MANIFEST_KID), out }, { env: hostedEnv({ ARENA_PACKS_DIR: p.dir }), platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, {}) });
  assert.equal(r.exitCode, 0);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
  assert.deepEqual(report.run.hosted!.packs, [p.entry]);
  const clauses = (report.not_assessed ?? []).filter((e) => e.kind === 'clause').map((e) => [e.id, e.reason_code, e.pack]);
  // ASI01 maps only to a Diplomacy oracle (not in this run); ASI08 and Art15(4) map to a byzantine oracle that was assessed.
  assert.deepEqual(clauses, [['OWASP:AgenticTop10:ASI01', 'clause_not_mapped_in_run', 'sx-test-core']]);
});

test('verify: an sx_ report exits 3 (re-simulation needs the pack)', () => {
  const dir = scratch();
  const p = join(dir, 'report.json');
  writeFileSync(p, JSON.stringify({ scenario: { scenario_id: 'sx_deadlock_hard' } }));
  assert.throws(() => verifyCommand(p), isRefusal(/^scenario_pack_unavailable: sx_deadlock_hard/));
});

/* ---- contracts 2.11.0: the pack window (signing.md §3.3 rule 3 "Packs", §11.3 step 5) ---- */
describe('pack window: a pack signature counts only with a pinned key whose window covers the run manifest\'s issued_at', () => {
  const DAY = 86_400_000;
  const OLD_KID = 'sixi-arena-manifest-ed25519-20260801';
  const now = Date.now();
  const pin = (kid: string, key: KeyObject, nb: number, na: number, revoked?: number): PinnedKey => ({ key, kid, not_before: nb, not_after: na, ...(revoked !== undefined ? { revoked_at: revoked } : {}) });
  const current = pin(MANIFEST_KID, PUB, now - 10 * DAY, now + 80 * DAY);
  const closed = pin(OLD_KID, toPublicKey(OTHER_PRIV), now - 100 * DAY, now - 3_600_000);
  /** A pack envelope carrying one signature per [key, kid], in order (1 to 4 allowed, §11.1). */
  function mountSigned(sigs: [KeyObject, string][]) {
    const dir = scratch();
    const pm = packManifest({}, sha256Of(VARIANT_PARAMS));
    const pdir = join(dir, pm.id);
    mkdirSync(join(pdir, 'variants'), { recursive: true });
    writeFileSync(join(pdir, 'variants', 'deadlock-hard.json'), VARIANT_PARAMS);
    const payload = Buffer.from(JSON.stringify(pm), 'utf8');
    const env = `${JSON.stringify({ payloadType: PACK_PAYLOAD_TYPE, payload: payload.toString('base64'), signatures: sigs.map(([k, kid]) => ({ keyid: kid, sig: edSign(null, pae(PACK_PAYLOAD_TYPE, payload), k).toString('base64') })) })}\n`;
    writeFileSync(join(pdir, PACK_ENVELOPE_FILE), env);
    return { dir, entry: { id: pm.id, version: pm.version, digest: sha256Of(env) } };
  }

  test('inside the window: loads; not_after is exclusive; revoked_at ends the window; a missing issued_at is outside every window', () => {
    const p = mountSigned([[PRIV, MANIFEST_KID]]);
    assert.equal(loadPacks([p.entry], p.dir, [current], build, 'byzantine', now - 60_000).length, 1);
    const w = pin(MANIFEST_KID, PUB, now - 10 * DAY, now);
    assert.equal(loadPacks([p.entry], p.dir, [w], build, 'byzantine', now - 1000).length, 1);
    assert.throws(() => loadPacks([p.entry], p.dir, [w], build, 'byzantine', now), isRefusal(/no signature is by a pinned control-plane key whose window covers the run manifest's issued_at \(sixi-arena-manifest-ed25519-20261101: signed at .*Z, at or after the key's not_after .*Z\)/));
    assert.throws(() => loadPacks([p.entry], p.dir, [pin(MANIFEST_KID, PUB, now - DAY, now + DAY, now - 3_600_000)], build, 'byzantine', now - 60_000), isRefusal(/at or after the key's revoked_at/));
    assert.throws(() => loadPacks([p.entry], p.dir, [current], build, 'byzantine'), isRefusal(/window covers the run manifest's issued_at .*the signing time is missing/));
  });

  test('rotation: a pack signed only by a key whose window has closed is refused; with the successor\'s signature added (up to 4) it loads; 5 signatures are refused', () => {
    const old = mountSigned([[OTHER_PRIV, OLD_KID]]);
    assert.throws(() => loadPacks([old.entry], old.dir, [current, closed], build, 'byzantine', now - 60_000), isRefusal(/^scenario_pack_unavailable: pack sx-test-core: no signature is by a pinned control-plane key whose window covers/));
    const both = mountSigned([[OTHER_PRIV, OLD_KID], [PRIV, MANIFEST_KID]]);
    assert.equal(loadPacks([both.entry], both.dir, [current, closed], build, 'byzantine', now - 60_000).length, 1);
    const four = mountSigned([[OTHER_PRIV, OLD_KID], [OTHER_PRIV, OLD_KID], [OTHER_PRIV, OLD_KID], [PRIV, MANIFEST_KID]]);
    assert.equal(loadPacks([four.entry], four.dir, [current, closed], build, 'byzantine', now - 60_000).length, 1);
    const five = mountSigned([[OTHER_PRIV, OLD_KID], [OTHER_PRIV, OLD_KID], [OTHER_PRIV, OLD_KID], [OTHER_PRIV, OLD_KID], [PRIV, MANIFEST_KID]]);
    assert.throws(() => loadPacks([five.entry], five.dir, [current, closed], build, 'byzantine', now - 60_000), isRefusal(/with 1 to 4 signatures/));
  });

  test('run --hosted applies it at the verified manifest\'s issued_at, before any I/O', async () => {
    const spec = runSpec({ seeds: [20260720], episodes: 1 });
    const old = mountSigned([[OTHER_PRIV, OLD_KID]]);
    const dir = scratch();
    const inputs = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec, { packs: [old.entry] })), spec);
    await assert.rejects(
      runHosted({ ...inputs, out: join(dir, 'out') }, { pinnedKeys: [current, closed], env: hostedEnv({ ARENA_PACKS_DIR: old.dir }), platform: PLATFORM }),
      isRefusal(/^scenario_pack_unavailable: pack sx-test-core: no signature is by a pinned control-plane key whose window covers the run manifest's issued_at \(sixi-arena-manifest-ed25519-20260801: signed at .*, at or after the key's not_after/),
    );
    const both = mountSigned([[OTHER_PRIV, OLD_KID], [PRIV, MANIFEST_KID]]);
    const dir2 = scratch();
    const inputs2 = writeInputs(join(dir2, 'in'), signManifest(unsignedManifest(spec, { packs: [both.entry] })), spec);
    const r = await runHosted({ ...inputs2, out: join(dir2, 'out') }, { pinnedKeys: [current, closed], env: hostedEnv({ ARENA_PACKS_DIR: both.dir }), platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, {}) });
    assert.equal(r.exitCode, 0);
  });
});
