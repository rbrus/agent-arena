// Codegen: contracts/schemas/{run_spec,eval_episode_end,hosted_context,pack_manifest}.schema.json -> src/generated/contracts.ts
//
// The CLI's own wire types come from the contracts, never by hand. `--check`
// regenerates in memory and exits 1 when the committed file drifted (the test
// suite runs it: CI fails on contract drift).
//
// Run: `npm run codegen -w @sixi4ai/agent-arena` (or `node codegen.mjs [--check]`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jstt from 'json-schema-to-typescript';

const { compile } = jstt;
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(HERE, 'src', 'generated', 'contracts.ts');

function findSchemasDir(start) {
  if (process.env.WOT_CONTRACTS_DIR) return join(process.env.WOT_CONTRACTS_DIR, 'schemas');
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'contracts', 'schemas'))) return join(dir, 'contracts', 'schemas');
    if (dirname(dir) === dir) throw new Error(`contracts/schemas not found above ${start}`);
  }
}

const FRAMES = [
  ['run_spec.schema.json', 'RunSpecContract'],
  ['eval_episode_end.schema.json', 'EvalEpisodeEndFrame'],
  // Phase 9 B1 (`run --hosted`): the signed run manifest and the scenario-pack manifest.
  ['hosted_context.schema.json', 'HostedContextContract'],
  ['pack_manifest.schema.json', 'PackManifestContract'],
];

function pascal(name) {
  return String(name)
    .replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * json-schema-to-typescript collapses an object with `if/then/else` (or an
 * allOf of them) into an index signature. Those conditionals only NARROW the
 * declared properties, so they are stripped for type generation; AJV still
 * enforces them at runtime (validateRunSpecSchema).
 */
/** An allOf member that only narrows: if/then/else plus annotations (2.2.0 adds a `description` to one). */
const CONDITIONAL_KEYS = new Set(['if', 'then', 'else', 'description', '$comment']);
function isPureConditional(x) {
  return !!x && typeof x === 'object' && 'if' in x && Object.keys(x).every((kk) => CONDITIONAL_KEYS.has(kk));
}

function stripConditionals(node) {
  if (Array.isArray(node)) return node.map(stripConditionals);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'if' || k === 'then' || k === 'else') continue;
    if (k === 'allOf' && Array.isArray(v) && v.every(isPureConditional)) continue;
    out[k] = stripConditionals(v);
  }
  return out;
}

export async function generate() {
  const dir = findSchemasDir(HERE);
  const chunks = [
    '/* eslint-disable */',
    '/**',
    ' * AUTO-GENERATED - DO NOT EDIT BY HAND.',
    ' * Source: contracts/schemas/{run_spec,eval_episode_end,hosted_context,pack_manifest}.schema.json.',
    ' * Regenerate: `node packages/arena-cli/codegen.mjs`. Drift fails `npm test`.',
    ' */',
    '',
  ];
  for (const [file, rootName] of FRAMES) {
    const schema = stripConditionals(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    const rootId = schema.$id;
    delete schema.examples;
    const ts = await compile(schema, rootName, {
      bannerComment: '',
      additionalProperties: false,
      declareExternallyReferenced: true,
      enableConstEnums: false,
      strictIndexSignatures: false,
      format: false,
      // Bounded arrays (seats[] is 1..6 since 2.2.0) become `[T, ...T[]]`, not a union of every tuple length.
      maxItems: 1,
      customName(sub, keyName) {
        if (sub && sub.$id && sub.$id === rootId) return rootName;
        if (!keyName) return undefined;
        if (keyName === rootName) return rootName;
        return rootName + pascal(keyName);
      },
    });
    chunks.push(`// ---- ${file} (${rootId}) ----\n${ts.trim()}\n`);
  }
  return chunks.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = await generate();
  if (process.argv.includes('--check')) {
    const cur = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
    if (cur !== text) {
      console.error('contract drift: src/generated/contracts.ts differs from contracts/schemas. Next: run `node packages/arena-cli/codegen.mjs` and review the diff.');
      process.exit(1);
    }
    console.log('codegen: generated types match contracts/schemas');
  } else {
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, text, 'utf8');
    console.log(`Wrote ${OUT_FILE}`);
  }
}
