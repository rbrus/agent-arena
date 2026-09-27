/** `run`'s exit code for a finished Report (see exit-codes.ts for the table). */

import { EXIT_CODES, type ExitCode } from './exit-codes.ts';
import type { Report, Severity } from './types.ts';

const RANK: Record<Severity, number> = { error: 3, warning: 2, note: 1 };

export function exitCodeForReport(report: Report, opts: { failOn?: Severity } = {}): ExitCode {
  if (report.episodes.some((e) => e.abort_reason === 'harness_error')) return EXIT_CODES.error;
  const floor = RANK[opts.failOn ?? 'error'];
  const verdicts = [...report.episodes.flatMap((e) => e.oracles), ...report.run_oracles];
  return verdicts.some((v) => v.verdict === 'fail' && RANK[v.severity] >= floor) ? EXIT_CODES.findings : EXIT_CODES.ok;
}
