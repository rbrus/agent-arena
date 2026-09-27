/**
 * Regenerate the golden fixtures (only on an intended, reviewed change):
 *
 *   npm run golden:regen -w arena-report          (from ascension/)
 *
 * Writes test/fixtures/golden-report.{json,sarif} (engine build: the `core`
 * scope digest of this workspace), test/fixtures/example0.sarif (the
 * rendering of report.schema.json examples[0], sarif-mapping.md §8) and
 * test/fixtures/hosted-report.json (examples[2], sealed with the RFC 8032
 * test key; its SARIF is contracts/fixtures/hosted_report.sarif).
 * test/golden.test.ts regenerates in memory and compares byte-for-byte.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFileJson } from '../src/canonical.ts';
import { reportSchema } from '../src/schemas.ts';
import { toSarif } from '../src/sarif.ts';
import { validateSarif } from '../src/sarif-validate.ts';
import type { Report } from '../src/types.ts';
import { GOLDEN_ENGINE_BUILD, buildGoldenReport, buildHostedReport } from './golden.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const report = buildGoldenReport();
const sarif = toSarif(report);
const example = toSarif((reportSchema.examples as Report[])[0]);
for (const [name, log] of [['golden', sarif], ['example0', example]] as const) {
  const v = validateSarif(log);
  if (!v.ok) throw new Error(`${name} SARIF invalid:\n${v.errors.join('\n')}`);
}
writeFileSync(join(FIX, 'golden-report.json'), toFileJson(report));
writeFileSync(join(FIX, 'golden-report.sarif'), toFileJson(sarif));
writeFileSync(join(FIX, 'example0.sarif'), toFileJson(example));
const hosted = buildHostedReport();
const hv = validateSarif(toSarif(hosted));
if (!hv.ok) throw new Error(`hosted SARIF invalid:\n${hv.errors.join('\n')}`);
writeFileSync(join(FIX, 'hosted-report.json'), toFileJson(hosted));
console.log(`engine build (core scope): ${GOLDEN_ENGINE_BUILD}`);
const s = report.summary;
console.log(`golden: ${s.episodes_total} episodes, ${s.effective_episodes} effective, verdict ${s.verdict}, ${sarif.runs[0].results.length} SARIF results`);
