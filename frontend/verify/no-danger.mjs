// A zero-dependency lint ban (threat-model-arena.md §4.2 "Replay inspector"):
// no raw HTML injection, no eval, and no href/src attribute built from data.
// All file-derived text goes through <T>/<JsonBlock> (src/inspector/Text.tsx).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// Match ACTUAL usage (prop assignment / object key / property write), not the
// word appearing in a comment that documents the ban.
const BANNED = [
  /dangerouslySetInnerHTML\s*[=:]/,
  /\.innerHTML\s*=/,
  /document\.write\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\b(href|src|xlinkHref|action|formAction)\s*=\s*\{/,
  /insertAdjacentHTML|outerHTML\s*=/,
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

let violations = 0;
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const bad of BANNED) {
    const m = bad.exec(text);
    if (m) {
      console.error(`BANNED: ${m[0]} in ${file}`);
      violations++;
    }
  }
}

if (violations) {
  console.error(`\nno-danger: ${violations} violation(s). File-derived text must render via <T>/<JsonBlock>.`);
  process.exit(1);
}
console.log('no-danger: OK — no raw HTML injection in src/.');
