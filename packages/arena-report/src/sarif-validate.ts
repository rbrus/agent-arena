/**
 * `validateSarif`: validate a value against the OASIS SARIF 2.1.0 JSON schema
 * (errata 01), vendored unmodified at `schema/sarif-schema-2.1.0.json` (see
 * `schema/NOTICE-OASIS.md`). The schema is JSON Schema draft-04 and is
 * compiled as published with `ajv-draft-04`; no network access, ever.
 *
 * On top of the schema, three checks the schema cannot express but GitHub
 * code scanning and sarif-mapping.md §3 rely on:
 *   - `level` must be `none` for every result whose `kind` is not `fail`
 *     (SARIF 2.1.0 §3.27.9/§3.27.10);
 *   - every `ruleIndex` must point at the rule with the same id;
 *   - no `message.markdown` anywhere (threat-model-arena.md §4.2).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvDraft04 from 'ajv-draft-04';
import { isDateTime, isUri } from './schemas.ts';

export const SARIF_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema', 'sarif-schema-2.1.0.json');
export const SARIF_SCHEMA_SHA256 = 'c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e';

/** RFC 3986 URI-reference: absolute or relative, no whitespace/controls, no raw backslash. */
function isUriReference(s: string): boolean {
  return /^[^\s\u0000-\u001f\u007f\\]*$/.test(s);
}

const ajv = new AjvDraft04({ allErrors: true, strict: false, validateFormats: true });
ajv.addFormat('date-time', isDateTime);
ajv.addFormat('uri', isUri);
ajv.addFormat('uri-reference', isUriReference);
const validate = ajv.compile(JSON.parse(readFileSync(SARIF_SCHEMA_PATH, 'utf8')) as object);

interface LooseRun {
  tool?: { driver?: { rules?: { id?: string }[] } };
  results?: { ruleId?: string; ruleIndex?: number; kind?: string; level?: string }[];
}

function extraChecks(log: unknown): string[] {
  const errs: string[] = [];
  const runs = (log as { runs?: LooseRun[] }).runs ?? [];
  runs.forEach((run, r) => {
    const rules = run.tool?.driver?.rules ?? [];
    (run.results ?? []).forEach((res, i) => {
      const at = `/runs/${r}/results/${i}`;
      const kind = res.kind ?? 'fail';
      if (kind !== 'fail' && res.level !== undefined && res.level !== 'none') errs.push(`${at} kind ${kind} must have level none, has ${res.level}`);
      if (res.ruleIndex !== undefined && rules[res.ruleIndex]?.id !== res.ruleId) errs.push(`${at} ruleIndex ${res.ruleIndex} does not point at rule ${res.ruleId}`);
    });
  });
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 64 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}/${i}`, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      if (k === 'markdown') errs.push(`${path}/markdown is present (never emitted: rendered Markdown is a phishing relay)`);
      walk(x, `${path}/${k}`, depth + 1);
    }
  };
  walk(log, '', 0);
  return errs;
}

export function validateSarif(log: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!validate(log)) {
    for (const e of (validate.errors ?? []).slice(0, 50)) errors.push(`${e.instancePath || '/'} ${e.message ?? e.keyword}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
  }
  if (log && typeof log === 'object') errors.push(...extraChecks(log));
  return { ok: errors.length === 0, errors };
}
