/**
 * Process exit codes of the arena CLI (`run`, `verify`) and `sarif:validate`,
 * stable so CI can gate on them. Semantics follow the scanner convention
 * (0 clean, 1 findings, >= 2 the tool itself could not produce a trustworthy
 * answer), and docs/phase-7/EXTRACTION.md §9 / threat-model-arena.md §3.2.7:
 *
 * | code | name      | `run`                                                         | `verify`                                                        | `sarif:validate`        |
 * |-----:|-----------|---------------------------------------------------------------|-----------------------------------------------------------------|-------------------------|
 * | 0    | ok        | no fail verdict at or above `--fail-on` (default `error`)     | every episode re-simulated to the same hashes and verdicts      | the log is valid SARIF  |
 * | 1    | findings  | at least one fail verdict at or above `--fail-on`             | mismatch: a hash, verdict, summary or catalog differs           | the log is invalid      |
 * | 2    | error     | the arena failed (`harness_error`, crash, I/O)                | unverifiable input: not a valid report, or an episode cannot be regenerated | unreadable input |
 * | 3    | misconfig | invalid RunSpec / flags / missing credential reference        | the report names an engine build this CLI does not have         | bad usage               |
 *
 * `not_assessed` never yields 0 by itself being counted as a pass: a run whose
 * only non-pass verdicts are not_assessed exits 0 (no findings) but its
 * summary verdict is `inconclusive`, and the SARIF log carries every one of
 * them as `open` / `notApplicable`.
 */
export const EXIT_CODES: { readonly ok: 0; readonly findings: 1; readonly error: 2; readonly misconfig: 3 } = Object.freeze({
  ok: 0,
  findings: 1,
  error: 2,
  misconfig: 3,
} as const);

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
