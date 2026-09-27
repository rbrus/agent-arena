/**
 * Validate SARIF files against the vendored OASIS SARIF 2.1.0 schema (no network).
 *
 *   npm run sarif:validate -- <file.sarif> [more.sarif ...]      (from ascension/)
 *
 * Exit: 0 all valid, 1 at least one invalid, 2 unreadable / not JSON, 3 usage.
 */

import { readFileSync, statSync } from 'node:fs';
import { EXIT_CODES } from '../src/exit-codes.ts';
import { validateSarif } from '../src/sarif-validate.ts';

const MAX_BYTES = 64 * 1024 * 1024;
const files = process.argv.slice(2).filter((a) => a !== '--');
if (!files.length) {
  console.error('usage: npm run sarif:validate -- <file.sarif> [...]');
  process.exit(EXIT_CODES.misconfig);
}
let code: number = EXIT_CODES.ok;
for (const f of files) {
  let log: unknown;
  try {
    if (statSync(f).size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
    log = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`${f}: unreadable: ${(e as Error).message}`);
    code = Math.max(code, EXIT_CODES.error);
    continue;
  }
  const v = validateSarif(log);
  if (v.ok) console.log(`${f}: valid SARIF 2.1.0`);
  else {
    console.error(`${f}: INVALID SARIF 2.1.0 (${v.errors.length} error(s))`);
    for (const e of v.errors) console.error(`  - ${JSON.stringify(e).slice(1, -1)}`);
    code = Math.max(code, EXIT_CODES.findings);
  }
}
process.exit(code);
