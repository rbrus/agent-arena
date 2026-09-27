/**
 * Validators for the hosted-only documents, compiled from the single
 * source of truth (`contracts/schemas`): the signed run manifest
 * (`hosted_context.schema.json`) and the scenario-pack manifest
 * (`pack_manifest.schema.json`), its variant parameter files (`pack_variant.schema.json`),
 * the sealed bundle list (`bundle_manifest.schema.json`), the verifier's result file (`verify_result.schema.json`)
 * and the evidence renderer's inputs (`evidence_input.schema.json`). A private AJV instance (same options and
 * formats as arena-report's), so nothing here perturbs another catalog. In the
 * bundle, build.ts serves `contracts/schemas` from the inlined snapshot, exactly
 * as for arena-report's loaders.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

function findSchemasDir(start: string): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'contracts', 'schemas');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`contracts/schemas not found in any ancestor of ${start}`);
    dir = parent;
  }
}

/**
 * Deliberately NOT honouring WOT_CONTRACTS_DIR: the hosted validators must be the
 * ones this build was released with (and `run --hosted` refuses the variable anyway).
 */
const SCHEMAS_DIR = findSchemasDir(dirname(fileURLToPath(import.meta.url)));

const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const isDateTime = (s: string) => DATE_TIME.test(s) && !Number.isNaN(Date.parse(s));

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', isDateTime);

function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as Record<string, unknown>;
}

const hostedContextSchema = load('hosted_context.schema.json');
const packManifestSchema = load('pack_manifest.schema.json');

const bundleManifestSchema = load('bundle_manifest.schema.json');
const packVariantSchema = load('pack_variant.schema.json');
const digestStatementSchema = load('digest_statement.schema.json');
const verifyResultSchema = load('verify_result.schema.json');

export const validateHostedContext: ValidateFunction = ajv.compile(hostedContextSchema);
export const validatePackManifest: ValidateFunction = ajv.compile(packManifestSchema);
export const validateBundleManifest: ValidateFunction = ajv.compile(bundleManifestSchema);
/** contracts 2.6.0 `wot:pack_variant:1` (`arena-pack-variant/1`): exactly what the variant loader accepts. */
export const validatePackVariant: ValidateFunction = ajv.compile(packVariantSchema);
/** contracts 2.11.0 `wot:digest_statement:1` (signing.md §5.2 D3): the statement a detached envelope carries. */
export const validateDigestStatement: ValidateFunction = ajv.compile(digestStatementSchema);
export const DIGEST_STATEMENT_MAX_BYTES = Number(digestStatementSchema['x-max-frame-bytes'] ?? 4096);
export const BUNDLE_MANIFEST_MAX_BYTES = Number(bundleManifestSchema['x-max-frame-bytes'] ?? 1048576);
/** contracts 2.12.0 `wot:verify_result:1` (signing.md §5.1.1): the `--result` file `evidence --verify-result` reads. */
export const validateVerifyResult: ValidateFunction = ajv.compile(verifyResultSchema);
export const VERIFY_RESULT_MAX_BYTES = Number(verifyResultSchema['x-max-frame-bytes'] ?? 8388608);

/**
 * contracts 2.13.0 `wot:evidence_input:1` (HOSTED-PROFILE §2.7 step 6, signing.md §5.3 step 4): the seal step's facts
 * `agent-arena evidence --inputs <input.json>` reads (Sixi `render/input.json`). Everything else the evidence states
 * (seal time, region, organisation, origin, image digest, engine build, key id, packs) is read from the signed report,
 * never from this file. The schema does not reference across files, so a present `crosscheck_record` is checked
 * against `crosscheck_record.schema.json` by the command (`validateCrosscheckRecordSchema`, arena-report) before its
 * signature is verified.
 */
const evidenceInputSchema = load('evidence_input.schema.json');
export const EVIDENCE_INPUT_VERSION = String((evidenceInputSchema.properties as { input_version: { const: string } }).input_version.const);
export const EVIDENCE_INPUT_MAX_BYTES = Number(evidenceInputSchema['x-max-frame-bytes'] ?? 8388608);
export const validateEvidenceInput: ValidateFunction = ajv.compile(evidenceInputSchema);

/** Frame caps declared by the contracts (`x-max-frame-bytes`). */
export const HOSTED_CONTEXT_MAX_BYTES = Number(hostedContextSchema['x-max-frame-bytes'] ?? 8192);
export const PACK_MANIFEST_MAX_BYTES = Number(packManifestSchema['x-max-frame-bytes'] ?? 262144);

/** Schema errors as `path message`; never quotes a value (the document may be hostile). */
export function schemaErrors(errors: readonly ErrorObject[] | null | undefined, max = 4): string {
  return (errors ?? [])
    .slice(0, max)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
    .join('; ');
}
