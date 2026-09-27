/**
 * Terminal and CI-log sinks (threat model §4.2 "Terminal and CI logs"). All
 * output leaves through `out()` / `info()` / `warn()` / `errorLine()`:
 * redacted, `toTerminalSafe()`d, redacted again (a cut can expose a secret
 * prefix), and rendered as exactly ONE line: a newline inside the text is shown
 * as `\n`, never emitted (G-22). A line that would still begin with a CI
 * marker (`::`, `##`) after leading whitespace is prefixed with `> `, because
 * the GitHub runner trims leading whitespace before matching `::command::`.
 *
 * Target-authored text additionally goes through the shared sanitiser and is
 * never allowed to start a line (`  target> ` prefix), which defeats
 * `::workflow-command::`, `##vso[` and `section_start:` markers. It is
 * redacted WHOLE before anything escapes or cuts it (G-19).
 */

import { scrubHostedText } from './hosted/log-filter.ts';
import { inertJson, stripActive } from './inert.ts';
import { redact } from './redact.ts';
import { sanitizeForReport } from './report.ts';

// ESC-introduced sequences: CSI, OSC (incl. OSC 8 links, OSC 52 clipboard), DCS/SOS/PM/APC, single ESC.
const ESC_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\)|[PX^_][\s\S]*?\u001b\\|[@-Z\\-_])/g;
// C1 CSI/OSC introducers and every other control except \n and \t.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Markers CI systems act on at the start of a line (after leading whitespace). */
const CI_MARKER = /^\s*(?:::|##|section_(?:start|end):)/;

/**
 * Strip escape sequences, control characters and (G-36) every other active code
 * point: bidi overrides and isolates, zero-width and format characters, tag
 * characters, variation selectors, private use (inert.ts). Newlines are shown as
 * `\n` when `oneLine`.
 */
export function toTerminalSafe(s: string, cap = 200, oneLine = true): string {
  // G-57: the hosted log filter runs on the whole text, again once stripping can have joined a
  // host split by escapes or invisibles, and again after the cut. A host that straddles `cap` is
  // then already `<verified origin>` before the cut, so no prefix of it (`agent.e…`) survives.
  let t = scrubHostedText(stripActive(scrubHostedText(s).replace(ESC_SEQ, '').replace(CONTROLS, '')));
  if (oneLine) t = t.replace(/\r?\n|\r/g, '\\n').replace(/\t/g, ' ');
  const cps = [...t];
  return cps.length > cap ? scrubHostedText(`${cps.slice(0, cap).join('')}…`) : t;
}

/**
 * One output line: redacted before and after sanitising/cutting, never a CI command.
 * G-57: hosted-filtered before the cut (toTerminalSafe filters, cuts, filters again).
 */
export function safeLine(s: string, cap: number): string {
  const line = redact(toTerminalSafe(redact(scrubHostedText(s)), cap, true));
  return CI_MARKER.test(line) ? `> ${line}` : line;
}

/**
 * Target-authored text for a human sink: redacted whole, sanitised (no
 * Markdown escaping: a terminal renders none), redacted again, capped,
 * redacted at the cut, and never at line start.
 *
 * G-57: the hosted log filter runs on the whole text first, and the sanitiser's
 * own bound is kept well above `cap` so that it never makes the visible cut: its
 * NFKC step can turn a fullwidth spelling into the host, and toTerminalSafe then
 * filters that result before and after the real cut at `cap`.
 */
export function targetText(s: string, cap = 200): string {
  const clean = redact(sanitizeForReport(redact(scrubHostedText(s)), { escapeMarkdown: false, maxLength: Math.max(cap, 16) * 4 }));
  return `  target> ${redact(toTerminalSafe(clean, cap))}`;
}

/**
 * The only two writers to the process streams (G-45): in a hosted run every byte
 * passes the hosted log filter (the verified origin and its addresses become
 * `<verified origin>`); otherwise the text is written unchanged.
 */
export function writeStdout(text: string): void {
  if (stdoutClosed) return;
  process.stdout.write(scrubHostedText(text));
}

/**
 * G-60: stdout was closed by its reader (`agent-arena verify … | head -n 1`). From then on stdout writes are
 * dropped and the command runs to its end, so the process still exits with the command's own code: a closed
 * pipe never turns a failed verification or a run with findings into exit 0.
 */
let stdoutClosed = false;
export function markStdoutClosed(): void {
  stdoutClosed = true;
}
export function isStdoutClosed(): boolean {
  return stdoutClosed;
}

export function writeStderr(text: string): void {
  process.stderr.write(scrubHostedText(text));
}

let quiet = false;
let jsonMode = false;

export function setOutputMode(o: { quiet?: boolean; json?: boolean }): void {
  quiet = !!o.quiet;
  jsonMode = !!o.json;
}

/** A human status line on stderr (stdout is reserved for results / `--json`). */
export function info(line: string): void {
  if (quiet) return;
  writeStderr(`${safeLine(line, 2000)}\n`);
}

export function warn(line: string): void {
  writeStderr(`warning: ${safeLine(line, 2000)}\n`);
}

export function errorLine(line: string): void {
  writeStderr(`error: ${safeLine(line, 2000)}\n`);
}

/** A result line on stdout (human mode). One call = one line: embedded newlines are shown, not emitted. */
export function out(text: string): void {
  if (jsonMode || quiet) return;
  writeStdout(`${safeLine(text, 4000)}\n`);
}

/** The single `--json` document on stdout: redacted, then inert (G-36: active code points `\u`-escaped, lossless). */
export function outJson(doc: unknown): void {
  writeStdout(jsonDocument(doc));
}

/** The text of a `--json` document (what outJson writes; also `verify --hosted-seal --result`): redacted, inert, LF-terminated. */
export function jsonDocument(doc: unknown): string {
  return `${inertJson(redact(JSON.stringify(doc, null, 2)))}\n`;
}

export function isJson(): boolean {
  return jsonMode;
}
