#!/usr/bin/env node
/**
 * Relative-link check for the repository's Markdown (README, docs/, contracts/,
 * package and sandbox READMEs). Every relative link target must exist in the
 * tree; external (scheme) links and pure #anchors are not checked. Code spans
 * and fenced code blocks are ignored. Imports only node:fs and node:path.
 *
 *   node .github/scripts/md-link-check.mjs [root]      (default: cwd)
 *
 * Exit 0 = no dead link, 1 = dead links (listed), 2 = usage error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
if (!existsSync(root) || !statSync(root).isDirectory()) {
  process.stderr.write(`md-link-check: not a directory: ${root}\n`);
  process.exit(2);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.agent-arena', 'out']);
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); }
    else if (e.isFile() && e.name.endsWith('.md')) files.push(join(dir, e.name));
  }
})(root);

const INLINE = /!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFDEF = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

let checked = 0;
const dead = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  let fence = null;
  lines.forEach((raw, i) => {
    const m = raw.match(/^\s*(```+|~~~+)/);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; return; }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, '');
    const targets = [...line.matchAll(INLINE)].map((x) => x[1]);
    const ref = line.match(REFDEF);
    if (ref) targets.push(ref[1]);
    for (const t of targets) {
      if (SCHEME.test(t) || t.startsWith('#')) continue;
      const path = decodeURIComponent(t.split('#')[0].split('?')[0]);
      if (!path) continue;
      checked++;
      const abs = path.startsWith('/') ? join(root, path) : resolve(dirname(f), path);
      if (!abs.startsWith(root) || !existsSync(abs)) dead.push(`${relative(root, f)}:${i + 1}: ${t}`);
    }
  });
}

if (dead.length) {
  process.stderr.write(`md-link-check: ${dead.length} dead relative link(s) in ${files.length} files:\n`);
  for (const d of dead) process.stderr.write(`  ${d}\n`);
  process.exit(1);
}
process.stdout.write(`md-link-check: ${checked} relative links in ${files.length} Markdown files, 0 dead\n`);
