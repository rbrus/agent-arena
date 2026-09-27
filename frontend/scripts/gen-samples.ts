/**
 * Generates the inspector's sample fixtures under public/samples/ by running
 * the CLI's own `agent-arena run` path (arena-cli `main(['run', …])`, in-process
 * reference targets, no network), so every sample is exactly what a user gets
 * from `agent-arena run` and `agent-arena verify` accepts it unchanged.
 * Build-time tool; never shipped in dist JS.
 *
 *   cd ascension/frontend && npm run samples                  (regenerate everything)
 *   npm run samples -- --only diplomacy                       (just the Diplomacy sample; index.json merged)
 *   npm run samples -- --all-replays                          (ship a replay for every sample)
 *   npm run samples -- --verify                               (run `agent-arena verify` on every listed sample)
 *
 * Layout: one folder per sample, holding the CLI's own sibling names, because
 * the report's `episodes[].replay_ref` is `report.episode-0.replay.json` and
 * `verify` finds the record next to it (`report.episode-0.record.json`):
 *
 *   public/samples/<id>/report.json
 *   public/samples/<id>/report.episode-0.record.json   (what verify re-simulates)
 *   public/samples/<id>/report.episode-0.replay.json   (inspector tick log; optional: verify
 *                                                       checks it against the record when present)
 *
 * The SARIF log and report.run-spec.json are not shipped (verify reads neither
 * for a local report; the RunSpec is embedded in the report).
 *
 * Golden assertions: each episode's replay hash equals the frozen anchor of its
 * golden-pair row (arena-scenarios SELF_TESTS); the Diplomacy sample
 * (robust-diplomat at germany, fill table:commitment_broken, seed 20261115,
 * horizon 1904, Core) must also reproduce the engine golden's transcript and
 * engine evaluation hashes.
 *
 * Not byte-stable across regenerations: run_id, started_at / finished_at,
 * duration_ms and the per-run blinding key are drawn by `run` (the first three
 * are declared unverifiable by verify; the key is an input the hashes do not
 * depend on for these rows). The hashes and verdicts are stable and asserted.
 *
 * The report's disclosure is the canonical sentence, verbatim: verify compares
 * `disclosure`, so the samples no longer prefix "Conflict of interest: ".
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { SELF_TESTS, dipAnchorFor, DIP_GOLDEN_SEED, type ScenarioId, type SelfTestCase } from '../../packages/arena-scenarios/src/index.ts';
import { main as cli } from '../../packages/arena-cli/src/main.ts';
import { startReferenceServer } from '../../packages/arena-cli/src/reference/serve.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'samples');
const ASCENSION = join(HERE, '..', '..');
const SCHEMAS = join(ASCENSION, '..', 'contracts', 'schemas');
const TSX = join(ASCENSION, 'node_modules', '.bin', 'tsx');
const BIN = join(ASCENSION, 'packages', 'arena-cli', 'src', 'bin.ts');

/** What the CLI writes for episode 0 (runner.ts REPORT_BASE + files.ts replayRefFor / recordRefFor). */
export const REPORT = 'report.json';
export const REPLAY = 'report.episode-0.replay.json';
export const RECORD = 'report.episode-0.record.json';

interface IndexEntry {
  id: string;
  label: string;
  report: string;
  replay?: string;
}

interface Sample {
  id: string;
  label: string;
  scenario: ScenarioId;
  args: string[];
  withReplay: boolean;
  /**
   * Serve the CLI's reference agent (`agent-arena serve-reference`) on loopback and run against its REST
   * URL instead of an in-process `ref:` target: the record then carries the wire form the target sent,
   * which is what the inspector renders for an external agent. `args` must not carry --target.
   */
  serve?: { scenario: ScenarioId; policy: 'robust' };
  /** Throws unless the episode reproduces its frozen anchor. */
  check: (episode: Record<string, unknown>) => void;
}

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validate = ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, 'report.schema.json'), 'utf8')));
const ALL_REPLAYS = process.argv.includes('--all-replays');
// Replays are ~0.2-0.5 MB each; ship the Byzantine, duel and Diplomacy ones, the rest with --all-replays.
const withReplay = (s: ScenarioId) => ALL_REPLAYS || s === 'byzantine' || s === 'grid_tactics' || s === 'diplomacy_standard';

function goldenSample(c: SelfTestCase & { scenario: ScenarioId }): Sample {
  const which = c.opts.targetDriver!.replace('ref:', '');
  const seat = c.opts.mode === 'duel' ? ['--seat', 'duel', '--position', String(c.opts.targetSeat ?? 'A')] : ['--seat', String(c.opts.mode)];
  return {
    id: `${c.scenario}-${c.tier}-${c.seed}-${which}`,
    label: `${c.scenario} · ${which} · seed ${c.seed} · ${c.tier}`,
    scenario: c.scenario,
    args: ['--scenario', c.scenario, ...seat, '--tier', c.tier, '--seeds', String(c.seed), '--target', c.opts.targetDriver!],
    withReplay: withReplay(c.scenario),
    check: (ep) => {
      if (ep.replay_hash !== c.expect.replayHash) throw new Error(`${c.name}: replay hash ${String(ep.replay_hash)} != anchor ${c.expect.replayHash}`);
    },
  };
}

function diplomacySample(): Sample {
  const fill = 'table:commitment_broken' as const;
  const horizonYear = 1904;
  const a = dipAnchorFor({ seat: 'germany', tier: 'core', seed: DIP_GOLDEN_SEED, policy: 'robust', fill, horizonYear });
  if (!a) throw new Error('diplomacy sample: no engine golden for robust-diplomat at germany');
  return {
    id: `diplomacy_standard-core-${DIP_GOLDEN_SEED}-robust`,
    label: `diplomacy_standard · robust-diplomat · germany · seed ${DIP_GOLDEN_SEED} · core`,
    scenario: 'diplomacy_standard',
    // Served over REST (not `--target ref:robust`): the in-process reference records the engine action
    // (internal clause keys, no intent phase), the served one the wire frame an external agent sends.
    args: ['--scenario', 'diplomacy_standard', '--seat', 'germany', '--fill', fill, '--horizon', String(horizonYear), '--tier', 'core', '--seeds', String(DIP_GOLDEN_SEED), '--label', 'reference robust-diplomat (sample)'],
    withReplay: withReplay('diplomacy_standard'),
    serve: { scenario: 'diplomacy_standard', policy: 'robust' },
    check: (ep) => {
      const d = ep.diplomacy as { engine_evaluation_hash?: string } | undefined;
      if (ep.replay_hash !== a.replayHash || ep.transcript_hash !== a.transcriptHash || d?.engine_evaluation_hash !== a.engineEvaluationHash) {
        throw new Error('diplomacy sample: the robust-diplomat run does not reproduce the engine golden (replay / transcript / engine evaluation hash)');
      }
    },
  };
}

/** Run `agent-arena run … --out <tmp>` in-process, check the anchor, copy the CLI's files into public/samples/<id>/. */
async function generate(s: Sample): Promise<IndexEntry> {
  const tmp = mkdtempSync(join(tmpdir(), 'arena-sample-'));
  const server = s.serve ? await startReferenceServer({ port: 0, host: '127.0.0.1', policy: s.serve.policy, scenario: s.serve.scenario }) : undefined;
  try {
    const target = server ? ['--target', server.urls.rest] : [];
    const code = await cli(['run', ...s.args, ...target, '--out', tmp, '--quiet']);
    // 0 = no findings, 1 = findings (the naive / null references are meant to fail oracles).
    if (code !== 0 && code !== 1) throw new Error(`${s.id}: agent-arena run exited ${code}`);
    const report = JSON.parse(readFileSync(join(tmp, REPORT), 'utf8')) as { episodes: Record<string, unknown>[] };
    if (!validate(report)) throw new Error(`${s.id}: report invalid: ${ajv.errorsText(validate.errors)}`);
    if (report.episodes.length !== 1 || report.episodes[0].replay_ref !== REPLAY) throw new Error(`${s.id}: expected one episode with replay_ref ${REPLAY}`);
    s.check(report.episodes[0]);
    const dir = join(OUT, s.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of [REPORT, RECORD, ...(s.withReplay ? [REPLAY] : [])]) copyFileSync(join(tmp, f), join(dir, f));
    console.log(`${s.id}: ${String(report.episodes[0].outcome)}@${String(report.episodes[0].terminal_tick)} ${String(report.episodes[0].replay_hash).slice(0, 19)}… (anchor)`);
    return { id: s.id, label: s.label, report: `${s.id}/${REPORT}`, ...(s.withReplay ? { replay: `${s.id}/${REPLAY}` } : {}) };
  } finally {
    await server?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** `agent-arena verify --json` (the real bin, a child process) on every listed sample; returns the failures. */
export function verifySamples(dir = OUT): { id: string; status: string; exitCode: number }[] {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as IndexEntry[];
  return index.map((e) => {
    let stdout: string;
    let exitCode = 0;
    try {
      stdout = execFileSync(TSX, [BIN, 'verify', join(dir, e.report), '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const x = err as { status?: number; stdout?: string };
      exitCode = x.status ?? -1;
      stdout = x.stdout ?? '';
    }
    let status = 'unparseable';
    try {
      status = String((JSON.parse(stdout) as { status?: unknown }).status);
    } catch {
      /* keep 'unparseable' */
    }
    return { id: e.id, status, exitCode };
  });
}

function sortIndex(index: IndexEntry[]): IndexEntry[] {
  // Byzantine coordinated first: it is the default sample.
  const first = 'byzantine-core-20260720-coordinated';
  return [...index].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : a.id < b.id ? -1 : 1));
}

function dirBytes(p: string): number {
  return readdirSync(p).reduce((n, f) => {
    const q = join(p, f);
    return n + (statSync(q).isDirectory() ? dirBytes(q) : statSync(q).size);
  }, 0);
}

async function mainGen(): Promise<void> {
  if (process.argv.includes('--verify')) {
    const results = verifySamples();
    for (const r of results) console.log(`${r.id}: ${r.status} (exit ${r.exitCode})`);
    if (results.some((r) => r.status !== 'verified' || r.exitCode !== 0)) process.exit(1);
    return;
  }
  const onlyAt = process.argv.indexOf('--only');
  const ONLY = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
  if (ONLY !== undefined && ONLY !== 'diplomacy') throw new Error('--only takes: diplomacy');
  mkdirSync(OUT, { recursive: true });

  if (ONLY === 'diplomacy') {
    const entry = await generate(diplomacySample());
    const existing = existsSync(join(OUT, 'index.json')) ? (JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) as IndexEntry[]) : [];
    writeFileSync(join(OUT, 'index.json'), JSON.stringify(sortIndex([...existing.filter((e) => e.id !== entry.id), entry]), null, 1) + '\n');
    return;
  }

  // Golden pairs: every open scenario at Core, seed 20260720 squad (grid: seed 2, the separating duel pair).
  const rows = SELF_TESTS.filter(
    (c) =>
      c.tier === 'core' &&
      !c.name.includes('(gate)') &&
      ((c.scenario === 'grid_tactics' && c.seed === 2) || (c.scenario !== 'grid_tactics' && c.seed === 20260720 && c.opts.mode === 'squad')),
  );
  const samples = [...rows.map(goldenSample), diplomacySample()];
  // A full regeneration owns the folder: drop everything (including the pre-B5c flat files).
  for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true, force: true });
  const index: IndexEntry[] = [];
  for (const s of samples) index.push(await generate(s));
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(sortIndex(index), null, 1) + '\n');
  console.log(`${index.length} samples, ${(dirBytes(OUT) / 1024 / 1024).toFixed(2)} MB in ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mainGen().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
