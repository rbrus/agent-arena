// Codegen: contracts/schemas/*.schema.json -> src/generated/frames.ts
//
// Single source of truth: ../../contracts/schemas (repo root). Emits one
// TypeScript file containing an interface per frame, with the exact exported
// type names the rest of the stack imports (Observation, Action, Hello, ...).
//
// Nested/helper types from each schema's $defs and inline objects are PREFIXED
// with the frame's root name (e.g. ObservationUnitView, ActionMove) so that all
// 11 schemas can share one output file without duplicate-identifier collisions
// (both `observation` and `action` define a `cell` $def, etc.).
//
// Run: `node codegen.mjs` (or `npm run codegen` at the workspace root).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jstt from 'json-schema-to-typescript';

const { compile } = jstt;

const HERE = dirname(fileURLToPath(import.meta.url));
// Walk up to the first ancestor holding contracts/schemas (nested layout:
// <private-root>/contracts; public repo: agent-arena/contracts). Mirrors
// src/contracts-dir.ts, which this .mjs cannot import without a TS loader.
function findSchemasDir(start) {
  if (process.env.WOT_CONTRACTS_DIR) return join(process.env.WOT_CONTRACTS_DIR, 'schemas');
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'contracts', 'schemas'))) return join(dir, 'contracts', 'schemas');
    if (dirname(dir) === dir) throw new Error(`contracts/schemas not found above ${start}`);
  }
}
const SCHEMAS_DIR = findSchemasDir(HERE);
const OUT_DIR = join(HERE, 'src', 'generated');
const OUT_FILE = join(OUT_DIR, 'frames.ts');

// frame file -> exported root type name. Order controls emission order.
const FRAMES = [
  ['hello.schema.json', 'Hello'],
  ['observation.schema.json', 'Observation'],
  ['action.schema.json', 'Action'],
  ['ack.schema.json', 'Ack'],
  ['reject.schema.json', 'Reject'],
  ['match_end.schema.json', 'MatchEnd'],
  ['thought.schema.json', 'Thought'],
  ['session_superseded.schema.json', 'SessionSuperseded'],
  ['session_revoked.schema.json', 'SessionRevoked'],
  ['error.schema.json', 'ErrorEnvelope'],
  ['oauth_error.schema.json', 'OAuthError'],
];

function pascal(name) {
  return String(name)
    .replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const banner = [
    '/* eslint-disable */',
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT BY HAND.',
    ' * Source: contracts/schemas/*.schema.json (JSON Schema 2020-12).',
    ' * Regenerate: `npm run codegen` (packages/wot-contracts/codegen.mjs).',
    ' */',
    '',
  ].join('\n');

  const chunks = [banner];

  for (const [file, rootName] of FRAMES) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8'));
    const rootId = schema.$id;

    const ts = await compile(schema, rootName, {
      bannerComment: '',
      additionalProperties: true,
      declareExternallyReferenced: true,
      enableConstEnums: false,
      strictIndexSignatures: false,
      // Force the root name and prefix every nested/helper type so that all
      // frames coexist in one file without name clashes.
      customName(subSchema, keyName) {
        if (subSchema && subSchema.$id && subSchema.$id === rootId) return rootName;
        if (!keyName) return undefined;
        if (keyName === rootName) return rootName;
        return rootName + pascal(keyName);
      },
    });

    chunks.push(`// ---- ${file} (${rootId}) ----\n${ts.trim()}\n`);
  }

  writeFileSync(OUT_FILE, chunks.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${OUT_FILE} from ${FRAMES.length} schemas.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
