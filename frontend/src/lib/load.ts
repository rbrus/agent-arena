// Hostile-file loader (threat-model-arena.md §3.2.6, §4.2): size cap, JSON only,
// depth cap, no prototype keys, shape-checked before anything renders, counts
// capped at the contract maxima. No network, no dynamic import of anything named
// in a file. Full schema validation is `agent-arena verify`'s job; this guard
// checks every field the inspector reads, with the type it reads it as.
import { REPLAY_LIMITS, type ReplayFile } from './replay-format.ts';

export const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const HASH = /^sha256:[0-9a-f]{64}$/;

export type Verdict = 'pass' | 'fail' | 'not_assessed';
export type Severity = 'error' | 'warning' | 'note';
export interface OracleResult {
  oracle_id: string;
  seat?: string;
  verdict: Verdict;
  severity: Severity;
  basis: string;
  reason_code?: string;
  measures?: Record<string, number>;
  thresholds?: Record<string, number>;
  review_required?: boolean;
  evidence_ref?: { replay_hash: string; ticks: number[]; code?: string; message?: string; items?: EvidenceItem[] };
}
export interface EvidenceItem {
  kind: string;
  id: string;
  tick: number;
  phase?: string;
  step?: string;
}
/** diplomacy_standard (contracts 2.1.0+): reported context, never scored. */
export interface DiplomacyBlock {
  power: string;
  profile: string;
  horizon_year: number;
  press_rounds: number;
  sig_mode: string;
  terminal?: { kind: string; year?: number; winner?: string | null };
  sc_counts: Record<string, number>;
  unit_counts: Record<string, number>;
  eliminated: string[];
  civil_disorder: string[];
  roster: { power: string; seat_kind: string; agent?: string; persona?: string }[];
  engagement: Record<string, number>;
  engine_evaluation_hash?: string;
}
export interface SeatProvenance {
  seat: string;
  driver: string;
  inputs_source: string;
  agent?: string;
  recorded_inputs?: { decisions: number; digest: string };
}
export interface NotAssessed {
  kind: string;
  id: string;
  reason_code: string;
  seat?: string;
  episodes?: number;
}
export interface Episode {
  episode_index: number;
  seed: number;
  scenario_id: string;
  mode: string;
  seat: string;
  fill?: string;
  status: string;
  abort_reason?: string;
  outcome: string;
  outcome_reason?: string;
  terminal_tick: number;
  replay_hash: string;
  trajectory_class?: string;
  budget: Record<string, number | boolean | string | Record<string, number>>;
  oracles: OracleResult[];
  transcript_hash?: string;
  evaluation_hash?: string;
  diplomacy?: DiplomacyBlock;
  seats?: SeatProvenance[];
}
export interface Report {
  report_version: '1.0';
  run: {
    run_id: string;
    mode: string;
    started_at: string;
    finished_at: string;
    tool: { name: string; version: string };
    spec: {
      scenario_id: string;
      budget_tier: string;
      seeds: number[];
      seat?: { mode: string; position?: string; fill?: string };
      target: { transport: string; url: string; label?: string };
    };
  };
  engine: { build_hash: string; version: string; commit?: string };
  scenario: { scenario_id: string; version: string; oracles: { oracle_id: string; title: string; primary?: boolean; basis: string }[] };
  episodes: Episode[];
  run_oracles: OracleResult[];
  summary: { verdict: string; episodes_total: number; effective_episodes: number };
  disclosure: { conflict_of_interest: string; determinism?: string };
  not_assessed?: NotAssessed[];
}

export class LoadError extends Error {}

function fail(path: string, what: string): never {
  throw new LoadError(`${path}: ${what}`);
}

/** JSON.parse with a prototype-key ban and a depth cap. */
export function safeParse(text: string): unknown {
  if (text.length > MAX_BYTES) fail('file', `larger than ${MAX_BYTES} bytes`);
  let v: unknown;
  try {
    v = JSON.parse(text, (k, val) => {
      if (FORBIDDEN.has(k)) throw new LoadError(`forbidden key "${k}"`);
      return val;
    });
  } catch (e) {
    if (e instanceof LoadError) throw e;
    fail('file', 'not valid JSON');
  }
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d > MAX_DEPTH) fail('file', `nesting deeper than ${MAX_DEPTH}`);
    for (const c of Object.values(x)) stack.push([c, d + 1]);
  }
  return v;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
function obj(x: unknown, p: string): Record<string, unknown> {
  if (!isObj(x)) fail(p, 'expected an object');
  return x;
}
function arr(x: unknown, p: string, max: number): unknown[] {
  if (!Array.isArray(x)) fail(p, 'expected an array');
  if (x.length > max) fail(p, `more than ${max} items`);
  return x;
}
function str(x: unknown, p: string, opt = false, max = 4096): void {
  if (opt && x === undefined) return;
  if (typeof x !== 'string' || x.length > max) fail(p, max === 4096 ? 'expected a string' : `expected a string of at most ${max} characters`);
}
function int(x: unknown, p: string, max = 0xffffffff): void {
  if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > max) fail(p, `expected an integer 0..${max}`);
}
function oneOf(x: unknown, p: string, vals: readonly string[]): void {
  if (!vals.includes(x as string)) fail(p, `expected one of ${vals.join('|')}`);
}
function hash(x: unknown, p: string): void {
  if (typeof x !== 'string' || !HASH.test(x)) fail(p, 'expected sha256:<64 hex>');
}
function numMap(x: unknown, p: string, max = 64): void {
  if (x === undefined) return;
  const o = obj(x, p);
  if (Object.keys(o).length > max) fail(p, 'too many keys');
  for (const [k, v] of Object.entries(o)) if (typeof v !== 'number') fail(`${p}.${k}`, 'expected a number');
}

function oracle(x: unknown, p: string): void {
  const o = obj(x, p);
  str(o.oracle_id, `${p}.oracle_id`);
  str(o.seat, `${p}.seat`, true);
  oneOf(o.verdict, `${p}.verdict`, ['pass', 'fail', 'not_assessed']);
  oneOf(o.severity, `${p}.severity`, ['error', 'warning', 'note']);
  str(o.basis, `${p}.basis`);
  str(o.reason_code, `${p}.reason_code`, true);
  numMap(o.measures, `${p}.measures`);
  numMap(o.thresholds, `${p}.thresholds`);
  if (o.review_required !== undefined && typeof o.review_required !== 'boolean') fail(`${p}.review_required`, 'expected a boolean');
  if (o.evidence_ref !== undefined) {
    const e = obj(o.evidence_ref, `${p}.evidence_ref`);
    hash(e.replay_hash, `${p}.evidence_ref.replay_hash`);
    arr(e.ticks, `${p}.evidence_ref.ticks`, 32).forEach((t, i) => int(t, `${p}.evidence_ref.ticks[${i}]`, 1000));
    str(e.code, `${p}.evidence_ref.code`, true);
    str(e.message, `${p}.evidence_ref.message`, true);
    if (e.items !== undefined)
      arr(e.items, `${p}.evidence_ref.items`, 32).forEach((it, k) => {
        const q = `${p}.evidence_ref.items[${k}]`;
        const o2 = obj(it, q);
        str(o2.kind, `${q}.kind`, false, 32);
        str(o2.id, `${q}.id`, false, 80);
        int(o2.tick, `${q}.tick`, 1000);
        str(o2.phase, `${q}.phase`, true, 16);
        str(o2.step, `${q}.step`, true, 16);
      });
  }
}

const strList = (x: unknown, p: string, max: number) => arr(x, p, max).forEach((v, i) => str(v, `${p}[${i}]`, false, 64));

/** The Diplomacy episode block (episode_result.schema.json `diplomacy`): every field the inspector reads. */
function diplomacy(x: unknown, p: string): void {
  const d = obj(x, p);
  for (const k of ['power', 'profile', 'sig_mode']) str(d[k], `${p}.${k}`, false, 64);
  int(d.horizon_year, `${p}.horizon_year`, 9999);
  int(d.press_rounds, `${p}.press_rounds`, 16);
  if (d.terminal !== undefined) {
    const t = obj(d.terminal, `${p}.terminal`);
    str(t.kind, `${p}.terminal.kind`, false, 32);
    if (t.year !== undefined) int(t.year, `${p}.terminal.year`, 9999);
    if (t.winner !== undefined && t.winner !== null) str(t.winner, `${p}.terminal.winner`, false, 64);
  }
  numMap(d.sc_counts, `${p}.sc_counts`, 7);
  numMap(d.unit_counts, `${p}.unit_counts`, 7);
  numMap(d.engagement, `${p}.engagement`, 32);
  strList(d.eliminated, `${p}.eliminated`, 7);
  strList(d.civil_disorder, `${p}.civil_disorder`, 7);
  arr(d.roster, `${p}.roster`, 7).forEach((r, i) => {
    const q = `${p}.roster[${i}]`;
    const o = obj(r, q);
    for (const k of ['power', 'seat_kind']) str(o[k], `${q}.${k}`, false, 64);
    for (const k of ['agent', 'persona']) str(o[k], `${q}.${k}`, true, 96);
  });
  if (d.engine_evaluation_hash !== undefined) hash(d.engine_evaluation_hash, `${p}.engine_evaluation_hash`);
}

function seats(x: unknown, p: string): void {
  arr(x, p, 7).forEach((s, i) => {
    const q = `${p}[${i}]`;
    const o = obj(s, q);
    for (const k of ['seat', 'driver', 'inputs_source']) str(o[k], `${q}.${k}`, false, 64);
    str(o.agent, `${q}.agent`, true, 96);
    if (o.recorded_inputs !== undefined) {
      const r = obj(o.recorded_inputs, `${q}.recorded_inputs`);
      int(r.decisions, `${q}.recorded_inputs.decisions`, 1000);
      hash(r.digest, `${q}.recorded_inputs.digest`);
    }
  });
}

export function checkReport(x: unknown): Report {
  const r = obj(x, 'report');
  if (r.report_version !== '1.0') fail('report.report_version', 'expected "1.0"');
  const run = obj(r.run, 'run');
  for (const k of ['run_id', 'mode', 'started_at', 'finished_at']) str(run[k], `run.${k}`);
  const tool = obj(run.tool, 'run.tool');
  str(tool.name, 'run.tool.name');
  str(tool.version, 'run.tool.version');
  const spec = obj(run.spec, 'run.spec');
  str(spec.scenario_id, 'run.spec.scenario_id');
  str(spec.budget_tier, 'run.spec.budget_tier');
  arr(spec.seeds, 'run.spec.seeds', 1000).forEach((s, i) => int(s, `run.spec.seeds[${i}]`));
  if (spec.seat !== undefined) {
    const seat = obj(spec.seat, 'run.spec.seat');
    str(seat.mode, 'run.spec.seat.mode');
    str(seat.position, 'run.spec.seat.position', true);
    str(seat.fill, 'run.spec.seat.fill', true);
  }
  const target = obj(spec.target, 'run.spec.target');
  str(target.transport, 'run.spec.target.transport');
  str(target.url, 'run.spec.target.url');
  str(target.label, 'run.spec.target.label', true);
  const eng = obj(r.engine, 'engine');
  str(eng.build_hash, 'engine.build_hash');
  str(eng.version, 'engine.version');
  str(eng.commit, 'engine.commit', true);
  const sc = obj(r.scenario, 'scenario');
  str(sc.scenario_id, 'scenario.scenario_id');
  str(sc.version, 'scenario.version');
  arr(sc.oracles, 'scenario.oracles', 64).forEach((o, i) => {
    const d = obj(o, `scenario.oracles[${i}]`);
    str(d.oracle_id, `scenario.oracles[${i}].oracle_id`);
    str(d.title, `scenario.oracles[${i}].title`);
    str(d.basis, `scenario.oracles[${i}].basis`);
    if (d.primary !== undefined && typeof d.primary !== 'boolean') fail(`scenario.oracles[${i}].primary`, 'expected a boolean');
  });
  arr(r.episodes, 'episodes', 1000).forEach((e, i) => {
    const p = `episodes[${i}]`;
    const ep = obj(e, p);
    int(ep.episode_index, `${p}.episode_index`, 999);
    int(ep.seed, `${p}.seed`);
    for (const k of ['scenario_id', 'mode', 'seat', 'status', 'outcome']) str(ep[k], `${p}.${k}`);
    for (const k of ['fill', 'abort_reason', 'outcome_reason']) str(ep[k], `${p}.${k}`, true);
    int(ep.terminal_tick, `${p}.terminal_tick`, 120);
    hash(ep.replay_hash, `${p}.replay_hash`);
    if (ep.trajectory_class !== undefined) hash(ep.trajectory_class, `${p}.trajectory_class`);
    const b = obj(ep.budget, `${p}.budget`);
    if (Object.keys(b).length > 32) fail(`${p}.budget`, 'too many keys');
    for (const [k, v] of Object.entries(b)) {
      // diplomacy_standard (2.1.0): press accounting is one flat object of counters.
      if (k === 'press' && isObj(v)) numMap(v, `${p}.budget.press`, 32);
      else if (!['number', 'boolean', 'string'].includes(typeof v)) fail(`${p}.budget.${k}`, 'expected a scalar');
    }
    arr(ep.oracles, `${p}.oracles`, 64).forEach((o, j) => oracle(o, `${p}.oracles[${j}]`));
    for (const k of ['transcript_hash', 'evaluation_hash']) if (ep[k] !== undefined) hash(ep[k], `${p}.${k}`);
    if (ep.diplomacy !== undefined) diplomacy(ep.diplomacy, `${p}.diplomacy`);
    if (ep.seats !== undefined) seats(ep.seats, `${p}.seats`);
  });
  arr(r.run_oracles, 'run_oracles', 16).forEach((o, j) => oracle(o, `run_oracles[${j}]`));
  const sum = obj(r.summary, 'summary');
  str(sum.verdict, 'summary.verdict');
  int(sum.episodes_total, 'summary.episodes_total', 1000);
  int(sum.effective_episodes, 'summary.effective_episodes', 1000);
  const dis = obj(r.disclosure, 'disclosure');
  str(dis.conflict_of_interest, 'disclosure.conflict_of_interest');
  str(dis.determinism, 'disclosure.determinism', true);
  if (r.not_assessed !== undefined)
    arr(r.not_assessed, 'not_assessed', 64).forEach((n, i) => {
      const q = `not_assessed[${i}]`;
      const o = obj(n, q);
      for (const k of ['kind', 'id', 'reason_code']) str(o[k], `${q}.${k}`, false, 96);
      str(o.seat, `${q}.seat`, true, 16);
      if (o.episodes !== undefined) int(o.episodes, `${q}.episodes`, 1000);
    });
  return r as unknown as Report;
}

export function checkReplay(x: unknown): ReplayFile {
  const r = obj(x, 'replay');
  if (r.replay_version !== '1.0') fail('replay.replay_version', 'expected "1.0"');
  for (const k of ['scenario_id', 'tier', 'mode', 'seat']) str(r[k], `replay.${k}`);
  int(r.episode_index, 'replay.episode_index', 999);
  int(r.seed, 'replay.seed');
  hash(r.replay_hash, 'replay.replay_hash');
  hash(r.initial_state_hash, 'replay.initial_state_hash');
  arr(r.ticks, 'replay.ticks', REPLAY_LIMITS.ticks).forEach((t, i) => {
    const p = `ticks[${i}]`;
    const tk = obj(t, p);
    int(tk.tick, `${p}.tick`, 1000);
    hash(tk.state_hash, `${p}.state_hash`);
    arr(tk.seats, `${p}.seats`, REPLAY_LIMITS.seats).forEach((s, j) => {
      const q = `${p}.seats[${j}]`;
      const st = obj(s, q);
      str(st.seat, `${q}.seat`);
      const ack = obj(st.ack, `${q}.ack`);
      oneOf(ack.status, `${q}.ack.status`, ['accepted', 'rejected', 'miss', 'none']);
      str(ack.reason, `${q}.ack.reason`, true);
      if (ack.coercions !== undefined) arr(ack.coercions, `${q}.ack.coercions`, 64).forEach((c, k) => obj(c, `${q}.ack.coercions[${k}]`));
    });
    arr(tk.engine_events, `${p}.engine_events`, REPLAY_LIMITS.events).forEach((e, j) => str(obj(e, `${p}.engine_events[${j}]`).type, `${p}.engine_events[${j}].type`));
    arr(tk.oracle_events, `${p}.oracle_events`, REPLAY_LIMITS.events).forEach((e, j) => {
      const ev = obj(e, `${p}.oracle_events[${j}]`);
      str(ev.oracle_id, `${p}.oracle_events[${j}].oracle_id`);
      oneOf(ev.severity, `${p}.oracle_events[${j}].severity`, ['error', 'warning', 'note']);
    });
  });
  return r as unknown as ReplayFile;
}

export type Loaded = { kind: 'report'; report: Report } | { kind: 'replay'; replay: ReplayFile };

/** Classify and check one file's text. Throws LoadError with a path on any problem. */
export function loadText(text: string): Loaded {
  const v = safeParse(text);
  if (isObj(v) && 'report_version' in v) return { kind: 'report', report: checkReport(v) };
  if (isObj(v) && 'replay_version' in v) return { kind: 'replay', replay: checkReplay(v) };
  fail('file', 'neither a report (report_version) nor a replay (replay_version)');
}

export async function loadFile(f: File): Promise<Loaded> {
  if (f.size > MAX_BYTES) fail('file', `larger than ${MAX_BYTES} bytes`);
  return loadText(await f.text());
}
