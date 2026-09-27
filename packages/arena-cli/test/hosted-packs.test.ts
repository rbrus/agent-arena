/**
 * Scenario packs (contracts 2.2.0 K5/K9; HOSTED-PROFILE §5): the open CLI
 * refuses every `sx_` id before any I/O; the hosted runner loads only packs the
 * signed manifest lists, mounted under ARENA_PACKS_DIR, signed with the pinned
 * control-plane key and valid for the running engine build. A variant resolves
 * to base scenario + parameters. A mounted clause-map pack feeds the report's
 * not-assessed clause list.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Report } from 'arena-report';
import { engineBuildFor } from '../src/build-info.ts';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { loadPacks, packCoverageMissing, parseVariantParams, resolveVariant } from '../src/hosted/packs.ts';
import type { PackManifestContract } from '../src/generated/contracts.ts';
import { contractsDir } from 'wot-contracts/contracts-dir';
import { loadPublicKeySet } from '../src/keys.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { hostedEnv, MANIFEST_KID, OTHER_PRIV, packManifest, PLATFORM, pubJwk, runSpec, sha256Of, signManifest, unsignedManifest, VARIANT_PARAMS, viaReference, writeInputs, writePack, runHosted } from './hosted-fixtures.ts';
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
