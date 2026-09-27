// Run the contract checks beyond Tier 0 (contracts/tools/contract-check.mjs):
// report.schema.json mirror drift, every OpenAPI example validated, and the
// must-reject negative cases. Dependency-free launcher: walks up to the first
// ancestor holding contracts/tools/contract-check.mjs, so it works from
// the nested source layout and from the root of the public repo.
//
// Run: `npm run contracts:check` (from ascension/, or the public repo root).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function findChecker(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'contracts', 'tools', 'contract-check.mjs');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`contracts/tools/contract-check.mjs not found above ${start}`);
  }
}

await import(pathToFileURL(findChecker(HERE)).href);
