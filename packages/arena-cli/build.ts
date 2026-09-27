/**
 * `npm run build:cli`: one self-contained CJS bundle for npm and for the Node
 * SEA step in .github-public/workflows/release.yml (EXTRACTION.md §8/§9):
 *
 *   packages/arena-cli/dist/agent-arena.cjs   (#!/usr/bin/env node, node22, cjs)
 *   packages/arena-cli/dist/meta.json         (esbuild metafile → licenses)
 *
 * No runtime dependencies and no `contracts/` on disk at runtime: workspace
 * modules that locate files with `fileURLToPath(import.meta.url)` (the schema
 * loaders in arena-scenarios and arena-report) are rewritten to a virtual
 * path, and their `node:fs` reads are served from an inlined snapshot of
 * contracts/schemas/*.json and the vendored SARIF schema.
 *
 * The engine build hash: the per-file source manifest of the workspace
 * (arena-report `engineSourceManifest`, hashes only, never sources) is embedded
 * as `__ARENA_ENGINE_SOURCES__`; at run time arena-report's `engineBuildDigest`
 * derives the scoped hash from it, exactly as the dev path derives it from the
 * workspace files (test/build-digest.test.ts asserts the two agree).
 */

import { build, type Plugin } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENGINE_BUILD_SCOPES, engineBuildDigestOf, engineSourceManifest, findEngineWorkspaceRoot, type EngineSourceManifest } from 'arena-report';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (() => {
  const r = findEngineWorkspaceRoot(HERE);
  if (!r) throw new Error(`the ascension workspace (packages/wot-engine, packages/arena-scenarios) was not found above ${HERE}`);
  return r;
})();
const OUT_DIR = join(HERE, 'dist');
const VFS = '/__arena_vfs__';

function findContracts(start: string): string {
  if (process.env.WOT_CONTRACTS_DIR) return process.env.WOT_CONTRACTS_DIR;
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, 'contracts', 'schemas'))) return join(d, 'contracts');
    if (dirname(d) === d) throw new Error('contracts/ not found');
  }
}

/** Files served from the virtual fs: `${VFS}/<posix path>` → contents. */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const contracts = findContracts(ROOT);
  for (const f of readdirSync(join(contracts, 'schemas'))) {
    if (f.endsWith('.json')) files[`${VFS}/contracts/schemas/${f}`] = readFileSync(join(contracts, 'schemas', f), 'utf8');
  }
  // arena-report/evidence.ts reads the contract version from contracts/CHANGELOG.md next to schemas/.
  if (existsSync(join(contracts, 'CHANGELOG.md'))) files[`${VFS}/contracts/CHANGELOG.md`] = readFileSync(join(contracts, 'CHANGELOG.md'), 'utf8');
  const sarifDir = join(ROOT, 'packages', 'arena-report', 'src', 'schema');
  if (existsSync(sarifDir)) {
    for (const f of readdirSync(sarifDir)) if (f.endsWith('.json')) files[`${VFS}/packages/arena-report/src/schema/${f}`] = readFileSync(join(sarifDir, f), 'utf8');
  }
  return files;
}

const META_URL = /fileURLToPath\(\s*import\.meta\.url\s*\)/g;

function vfsPlugin(files: Record<string, string>): Plugin {
  const rewritten: string[] = [];
  return {
    name: 'arena-vfs',
    setup(b) {
      b.onResolve({ filter: /^arena-vfs:fs$/ }, () => ({ path: 'arena-vfs-fs', namespace: 'arena-vfs' }));
      b.onLoad({ filter: /.*/, namespace: 'arena-vfs' }, () => ({
        loader: 'js',
        resolveDir: HERE,
        contents: `
const real = require('node:fs');
const FILES = ${JSON.stringify(files)};
const DIRS = new Set();
for (const p of Object.keys(FILES)) { let d = p; while ((d = d.slice(0, d.lastIndexOf('/'))) && d.length) DIRS.add(d); }
const norm = (p) => String(p).replace(/\\\\/g, '/').replace(/^[A-Za-z]:/, '');
const virtual = (p) => norm(p).startsWith(${JSON.stringify(VFS)});
function existsSync(p) { return virtual(p) ? (norm(p) in FILES || DIRS.has(norm(p))) : real.existsSync(p); }
function readFileSync(p, enc) {
  if (!virtual(p)) return real.readFileSync(p, enc);
  const k = norm(p);
  if (!(k in FILES)) { const e = new Error('ENOENT: ' + k); e.code = 'ENOENT'; throw e; }
  return enc ? FILES[k] : Buffer.from(FILES[k], 'utf8');
}
module.exports = { ...real, existsSync, readFileSync };
`,
      }));
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        const src = readFileSync(args.path, 'utf8');
        const FS_IMPORT = /from\s+['"](?:node:)?fs['"]/g;
        if (!src.includes('import.meta')) {
          // A workspace module that reads files through a path computed by another module
          // (e.g. arena-report/evidence.ts joins schemas.ts's SCHEMAS_DIR) still needs the
          // virtual fs; the shim falls through to the real fs for every non-virtual path.
          if (!FS_IMPORT.test(src)) return undefined;
          rewritten.push(relative(ROOT, args.path).split(sep).join('/'));
          return { contents: src.replace(FS_IMPORT, "from 'arena-vfs:fs'"), loader: 'ts' };
        }
        const rel = relative(ROOT, args.path).split(sep).join('/');
        let out = src.replace(META_URL, JSON.stringify(`${VFS}/${rel}`));
        if (/import\.meta/.test(out.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
          // arena-cli's own dev-only paths (build-info) are dead code in the bundle (guarded by define).
          if (!args.path.startsWith(HERE + sep)) throw new Error(`${rel}: unsupported import.meta use for the bundle`);
        }
        out = out.replace(/from\s+['"]node:fs['"]/g, "from 'arena-vfs:fs'").replace(/from\s+['"]fs['"]/g, "from 'arena-vfs:fs'");
        rewritten.push(rel);
        return { contents: out, loader: 'ts' };
      });
      b.onEnd(() => {
        if (process.env.ARENA_BUILD_VERBOSE) console.log(`arena-vfs: rewrote ${rewritten.join(', ')}`);
      });
    },
  };
}

/** The esbuild `define` map of the bundle: the embedded engine source manifest and the bundled flag. */
export function bundleDefines(manifest: EngineSourceManifest = engineSourceManifest(ROOT)): Record<string, string> {
  return { __ARENA_ENGINE_SOURCES__: JSON.stringify(manifest), __ARENA_BUNDLED__: 'true' };
}

export interface BundleResult {
  outfile: string;
  bytes: number;
  manifest: EngineSourceManifest;
}

/** Build the self-contained bundle to `outfile` (default dist/agent-arena.cjs; tests build to a temp path). */
export async function bundle(outfile: string = join(OUT_DIR, 'agent-arena.cjs'), o: { metafile?: string } = {}): Promise<BundleResult> {
  mkdirSync(dirname(outfile), { recursive: true });
  const manifest = engineSourceManifest(ROOT);
  const result = await build({
    entryPoints: [join(HERE, 'src', 'bin.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    define: bundleDefines(manifest),
    external: ['bufferutil', 'utf-8-validate'],
    metafile: true,
    absWorkingDir: ROOT,
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'warning',
    plugins: [vfsPlugin(snapshot())],
  });
  if (o.metafile) writeFileSync(o.metafile, JSON.stringify(result.metafile));
  return { outfile, bytes: readFileSync(outfile).byteLength, manifest };
}

async function main(): Promise<void> {
  const r = await bundle(join(OUT_DIR, 'agent-arena.cjs'), { metafile: join(OUT_DIR, 'meta.json') });
  const scopes = ENGINE_BUILD_SCOPES.map((s) => `${s} ${engineBuildDigestOf(r.manifest, s).digest}`).join(', ');
  console.log(`built dist/agent-arena.cjs (${(r.bytes / 1024).toFixed(0)} KiB); embedded ${r.manifest.files.length} engine source hashes; engine builds: ${scopes}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
