/**
 * Pillar 9 guard for this package: the harness runs no model and reaches no network.
 *
 *  - No file of the package (src/, test/), and no file outside it that the package reaches by a
 *    relative import, imports a network or process module (the arena-cli lint:net list), calls a
 *    network primitive, or computes a module specifier.
 *  - No file NAMES a provider SDK, anywhere (code, strings or comments), and package.json depends
 *    on workspace packages only.
 *
 * The names below are assembled from fragments so this file does not trip its own scan.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const j = (...parts: string[]): string => parts.join('');
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** arena-cli scripts/lint-net.mjs MODULES. */
const NET_MODULES = [
  j('ht', 'tp'), j('ht', 'tps'), j('ht', 'tp2'), j('n', 'et'), j('t', 'ls'), j('dg', 'ram'), j('d', 'ns'), j('d', 'ns/promises'), j('w', 's'), j('und', 'ici'),
  j('node-', 'fetch'), j('ax', 'ios'), j('g', 'ot'), j('event', 'source'), j('@modelcontext', 'protocol/sdk'),
  j('child_', 'process'), j('worker_', 'threads'), j('insp', 'ector'), j('clus', 'ter'), j('mod', 'ule'),
];

/** Provider SDKs (npm names and the bare vendor tokens they are imported by). */
const PROVIDER_SDKS = [
  j('open', 'ai'), j('@anth', 'ropic-ai'), j('anth', 'ropic'), j('@google/', 'generative-ai'), j('@google/', 'genai'), j('@google-cloud/', 'vertexai'),
  j('@mistral', 'ai'), j('mistral', 'ai'), j('cohere', '-ai'), j('groq', '-sdk'), j('together', '-ai'), j('repli', 'cate'), j('oll', 'ama'),
  j('@aws-sdk/client-', 'bedrock'), j('@azure/', 'open', 'ai'), j('@hugging', 'face/inference'), j('lang', 'chain'), j('lite', 'llm'), j('@ai', '-sdk/'), j('fireworks', '-ai'),
];

const modAlt = NET_MODULES.map(esc).join('|');
const CODE_RULES: { name: string; re: RegExp }[] = [
  { name: 'network/process module import', re: new RegExp(`\\bfrom\\s+['"](?:node:)?(?:${modAlt})(?:/[^'"]*)?['"]`, 'g') },
  { name: 'network/process side-effect import', re: new RegExp(`\\bimport\\s+['"](?:node:)?(?:${modAlt})(?:/[^'"]*)?['"]`, 'g') },
  { name: 'dynamic import/require of a network/process module', re: new RegExp(`\\b(?:import|require)\\s*\\(\\s*['"\`](?:node:)?(?:${modAlt})(?:/[^'"\`]*)?['"\`]`, 'g') },
  { name: 'dynamic import/require with a computed specifier', re: /\b(?:import|require)\s*\(\s*[^'"`\s)]/g },
  { name: 'network primitive', re: new RegExp(`(?<![.\\w$])${j('fet', 'ch')}\\s*\\(|\\b(?:${j('Web', 'Socket')}|${j('Event', 'Source')}|${j('XMLHttp', 'Request')})\\b`, 'g') },
  { name: 'module loader escape hatch', re: new RegExp(`\\b(?:${j('create', 'Require')}|${j('getBuiltin', 'Module')}|${j('process', '.binding')})\\b`, 'g') },
];
const SDK_RE = new RegExp(`(?<![A-Za-z0-9])(?:${PROVIDER_SDKS.map(esc).join('|')})(?![A-Za-z0-9])`, 'i');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') walk(p, out);
    } else if (/\.(?:[cm]?[jt]s|json)$/.test(name)) out.push(p);
  }
  return out;
}

/** Package files plus every file reached through relative imports (transitively). */
function reachable(): string[] {
  const seen = new Set<string>();
  const queue = [...walk(join(PKG, 'src')), ...walk(join(PKG, 'test'))];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(resolve(dirname(f), m[1]));
  }
  return [...seen].sort();
}

test('no file of the package, or reached by it, imports a network module or calls a network primitive', () => {
  const files = reachable();
  assert.ok(files.some((f) => f.endsWith(join('arena-cli', 'src', 'reference', 'diplomacy.ts'))), 'the cross-package reference agent is scanned too');
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const r of CODE_RULES) {
      r.re.lastIndex = 0;
      for (const m of text.matchAll(r.re)) hits.push(`${f}: ${r.name}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('no file names a provider SDK, and the package depends on workspace packages only', () => {
  const files = [...reachable(), join(PKG, 'package.json')];
  const hits = files.flatMap((f) => {
    const m = SDK_RE.exec(readFileSync(f, 'utf8'));
    return m ? [`${f}: ${m[0]}`] : [];
  });
  assert.deepEqual(hits, []);
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['arena-report', 'arena-scenarios', 'wot-engine']);
  assert.equal(pkg.devDependencies, undefined);
});

test('the scan itself works: it flags a network import, a computed import and an SDK name', () => {
  const sample = [`import x from '${j('node:', 'ht', 'tps')}';`, `await ${j('imp', 'ort')}(spec);`, `const c = new ${j('Web', 'Socket')}(u);`].join('\n');
  const found = CODE_RULES.filter((r) => {
    r.re.lastIndex = 0;
    return r.re.test(sample);
  }).map((r) => r.name);
  assert.deepEqual(found, ['network/process module import', 'dynamic import/require with a computed specifier', 'network primitive']);
  assert.ok(SDK_RE.test(`import { X } from '${j('@anth', 'ropic-ai')}/sdk'`));
  assert.ok(!SDK_RE.test('provider_id: alpha'));
});
