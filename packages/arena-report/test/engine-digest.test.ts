/**
 * Scoped engine build digest (engine-digest.ts): Diplomacy edits must not
 * change the `core` digest that every non-Diplomacy report records, and the
 * bundle's embedded manifest must give the same digest as the workspace.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  ENGINE_SOURCE_MANIFEST_FORMAT,
  assertEngineSourceManifest,
  buildReport,
  engineBuildDigest,
  engineBuildDigestOf,
  engineBuildScopeFor,
  allowedEngineBuildScopes,
  engineSourceManifest,
  engineSourceManifestDigest,
  findEngineWorkspaceRoot,
  type EngineSourceManifest,
} from '../src/index.ts';
import { DUEL_SPEC, input, runEpisodes } from './helpers.ts';

function fakeWorkspace(): { root: string; write: (p: string, body: string) => void; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'engine-digest-'));
  const write = (p: string, body: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };
  write('packages/wot-engine/src/index.ts', 'export * from "./rng.ts";\n');
  write('packages/wot-engine/src/rng.ts', 'export const x = 1;\n');
  write('packages/wot-engine/src/diplomacy/resolve.ts', 'export const d = 1;\n');
  write('packages/wot-engine/src/diplomacy/datc/fixtures/6A.json', '{"cases":[]}\n');
  write('packages/wot-engine/src/diplomacy/testing/leak-hooks.ts', 'export const h = 1;\n');
  write('packages/arena-scenarios/src/index.ts', 'export const s = 1;\n');
  write('agents/house-bot/policy.ts', 'export const p = 1;\n');
  write('agents/reflex/policy.ts', 'export const r = 1;\n');
  return { root, write, done: () => rmSync(root, { recursive: true, force: true }) };
}

const digests = (root: string) => ({
  core: engineBuildDigest({ scope: 'core', root }).digest,
  diplomacy: engineBuildDigest({ scope: 'diplomacy', root }).digest,
  all: engineBuildDigest({ scope: 'all', root }).digest,
});

test('scopes: a Diplomacy edit changes diplomacy and all, never core; a core edit changes all three', () => {
  const w = fakeWorkspace();
  try {
    const d0 = digests(w.root);
    assert.equal(new Set(Object.values(d0)).size, 3, 'scopes are domain-separated even over overlapping files');
    w.write('packages/wot-engine/src/diplomacy/resolve.ts', 'export const d = 2;\n');
    const d1 = digests(w.root);
    assert.equal(d1.core, d0.core, 'a Diplomacy commit must not invalidate non-Diplomacy goldens');
    assert.notEqual(d1.diplomacy, d0.diplomacy);
    assert.notEqual(d1.all, d0.all);
    w.write('packages/wot-engine/src/diplomacy/reference/new-agent.ts', 'export const n = 1;\n');
    assert.equal(digests(w.root).core, d0.core, 'a new Diplomacy file does not change core either');
    w.write('packages/arena-scenarios/src/diplomacy/adapter.ts', 'export const a = 1;\n');
    assert.equal(digests(w.root).core, d0.core, 'any src/diplomacy subtree is outside core');
    const d2 = digests(w.root);
    w.write('packages/wot-engine/src/rng.ts', 'export const x = 2;\n');
    const d3 = digests(w.root);
    assert.notEqual(d3.core, d2.core);
    assert.notEqual(d3.diplomacy, d2.diplomacy);
    assert.notEqual(d3.all, d2.all);
    w.write('agents/reflex/policy.ts', 'export const r = 2;\n');
    assert.notEqual(digests(w.root).core, d3.core, 'the reference policies are part of core');
  } finally {
    w.done();
  }
});

test('scopes: DATC fixtures and test hooks are outside diplomacy (no episode runs them) but inside all; tests, docs and dotfiles are never hashed', () => {
  const w = fakeWorkspace();
  try {
    const d0 = digests(w.root);
    w.write('packages/wot-engine/src/diplomacy/datc/fixtures/6A.json', '{"cases":[1]}\n');
    w.write('packages/wot-engine/src/diplomacy/testing/leak-hooks.ts', 'export const h = 2;\n');
    const d1 = digests(w.root);
    assert.equal(d1.core, d0.core);
    assert.equal(d1.diplomacy, d0.diplomacy);
    assert.notEqual(d1.all, d0.all);
    w.write('packages/wot-engine/src/rng.test.ts', 'test\n');
    w.write('packages/wot-engine/src/README.md', '# docs\n');
    w.write('packages/wot-engine/src/.cache/x.ts', 'x\n');
    w.write('packages/wot-engine/src/node_modules/y.ts', 'y\n');
    w.write('packages/wot-engine/test/rng.test.ts', 'z\n');
    assert.deepEqual(digests(w.root), d1);
  } finally {
    w.done();
  }
});

test('digest format: reproducible with coreutils (sha256sum lines, C-locale sort, scope header)', () => {
  const w = fakeWorkspace();
  try {
    const m = engineSourceManifest(w.root);
    const lines = m.files.filter((f) => !f.path.includes('/src/diplomacy/')).map((f) => `${createHash('sha256').update(execFileSync('cat', [join(w.root, f.path)])).digest('hex')}  ${f.path}\n`);
    const want = `sha256:${createHash('sha256').update(`agent-arena engine-build v1 scope=core\n${lines.join('')}`).digest('hex')}`;
    assert.equal(engineBuildDigest({ scope: 'core', root: w.root }).digest, want);
    const sh = execFileSync(
      'sh',
      ['-c', `cd "$1" && { printf 'agent-arena engine-build v1 scope=core\\n'; find packages/wot-engine/src packages/arena-scenarios/src agents/house-bot agents/reflex -type f \\( -name '*.ts' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' -o -name '*.json' \\) ! -name '*.test.*' | grep -v /src/diplomacy/ | LC_ALL=C sort | xargs sha256sum; } | sha256sum`, 'sh', w.root],
      { encoding: 'utf8' },
    );
    assert.equal(`sha256:${sh.split(' ')[0]}`, want, 'the documented shell command reproduces the digest');
  } finally {
    w.done();
  }
});

test('embedded manifest: the manifest the CLI embeds gives the same digest as the workspace, per scope', () => {
  const root = findEngineWorkspaceRoot();
  assert.ok(root, 'the test runs inside the workspace');
  const manifest = JSON.parse(JSON.stringify(engineSourceManifest(root))) as EngineSourceManifest;
  for (const scope of ['core', 'diplomacy', 'all'] as const) {
    const fromWorkspace = engineBuildDigest({ scope });
    const fromManifest = engineBuildDigest({ scope, manifest });
    assert.equal(fromWorkspace.source, 'workspace');
    assert.equal(fromManifest.source, 'manifest');
    assert.equal(fromManifest.digest, fromWorkspace.digest, scope);
    assert.equal(fromManifest.files, fromWorkspace.files);
  }
  assert.ok(manifest.files.some((f) => f.path.startsWith('packages/wot-engine/src/diplomacy/')), 'the manifest holds every scope; filtering happens at digest time');
  assert.ok(!JSON.stringify(manifest).includes('export '), 'only hashes are embedded, never sources');
});

test('manifest validation: format, sorting, uniqueness, paths inside the roots, hex hashes', () => {
  const ok: EngineSourceManifest = { format: ENGINE_SOURCE_MANIFEST_FORMAT, files: [{ path: 'agents/reflex/policy.ts', sha256: 'a'.repeat(64) }, { path: 'packages/wot-engine/src/a.ts', sha256: 'b'.repeat(64) }] };
  assertEngineSourceManifest(ok);
  const bad: [string, unknown][] = [
    ['format', { ...ok, format: 'other@1' }],
    ['empty', { ...ok, files: [] }],
    ['unsorted', { ...ok, files: [...ok.files].reverse() }],
    ['duplicate', { ...ok, files: [ok.files[0], ok.files[0]] }],
    ['traversal', { ...ok, files: [{ path: 'packages/wot-engine/src/../../../etc/passwd', sha256: 'a'.repeat(64) }] }],
    ['outside roots', { ...ok, files: [{ path: 'packages/arena-cli/src/main.ts', sha256: 'a'.repeat(64) }] }],
    ['hash', { ...ok, files: [{ path: 'agents/reflex/policy.ts', sha256: 'A'.repeat(64) }] }],
  ];
  for (const [name, m] of bad) assert.throws(() => assertEngineSourceManifest(m), /invalid engine source manifest/, name);
  assert.throws(() => engineBuildDigestOf(ok, 'everything' as never), /unknown engine build scope/);
});

test('reports: non-Diplomacy scenarios record the core scope (or all); buildReport writes engine.build_scope and refuses a mis-scoped build hash', () => {
  for (const id of ['grid_tactics', 'hallucinator', 'overfit', 'byzantine', 'deadlock', 'split_brain', 'latency']) {
    assert.equal(engineBuildScopeFor(id), 'core');
    assert.deepEqual(allowedEngineBuildScopes(id), ['core', 'all']);
  }
  assert.equal(engineBuildScopeFor('diplomacy_standard'), 'diplomacy');
  assert.deepEqual(allowedEngineBuildScopes('diplomacy_standard'), ['diplomacy', 'all']);
  const core = engineBuildDigest({ scope: 'core' }).digest;
  const eps = runEpisodes(DUEL_SPEC, 'ref:reflex');
  const r = buildReport(input(DUEL_SPEC, eps, { engineBuild: core, engineBuildScope: 'core' }));
  assert.equal(r.engine.build_hash, core);
  assert.equal(r.engine.build_scope, 'core');
  assert.deepEqual(Object.keys(r.engine), ['build_hash', 'build_scope', 'version'], 'report.schema.json examples[0] member order');
  // contract-check build_scope linkage: the scenario's scope or `all`.
  const all = buildReport(input(DUEL_SPEC, eps, { engineBuild: engineBuildDigest({ scope: 'all' }).digest, engineBuildScope: 'all' }));
  assert.equal(all.engine.build_scope, 'all');
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { engineBuild: engineBuildDigest({ scope: 'diplomacy' }).digest, engineBuildScope: 'diplomacy' })), /grid_tactics reports record scope core or all/);
  // No scope given: nothing is recorded (a 2.2.0-shaped engine block; readers assume the scenario's scope).
  assert.equal(buildReport(input(DUEL_SPEC, eps, { engineBuild: core })).engine.build_scope, undefined);
});

test('source_manifest_digest: sha256 over JCS of the manifest; recorded by buildReport, bound to the build hash under the recorded scope', () => {
  const w = fakeWorkspace();
  try {
    const m = engineSourceManifest(w.root);
    const jcs = `{"files":[${m.files.map((f) => `{"path":${JSON.stringify(f.path)},"sha256":"${f.sha256}"}`).join(',')}],"format":"${ENGINE_SOURCE_MANIFEST_FORMAT}"}`;
    const want = `sha256:${createHash('sha256').update(jcs, 'utf8').digest('hex')}`;
    assert.equal(engineSourceManifestDigest(m), want, 'RFC 8785 over {format, files[{path, sha256}]}');
    assert.equal(engineBuildDigest({ scope: 'core', root: w.root }).manifestDigest, want);
    assert.equal(engineBuildDigest({ scope: 'all', manifest: m }).manifestDigest, want, 'one manifest digest for every scope');
    w.write('packages/wot-engine/src/diplomacy/resolve.ts', 'export const d = 3;\n');
    assert.notEqual(engineSourceManifestDigest(engineSourceManifest(w.root)), want, 'the manifest covers scope all: a Diplomacy edit changes it');
    assert.throws(() => engineSourceManifestDigest({ ...m, files: [] }), /invalid engine source manifest/);
  } finally {
    w.done();
  }

  const root = findEngineWorkspaceRoot()!;
  const manifest = engineSourceManifest(root);
  const eps = runEpisodes(DUEL_SPEC, 'ref:reflex');
  const d = engineBuildDigest({ scope: 'core', manifest });
  const r = buildReport(input(DUEL_SPEC, eps, { engineBuild: d.digest, engineBuildScope: 'core', engineSourceManifest: manifest }));
  assert.equal(r.engine.source_manifest_digest, engineSourceManifestDigest(manifest));
  assert.deepEqual(Object.keys(r.engine), ['build_hash', 'build_scope', 'source_manifest_digest', 'version']);
  assert.ok(!JSON.stringify(r).includes(manifest.files[0].path), 'the manifest itself is never embedded');
  // The digest alone (verify's rebuild, EngineBuildDigest.manifestDigest) is recorded as given.
  assert.equal(buildReport(input(DUEL_SPEC, eps, { engineBuild: d.digest, engineBuildScope: 'core', engineSourceManifestDigest: d.manifestDigest })).engine.source_manifest_digest, d.manifestDigest);
  // Inconsistent inputs are refused.
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { engineBuild: engineBuildDigest({ scope: 'all', manifest }).digest, engineBuildScope: 'core', engineSourceManifest: manifest })), /is not the scope-core digest of the given source manifest/);
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { engineBuild: d.digest, engineBuildScope: 'core', engineSourceManifest: manifest, engineSourceManifestDigest: `sha256:${'0'.repeat(64)}` })), /is not the digest of the given manifest/);
  assert.throws(() => buildReport(input(DUEL_SPEC, eps, { engineBuild: d.digest, engineSourceManifestDigest: 'f'.repeat(64) })), /engineSourceManifestDigest must be sha256/);
});
