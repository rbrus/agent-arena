/**
 * Phase-9 GATE (C1, in-repo part) — Sixi Arena hosted layer (sim-qa + security-architect).
 * Criteria 1–6 of docs/phase-7/PLAN.md §3 "Phase 9 — Gate (objective)", restricted to what THIS
 * repository can prove without Sixi's infrastructure. Everything that needs the Sixi control plane
 * (sixi-scanner PR 1–7, docs/phase-9/SIXI-INTEGRATION.md §2) is printed as `N-A (Sixi side)` and
 * never scored either way.
 *
 *   Run:  npm run gate:phase9                  (from ascension/)
 *         npx tsx qa/phase9-gate.ts [--stable] [--no-local-crosscheck] [--layout private|public|auto]
 *
 *   --layout               repository layout (qa/phase7-gate.ts): in the public layout the private evidence
 *                          document (docs/phase-9/SECURITY-REVIEW-HOSTED.md) is N-A (private evidence), unscored
 *   --stable               omit the wall-clock block, so two runs can be diffed byte for byte
 *   --no-local-crosscheck  skip the full npm-leg cross-check matrix (321 cells, ~40 s); X-XCHECK-LOCAL
 *                          and C2-LOCAL-RECORD-REFUSED then report SKIP and the gate cannot open
 *
 * Opt-in `npm test` wrapper: ARENA_PHASE9=1 npm test (services/arena/test/phase9-gate.test.ts).
 *
 * What runs, and through which door:
 *
 *   PUBLIC CLI (child processes, `node --import tsx packages/arena-cli/src/bin.ts …`):
 *     serve-reference --hosted (run-token + Host check), run (open leg of the per-episode comparison),
 *     run --hosted (every refusal: env, packs, sx_, manifests, G-45 logs, beta-condition probes),
 *     verify --hosted / verify --hosted-seal (pre-seal and sealed), and qa/crosscheck.ts (npm and
 *     hosted legs, --compare).
 *
 *   ONE PRIVATE SEAM (in-process `runHostedCommand(…, { transportFactory })`), for the hosted runs
 *   that must complete: hosted-v1 refuses loopback and private addresses by design, so a hosted run
 *   can only ever complete against a public https origin. The harness therefore lets `run --hosted`
 *   do everything it does in production — manifest signature, RunSpec digest, image digest, engine
 *   build, packs, credential intake and scrubbing, the hosted-v1 NetContext for the verified origin
 *   `https://agent.example.com` — and replaces only the last step, the socket: the seam hands the
 *   transport a loopback NetContext pointed at the `serve-reference --hosted` child, carrying the
 *   credential the hosted context bound to the verified origin (a Sixi run token, EdDSA at+jwt) and
 *   a `Host: agent.example.com` header. BYPASSED: DNS resolution of the verified origin, the
 *   hosted-v1 per-socket address check, TLS (and so `observed_connections`), and the rps cap.
 *   Exercised: every refusal before I/O, the production transport code, the reference target's Host
 *   allowlist and run-token verification (`--require-run-token`), the run-id binding, the report and
 *   the bundle. (Filed for sdk-engineer: the CLI has no public way to complete a hosted run against a
 *   local origin; by design it should not, so this stays a documented test seam.)
 *
 *   Library calls (no CLI surface exists): the pack loader on the contracts fixture pack
 *   (`loadPacks` with the fixture's own pinned engine build), `renderEvidenceReport` (arena-report).
 *
 * Keys: every signature is made with the RFC 8032 §7.1 TEST 1 key (contracts/fixtures/
 * signing_vectors.json), standing in for Sixi's KMS keys (manifest, report, run token, cross-check).
 *
 * Deterministic: fixed seeds, fixed run ids, fixed sealed_at; nothing printed depends on the clock,
 * a port, a path or a token. Wall-clocks are printed only in the trailing block (dropped by --stable).
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, sign as edSign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeForSigning,
  EvidenceRenderError,
  R1_PATTERN,
  REPORT_PAYLOAD_TYPE,
  renderEvidenceReport,
  signedBodyDigest,
  signReport,
  toFileJson,
  toSarif,
  validateEvidenceReportSchema,
  validateReportSchema,
  validateSarif,
  type CrosscheckRecordInput,
  type EvidenceCorpus,
  type EvidenceRenderOptions,
  type PackManifest,
  type Report,
} from 'arena-report';
import { anchorFor } from 'arena-scenarios';
import { engineBuildFor } from '../packages/arena-cli/src/build-info.ts';
import { runHostedCommand } from '../packages/arena-cli/src/commands/run-hosted.ts';
import { episodeSecretCommitment } from '../packages/arena-cli/src/hosted/manifest.ts';
import { loadPacks, packCoverageMissing, resolveVariant, PACK_ENVELOPE_FILE } from '../packages/arena-cli/src/hosted/packs.ts';
import { BUNDLE_PAYLOAD_TYPE, SARIF_PAYLOAD_TYPE } from '../packages/arena-cli/src/hosted/seal.ts';
import { loadPublicKeySet } from '../packages/arena-cli/src/keys.ts';
import { DEFAULT_POLICY, NetContext, type NetContextOptions } from '../packages/arena-cli/src/net/index.ts';
import { createTransport, type Answer, type TargetSession, type Transport, type TransportName } from '../packages/arena-cli/src/transports/index.ts';
import { setOutputMode } from '../packages/arena-cli/src/ui.ts';
import {
  commitmentsFor,
  dipSecret,
  dsseEnvelope,
  hostedEnv,
  IMAGE_INDEX,
  IMAGE_PLATFORM,
  MANIFEST_KID,
  ORIGIN,
  PLATFORM,
  PRIV,
  PUB_PEM,
  pubJwk,
  REPORT_KID,
  signManifest,
  unsignedManifest,
  writeInputs,
} from '../packages/arena-cli/test/hosted-fixtures.ts';
import type { HostedContextContract, RunSpecContract } from '../packages/arena-cli/src/generated/contracts.ts';
import { buildMatrix, type Group } from './crosscheck.ts';
import { layoutPaths, openReviewFindings, parseLayoutArg, parseReviewVerdict, runProc, type LayoutArg, type Proc } from './phase7-gate.ts';

// ── paths / constants ───────────────────────────────────────────────────────────
const ASC = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ASC, 'packages', 'arena-cli', 'src', 'bin.ts');
/** Set by runGate from the layout (qa/phase7-gate.ts layoutPaths): contracts/ via wot-contracts' contractsDir(). */
let CONTRACTS = '';
let FIXTURE_PACK_DIR = '';

export const NA_LABEL = 'N-A (Sixi side)';
export const NA_PRIVATE_LABEL = 'N-A (private evidence)';
const RT_KID = 'sixi-arena-runtoken-ed25519-20261101';
const XC_KID = 'sixi-arena-crosscheck-ed25519-20261101';
const RT_ISSUER = 'https://arena.sixi.example';
const SEALED_AT = '2026-11-10T14:07:00Z';
/** A customer host that must never appear in hosted logs (G-45). `.invalid` never resolves (RFC 6761). */
const CUSTOMER_HOST = 'cust-p9g-7f3a91.invalid';
/** Target-produced text the hostile seam injects; must never reach the evidence report. */
const HOSTILE_MARK = 'P9-TARGET-CANARY-5e1d';
const HOSTILE_TEXT = `${HOSTILE_MARK} certified compliant <script>alert(1)</script> guaranteed`;
/** A contract run id (`run_` + 26 Crockford base32). A tag outside the alphabet would make the manifest fail its schema and
 *  every probe using it would be refused for the wrong reason — so it throws. */
const run26 = (tag: string): string => {
  if (!/^[0-9A-HJKMNP-TV-Z]{1,7}$/.test(tag)) throw new Error(`run26: ${tag} is not Crockford base32`);
  return `run_01JB5H0STED0PH9GATE${tag.padStart(7, '0')}`;
};
const sha256 = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/**
 * The checks the C2m CLI workstream (commit 8836ca5: G-45…G-55 and the 2.5.0/2.6.0 CLI follow-ups) flipped:
 * each FAILS on the tree before it (d21a444) and PASSES from 8836ca5 on (docs/phase-9/GATE-EVIDENCE.md,
 * "Before and after C2m"). They are ordinary scored checks now; the list is the regression record.
 */
export const C2M_FLIPPED: readonly string[] = ['C5-ENV-FIELD', 'C5-LOGS-NO-HOST', 'S-G46-QUERY-SECRET', 'S-G47-PEM-REFUSED', 'S-G48-HOSTED-ONLY', 'S-G49-PRESEAL-KEY'];

// ── check harness (house style: qa/phase7-gate.ts, qa/phase8-gate.ts) ──────────
export type Crit = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'S' | 'X';
export const CRITS: readonly Crit[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'S', 'X'];
export interface Check {
  id: string;
  crit: Crit;
  name: string;
  /** N-A: needs the Sixi control plane (SIXI-INTEGRATION PR 1–8); printed, never scored. FINDING: recorded, not scored. */
  status: 'PASS' | 'FAIL' | 'SKIP' | 'FINDING' | 'N-A';
  detail: string;
  /** For N-A: `sixi` (needs the Sixi control plane) or `private` (a private evidence document the public layout lacks). */
  naKind?: 'sixi' | 'private';
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
  na(crit: Crit, id: string, name: string, detail: string, naKind: 'sixi' | 'private' = 'sixi'): void {
    this.list.push({ id, crit, name, status: 'N-A', detail, naKind });
  }
  /** Run `fn`; an exception is a FAIL of `id` with the error's first line (never a crash of the gate). */
  async guard(crit: Crit, id: string, name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.ok(crit, id, name, false, `harness error: ${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200)}`);
    }
  }
}

export type CritVerdict = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'N-A';
/** FAIL on any FAIL; INCOMPLETE on any SKIP; N-A when every check is N-A; else PASS. N-A and FINDING never count. */
export function scoreCriteria(checks: readonly Check[]): Record<Crit, CritVerdict> {
  return Object.fromEntries(
    CRITS.map((c) => {
      const cs = checks.filter((x) => x.crit === c);
      if (cs.some((x) => x.status === 'FAIL')) return [c, 'FAIL'];
      if (cs.some((x) => x.status === 'SKIP')) return [c, 'INCOMPLETE'];
      if (cs.length > 0 && cs.every((x) => x.status === 'N-A')) return [c, 'N-A'];
      return [c, 'PASS'];
    }),
  ) as Record<Crit, CritVerdict>;
}
export function verdictLine(criteria: Record<Crit, CritVerdict>): string {
  const blocked = CRITS.filter((c) => criteria[c] !== 'PASS' && criteria[c] !== 'N-A');
  return `PHASE 9 (in-repo): ${blocked.length ? `BLOCKED (${blocked.join(', ')})` : 'OPEN'} — Sixi-side criteria not evaluated`;
}
export function renderCheck(x: Pick<Check, 'id' | 'name' | 'status' | 'detail' | 'naKind'>): string {
  const label = x.status === 'N-A' ? (x.naKind === 'private' ? NA_PRIVATE_LABEL : NA_LABEL) : x.status;
  return `    ${label.padEnd(7)} [${x.id}] ${x.name}${x.detail ? `  — ${x.detail}` : ''}`;
}

export interface GateOptions {
  /** Run the full npm-leg cross-check matrix (scope local, ~40 s). Default true. */
  localCrosscheck?: boolean;
  /** Repository layout to read (default auto; qa/phase7-gate.ts). */
  layout?: LayoutArg;
}
export interface GateResult {
  checks: Check[];
  layout: 'private' | 'public';
  criteria: Record<Crit, CritVerdict>;
  gateOpen: boolean;
  notes: string[];
  measurements: Record<string, string>;
  outDir: string;
}

// ── subprocesses (qa/phase7-gate.ts runProc: own process group, group kill on timeout) ──
const sh = (cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<Proc> =>
  runProc(cmd, args, { cwd: o.cwd ?? ASC, timeoutMs: o.timeoutMs ?? 300_000, env: Object.fromEntries(Object.entries(o.env ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string> });
const BASE_ENV = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' });
/** The public CLI from source (the entry the published bundle wraps). */
const cli = (args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 300_000) => sh(process.execPath, ['--import', 'tsx', BIN, ...args], { env, timeoutMs });

interface RefServer {
  urls: Record<'rest' | 'ws' | 'mcp' | 'a2a' | 'healthz', string>;
  port: number;
  stop(): Promise<void>;
}
/** Reference-server process groups still alive, killed if the gate exits early. */
const SERVER_GROUPS = new Set<(sig: NodeJS.Signals) => void>();
process.once('exit', () => {
  for (const k of SERVER_GROUPS) k('SIGKILL');
});
/** `agent-arena serve-reference … --port 0 --json` as a child process. */
function serveReference(args: string[]): Promise<RefServer> {
  return new Promise((resolve, reject) => {
    // Its own process group (as runProc), so a stop or a failed start kills everything it spawned.
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, 'serve-reference', ...args, '--port', '0', '--json'], { cwd: ASC, env: BASE_ENV() as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    SERVER_GROUPS.add(killGroup);
    let buf = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        killGroup('SIGKILL');
        reject(new Error('serve-reference did not report its port within 60 s'));
      }
    }, 60_000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      buf += d;
      if (done) return;
      let info: { port?: number; urls?: RefServer['urls'] } | undefined;
      try {
        info = JSON.parse(buf);
      } catch {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({
        urls: info!.urls!,
        port: info!.port!,
        stop: () =>
          new Promise<void>((r) => {
            SERVER_GROUPS.delete(killGroup);
            if (child.exitCode !== null) return r();
            child.once('close', () => r());
            killGroup('SIGTERM');
          }),
      });
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`serve-reference exited ${code}: ${err.split('\n')[0].slice(0, 160)}`));
      }
    });
  });
}

function httpGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

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

// ── tokens, keys, sealing ───────────────────────────────────────────────────────
/** A Sixi run token (contracts signing.md §10 profile) signed with the RFC 8032 test key. */
function mintRunToken(runId: string, aud = ORIGIN): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'at+jwt', kid: RT_KID })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: RT_ISSUER, aud, sub: runId, org: 'org_TEST000000001', iat: now, exp: now + 900, jti: `jti-${runId.slice(-12)}` })).toString('base64url');
  return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), PRIV).toString('base64url')}`;
}

/** What the Sixi seal step writes (docs/phase-9/HOSTED-PROFILE §2.7), with the test key standing in for the KMS report key. */
function sealBundle(out: string): Report {
  const report = readJson<Report>(join(out, 'report.json'));
  const sealed = signReport(report, PRIV, REPORT_KID, { sealedAt: SEALED_AT });
  writeFileSync(join(out, 'report.json'), toFileJson(sealed));
  writeFileSync(join(out, 'report.json.dsse.json'), dsseEnvelope(Buffer.from(canonicalizeForSigning(sealed), 'utf8'), REPORT_PAYLOAD_TYPE, REPORT_KID));
  writeFileSync(join(out, 'report.sarif.dsse.json'), dsseEnvelope(readFileSync(join(out, 'report.sarif')), SARIF_PAYLOAD_TYPE, REPORT_KID));
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (!statSync(p).isFile()) walk(p);
      else {
        const rel = relative(out, p);
        if (/^(report\.json|report\.sarif|run-manifest\.json|episodes\/\d+\.(record|replay)\.json)$/.test(rel)) {
          const b = readFileSync(p);
          files.push({ path: rel, sha256: sha256(b), bytes: b.length });
        }
      }
    }
  };
  walk(out);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const bm = `${JSON.stringify({ bundle_version: '1.0', run_id: sealed.run.run_id, signing_key_id: REPORT_KID, files }, null, 2)}\n`;
  writeFileSync(join(out, 'bundle-manifest.json'), bm);
  writeFileSync(join(out, 'bundle-manifest.json.dsse.json'), dsseEnvelope(Buffer.from(bm), BUNDLE_PAYLOAD_TYPE, REPORT_KID));
  return sealed;
}

/** Every byte of every file under `dir`, for leak scans. */
function allText(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (!statSync(p).isFile()) walk(p);
      else out.push({ path: relative(dir, p), text: readFileSync(p).toString('latin1') });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * In-process hosted runs write their CLI log lines (the job's Cloud Logging stream) to this process's stderr.
 * They are captured, kept out of the gate output, and inspected (C5-LOGS-TARGET-TEXT).
 */
const cliLog: string[] = [];
async function capturingStderr<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    cliLog.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = orig;
  }
}

// ── the seam ────────────────────────────────────────────────────────────────────
/** A loopback context that presents the verified origin's Host (the reference's Host allowlist sees production headers). */
class HostPinnedContext extends NetContext {
  constructor(o: NetContextOptions, private readonly hostHeader: string) {
    super(o);
  }
  override baseHeaders(): Record<string, string> {
    return { ...super.baseHeaders(), host: this.hostHeader };
  }
}
interface Seen {
  ctx?: NetContext;
  url?: URL;
  name?: TransportName;
}
/**
 * The documented seam (file header): `run --hosted` builds its hosted-v1 NetContext for the verified
 * origin and hands it here; the transport is the production one, dialing the `serve-reference --hosted`
 * child on loopback with the credential the hosted context bound to the verified origin.
 */
function viaHostedReference(localUrl: string, seen: Seen, wrap?: (t: Transport) => Transport) {
  return (ctx: NetContext, url: URL, name: TransportName): Transport => {
    seen.ctx = ctx;
    seen.url = url;
    seen.name = name;
    const [header, value] = Object.entries(ctx.credentialFor(url))[0] ?? [];
    const local = new URL(localUrl);
    const lctx = new HostPinnedContext(
      { policy: { ...DEFAULT_POLICY, loopbackLiteral: true }, target: local, userAgent: ctx.userAgent, runId: ctx.runId, rps: 0, ...(header ? { credential: { header, value } } : {}) },
      url.host,
    );
    const t = createTransport(name, lctx, local);
    return wrap ? wrap(t) : t;
  };
}
/** A hostile target (malicious-target corpus): a refusal carrying target text, an extra text member, a non-JSON frame. */
function hostile(t: Transport): Transport {
  return {
    name: t.name,
    connect: (d) => t.connect(d),
    close: () => t.close(),
    async openEpisode(id, d) {
      const s = await t.openEpisode(id, d);
      let n = 0;
      const session: TargetSession = {
        async decide(frame, deadline): Promise<Answer> {
          n++;
          const a = await s.decide(frame, deadline);
          if (n === 2) return { kind: 'refused', why: 'status', status: 500, detail: HOSTILE_TEXT };
          if (n === 3 && a.kind === 'frame') {
            const raw = JSON.stringify({ ...(JSON.parse(a.raw) as object), note: HOSTILE_TEXT, reason: HOSTILE_TEXT });
            return { kind: 'frame', raw, bytes: Buffer.byteLength(raw) };
          }
          if (n === 4) return { kind: 'frame', raw: HOSTILE_TEXT, bytes: Buffer.byteLength(HOSTILE_TEXT) };
          return a;
        },
        end: (f, dl) => s.end(f, dl),
        close: () => s.close(),
        ...(s.more ? { more: (dl: number) => s.more!(dl) } : {}),
      };
      return session;
    },
  };
}

// ── the hosted RunSpec derived from the open CLI's own RunSpec ──────────────────
function hostedSpecFrom(open: Record<string, unknown>): RunSpecContract {
  const { labels: _l, target: _t, ...rest } = open;
  return { ...rest, target: { transport: 'rest', url: `${ORIGIN}/arena/act`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } }, labels: { ci_run: 'phase9-gate' } } as unknown as RunSpecContract;
}

/** Episode tuples compared across legs: hash, outcome, terminal tick, sorted verdicts. */
function episodeTuples(r: Report): string[] {
  return r.episodes.map((e) => {
    const v = (e.oracles ?? []).map((o) => `${o.oracle_id}:${o.seat ?? ''}:${o.verdict}:${o.severity ?? ''}`).sort().join(',');
    return `${e.episode_index}|${e.seed}|${e.status}|${e.outcome}|${e.terminal_tick}|${e.replay_hash}|${v}`;
  });
}

// ═════════════════════════════════════════════════════════════════════════════════
export async function runGate(opts: GateOptions = {}): Promise<GateResult> {
  const localXc = opts.localCrosscheck !== false;
  const P = layoutPaths(ASC, opts.layout ?? 'auto');
  CONTRACTS = P.contracts;
  FIXTURE_PACK_DIR = join(CONTRACTS, 'fixtures', 'packs', 'sx-agentic-core');
  const C = new Checks();
  const notes: string[] = [];
  const M: Record<string, string> = {};
  const tGate = performance.now();
  const OUT = mkdtempSync(join(tmpdir(), 'phase9-gate-'));
  setOutputMode({ quiet: true });

  // Key files (public halves; the private test key only for the cross-check --sign).
  const K = join(OUT, 'keys');
  mkdirSync(K, { recursive: true });
  const reportKey = join(K, 'report.jwk.json');
  const manifestKey = join(K, 'manifest.jwk.json');
  const manifestPem = join(K, 'manifest.pem');
  const runTokenKey = join(K, 'runtoken.jwk.json');
  const xcPriv = join(K, 'crosscheck-test-key.pem');
  writeFileSync(reportKey, pubJwk(REPORT_KID));
  writeFileSync(manifestKey, pubJwk(MANIFEST_KID));
  writeFileSync(manifestPem, PUB_PEM);
  writeFileSync(runTokenKey, pubJwk(RT_KID));
  writeFileSync(xcPriv, PRIV.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });

  /** Write inputs for a child `run --hosted`; returns the argv. */
  let inputSeq = 0;
  const hostedInputs = (spec: unknown, manifest: unknown, key = manifestKey): string[] => {
    const dir = join(OUT, 'child-inputs', String(++inputSeq));
    const inp = writeInputs(dir, manifest, spec);
    return ['run', '--hosted', '--manifest', inp.manifest, '--run-spec', inp.runSpec, '--manifest-key', key, '--out', join(dir, 'out')];
  };
  const byzSpec = (o: Partial<RunSpecContract> = {}): RunSpecContract =>
    ({ scenario_id: 'byzantine', seeds: [20260720], episodes: 1, budget_tier: 'core', seat: { mode: 'squad' }, target: { transport: 'rest', url: `${ORIGIN}/arena/act`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } }, labels: { ci_run: 'phase9-gate' }, ...o }) as RunSpecContract;

  // ── reference targets (public CLI) ──
  const tSrv = performance.now();
  const hostedRefArgs = ['--hosted', '--verified-origin', ORIGIN, '--run-token-key', runTokenKey, '--run-token-issuer', RT_ISSUER, '--require-run-token'];
  const [refHostedCoord, refHostedNaive, refHostedDip, refOpenCoord, refOpenNaive] = await Promise.all([
    serveReference(['--policy', 'coordinated', ...hostedRefArgs]),
    serveReference(['--policy', 'naive', ...hostedRefArgs]),
    serveReference(['--scenario', 'diplomacy_standard', '--policy', 'robust', ...hostedRefArgs]),
    serveReference(['--policy', 'coordinated']),
    serveReference(['--policy', 'naive']),
  ]);
  M['reference servers up'] = `${((performance.now() - tSrv) / 1000).toFixed(1)} s`;
  const hostedRefFor = (g: Group) => (g.policy === 'naive' ? refHostedNaive : refHostedCoord);
  const openRefFor = (g: Group) => (g.policy === 'naive' ? refOpenNaive : refOpenCoord);

  try {
    // ── the re-pinned fixture pack (sx-agentic-core with engine.builds = this build) ──
    const fixtureEnvBytes = readFileSync(join(FIXTURE_PACK_DIR, PACK_ENVELOPE_FILE));
    const fixtureEnv = JSON.parse(fixtureEnvBytes.toString('utf8')) as { payload: string; payloadType: string };
    const fixturePm = JSON.parse(Buffer.from(fixtureEnv.payload, 'base64').toString('utf8')) as PackManifest & { engine: { builds: string[]; versions: string; contracts: string }; scenarios: { id: string; data?: { ref: string; digest: string } }[] };
    // contracts 2.9.0 (signing.md §11.4): the fixture pins a placeholder engine build, so the harness re-signs a COPY for
    // this tree's build with the contract tool's --engine-build mode (same RFC 8032 TEST 1 key and keyid), never its own copy.
    const runBuild = engineBuildFor('byzantine').digest;
    if (engineBuildFor('deadlock').digest !== runBuild) throw new Error(`phase9-gate: the byzantine and deadlock engine builds differ (${runBuild} vs ${engineBuildFor('deadlock').digest}); signing-vectors.mjs --engine-build pins one build, so the re-signed pack cannot cover both. Extend the tool or pin the variant base's build.`);
    const PACKS = join(OUT, 'packs-repinned');
    const resignTool = join(CONTRACTS, 'tools', 'signing-vectors.mjs');
    let resigned: { id: string; version: string; engine_build: string; dir: string; keyid: string; payload_sha256: string; envelope_sha256: string };
    try {
      resigned = JSON.parse(execFileSync(process.execPath, [resignTool, '--engine-build', runBuild, '--out', PACKS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      throw new Error(`phase9-gate: re-signing the fixture pack failed (node ${relative(ASC, resignTool)} --engine-build ${runBuild} --out ${PACKS}): ${String((e as { stderr?: string }).stderr ?? e).slice(0, 400)}`);
    }
    const repinnedEnv = readFileSync(join(PACKS, resigned.id, PACK_ENVELOPE_FILE), 'utf8');
    const repinned = JSON.parse(Buffer.from((JSON.parse(repinnedEnv) as { payload: string }).payload, 'base64').toString('utf8')) as typeof fixturePm;
    if (resigned.keyid !== MANIFEST_KID || sha256(repinnedEnv) !== resigned.envelope_sha256 || JSON.stringify(repinned.engine.builds) !== JSON.stringify([runBuild])) {
      throw new Error(`phase9-gate: the re-signed pack copy does not match what signing-vectors.mjs printed (keyid ${resigned.keyid}, envelope ${resigned.envelope_sha256}, builds ${JSON.stringify(repinned.engine.builds)})`);
    }
    const repinnedEntry = { id: repinned.id, version: repinned.version, digest: resigned.envelope_sha256 };
    notes.push(`C2/C3: the contracts fixture pack sx-agentic-core@1.0.0 pins a placeholder engine build (${fixturePm.engine.builds[0].slice(0, 19)}…), so the hosted runs mount a copy re-signed for this tree's build (${runBuild.slice(0, 19)}…) by \`node contracts/tools/signing-vectors.mjs --engine-build … --out <scratch>\` (same test key and keyid; envelope ${resigned.envelope_sha256.slice(0, 19)}…); every other byte of the pack manifest and the variant file is the fixture's.`);

    // ═════════ Criterion 1 — hosted run path, SARIF, cross-check against the open CLI ═════════
    C.na('C1', 'C1-SCAN-ACTION', '`sixi-ai/scan-action` profile: arena / arena-diplomacy; a workflow run uploads the SARIF to the Security tab', 'sixi-scanner PR 7 (action.yml profiles, upload-sarif) on top of PR 5 (runner by digest) and PR 6 (sealed byte-identical SARIF)');
    C.na('C1', 'C1-XCHECK-JOB', 'the cross-check job on Sixi infrastructure (arena-crosscheck.yml): leg H = a real customer-path run of the promoted image digest, record signed with the KMS cross-check key', 'sixi-scanner PR 7 (§1.14); this repo proves the runner, the record and --compare below');

    const groups = buildMatrix({ blocks: ['X1'], scenarios: ['byzantine'], tiers: ['core'] });
    const HOSTED_DIR = join(OUT, 'hosted');
    type HostedRun = { g: Group; spec: RunSpecContract; manifest: HostedContextContract; out: string; open: Report; report?: Report; token: string; env: NodeJS.ProcessEnv; seen: Seen; exit?: number; error?: string };
    const hr: HostedRun[] = [];
    const tOpen = performance.now();
    // Open leg: the public CLI against the plain reference, for each group; its RunSpec seeds the hosted one.
    const openRuns = await pool(
      groups.map((g) => async () => {
        const dir = join(OUT, 'open', g.id);
        const p = await cli([...g.args.filter((a) => a !== '--json'), '--target', openRefFor(g).urls.rest, '--out', dir, '--json']);
        return { g, dir, p };
      }),
      3,
    );
    M['open CLI runs (3 groups × 5 episodes)'] = `${((performance.now() - tOpen) / 1000).toFixed(1)} s`;
    const tHosted = performance.now();
    for (const [i, { g, dir, p }] of openRuns.entries()) {
      if (!existsSync(join(dir, 'report.json'))) {
        C.ok('C1', `C1-OPEN-${g.id}`, `open CLI run for ${g.id}`, false, `exit ${p.code}, no report`);
        continue;
      }
      const open = readJson<Report>(join(dir, 'report.json'));
      const spec = hostedSpecFrom(readJson<Record<string, unknown>>(join(dir, 'report.run-spec.json')));
      const runId = run26(`${i + 1}`);
      const withPack = g.policy === 'coordinated' && g.seatMode === 'squad';
      const manifest = signManifest(unsignedManifest(spec, { run_id: runId, ...(withPack ? { packs: [repinnedEntry] } : {}) } as Partial<HostedContextContract>));
      const out = join(HOSTED_DIR, g.id);
      const inputs = writeInputs(join(OUT, 'hosted-in', g.id), manifest, spec);
      const token = mintRunToken(runId);
      const env = hostedEnv({ ARENA_TARGET_CREDENTIAL: token, ...(withPack ? { ARENA_PACKS_DIR: PACKS } : {}) });
      const run: HostedRun = { g, spec, manifest, out, open, token, env, seen: {} };
      try {
        const r = await capturingStderr(() => runHostedCommand({ ...inputs, manifestKey: manifestKey, out }, { env, platform: PLATFORM, transportFactory: viaHostedReference(hostedRefFor(g).urls.rest, run.seen) }));
        run.exit = r.exitCode;
        run.report = readJson<Report>(join(out, 'report.json'));
      } catch (e) {
        run.error = String((e as Error).message ?? e).split('\n')[0].slice(0, 200);
      }
      hr.push(run);
    }
    M['hosted runs through the seam (3 groups × 5 episodes)'] = `${((performance.now() - tHosted) / 1000).toFixed(1)} s`;
    const main = hr.find((h) => h.g.policy === 'coordinated' && h.g.seatMode === 'squad');

    C.ok('C1', 'C1-HOSTED-RUN', '`run --hosted` (signed manifest + bound RunSpec, test key) completes for byzantine core squad-coordinated, squad-naive and member-m1; report.json validates', hr.length === 3 && hr.every((h) => h.report && validateReportSchema(h.report) && h.report.summary.episodes_completed === h.report.summary.episodes_total && h.report.summary.episodes_total === 5),
      hr.map((h) => `${h.g.seatMode}${h.g.position ? `-${h.g.position}` : ''}-${h.g.policy}: ${h.error ? `threw ${h.error}` : `exit ${h.exit}, ${h.report?.summary.episodes_completed}/${h.report?.summary.episodes_total} completed`}`).join('; '));

    if (main?.report && main.seen.ctx) {
      const ctx = main.seen.ctx;
      const credOk = Object.keys(ctx.credentialFor(new URL(`${ORIGIN}/arena/act`))).length === 1 && Object.keys(ctx.credentialFor(new URL('https://evil.example.net/'))).length === 0;
      C.ok('C1', 'C1-HOSTED-NET', 'the hosted NetContext handed to the transport is hosted-v1: allowlist = the verified origin only, no private/loopback, no redirects, run id bound, credential attached only to the verified origin',
        JSON.stringify(ctx.policy.allowOrigins) === JSON.stringify([`${ORIGIN}:443`]) && ctx.policy.allowPrivate === false && ctx.policy.loopbackLiteral === false && ctx.followRedirects === false && ctx.runId === main.manifest.run_id && credOk,
        `allowOrigins=${JSON.stringify(ctx.policy.allowOrigins)} redirects=${ctx.followRedirects} credential-bound=${credOk}`);
      const rep = main.report;
      const h = (rep.run.hosted ?? {}) as Record<string, unknown>;
      const keys = ['signing_key_id', 'region', 'image_digest', 'verified_origin', 'org_ref', 'scan_id', 'credential_mode', 'seed_source', 'packs', 'retention'] as const;
      const diff = keys.filter((k) => JSON.stringify(h[k]) !== JSON.stringify((main.manifest as unknown as Record<string, unknown>)[k]));
      const rm = h.run_manifest as { digest?: string; signing_key_id?: string; path?: string } | undefined;
      C.ok('C1', 'C1-HOSTED-FIELDS', 'report.run.mode = hosted, run_id = manifest run_id, target_ownership sixi_verified; run.hosted.{signing_key_id, region, image_digest, verified_origin, org_ref, scan_id, credential_mode, seed_source, packs, retention} = the manifest; run_manifest {digest, kid, path}',
        rep.run.mode === 'hosted' && rep.run.run_id === main.manifest.run_id && JSON.stringify(rep.run.target_ownership) === JSON.stringify({ loopback: false, attested: true, source: 'sixi_verified' }) && diff.length === 0 &&
          rm?.digest === signedBodyDigest(main.manifest) && rm?.signing_key_id === MANIFEST_KID && rm?.path === 'run-manifest.json' && h.region === 'europe-west6',
        diff.length ? `differs: ${diff.join(', ')}` : `region ${String(h.region)}, run_manifest kid ${String(rm?.signing_key_id)}, path ${String(rm?.path)}`); // the digest covers issued_at (clock): not printed
      const na = (rep.not_assessed ?? []).map((e) => `${e.kind}:${e.id}:${e.reason_code}`);
      const want = ['property:robustness.seed_recovery:seed_recovery_not_modelled', 'property:target.model_identity:out_of_scope_by_design', 'property:target.production_equivalence:out_of_scope_by_design'];
      C.ok('C1', 'C1-NOT-ASSESSED', 'report.not_assessed[] (inside the signed body) carries the standing hosted properties', want.every((w) => na.includes(w)), `${na.length} entries; missing: ${want.filter((w) => !na.includes(w)).join(', ') || 'none'}`);
      C.ok('C1', 'C1-NO-SIGNING', 'the runner never signs: report.signing is absent until the seal step', hr.every((x) => x.report && x.report.signing === undefined));
      const sarifOk = hr.every((x) => {
        const p = join(x.out, 'report.sarif');
        return existsSync(p) && validateSarif(readJson(p)).ok;
      });
      C.ok('C1', 'C1-SARIF', 'every hosted report.sarif validates against the vendored OASIS SARIF 2.1.0 schema (the bytes the Security tab would receive)', sarifOk);
      const runManifestAsReceived = hr.every((x) => readFileSync(join(x.out, 'run-manifest.json'), 'utf8') === readFileSync(join(OUT, 'hosted-in', x.g.id, 'manifest.json'), 'utf8'));
      C.ok('C1', 'C1-BUNDLE-LAYOUT', 'bundle layout: run-manifest.json byte-equal to the manifest as received; episodes/<i>.{record,replay}.json per episode', runManifestAsReceived && hr.every((x) => x.report!.episodes.every((e, i) => e.replay_ref === `episodes/${i}.replay.json` && existsSync(join(x.out, 'episodes', `${i}.record.json`)))));
    } else {
      C.ok('C1', 'C1-HOSTED-NET', 'hosted NetContext is hosted-v1', false, 'the squad-coordinated hosted run did not complete');
    }

    // Run tokens: the reference admitted the hosted run (every episode completed under --require-run-token); direct probes.
    await C.guard('C1', 'C1-RUN-TOKEN', '`serve-reference --hosted --require-run-token`: the hosted run was admitted with its run token; tokenless → 401, token of another run → 401, foreign Host → 421, valid token → 200', async () => {
      const port = refHostedCoord.port;
      const card = '/.well-known/agent-card.json';
      const host = new URL(ORIGIN).host;
      const run = run26('9');
      const good = await httpGet(port, card, { host, authorization: `Bearer ${mintRunToken(run)}`, 'x-agent-arena-run': run });
      const none = await httpGet(port, card, { host });
      const other = await httpGet(port, card, { host, authorization: `Bearer ${mintRunToken(run)}`, 'x-agent-arena-run': run26('8') });
      const wrongAud = await httpGet(port, card, { host, authorization: `Bearer ${mintRunToken(run, 'https://other.example.com')}`, 'x-agent-arena-run': run });
      const foreign = await httpGet(port, card, { host: 'evil.example.net', authorization: `Bearer ${mintRunToken(run)}`, 'x-agent-arena-run': run });
      const admitted = hr.every((x) => x.report?.episodes.every((e) => e.status === 'completed'));
      C.ok('C1', 'C1-RUN-TOKEN', '`serve-reference --hosted --require-run-token`: the hosted runs were admitted with their run tokens; tokenless → 401, another run → 401, another audience → 401, foreign Host → 421, valid → 200',
        admitted && good === 200 && none === 401 && other === 401 && wrongAud === 401 && foreign === 421, `valid ${good} · none ${none} · other run ${other} · other aud ${wrongAud} · foreign Host ${foreign} · hosted episodes admitted ${admitted}`);
    });

    // The cross-check for criterion 1: per episode, hosted = open CLI = frozen anchors.
    {
      const rows: string[] = [];
      let eq = true;
      let anchors = 0;
      for (const x of hr) {
        if (!x.report) {
          eq = false;
          continue;
        }
        const a = episodeTuples(x.report);
        const b = episodeTuples(x.open);
        const same = JSON.stringify(a) === JSON.stringify(b);
        eq &&= same;
        for (const e of x.report.episodes) {
          if (x.g.seatMode !== 'squad') continue;
          const anc = anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'core', seed: e.seed, policy: x.g.policy });
          if (anc) {
            anchors++;
            if (anc.replayHash !== e.replay_hash || anc.outcome !== e.outcome) eq = false;
          }
        }
        rows.push(`${x.g.seatMode}${x.g.position ? `-${x.g.position}` : ''}-${x.g.policy} ${same ? '5/5' : 'DIFFER'}`);
      }
      const h0 = main?.report?.episodes[0]?.replay_hash ?? '';
      C.ok('C1', 'C1-EQ-OPEN', 'cross-check (direct): each hosted episode equals the open CLI run of the same RunSpec and seeds (replay_hash, outcome, terminal_tick, every verdict) and the frozen anchors', eq && anchors === 10,
        `${rows.join(' · ')}; ${anchors}/10 squad anchors; seed 20260720 ${h0.slice(0, 19)}…`);
    }

    // Pre-seal verify (the seal step's verifier job), then seal every bundle with the test key.
    if (main?.report) {
      const pre = await cli(['verify', '--hosted-seal', main.out, '--manifest-key', manifestKey, '--json']);
      C.ok('C1', 'C1-PRESEAL', '`verify --hosted-seal <bundle> --manifest-key` before sealing (the verifier job) exits 0: SARIF re-render byte-equal, manifest digest + signature, run.hosted copy', pre.code === 0, `exit ${pre.code}`);
      const preNoKey = await cli(['verify', '--hosted-seal', main.out, '--json']);
      const keyNeeded = preNoKey.code !== 0 && /manifest key/.test(preNoKey.stdout + preNoKey.stderr);
      C.ok('S', 'S-G49-PRESEAL-KEY', 'G-49: pre-seal `verify --hosted-seal` without --manifest-key (and no pinned key) is refused — it cannot vouch for the manifest signature', keyNeeded, preNoKey.code === 0 ? 'exit 0 (G-49 open)' : keyNeeded ? `exit ${preNoKey.code}, the manifest key is required` : `exit ${preNoKey.code}, for another reason`);
    }
    const sealed = new Map<string, Report>();
    for (const x of hr) if (x.report) sealed.set(x.g.id, sealBundle(x.out));
    if (main?.report) {
      const s = await cli(['verify', '--hosted-seal', main.out, '--key', reportKey, '--manifest-key', manifestKey, '--json']);
      const all = await pool(hr.filter((x) => x.report).map((x) => () => cli(['verify', '--hosted-seal', x.out, '--key', reportKey, '--manifest-key', manifestKey])), 3);
      // Tamper after sealing: a record byte → exit 2 (bundle digest), then restore.
      const rec = join(main.out, 'episodes', '0.record.json');
      const recText = readFileSync(rec, 'utf8');
      writeFileSync(rec, recText.replace(/\n$/, ' \n'));
      const tampered = await cli(['verify', '--hosted-seal', main.out, '--key', reportKey]);
      writeFileSync(rec, recText);
      C.ok('C1', 'C1-SEALED', '`verify --hosted-seal` on each sealed bundle (report/SARIF/bundle DSSE, test key) exits 0; a record edited after sealing exits 2', s.code === 0 && all.every((p) => p.code === 0) && tampered.code === 2,
        `sealed: ${[s, ...all].map((p) => p.code).join(',')} · tampered: ${tampered.code}`);
    }

    // The cross-check runner itself, legs npm + hosted, scope hosted, signed; twice → --compare.
    const xcArgs = (out: string) => ['--import', 'tsx', join(ASC, 'qa', 'crosscheck.ts'), '--legs', 'npm,hosted', '--digest', IMAGE_INDEX, '--platform', PLATFORM, '--platform-manifest', IMAGE_PLATFORM, '--blocks', 'X1', '--scenarios', 'byzantine', '--tiers', 'core', '--hosted-dir', HOSTED_DIR, '--hosted-key', reportKey, '--sign', xcPriv, '--kid', XC_KID, '--out', out, '--stable', '--json'];
    const tXc = performance.now();
    const xcA = join(OUT, 'xc-hosted-a');
    const xcB = join(OUT, 'xc-hosted-b');
    const pA = await sh(process.execPath, xcArgs(xcA), { timeoutMs: 600_000 });
    const pB = await sh(process.execPath, xcArgs(xcB), { timeoutMs: 600_000 });
    M['cross-check npm+hosted (2 runs, 15 cells each)'] = `${((performance.now() - tXc) / 1000).toFixed(1)} s`;
    let xcRecord: CrosscheckRecordInput | undefined;
    if (existsSync(join(xcA, 'crosscheck_record.json'))) {
      xcRecord = readJson<CrosscheckRecordInput>(join(xcA, 'crosscheck_record.json'));
      const sum = readJson<{ job_verdict: string; scope: string; signed: boolean; counts: Record<string, Record<string, number>>; leg_v: { reports_verified?: number; reports_total?: number; signatures_valid?: boolean }; cells: { verdict: string }[] }>(join(xcA, 'crosscheck_summary.json'));
      const match = sum.cells.filter((c) => c.verdict === 'match').length;
      C.ok('C1', 'C1-XCHECK-HOSTED', '`qa/crosscheck.ts --legs npm,hosted` over the three hosted bundles: scope hosted, job verdict pass, every cell match (hosted = npm = anchors), leg V verified every sealed report and its signature, record signed', pA.code === 0 && xcRecord.scope === 'hosted' && xcRecord.job_verdict === 'pass' && match === sum.cells.length && sum.cells.length === 15 && sum.leg_v.reports_verified === 3 && sum.leg_v.reports_total === 3 && sum.leg_v.signatures_valid === true && sum.signed,
        `exit ${pA.code}, scope ${xcRecord.scope}, ${xcRecord.job_verdict}, ${match}/${sum.cells.length} match, leg V ${sum.leg_v.reports_verified}/${sum.leg_v.reports_total} signatures ${sum.leg_v.signatures_valid ? 'valid' : 'NOT valid'}`);
      const cmp = await sh(process.execPath, ['--import', 'tsx', join(ASC, 'qa', 'crosscheck.ts'), '--compare', join(xcA, 'crosscheck_record.json'), join(xcB, 'crosscheck_record.json')]);
      const bytes = existsSync(join(xcB, 'crosscheck_record.json')) && readFileSync(join(xcA, 'crosscheck_record.json'), 'utf8') === readFileSync(join(xcB, 'crosscheck_record.json'), 'utf8');
      C.ok('C1', 'C1-XCHECK-COMPARE', 'a second identical cross-check: `crosscheck.ts --compare A B` exits 0 and the --stable signed records are byte-identical', pB.code === 0 && cmp.code === 0 && bytes, `second run exit ${pB.code}; --compare exit ${cmp.code}; byte-identical ${bytes}; record ${sha256(readFileSync(join(xcA, 'crosscheck_record.json'))).slice(0, 19)}…`);
    } else {
      C.ok('C1', 'C1-XCHECK-HOSTED', 'crosscheck.ts --legs npm,hosted produces a record', false, `exit ${pA.code}: ${pA.stderr.split('\n')[0].slice(0, 160)}`);
    }

    // ═════════ Criterion 2 — evidence report over the sealed hosted run ═════════
    const corpus: EvidenceCorpus = Object.freeze({
      'OWASP:AgenticTop10:ASI01': { instrument: 'OWASP Top 10 for Agentic Applications', reference: 'ASI01', title: 'Agent goal hijack', paraphrase: 'Gate test paraphrase for ASI01.', url: 'https://genai.owasp.org/' },
      'OWASP:AgenticTop10:ASI07': { instrument: 'OWASP Top 10 for Agentic Applications', reference: 'ASI07', paraphrase: 'Gate test paraphrase for ASI07.', url: 'https://genai.owasp.org/' },
      'OWASP:AgenticTop10:ASI08': { instrument: 'OWASP Top 10 for Agentic Applications', reference: 'ASI08', paraphrase: 'Gate test paraphrase for ASI08.', url: 'https://genai.owasp.org/' },
      'OWASP:LLMTop10:LLM01': { instrument: 'OWASP Top 10 for LLM Applications', reference: 'LLM01', title: 'Prompt injection', paraphrase: 'Gate test paraphrase for LLM01.', url: 'https://genai.owasp.org/' },
      'OWASP:LLMTop10:LLM10': { instrument: 'OWASP Top 10 for LLM Applications', reference: 'LLM10', paraphrase: 'Gate test paraphrase for LLM10.', url: 'https://genai.owasp.org/' },
      'AIACT:2024/1689:Art15(4)': { instrument: 'Regulation (EU) 2024/1689 (AI Act)', reference: 'Art. 15(4)', paraphrase: 'Gate test paraphrase for Art. 15(4).', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' },
      'AIACT:2024/1689:Art15(5)': { instrument: 'Regulation (EU) 2024/1689 (AI Act)', reference: 'Art. 15(5)', paraphrase: 'Gate test paraphrase for Art. 15(5).', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' },
    });
    const evidenceOptions = async (x: { out: string }, rep: Report): Promise<EvidenceRenderOptions> => {
      const v = await cli(['verify', join(x.out, 'report.json'), '--json', '--key', reportKey, '--hosted', '--manifest-key', manifestKey]);
      let vr: { status: string; unverified: string[] } = { status: `exit ${v.code}`, unverified: [] };
      try {
        vr = JSON.parse(v.stdout);
      } catch {
        /* keep the exit code as the status: the renderer refuses anything but verified */
      }
      const bm = readJson<{ files: { path: string; sha256: string }[] }>(join(x.out, 'bundle-manifest.json'));
      const file = (p: 'report.json' | 'report.sarif') => ({ path: p, run_id: rep.run.run_id, sha256: bm.files.find((f) => f.path === p)!.sha256 });
      return {
        packManifests: [repinned],
        corpus,
        crosscheckRecord: xcRecord,
        crosscheckKey: JSON.parse(pubJwk()) as { kty: 'OKP'; crv: 'Ed25519'; x: string },
        verifyResult: { status: vr.status as 'verified', unverified: vr.unverified ?? [] },
        bundle: { jwks_url: 'https://keys.example.net/.well-known/sixi-arena-signing-keys.json', files: [file('report.json'), file('report.sarif'), { path: 'bundle-manifest.json', run_id: rep.run.run_id, sha256: sha256(readFileSync(join(x.out, 'bundle-manifest.json'))) }] },
        admission: { reports_until: '2027-11-10T14:06:42Z', audit_until: '2028-11-09T14:06:42Z', credential_destroyed_at: '2026-11-10T14:00:05Z', requested_by: { actor_kind: 'pipeline_token', actor_id: 'tok_PHASE9GATE01' } },
      };
    };
    const mainSealed = main ? sealed.get(main.g.id) : undefined;
    if (main && mainSealed && xcRecord) {
      await C.guard('C2', 'C2-EVIDENCE-JSON', 'renderEvidenceReport over the sealed hosted report', async () => {
        const o = await evidenceOptions(main, mainSealed);
        const { markdown, json } = renderEvidenceReport(mainSealed, o);
        writeFileSync(join(OUT, 'evidence.md'), markdown);
        writeFileSync(join(OUT, 'evidence.json'), `${JSON.stringify(json, null, 2)}\n`);
        C.ok('C2', 'C2-EVIDENCE-JSON', 'renderEvidenceReport(sealed hosted report, sx-agentic-core clause map, 7-clause corpus, signed hosted cross-check record, verify result, bundle digests, admission) yields evidence.json valid against evidence_report.schema.json', !!json && validateEvidenceReportSchema(json) === true,
          json ? `status_line "${json.status_line}"; ${json.findings.length} finding(s); ${json.records.length} gap record(s); crosscheck ${json.build.crosscheck.verdict}` : 'json null');
        if (!json) return;
        // Every uncovered clause (template §6.4): a clause of the pack's coverage.clauses that no assessed oracle of this run maps to.
        const assessed = new Set(mainSealed.summary.oracles.filter((s) => s.pass + s.fail > 0).map((s) => s.oracle_id));
        const coveredByRun = new Set((repinned.oracles ?? []).filter((m) => assessed.has(m.oracle_id)).flatMap((m) => m.clauses));
        const uncovered = repinned.coverage.clauses.filter((c) => !coveredByRun.has(c)).sort();
        // contracts 2.9.0 load rule (signing.md §11.3 step 6a), on the pack the run actually mounted and on the shipped fixture payload.
        const mapOnly = [...new Set([...packCoverageMissing(repinned), ...packCoverageMissing(fixturePm)].map((m) => m.clause))].sort();
        const sec6 = markdown.slice(markdown.indexOf('## 6. Not assessed'), markdown.indexOf('## 7.'));
        const inJson = new Set([...json.not_assessed.coverage.pack_clauses_not_assessed, ...json.not_assessed.coverage.unmapped_clauses]);
        const inReport = new Set((mainSealed.not_assessed ?? []).filter((e) => e.kind === 'clause').map((e) => e.id));
        const missingMd = uncovered.filter((c) => !sec6.includes(c));
        const missingJson = uncovered.filter((c) => !inJson.has(c));
        const missingReport = uncovered.filter((c) => !inReport.has(c));
        C.ok('C2', 'C2-NOT-ASSESSED', '"Not assessed" (§6.4) names every coverage.clauses entry of the mounted pack that no assessed oracle of this run maps to; so do evidence.json and the signed report.not_assessed[]', uncovered.length > 0 && missingMd.length + missingJson.length + missingReport.length === 0,
          `uncovered ${uncovered.join(', ')}; missing in §6: ${missingMd.join(', ') || 'none'}; in evidence.json: ${missingJson.join(', ') || 'none'}; in report.not_assessed: ${missingReport.join(', ') || 'none'}`);
        C.ok('C2', 'C2-PACK-COVERAGE', 'pack coverage rule (contracts 2.9.0, signing.md §11.3 step 6a): every clause the mounted pack\'s clause map or rules cite is in its coverage.clauses, in the re-signed copy and the shipped fixture payload (the loader refuses otherwise)', mapOnly.length === 0,
          mapOnly.length ? `sx-agentic-core cites ${mapOnly.join(', ')} but omits them from coverage.clauses` : `consistent: ${repinned.coverage.clauses.length} coverage clauses ⊇ clause map ∪ rule clauses`);
        const cited = [...json.records.map((r) => r.clause_id), ...json.findings.flatMap((f) => f.clauses), ...json.assessed_no_finding_clauses, ...json.not_assessed.coverage.pack_clauses_not_assessed];
        const badIds = cited.filter((c) => !/^(OWASP:(AgenticTop10:ASI(0[1-9]|10)|LLMTop10:LLM(0[1-9]|10))|AIACT:2024\/1689:Art[0-9A-Za-z()]+)$/.test(c));
        const atlasAsClause = cited.filter((c) => /AML\.T\d/.test(c) || /^ATLAS/.test(c));
        C.ok('C2', 'C2-CLAUSE-IDS', 'every clause id cited is a corpus id (OWASP:AgenticTop10:ASI01–ASI10, OWASP:LLMTop10, AIACT:2024/1689:Art…); MITRE ATLAS appears only as technique labels, never as a clause', badIds.length === 0 && atlasAsClause.length === 0,
          `${new Set(cited).size} distinct cited ids; non-corpus: ${badIds.join(', ') || 'none'}; ATLAS as clause: ${atlasAsClause.join(', ') || 'none'}`);
        const jsonStrings = JSON.stringify(json);
        C.ok('C2', 'C2-WORDING', 'R1 wording lint: neither evidence.md nor any string of evidence.json says compliant/compliance, certify/certified, guarantee or confirm', !R1_PATTERN.test(markdown) && !R1_PATTERN.test(jsonStrings), `${markdown.length} bytes Markdown, ${jsonStrings.length} bytes JSON`);
        C.ok('C2', 'C2-XCHECK-CITED', 'the evidence report cites the signed hosted cross-check record (signature verified against the published key) and the byte-identical SARIF digest', json.build.crosscheck.verdict === 'pass' && /signature verified against key/.test(markdown) && json.signature.files.some((f) => f.path === 'report.sarif'));
        // Deterministic: the same inputs render the same bytes.
        const again = renderEvidenceReport(mainSealed, o);
        C.ok('C2', 'C2-BYTE-STABLE', 'the same sealed inputs render byte-identical Markdown and evidence.json', again.markdown === markdown && JSON.stringify(again.json) === JSON.stringify(json), `${markdown.split('\n').filter((l) => /^#{1,3} /.test(l)).length} headings`); // bytes carry the run window (clock): digest not printed
      });
    } else {
      C.ok('C2', 'C2-EVIDENCE-JSON', 'renderEvidenceReport over the sealed hosted report', false, 'no sealed hosted report or no hosted cross-check record');
    }

    // Hostile target: target text must never reach the evidence report (template R3).
    await C.guard('C2', 'C2-NO-TARGET-TEXT', 'no target text in the evidence report', async () => {
      const spec = byzSpec();
      const runId = run26('H');
      const manifest = signManifest(unsignedManifest(spec, { run_id: runId, packs: [repinnedEntry] } as Partial<HostedContextContract>));
      const out = join(OUT, 'hostile', 'out');
      const inputs = writeInputs(join(OUT, 'hostile', 'in'), manifest, spec);
      const logFrom = cliLog.length;
      const r = await capturingStderr(() => runHostedCommand({ ...inputs, manifestKey, out }, { env: hostedEnv({ ARENA_TARGET_CREDENTIAL: mintRunToken(runId), ARENA_PACKS_DIR: PACKS }), platform: PLATFORM, transportFactory: viaHostedReference(refHostedCoord.urls.rest, {}, hostile) }));
      // Hosted logs (SECURITY-REVIEW-HOSTED G-57 row: target-authored text on `  target> ` lines is accepted design).
      const lines = cliLog.slice(logFrom).join('').split('\n');
      const withTarget = lines.filter((l) => l.includes(HOSTILE_MARK));
      const offPrefix = withTarget.filter((l) => !l.startsWith('  target> ') || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(l));
      C.finding('C5', 'C5-LOGS-TARGET-TEXT', 'hosted logs: target-authored text reaches stderr only on terminal-safe `  target> ` lines (accepted design per SECURITY-REVIEW-HOSTED G-57; recorded, not scored)', offPrefix.length === 0,
        `${withTarget.length} line(s) carried the hostile target's text; ${offPrefix.length} outside a \`  target> \` line or with control/bidi characters`);
      const rep = sealBundle(out);
      if (!xcRecord) throw new Error('no hosted cross-check record');
      const { markdown, json } = renderEvidenceReport(rep, await evidenceOptions({ out }, rep));
      const leaks = [markdown.includes(HOSTILE_MARK) && 'evidence.md', JSON.stringify(json).includes(HOSTILE_MARK) && 'evidence.json', /<script/i.test(markdown) && '<script> in evidence.md'].filter(Boolean);
      const inReport = readFileSync(join(out, 'report.json'), 'utf8').includes(HOSTILE_MARK);
      const inSarif = readFileSync(join(out, 'report.sarif'), 'utf8').includes(HOSTILE_MARK);
      C.ok('C2', 'C2-NO-TARGET-TEXT', 'a hostile target (refusal body, extra text members, a non-JSON frame, all carrying R1 words and <script>) never reaches evidence.md or evidence.json; the render does not trip R1 on target text', leaks.length === 0 && !!json,
        `run exit ${r.exitCode}; leaks: ${leaks.join(', ') || 'none'}; target text in report.json: ${inReport ? 'yes' : 'no'}, in report.sarif: ${inSarif ? 'yes' : 'no'}`);
    });

    // ═════════ Criterion 3 — scenario packs ═════════
    await C.guard('C3', 'C3-FIXTURE-VECTOR', 'fixture pack vector', async () => {
      const vec = readJson<{ pack_vectors: { envelope_sha256: string; payload_sha256: string; keyid: string; variants: { digest: string; file: string }[] }[] }>(join(CONTRACTS, 'fixtures', 'signing_vectors.json')).pack_vectors[0];
      const payload = Buffer.from(fixtureEnv.payload, 'base64');
      const variantBytes = readFileSync(join(FIXTURE_PACK_DIR, 'variants', 'deadlock-hard.json'));
      const keys = loadPublicKeySet(pubJwk(MANIFEST_KID), '--manifest-key');
      const loaded = loadPacks([{ id: fixturePm.id, version: fixturePm.version, digest: vec.envelope_sha256 }], join(CONTRACTS, 'fixtures', 'packs'), keys, () => fixturePm.engine.builds[0], 'byzantine');
      const v = resolveVariant('sx_deadlock_hard', loaded);
      const file = JSON.parse(variantBytes.toString('utf8')) as Record<string, unknown>;
      const { format: _f, ...params } = file;
      C.ok('C3', 'C3-FIXTURE-LOAD', 'contracts fixture pack sx-agentic-core: envelope/payload/variant digests equal signing_vectors.json, the DSSE signature verifies with the pinned test key, and the loader resolves sx_deadlock_hard → base deadlock + the fixture parameters (library call, engine build = the fixture\'s pinned build)',
        sha256(fixtureEnvBytes) === vec.envelope_sha256 && sha256(payload) === vec.payload_sha256 && sha256(variantBytes) === vec.variants[0].digest && v.base === 'deadlock' && JSON.stringify(v.params) === JSON.stringify(params),
        `envelope ${vec.envelope_sha256.slice(0, 19)}… · variant ${v.id} → ${v.base} ${JSON.stringify(v.params).slice(0, 80)}`);
    });
    const packChild = async (spec: RunSpecContract, packs: { id: string; version: string; digest: string }[], packsDir: string | undefined, envExtra: Record<string, string> = {}) =>
      cli(hostedInputs(spec, signManifest(unsignedManifest(spec, { run_id: run26('P'), packs } as Partial<HostedContextContract>))), { ...(hostedEnv({ ...(packsDir ? { ARENA_PACKS_DIR: packsDir } : {}), ...envExtra }) as Record<string, string>) });
    const sxSpec = byzSpec({ scenario_id: 'sx_deadlock_hard', seeds: [20260720, 1, 2, 3, 5], episodes: 5 } as Partial<RunSpecContract>);
    {
      const asShipped = await packChild(byzSpec(), [{ id: fixturePm.id, version: fixturePm.version, digest: sha256(fixtureEnvBytes) }], join(CONTRACTS, 'fixtures', 'packs'));
      C.ok('C3', 'C3-FIXTURE-ENGINE', '`run --hosted` mounting the fixture pack exactly as shipped: signature and digest hold, then pack_engine_mismatch (exit 3) because it pins a placeholder engine build', asShipped.code === 3 && /pack_engine_mismatch: Pack sx-agentic-core@1\.0\.0/.test(asShipped.stderr), `exit ${asShipped.code}`);
      const variant = await packChild(sxSpec, [repinnedEntry], PACKS);
      const resolvedRefusal = variant.code === 3 && /resolves to base deadlock/.test(variant.stderr) && /sx-agentic-core/.test(variant.stderr);
      const ran = (variant.code === 0 || variant.code === 1) && /deadlock/.test(variant.stdout + variant.stderr);
      C.ok('C3', 'C3-VARIANT-CLI', '`run --hosted` with sx_deadlock_hard and the signed pack mounted: the variant resolves to base deadlock with the pack parameters (execution then awaits pack-scenario reports: exit 3 by design today)', resolvedRefusal || ran, resolvedRefusal ? 'resolved, then refused (pack-scenario reporting not built yet)' : ran ? 'resolved and ran' : `exit ${variant.code}`);
      // Tampered envelope: one payload byte changed, manifest digest updated to the tampered bytes.
      const TAMP = join(OUT, 'packs-tampered');
      mkdirSync(join(TAMP, repinned.id, 'variants'), { recursive: true });
      copyFileSync(join(FIXTURE_PACK_DIR, 'variants', 'deadlock-hard.json'), join(TAMP, repinned.id, 'variants', 'deadlock-hard.json'));
      const envObj = JSON.parse(repinnedEnv) as { payload: string };
      const tamperedPayload = Buffer.from(JSON.stringify({ ...repinned, title: `${repinned.title} (edited)` }), 'utf8');
      const tamperedEnv = `${JSON.stringify({ ...JSON.parse(repinnedEnv), payload: tamperedPayload.toString('base64') })}\n`;
      writeFileSync(join(TAMP, repinned.id, PACK_ENVELOPE_FILE), tamperedEnv);
      const tampered = await packChild(byzSpec(), [{ ...repinnedEntry, digest: sha256(tamperedEnv) }], TAMP);
      const wrongDigest = await packChild(byzSpec(), [{ ...repinnedEntry, digest: sha256(envObj.payload) }], PACKS);
      C.ok('C3', 'C3-TAMPER', 'a tampered pack envelope (payload edited, digest re-pinned) is refused: scenario_pack_unavailable, signature does not verify (exit 3); a digest the manifest does not pin is refused too', tampered.code === 3 && /scenario_pack_unavailable: pack sx-agentic-core: the pack signature does not verify/.test(tampered.stderr) && wrongDigest.code === 3 && /scenario_pack_unavailable/.test(wrongDigest.stderr),
        `tampered exit ${tampered.code} · wrong digest exit ${wrongDigest.code}`);
      const bare = await packChild(sxSpec, [], undefined);
      const open = await cli(['run', '--scenario', 'sx_deadlock_hard', '--target', 'http://127.0.0.1:9', '--seat', 'squad', '--i-own-this-target']);
      C.ok('C3', 'C3-SX-NO-PACK', 'an sx_ id without a mounted pack is refused with scenario_pack_unavailable before any I/O (exit 3): hosted, and the open CLI', bare.code === 3 && /scenario_pack_unavailable: sx_deadlock_hard is a Sixi Arena pack scenario and the run manifest mounts no pack/.test(bare.stderr) && open.code === 3 && /scenario_pack_unavailable: sx_deadlock_hard/.test(open.stderr),
        `hosted exit ${bare.code} · open CLI exit ${open.code}`);
    }
    C.na('C3', 'C3-N-OF-M', 'paid-only adversarial peers driven by Sixi attack agents (LLM) with "reproduced N of M" per finding', 'needs LLM peers: sixi-scanner PR 8 (opponent gateway) + contracts K7 for peer seats; the CLI refuses peer seats today (blocked on K7). The renderer\'s N-of-M text is covered by arena-report tests only');

    // ═════════ Criterion 4 — Neutral Ground ═════════
    C.na('C4', 'C4-NEUTRAL-GROUND', 'Neutral Ground league runner: N provider models as Diplomacy players under the zero-inference referee; per-model evidence pack; cost per game logged and capped (CHF 300/month alert)', 'inference happens only on the Sixi side (PLAN §3; B4 ng-runner + provider connectors; SIXI-INTEGRATION PR 4–6, PR 8)');

    // ═════════ Criterion 5 — residency and credentials (CLI side) ═════════
    C.na('C5', 'C5-RESIDENCY', 'hosted runs execute in europe-west6 (Zürich) / EU; the arena database and buckets are there; no us-east1 inheritance (S3)', 'sixi-scanner PR 1 (residency startup check, dedicated europe-west6 database); the CLI only records the manifest region (C1-HOSTED-FIELDS)');
    C.na('C5', 'C5-CRED-LIFECYCLE', 'the per-run credential secret is destroyed at start and at end; no arena path reuses the scan-row credential storage (S4, OQ-8)', 'sixi-scanner PR 5 (credential broker); the CLI side is C5-CRED-SCRUB below');
    C.na('C5', 'C5-SWISS-ATTACKERS', 'Swiss-hosted attacker model option documented', 'sixi-scanner PR 8 (Swiss or EU model endpoints)');

    await C.guard('C5', 'C5-ENV-REFUSED', 'must-be-absent environment', async () => {
      const table = readJson<{ must_be_absent: { name: string; field: string; unless?: string; taken_as_secret?: boolean }[] }>(join(CONTRACTS, 'fixtures', 'hosted_env.json')).must_be_absent;
      const SECRET_VALUE = 'p9-env-canary-value-3c1e9a';
      const cases = table.map((e) => {
        const name = e.name === 'ARENA_DIP_SECRET_<x>' ? 'ARENA_DIP_SECRET_00' : e.name;
        const value = e.taken_as_secret
          ? SECRET_VALUE
          : name === 'NODE_OPTIONS'
            ? '--no-warnings'
            : name === 'WOT_CONTRACTS_DIR'
              ? CONTRACTS // the real contracts path: the refusal must come from the hosted check, not from a broken path
              : /(_DIR|FILE|CERTS|COVERAGE)$/.test(name)
                ? join(OUT, 'env-probe', name.toLowerCase())
                : name === 'ARENA_HOSTED_CONTEXT' || name === 'ARENA_RUN_SPEC'
                  ? '{}'
                  : '1';
        return { e, name, value };
      });
      // NODE_OPTIONS is honoured by Node itself before the CLI runs; pass it to the CLI child only.
      const res = await pool(cases.map((c) => () => cli(hostedInputs(byzSpec(), signManifest(unsignedManifest(byzSpec(), { run_id: run26('E') } as Partial<HostedContextContract>))), { ...(hostedEnv({ [c.name]: c.value }) as Record<string, string>) })), 4);
      const refusedRows = cases.map((c, i) => ({ ...c, p: res[i], refused: res[i].code === 3 && res[i].stderr.includes(c.name) && !(res[i].stdout + res[i].stderr).includes(SECRET_VALUE) }));
      const bad = refusedRows.filter((r) => !r.refused);
      C.ok('C5', 'C5-ENV-REFUSED', `every must_be_absent variable of contracts/fixtures/hosted_env.json (${cases.length}) is refused before any I/O (exit 3, the variable named, a secret-taken value never echoed)`, bad.length === 0, bad.length ? `not refused: ${bad.map((b) => `${b.name} (exit ${b.p.code})`).join(', ')}` : `${cases.length}/${cases.length}`);
      const noField = refusedRows.filter((r) => !r.p.stderr.includes(`hosted_context_invalid (${r.e.field})`));
      C.ok('C5', 'C5-ENV-FIELD', 'each refusal names the contract field of hosted_env.json (`hosted_context_invalid (environment|manifest_source|episode_secret_commitments)`)', noField.length === 0,
        noField.length ? `${cases.length - noField.length}/${cases.length}; without the field: ${noField.map((r) => `${r.name}→${r.e.field}`).join(', ')}` : `${cases.length}/${cases.length}`);
      const nodeEmpty = await cli(hostedInputs(byzSpec(), signManifest(unsignedManifest(byzSpec(), { run_id: run26('E') } as Partial<HostedContextContract>))), { ...(hostedEnv({ NODE_OPTIONS: '', ARENA_TARGET_CREDENTIAL: undefined }) as Record<string, string>) });
      C.ok('C5', 'C5-ENV-TEMPLATE', 'the job template itself (ARENA_IMAGE_DIGEST, empty NODE_OPTIONS, ARENA_HOSTED=1) passes the environment check (the run then stops at the missing credential, exit 3)', nodeEmpty.code === 3 && /was not delivered/.test(nodeEmpty.stderr), `exit ${nodeEmpty.code}`);
    });
    await C.guard('C5', 'C5-ABSENT-FOR-MANIFEST', 'absent_for_manifest', async () => {
      const noCred = byzSpec({ target: { transport: 'rest', url: `${ORIGIN}/arena/act` } } as Partial<RunSpecContract>);
      const a = await cli(hostedInputs(noCred, signManifest(unsignedManifest(noCred, { run_id: run26('F'), credential_mode: 'none' } as Partial<HostedContextContract>))), { ...(hostedEnv() as Record<string, string>) });
      const b = await cli(hostedInputs(byzSpec(), signManifest(unsignedManifest(byzSpec(), { run_id: run26('F') } as Partial<HostedContextContract>))), { ...(hostedEnv({ ARENA_DIP_SECRET_0: dipSecret('x') }) as Record<string, string>) });
      const c = await cli(hostedInputs(byzSpec(), signManifest(unsignedManifest(byzSpec(), { run_id: run26('F') } as Partial<HostedContextContract>))), { ...(hostedEnv({ ARENA_SEAT_CREDENTIAL_FRANCE: 'seat-canary-91ab' }) as Record<string, string>) });
      const leak = [a, b, c].some((p) => (p.stdout + p.stderr).includes('seat-canary-91ab') || (p.stdout + p.stderr).includes(dipSecret('x')));
      // Parity with the contract table: each refusal carries the `field` hosted_env.json absent_for_manifest gives for its variable.
      const afm = readJson<{ absent_for_manifest: { name: string; field: string }[] }>(join(CONTRACTS, 'fixtures', 'hosted_env.json')).absent_for_manifest;
      const fieldOf = (n: string) => afm.find((e) => e.name === n)?.field ?? '?';
      const rows = [
        { p: a, field: fieldOf('ARENA_TARGET_CREDENTIAL') },
        { p: b, field: fieldOf('ARENA_DIP_SECRET_<n>') },
        { p: c, field: fieldOf('ARENA_SEAT_CREDENTIAL_<POWER>') },
      ].map((x) => ({ ...x, ok: x.p.code === 3 && x.p.stderr.includes(`hosted_context_invalid (${x.field})`) }));
      C.ok('C5', 'C5-ABSENT-FOR-MANIFEST', 'hosted_env.json absent_for_manifest: a credential with credential_mode none, an episode secret on a non-Diplomacy run, a seat credential without seats[] → refused (exit 3) with the table\'s field, values never echoed', rows.every((r) => r.ok) && !leak,
        `${rows.map((r) => `${r.field}: exit ${r.p.code}${r.ok ? '' : ' (field not named)'}`).join(' · ')}; echoed ${leak}`);
    });
    await C.guard('C5', 'C5-EPISODE-CAPS', 'hosted episode caps (contracts 2.10.0)', async () => {
      // signing.md §3.2 A6: an extended run plays one episode (Dh 30 s vs the 55-min run token);
      // M10 (OQ-18): a Diplomacy-family run plays at most 50. Public CLI, refused before any I/O.
      const ext = byzSpec({ budget_tier: 'extended', seeds: [20260720, 1], episodes: 2 } as Partial<RunSpecContract>);
      const a = await cli(hostedInputs(ext, signManifest(unsignedManifest(ext, { run_id: run26('E') } as Partial<HostedContextContract>))), { ...(hostedEnv() as Record<string, string>) });
      const dip = { scenario_id: 'diplomacy_standard', seeds: [20261115], episodes: 51, budget_tier: 'core', seat: { mode: 'power', position: 'germany' }, diplomacy: { profile: 'clean', horizon_year: 1901, fill: 'house' }, target: { transport: 'rest', url: `${ORIGIN}/arena/act`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } }, labels: { ci_run: 'phase9-gate' } } as unknown as RunSpecContract;
      const fifty = Array.from({ length: 50 }, (_, i) => dipSecret(`cap-${i}`));
      const b = await cli(hostedInputs(dip, signManifest(unsignedManifest(dip, { run_id: run26('E'), episode_secret_commitments: commitmentsFor(fifty) } as Partial<HostedContextContract>))), { ...(hostedEnv(Object.fromEntries(fifty.map((v, i) => [`ARENA_DIP_SECRET_${i}`, v]))) as Record<string, string>) });
      const okA = a.code === 3 && a.stderr.includes('run_spec_invalid (episodes)');
      const okB = b.code === 3 && b.stderr.includes('hosted_context_invalid (episode_secret_commitments)') && !(b.stdout + b.stderr).includes(fifty[0]);
      C.ok('C5', 'C5-EPISODE-CAPS', 'hosted episode caps (contracts 2.10.0, signing.md §3.2): an extended run with 2 episodes is run_spec_invalid (episodes) (A6); a Diplomacy run with 51 episodes is hosted_context_invalid (episode_secret_commitments) (M10); both exit 3 before any I/O', okA && okB,
        `extended ×2: exit ${a.code}${okA ? '' : ' (field not named)'} · diplomacy ×51: exit ${b.code}${okB ? '' : ' (field not named or secret echoed)'}`);
    });
    {
      const leaks = hr.flatMap((x) => allText(x.out).filter((f) => f.text.includes(x.token) || f.text.includes(x.token.split('.')[2])).map((f) => `${x.g.id}/${f.path}`));
      const scrubbed = hr.every((x) => x.env.ARENA_TARGET_CREDENTIAL === undefined);
      const env = hostedEnv({ ARENA_TARGET_CREDENTIAL: 'p9-refused-credential-canary', ARENA_SEAT_CREDENTIAL_FRANCE: 'p9-seat-canary', ARENA_DIP_SECRET_0: dipSecret('refused') });
      const spec = byzSpec();
      const inp = writeInputs(join(OUT, 'scrub', 'in'), { ...signManifest(unsignedManifest(spec, { run_id: run26('S') } as Partial<HostedContextContract>)), rps_cap: 1 }, spec);
      let refusedScrub = false;
      try {
        await capturingStderr(() => runHostedCommand({ ...inp, manifestKey, out: join(OUT, 'scrub', 'out') }, { env, platform: PLATFORM }));
      } catch {
        refusedScrub = env.ARENA_TARGET_CREDENTIAL === undefined && env.ARENA_SEAT_CREDENTIAL_FRANCE === undefined && env.ARENA_DIP_SECRET_0 === undefined;
      }
      C.ok('C5', 'C5-CRED-SCRUB', 'the credential (a Sixi run token) is scrubbed from the environment on load — after a completed run and after a refused one (tampered manifest) — and appears in no byte of any bundle', scrubbed && refusedScrub && leaks.length === 0, `scrubbed after run ${scrubbed}, after refusal ${refusedScrub}; token in bundle: ${leaks.join(', ') || 'none'}`);
    }
    await C.guard('C5', 'C5-DIP-COMMIT', 'ARENA_DIP_SECRET commit-then-reveal', async () => {
      const spec = { scenario_id: 'diplomacy_standard', seeds: [20261115], episodes: 1, budget_tier: 'core', seat: { mode: 'power', position: 'germany' }, diplomacy: { profile: 'clean', horizon_year: 1901, fill: 'house' }, target: { transport: 'rest', url: `${ORIGIN}/arena/act`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } }, labels: { ci_run: 'phase9-gate' } } as unknown as RunSpecContract;
      const secret = dipSecret('phase9-gate-ep0');
      const runId = run26('D');
      const manifest = signManifest(unsignedManifest(spec, { run_id: runId, episode_secret_commitments: commitmentsFor([secret]) } as Partial<HostedContextContract>));
      const out = join(OUT, 'dip', 'out');
      const inputs = writeInputs(join(OUT, 'dip', 'in'), manifest, spec);
      const env = hostedEnv({ ARENA_TARGET_CREDENTIAL: mintRunToken(runId), ARENA_DIP_SECRET_0: secret });
      const r = await capturingStderr(() => runHostedCommand({ ...inputs, manifestKey, out }, { env, platform: PLATFORM, transportFactory: viaHostedReference(refHostedDip.urls.rest, {}) }));
      const rep = readJson<Report>(join(out, 'report.json'));
      const d = rep.episodes[0]?.diplomacy as { episode_secret?: string; episode_secret_commitment?: string } | undefined;
      const disclosed = d?.episode_secret === secret && d?.episode_secret_commitment === episodeSecretCommitment(secret) && env.ARENA_DIP_SECRET_0 === undefined;
      const sealedRep = signReport(rep, PRIV, REPORT_KID, { sealedAt: SEALED_AT });
      writeFileSync(join(out, 'report.json'), toFileJson(sealedRep));
      writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(sealedRep, { specPath: '.agent-arena/diplomacy_standard.run.json' })));
      const ok = await cli(['verify', join(out, 'report.json'), '--key', reportKey, '--hosted', '--manifest-key', manifestKey]);
      // A secret chosen after the run, consistently re-committed per episode and re-sealed: the list no longer hashes to the manifest.
      const forged = JSON.parse(JSON.stringify(rep)) as Report;
      const other = dipSecret('chosen-after-the-run');
      Object.assign(forged.episodes[0].diplomacy as object, { episode_secret: other, episode_secret_commitment: episodeSecretCommitment(other) });
      const reSealed = signReport(forged, PRIV, REPORT_KID, { sealedAt: SEALED_AT });
      writeFileSync(join(out, 'report.json'), toFileJson(reSealed));
      writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(reSealed, { specPath: '.agent-arena/diplomacy_standard.run.json' })));
      const forgedV = await cli(['verify', join(out, 'report.json'), '--key', reportKey, '--hosted']);
      // A secret that does not hash to the commitment: refused before any I/O (public CLI).
      const wrong = await cli(hostedInputs(spec, manifest), { ...(hostedEnv({ ARENA_DIP_SECRET_0: dipSecret('not-the-committed-one') }) as Record<string, string>) });
      C.ok('C5', 'C5-DIP-COMMIT', '`ARENA_DIP_SECRET_<n>` commit-then-reveal: the run plays with the committed secret, scrubs it, discloses it with its commitment; verify --hosted exits 0; a secret chosen after the run exits 1; an uncommitted secret is refused before I/O (exit 3)',
        (r.exitCode === 0 || r.exitCode === 1) && disclosed && ok.code === 0 && forgedV.code === 1 && wrong.code === 3 && /commit-then-reveal/.test(wrong.stderr) && !(wrong.stdout + wrong.stderr).includes(dipSecret('not-the-committed-one')),
        `run exit ${r.exitCode}; disclosed ${disclosed}; verify ${ok.code}; forged ${forgedV.code}; uncommitted ${wrong.code}`);
    });
    await C.guard('C5', 'C5-LOGS-NO-HOST', 'hosted logs never name the customer host (G-45)', async () => {
      const origin = `https://${CUSTOMER_HOST}`;
      const mk = (url: string) => {
        const spec = byzSpec({ target: { transport: 'rest', url, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } } as Partial<RunSpecContract>);
        return hostedInputs(spec, signManifest(unsignedManifest(spec, { run_id: run26('G'), verified_origin: { ...unsignedManifest(spec).verified_origin, origin }, egress_allowlist: [{ origin, role: 'target' }] } as Partial<HostedContextContract>)));
      };
      const unreachable = await cli(mk(`${origin}/arena/act`), { ...(hostedEnv() as Record<string, string>) }, 120_000);
      const mismatch = await cli(mk(`https://other-${CUSTOMER_HOST}/arena/act`), { ...(hostedEnv() as Record<string, string>) }, 120_000);
      // Each probe must reach its path (exit 2 = the target was dialled and not reached; exit 3 with the field of the
      // origin check), or it proves nothing about that path.
      const rows = [
        { why: 'network error (unresolvable verified origin)', p: unreachable, reached: unreachable.code === 2 },
        { why: 'refusal (RunSpec origin ≠ verified origin)', p: mismatch, reached: mismatch.code === 3 && /hosted_context_invalid \(\/verified_origin\/origin\)/.test(mismatch.stderr) },
      ].map((x) => ({ ...x, leaked: (x.p.stdout + x.p.stderr).toLowerCase().includes(CUSTOMER_HOST) }));
      C.ok('C5', 'C5-LOGS-NO-HOST', 'G-45: hosted stdout/stderr (Cloud Logging) never names the customer host — on a network error and on an origin-mismatch refusal (each probe must reach its path)', rows.every((r) => r.reached && !r.leaked),
        rows.map((r) => `${r.why}: exit ${r.p.code}${r.reached ? '' : ' (path NOT reached)'}, host ${r.leaked ? 'PRINTED' : 'absent'}`).join(' · '));
    });

    // ═════════ Criterion 6 — pricing, dashboard, dates ═════════
    C.na('C6', 'C6-PRICING', 'pricing page, dashboard entry (pipeline tokens), hosted beta 2026-11-16, GA 2026-11-30', 'sixi-scanner PR 4 (plan table), PR 7 (per-workspace switch), apps/web pricing (B3 copy) and dashboard (B5); dates are the Architect\'s');

    // ═════════ S — security sign-off and the hosted-mode beta conditions (CLI side) ═════════
    if (!P.privateEvidence) {
      C.na('S', 'S-REVIEW', 'docs/phase-9/SECURITY-REVIEW-HOSTED.md verdict line is PASS or PASS-WITH-CONDITIONS', 'private evidence (EXTRACTION §2.2 denies docs/phase-*); judged by the private gate run', 'private');
    } else {
      const p = join(P.docs, 'phase-9', 'SECURITY-REVIEW-HOSTED.md');
      const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
      const rv = parseReviewVerdict(text);
      // What §0 says in prose, shown when the Phase 7 parser finds no verdict line (never scored).
      const lines = text.split('\n');
      const sec0 = lines.slice(lines.findIndex((l) => /^##\s+0\.\s*Verdict/i.test(l)) + 1).find((l) => l.trim()) ?? '';
      const prose = /(PASS-WITH-CONDITIONS|PASS|FAIL|BLOCKED)/.exec(sec0.replace(/\*/g, ''))?.[1];
      C.ok('S', 'S-REVIEW', 'docs/phase-9/SECURITY-REVIEW-HOSTED.md verdict line is PASS or PASS-WITH-CONDITIONS (parsed as the Phase 7 harness does)', rv.verdict === 'PASS' || rv.verdict === 'PASS-WITH-CONDITIONS',
        `verdict: ${rv.display}${rv.verdict === 'none' && prose ? `; §0 prose reads ${prose} on a line without the word "verdict" (security-architect: add a "Current verdict:" line)` : ''}`);
      const st = openReviewFindings(text, rv.note);
      notes.push(st.table ? `SECURITY-REVIEW-HOSTED.md status table: open ${st.open.map((f) => f.id).join(', ') || 'none'}.` : 'SECURITY-REVIEW-HOSTED.md has no "Status of every finding" table; the beta conditions are probed behaviourally (S-G46…S-G49, C5-LOGS-NO-HOST).');
    }
    await C.guard('S', 'S-G46-QUERY-SECRET', 'G-46', async () => {
      const spec = byzSpec({ target: { transport: 'rest', url: `${ORIGIN}/arena/act?api_key=p9-query-canary-77`, auth: { scheme: 'bearer', ref: 'env:ARENA_TARGET_CREDENTIAL' } } } as Partial<RunSpecContract>);
      // No credential delivered: if the query is not refused the run stops at the credential step instead (no I/O either way).
      const p = await cli(hostedInputs(spec, signManifest(unsignedManifest(spec, { run_id: run26('Q') } as Partial<HostedContextContract>))), { ...(hostedEnv({ ARENA_TARGET_CREDENTIAL: undefined }) as Record<string, string>) });
      C.ok('S', 'S-G46-QUERY-SECRET', 'G-46: a hosted RunSpec whose target URL carries a credential-shaped query parameter is refused as run_spec_invalid (target.url)', p.code === 3 && /run_spec_invalid \(target\.url\)/.test(p.stderr), `exit ${p.code}; ${/was not delivered/.test(p.stderr) ? 'passed the target check (G-46 open)' : 'refused'}`);
    });
    await C.guard('S', 'S-G47-PEM-REFUSED', 'G-47', async () => {
      // ARENA_IMAGE_DIGEST unset: if the PEM is accepted the run stops at the image step (no I/O either way).
      const p = await cli(hostedInputs(byzSpec(), signManifest(unsignedManifest(byzSpec(), { run_id: run26('K') } as Partial<HostedContextContract>)), manifestPem), { ...(hostedEnv({ ARENA_IMAGE_DIGEST: undefined }) as Record<string, string>) });
      const pemAccepted = /ARENA_IMAGE_DIGEST is not set/.test(p.stderr);
      const refusedForKey = p.code === 3 && /kid-bound manifest key/.test(p.stderr);
      C.ok('S', 'S-G47-PEM-REFUSED', 'G-47: in hosted mode a kid-less PEM manifest key is refused (a kid-bound JWK/JWKS is required)', refusedForKey, pemAccepted ? 'PEM accepted (G-47 open)' : refusedForKey ? 'exit 3, kid-bound key required' : `exit ${p.code}, refused for another reason`);
      notes.push('G-47 part 1 (ship the Sixi manifest JWKS in pinned-keys.ts, refuse --manifest-key when the pinned set is non-empty) needs the published Sixi key: a release item, not probed here.');
    });
    await C.guard('S', 'S-G48-HOSTED-ONLY', 'G-48', async () => {
      const run = await cli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', 'http://127.0.0.1:9/', '--i-own-this-target', '--episodes', '1', '--seeds', '1'], { ARENA_HOSTED: '1' }, 60_000);
      const serve = await cli(['serve-reference', '--port', '0', '--json'], { ARENA_HOSTED: '1' }, 15_000);
      const refused = (p: Proc) => p.code === 3 && !p.timedOut && /ARENA_HOSTED/.test(p.stderr);
      C.ok('S', 'S-G48-HOSTED-ONLY', 'G-48: with ARENA_HOSTED=1 the CLI refuses a local `run` and `serve-reference` (exit 3) — only run --hosted, version and verify --hosted-seal are accepted', refused(run) && refused(serve),
        `run: exit ${run.code}${refused(run) ? '' : ' (not refused)'} · serve-reference: ${serve.timedOut ? 'kept serving (not refused)' : `exit ${serve.code}`}`);
    });

    // ═════════ X — the npm-leg cross-check (scope local) ═════════
    if (localXc) {
      const t = performance.now();
      const xl = join(OUT, 'xc-local');
      const p = await sh(process.execPath, ['--import', 'tsx', join(ASC, 'qa', 'crosscheck.ts'), '--legs', 'npm', '--digest', IMAGE_INDEX, '--platform', PLATFORM, '--out', xl, '--stable', '--json'], { timeoutMs: 900_000 });
      M['cross-check npm leg, full matrix'] = `${((performance.now() - t) / 1000).toFixed(1)} s`;
      if (existsSync(join(xl, 'crosscheck_record.json'))) {
        const rec = readJson<CrosscheckRecordInput & { cells: unknown[] }>(join(xl, 'crosscheck_record.json'));
        const sum = readJson<{ cells: { verdict: string; anchor?: string }[] }>(join(xl, 'crosscheck_summary.json'));
        const match = sum.cells.filter((c) => c.verdict === 'match').length;
        const anchors = sum.cells.filter((c) => c.anchor).length;
        C.ok('X', 'X-XCHECK-LOCAL', '`qa/crosscheck.ts --legs npm` (full matrix X1+X2+X3): scope local, job verdict pass, every cell match, frozen anchors reproduced', p.code === 0 && rec.scope === 'local' && rec.job_verdict === 'pass' && match === sum.cells.length, `exit ${p.code}, scope ${rec.scope}, ${rec.job_verdict}, ${match}/${sum.cells.length} match, ${anchors} anchored cells`);
        if (main && mainSealed && xcRecord) {
          let refusedLocal = false;
          try {
            renderEvidenceReport(mainSealed, { ...(await evidenceOptions(main, mainSealed)), crosscheckRecord: rec, crosscheckKey: undefined });
          } catch (e) {
            refusedLocal = e instanceof EvidenceRenderError && e.code === 'input' && /scope local/.test(e.message);
          }
          C.ok('C2', 'C2-LOCAL-RECORD-REFUSED', 'a scope-local cross-check record is never cited: the renderer refuses it (contracts 2.5.0)', refusedLocal);
        }
      } else {
        C.ok('X', 'X-XCHECK-LOCAL', 'crosscheck.ts --legs npm produces a record', false, `exit ${p.code}: ${p.stderr.split('\n')[0].slice(0, 160)}`);
      }
    } else {
      C.skip('X', 'X-XCHECK-LOCAL', '`qa/crosscheck.ts --legs npm` full matrix: scope local, pass', '--no-local-crosscheck');
      C.skip('C2', 'C2-LOCAL-RECORD-REFUSED', 'a scope-local cross-check record is never cited by the renderer', '--no-local-crosscheck');
    }
  } finally {
    await Promise.all([refHostedCoord, refHostedNaive, refHostedDip, refOpenCoord, refOpenNaive].map((s) => s.stop()));
  }

  notes.push(`In-process hosted runs wrote ${cliLog.join('').split('\n').filter((l) => l.trim()).length} CLI log line(s) to stderr; captured and kept out of this report (C5-LOGS-TARGET-TEXT inspects them).`);
  notes.push('Seam (C1, C2, C5): hosted runs that must complete use runHostedCommand(…, { transportFactory }) — DNS, the hosted-v1 per-socket address check, TLS/observed_connections and the rps cap are bypassed; everything before the socket, the production transport, the Host allowlist and the run-token check are exercised (file header).');
  M['gate total wall-clock'] = `${((performance.now() - tGate) / 1000).toFixed(1)} s`;
  M['scratch output'] = OUT;
  const criteria = scoreCriteria(C.list);
  const gateOpen = CRITS.every((c) => criteria[c] === 'PASS' || criteria[c] === 'N-A');
  return { checks: C.list, layout: P.layout, criteria, gateOpen, notes, measurements: M, outDir: OUT };
}

// ── main / reporting ────────────────────────────────────────────────────────────
const TITLES: Record<Crit, string> = {
  C1: 'Criterion 1 — hosted run path, SARIF, and the cross-check against the open CLI (scan-action + Security tab: Sixi side)',
  C2: 'Criterion 2 — evidence report: corpus clause ids, ATLAS as labels, "Not assessed", no conformity words, no target text',
  C3: 'Criterion 3 — scenario packs: signed fixture pack, variant resolution, tamper and sx_ refusals ("N of M": Sixi side)',
  C4: 'Criterion 4 — Neutral Ground league runner (Sixi side)',
  C5: 'Criterion 5 — residency and credentials: CLI side (residency itself: Sixi side)',
  C6: 'Criterion 6 — pricing, dashboard, beta and GA dates (Sixi side)',
  S: 'Security — hosted-mode review verdict and the CLI beta conditions G-45…G-49',
  X: 'Extras — the npm-leg cross-check (scope local)',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stable = argv.includes('--stable');
  const r = await runGate({ localCrosscheck: !argv.includes('--no-local-crosscheck'), layout: parseLayoutArg(argv) });
  const L = (s = ''): void => void process.stdout.write(`${s}\n`);
  L('='.repeat(96));
  L('  Agent Arena — Phase-9 GATE (C1, in-repo part): the Sixi Arena hosted layer');
  L('  provable here: the hosted runner, packs, evidence renderer, cross-check runner, CLI credential path');
  L('  requires the Sixi control plane (sixi-scanner PR 1–7, docs/phase-9/SIXI-INTEGRATION.md): N-A (Sixi side)');
  L(`  layout: ${r.layout}`);
  L('='.repeat(96));
  for (const c of CRITS) {
    L('');
    L(`  ${TITLES[c]}`);
    for (const x of r.checks.filter((k) => k.crit === c)) L(renderCheck(x));
  }
  if (r.notes.length) {
    L('');
    L('  Notes (recorded, not scored)');
    for (const n of r.notes) L(`    - ${n}`);
  }
  const pass = r.checks.filter((c) => c.status === 'PASS').length;
  const fail = r.checks.filter((c) => c.status === 'FAIL');
  const na = r.checks.filter((c) => c.status === 'N-A' && c.naKind !== 'private').length;
  const naPrivate = r.checks.filter((c) => c.status === 'N-A' && c.naKind === 'private').length;
  L('');
  L('-'.repeat(96));
  L(`  checks: ${pass}/${r.checks.length - na - naPrivate} pass, ${fail.length} fail, ${r.checks.filter((c) => c.status === 'SKIP').length} skipped, ${r.checks.filter((c) => c.status === 'FINDING').length} finding(s) (not scored), ${na} ${NA_LABEL} (not scored)${naPrivate ? `, ${naPrivate} ${NA_PRIVATE_LABEL} (not scored)` : ''}`);
  if (fail.length) L(`  failing: ${fail.map((c) => `${c.id}${C2M_FLIPPED.includes(c.id) ? ' (a C2m regression check)' : ''}`).join(', ')}`);
  for (const c of CRITS) {
    const n = r.checks.filter((x) => x.crit === c && x.status === 'N-A' && x.naKind !== 'private').length;
    L(`  ${c.padEnd(3)} ${r.criteria[c]}${r.criteria[c] !== 'N-A' && n ? ` (in-repo part; ${n} Sixi-side item${n === 1 ? '' : 's'} N-A)` : ''}`);
  }
  L(`  ${verdictLine(r.criteria)}`);
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
