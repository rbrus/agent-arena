/**
 * Start-up hardening against Node diagnostics that can dump this process's
 * memory or environment, i.e. the target credential (threat model C-4, G-26,
 * G-31). `main.ts` calls `assertNoDiagnostics()` before anything else runs.
 *
 * Node flags that ENABLE such a dump (inspector, heap snapshots, diagnostic
 * reports, the V8 CPU/heap profilers) are refused unless ARENA_DEBUG=1. Flags that only configure a
 * facility without turning it on (`--inspect-port`, `--report-signal`,
 * `--report-dir`, `--heapsnapshot-near-heap-limit=0`) are allowed: the Node
 * test runner passes several of them to every child.
 *
 * G-31: `NODE_OPTIONS` is split the way Node splits it (quoted tokens, with
 * backslash escapes inside double quotes), so `"--report-on-fatalerror"` is
 * seen as the flag it is. Single-quoted tokens are unquoted too (Node does not
 * treat `'` specially, so this only ever refuses more). As a backstop, the
 * effective diagnostic-report state is forced off after the check.
 *
 * G-41: Node accepts `_` for `-` in option names (`--inspect_brk`,
 * `--heapsnapshot_signal`), so names are compared in their dash spelling.
 */

import { misconfig } from './errors.ts';

// G-50 (contracts 2.6.0 signing.md §3.1.1): the V8 profilers too. A heap profile holds heap contents
// (the credential), and every profile is written outside /out. `--cpu-prof-dir` & co. only configure.
const DIAGNOSTIC_ENABLER = /^--(?:inspect(?:-brk|-wait)?|debug(?:-brk)?|heapsnapshot-signal|report-on-signal|report-on-fatalerror|report-uncaught-exception|cpu-prof|heap-prof|prof)(?:=|$)/;
const NEAR_HEAP_LIMIT = /^--heapsnapshot-near-heap-limit(?:=(\d+))?$/;

/**
 * Split `NODE_OPTIONS` into tokens like Node's `ParseNodeOptionsEnvVar`:
 * whitespace separates tokens outside quotes; `"…"` groups (a backslash
 * escapes the next character inside it); additionally `'…'` groups. An
 * unterminated quote runs to the end (Node refuses to start; we still check).
 */
export function splitNodeOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** `--heapsnapshot_signal=SIGUSR2` → `--heapsnapshot-signal=SIGUSR2`: underscores in the option name (before `=`) become dashes, as Node reads them. */
export function dashName(token: string): string {
  if (!token.startsWith('-')) return token;
  const eq = token.indexOf('=');
  return eq < 0 ? token.replace(/_/g, '-') : token.slice(0, eq).replace(/_/g, '-') + token.slice(eq);
}

/** The offending flag names (as written, never their values), from execArgv and NODE_OPTIONS. */
export function diagnosticFlags(execArgv: readonly string[] = process.execArgv, nodeOptions: string | undefined = process.env.NODE_OPTIONS): string[] {
  const found = new Set<string>();
  for (const raw of [...execArgv, ...splitNodeOptions(nodeOptions ?? '')]) {
    // Belt and braces: a token that still carries quote characters is checked without them too.
    for (const t of new Set([raw, raw.replace(/^["']+|["']+$/g, '')])) {
      // G-41: Node treats `_` and `-` in an option NAME as the same (`--inspect_brk`), so match the dash spelling of the name; the value is left alone.
      const a = dashName(t);
      const near = NEAR_HEAP_LIMIT.exec(a);
      if (DIAGNOSTIC_ENABLER.test(a) || (near && Number(near[1] ?? 1) > 0)) found.add(t.split('=')[0]);
    }
  }
  return [...found].sort();
}

/**
 * Backstop: whatever the flags said, switch diagnostic reports off in this
 * process (a report includes the environment, where `--auth env:NAME` lives).
 * Returns the switches that were on.
 */
export function disableDiagnosticReports(report: { reportOnFatalError?: boolean; reportOnSignal?: boolean; reportOnUncaughtException?: boolean } | undefined = process.report): string[] {
  if (!report) return [];
  const on: string[] = [];
  for (const k of ['reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException'] as const) {
    if (report[k]) {
      on.push(k);
      try {
        report[k] = false;
      } catch {
        /* read-only in some embedders: the flag check above is the control */
      }
    }
  }
  return on;
}

export function assertNoDiagnostics(env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): void {
  if (env.ARENA_DEBUG === '1') return;
  const flags = diagnosticFlags(execArgv, env.NODE_OPTIONS);
  if (flags.length) {
    throw misconfig(
      `refusing to run with Node diagnostics enabled (${flags.join(', ')}): they can write the target credential to disk or expose it to a debugger.`,
      'remove the flag from the command line and NODE_OPTIONS, or set ARENA_DEBUG=1 if you accept that risk on this machine.',
    );
  }
  disableDiagnosticReports();
}
