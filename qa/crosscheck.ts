/**
 * `arena-crosscheck` — the Phase 9 reproducibility cross-check runner (B1-crosscheck, sim-qa).
 * Spec: docs/phase-9/HOSTED-PROFILE.md §2.8; record: contracts/schemas/crosscheck_record.schema.json;
 * signing: contracts/signing.md (CROSSCHECK_PAYLOAD_TYPE); operator doc: docs/phase-9/CROSSCHECK.md.
 *
 *   npx tsx qa/crosscheck.ts --legs npm,binary,docker,hosted --digest sha256:<64 hex> --out <dir>
 *        [--sign <ed25519 private key pem>] [--kid <key id>]
 *        [--binary <SEA binary>] [--image <ref>] [--hosted-dir <dir>] [--hosted-key <pem|jwk file>]
 *        [--npm-bin <installed agent-arena bin>] [--trigger pre_promotion|nightly|config_change]
 *        [--platform linux/amd64|linux/arm64] [--platform-manifest sha256:…]
 *        [--spec-ref <git sha>] [--spec-repo owner/repo]
 *        [--blocks X1,X2,X3] [--tiers edge,core,frontier] [--scenarios a,b] [--concurrency n]
 *        [--stable] [--json]
 *   npx tsx qa/crosscheck.ts --compare <recordA> <recordB> [--json]
 *
 * Legs (HOSTED-PROFILE §2.8 names in brackets):
 *   npm    [O1] the public CLI. Default: the workspace source (`node --import tsx
 *               packages/arena-cli/src/bin.ts`, the entry the published bundle wraps);
 *               `--npm-bin` points at an installed `@rbrus/agent-arena` bin instead.
 *   binary [O2] the Node SEA binary at `--binary`; `missing` when absent.
 *   docker [O3] `docker run <image>` where image = `--image` or ghcr.io/rbrus/agent-arena@<digest>;
 *               `missing` when docker or the image is unavailable.
 *   hosted [H]  reports the hosted runner produced, `<hosted-dir>/<group id>/report.json`
 *               (group ids: matrix.json); `missing` without `--hosted-dir`. Leg V (`verify
 *               --hosted --key` of every hosted report) runs on the open CLI.
 * Every local leg serves its OWN reference targets (`serve-reference`, same artifact) and runs
 * the matrix against them over the network — the same shape as the hosted leg.
 *
 * The frozen anchors (arena-scenarios `anchorFor`) are compared on every cell that has one and
 * embedded as leg `A` of that cell (contracts 2.5.0): `replay_hash`, `outcome`, `terminal_tick`
 * (all `anchors.ts` freezes) and `anchor_id` (the anchor's name as a slug, see `anchorId`).
 *
 * Matrix (HOSTED-PROFILE §2.8):
 *   X1  the seven Phase 7 reference pairs × {edge, core, frontier} × gate seeds 20260720,1,2,3,5, REST:
 *       six raids × {squad coordinated, squad naive, member m1 coordinated fill} + grid_tactics duel
 *       seat A {reflex, null} vs silver                                                  = 300 cells
 *   X2  byzantine squad coordinated, core, gate seeds, over ws / mcp / a2a              =  15 cells
 *   X3  diplomacy_standard power auto, horizon 1906, {robust, credulous}-diplomat,
 *       {edge, core, frontier}, Phase 8 seed 20261115, REST; transcript_hash via `verify` =   6 cells
 *
 * Cell verdicts: match / environmental (differs and a leg missed a deadline or aborted target_*;
 * the group is re-run on the local legs up to 2 times) / divergent / missing. Job verdict:
 * fail (divergent, harness_error missing, leg V failure, tool/engine build mismatch) >
 * inconclusive (environmental or other missing left, or H requested but absent) > pass.
 *
 * Scope (contracts 2.5.0): a run with `hosted` among --legs writes `scope: hosted`, whose pass
 * needs H and may promote a digest. A run without it writes `scope: local`: leg V is empty and a
 * clean run is `pass`, meaning the open legs agree with each other and with the anchors. A local
 * record never promotes a digest and is never cited by an evidence report.
 *
 * Exit: 0 every non-missing cell is `match` and nothing makes the job `fail` · 1 otherwise ·
 * 2 harness / usage error.
 *
 * `--compare <recordA> <recordB>` (the seal route's equality check, SIXI-INTEGRATION §1.14 step 6):
 * both records must validate; every member except `signing`, `started_at` and `finished_at` must be
 * equal, cells cell by cell (same ids, same order, same fields per leg). Exit 0 equal · 1 differ ·
 * 2 unreadable or invalid record.
 *
 * Outputs in --out: crosscheck_record.json (schema-valid; signed with --sign), crosscheck_summary.json,
 * matrix.json, timing.json (the only file with wall-clocks), legs/<leg>/<group>/ (raw CLI output).
 * `--stable`: the record's started_at/finished_at are the fixed epoch and stdout omits timings,
 * so two runs on the same tree are byte-identical (record, summary, matrix).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { anchorFor, GATE_SEEDS_BYZANTINE, REFERENCE, type ScenarioId } from 'arena-scenarios';
import { CROSSCHECK_PAYLOAD_TYPE, jcs, signDocument, SIGNATURE_POINTER, validateReportSchema } from 'arena-report';

// ── paths / constants ───────────────────────────────────────────────────────────
const ASC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ASC, '..');
const BIN = join(ASC, 'packages', 'arena-cli', 'src', 'bin.ts');
const SCHEMA_PATH = join(REPO, 'contracts', 'schemas', 'crosscheck_record.schema.json');

export const TIERS = ['edge', 'core', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];
export const GATE_SEEDS: readonly number[] = GATE_SEEDS_BYZANTINE; // 20260720,1,2,3,5
/** Phase 8 gate seed (wot-engine test/diplomacy-golden.test.ts S0; phase8-gate.ts). */
export const PHASE8_SEEDS: readonly number[] = [20261115];
export const DIP_HORIZON = 1906;
const RAIDS = ['hallucinator', 'overfit', 'byzantine', 'deadlock', 'split_brain', 'latency'] as const;
const STABLE_TIME = '1970-01-01T00:00:00Z';
const PLACEHOLDER_SIGNATURE = `${'A'.repeat(86)}==`;
const DEFAULT_KID = 'arena-crosscheck-unsigned';
const REPORT_MAX_BYTES = 64 * 1024 * 1024;

export type LegName = 'npm' | 'binary' | 'docker' | 'hosted';
export type Leg = 'H' | 'O1' | 'O2' | 'O3' | 'A';
export const LEG_OF: Record<LegName, Leg> = { npm: 'O1', binary: 'O2', docker: 'O3', hosted: 'H' };
const LEG_ORDER: Leg[] = ['H', 'O1', 'O2', 'O3', 'A'];
export type Verdict = 'match' | 'environmental' | 'divergent' | 'missing';
export type JobVerdict = 'pass' | 'inconclusive' | 'fail';

// ── the matrix ──────────────────────────────────────────────────────────────────
type Policy = 'coordinated' | 'naive' | 'robust' | 'credulous';
export interface Group {
  /** Stable id; the hosted leg's reports live at <hosted-dir>/<id>/report.json. */
  id: string;
  block: 'X1' | 'X2' | 'X3';
  scenario: ScenarioId;
  tier: Tier;
  seatMode: 'squad' | 'member' | 'duel' | 'power';
  position?: 'A' | 'm1' | 'auto';
  fill?: 'coordinated' | 'house';
  transport: 'rest' | 'ws' | 'mcp' | 'a2a';
  /** The served reference policy (`serve-reference --policy`). */
  policy: Policy;
  referenceTarget: string;
  seeds: number[];
  horizon?: number;
  /** The CLI `run` arguments minus --target / --out (identical on every leg). */
  args: string[];
}

const refName = (s: string): string => `ref:${s.toLowerCase().replace(/[^a-z0-9:-]/g, '-')}`.slice(0, 40);

export interface MatrixFilter {
  blocks?: string[];
  tiers?: string[];
  scenarios?: string[];
}

export function buildMatrix(f: MatrixFilter = {}): Group[] {
  const groups: Group[] = [];
  const want = (b: string) => !f.blocks || f.blocks.includes(b);
  const tiers = TIERS.filter((t) => !f.tiers || f.tiers.includes(t));
  const scen = (s: string) => !f.scenarios || f.scenarios.includes(s);
  const seeds = [...GATE_SEEDS];
  const common = (g: Omit<Group, 'id' | 'args'>): Group => {
    const args = ['run', '--scenario', g.scenario, '--seat', g.seatMode];
    if (g.position && g.seatMode !== 'power') args.push('--position', g.position);
    if (g.seatMode === 'power') args.splice(4, 1, g.position ?? 'auto');
    if (g.fill) args.push('--fill', g.fill);
    if (g.horizon) args.push('--horizon', String(g.horizon));
    args.push('--tier', g.tier, '--seeds', g.seeds.join(','), '--episodes', String(g.seeds.length), '--transport', g.transport, '--i-own-this-target', '--json');
    const seat = g.seatMode === 'power' ? `power-${g.position}` : g.seatMode === 'member' ? `member-${g.position}` : g.seatMode === 'duel' ? `duel-${g.position}` : 'squad';
    return { ...g, id: `${g.block.toLowerCase()}-${g.tier}-${g.scenario.replace(/_/g, '-')}-${seat}-${g.policy}-${g.transport}`, args };
  };
  if (want('X1')) {
    for (const tier of tiers) {
      for (const s of RAIDS) {
        if (!scen(s)) continue;
        for (const policy of ['coordinated', 'naive'] as const) {
          groups.push(common({ block: 'X1', scenario: s, tier, seatMode: 'squad', transport: 'rest', policy, referenceTarget: refName(REFERENCE[s][policy].name), seeds }));
        }
        groups.push(common({ block: 'X1', scenario: s, tier, seatMode: 'member', position: 'm1', fill: 'coordinated', transport: 'rest', policy: 'coordinated', referenceTarget: refName(REFERENCE[s].coordinated.name), seeds }));
      }
      if (scen('grid_tactics')) {
        groups.push(common({ block: 'X1', scenario: 'grid_tactics', tier, seatMode: 'duel', position: 'A', transport: 'rest', policy: 'coordinated', referenceTarget: 'ref:reflex', seeds }));
        groups.push(common({ block: 'X1', scenario: 'grid_tactics', tier, seatMode: 'duel', position: 'A', transport: 'rest', policy: 'naive', referenceTarget: 'ref:null', seeds }));
      }
    }
  }
  if (want('X2') && (!f.tiers || f.tiers.includes('core')) && scen('byzantine')) {
    for (const transport of ['ws', 'mcp', 'a2a'] as const) {
      groups.push(common({ block: 'X2', scenario: 'byzantine', tier: 'core', seatMode: 'squad', transport, policy: 'coordinated', referenceTarget: refName(REFERENCE.byzantine.coordinated.name), seeds }));
    }
  }
  if (want('X3') && scen('diplomacy_standard')) {
    for (const tier of tiers) {
      for (const policy of ['robust', 'credulous'] as const) {
        groups.push(common({ block: 'X3', scenario: 'diplomacy_standard', tier, seatMode: 'power', position: 'auto', transport: 'rest', policy, referenceTarget: `${policy}-diplomat`, seeds: [...PHASE8_SEEDS], horizon: DIP_HORIZON, fill: 'house' }));
      }
    }
  }
  return groups;
}

// ── compared values per leg ─────────────────────────────────────────────────────
export interface LegEntry {
  status: 'completed' | 'aborted';
  abort_reason?: string;
  replay_hash: string;
  outcome: string;
  terminal_tick: number;
  trajectory_class: string;
  evaluation_hash?: string;
  deadline_miss: boolean;
  target_abort: boolean;
}
export const COMPARED: readonly (keyof LegEntry)[] = ['status', 'abort_reason', 'replay_hash', 'outcome', 'terminal_tick', 'trajectory_class', 'evaluation_hash'];
export interface AnchorValues {
  name: string;
  /** `anchor_id` in the record (`anchorId(name)`); absent if the slug does not fit the schema pattern. */
  id?: string;
  replay_hash: string;
  outcome: string;
  terminal_tick?: number;
}
/** Leg `A` of a record cell (crosscheck_record 2.5.0): only what `anchors.ts` freezes, plus the anchor's id. */
export interface AnchorLeg {
  replay_hash: string;
  outcome: string;
  terminal_tick: number;
  anchor_id?: string;
}
// Contracts 2.7.0 `crosscheck_record` leg A `anchor_id`: schema pattern, maxLength 128.
const ANCHOR_ID = /^[a-z][a-z0-9_]{0,39}\/(edge|core|frontier)\/seed\/(0|[1-9][0-9]{0,9})(\/[a-z0-9][a-z0-9_.:@-]{0,39}){2,12}$/;
const ANCHOR_ID_MAX = 128;
/**
 * The anchor's `anchors.ts` name as a record id: lower-cased, every run of characters outside the
 * id alphabet (spaces, parentheses) as one `/`, no leading or trailing `/`.
 * `byzantine core seed 1 squad naive (gate)` → `byzantine/core/seed/1/squad/naive/gate`.
 * Undefined when the result does not fit the 2.7.0 schema pattern (max 128 characters).
 */
export function anchorId(name: string): string | undefined {
  const id = name.toLowerCase().replace(/[^a-z0-9_.:@-]+/g, '/').replace(/^\/+|\/+$/g, '');
  return id.length <= ANCHOR_ID_MAX && ANCHOR_ID.test(id) ? id : undefined;
}
/** The embedded leg A of a cell, or undefined when the anchor froze no terminal tick (the schema requires one). */
export function anchorLeg(a: AnchorValues | undefined): AnchorLeg | undefined {
  if (!a || a.terminal_tick === undefined) return undefined;
  return { replay_hash: a.replay_hash, outcome: a.outcome, terminal_tick: a.terminal_tick, ...(a.id ? { anchor_id: a.id } : {}) };
}
export type MissingCause = 'harness_error' | 'other';

export interface CellEval {
  verdict: Verdict;
  diffs: string[];
  missing: Leg[];
}

/**
 * The cell verdict of HOSTED-PROFILE §2.8 over the legs that produced the episode, the frozen
 * anchor where one exists, and extra per-leg failures (a Diplomacy `verify` that did not
 * re-derive the transcript). A difference outranks a missing leg: a cell that disagrees is
 * reported as such even when another leg is absent.
 */
export function cellVerdict(entries: Partial<Record<Leg, LegEntry>>, requested: readonly Leg[], anchor?: AnchorValues, extraDiffs: readonly string[] = []): CellEval {
  const present = LEG_ORDER.filter((l) => entries[l]);
  const missing = requested.filter((l) => l !== 'A' && !entries[l]);
  const diffs: string[] = [...extraDiffs];
  if (present.length) {
    const base = entries[present[0]]!;
    for (const l of present.slice(1)) {
      for (const k of COMPARED) {
        const a = base[k];
        const b = entries[l]![k];
        if (a !== b) diffs.push(`${k}: ${present[0]}=${String(a)} ${l}=${String(b)}`);
      }
    }
    if (anchor) {
      for (const l of present) {
        const e = entries[l]!;
        if (e.replay_hash !== anchor.replay_hash) diffs.push(`replay_hash: ${l}=${e.replay_hash} anchor=${anchor.replay_hash}`);
        if (e.outcome !== anchor.outcome) diffs.push(`outcome: ${l}=${e.outcome} anchor=${anchor.outcome}`);
        if (anchor.terminal_tick !== undefined && e.terminal_tick !== anchor.terminal_tick) diffs.push(`terminal_tick: ${l}=${e.terminal_tick} anchor=${anchor.terminal_tick}`);
      }
    }
  }
  if (diffs.length) {
    const env = present.some((l) => entries[l]!.deadline_miss || entries[l]!.target_abort);
    return { verdict: env ? 'environmental' : 'divergent', diffs, missing };
  }
  if (missing.length || !present.length) return { verdict: 'missing', diffs, missing };
  return { verdict: 'match', diffs, missing };
}

export type Scope = 'hosted' | 'local';
/**
 * Job verdict from cell verdicts plus the job-level failure conditions (§2.8 table). A hosted-scope
 * job (the default) needs H to pass; a local-scope job (2.5.0, no H requested) can pass without it.
 */
export function jobVerdict(cells: readonly { verdict: Verdict; missing_cause?: MissingCause }[], o: { legVFailed: boolean; buildMismatch: boolean; hostedRan: boolean; scope?: Scope }): JobVerdict {
  if (o.legVFailed || o.buildMismatch) return 'fail';
  if (cells.some((c) => c.verdict === 'divergent' || (c.verdict === 'missing' && c.missing_cause === 'harness_error'))) return 'fail';
  if ((o.scope ?? 'hosted') === 'hosted' && !o.hostedRan) return 'inconclusive';
  if (cells.some((c) => c.verdict !== 'match')) return 'inconclusive';
  return 'pass';
}

// ── report parsing ──────────────────────────────────────────────────────────────
interface RepEpisode {
  episode_index: number;
  seed: number;
  seat?: string;
  status: 'completed' | 'aborted';
  abort_reason?: string;
  outcome: string;
  terminal_tick: number;
  replay_hash?: string;
  trajectory_class?: string;
  evaluation_hash?: string;
  transcript_hash?: string;
  budget?: { soft_deadline_misses?: number; hard_deadline_misses?: number };
}
interface Rep {
  run: { tool?: { version?: string }; spec: { scenario_id: string; budget_tier: string; seeds: number[]; seat: { mode: string; position?: string; fill?: string }; diplomacy?: { fill?: string }; target: { transport: string } } };
  engine: { build_hash: string; build_scope?: string };
  episodes: RepEpisode[];
}

function entryOf(e: RepEpisode): LegEntry | undefined {
  if (!e.replay_hash || !e.trajectory_class) return undefined;
  const miss = (e.budget?.soft_deadline_misses ?? 0) + (e.budget?.hard_deadline_misses ?? 0) > 0;
  const out: LegEntry = {
    status: e.status,
    replay_hash: e.replay_hash,
    outcome: e.outcome,
    terminal_tick: e.terminal_tick,
    trajectory_class: e.trajectory_class,
    deadline_miss: miss,
    target_abort: e.status === 'aborted' && /^target_/.test(e.abort_reason ?? ''),
  };
  if (e.status === 'aborted' && e.abort_reason) out.abort_reason = e.abort_reason;
  if (e.evaluation_hash) out.evaluation_hash = e.evaluation_hash;
  return out;
}

/** A report must be the run this group asked for (a misplaced hosted report cannot stand in for another cell). */
function specMismatch(r: Rep, g: Group): string | undefined {
  const s = r.run?.spec;
  if (!s) return 'no run.spec';
  if (s.scenario_id !== g.scenario) return `scenario ${s.scenario_id}`;
  if (s.budget_tier !== g.tier) return `tier ${s.budget_tier}`;
  if (JSON.stringify(s.seeds) !== JSON.stringify(g.seeds)) return 'seeds differ';
  if (s.seat?.mode !== g.seatMode) return `seat ${s.seat?.mode}`;
  if (g.seatMode !== 'squad' && g.seatMode !== 'power' && s.seat.position !== g.position) return `position ${s.seat.position}`;
  // Raid groups record the fill under seat.fill; Diplomacy under diplomacy.fill (contracts 2.4.0).
  const fill = g.seatMode === 'power' ? s.diplomacy?.fill : s.seat.fill;
  if (g.fill && fill !== g.fill) return `fill ${fill}`;
  if (s.target?.transport !== g.transport) return `transport ${s.target?.transport}`;
  return undefined;
}

function readReport(path: string): { rep?: Rep; error?: string } {
  if (!existsSync(path)) return { error: 'no report.json' };
  if (statSync(path).size > REPORT_MAX_BYTES) return { error: 'report.json over 64 MiB' };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { error: 'report.json is not JSON' };
  }
  if (!validateReportSchema(doc)) return { error: 'report.json is invalid against report.schema.json' };
  return { rep: doc as Rep };
}

// ── subprocesses ────────────────────────────────────────────────────────────────
interface Proc {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}
function sh(cmd: string, args: string[], timeoutMs = 600_000): Promise<Proc> {
  return new Promise((res) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd: ASC, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => (stderr += `spawn error: ${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr, ms: performance.now() - t0 });
    });
  });
}

interface Server {
  urls: Record<'rest' | 'ws' | 'mcp' | 'a2a', string>;
  stop(): Promise<void>;
}
/** Start `serve-reference … --port 0 --json` and read its port line; `onStop` tears it down (docker rm -f). */
function startServer(cmd: string, args: string[], onStop?: () => Promise<unknown>): Promise<Server> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: ASC, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let done = false;
    const stop = async () => {
      if (onStop) await onStop();
      if (child.exitCode === null) {
        await new Promise<void>((r) => {
          child.once('close', () => r());
          child.kill('SIGTERM');
        });
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      void stop();
      rej(new Error(`serve-reference did not report its port within 60 s: ${err.slice(0, 300)}`));
    }, 60_000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      buf += d;
      if (done) return;
      let info: { urls?: Server['urls'] } | undefined;
      try {
        info = JSON.parse(buf);
      } catch {
        return;
      }
      done = true;
      clearTimeout(timer);
      res({ urls: info!.urls!, stop });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rej(new Error(`serve-reference exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// ── legs ────────────────────────────────────────────────────────────────────────
interface RunOut {
  code: number;
  reportPath?: string;
  error?: string;
}
interface VerifyOut {
  code: number;
  status: string;
  signature?: string;
}
interface Driver {
  leg: Leg;
  name: LegName;
  available: boolean;
  reason?: string;
  /** Why an unavailable leg is missing: `other` = not provided here (no binary, no docker, no hosted dir, pull failed); `harness_error` = the artifact itself failed (version, serve-reference). */
  cause?: MissingCause;
  /** Local legs can re-run a group (environmental retries); the hosted leg cannot. */
  rerunnable: boolean;
  version?: { version: string; engine_builds: Record<string, string> };
  start(policies: Set<Policy>): Promise<void>;
  stop(): Promise<void>;
  run(g: Group, outDir: string): Promise<RunOut>;
  verify(reportPath: string): Promise<VerifyOut>;
}

function parseJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
/**
 * `version --json` → {version, engine_builds}. A CLI older than the engine-build output prints
 * the bare version: accepted with no engine builds, so the per-report `engine.build_hash`
 * check carries the build comparison for that leg.
 */
function versionOf(p: Proc): { version: string; engine_builds: Record<string, string> } | undefined {
  if (p.code !== 0) return undefined;
  const j = parseJson<{ version?: string; engine_builds?: Record<string, string> }>(p.stdout);
  if (j && typeof j === 'object' && typeof j.version === 'string') return { version: j.version, engine_builds: j.engine_builds ?? {} };
  const bare = p.stdout.trim();
  return /^[0-9A-Za-z.+-]{1,64}$/.test(bare) ? { version: bare, engine_builds: {} } : undefined;
}
const verifyOut = (p: Proc): VerifyOut => {
  const j = parseJson<{ status?: string; signature?: { status?: string } }>(p.stdout);
  return { code: p.code, status: j?.status ?? `exit ${p.code}`, ...(j?.signature?.status ? { signature: j.signature.status } : {}) };
};

const servePolicyArgs = (p: Policy): string[] => (p === 'robust' || p === 'credulous' ? ['--scenario', 'diplomacy_standard', '--policy', p, '--agent-seed', String(PHASE8_SEEDS[0])] : ['--policy', p]);

/** O1 (workspace or installed bin) and O2 (SEA binary): a local command. */
function localDriver(leg: Leg, name: LegName, cmd: string, pre: string[], reason?: string): Driver {
  const servers = new Map<Policy, Server>();
  const d: Driver = {
    leg,
    name,
    available: !reason,
    reason,
    rerunnable: true,
    async start(policies) {
      const v = await sh(cmd, [...pre, 'version', '--json'], 60_000);
      const j = versionOf(v);
      if (!j) {
        d.available = false;
        d.cause = 'harness_error';
        d.reason = `\`version --json\` failed (exit ${v.code})`;
        return;
      }
      d.version = j;
      for (const p of policies) servers.set(p, await startServer(cmd, [...pre, 'serve-reference', ...servePolicyArgs(p), '--port', '0', '--json']));
    },
    async stop() {
      await Promise.all([...servers.values()].map((s) => s.stop()));
      servers.clear();
    },
    async run(g, outDir) {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(dirname(outDir), { recursive: true });
      const s = servers.get(g.policy);
      if (!s) return { code: -1, error: `no reference server for ${g.policy}` };
      const p = await sh(cmd, [...pre, ...g.args, '--target', s.urls[g.transport], '--out', outDir]);
      const rp = join(outDir, 'report.json');
      return existsSync(rp) ? { code: p.code, reportPath: rp } : { code: p.code, error: `exit ${p.code}, no report.json: ${p.stderr.slice(0, 200)}` };
    },
    async verify(reportPath) {
      return verifyOut(await sh(cmd, [...pre, 'verify', reportPath, '--json']));
    },
  };
  return d;
}

/** O3: the image, hardened as sandbox/docker-compose.yml runs it; host network so loopback targets work. */
function dockerDriver(image: string, reason?: string): Driver {
  const servers = new Map<Policy, Server>();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65532;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 65532;
  const harden = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', `${uid}:${gid}`];
  const d: Driver = {
    leg: 'O3',
    name: 'docker',
    available: !reason,
    reason,
    rerunnable: true,
    async start(policies) {
      const has = await sh('docker', ['image', 'inspect', image], 60_000);
      if (has.code !== 0) {
        const pull = await sh('docker', ['pull', image], 600_000);
        if (pull.code !== 0) {
          d.available = false;
          d.reason = `image ${image} not present and \`docker pull\` failed`;
          return;
        }
      }
      const v = await sh('docker', ['run', '--rm', '--network', 'none', ...harden, image, 'version', '--json'], 120_000);
      const j = versionOf(v);
      if (!j) {
        d.available = false;
        d.cause = 'harness_error';
        d.reason = `\`docker run … version --json\` failed (exit ${v.code})`;
        return;
      }
      d.version = j;
      for (const p of policies) {
        const name = `arena-xcheck-${process.pid}-${p}`;
        servers.set(p, await startServer('docker', ['run', '--rm', '--name', name, '--network', 'host', ...harden, image, 'serve-reference', ...servePolicyArgs(p), '--port', '0', '--json'], () => sh('docker', ['rm', '-f', name], 60_000)));
      }
    },
    async stop() {
      await Promise.all([...servers.values()].map((s) => s.stop()));
      servers.clear();
    },
    async run(g, outDir) {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const s = servers.get(g.policy);
      if (!s) return { code: -1, error: `no reference server for ${g.policy}` };
      const p = await sh('docker', ['run', '--rm', '--network', 'host', ...harden, '-v', `${outDir}:/out`, image, ...g.args, '--target', s.urls[g.transport], '--out', '/out']);
      const rp = join(outDir, 'report.json');
      return existsSync(rp) ? { code: p.code, reportPath: rp } : { code: p.code, error: `exit ${p.code}, no report.json: ${p.stderr.slice(0, 200)}` };
    },
    async verify(reportPath) {
      const dir = dirname(reportPath);
      return verifyOut(await sh('docker', ['run', '--rm', '--network', 'none', ...harden, '-v', `${dir}:/out:ro`, image, 'verify', '/out/report.json', '--json']));
    },
  };
  return d;
}

/** H: reports the hosted runner already produced; verified (leg V) with the open workspace CLI. */
function hostedDriver(dir: string | undefined, key: string | undefined, verifier: { cmd: string; pre: string[] }): Driver {
  return {
    leg: 'H',
    name: 'hosted',
    available: !!dir && existsSync(dir),
    reason: !dir ? 'no --hosted-dir given' : !existsSync(dir) ? 'the --hosted-dir does not exist' : undefined,
    rerunnable: false,
    async start() {},
    async stop() {},
    async run(g) {
      const rp = join(dir!, g.id, 'report.json');
      return existsSync(rp) ? { code: 0, reportPath: rp } : { code: -1, error: `no hosted report for ${g.id}` };
    },
    async verify(reportPath) {
      const args = [...verifier.pre, 'verify', reportPath, '--json', ...(key ? ['--key', key, '--hosted'] : [])];
      return verifyOut(await sh(verifier.cmd, args));
    },
  };
}

// ── pool ────────────────────────────────────────────────────────────────────────
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

// ── the run ─────────────────────────────────────────────────────────────────────
export interface CrosscheckOptions {
  legs: LegName[];
  digest: string;
  out: string;
  sign?: string;
  kid?: string;
  binary?: string;
  image?: string;
  hostedDir?: string;
  hostedKey?: string;
  npmBin?: string;
  trigger?: 'pre_promotion' | 'nightly' | 'config_change';
  platform?: 'linux/amd64' | 'linux/arm64';
  platformManifest?: string;
  specRef?: string;
  specRepo?: string;
  filter?: MatrixFilter;
  concurrency?: number;
  stable?: boolean;
}

interface LegCellInfo {
  entry?: LegEntry;
  missingCause?: MissingCause;
  note?: string;
  verify?: string;
}
export interface CellSummary {
  cell_id: string;
  group: string;
  episode_index: number;
  seed: number;
  verdict: Verdict;
  retries: number;
  anchor?: string;
  anchor_skipped?: string;
  compared_legs: Leg[];
  diffs: string[];
  missing?: { leg: Leg; cause: MissingCause; note: string }[];
  verify?: Partial<Record<Leg, string>>;
}
export interface CrosscheckResult {
  record: Record<string, unknown>;
  summary: {
    job_verdict: JobVerdict;
    scope: Scope;
    exit_code: number;
    signed: boolean;
    legs: { leg: Leg; name: LegName | 'anchors'; state: 'ran' | 'missing'; reason?: string; version?: string; engine_build?: string }[];
    counts: Record<string, Record<Verdict, number>>;
    matrix: { groups: number; cells: number; digest: string };
    leg_v: Record<string, unknown>;
    build_mismatch: string[];
    notes: string[];
    cells: CellSummary[];
  };
  timing: Record<string, unknown>;
  exitCode: number;
}

const anchorSkip = (g: Group): string | undefined =>
  g.seatMode === 'member'
    ? 'served member seating is best effort (arena-cli reference/policy.ts): the frozen member m1 anchor is an in-process value no served target reproduces; compared across legs only'
    : undefined;

function anchorOf(g: Group, seed: number): AnchorValues | undefined {
  if (anchorSkip(g)) return undefined;
  const seat = g.seatMode === 'squad' ? 'squad' : g.seatMode === 'duel' ? 'A' : g.seatMode === 'member' ? 'm1' : 'auto';
  const a = anchorFor({ scenario: g.scenario, seat: seat as never, tier: g.tier, seed, policy: g.policy, ...(g.fill ? { fill: g.fill } : {}), ...(g.horizon ? { horizonYear: g.horizon } : {}) });
  if (!a) return undefined;
  const id = anchorId(a.name);
  return { name: a.name, ...(id ? { id } : {}), replay_hash: a.replayHash, outcome: a.outcome, ...(a.ticks !== undefined ? { terminal_tick: a.ticks } : {}) };
}

export function loadCrosscheckValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addKeyword({ keyword: 'x-max-frame-bytes' });
  ajv.addKeyword({ keyword: 'x-direction' });
  ajv.addFormat('date-time', (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)));
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
}

export async function runCrosscheck(o: CrosscheckOptions): Promise<CrosscheckResult> {
  const t0 = performance.now();
  const startedAt = o.stable ? STABLE_TIME : new Date().toISOString();
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const digest = o.digest.startsWith('sha256:') ? o.digest : `sha256:${o.digest}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('--digest must be sha256:<64 lowercase hex>');
  const notes: string[] = [];
  const groups = buildMatrix(o.filter);
  if (!groups.length) throw new Error('the matrix filter selects no groups');
  const matrixDoc = groups.map((g) => ({ id: g.id, block: g.block, scenario: g.scenario, tier: g.tier, seat: g.seatMode, position: g.position ?? null, fill: g.fill ?? null, transport: g.transport, policy: g.policy, reference_target: g.referenceTarget, seeds: g.seeds, args: g.args }));
  const matrixDigest = `sha256:${(await import('node:crypto')).createHash('sha256').update(jcs(matrixDoc)).digest('hex')}`;
  writeFileSync(join(out, 'matrix.json'), `${JSON.stringify({ digest: matrixDigest, groups: matrixDoc }, null, 2)}\n`);

  // Drivers
  const workspace = o.npmBin ? { cmd: o.npmBin, pre: [] as string[] } : { cmd: process.execPath, pre: ['--import', 'tsx', BIN] };
  const drivers: Driver[] = [];
  for (const name of o.legs) {
    if (name === 'npm') drivers.push(localDriver('O1', 'npm', workspace.cmd, workspace.pre, o.npmBin && !existsSync(o.npmBin) ? `--npm-bin ${o.npmBin} does not exist` : undefined));
    else if (name === 'binary') drivers.push(localDriver('O2', 'binary', o.binary ?? '', [], !o.binary ? 'no --binary given' : !existsSync(o.binary) ? `--binary ${o.binary} does not exist` : undefined));
    else if (name === 'docker') {
      const dockerOk = (await sh('docker', ['version', '--format', '{{.Server.Version}}'], 30_000)).code === 0;
      drivers.push(dockerDriver(o.image ?? `ghcr.io/rbrus/agent-arena@${digest}`, dockerOk ? undefined : 'docker is not available (no CLI or no daemon)'));
    } else if (name === 'hosted') drivers.push(hostedDriver(o.hostedDir, o.hostedKey, workspace));
  }
  const requested: Leg[] = drivers.map((d) => d.leg);
  const scope: Scope = requested.includes('H') ? 'hosted' : 'local';
  const policies = new Set(groups.map((g) => g.policy));
  const timing: Record<string, unknown> = { legs: {} as Record<string, unknown>, groups: {} as Record<string, unknown> };

  try {
    for (const d of drivers) {
      if (!d.available) continue;
      const ts = performance.now();
      try {
        await d.start(policies);
      } catch (e) {
        d.available = false;
        d.cause = 'harness_error';
        d.reason = `could not start the reference targets: ${(e as Error).message.slice(0, 200)}`;
      }
      (timing.legs as Record<string, unknown>)[`${d.leg} start`] = `${((performance.now() - ts) / 1000).toFixed(2)} s`;
    }

    // Per (leg, group): the CLI run (or the hosted report), parsed to per-seed entries.
    const info = new Map<string, LegCellInfo>(); // key `${leg}|${group}|${i}`
    const reports = new Map<string, { path: string; rep: Rep }>(); // key `${leg}|${group}`
    const buildMismatch: string[] = [];
    const runOne = async (d: Driver, g: Group, attempt: number): Promise<void> => {
      const ts = performance.now();
      const dir = join(out, 'legs', d.leg, attempt ? `${g.id}.retry${attempt}` : g.id);
      const r = await d.run(g, dir);
      (timing.groups as Record<string, string>)[`${d.leg} ${g.id}${attempt ? ` retry ${attempt}` : ''}`] = `${((performance.now() - ts) / 1000).toFixed(2)} s`;
      const cause: MissingCause = d.rerunnable ? 'harness_error' : 'other';
      const setAll = (note: string, c: MissingCause) => g.seeds.forEach((_, i) => info.set(`${d.leg}|${g.id}|${i}`, { missingCause: c, note }));
      if (!r.reportPath) return setAll(r.error ?? 'no report', cause);
      const { rep, error } = readReport(r.reportPath);
      if (!rep) return setAll(error!, 'harness_error');
      const mm = specMismatch(rep, g);
      if (mm) return setAll(`report is not this group's run (${mm})`, 'harness_error');
      reports.set(`${d.leg}|${g.id}`, { path: r.reportPath, rep });
      let verify: string | undefined;
      if (g.block === 'X3' && d.leg !== 'H') verify = (await d.verify(r.reportPath)).status;
      g.seeds.forEach((seed, i) => {
        const e = rep.episodes.find((x) => x.episode_index === i);
        const key = `${d.leg}|${g.id}|${i}`;
        if (!e || e.seed !== seed) return void info.set(key, { missingCause: 'harness_error', note: `episode ${i} (seed ${seed}) absent from the report` });
        if (g.position && g.seatMode !== 'power' && e.seat !== g.position) return void info.set(key, { missingCause: 'harness_error', note: `episode ${i} seated ${e.seat}, expected ${g.position}` });
        const entry = entryOf(e);
        info.set(key, entry ? { entry, ...(verify ? { verify } : {}) } : { missingCause: 'harness_error', note: `episode ${i} carries no replay_hash / trajectory_class` });
      });
    };

    const live = drivers.filter((d) => d.available);
    await pool(
      live.flatMap((d) => groups.map((g) => () => runOne(d, g, 0))),
      o.concurrency ?? Math.max(1, Math.min(4, cpus().length)),
    );

    // Tool / engine build equality across legs (§2.8: one tool version, one engine build).
    const ref = live.find((d) => d.version?.engine_builds.all)?.version ?? live.find((d) => d.version)?.version;
    for (const d of live) {
      if (!d.version || !ref || d.version === ref) continue;
      if (d.version.version !== ref.version) buildMismatch.push(`${d.leg}: tool ${d.version.version} differs from ${ref.version}`);
      else if (!d.version.engine_builds.all) notes.push(`${d.leg}: \`version --json\` reports no engine builds (older CLI); its build is checked per report only`);
      else if (d.version.engine_builds.all !== ref.engine_builds.all) buildMismatch.push(`${d.leg}: engine ${d.version.engine_builds.all} differs from ${ref.engine_builds.all}`);
    }
    if (ref) {
      for (const [k, { rep }] of reports) {
        const scope = rep.engine.build_scope ?? 'core';
        const want = ref.engine_builds[scope];
        if (rep.run.tool?.version && rep.run.tool.version !== ref.version) buildMismatch.push(`${k}: tool ${rep.run.tool.version} ≠ ${ref.version}`);
        else if (want && rep.engine.build_hash !== want) buildMismatch.push(`${k}: engine ${rep.engine.build_hash} ≠ ${want} (${scope})`);
      }
    }

    // Leg V: every hosted report through the open CLI's `verify` (with --hosted --key when a key is given).
    const legV = { reports_verified: 0, reports_total: 0, verify_exit_codes: {} as Record<string, number>, signatures_valid: true };
    const hosted = drivers.find((d) => d.leg === 'H' && d.available);
    if (hosted) {
      const hr = [...reports].filter(([k]) => k.startsWith('H|'));
      legV.reports_total = hr.length;
      const vs = await pool(hr.map(([, v]) => () => hosted.verify(v.path)), o.concurrency ?? 4);
      for (const v of vs) {
        const c = String(Math.min(3, Math.max(0, v.code)));
        legV.verify_exit_codes[c] = (legV.verify_exit_codes[c] ?? 0) + 1;
        if (v.code === 0) legV.reports_verified++;
        if (v.signature !== 'valid') legV.signatures_valid = false;
      }
      if (!o.hostedKey && hr.length) notes.push('leg V: no --hosted-key, so no hosted report signature was checked (signatures_valid=false)');
      if (!hr.length) legV.signatures_valid = false;
    }
    const legVFailed = !!hosted && (legV.reports_verified !== legV.reports_total || !legV.signatures_valid || legV.reports_total === 0);

    // Cells
    const cellsOut: Record<string, unknown>[] = [];
    const sums: CellSummary[] = [];
    const counters: Record<string, number> = { X1: 0, X2: 0, X3: 0 };
    const evalCell = (g: Group, i: number) => {
      const entries: Partial<Record<Leg, LegEntry>> = {};
      const extra: string[] = [];
      const verify: Partial<Record<Leg, string>> = {};
      const missingInfo: { leg: Leg; cause: MissingCause; note: string }[] = [];
      for (const d of drivers) {
        if (!d.available) {
          missingInfo.push({ leg: d.leg, cause: d.cause ?? 'other', note: `leg unavailable: ${d.reason}` });
          continue;
        }
        const x = info.get(`${d.leg}|${g.id}|${i}`);
        if (x?.entry) entries[d.leg] = x.entry;
        else missingInfo.push({ leg: d.leg, cause: x?.missingCause ?? 'harness_error', note: x?.note ?? 'no result' });
        if (x?.verify) {
          verify[d.leg] = x.verify;
          if (x.verify !== 'verified') extra.push(`verify: ${d.leg} ${x.verify} (transcript/replay not re-derived)`);
        }
      }
      const anchor = anchorOf(g, g.seeds[i]);
      return { entries, anchor, verify, missingInfo, ev: cellVerdict(entries, requested, anchor, extra) };
    };
    const state = groups.flatMap((g) => g.seeds.map((_, i) => ({ g, i, retries: 0, ...evalCell(g, i) })));

    // Environmental retries: re-run the group on the local legs, at most twice.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const env = state.filter((c) => c.ev.verdict === 'environmental');
      if (!env.length) break;
      const gs = [...new Set(env.map((c) => c.g))];
      await pool(live.filter((d) => d.rerunnable).flatMap((d) => gs.map((g) => () => runOne(d, g, attempt))), o.concurrency ?? 4);
      for (const c of env) Object.assign(c, { retries: attempt }, evalCell(c.g, c.i));
    }

    for (const c of state) {
      const { g, i, ev } = c;
      const id = `${g.block}-${++counters[g.block]}`;
      const cause: MissingCause = c.missingInfo.some((m) => m.cause === 'harness_error') ? 'harness_error' : 'other';
      const legs: Record<string, LegEntry | AnchorLeg> = {};
      for (const l of LEG_ORDER) if (c.entries[l]) legs[l] = c.entries[l]!;
      const aLeg = anchorLeg(c.anchor);
      if (aLeg) legs.A = aLeg; // 2.5.0: the frozen anchor, embedded (LEG_ORDER puts A last)
      const cell: Record<string, unknown> = {
        cell_id: id,
        block: g.block,
        scenario_id: g.scenario,
        budget_tier: g.tier,
        seat_mode: g.seatMode,
        ...(g.position ? { seat_position: g.position } : {}),
        ...(g.fill && g.seatMode !== 'power' ? { fill: g.fill } : {}),
        transport: g.transport,
        reference_target: g.referenceTarget,
        seed: g.seeds[i],
        episode_index: i,
        legs,
        verdict: ev.verdict,
        retries: c.retries,
        ...(ev.verdict === 'missing' ? { missing_legs: ev.missing.length ? ev.missing : requested, missing_cause: cause } : {}),
      };
      // A cell no leg produced and no anchor covers cannot be a record cell (the schema needs >= 1 leg object): summary only.
      if (!Object.keys(legs).length) {
        sums.push({ cell_id: id, group: g.id, episode_index: i, seed: g.seeds[i], verdict: 'missing', retries: c.retries, compared_legs: [], diffs: [], missing: c.missingInfo, ...(c.anchor ? { anchor: c.anchor.name } : {}) });
        cellsOut.push({ ...cell, __orphan: true });
        continue;
      }
      cellsOut.push(cell);
      sums.push({
        cell_id: id,
        group: g.id,
        episode_index: i,
        seed: g.seeds[i],
        verdict: ev.verdict,
        retries: c.retries,
        ...(c.anchor ? { anchor: c.anchor.name } : {}),
        ...(anchorSkip(g) ? { anchor_skipped: 'member seating (see notes)' } : {}),
        compared_legs: [...LEG_ORDER.filter((l) => c.entries[l]), ...(c.anchor ? (['A'] as Leg[]) : [])],
        diffs: ev.diffs,
        ...(c.missingInfo.length ? { missing: c.missingInfo } : {}),
        ...(Object.keys(c.verify).length ? { verify: c.verify } : {}),
      });
    }
    const orphans = cellsOut.filter((c) => c.__orphan).length;
    const recordCells = cellsOut.filter((c) => !c.__orphan);
    if (orphans) notes.push(`${orphans} cell(s) produced by no leg and covered by no anchor are listed in crosscheck_summary.json only (a record cell needs at least one leg object)`);
    const unembedded = state.filter((c) => c.anchor && !anchorLeg(c.anchor)).length;
    if (unembedded) notes.push(`${unembedded} anchored cell(s) have no frozen terminal tick, so leg A is compared but not embedded`);
    if (groups.some((g) => anchorSkip(g))) notes.push(`member m1 cells: ${anchorSkip(groups.find((g) => anchorSkip(g))!)}`);

    const hostedRan = !!hosted;
    const allCells = cellsOut.map((c) => ({ verdict: c.verdict as Verdict, missing_cause: c.missing_cause as MissingCause | undefined }));
    const job = jobVerdict(allCells, { legVFailed, buildMismatch: buildMismatch.length > 0, hostedRan, scope });
    if (scope === 'local') notes.push('scope local (no hosted leg requested): a `pass` means the open legs agree with each other and with the anchors; it never promotes a digest and is never cited by an evidence report');
    else if (!hostedRan) notes.push('the hosted leg (H) was requested but did not run: a hosted-scope record cannot `pass` without H');
    const nonMissingBad = allCells.some((c) => c.verdict !== 'match' && c.verdict !== 'missing');
    const exitCode = nonMissingBad || job === 'fail' ? 1 : 0;

    const legsInRecord: Leg[] = [...LEG_ORDER.filter((l) => requested.includes(l) || l === 'A')];
    if (legsInRecord.length < 2) throw new Error('internal: record needs at least two legs');
    const platform = o.platform ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64');
    const pm = o.platformManifest ?? digest;
    if (!o.platformManifest) notes.push('image_digest.platform_manifest defaults to the index digest (single-platform image as release.yml pushes it); pass --platform-manifest for a multi-arch index');
    const refVersion = { version: ref?.version ?? '0.0.0', all: ref?.engine_builds.all ?? `sha256:${'0'.repeat(64)}` };
    if (!ref?.engine_builds.all) notes.push('no local leg reported an engine build: tool_version / engine_build_hash are placeholders');

    const record: Record<string, unknown> = {
      record_version: '1.0',
      image_digest: { index: digest, platform_manifest: pm, platform },
      tool_version: refVersion.version,
      engine_build_hash: refVersion.all,
      trigger: o.trigger ?? 'pre_promotion',
      scope,
      ...(o.specRef ? { spec_set: { repo: o.specRepo ?? 'rbrus/agent-arena', ref: o.specRef, digest: matrixDigest } } : {}),
      legs: legsInRecord,
      cells: recordCells,
      leg_v: legV,
      job_verdict: job,
      started_at: startedAt,
      finished_at: o.stable ? STABLE_TIME : new Date().toISOString(),
      signing: { algorithm: 'ed25519', signing_key_id: o.kid ?? DEFAULT_KID, canonicalization: 'jcs-rfc8785', payload_type: CROSSCHECK_PAYLOAD_TYPE, excluded: [SIGNATURE_POINTER], signature: PLACEHOLDER_SIGNATURE },
    };
    const signed = o.sign ? signDocument(record as { signing: unknown }, readFileSync(o.sign, 'utf8'), CROSSCHECK_PAYLOAD_TYPE) : record;
    if (!o.sign) notes.push('unsigned: signing.signature is the all-"A" placeholder, which never verifies; pass --sign for a publishable record');
    const validate = loadCrosscheckValidator();
    if (!validate(signed)) throw new Error(`internal: the record is invalid against crosscheck_record.schema.json: ${JSON.stringify(validate.errors?.slice(0, 5))}`);

    const counts: Record<string, Record<Verdict, number>> = {};
    for (const s of sums) {
      const b = s.cell_id.split('-')[0];
      counts[b] ??= { match: 0, environmental: 0, divergent: 0, missing: 0 };
      counts[b][s.verdict]++;
    }
    const summary: CrosscheckResult['summary'] = {
      job_verdict: job,
      scope,
      exit_code: exitCode,
      signed: !!o.sign,
      legs: [
        ...drivers.map((d) => ({ leg: d.leg, name: d.name, state: d.available ? ('ran' as const) : ('missing' as const), ...(d.reason && !d.available ? { reason: d.reason } : {}), ...(d.version ? { version: d.version.version, engine_build: d.version.engine_builds.all } : {}) })),
        { leg: 'A' as Leg, name: 'anchors' as const, state: 'ran' as const },
      ],
      counts,
      matrix: { groups: groups.length, cells: sums.length, digest: matrixDigest },
      leg_v: legV,
      build_mismatch: buildMismatch,
      notes,
      cells: sums,
    };
    writeFileSync(join(out, 'crosscheck_record.json'), `${JSON.stringify(signed, null, 2)}\n`);
    writeFileSync(join(out, 'crosscheck_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    timing.started_at = o.stable ? STABLE_TIME : startedAt;
    timing.wall_clock_s = Number(((performance.now() - t0) / 1000).toFixed(2));
    timing.real_started_at = new Date(Date.now() - (performance.now() - t0)).toISOString();
    timing.real_finished_at = new Date().toISOString();
    writeFileSync(join(out, 'timing.json'), `${JSON.stringify(timing, null, 2)}\n`);
    return { record: signed, summary, timing, exitCode };
  } finally {
    await Promise.all(drivers.map((d) => d.stop().catch(() => undefined)));
  }
}

// ── compare (seal route) ────────────────────────────────────────────────────────
/** Members `--compare` does not compare: the seal (the sealer adds or replaces it) and the wall-clocks. */
export const COMPARE_IGNORED = ['/signing', '/started_at', '/finished_at'] as const;
const RECORD_MAX_BYTES = 4 * 1024 * 1024; // crosscheck_record x-max-frame-bytes

export interface CompareResult {
  equal: boolean;
  cells_compared: number;
  cells_differing: number;
  differences: string[];
  ignored: readonly string[];
}

const canon = (v: unknown): string => (v === undefined ? '(absent)' : jcs(v));
const shortVal = (v: unknown): string => {
  const t = canon(v);
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
};

/**
 * The seal route's equality check (SIXI-INTEGRATION §1.14 step 6): two cross-check records for the
 * same job must agree on every member but the seal and the wall-clocks, and cell by cell on every
 * field of every leg. Both records are schema-validated first; an invalid one throws.
 */
export function compareRecords(a: unknown, b: unknown): CompareResult {
  const validate = loadCrosscheckValidator();
  for (const [n, d] of [['A', a], ['B', b]] as const) {
    if (!validate(d)) throw new Error(`record ${n} is invalid against crosscheck_record.schema.json: ${JSON.stringify(validate.errors?.slice(0, 3)).slice(0, 400)}`);
  }
  const A = a as Record<string, unknown>;
  const B = b as Record<string, unknown>;
  const differences: string[] = [];
  const skip = new Set(['cells', ...COMPARE_IGNORED.map((p) => p.slice(1))]);
  for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    if (skip.has(k)) continue;
    if (canon(A[k]) !== canon(B[k])) differences.push(`/${k}: A=${shortVal(A[k])} B=${shortVal(B[k])}`);
  }
  type Cell = Record<string, unknown> & { cell_id: string; legs: Record<string, Record<string, unknown>> };
  const ca = A.cells as Cell[];
  const cb = B.cells as Cell[];
  const ib = new Map(cb.map((c) => [c.cell_id, c]));
  const ia = new Map(ca.map((c) => [c.cell_id, c]));
  const ids = [...new Set([...ca.map((c) => c.cell_id), ...cb.map((c) => c.cell_id)])];
  let differing = 0;
  let compared = 0;
  for (const id of ids) {
    const x = ia.get(id);
    const y = ib.get(id);
    if (!x || !y) {
      differing++;
      differences.push(`cell ${id}: only in record ${x ? 'A' : 'B'}`);
      continue;
    }
    compared++;
    const before = differences.length;
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      if (k === 'legs') {
        for (const leg of [...new Set([...Object.keys(x.legs), ...Object.keys(y.legs)])].sort()) {
          const lx = x.legs[leg];
          const ly = y.legs[leg];
          if (!lx || !ly) {
            differences.push(`cell ${id} leg ${leg}: only in record ${lx ? 'A' : 'B'}`);
            continue;
          }
          for (const f of [...new Set([...Object.keys(lx), ...Object.keys(ly)])].sort()) {
            if (canon(lx[f]) !== canon(ly[f])) differences.push(`cell ${id} leg ${leg} ${f}: A=${shortVal(lx[f])} B=${shortVal(ly[f])}`);
          }
        }
      } else if (canon(x[k]) !== canon(y[k])) differences.push(`cell ${id} ${k}: A=${shortVal(x[k])} B=${shortVal(y[k])}`);
    }
    if (differences.length > before) differing++;
  }
  // JCS identity also needs the same cell order.
  if (!differing && ca.map((c) => c.cell_id).join() !== cb.map((c) => c.cell_id).join()) differences.push('cells: same cells in a different order');
  return { equal: differences.length === 0, cells_compared: compared, cells_differing: differing, differences, ignored: COMPARE_IGNORED };
}

function readRecordFile(path: string): unknown {
  if (!existsSync(path)) throw new Error(`${path}: no such file`);
  if (statSync(path).size > RECORD_MAX_BYTES) throw new Error(`${path}: over ${RECORD_MAX_BYTES} bytes`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path}: not JSON`);
  }
}

function compareMain(argv: string[]): void {
  const json = argv.includes('--json');
  const paths = argv.filter((a) => a !== '--json');
  if (paths.length !== 2 || paths.some((p) => p.startsWith('--'))) {
    process.stderr.write('crosscheck: --compare takes exactly two record files: --compare <recordA> <recordB> [--json]\n');
    process.exitCode = 2;
    return;
  }
  let r: CompareResult;
  try {
    r = compareRecords(readRecordFile(paths[0]), readRecordFile(paths[1]));
  } catch (e) {
    process.stderr.write(`crosscheck: compare: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    process.stdout.write(`compare: ${r.equal ? 'EQUAL' : 'DIFFERENT'}; ${r.cells_compared} cells compared, ${r.cells_differing} differ; ignored ${r.ignored.join(', ')}\n`);
    for (const d of r.differences.slice(0, 60)) process.stdout.write(`  ${d}\n`);
    if (r.differences.length > 60) process.stdout.write(`  … ${r.differences.length - 60} more (--json)\n`);
  }
  process.exitCode = r.equal ? 0 : 1;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): CrosscheckOptions & { json: boolean } {
  const m = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stable' || a === '--json') flags.add(a);
    else if (a.startsWith('--') && i + 1 < argv.length) m.set(a.slice(2), argv[++i]);
    else throw new Error(`unknown argument ${a.slice(0, 60)}`);
  }
  const known = new Set(['legs', 'digest', 'out', 'sign', 'kid', 'binary', 'image', 'hosted-dir', 'hosted-key', 'npm-bin', 'trigger', 'platform', 'platform-manifest', 'spec-ref', 'spec-repo', 'blocks', 'tiers', 'scenarios', 'concurrency']);
  for (const k of m.keys()) if (!known.has(k)) throw new Error(`unknown option --${k.slice(0, 40)}`);
  const legs = (m.get('legs') ?? 'npm').split(',').map((s) => s.trim()) as LegName[];
  for (const l of legs) if (!(l in LEG_OF)) throw new Error(`--legs takes npm, binary, docker, hosted (got ${String(l).slice(0, 20)})`);
  if (new Set(legs).size !== legs.length) throw new Error('--legs lists a leg twice');
  if (!m.get('digest')) throw new Error('--digest sha256:<64 hex> is required (the image index digest the record is for)');
  if (!m.get('out')) throw new Error('--out <dir> is required');
  const list = (k: string) => m.get(k)?.split(',').map((s) => s.trim()).filter(Boolean);
  const trig = m.get('trigger');
  if (trig && !['pre_promotion', 'nightly', 'config_change'].includes(trig)) throw new Error('--trigger is pre_promotion, nightly or config_change');
  const plat = m.get('platform');
  if (plat && plat !== 'linux/amd64' && plat !== 'linux/arm64') throw new Error('--platform is linux/amd64 or linux/arm64');
  if (m.get('spec-ref') && !/^[0-9a-f]{7,40}$/.test(m.get('spec-ref')!)) throw new Error('--spec-ref is a 7..40 hex git sha');
  const conc = m.get('concurrency') ? Number(m.get('concurrency')) : undefined;
  if (conc !== undefined && (!Number.isInteger(conc) || conc < 1 || conc > 32)) throw new Error('--concurrency is 1..32');
  return {
    legs,
    digest: m.get('digest')!,
    out: m.get('out')!,
    sign: m.get('sign'),
    kid: m.get('kid'),
    binary: m.get('binary'),
    image: m.get('image'),
    hostedDir: m.get('hosted-dir'),
    hostedKey: m.get('hosted-key'),
    npmBin: m.get('npm-bin'),
    trigger: trig as CrosscheckOptions['trigger'],
    platform: plat as CrosscheckOptions['platform'],
    platformManifest: m.get('platform-manifest'),
    specRef: m.get('spec-ref'),
    specRepo: m.get('spec-repo'),
    filter: { blocks: list('blocks'), tiers: list('tiers'), scenarios: list('scenarios') },
    concurrency: conc,
    stable: flags.has('--stable'),
    json: flags.has('--json'),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--compare')) return compareMain(argv.filter((a) => a !== '--compare'));
  let o: ReturnType<typeof parseArgs>;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`crosscheck: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  let r: CrosscheckResult;
  try {
    r = await runCrosscheck(o);
  } catch (e) {
    process.stderr.write(`crosscheck: harness error: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const L = (s = ''): void => void process.stdout.write(`${s}\n`);
  if (o.json) {
    L(JSON.stringify({ job_verdict: r.summary.job_verdict, scope: r.summary.scope, exit_code: r.exitCode, counts: r.summary.counts, legs: r.summary.legs, matrix: r.summary.matrix, notes: r.summary.notes }, null, 2));
  } else {
    L('='.repeat(96));
    L('  Agent Arena — arena-crosscheck (HOSTED-PROFILE §2.8)');
    L('='.repeat(96));
    L(`  image      ${(r.record.image_digest as { index: string }).index}`);
    L(`  tool       ${r.record.tool_version}   engine ${r.record.engine_build_hash}`);
    for (const l of r.summary.legs) L(`  leg ${l.leg.padEnd(3)} ${l.name.padEnd(8)} ${l.state}${l.reason ? ` (${l.reason})` : ''}`);
    L(`  matrix     ${r.summary.matrix.groups} runs, ${r.summary.matrix.cells} cells, digest ${r.summary.matrix.digest}`);
    L('');
    L('  block   match  environmental  divergent  missing');
    for (const [b, c] of Object.entries(r.summary.counts)) L(`  ${b.padEnd(6)} ${String(c.match).padStart(6)} ${String(c.environmental).padStart(14)} ${String(c.divergent).padStart(10)} ${String(c.missing).padStart(8)}`);
    const bad = r.summary.cells.filter((c) => c.verdict === 'divergent' || c.verdict === 'environmental');
    for (const c of bad.slice(0, 40)) L(`    ${c.verdict.padEnd(13)} ${c.cell_id} ${c.group} ep${c.episode_index}${c.retries ? ` (after ${c.retries} retries)` : ''}: ${c.diffs.slice(0, 3).join(' | ').slice(0, 300)}`);
    if (bad.length > 40) L(`    … ${bad.length - 40} more in crosscheck_summary.json`);
    const miss = new Map<string, number>();
    for (const c of r.summary.cells) for (const m of c.missing ?? []) miss.set(`${m.leg} (${m.cause}): ${m.note.slice(0, 160)}`, (miss.get(`${m.leg} (${m.cause}): ${m.note.slice(0, 160)}`) ?? 0) + 1);
    for (const [k, n] of miss) L(`    missing       ${n} cell(s) — ${k}`);
    if (r.summary.build_mismatch.length) for (const b of r.summary.build_mismatch) L(`  BUILD MISMATCH ${b}`);
    L(`  leg V      ${JSON.stringify(r.summary.leg_v)}`);
    for (const n of r.summary.notes) L(`  note: ${n}`);
    L('-'.repeat(96));
    L(`  JOB VERDICT: ${r.summary.job_verdict} (scope ${r.summary.scope})   exit ${r.exitCode}   record ${join(resolve(o.out), 'crosscheck_record.json')}${r.summary.signed ? ' (signed)' : ' (unsigned)'}`);
    if (!o.stable) L(`  wall-clock: ${r.timing.wall_clock_s} s (timing.json)`);
    L('='.repeat(96));
  }
  process.exitCode = r.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
