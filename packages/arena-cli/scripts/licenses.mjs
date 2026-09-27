#!/usr/bin/env node
// Third-party licence texts for every npm package inside the esbuild bundle
// (EXTRACTION.md §9 `licenses:third-party`). Reads dist/meta.json written by
// build.ts; fails if a bundled package ships no licence file.
//
// Usage: node scripts/licenses.mjs [--out dist/THIRD_PARTY_LICENSES.txt]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(PKG, 'dist', 'THIRD_PARTY_LICENSES.txt');
const metaPath = join(PKG, 'dist', 'meta.json');
if (!existsSync(metaPath)) {
  console.error('dist/meta.json not found. Next: run `npm run build:cli` first.');
  process.exit(2);
}
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const roots = new Map();
for (const input of Object.keys(meta.inputs)) {
  const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input.replace(/\\/g, '/'));
  if (m) roots.set(m[2], resolve(PKG, '..', '..', m[1])); // metafile paths are relative to the workspace root (build.ts absWorkingDir)
}
const missing = [];
const blocks = [];
for (const [name, dir] of [...roots].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
  if (!file) missing.push(name);
  blocks.push(`${'='.repeat(78)}\n${name}@${pkg.version}  (${pkg.license ?? 'UNKNOWN'})\n${'='.repeat(78)}\n${file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file shipped)'}\n`);
}
writeFileSync(OUT, `Third-party software bundled in agent-arena (dist/agent-arena.cjs)\n\n${blocks.join('\n')}`);
console.log(`wrote ${OUT} (${roots.size} packages: ${[...roots.keys()].join(', ')})`);
if (missing.length) {
  console.error(`no licence file in: ${missing.join(', ')}`);
  process.exit(1);
}
