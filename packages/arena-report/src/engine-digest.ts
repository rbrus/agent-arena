/**
 * `engine.build_hash`: a content hash of the source files that decide an
 * episode, SCOPED so that a Diplomacy commit does not change the build hash
 * of a non-Diplomacy report (PLAN.md progress log, B1 and B4b follow-ups).
 *
 * File set (workspace-relative, POSIX separators, `*.ts|*.mts|*.js|*.mjs|*.json`,
 * never `*.test.*`):
 *   packages/wot-engine/src/**, packages/arena-scenarios/src/**,
 *   agents/house-bot/**, agents/reflex/**   (the reference policies)
 *
 * Scopes:
 *   core       every file above EXCEPT any `src/diplomacy/**` subtree.
 *              Every non-Diplomacy scenario records this scope.
 *   diplomacy  core + `src/diplomacy/**`, without its conformance fixtures and
 *              test hooks (`src/diplomacy/datc/**`, `src/diplomacy/testing/**`),
 *              which no episode executes. diplomacy_standard records this scope.
 *   all        every file above (release pinning, cross-checks).
 *
 * Digest (reproducible with coreutils):
 *   line(f) = hex(sha256(bytes(f))) + "  " + path(f) + "\n"          (sha256sum format)
 *   D       = sha256( "agent-arena engine-build v1 scope=" + scope + "\n" + line(f1) + … )
 *   engine.build_hash = "sha256:" + hex(D),  files sorted by path in UTF-16 code-unit order
 *
 * Scope `core`, from ascension/ (drop the `grep -v` and say `scope=all` for `all`):
 *   { printf 'agent-arena engine-build v1 scope=core\n'; find packages/wot-engine/src packages/arena-scenarios/src \
 *       agents/house-bot agents/reflex -type f \( -name '*.ts' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' \
 *       -o -name '*.json' \) ! -name '*.test.*' | grep -v /src/diplomacy/ | LC_ALL=C sort | xargs sha256sum; } | sha256sum
 *
 * `engine.source_manifest_digest` = "sha256:" + hex(sha256(JCS(manifest))), the
 * manifest being the scope-`all` `agent-arena/engine-sources@1` document below
 * (`engineSourceManifestDigest`).
 *
 * Sources, in order: an explicit `manifest`, an explicit `root`, the manifest
 * embedded at bundle time (`__ARENA_ENGINE_SOURCES__`, an
 * `EngineSourceManifest` injected by the CLI's esbuild `define`), the
 * workspace found by walking up from this file. Only per-file hashes are
 * embedded, never the sources.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EngineBuildScope = 'core' | 'diplomacy' | 'all';
export const ENGINE_BUILD_SCOPES: readonly EngineBuildScope[] = ['core', 'diplomacy', 'all'];

/** The roots hashed, relative to the ascension workspace. */
export const ENGINE_SOURCE_ROOTS: readonly string[] = ['packages/wot-engine/src', 'packages/arena-scenarios/src', 'agents/house-bot', 'agents/reflex'];

export const ENGINE_SOURCE_MANIFEST_FORMAT = 'agent-arena/engine-sources@1';

/** What a bundle embeds: per-file content hashes of every source file under the roots (scope `all`). */
export interface EngineSourceManifest {
  format: typeof ENGINE_SOURCE_MANIFEST_FORMAT;
  /** Sorted by `path` (UTF-16 code-unit order), unique. */
  files: { path: string; sha256: string }[];
}

export interface EngineBuildDigest {
  /** `sha256:<64 hex>`: the value for `engine.build_hash`. */
  digest: string;
  scope: EngineBuildScope;
  /** Files hashed under this scope. */
  files: number;
  source: 'manifest' | 'workspace';
  /** `engine.source_manifest_digest` (contracts 2.3.0) of the manifest the digest was derived from. */
  manifestDigest: string;
}

export interface EngineBuildDigestOptions {
  scope: EngineBuildScope;
  /** Use this manifest (e.g. one read from a release asset). */
  manifest?: EngineSourceManifest;
  /** Hash this workspace (the directory holding packages/ and agents/). */
  root?: string;
}

declare const __ARENA_ENGINE_SOURCES__: EngineSourceManifest | undefined;

const EXT = /\.(ts|mts|js|mjs|json)$/;
const TEST = /\.test\.[a-z]+$/;
const PATH_RE = /^[A-Za-z0-9_@.-]+(\/[A-Za-z0-9_@.-]+)*$/;
const DIPLOMACY_TREE = /(^|\/)src\/diplomacy\//;
const DIPLOMACY_NOT_EXECUTED = /(^|\/)src\/diplomacy\/(datc|testing)\//;

/** The scope a scenario's reports record. */
export function engineBuildScopeFor(scenarioId: string): EngineBuildScope {
  return scenarioId === 'diplomacy_standard' ? 'diplomacy' : 'core';
}

/**
 * The scopes a Report of `scenarioId` may record in `engine.build_scope`
 * (contracts 2.3.0, contract-check `build_scope` linkage): the scenario's own
 * scope, or `all` (a release pin; `verify` then recomputes over every file).
 */
export function allowedEngineBuildScopes(scenarioId: string): readonly EngineBuildScope[] {
  return [engineBuildScopeFor(scenarioId), 'all'];
}

export function inScope(path: string, scope: EngineBuildScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'core') return !DIPLOMACY_TREE.test(path);
  return !DIPLOMACY_NOT_EXECUTED.test(path);
}

/** The ascension workspace root (holds packages/wot-engine and packages/arena-scenarios), walking up from `start`. */
export function findEngineWorkspaceRoot(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'packages', 'wot-engine', 'src')) && existsSync(join(dir, 'packages', 'arena-scenarios', 'src'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(join(root, r));
    if (st.isDirectory()) walk(root, r, out);
    else if (st.isFile() && EXT.test(name) && !TEST.test(name)) out.push(r.split(sep).join('/'));
  }
}

/** Build the manifest of a workspace (the CLI's build step embeds this). */
export function engineSourceManifest(root: string): EngineSourceManifest {
  const paths: string[] = [];
  for (const r of ENGINE_SOURCE_ROOTS) {
    if (!existsSync(join(root, r))) throw new Error(`engine source root ${r} not found under ${root}`);
    walk(root, r, paths);
  }
  paths.sort();
  return {
    format: ENGINE_SOURCE_MANIFEST_FORMAT,
    files: paths.map((p) => ({ path: p, sha256: createHash('sha256').update(readFileSync(join(root, p))).digest('hex') })),
  };
}

export function assertEngineSourceManifest(m: unknown): asserts m is EngineSourceManifest {
  const bad = (why: string): never => {
    throw new Error(`invalid engine source manifest: ${why}`);
  };
  if (typeof m !== 'object' || m === null) bad('not an object');
  const x = m as Partial<EngineSourceManifest>;
  if (x.format !== ENGINE_SOURCE_MANIFEST_FORMAT) bad(`format is not ${ENGINE_SOURCE_MANIFEST_FORMAT}`);
  if (!Array.isArray(x.files) || x.files.length === 0) bad('no files');
  let prev = '';
  for (const f of x.files!) {
    if (typeof f?.path !== 'string' || !PATH_RE.test(f.path) || f.path.split('/').includes('..')) bad(`bad path ${String(f?.path).slice(0, 80)}`);
    if (!ENGINE_SOURCE_ROOTS.some((r) => f.path.startsWith(`${r}/`))) bad(`${f.path} is outside the engine source roots`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) bad(`bad sha256 for ${f.path}`);
    if (f.path <= prev) bad('files are not sorted and unique');
    prev = f.path;
  }
}

/** The scoped digest of a manifest. */
export function engineBuildDigestOf(manifest: EngineSourceManifest, scope: EngineBuildScope): { digest: string; files: number } {
  assertEngineSourceManifest(manifest);
  if (!ENGINE_BUILD_SCOPES.includes(scope)) throw new Error(`unknown engine build scope ${String(scope)}`);
  const h = createHash('sha256');
  h.update(`agent-arena engine-build v1 scope=${scope}\n`);
  let n = 0;
  for (const f of manifest.files) {
    if (!inScope(f.path, scope)) continue;
    h.update(`${f.sha256}  ${f.path}\n`);
    n++;
  }
  return { digest: `sha256:${h.digest('hex')}`, files: n };
}

/**
 * `engine.source_manifest_digest` (report.schema.json, contracts 2.3.0):
 * "sha256:" + hex(sha256(JCS(M))) over the whole manifest (scope `all`, the
 * form the bundle embeds). It names the manifest; the manifest itself is never
 * put into a Report.
 */
export function engineSourceManifestDigest(manifest: EngineSourceManifest): string {
  assertEngineSourceManifest(manifest);
  const m: EngineSourceManifest = { format: manifest.format, files: manifest.files.map((f) => ({ path: f.path, sha256: f.sha256 })) };
  return `sha256:${createHash('sha256').update(canonicalize(m), 'utf8').digest('hex')}`;
}

function embedded(): EngineSourceManifest | undefined {
  return typeof __ARENA_ENGINE_SOURCES__ === 'undefined' ? undefined : __ARENA_ENGINE_SOURCES__;
}

/** `engine.build_hash` for a scope, from a manifest, a workspace, the bundle's embedded manifest, or the enclosing workspace. */
export function engineBuildDigest(opts: EngineBuildDigestOptions): EngineBuildDigest {
  const { scope } = opts;
  let manifest = opts.manifest;
  let source: EngineBuildDigest['source'] = 'manifest';
  if (!manifest && opts.root) {
    manifest = engineSourceManifest(resolve(opts.root));
    source = 'workspace';
  }
  if (!manifest) manifest = embedded();
  if (!manifest) {
    const root = findEngineWorkspaceRoot();
    if (!root) throw new Error('no engine sources: not bundled (no embedded manifest) and no workspace above this module');
    manifest = engineSourceManifest(root);
    source = 'workspace';
  }
  const { digest, files } = engineBuildDigestOf(manifest, scope);
  return { digest, scope, files, source, manifestDigest: engineSourceManifestDigest(manifest) };
}

