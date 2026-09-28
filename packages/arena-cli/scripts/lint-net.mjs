#!/usr/bin/env node
// lint:net — the single-guarded-network-layer rule (PLAN B1 hard requirement,
// threat model §9.1 "Repo-wide lint"). Two checks:
//
//  1. SOURCE: fails if any file under src/ OUTSIDE src/net/ references a
//     network or process primitive: fetch, http/https/http2/net/tls/dgram/dns,
//     ws, undici, child_process, worker_threads, inspector, cluster, module;
//     WebSocket / WebSocketStream / EventSource / XMLHttpRequest; a dynamic
//     import/require of one (or with a computed specifier); `createRequire`,
//     `process.getBuiltinModule`, `process.binding`/`internalBinding`/`dlopen`;
//     computed member access on `globalThis`/`process` (`globalThis['fe'+'tch']`);
//     `process`/`globalThis` used as a value (aliasing, `Reflect.get(process, k)`,
//     `Object.getOwnPropertyDescriptor(process, k)`: G-32); `eval` / `Function(...)`. Rules run over the whole file, so a `from`
//     clause on its own line is still caught. Comments are stripped first so
//     prose does not trip it; module specifiers inside strings are still checked.
//
//  2. BUNDLE (G-21): bundles src/bin.ts in memory with esbuild (the same entry
//     as build.ts) and inspects the metafile: every bundled npm package must be
//     on BUNDLE_ALLOWLIST; only src/net/ and the `ws` package may import a
//     network/process builtin or `ws`; every bundled workspace source
//     (arena-scenarios, arena-report, wot-engine, agents/*) passes the source
//     rules with no exemption; allowlisted npm packages other than `ws` are
//     scanned for getBuiltinModule / process.binding / require of a network module.
//
// Usage: node scripts/lint-net.mjs            (src/ + bundle; exit 0 clean, 1 violations)
//        node scripts/lint-net.mjs <root>     (source rules over <root> only; relative or absolute)
//        node scripts/lint-net.mjs <root> --bundle

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(PKG, '..', '..');

export const MODULES = [
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises', 'ws', 'undici', 'node-fetch', 'axios', 'got', 'eventsource', '@modelcontextprotocol/sdk',
  'child_process', 'worker_threads', 'inspector', 'inspector/promises', 'cluster', 'module',
];
const modAlt = MODULES.map((m) => m.replace(/[/.]/g, '\\$&')).join('|');
// `spec: true` rules look at module specifiers (string contents kept); the others
// see string contents blanked: '...', "..." and template-literal text (the code
// inside `${…}` is kept: `${fetch()}` is code).
// Every rule runs over the WHOLE stripped file (`\s` spans newlines).
export const RULES = [
  { spec: true, name: 'network/process module import', re: new RegExp(String.raw`\bfrom\s+['"](?:node:)?(?:${modAlt})(?:/[^'"]*)?['"]`, 'g') },
  { spec: true, name: 'network/process module side-effect import', re: new RegExp(String.raw`\bimport\s+['"](?:node:)?(?:${modAlt})(?:/[^'"]*)?['"]`, 'g') },
  { spec: true, name: 'dynamic import/require of a network/process module', re: new RegExp(String.raw`\b(?:import|require)\s*\(\s*['"\`](?:node:)?(?:${modAlt})(?:/[^'"\`]*)?['"\`]`, 'g') },
  { spec: true, name: 'dynamic import/require with a computed specifier', re: /\b(?:import|require)\s*\(\s*[^'"`\s)]/g },
  { name: 'require used as a value (aliasing)', re: /(?<![.\w$])require\b(?!\s*\()/g },
  { name: 'createRequire', re: /\bcreateRequire\b/g },
  { name: 'process.getBuiltinModule', re: /\bgetBuiltinModule\b/g },
  { name: 'fetch()', re: /(?<![.\w$])fetch\s*\(/g },
  { name: 'globalThis.fetch / window.fetch', re: /\b(?:globalThis|window|self|global)\s*\.\s*fetch\b/g },
  { name: 'computed member access on globalThis / global / process', re: /(?<![.\w$])(?:globalThis|global|process)\s*(?:\?\.\s*)?\[/g },
  { name: 'WebSocket constructor', re: /\bnew\s+(?:\w+\.)?WebSocket\b/g },
  { name: 'WebSocket reference', re: /(?<![\w$.])WebSocket\s*\(/g },
  { name: 'EventSource / XMLHttpRequest / WebSocketStream', re: /\b(?:EventSource|XMLHttpRequest|WebSocketStream)\b/g },
  { name: 'process.binding / internalBinding / process.dlopen', re: /\b(?:process\s*\.\s*(?:binding|_linkedBinding|dlopen)|internalBinding)\s*\(/g },
  { name: 'eval / Function constructor', re: /(?<![.\w$])eval\s*\(|(?<![.\w$])(?:new\s+)?Function\s*\(/g },
  // G-32: reflective access. `process` / `globalThis` may only appear as the object of a
  // plain member access (`process.env`, `process?.exitCode`); used as a VALUE (aliased,
  // passed to Reflect.* / Object.getOwnPropertyDescriptor, spread, cast) it would let a
  // computed name reach getBuiltinModule / binding past every rule above.
  { name: 'process / globalThis used as a value (aliasing, reflection)', re: /(?<![\w$])(?<!(?:^|[^.])\.)(?:process|globalThis)\b(?!\s*(?:\?\.|\.)\s*[A-Za-z_$])/g },
  { name: 'Reflect.* / Object.getOwnPropertyDescriptor over process / globalThis', re: /\b(?:Reflect\s*\.\s*[A-Za-z]+|Object\s*\.\s*(?:getOwnPropertyDescriptors?|entries|values|getOwnPropertyNames|keys|assign))\s*\(\s*(?:process|globalThis|global)\b/g },
];

/**
 * Strip comments. With `blankQuoted`, also blank the TEXT of every string: '…', "…"
 * and the literal parts of template literals (G-32: prose such as `in-process` must
 * not look like code), while the code inside `${…}` is kept (nested templates too).
 */
function stripComments(src, blankQuoted = false) {
  let out = '';
  let i = 0;
  let mode = 'code';
  let quote = '';
  /** Template nesting: each entry is the `{` depth of the `${…}` expression we are in. */
  const tpl = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (blankQuoted && tpl.length) {
        if (c === '{') tpl[tpl.length - 1]++;
        else if (c === '}') {
          if (tpl[tpl.length - 1] === 0) {
            // end of `${…}`: back into the template literal's text
            tpl.pop();
            mode = 'str';
            quote = '`';
            out += c;
            i++;
            continue;
          }
          tpl[tpl.length - 1]--;
        }
      }
      if (c === '"' || c === "'" || c === '`') {
        mode = 'str';
        quote = c;
      }
      out += c;
      i++;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    // string: keep contents (module specifiers live here) unless blanking; honour escapes
    if (c === '\\') {
      out += blankQuoted ? '  ' : c + (n ?? '');
      i += 2;
      continue;
    }
    if (c === quote) {
      mode = 'code';
      out += c;
    } else if (blankQuoted && quote === '`' && c === '$' && n === '{') {
      out += '${';
      tpl.push(0);
      mode = 'code';
      i += 2;
      continue;
    } else out += blankQuoted && c !== '\n' ? ' ' : c;
    i++;
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(name)) files.push(p);
  }
  return files;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

export function lintFile(path, text) {
  const hits = [];
  const withStrings = stripComments(text);
  const noStrings = stripComments(text, true);
  const lines = withStrings.split('\n');
  for (const r of RULES) {
    const view = r.spec ? withStrings : noStrings;
    r.re.lastIndex = 0;
    for (const m of view.matchAll(r.re)) {
      const line = lineOf(view, m.index);
      hits.push({ path, line, rule: r.name, text: (lines[line - 1] ?? '').trim().slice(0, 160) });
    }
  }
  return hits;
}

export function lintTree(root) {
  const netDir = join(root, 'net') + sep;
  const violations = [];
  for (const f of walk(root)) {
    if (f.startsWith(netDir)) continue;
    violations.push(...lintFile(f, readFileSync(f, 'utf8')));
  }
  return violations;
}

// ── Bundle check ──

/** npm packages the published bundle may inline (esbuild metafile). Adding one is a reviewed change. */
export const BUNDLE_ALLOWLIST = ['ajv', 'ajv-draft-04', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'ws'];
/** Allowlisted packages that are themselves network code (imported only from src/net/). */
export const NETWORK_PACKAGES = ['ws'];
const NET_BUILTIN = /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns|dns\/promises|child_process|worker_threads|inspector|inspector\/promises|cluster|undici)$/;
const PACKAGE_SCAN = /\bgetBuiltinModule\b|\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(|\binternalBinding\s*\(|\brequire\s*\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads|inspector|cluster|undici)['"]/g;
const NET_SRC = 'packages/arena-cli/src/net/';
/**
 * Workspace sources outside src/net/ that are part of the guarded layer and may import
 * exactly the listed builtins (G-25: the shared address blocklist uses `node:net` isIP only).
 * Every other source rule still applies to them.
 */
const SHARED_NET_SOURCES = { 'packages/wot-store/src/net-blocklist.ts': ['node:net'] };
const OWN_SRC = 'packages/arena-cli/src/';

function packageOf(path) {
  const i = path.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const rest = path.slice(i + 'node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/**
 * Check an esbuild metafile's inputs. `read(path)` returns an input's source
 * text (path relative to the workspace), or null when it cannot be read.
 */
export function checkMetafile(meta, read) {
  const violations = [];
  const v = (path, rule, text = '') => violations.push({ path, line: 0, rule, text });
  for (const [path, input] of Object.entries(meta.inputs ?? {})) {
    if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path)) continue;
    const pkg = packageOf(path);
    if (pkg && !BUNDLE_ALLOWLIST.includes(pkg)) v(path, `bundled package "${pkg}" is not on BUNDLE_ALLOWLIST`);
    const netCode = path.startsWith(NET_SRC) || (pkg !== null && NETWORK_PACKAGES.includes(pkg));
    const sharedAllowed = Object.hasOwn(SHARED_NET_SOURCES, path) ? SHARED_NET_SOURCES[path] : [];
    for (const imp of input.imports ?? []) {
      const target = String(imp.path);
      const isNet = (imp.external && NET_BUILTIN.test(target)) || NETWORK_PACKAGES.includes(packageOf(target) ?? '');
      if (isNet && !netCode && !(imp.external && sharedAllowed.includes(target))) v(path, `imports ${target} outside src/net/`);
    }
    if (netCode) continue;
    const text = read(path);
    if (text === null) {
      v(path, 'bundled source could not be read for linting');
      continue;
    }
    if (pkg) {
      PACKAGE_SCAN.lastIndex = 0;
      for (const m of text.matchAll(PACKAGE_SCAN)) v(path, 'bundled package reaches a network/process primitive', m[0]);
    } else if (!path.startsWith(OWN_SRC)) {
      const allowedImport = (h) =>
        h.rule === 'network/process module import' && sharedAllowed.some((m) => new RegExp(String.raw`\bfrom\s+['"]${m.replace(/[/.]/g, '\\$&')}['"]`).test(h.text));
      violations.push(...lintFile(path, text).filter((h) => !allowedImport(h)));
    }
  }
  return violations;
}

export async function bundleMetafile() {
  const { build } = await import('esbuild');
  const r = await build({
    entryPoints: [join(PKG, 'src', 'bin.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    write: false,
    metafile: true,
    absWorkingDir: WORKSPACE,
    external: ['bufferutil', 'utf-8-validate'],
    define: { __ARENA_ENGINE_SOURCES__: 'undefined', __ARENA_BUNDLED__: 'true' },
    logLevel: 'silent',
  });
  return r.metafile;
}

function readInput(path) {
  try {
    return readFileSync(join(WORKSPACE, path), 'utf8');
  } catch {
    return null;
  }
}

function report(violations, where) {
  if (!violations.length) return false;
  console.error(`lint:net: ${violations.length} violation(s) ${where} (every outbound connection must use the guarded layer in src/net/):`);
  const show = (p) => {
    if (!isAbsolute(p)) return p;
    const rel = relative(PKG, p);
    return rel.startsWith('..') ? p : rel;
  };
  for (const x of violations) console.error(`  ${show(x.path)}${x.line ? `:${x.line}` : ''}  [${x.rule}]  ${x.text}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = rootArg ? resolve(process.cwd(), rootArg) : join(PKG, 'src');
  const doBundle = args.includes('--bundle') || !rootArg;
  let failed = report(lintTree(root), `under ${relative(PKG, root) || '.'} outside net/`);
  let bundleNote = '';
  if (doBundle) {
    let meta;
    try {
      meta = await bundleMetafile();
    } catch (e) {
      const first = (e?.errors ?? [])[0];
      const where = first?.location ? `${first.location.file}:${first.location.line}: ` : '';
      console.error(`lint:net: cannot bundle src/bin.ts to check the bundle inputs: ${where}${first?.text ?? String(e?.message ?? e).split('\n')[0]}`);
      console.error('Next: fix the build first (npm run build -w @sixi4ai/agent-arena); the bundle check cannot pass on a tree that does not bundle.');
      process.exit(1);
    }
    failed = report(checkMetafile(meta, readInput), 'in the bundle inputs') || failed;
    const pkgs = [...new Set(Object.keys(meta.inputs).map(packageOf).filter(Boolean))].sort();
    bundleNote = `; bundle: ${Object.keys(meta.inputs).length} inputs, packages ${pkgs.join(', ')}`;
  }
  if (failed) {
    console.error('Next: import httpRequest / openWebSocket / serve from src/net/ instead (or add a reviewed package to BUNDLE_ALLOWLIST).');
    process.exit(1);
  }
  console.log(`lint:net: ok (${relative(PKG, root) || '.'}; src/net/ is the only network module${bundleNote})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
