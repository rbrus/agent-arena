// Asserts the built inspector makes no call to another origin: no http(s)://
// in dist HTML/JS/CSS outside comments, except the inert allowlist below.
// Run after `vite build` (npm run verify does both).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Strings in bundled libraries that are identifiers, never fetched.
const ALLOW = [
  /^http:\/\/www\.w3\.org\/(1999\/xhtml|2000\/svg|1998\/Math\/MathML|1999\/xlink|XML\/1998\/namespace)$/, // DOM namespace URIs (react-dom)
  /^https:\/\/react\.dev\/errors\/$/, // react-dom's minified-error text; shown in a thrown message, never requested
];

function walk(d) {
  return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
}
function stripComments(src, ext) {
  if (ext === 'html') return src.replace(/<!--[\s\S]*?-->/g, '');
  // Block comments only: a `//` inside a string ("https://…") must not be eaten.
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

let bad = 0;
let files = 0;
for (const f of walk(DIST)) {
  const ext = f.split('.').pop();
  if (!['html', 'js', 'css', 'mjs'].includes(ext)) continue;
  files++;
  const src = stripComments(readFileSync(f, 'utf8'), ext);
  for (const m of src.matchAll(/https?:\/\/[^\s"'`)<>\\]*/g)) {
    if (ALLOW.some((a) => a.test(m[0]))) continue;
    console.error(`no-network: ${relative(DIST, f)}: ${m[0]}`);
    bad++;
  }
  if (ext === 'html' && !/Content-Security-Policy/.test(src)) {
    console.error(`no-network: ${relative(DIST, f)}: missing CSP meta`);
    bad++;
  }
}
if (!files) {
  console.error('no-network: dist/ is empty; run the build first');
  process.exit(1);
}
if (bad) process.exit(1);
console.log(`no-network: OK (${files} files, no external origins)`);
