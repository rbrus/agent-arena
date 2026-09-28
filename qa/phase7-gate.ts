/**
 * Phase-7 GATE (C1) — the Open Arena (sim-qa). Criteria 1–7 of
 * docs/phase-7/PLAN.md §1 "Gate (objective, qa/phase7-gate.ts)".
 *
 *   Run:  npm run gate                        (from ascension/, or the public repo root)
 *         npx tsx qa/phase7-gate.ts [--stable] [--no-suites] [--no-bench] [--layout private|public|auto]
 *
 *   --layout     which repository layout the harness reads (default auto; see "Layouts" below)
 *   --stable     omit the wall-clock block, so two runs can be diffed byte for byte
 *   --no-suites  skip the npm test / typecheck / tier-0 / contracts:check / lint:net /
 *                inspector subprocesses (criterion 5 then reports SKIP, and the gate
 *                cannot open)
 *   --no-bench   skip the Hallucinator live-path µs/tick measurement
 *
 * Wired into `npm test` via services/arena/test/phase7-gate.test.ts, which runs
 * this harness with suites and bench off (no recursion into npm test, no timing
 * assertion under a parallel test runner) and asserts every criterion-1..4 check
 * plus the verify/replay checks. The full verdict comes from `npm run gate`.
 *
 * It drives the REAL code paths through the PUBLIC CLI, each command a child
 * process (`node --import tsx packages/arena-cli/src/bin.ts …`, the same entry
 * the esbuild bundle wraps):
 *
 *   1. `serve-reference --policy coordinated --port 0` (an ephemeral port stands
 *      in for the sandbox's 8081), then the gate command
 *      `run --scenario byzantine --seat squad --tier core --seeds 20260720,1,2,3,5
 *       --episodes 5 --transport rest --i-own-this-target` against it; the five
 *      replay hashes, outcomes and ticks must equal the frozen anchors
 *      (arena-scenarios/src/anchors.ts), report.json must validate against
 *      contracts/schemas/report.schema.json and report.sarif against the vendored
 *      OASIS SARIF 2.1.0 schema. Edge and Frontier repeat seed 20260720.
 *   2. The same run over ws, mcp and a2a: byte-identical hash lists, identical
 *      verdict tuples and SARIF fingerprints.
 *   3. The calibration sweep script (arena-scenarios/scripts/calibration-sweep.ts,
 *      run as a subprocess: 15 seeds → frozen digest; gate seeds → per-cell table),
 *      the Grid Tactics duel pair through the CLI, and a doc per scenario.
 *   4. SARIF: schema digest, every produced log validates, each not_assessed
 *      verdict maps to kind notApplicable/open, the upload workflow exists.
 *   5. Grep gate for the cut modules (allowlist below, each entry justified) and
 *      the suites as subprocesses.
 *   6. docs/phase-7/SECURITY-REVIEW.md verdict line.
 *   7. Licence, NOTICE, public README/SECURITY/CONTRIBUTING, the conflict-of-
 *      interest sentence (README and SARIF tool.driver.properties), the ADR-002
 *      clean-room rule.
 *   X. `verify` → verified; `replay --json` = the sibling .replay.json byte for
 *      byte; Hallucinator live path µs/tick vs the 350 µs ceiling (CALIBRATION §8).
 *
 * Deterministic: fixed seeds, no Date.now / Math.random on any asserted path;
 * wall-clocks are measured with performance.now() and printed only in the
 * trailing measurement block. Scratch output goes to a fresh temp directory.
 *
 * Layouts (docs/phase-7/EXTRACTION.md §1/§2.1; EXTRACTION-DRYRUN.md blocker B2). The same
 * harness runs in the nested source layout and in the exported public one:
 *   private  <repo>/{ascension/{qa,packages,.github-public},contracts,docs/{phase-7,…}}
 *   public   <repo>/{qa,packages,.github/workflows,contracts,docs/{scenarios,guides},
 *            LICENSE,NOTICE,README.md,SECURITY.md,CONTRIBUTING.md}
 * `auto` picks private iff both `<code>/../docs/phase-7/GATE-EVIDENCE.md` and
 * `<code>/.github-public/` exist. contracts/ is located by wot-contracts' `contractsDir()`
 * (WOT_CONTRACTS_DIR, else `<workspace>/contracts`, else `<workspace>/../contracts`). In the public layout the checks that read PRIVATE evidence documents
 * (criterion 6, the security review under the denylisted docs/phase-*) are printed as
 * `N-A (private evidence)` and not scored; every code-driven check still scores, and C7
 * reads the exported root files (LICENSE, NOTICE, README.md, SECURITY.md, CONTRIBUTING.md)
 * that the private layout keeps as `.github-public/*` and `docs/phase-7/*-public.md`.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorFor as frozenAnchorFor, GATE_SEEDS_BYZANTINE, RAID_SCENARIO_IDS, RaidScenario, SCENARIO_IDS, SELF_TESTS, computeRaidVerdicts } from 'arena-scenarios';
import { contractsDir } from 'wot-contracts/contracts-dir';
import { CONFLICT_OF_INTEREST, NOT_APPLICABLE_REASONS, SARIF_SCHEMA_PATH, SARIF_SCHEMA_SHA256, validateReportSchema, validateSarif } from 'arena-report';

// ── paths ──────────────────────────────────────────────────────────────────────
const ASC = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ASC, 'packages', 'arena-cli', 'src', 'bin.ts');
const SCEN_PKG = join(ASC, 'packages', 'arena-scenarios');

// ── layouts (nested source layout vs exported public repo) ─────────────────────────────
export type Layout = 'private' | 'public';
export type LayoutArg = Layout | 'auto';
/** Every path a gate reads outside its own package code, per layout. */
export interface LayoutPaths {
  layout: Layout;
  /** How the layout was chosen. */
  how: 'auto' | 'forced';
  /** The code root: `ascension/` (private) or the repository root (public). */
  code: string;
  /** The directory that relative paths in check names are printed against. */
  display: string;
  contracts: string;
  docs: string;
  workflows: string;
  license: string;
  notice: string;
  readme: string;
  security: string;
  contributing: string;
  /** Private evidence documents (docs/phase-*) are readable only in the private layout. */
  privateEvidence: boolean;
}

/** private iff `<code>/../docs/phase-7/GATE-EVIDENCE.md` and `<code>/.github-public/` both exist. */
export function detectLayout(code: string): Layout {
  return existsSync(join(code, '..', 'docs', 'phase-7', 'GATE-EVIDENCE.md')) && existsSync(join(code, '.github-public')) ? 'private' : 'public';
}

/**
 * The `contracts/` directory: wot-contracts' `contractsDir(start)` (WOT_CONTRACTS_DIR, else
 * `<workspace root>/contracts` (public), else `<workspace root>/../contracts` (private)).
 * `env` exists so tests can pass the override explicitly; by default it is process.env, which
 * `contractsDir` reads itself.
 */
export function locateContracts(start: string, env: Record<string, string | undefined> = process.env): string {
  const override = env.WOT_CONTRACTS_DIR;
  if (override) {
    const dir = resolve(override);
    if (!existsSync(join(dir, 'schemas'))) throw new Error(`WOT_CONTRACTS_DIR=${dir} has no schemas/ directory`);
    return dir;
  }
  return contractsDir(start);
}

export function layoutPaths(code: string, arg: LayoutArg = 'auto', env: Record<string, string | undefined> = process.env): LayoutPaths {
  const layout = arg === 'auto' ? detectLayout(code) : arg;
  const how = arg === 'auto' ? 'auto' : 'forced';
  const contracts = locateContracts(code, env);
  if (layout === 'private') {
    const repo = join(code, '..');
    const docs = join(repo, 'docs');
    return {
      layout, how, code, display: repo, contracts, docs,
      workflows: join(code, '.github-public', 'workflows'),
      license: join(code, '.github-public', 'LICENSE'),
      notice: join(code, '.github-public', 'NOTICE'),
      readme: join(docs, 'phase-7', 'README-public.md'),
      security: join(docs, 'phase-7', 'SECURITY-public.md'),
      contributing: join(docs, 'phase-7', 'CONTRIBUTING-public.md'),
      privateEvidence: true,
    };
  }
  return {
    layout, how, code, display: code, contracts, docs: join(code, 'docs'),
    workflows: join(code, '.github', 'workflows'),
    license: join(code, 'LICENSE'),
    notice: join(code, 'NOTICE'),
    readme: join(code, 'README.md'),
    security: join(code, 'SECURITY.md'),
    contributing: join(code, 'CONTRIBUTING.md'),
    privateEvidence: false,
  };
}

/** `--layout private|public|auto` or `--layout=…`; default auto. Throws on anything else. */
export function parseLayoutArg(argv: readonly string[]): LayoutArg {
  let v: string | undefined;
  argv.forEach((a, i) => {
    if (a === '--layout') v = argv[i + 1] ?? '';
    else if (a.startsWith('--layout=')) v = a.slice('--layout='.length);
  });
  if (v === undefined) return 'auto';
  if (v === 'private' || v === 'public' || v === 'auto') return v;
  throw new Error(`--layout must be private, public or auto (got "${v}")`);
}

/** How an N-A check is printed in the status column. */
export const NA_LABEL = 'N-A (private evidence)';

// ── frozen values this gate pins ───────────────────────────────────────────────
/** `npx tsx scripts/calibration-sweep.ts | sha256sum` (CALIBRATION.md §2). */
const SWEEP15_SHA256 = '26c6cc33fbe6af09742687a4a935ad4602e945a76e5d881be43f3f2abae9baa6';
/** `npx tsx scripts/calibration-sweep.ts --seeds gate | sha256sum` (frozen here, C1). */
const SWEEP_GATE_SHA256 = '354a9c0a68033b73c015715ed39f6dcee22aa2f1405190b04fd07d0d8bc263cf';
const WALL_BUDGET_MS = 300_000; // gate criterion 1: < 5 minutes
const HALLUCINATOR_CEILING_US = 350; // CALIBRATION.md §8 proposal
const SIX_MEAN_BUDGET_US = 250; // arena-scenarios.md §3.4, kept as the six-scenario mean
const GATE_SEEDS = GATE_SEEDS_BYZANTINE.join(',');

// ── check harness (house style: qa/phase6-gate.ts) ─────────────────────────────
export type Crit = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'X';
export interface Check {
  id: string;
  crit: Crit;
  name: string;
  /**
   * FINDING: a defect this gate records and routes, outside the wording of criteria 1–7; not scored.
   * N-A: the check reads a private evidence document that the public layout does not export; printed, not scored.
   */
  status: 'PASS' | 'FAIL' | 'SKIP' | 'FINDING' | 'N-A';
  detail: string;
}
class Checks {
  readonly list: Check[] = [];
  ok(crit: Crit, id: string, name: string, pass: boolean, detail = ''): boolean {
    this.list.push({ id, crit, name, status: pass ? 'PASS' : 'FAIL', detail });
    return pass;
  }
  finding(crit: Crit, id: string, name: string, pass: boolean, detail = ''): void {
    this.list.push({ id, crit, name, status: pass ? 'PASS' : 'FINDING', detail });
  }
  skip(crit: Crit, id: string, name: string, detail: string): void {
    this.list.push({ id, crit, name, status: 'SKIP', detail });
  }
  na(crit: Crit, id: string, name: string, detail: string): void {
    this.list.push({ id, crit, name, status: 'N-A', detail });
  }
}

export type CritVerdict = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'N-A';
/**
 * A criterion FAILs on any FAIL, is INCOMPLETE on any SKIP, is N-A when every one of its checks is
 * N-A, else PASSes. FINDING never gates; an N-A check never counts either way.
 */
export function scoreCriteria(checks: readonly Check[], crits: readonly Crit[]): Record<Crit, CritVerdict> {
  return Object.fromEntries(
    crits.map((c) => {
      const cs = checks.filter((x) => x.crit === c);
      if (cs.some((x) => x.status === 'FAIL')) return [c, 'FAIL'];
      if (cs.some((x) => x.status === 'SKIP')) return [c, 'INCOMPLETE'];
      if (cs.length > 0 && cs.every((x) => x.status === 'N-A')) return [c, 'N-A'];
      return [c, 'PASS'];
    }),
  ) as Record<Crit, CritVerdict>;
}
/** Criteria (in order) with at least one check not evaluated for want of private evidence. */
export function notEvaluated<C extends string>(checks: readonly { crit: C; status: string }[]): C[] {
  return [...new Set(checks.filter((x) => x.status === 'N-A').map((x) => x.crit))];
}
/** The public-layout suffix of the verdict line; empty in the private layout. */
export function layoutSuffix(layout: Layout, notEval: readonly string[]): string {
  if (layout !== 'public') return '';
  const n = notEval.length;
  return ` (public layout: ${n} private ${n === 1 ? 'criterion' : 'criteria'} not evaluated)`;
}
/** `GATE: OPEN` / `GATE: BLOCKED (…)`, plus the public-layout suffix. */
export function verdictLine(r: Pick<GateResult, 'criteria' | 'gateOpen' | 'layout' | 'notEvaluated'>): string {
  const blocked = (Object.keys(r.criteria) as Crit[]).filter((c) => r.criteria[c] !== 'PASS' && r.criteria[c] !== 'N-A');
  return `GATE: ${r.gateOpen ? 'OPEN' : `BLOCKED (${blocked.join(', ')})`}${layoutSuffix(r.layout, r.notEvaluated)}`;
}
/** One check line of the printed report. */
export function renderCheck(x: { id: string; name: string; status: string; detail: string }): string {
  return `    ${(x.status === 'N-A' ? NA_LABEL : x.status).padEnd(7)} [${x.id}] ${x.name}${x.detail ? `  — ${x.detail}` : ''}`;
}

export interface GateOptions {
  /** Run npm test / typecheck / tier-0 / contracts:check / lint:net / inspector as subprocesses. */
  suites?: boolean;
  /** Measure the Hallucinator live path. */
  bench?: boolean;
  /** Repository layout to read (default auto). */
  layout?: LayoutArg;
}

export interface GateResult {
  checks: Check[];
  criteria: Record<Crit, CritVerdict>;
  gateOpen: boolean;
  layout: Layout;
  /** How the layout was chosen and where contracts/ was found (printed in the header). */
  layoutInfo: string;
  /** Criteria with checks not evaluated for want of private evidence (public layout only). */
  notEvaluated: Crit[];
  notes: string[];
  /** Allowlisted grep hits: rule → sorted "file (tokens)" lines. */
  allowlisted: { rule: string; why: string; hits: string[] }[];
  /** Wall-clocks and the benchmark (vary run to run; never part of the determinism diff). */
  measurements: Record<string, string>;
  outDir: string;
}

// ── subprocesses ───────────────────────────────────────────────────────────────
export interface Proc {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  /** The timeout fired and the process group was killed. */
  timedOut?: boolean;
}

/** Process groups still running, killed if the gate itself exits early. */
const LIVE_GROUPS = new Set<number>();
process.once('exit', () => {
  for (const pid of LIVE_GROUPS) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

/**
 * Run a command in its OWN process group and collect its output. On timeout the whole group gets
 * SIGKILL. Regression (2026-09-26, private gate run): the old helper killed only the direct child,
 * so `npm test` died while its `node --test` grandchild, stuck on a hung test file, kept the stdout
 * pipe open; `close` never fired and the gate hung for 30+ minutes past its 900 s timeout. If some
 * descendant escaped the group (setsid) and still holds the pipes, the result resolves 5 s after the
 * direct child exits.
 */
export function runProc(cmd: string, args: string[], o: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<Proc> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(o.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) LIVE_GROUPS.add(pid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) LIVE_GROUPS.delete(pid);
      if (timedOut) stderr += `\n[gate] timed out after ${(o.timeoutMs / 1000).toFixed(0)} s; process group killed`;
      resolve({ code: code ?? -1, stdout, stderr, ms: performance.now() - t0, ...(timedOut ? { timedOut } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (pid !== undefined) process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, o.timeoutMs);
    child.on('error', (e) => {
      stderr += `spawn error: ${e.message}`;
      finish(-1);
    });
    child.on('exit', (code) => {
      exitCode = code;
      if (timedOut) setTimeout(() => finish(exitCode), 5_000).unref();
    });
    child.on('close', (code) => finish(code ?? exitCode));
  });
}

const sh = (cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Proc> =>
  runProc(cmd, args, { cwd: o.cwd ?? ASC, timeoutMs: o.timeoutMs ?? 600_000, env: o.env });

/** The public CLI, from source (the entry the published bundle wraps). */
const cli = (args: string[], timeoutMs = WALL_BUDGET_MS * 2): Promise<Proc> => sh(process.execPath, ['--import', 'tsx', BIN, ...args], { timeoutMs });

interface RefServer {
  urls: Record<'rest' | 'ws' | 'mcp' | 'a2a' | 'healthz', string>;
  port: number;
  stop(): Promise<void>;
}

/** `agent-arena serve-reference --policy <policy> --port 0 --json` as a child process. */
function serveReference(policy: 'coordinated' | 'naive' = 'coordinated'): Promise<RefServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, 'serve-reference', '--policy', policy, '--port', '0', '--json'], {
      cwd: ASC,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGKILL');
        reject(new Error('serve-reference did not report its port within 30 s'));
      }
    }, 30_000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (done) return;
      let info: { port?: number; urls?: RefServer['urls'] } | undefined;
      try {
        info = JSON.parse(buf);
      } catch {
        return; // not complete yet
      }
      done = true;
      clearTimeout(timer);
      resolve({
        urls: info!.urls!,
        port: info!.port!,
        stop: () =>
          new Promise<void>((r) => {
            child.once('close', () => r());
            child.kill('SIGTERM');
          }),
      });
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`serve-reference exited ${code}`));
      }
    });
  });
}

// ── report helpers ─────────────────────────────────────────────────────────────
interface Verdict {
  oracle_id: string;
  seat?: string;
  verdict: 'pass' | 'fail' | 'not_assessed';
  severity?: string;
  reason_code?: string;
}
interface Episode {
  episode_index: number;
  seed: number;
  seat: string;
  outcome: string;
  terminal_tick: number;
  replay_hash: string;
  replay_ref?: string;
  oracles: Verdict[];
}
interface Report {
  run: { spec: { target: { transport: string; ownership_attested?: boolean } }; target_ownership?: unknown };
  episodes: Episode[];
  run_oracles: Verdict[];
  summary: { verdict: string };
}
interface SarifResult {
  ruleId: string;
  kind: string;
  level: string;
  partialFingerprints?: Record<string, string>;
  properties?: { agentArena?: { episode_index?: number; seat?: string; verdict?: string; reason_code?: string } };
}
interface Sarif {
  runs: { tool: { driver: { properties?: { agentArena?: { conflict_of_interest?: string } } } }; results: SarifResult[]; properties?: { agentArena?: { not_assessed?: number } } }[];
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const short = (h: string): string => h.slice(0, 19); // "sha256:" + 12 hex

// ── security hand review parsing (C6 here, S-REVIEW in phase8-gate.ts) ─────────
/**
 * The verdict of a SECURITY-REVIEW*.md file. The review keeps its superseded verdicts in §0 "for
 * the record" and writes prose around the current one ("after the closure pass of …"), so:
 *   - the verdict is read from the "Current verdict" line only, and the token is matched
 *     case-sensitively (`PASS-WITH-CONDITIONS`, `PASS`, `FAIL`, `BLOCKED`), never the word "pass";
 *   - an "Orchestrator note … treated as **PASS**" within the next three non-empty lines turns a
 *     PASS-WITH-CONDITIONS into `PASS (pending counter-signature)`. It never lifts a FAIL/BLOCKED:
 *     only the security-architect can change those;
 *   - a review with no "Current verdict" line (a first review) falls back to the first line that
 *     names a verdict, skipping lines marked "superseded", with the same case-sensitive token.
 * `verdict` is the scored value (PASS-WITH-CONDITIONS stays PASS-WITH-CONDITIONS under a note),
 * `display` is what the gate prints.
 */
export interface ReviewVerdict {
  verdict: 'PASS' | 'PASS-WITH-CONDITIONS' | 'FAIL' | 'BLOCKED' | 'none';
  display: string;
  /** The orchestrator note under the current verdict, if any (used by {@link openReviewFindings}). */
  note?: string;
}
const VERDICT_TOKEN = /(?<![A-Za-z-])(PASS-WITH-CONDITIONS|PASS|FAIL|BLOCKED)(?![A-Za-z-])/;
export function parseReviewVerdict(text: string): ReviewVerdict {
  const lines = text.split('\n');
  let at = lines.findIndex((l) => /\bCurrent verdict\b/i.test(l));
  if (at < 0) at = lines.findIndex((l) => /verdict/i.test(l) && !/superseded/i.test(l) && VERDICT_TOKEN.test(l.replace(/\*/g, '')));
  if (at < 0) return { verdict: 'none', display: 'none (no "Current verdict" line)' };
  const verdict = (VERDICT_TOKEN.exec(lines[at].replace(/\*/g, ''))?.[1] ?? 'none') as ReviewVerdict['verdict'];
  const next = lines.slice(at + 1).filter((l) => l.trim()).slice(0, 3);
  const note = next.find((l) => /Orchestrator note\b/i.test(l));
  const treatedAsPass = !!note && /treated as \*\*PASS\*\*(?!-)/.test(note);
  if (verdict === 'PASS-WITH-CONDITIONS' && treatedAsPass) {
    return { verdict, display: 'PASS (pending counter-signature); "Current verdict" line: PASS-WITH-CONDITIONS, orchestrator note: treated as PASS', note };
  }
  return { verdict, display: verdict, note };
}

export interface ReviewFinding { id: string; state: string }
/**
 * Findings still open in the review's status table ("## N. Status of every finding …"), which
 * is kept current, unlike the §0 condition tables of superseded reviews. A row is open when its
 * State cell starts with "Open" or "New", or says "reopened by G-n" while G-n is itself open.
 * IDs that the orchestrator note under the current verdict declares "closed" are split out as
 * `closedByNote` (closed on the orchestrator's word, pending the security-architect's
 * counter-signature). Returns `table: false` when the file has no status table.
 */
export function openReviewFindings(text: string, note?: string): { table: boolean; open: ReviewFinding[]; closedByNote: ReviewFinding[] } {
  const lines = text.split('\n');
  const h = lines.findIndex((l) => /^##\s+(?:\d+\.\s*)?Status of every finding/i.test(l));
  if (h < 0) return { table: false, open: [], closedByNote: [] };
  const end = lines.findIndex((l, i) => i > h && /^##\s/.test(l));
  const rows = lines.slice(h + 1, end < 0 ? undefined : end).filter((l) => /^\|/.test(l.trim()));
  const findings: ReviewFinding[] = [];
  for (const r of rows) {
    const cells = r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/\*/g, '').trim());
    const ids = cells[0]?.match(/\bG-\d+[a-z]?\b/g);
    if (!ids || cells.length < 3) continue; // header / separator
    for (const id of ids) findings.push({ id, state: cells[2] });
  }
  const noteClosed = new Set<string>();
  for (const seg of (note ?? '').split(/[.;—]|\s-\s/)) if (/\bclosed\b/i.test(seg)) for (const id of seg.match(/\bG-\d+[a-z]?\b/g) ?? []) noteClosed.add(id);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const reopeners = (f: ReviewFinding): string[] => /\breopened by ((?:G-\d+[a-z]?(?:,\s*|\s+and\s+)?)+)/i.exec(f.state)?.[1].match(/G-\d+[a-z]?/g) ?? [];
  // Open in the table's own words: "Open…"/"New…", or reopened by a finding that is open.
  const isOpen = (id: string, useNote: boolean, seen = new Set<string>()): boolean => {
    const f = byId.get(id);
    if (!f) return !(useNote && noteClosed.has(id)); // an unknown reopener counts as open unless the note closed it
    if (seen.has(id)) return false;
    seen.add(id);
    if (useNote && noteClosed.has(id)) return false;
    if (/^(Open|New)\b/i.test(f.state)) return true;
    return reopeners(f).some((g) => isOpen(g, useNote, seen));
  };
  const uniq = [...byId.values()];
  return {
    table: true,
    open: uniq.filter((f) => isOpen(f.id, true)),
    closedByNote: uniq.filter((f) => isOpen(f.id, false) && !isOpen(f.id, true)),
  };
}

function verdictTuples(r: Report): string[] {
  const t = (v: Verdict, where: string) => `${where}|${v.oracle_id}|${v.seat ?? ''}|${v.verdict}|${v.severity ?? ''}|${v.reason_code ?? ''}`;
  return [...r.episodes.flatMap((e) => e.oracles.map((v) => t(v, `ep${e.episode_index}`))), ...r.run_oracles.map((v) => t(v, 'run'))];
}
const fingerprints = (s: Sarif): string[] => s.runs[0].results.map((x) => JSON.stringify(x.partialFingerprints ?? {})).sort();

/** The frozen Byzantine squad gate anchor (arena-scenarios keyed `anchorFor`; C2e froze all five seeds in all three tiers). */
function coordAnchor(tier: string, seed: number, driver: 'ref:coordinated' | 'ref:naive' = 'ref:coordinated') {
  return frozenAnchorFor({ scenario: 'byzantine', seat: 'squad', tier: tier as 'core', seed, policy: driver === 'ref:naive' ? 'naive' : 'coordinated' });
}

// ── criterion 5: the grep gate over the code root and contracts/ ───────────────
const CUT = /[A-Za-z0-9_$]*(?:hunt|bazaar|market|adapter|vault|coach|caster|guild|tournament|director|golden[ _-]?list|season)[A-Za-z0-9_$]*/gi;
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|html|css)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.dev-keys', 'out']);

interface AllowRule {
  rule: string;
  token: RegExp;
  path: RegExp;
  /** If set, it must also match the hit's line together with the (up to) four lines above it. */
  context?: RegExp;
  why: string;
}
/**
 * Every word that legitimately survives the cut. A hit is allowed only if BOTH
 * its token and its path (and the context, when the rule has one) match one rule.
 * Anything else fails criterion 5. Paths are relative to the code root, with
 * contracts/ as `contracts/…` in both layouts (it is scanned in both).
 */
export const ALLOWLIST: AllowRule[] = [
  { rule: 'filesystem-directory', token: /^(is|working)?directory$|^directory$|^directories$/i, path: /./, why: '"director" is a substring of "directory"/"directories" (fs API, SARIF schema field, prose); not the Director module.' },
  {
    rule: 'scenario-adapter',
    token: /^(adapter|adapters|adaptercoercions?|adapter_coercions?)$/i,
    path: /^packages\/(arena-scenarios|arena-cli|arena-report)\/|^frontend\/|^packages\/wot-engine\/test\/anchors-tiers\.test\.ts$/,
    why: 'The Scenario adapter of B2 (arena-scenarios wraps the engine; "adapter coercions" are its legal-prefix truncations; "adapters/ws.ts" names a threat-model row). Not the cut Adapters (passport power-ups).',
  },
  {
    rule: 'league-scenario-record-field',
    token: /^adapterCoercions$/,
    path: /^packages\/arena-league\/src\/reports\.ts$/,
    why: 'arena-league fills the arena-scenarios episode-record field `adapterCoercions` (the Scenario adapter\'s legal-prefix truncations, rule scenario-adapter) with []; the field name is the record contract, not the cut Adapters. Only this token in this file (coordinator decision 2026-09-26: the grep stays strict).',
  },
  {
    rule: 'passport-adapters-claim-field',
    token: /^adapters$/,
    path: /^packages\/wot-auth\/(src\/tokens\.ts|test\/roundtrip\.test\.ts)$|^packages\/wot-store\/src\/(types|memory)\.ts$|^services\/passports\/src\/app\.ts$/,
    why: 'The `adapters` access-token claim FIELD, minted always-empty for token-shape compatibility (contracts RESERVED.md retires the claim "as a gate"). Only the field is allowed here; the gate itself (hasAdapter / adapter_required) is not.',
  },
  {
    rule: 'grid-hunter-agent',
    token: /^(hunter|createhunterpolicy|caphunter|nhunter|hunt|hunting)$/i,
    path: /^agents\/|^qa\/gate\.ts$|^sandbox\/demo-match\.ts$/,
    why: 'The Grid Tactics "hunter" duel policy (agents/hunter) and the heuristic verb "hunt a favourable matchup"; unrelated to The Great Hunt module.',
  },
  { rule: 'test-password-literal', token: /^hunter2(hunter2)?$/, path: /^packages\/arena-cli\/test\/credentials\.test\.ts$|^packages\/wot-auth\/test\/redact\.test\.ts$/, why: 'The classic throwaway password literal "hunter2" in credential-refusal and redaction tests (they assert the value is never echoed).' },
  { rule: 'diplomacy-season', token: /^seasons?$/i, path: /^packages\/wot-engine\/(src\/diplomacy\/|test\/diplomacy-)/, why: 'Diplomacy game seasons (Spring/Fall/Winter), a rule term of the Phase 8 adjudicator; not the cut league seasons.' },
  {
    rule: 'retired-surface-negative-tests',
    token: /^caster$/,
    path: /^services\/arena\/test\/edgeguard\.test\.ts$|^services\/passports\/test\/passports\.test\.ts$/,
    why: 'Tests that assert the retired `caster.say` frame is rejected and `caster:publish` is never granted: they prove the surface is gone.',
  },
  { rule: 'generated-removal-note', token: /^coach_interventions$/, path: /^packages\/wot-contracts\/src\/generated\/frames\.ts$/, why: 'Generated doc comment (from the 2.0.0 schema) recording that the field was REMOVED from match_end.' },
  {
    rule: 'negotiations-cut-note',
    token: /^(bazaar|market|adapter)$/i,
    path: /^services\/gateway\/(src|test)\/negotiations(\.test)?\.ts$/,
    why: 'Negotiation Chambers (kept for Phase 8) state that they are decoupled from the cut Bazaar ("no market fill", "the Bazaar escrow was cut"); one test uses the opaque item id "adapter:oracle_lens" as data.',
  },
  { rule: 'leagues-cut-note', token: /^golden list$/i, path: /^packages\/wot-store\/src\/leagues\.ts$/, why: 'Comment recording that the Golden List was cut ("league" survives as the budget tier).' },
  { rule: 'gate-harness-self', token: /./, path: /^qa\/phase7-gate\.ts$|^qa\/test\/gate-layout\.test\.ts$/, why: 'This harness and its allowlist regression test: the grep pattern, this allowlist and the test inputs name every cut word by design.' },
  { rule: 'stale-director-comment', token: /^director$/i, path: /^packages\/wot-engine\/src\/terminal\.ts$/, why: 'Stale doc comment ("used later by the Director / house bot"); no code path. Cosmetic: remove when wot-engine is next touched under a rule-owner change.' },
  {
    rule: 'contracts-removal-notes',
    token: /^(caster|caster_ack|caster_commentary|caster_hello|coach_interventions|coach|adapters?|bazaar|director|golden list|guilds|hunt|market|seasons|tournaments|vault)$/i,
    path: /^contracts\/(openapi\.yaml|asyncapi\.yaml|schemas\/(match_end|webhook_event)\.schema\.json)$/,
    context: /REMOVED|Removed in 2\.0\.0|removed with the economy|History \(1\.0 → 1\.5\)|CONTRACTS 2\.0\.0 \(ADR-001\)/,
    why: 'Contract changelog prose recording what 2.0.0 REMOVED (ADR-001 §6): openapi/asyncapi info.description, the scope list, OfferSide, match_end and webhook_event descriptions. Allowed only on a line within four lines of a REMOVED/Removed-in-2.0.0 marker, so a re-introduced path, scope or frame still fails.',
  },
  {
    rule: 'contracts-scenario-adapter',
    token: /^adapter$/,
    path: /^contracts\/schemas\/(run_spec|report)\.schema\.json$/,
    why: 'The Scenario adapter of B2 ("named as the scenario adapter and the CLI (`--fill`) name it") and the example hostnames ng-adapter-{a,b,c}.example.com (Neutral Ground run examples). Not the cut Adapters.',
  },
  {
    rule: 'contracts-client-side-director',
    token: /^Director$/,
    path: /^contracts\/schemas\/spectator_frame\.schema\.json$/,
    why: 'Stale 1.x description ("any client-side Director", a consumer of the notable-events feed); no field or frame. Route to api-architect to reword at the next contracts bump.',
  },
];

/** The allowlist rule that admits a grep hit, if any. */
export function allowRuleFor(h: Pick<GrepHit, 'file' | 'token' | 'ctx'>): AllowRule | undefined {
  return ALLOWLIST.find((r) => r.token.test(h.token) && r.path.test(h.file) && (!r.context || r.context.test(h.ctx)));
}

export interface GrepHit {
  file: string;
  line: number;
  token: string;
  /** The hit's line and up to four lines above it (for rules with a `context`). */
  ctx: string;
}
/**
 * Grep `code` (the code root) and `contracts`. In the public layout contracts/ is inside the
 * code root and is walked once; in the private layout it is a sibling of ascension/ and is walked
 * separately, so both layouts scan the same files under the same relative paths.
 */
export function grepCut(code: string = ASC, contracts?: string): GrepHit[] {
  const hits: GrepHit[] = [];
  const walk = (dir: string, base: string, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, base, prefix);
      else if ((CODE_EXT.test(name) && name !== 'package-lock.json') || name === 'Dockerfile') {
        const rel = prefix + relative(base, p);
        // frontend/public/samples is generated data (regenerated by `npm run samples`), not code.
        if (rel.startsWith('frontend/public/')) continue;
        const lines = readFileSync(p, 'utf8').split('\n');
        lines.forEach((l, i) => {
          for (const m of l.matchAll(CUT)) hits.push({ file: rel, line: i + 1, token: m[0], ctx: lines.slice(Math.max(0, i - 4), i + 1).join('\n') });
        });
        // "Golden List" spans a space: the identifier regex already catches golden[ _-]?list.
      }
    }
  };
  walk(code, code);
  if (contracts && relative(code, contracts).startsWith('..')) walk(contracts, contracts, 'contracts/');
  return hits;
}

// ── criterion 3: parse the sweep's Markdown tables ─────────────────────────────
interface SweepRow {
  scenario: string;
  seating: string;
  tier: string;
  coordFails: string;
  naivePrimaryError: string;
  naiveNotAssessed: string;
  rule: string;
}
function parseSweep(md: string): SweepRow[] {
  const rows: SweepRow[] = [];
  let scenario = '';
  let seating = '';
  for (const line of md.split('\n')) {
    const h = /^#### (\w+) — (squad|member \(m1\)) — primary/.exec(line);
    if (h) {
      [scenario, seating] = [h[1], h[2] === 'squad' ? 'squad' : 'member_m1'];
      continue;
    }
    const c = line.split('|').map((x) => x.trim());
    // CALIBRATION.md rows exist for the three anchored tiers only (`extended` was never calibrated against anchors).
    if (c.length >= 12 && ['edge', 'core', 'frontier'].includes(c[1])) {
      rows.push({ scenario, seating, tier: c[1], coordFails: c[3], naivePrimaryError: c[5], naiveNotAssessed: c[8], rule: c[10] });
    }
  }
  return rows;
}

// ── the benchmark (CALIBRATION.md §8; same loop as arena-scenarios/test/bench.test.ts) ──
function benchLive(): { hallucinatorUs: number; sixMeanUs: number } {
  const KEY = '7a'.repeat(32);
  const once = () => {
    let allLive = 0;
    let allTicks = 0;
    let hal = 0;
    for (const id of RAID_SCENARIO_IDS) {
      let live = 0;
      let ticks = 0;
      for (let rep = 0; rep < 5; rep++) {
        for (const which of ['coordinated', 'naive'] as const) {
          const scn = new RaidScenario(id);
          scn.init(20260720 + rep, 'core', { mode: 'squad', targetDriver: `ref:${which}`, blindingKey: KEY });
          const t0 = performance.now();
          while (!scn.terminal()) {
            scn.observe('squad');
            scn.tick();
            ticks++;
          }
          live += performance.now() - t0;
          computeRaidVerdicts(scn.record());
        }
      }
      if (id === 'hallucinator') hal = (live * 1000) / ticks;
      allLive += live;
      allTicks += ticks;
    }
    return { hal, mean: (allLive * 1000) / allTicks };
  };
  once(); // warm-up (JIT)
  const runs = [once(), once(), once(), once(), once()];
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return { hallucinatorUs: med(runs.map((r) => r.hal)), sixMeanUs: med(runs.map((r) => r.mean)) };
}

// ── the gate ───────────────────────────────────────────────────────────────────
export async function runGate(opts: GateOptions = {}): Promise<GateResult> {
  const suites = opts.suites ?? true;
  const bench = opts.bench ?? true;
  const C = new Checks();
  const notes: string[] = [];
  const M: Record<string, string> = {};
  const OUT = mkdtempSync(join(tmpdir(), 'phase7-gate-'));
  const sarifFiles: string[] = [];
  const tGate = performance.now();
  const P = layoutPaths(ASC, opts.layout ?? 'auto');
  const shown = (p: string): string => relative(P.display, p);

  // ═════════ Criterion 1 — the gate run over REST, five seeds, three tiers ═════════
  const srv = await serveReference();
  let restReport: Report | undefined;
  let restSarif: Sarif | undefined;
  const coreDir = join(OUT, 'c1-rest-core');
  try {
    C.ok('C1', 'C1-SERVE', 'serve-reference --policy coordinated --port 0 serves rest, ws, mcp and a2a on one loopback port',
      ['rest', 'ws', 'mcp', 'a2a', 'healthz'].every((k) => typeof srv.urls[k as 'rest'] === 'string' && srv.urls[k as 'rest'].includes('127.0.0.1')),
      'urls: rest ws mcp a2a healthz on 127.0.0.1:<ephemeral>');
    const restUrl = `http://127.0.0.1:${srv.port}`;
    const gateArgs = (tier: string, seeds: string, episodes: number, target: string, transport: string, out: string) => [
      'run', '--scenario', 'byzantine', '--seat', 'squad', '--tier', tier, '--seeds', seeds, '--episodes', String(episodes),
      '--target', target, '--transport', transport, '--i-own-this-target', '--out', out, '--json',
    ];

    // The timed gate command: run alone, nothing else in flight.
    const r = await cli(gateArgs('core', GATE_SEEDS, 5, restUrl, 'rest', coreDir));
    M['C1 gate command (rest, core, 5 episodes), child-process wall-clock'] = `${(r.ms / 1000).toFixed(2)} s`;
    C.ok('C1', 'C1-EXIT', 'the gate command exits 0 (coordinated reference: no finding at or above error)', r.code === 0, `exit ${r.code}`);
    C.ok('C1', 'C1-WALL', 'the gate command completes in < 5 minutes', r.code === 0 && r.ms < WALL_BUDGET_MS, 'budget 300 s (number in the measurement block)');
    const files = ['report.json', 'report.sarif'].every((f) => existsSync(join(coreDir, f)));
    C.ok('C1', 'C1-FILES', 'report.json and report.sarif are written', files);
    if (files) {
      restReport = readJson<Report>(join(coreDir, 'report.json'));
      restSarif = readJson<Sarif>(join(coreDir, 'report.sarif'));
      sarifFiles.push(join(coreDir, 'report.sarif'));
      const eps = restReport.episodes;
      C.ok('C1', 'C1-N', 'five seeded episodes, in gate-seed order', eps.length === 5 && eps.every((e, i) => e.seed === GATE_SEEDS_BYZANTINE[i]), eps.map((e) => e.seed).join(','));
      for (const [i, s] of GATE_SEEDS_BYZANTINE.entries()) {
        const a = coordAnchor('core', s);
        const e = eps[i];
        C.ok('C1', `C1-CORE-${s}`, `core seed ${s}: replay hash, outcome and tick equal the frozen anchor`,
          !!a && !!e && e.replay_hash === a.replayHash && e.outcome === a.outcome && e.terminal_tick === a.ticks,
          e ? `${e.outcome}@${e.terminal_tick} ${e.replay_hash}` : 'missing');
      }
      const okSchema = validateReportSchema(restReport) as boolean;
      C.ok('C1', 'C1-REPORT-SCHEMA', 'report.json validates against contracts/schemas/report.schema.json', okSchema,
        okSchema ? 'valid' : JSON.stringify(validateReportSchema.errors?.slice(0, 3)));
      const sv = validateSarif(restSarif);
      C.ok('C1', 'C1-SARIF', 'report.sarif validates (arena-report validateSarif: OASIS 2.1.0 schema + GitHub constraints)', sv.ok, sv.ok ? 'valid' : sv.errors.slice(0, 3).join('; '));
      C.ok('C1', 'C1-VERDICT', 'summary verdict pass; ownership attested and loopback recorded',
        restReport.summary.verdict === 'pass' && restReport.run.spec.target.ownership_attested === true && (restReport.run.target_ownership as { loopback?: boolean; attested?: boolean } | undefined)?.loopback === true && (restReport.run.target_ownership as { attested?: boolean } | undefined)?.attested === true,
        `verdict=${restReport.summary.verdict} target_ownership=${JSON.stringify(restReport.run.target_ownership)}`);
    }

    // Edge and Frontier: all five gate seeds, each asserted against its frozen tier anchor.
    // The gate is over the three ANCHORED tiers; `extended` (contracts 2.10.0, Dh 30 s) has no
    // frozen anchor and is deliberately outside every frozen-anchor check of this harness.
    // (C2e froze seeds 1, 2, 3, 5 at Edge/Frontier; before that they were only recorded).
    const tiers = await Promise.all(
      (['edge', 'frontier'] as const).map(async (tier) => {
        const dir = join(OUT, `c1-rest-${tier}`);
        const p = await cli(gateArgs(tier, GATE_SEEDS, 5, restUrl, 'rest', dir));
        const v = p.code === 0 ? await cli(['verify', join(dir, 'report.json'), '--json']) : undefined;
        return { tier, dir, p, v };
      }),
    );
    for (const { tier, dir, p, v } of tiers) {
      M[`C1 ${tier} five gate seeds (rest), child-process wall-clock`] = `${(p.ms / 1000).toFixed(2)} s`;
      const a = coordAnchor(tier, 20260720);
      const ok = p.code === 0 && existsSync(join(dir, 'report.json'));
      const rep = ok ? readJson<Report>(join(dir, 'report.json')) : undefined;
      const e = rep?.episodes[0];
      C.ok('C1', `C1-${tier.toUpperCase()}-20260720`, `${tier} seed 20260720: replay hash, outcome and tick equal the frozen tier anchor`,
        !!a && !!e && e.replay_hash === a.replayHash && e.outcome === a.outcome && e.terminal_tick === a.ticks,
        e ? `${e.outcome}@${e.terminal_tick} ${e.replay_hash}` : `exit ${p.code}`);
      if (rep) {
        const sv = validateSarif(readJson(join(dir, 'report.sarif')));
        sarifFiles.push(join(dir, 'report.sarif'));
        C.ok('C1', `C1-${tier.toUpperCase()}-FILES`, `${tier}: report.json and report.sarif validate`, (validateReportSchema(rep) as boolean) && sv.ok);
        let vs = '';
        try {
          vs = v ? (JSON.parse(v.stdout) as { status: string }).status : 'not run';
        } catch {
          vs = 'unparseable';
        }
        const rest4 = rep.episodes.slice(1);
        const anchored = rest4.map((e) => ({ e, a: coordAnchor(tier, e.seed) }));
        C.ok('C1', `C1-${tier.toUpperCase()}-SEEDS`, `${tier} seeds 1,2,3,5: replay hash, outcome and tick equal the frozen tier anchors; no finding; verify → verified`,
          rest4.length === 4 && anchored.every(({ e, a }) => !!a && e.replay_hash === a.replayHash && e.outcome === a.outcome && e.terminal_tick === a.ticks) && rep.summary.verdict === 'pass' && vs === 'verified',
          anchored.map(({ e, a }) => `${e.seed}:${e.outcome}@${e.terminal_tick} ${short(e.replay_hash)}${a?.replayHash === e.replay_hash ? '=anchor' : a ? '≠anchor' : ' (no anchor)'}`).join(' | '));
      }
    }

    // ═════════ Extras on the core report: verify and replay ═════════
    if (restReport) {
      const [v, rp] = await Promise.all([cli(['verify', join(coreDir, 'report.json'), '--json']), cli(['replay', join(coreDir, 'report.json'), '--episode', '0', '--json'])]);
      let status = '';
      try {
        status = (JSON.parse(v.stdout) as { status: string }).status;
      } catch {
        status = 'unparseable';
      }
      C.ok('X', 'X-VERIFY', '`verify report.json` re-simulates every episode and returns verified (exit 0)', v.code === 0 && status === 'verified', `status=${status} exit=${v.code}`);
      const ref = restReport.episodes[0].replay_ref!;
      const sibling = readFileSync(join(coreDir, ref), 'utf8');
      C.ok('X', 'X-REPLAY', '`replay --episode 0 --json` equals the sibling .replay.json byte for byte', rp.code === 0 && rp.stdout === sibling,
        `${ref}: ${rp.stdout === sibling ? 'identical' : 'differs'} (sha256 ${sha256(sibling).slice(0, 16)}…)`);
    }

    // ═════════ Criterion 2 — ws, mcp, a2a: identical hashes and verdicts ═════════
    const others = await Promise.all(
      (['ws', 'mcp', 'a2a'] as const).map(async (t) => {
        const dir = join(OUT, `c2-${t}`);
        const p = await cli(gateArgs('core', GATE_SEEDS, 5, srv.urls[t], t, dir));
        const v = p.code === 0 ? await cli(['verify', join(dir, 'report.json'), '--json']) : undefined;
        return { t, dir, p, v };
      }),
    );
    for (const { t, dir, p, v } of others) {
      M[`C2 ${t} (core, 5 episodes), child-process wall-clock`] = `${(p.ms / 1000).toFixed(2)} s`;
      const ok = p.code === 0 && existsSync(join(dir, 'report.json'));
      const rep = ok ? readJson<Report>(join(dir, 'report.json')) : undefined;
      const sar = ok ? readJson<Sarif>(join(dir, 'report.sarif')) : undefined;
      if (sar) sarifFiles.push(join(dir, 'report.sarif'));
      const hashes = rep?.episodes.map((e) => e.replay_hash) ?? [];
      const restHashes = restReport?.episodes.map((e) => e.replay_hash) ?? ['<no rest report>'];
      C.ok('C2', `C2-${t.toUpperCase()}-HASH`, `${t}: the five replay hashes are byte-identical to REST's (and to the anchors)`,
        ok && JSON.stringify(hashes) === JSON.stringify(restHashes) && rep!.run.spec.target.transport === t, `exit ${p.code}; ${hashes.length} hashes ${JSON.stringify(hashes) === JSON.stringify(restHashes) ? 'identical' : 'DIFFER'}`);
      C.ok('C2', `C2-${t.toUpperCase()}-VERDICT`, `${t}: every verdict (oracle, seat, verdict, severity, reason) and the summary equal REST's`,
        !!rep && !!restReport && JSON.stringify(verdictTuples(rep)) === JSON.stringify(verdictTuples(restReport)) && rep.summary.verdict === restReport.summary.verdict,
        rep ? `${verdictTuples(rep).length} verdicts, summary ${rep.summary.verdict}` : '');
      C.ok('C2', `C2-${t.toUpperCase()}-SARIF`, `${t}: SARIF validates and its partialFingerprints equal REST's`,
        !!sar && !!restSarif && validateSarif(sar).ok && JSON.stringify(fingerprints(sar)) === JSON.stringify(fingerprints(restSarif)), sar ? `${sar.runs[0].results.length} results` : '');
      let vs = '';
      try {
        vs = v ? (JSON.parse(v.stdout) as { status: string }).status : 'not run';
      } catch {
        vs = 'unparseable';
      }
      C.ok('C2', `C2-${t.toUpperCase()}-VERIFY`, `${t}: verify → verified`, v?.code === 0 && vs === 'verified', `status=${vs}`);
    }

    // The coordinated pass emits no SARIF result, so fingerprint equality above is vacuous.
    // The naive reference (served the same way) produces findings: all four transports must
    // agree on hashes (= the naive gate anchors), verdicts and every SARIF fingerprint.
    const nsrv = await serveReference('naive');
    try {
      const nv = await Promise.all(
        (['rest', 'ws', 'mcp', 'a2a'] as const).map(async (t) => {
          const dir = join(OUT, `c2-naive-${t}`);
          const target = t === 'rest' ? `http://127.0.0.1:${nsrv.port}` : nsrv.urls[t];
          const p = await cli(gateArgs('core', GATE_SEEDS, 5, target, t, dir));
          const ok = existsSync(join(dir, 'report.json'));
          if (ok) sarifFiles.push(join(dir, 'report.sarif'));
          return { t, p, rep: ok ? readJson<Report>(join(dir, 'report.json')) : undefined, sar: ok ? readJson<Sarif>(join(dir, 'report.sarif')) : undefined };
        }),
      );
      const base = nv[0];
      const anchorsOk = !!base.rep && GATE_SEEDS_BYZANTINE.every((s, i) => {
        const a = coordAnchor('core', s, 'ref:naive');
        const e = base.rep!.episodes[i];
        return !!a && !!e && e.replay_hash === a.replayHash && e.outcome === a.outcome && e.terminal_tick === a.ticks;
      });
      // Not a criterion-2 question (the four transports agree with each other, checked below):
      // whether the SERVED naive squad, which sees only the filtered egress, reproduces the
      // calibrated in-process naive anchors. Recorded as a finding.
      C.finding('X', 'X-NAIVE-SERVED', 'served naive reference (serve-reference --policy naive, over the wire) reproduces the frozen naive gate anchors',
        base.p.code === 1 && anchorsOk, `exit ${base.p.code}; ${base.rep?.episodes.map((e) => `${e.seed}:${e.outcome}@${e.terminal_tick}${coordAnchor('core', e.seed, 'ref:naive')?.replayHash === e.replay_hash ? '=anchor' : ''}`).join(' ')}; primary errors ${base.rep?.episodes.filter((e) => e.oracles.some((v) => v.oracle_id === 'byzantine.off_quorum_position' && v.verdict === 'fail' && v.severity === 'error')).length ?? 0}/5; summary ${base.rep?.summary.verdict}`);
      for (const x of nv.slice(1)) {
        const same =
          x.p.code === base.p.code &&
          JSON.stringify(x.rep?.episodes.map((e) => e.replay_hash)) === JSON.stringify(base.rep?.episodes.map((e) => e.replay_hash)) &&
          !!x.rep && !!base.rep && JSON.stringify(verdictTuples(x.rep)) === JSON.stringify(verdictTuples(base.rep)) &&
          !!x.sar && !!base.sar && JSON.stringify(fingerprints(x.sar)) === JSON.stringify(fingerprints(base.sar));
        C.ok('C2', `C2-NAIVE-${x.t.toUpperCase()}`, `naive reference over ${x.t}: hashes, verdicts, exit code and every SARIF fingerprint equal REST's`,
          same && (x.sar?.runs[0].results.length ?? 0) > 0, `exit ${x.p.code}; ${x.sar?.runs[0].results.length ?? 0} SARIF results`);
      }
    } finally {
      await nsrv.stop();
    }
  } finally {
    await srv.stop();
  }

  // ═════════ Criterion 3 — seven scenarios: calibration, duel pair, docs ═════════
  const [sw15, swGate] = await Promise.all([
    sh(process.execPath, ['--import', 'tsx', 'scripts/calibration-sweep.ts'], { cwd: SCEN_PKG }),
    sh(process.execPath, ['--import', 'tsx', 'scripts/calibration-sweep.ts', '--seeds', 'gate'], { cwd: SCEN_PKG }),
  ]);
  M['C3 calibration sweep, 15 seeds (subprocess)'] = `${(sw15.ms / 1000).toFixed(1)} s`;
  M['C3 calibration sweep, gate seeds (subprocess)'] = `${(swGate.ms / 1000).toFixed(1)} s`;
  const d15 = sha256(sw15.stdout);
  const dGate = sha256(swGate.stdout);
  C.ok('C3', 'C3-SWEEP15', 'calibration sweep (6 raids × squad/member m1 × 3 tiers × 15 seeds): rule holds in 36/36 cells, digest frozen',
    sw15.code === 0 && sw15.stdout.includes('cells: 36, holding: 36, broken: 0') && d15 === SWEEP15_SHA256, `sha256 ${d15.slice(0, 16)}… (frozen ${SWEEP15_SHA256.slice(0, 16)}…)`);
  C.ok('C3', 'C3-SWEEPGATE', 'calibration sweep on the five gate seeds: rule holds in 36/36 cells, digest frozen',
    swGate.code === 0 && swGate.stdout.includes('cells: 36, holding: 36, broken: 0') && dGate === SWEEP_GATE_SHA256, `sha256 ${dGate.slice(0, 16)}… (frozen ${SWEEP_GATE_SHA256.slice(0, 16)}…)`);
  const rows = parseSweep(swGate.stdout);
  for (const id of RAID_SCENARIO_IDS) {
    const sq = rows.filter((r) => r.scenario === id && r.seating === 'squad');
    const mm = rows.filter((r) => r.scenario === id && r.seating === 'member_m1');
    C.ok('C3', `C3-${id}-SQUAD`, `${id} squad, gate seeds, every tier: coordinated 0 behavioural fails; naive primary at error 5/5`,
      sq.length === 3 && sq.every((r) => r.coordFails === '0' && r.naivePrimaryError === '5/5' && r.rule === 'holds'),
      sq.map((r) => `${r.tier} coord-fails ${r.coordFails} naive-err ${r.naivePrimaryError}`).join('; '));
    C.ok('C3', `C3-${id}-MEMBER`, `${id} member m1, gate seeds, every tier: coordinated 0 behavioural fails; naive rule holds`,
      mm.length === 3 && mm.every((r) => r.coordFails === '0' && r.rule === 'holds'),
      mm.map((r) => `${r.tier} naive-err ${r.naivePrimaryError}${r.naiveNotAssessed !== '0' ? ` n/a ${r.naiveNotAssessed}` : ''}`).join('; '));
  }
  // Grid Tactics: the duel pair is judged by win rate against the house bot (run-level
  // `grid_tactics.win_rate`), both sides of every gate seed, through the CLI.
  const duelSeeds = GATE_SEEDS_BYZANTINE.flatMap((s) => [s, s]).join(','); // even index = seat A, odd = seat B
  const duels = await Promise.all(
    (['edge', 'core', 'frontier'] as const).flatMap((tier) =>
      (['ref:reflex', 'ref:null'] as const).map(async (target) => {
        const dir = join(OUT, `c3-grid-${tier}-${target.slice(4)}`);
        const p = await cli(['run', '--scenario', 'grid_tactics', '--seat', 'duel', '--tier', tier, '--seeds', duelSeeds, '--episodes', '10', '--target', target, '--out', dir, '--json']);
        return { tier, target, dir, p };
      }),
    ),
  );
  for (const { tier, target, dir, p } of duels) {
    const ok = existsSync(join(dir, 'report.json'));
    const rep = ok ? readJson<Report>(join(dir, 'report.json')) : undefined;
    if (ok) sarifFiles.push(join(dir, 'report.sarif'));
    const wr = rep?.run_oracles.find((v) => v.oracle_id === 'grid_tactics.win_rate') as (Verdict & { measures?: { wins?: number; episodes?: number } }) | undefined;
    const want = target === 'ref:reflex' ? 'pass' : 'fail';
    // Frozen duel anchors for seat A (episode 0 = seed 20260720, episode 4 = seed 2).
    const anchorOk = [0, 4].every((i) => {
      const e = rep?.episodes[i];
      const a = SELF_TESTS.find((c) => c.scenario === 'grid_tactics' && c.tier === tier && c.seed === e?.seed && c.opts.targetSeat === 'A' && c.opts.targetDriver === target);
      return !!a && !!e && e.replay_hash === a.expect.replayHash && e.outcome === a.expect.outcome;
    });
    C.ok('C3', `C3-grid-${tier}-${target.slice(4)}`, `grid_tactics ${tier} ${target} vs silver, gate seeds × both sides: win_rate ${want}; seat-A anchors (seeds 20260720, 2) match`,
      p.code !== 2 && p.code !== 3 && wr?.verdict === want && anchorOk, `win_rate ${wr?.verdict}${wr?.severity && wr.verdict === 'fail' ? `/${wr.severity}` : ''} ${wr?.measures?.wins}/${wr?.measures?.episodes}; anchors ${anchorOk ? 'match' : 'MISMATCH'}`);
  }
  notes.push('Grid Tactics has no per-seed behavioural primary: its pair is judged by the run-level `grid_tactics.win_rate` (fail severity `warning` by the severity table), so "naive fails its primary at error" applies to the six raids only.');
  const docsOk = SCENARIO_IDS.map((id) => {
    const p = join(P.docs, 'scenarios', `${id}.md`);
    const t = existsSync(p) ? readFileSync(p, 'utf8') : '';
    return { id, ok: /^## What it tests/m.test(t) && /^## What a failure means/m.test(t) };
  });
  C.ok('C3', 'C3-DOCS', 'every registered scenario (the seven Phase 7 ones and any later registration) has docs/scenarios/<id>.md with "What it tests" and "What a failure means"',
    SCENARIO_IDS.length >= 7 && ['grid_tactics','hallucinator','overfit','byzantine','deadlock','split_brain','latency'].every((id) => SCENARIO_IDS.includes(id as never)) && docsOk.every((d) => d.ok), docsOk.map((d) => `${d.id}:${d.ok ? 'ok' : 'MISSING'}`).join(' '));

  // ═════════ Criterion 4 — SARIF ═════════
  const schemaDigest = sha256(readFileSync(SARIF_SCHEMA_PATH));
  C.ok('C4', 'C4-SCHEMA', 'the vendored OASIS SARIF 2.1.0 schema is the pinned file', schemaDigest === SARIF_SCHEMA_SHA256, `sha256 ${schemaDigest.slice(0, 16)}…`);
  // not_assessed → notApplicable (precondition/seat/tier) or open (anything else).
  const na = await Promise.all([
    { name: 'split_brain member m1 coordinated', dir: join(OUT, 'c4-sb-member'), args: ['--scenario', 'split_brain', '--seat', 'member', '--target', 'ref:coordinated'] },
    { name: 'grid_tactics duel null', dir: join(OUT, 'c4-grid-null'), args: ['--scenario', 'grid_tactics', '--seat', 'duel', '--target', 'ref:null'] },
  ].map(async (x) => ({ ...x, p: await cli(['run', ...x.args, '--seeds', GATE_SEEDS, '--out', x.dir, '--json']) })));
  const kinds = { notApplicable: 0, open: 0 };
  for (const x of na) {
    const rep = readJson<Report>(join(x.dir, 'report.json'));
    const sar = readJson<Sarif>(join(x.dir, 'report.sarif'));
    sarifFiles.push(join(x.dir, 'report.sarif'));
    const res = sar.runs[0].results;
    const wanted = [
      ...rep.episodes.flatMap((e) => e.oracles.filter((v) => v.verdict === 'not_assessed').map((v) => ({ v, ep: e.episode_index as number | undefined }))),
      ...rep.run_oracles.filter((v) => v.verdict === 'not_assessed').map((v) => ({ v, ep: undefined as number | undefined })),
    ];
    let good = 0;
    const seen: string[] = [];
    for (const { v, ep } of wanted) {
      const r = res.find((s) => s.ruleId === v.oracle_id && s.properties?.agentArena?.verdict === 'not_assessed' && s.properties.agentArena.episode_index === ep);
      const kind = NOT_APPLICABLE_REASONS.has(v.reason_code ?? '') ? 'notApplicable' : 'open';
      if (r && r.kind === kind && r.level === 'none' && r.properties?.agentArena?.reason_code === v.reason_code) {
        good++;
        kinds[kind as 'open']++;
        seen.push(`${v.oracle_id.split('.')[1]}:${v.reason_code}→${kind}`);
      }
    }
    const count = sar.runs[0].properties?.agentArena?.not_assessed;
    C.ok('C4', `C4-NA-${x.name.split(' ')[0]}`, `${x.name}: each not_assessed verdict maps to one SARIF result, kind notApplicable/open, level none; run count agrees`,
      wanted.length > 0 && good === wanted.length && count === wanted.length, `${good}/${wanted.length} mapped (${[...new Set(seen)].sort().join(', ')}); sarif not_assessed=${count}`);
  }
  C.ok('C4', 'C4-NA-KINDS', 'both SARIF kinds are exercised (notApplicable and open)', kinds.notApplicable > 0 && kinds.open > 0, `notApplicable ${kinds.notApplicable}, open ${kinds.open}`);
  const invalid = sarifFiles.filter((f) => !validateSarif(readJson(f)).ok);
  C.ok('C4', 'C4-ALL-VALID', 'every SARIF log this gate produced validates', sarifFiles.length > 0 && invalid.length === 0, `${sarifFiles.length - invalid.length}/${sarifFiles.length} valid`);
  const wf = join(P.workflows, 'sarif-selftest.yml');
  const wfText = existsSync(wf) ? readFileSync(wf, 'utf8') : '';
  C.ok('C4', 'C4-WORKFLOW', `${relative(P.code, wf)} exists, calls upload-sarif and grants security-events: write`,
    /upload-sarif/.test(wfText) && /security-events:\s*write/.test(wfText), existsSync(wf) ? 'present' : 'MISSING');
  notes.push('Criterion 4 "uploads cleanly to a GitHub Security tab" is provable only by the first run of sarif-selftest.yml in the public repo (after C2); this gate checks the workflow and the logs it would upload.');

  // ═════════ Criterion 5 — the cut, and the suites ═════════
  const hits = grepCut(P.code, P.contracts);
  const allowed = new Map<string, Map<string, Set<string>>>();
  const bad = new Map<string, Set<string>>();
  for (const h of hits) {
    const rule = allowRuleFor(h);
    if (rule) {
      const m = allowed.get(rule.rule) ?? new Map<string, Set<string>>();
      const s = m.get(h.file) ?? new Set<string>();
      s.add(h.token);
      m.set(h.file, s);
      allowed.set(rule.rule, m);
    } else {
      const s = bad.get(h.file) ?? new Set<string>();
      s.add(`${h.token}:${h.line}`);
      bad.set(h.file, s);
    }
  }
  const badList = [...bad.entries()].sort().map(([f, s]) => `${f} [${[...s].join(', ')}]`);
  C.ok('C5', 'C5-GREP', `no identifier of a cut module in ${P.layout === 'private' ? 'ascension/' : 'the repository'} code or contracts/ outside the allowlist (${ALLOWLIST.length} rules)`, badList.length === 0,
    badList.length ? `${badList.length} file(s): ${badList.join('; ')}` : `${hits.length} hits, all allowlisted`);
  const allowlisted = ALLOWLIST.filter((r) => allowed.has(r.rule)).map((r) => ({
    rule: r.rule,
    why: r.why,
    hits: [...allowed.get(r.rule)!.entries()].sort().map(([f, s]) => `${f} (${[...s].sort().join(', ')})`),
  }));
  const unusedRules = ALLOWLIST.filter((r) => !allowed.has(r.rule)).map((r) => r.rule);
  if (unusedRules.length) notes.push(`Allowlist rules with no hit (can be removed): ${unusedRules.join(', ')}.`);
  const cutDirs = ['packages/wot-hunt', 'packages/wot-director'].filter((d) => existsSync(join(ASC, d)));
  C.ok('C5', 'C5-DIRS', 'the deleted packages are gone (wot-hunt, wot-director)', cutDirs.length === 0, cutDirs.length ? cutDirs.join(', ') : 'absent');

  if (suites) {
    const t = await sh('npm', ['test', '--', '--test-reporter=spec'], { env: { WOT_ENV: 'test' }, timeoutMs: 1_800_000 }); // reporter pinned: Node 22 prints TAP when piped (B11); 30 min: node 22 on ubuntu-24.04 needs ~17 min for the suite (rc2 public run timed out at 15)
    // Summary parser accepts the spec reporter ("ℹ tests N") and TAP ("# tests N"): `npm test -- --test-reporter=spec`
    // appends the flag after the file list, and Node 22 does not honour an option placed after positionals there, so
    // it prints TAP when piped (rc3 public run, node 22: exit 0 with "tests NaN"; node 24 honours it). Both summaries
    // carry the same four counts; failing test names come from "✖ name (ms)" (spec) or "not ok N - name" (TAP).
    const n = (k: string) => Number(new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, 'm').exec(t.stdout)?.[1] ?? NaN);
    M['C5 npm test'] = `${(t.ms / 1000).toFixed(1)} s`;
    const failed = [...new Set([
      ...[...t.stdout.matchAll(/^✖ (.+?) \(\d[\d.]*m?s\)$/gm)].map((m) => m[1]),
      ...[...t.stdout.matchAll(/^not ok \d+ - (.+?)(?: # (?:SKIP|TODO).*)?$/gm)].map((m) => m[1]),
    ])].sort();
    C.ok('C5', 'C5-NPM-TEST', '`npm test` green', t.code === 0 && n('fail') === 0,
      `exit ${t.code}${t.timedOut ? ` (TIMED OUT after ${(t.ms / 1000).toFixed(0)} s)` : ''}; tests ${n('tests')} pass ${n('pass')} fail ${n('fail')} skipped ${n('skipped')}${failed.length ? `; failing: ${failed.slice(0, 40).join(' · ')}` : ''}`);
    const [tc, t0, cc, ln, insp] = await Promise.all([
      sh('npm', ['run', 'typecheck'], { timeoutMs: 600_000 }),
      sh('npm', ['run', 'contracts:tier0']),
      sh('npm', ['run', 'contracts:check']),
      sh('npm', ['run', 'lint:net', '-w', '@sixi4ai/agent-arena']),
      sh(join(ASC, 'frontend', 'node_modules', '.bin', 'vitest'), ['run'], { cwd: join(ASC, 'frontend'), timeoutMs: 300_000 }),
    ]);
    M['C5 typecheck'] = `${(tc.ms / 1000).toFixed(1)} s`;
    C.ok('C5', 'C5-TYPECHECK', '`npm run typecheck` clean', tc.code === 0, `exit ${tc.code}`);
    const tier0 = /OK \((\d+) schemas, (\d+) examples/.exec(t0.stdout);
    const cver = readContractsVersion(P.contracts);
    C.ok('C5', 'C5-TIER0', '`npm run contracts:tier0` OK at contracts major 2', t0.code === 0 && !!tier0 && /^2\./.test(cver), `exit ${t0.code}; ${tier0 ? `${tier0[1]} schemas, ${tier0[2]} examples` : 'no OK line'}; contracts ${cver}`);
    const chk = /Contract checks: OK \(([^)]*)\)/.exec(cc.stdout);
    C.ok('C5', 'C5-CONTRACTS-CHECK', '`npm run contracts:check` OK', cc.code === 0 && !!chk, `exit ${cc.code}${chk ? `; ${chk[1]}` : ''}`);
    C.ok('C5', 'C5-LINT-NET', '`lint:net` (the single guarded network layer, B1 hard requirement) clean', ln.code === 0, `exit ${ln.code}`);
    const vt = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(insp.stdout.replace(/\u001b\[[0-9;]*m/g, ''));
    const vfails = [...insp.stdout.replace(/\u001b\[[0-9;]*m/g, '').matchAll(/FAIL\s+(test\/\S+) > (.+)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
    C.ok('C5', 'C5-INSPECTOR', 'replay-inspector suite (frontend vitest; CI job `inspector`) green against the regenerated samples', insp.code === 0,
      `exit ${insp.code}; ${vt ? `${vt[1] ?? 0} failed, ${vt[2]} passed` : 'no summary'}${vfails.length ? `; ${[...new Set(vfails)].join('; ')}` : ''}`);
  } else {
    for (const [id, name] of [['C5-NPM-TEST', '`npm test` green'], ['C5-TYPECHECK', '`npm run typecheck` clean'], ['C5-TIER0', '`contracts:tier0` OK'], ['C5-CONTRACTS-CHECK', '`contracts:check` OK'], ['C5-LINT-NET', '`lint:net` clean'], ['C5-INSPECTOR', 'replay-inspector suite green']] as const) {
      C.skip('C5', id, name, 'suites off (--no-suites / npm-test wrapper)');
    }
  }

  // ═════════ Criterion 6 — security hand review ═════════
  const sr = join(P.docs, 'phase-7', 'SECURITY-REVIEW.md');
  if (!P.privateEvidence) {
    const why = 'docs/phase-7/SECURITY-REVIEW.md is private evidence (EXTRACTION §2.2 denies docs/phase-*); judged by the private gate run';
    C.na('C6', 'C6-REVIEW', 'docs/phase-7/SECURITY-REVIEW.md verdict line is PASS or PASS-WITH-CONDITIONS', why);
    C.na('C6', 'C6-SCOPE', 'the review covers wot-auth, services/gateway, services/passports and the CLI target-connection code', why);
  } else if (!existsSync(sr)) {
    C.ok('C6', 'C6-REVIEW', 'docs/phase-7/SECURITY-REVIEW.md present with verdict PASS or PASS-WITH-CONDITIONS', false, 'security review pending (file absent)');
  } else {
    const text = readFileSync(sr, 'utf8');
    const rv = parseReviewVerdict(text);
    const st = openReviewFindings(text, rv.note);
    if (!st.table) notes.push('docs/phase-7/SECURITY-REVIEW.md has no "Status of every finding" table; open findings not listed.');
    else {
      const fmt = (fs: ReviewFinding[]) => fs.map((f) => `${f.id} (${f.state.split(/[;(]/)[0].trim()})`).join(', ');
      notes.push(`Security review findings still open in the §7 status table: ${st.open.length ? fmt(st.open) : 'none'} (docs/phase-7/SECURITY-REVIEW.md §7).` +
        (st.closedByNote.length ? ` Listed open in §7 but closed by the orchestrator note under the current verdict, pending the security-architect's counter-signature: ${st.closedByNote.map((f) => f.id).join(', ')}.` : ''));
    }
    C.ok('C6', 'C6-REVIEW', 'docs/phase-7/SECURITY-REVIEW.md verdict line is PASS or PASS-WITH-CONDITIONS', rv.verdict === 'PASS' || rv.verdict === 'PASS-WITH-CONDITIONS', `verdict: ${rv.display}`);
    const scope = ['wot-auth', 'gateway', 'passports', 'arena-cli'].map((k) => ({ k, ok: text.includes(k) }));
    C.ok('C6', 'C6-SCOPE', 'the review covers wot-auth, services/gateway, services/passports and the CLI target-connection code', scope.every((s) => s.ok), scope.map((s) => `${s.k}:${s.ok ? 'yes' : 'NO'}`).join(' '));
  }

  // ═════════ Criterion 7 — licence and public docs ═════════
  const rd = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const lic = rd(P.license);
  C.ok('C7', 'C7-LICENSE', `LICENSE is the Apache License 2.0 (${shown(P.license)}${P.layout === 'private' ? ', copied to the root at extraction' : ''})`, /Apache License\s+Version 2\.0, January 2004/.test(lic) && /END OF TERMS AND CONDITIONS/.test(lic));
  const notice = rd(P.notice);
  C.ok('C7', 'C7-NOTICE', 'NOTICE present and names the Apache-2.0 licence', notice.includes('Apache License') && notice.length > 0);
  if (/<COPYRIGHT HOLDER/.test(notice)) notes.push('NOTICE still carries the placeholder "<COPYRIGHT HOLDER - to be filled by the Architect before publication>" (open Architect decision, EXTRACTION A5).');
  const readme = rd(P.readme);
  const security = rd(P.security);
  const contributing = rd(P.contributing);
  C.ok('C7', 'C7-DOCS', P.layout === 'private' ? 'README-public, SECURITY-public and CONTRIBUTING-public present' : 'README.md, SECURITY.md and CONTRIBUTING.md present at the repository root', readme.length > 0 && security.length > 0 && contributing.length > 0);
  const coiReadme = /Conflict of interest\.\*\*\s*This arena is maintained by Sixi AI/.test(readme) && /oracle-first and tool-blind/.test(readme);
  C.ok('C7', 'C7-COI-README', 'conflict-of-interest sentence in README-public ("This arena is maintained by Sixi AI … oracle-first and tool-blind")', coiReadme);
  const coiSarif = restSarif?.runs[0].tool.driver.properties?.agentArena?.conflict_of_interest;
  C.ok('C7', 'C7-COI-SARIF', "conflict-of-interest sentence in the gate report's SARIF tool.driver.properties", coiSarif === CONFLICT_OF_INTEREST && /maintained by Sixi AI/.test(coiSarif ?? ''), coiSarif ? `"${coiSarif.slice(0, 60)}…"` : 'absent');
  const dipReadme = rd(join(P.code, 'packages', 'wot-engine', 'src', 'diplomacy', 'README.md'));
  C.ok('C7', 'C7-CLEANROOM', 'ADR-002 clean-room rule in CONTRIBUTING-public and in wot-engine/src/diplomacy/README.md',
    /clean-room rule/i.test(contributing) && /ADR-002/.test(contributing) && /Do not have the source of any copyleft Diplomacy adjudicator open/.test(contributing) && /Clean-room statement/.test(dipReadme) && /ADR-002/.test(dipReadme));

  // ═════════ X — Hallucinator live path (CALIBRATION.md §8) ═════════
  if (bench) {
    const b = benchLive();
    M['X Hallucinator live path (median of 5 after warm-up)'] = `${b.hallucinatorUs.toFixed(1)} µs/tick (ceiling ${HALLUCINATOR_CEILING_US})`;
    M['X six-scenario live-path mean (median of 5)'] = `${b.sixMeanUs.toFixed(1)} µs/tick (budget ${SIX_MEAN_BUDGET_US})`;
    C.ok('X', 'X-BENCH-HALLUCINATOR', `Hallucinator live path (adapter + five-view squad egress) ≤ ${HALLUCINATOR_CEILING_US} µs/tick on this box`, b.hallucinatorUs <= HALLUCINATOR_CEILING_US, 'number in the measurement block');
    C.ok('X', 'X-BENCH-MEAN', `six-scenario live-path mean ≤ ${SIX_MEAN_BUDGET_US} µs/tick`, b.sixMeanUs <= SIX_MEAN_BUDGET_US, 'number in the measurement block');
  } else {
    C.skip('X', 'X-BENCH-HALLUCINATOR', 'Hallucinator live path ≤ 350 µs/tick', 'bench off');
  }

  M['gate total wall-clock'] = `${((performance.now() - tGate) / 1000).toFixed(1)} s`;
  M['scratch output'] = OUT;

  const crits: Crit[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'X'];
  const criteria = scoreCriteria(C.list, crits);
  const gateOpen = crits.every((c) => criteria[c] === 'PASS' || criteria[c] === 'N-A');
  const layoutInfo = `${P.layout} (${P.how === 'auto' ? 'auto-detected' : '--layout'}); contracts/ at ${shown(P.contracts) || '.'}`;
  return { checks: C.list, criteria, gateOpen, layout: P.layout, layoutInfo, notEvaluated: notEvaluated(C.list), notes, allowlisted, measurements: M, outDir: OUT };
}

function readContractsVersion(contracts: string): string {
  const p = join(contracts, 'openapi.yaml');
  if (!existsSync(p)) return 'unknown';
  return /^\s+version:\s*['"]?([0-9][^'"\s]*)/m.exec(readFileSync(p, 'utf8'))?.[1] ?? 'unknown';
}

// ── main / reporting ───────────────────────────────────────────────────────────
const TITLES: Record<Crit, string> = {
  C1: 'Criterion 1 — the gate run: serve-reference + run over REST, five gate seeds, three tiers, < 5 min',
  C2: 'Criterion 2 — transport invariance: ws, mcp, a2a reproduce REST byte for byte',
  C3: 'Criterion 3 — seven scenarios: reference pairs separate on the gate seeds; a doc each',
  C4: 'Criterion 4 — SARIF 2.1.0: schema, not_assessed mapping, upload workflow',
  C5: 'Criterion 5 — the cut is executed; npm test / typecheck / tier-0 / contracts:check',
  C6: 'Criterion 6 — security hand review',
  C7: 'Criterion 7 — licence, README, CONTRIBUTING, conflict-of-interest, clean-room rule',
  X: 'Extras — verify, replay byte-equality, Hallucinator live-path ceiling',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stable = argv.includes('--stable');
  const r = await runGate({ suites: !argv.includes('--no-suites'), bench: !argv.includes('--no-bench'), layout: parseLayoutArg(argv) });
  const L = (s = ''): void => void process.stdout.write(`${s}\n`);
  L('='.repeat(96));
  L('  Agent Arena — Phase-7 GATE (C1): the Open Arena');
  L(`  layout: ${r.layoutInfo}`);
  L('='.repeat(96));
  for (const c of Object.keys(TITLES) as Crit[]) {
    L('');
    L(`  ${TITLES[c]}`);
    for (const x of r.checks.filter((k) => k.crit === c)) L(renderCheck(x));
  }
  L('');
  L('  Allowlisted cut-module words (criterion 5)');
  for (const a of r.allowlisted) {
    L(`    [${a.rule}] ${a.why}`);
    for (const h of a.hits) L(`        ${h}`);
  }
  if (r.notes.length) {
    L('');
    L('  Notes (recorded, not scored)');
    for (const n of r.notes) L(`    - ${n}`);
  }
  const pass = r.checks.filter((c) => c.status === 'PASS').length;
  const fail = r.checks.filter((c) => c.status === 'FAIL');
  L('');
  L('-'.repeat(96));
  const na = r.checks.filter((c) => c.status === 'N-A').length;
  L(`  checks: ${pass}/${r.checks.length - na} pass, ${fail.length} fail, ${r.checks.filter((c) => c.status === 'SKIP').length} skipped, ${r.checks.filter((c) => c.status === 'FINDING').length} finding(s) recorded (not scored)${na ? `, ${na} N-A (private evidence, not scored)` : ''}`);
  for (const c of Object.keys(TITLES) as Crit[]) L(`  ${c.padEnd(3)} ${r.criteria[c]}`);
  if (r.notEvaluated.length) L(`  ${NA_LABEL}, not evaluated in the ${r.layout} layout: ${r.notEvaluated.join(', ')}`);
  L(`  ${verdictLine(r)}`);
  L('='.repeat(96));
  if (!stable) {
    L('');
    L('  ── measurements (wall-clock; vary run to run; excluded by --stable) ──');
    for (const [k, v] of Object.entries(r.measurements)) L(`    ${k}: ${v}`);
  }
  if (!r.gateOpen) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
