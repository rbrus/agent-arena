// Contract Tier-0 self-consistency check (contracts/README.md §"Tier 0").
//
// Dependency-free (AJV only, already installed via wot-contracts): validates the
// contract against ITSELF, no implementation needed. Runs in CI on every PR.
//
//   1. Every schema in contracts/schemas compiles under AJV 2020-12 strict.
//   2. Every embedded `examples[]` validates against its own schema (catches
//      drift like a wrong-length ULID).
//   3. Every `$ref: './schemas/<file>'` in openapi.yaml / asyncapi.yaml resolves
//      to a real schema file.
//   4. Every OAuth scope in the flow appears in the granted-scope enum.
//
// The fuller spec lint (OpenAPI 3.1 / AsyncAPI 3.0 via spectral / asyncapi-cli)
// is deferred to the contracts workstream to avoid adding tool dependencies
// without approval — noted in sandbox/README.md.
//
// Run: `node .github/scripts/contract-selfcheck.mjs` (from ascension/) or
// `npm run contracts:tier0`.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Walk up to the first ancestor holding contracts/schemas: the repo root in
// both the private layout (<private-root>/) and the public one (agent-arena/).
function findContractsDir(start) {
  if (process.env.WOT_CONTRACTS_DIR) return process.env.WOT_CONTRACTS_DIR;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'contracts', 'schemas'))) return join(dir, 'contracts');
    if (dirname(dir) === dir) throw new Error(`contracts/schemas not found above ${start}`);
  }
}
const CONTRACTS = findContractsDir(HERE);
const SCHEMAS_DIR = join(CONTRACTS, 'schemas');

const failures = [];
const fail = (msg) => failures.push(msg);

// --- 1 + 2: schemas compile, examples validate ---------------------------
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', (s) => !Number.isNaN(Date.parse(s)));
ajv.addFormat('uri', (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s));

const schemaFiles = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.schema.json'));
let exampleCount = 0;
for (const file of schemaFiles) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8'));
  } catch (e) {
    fail(`schema ${file} is not valid JSON: ${e.message}`);
    continue;
  }
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    fail(`schema ${file} failed to compile under AJV strict: ${e.message}`);
    continue;
  }
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  examples.forEach((ex, i) => {
    exampleCount += 1;
    if (!validate(ex)) {
      fail(`schema ${file} example[${i}] failed validation: ${JSON.stringify(validate.errors)}`);
    }
  });
}

// --- 3: every ./schemas/<file> ref in the specs resolves -----------------
const specFiles = ['openapi.yaml', 'asyncapi.yaml'].filter((f) => existsSync(join(CONTRACTS, f)));
const refRe = /['"]?\.\/schemas\/([A-Za-z0-9_]+\.schema\.json)['"]?/g;
const referenced = new Set();
for (const spec of specFiles) {
  const text = readFileSync(join(CONTRACTS, spec), 'utf8');
  for (const m of text.matchAll(refRe)) {
    referenced.add(m[1]);
    if (!existsSync(join(SCHEMAS_DIR, m[1]))) {
      fail(`${spec} references ./schemas/${m[1]} which does not exist`);
    }
  }
}

// --- 4: OAuth scopes in the flow appear in the granted-scope enum --------
const openapiPath = join(CONTRACTS, 'openapi.yaml');
if (existsSync(openapiPath)) {
  const oa = readFileSync(openapiPath, 'utf8');
  // Anchor on the `Scope:` schema definition (a 4+-space-indented key whose
  // very next line is its enum), not any substring like `InsufficientScope:`.
  const scopeEnum = /\n\s{4,}Scope:\s*\n\s{4,}enum:\s*\[([^\]]*)\]/.exec(oa);
  const enumScopes = scopeEnum ? scopeEnum[1].split(',').map((s) => s.trim()) : [];
  for (const scope of ['play:duel', 'spectate:read']) {
    if (!enumScopes.includes(scope)) {
      fail(`OAuth scope '${scope}' is used but missing from the Scope enum ${JSON.stringify(enumScopes)}`);
    }
  }
}

// --- report --------------------------------------------------------------
if (failures.length > 0) {
  console.error('Tier-0 contract self-consistency: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `Tier-0 contract self-consistency: OK ` +
    `(${schemaFiles.length} schemas, ${exampleCount} examples, ` +
    `${referenced.size} schema refs across ${specFiles.length} specs).`,
);
