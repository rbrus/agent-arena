/**
 * The `Rerun` callback `verifyReport` drives (threat model §3.2, ADR-004):
 * re-simulate one episode from its record with arena-scenarios' upstream
 * `redrive(record)` (a fresh Scenario re-driven through its own act()/tick(),
 * the exact inverse of the adapter's timing log). Every engine-controlled seat
 * (boss, house bot, reference fill, Byzantine peers) is regenerated from the
 * seed; only the target seat's free inputs (its applied actions, rejected
 * frames, per-tick decision entries and adapter coercions) come from the
 * record. Any disagreement between the regenerated and the recorded inputs,
 * per-tick hashes, terminal or timing log throws (the episode is then
 * unverifiable, never a match). Verdicts are recomputed from the regenerated
 * record.
 *
 * ADR-004: the seats `ctx.recordedSeats` names are the target's; their action
 * arrays (`inputs[t][seat] ?? null`, decision order) are returned as
 * `recordedActions`, from which verify recomputes each `recorded_inputs.digest`.
 * The seats `ctx.regeneratedSeats` names must be engine seats in the record.
 */

import { dirname } from 'node:path';
import {
  redrive,
  RedriveDriverMismatchError,
  targetDriverFromRunSpecTarget,
  targetDriverOf,
  toEpisodeResult,
  SCENARIO_IDS,
  type EpisodeRecord,
  type TargetDriver,
} from 'arena-scenarios';
import { DIP_IN_PROCESS, DIPLOMACY, dipRecordedActions } from './diplomacy.ts';
import { readHostileJson, recordRefFor, resolveInside } from './files.ts';
import type { EpisodeResult, Rerun, RerunContext, RerunOutput, RunSpec } from './report.ts';
import { recordText as q } from './inert.ts';
import { assertDipRecordShape, dipRegenerateChecks, dipRerunChecks, type DipRerunOptions } from './verify-diplomacy.ts';

export { redrive, type DecisionTrace } from 'arena-scenarios';

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_TICKS = 121;

/** Scenarios whose records this CLI version re-simulates: every registered one (diplomacy_standard since C2g). */
export const CLI_SCENARIOS: readonly string[] = [...SCENARIO_IDS];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(msg: string): never {
  throw new Error(msg);
}

/** Structural sanity before anything is simulated (a record claiming 10^9 ticks is rejected, not run). */
export function assertRecordShape(v: unknown): asserts v is EpisodeRecord {
  if (!isObj(v)) fail('the episode record is not an object');
  for (const k of ['scenarioId', 'scenarioVersion', 'tier', 'mode', 'targetSeat', 'blindingKey', 'replayHash'] as const) if (typeof v[k] !== 'string') fail(`record.${k} missing`);
  if (!Number.isInteger(v.seed)) fail('record.seed missing');
  for (const k of ['inputs', 'timing', 'adapterCoercions', 'perTickHashes', 'seats'] as const) if (!Array.isArray(v[k])) fail(`record.${k} must be an array`);
  if ((v.inputs as unknown[]).length > MAX_TICKS || (v.perTickHashes as unknown[]).length > MAX_TICKS) fail(`the record claims more than ${MAX_TICKS - 1} ticks`);
  if ((v.timing as unknown[]).length > MAX_TICKS * 40) fail('the timing log is implausibly long');
  if ((v.adapterCoercions as unknown[]).length > MAX_TICKS * 5 * 8) fail('too many adapter coercions');
  if (!isObj(v.terminal)) fail('record.terminal missing');
  if (!(SCENARIO_IDS as readonly string[]).includes(v.scenarioId as string)) fail(`unknown scenario ${q(v.scenarioId)}`);
  if (!CLI_SCENARIOS.includes(v.scenarioId as string)) fail(`${v.scenarioId as string} records are not supported by this CLI version yet`);
  assertDipRecordShape(v);
}

const canon = (v: unknown) => JSON.stringify(v);

/**
 * The engine driver an in-process reference name (`--target ref:…`, recorded in
 * the RunSpec as `http://in-process.invalid/<ref>`) stands for in a scenario:
 * grid_tactics maps the Phase-7 pair names onto its duel references,
 * diplomacy_standard onto its robust/credulous pair. Shared by `run` and
 * `verify`, so both read the RunSpec the same way.
 */
export function inProcessDriver(scenarioId: string, ref: string): TargetDriver {
  if (scenarioId === DIPLOMACY) {
    const d = DIP_IN_PROCESS[ref];
    if (!d) fail(`${q(ref)} is not an in-process reference for ${scenarioId}`);
    return d;
  }
  if (scenarioId === 'grid_tactics') return (({ 'ref:coordinated': 'ref:reflex', 'ref:naive': 'ref:null' }) as Record<string, TargetDriver>)[ref] ?? (ref as TargetDriver);
  return ref as TargetDriver;
}

/**
 * G-33: the target driver the RunSpec implies (never the record): `external`
 * for a real target URL, else the in-process reference its URL names, with the
 * scenario's aliases resolved.
 */
export function expectedTargetDriver(spec: Pick<RunSpec, 'scenario_id' | 'target'>): TargetDriver {
  const d = targetDriverFromRunSpecTarget(spec.target);
  return d === 'external' ? d : inProcessDriver(spec.scenario_id, d);
}

/** G-33: the fixed text a driver mismatch is reported with (never the record's own wording). */
export const DRIVER_MISMATCH_MESSAGE =
  'seat provenance mismatch (G-33): the episode record drives the target seat differently from the RunSpec target (an external agent replayed from the record vs an in-process reference regenerated from the seed); the RunSpec decides, so the report does not verify';

/** Runs `f`; a G-33 driver mismatch surfaces as the fixed DRIVER_MISMATCH_MESSAGE (no record text). */
function driverChecked<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof RedriveDriverMismatchError) fail(DRIVER_MISMATCH_MESSAGE);
    throw e;
  }
}

/**
 * Compare the regenerated record with the claimed one; throw on the first disagreement.
 * `expectedTargetDriver` (G-33) is the driver the RunSpec implies; verify always passes it,
 * and a record that disagrees throws `RedriveDriverMismatchError` before anything is simulated.
 */
export function regenerate(claimed: EpisodeRecord, expectedTargetDriver?: TargetDriver): EpisodeRecord {
  const re = redrive(claimed, expectedTargetDriver === undefined ? undefined : { expectedTargetDriver }).record();
  if (re.inputs.length !== claimed.inputs.length) fail(`the record has ${claimed.inputs.length} ticks, the re-simulation ${re.inputs.length}`);
  for (let t = 0; t < re.inputs.length; t++) {
    if (canon(re.inputs[t]) !== canon(claimed.inputs[t])) {
      fail(`tick ${t}: recorded inputs differ from the regenerated ones (an engine-controlled seat was altered, or a target action is not canonical)`);
    }
  }
  if (canon(re.perTickHashes) !== canon(claimed.perTickHashes)) fail('per-tick state hashes differ from the re-simulation');
  if (re.replayHash !== claimed.replayHash) fail(`replay hash differs: recorded ${q(claimed.replayHash, 80)}, re-simulated ${q(re.replayHash, 80)}`);
  if (canon(re.terminal) !== canon(claimed.terminal)) fail('terminal state differs from the re-simulation');
  if (claimed.seats.length && canon(re.seats) !== canon(claimed.seats)) fail('seat descriptors differ from the re-simulation');
  if (re.targetSeat !== claimed.targetSeat || re.mode !== claimed.mode) fail('seating differs from the re-simulation');
  if (targetDriverOf(claimed) === 'external' && canon(re.timing) !== canon(claimed.timing)) fail('the timing log is not self-consistent under re-simulation');
  dipRegenerateChecks(claimed, re);
  // Adapter coercions are a property of the target's raw frames (free input): carried over after a sanity check.
  const controls = targetControls(re);
  for (const c of claimed.adapterCoercions) {
    if (!isObj(c) || !Number.isInteger(c.tick) || c.tick < 0 || c.tick >= re.inputs.length || c.reason !== 'over_speed' || !controls.has(String(c.member))) {
      fail('an adapter coercion names a tick or member outside the target seat');
    }
  }
  return { ...re, adapterCoercions: claimed.adapterCoercions.map((c) => ({ ...c })) };
}

/** The engine ids the target controls in a record (squad: m0..m4; member: the one member; duel: A or B). */
export function targetControls(rec: EpisodeRecord): Set<string> {
  return new Set(rec.seats.filter((s) => s.role === 'target').flatMap((s) => s.controls));
}

/**
 * One seat's recorded action array, in decision order (the `recorded_inputs` commitment):
 * `inputs[t][seat] ?? null`; diplomacy_standard: the target power's accepted payloads per
 * decision (diplomacy.ts `dipRecordedActions`).
 */
export function recordedActionsOf(rec: EpisodeRecord, seat: string): unknown[] {
  if (rec.scenarioId === 'diplomacy_standard') return dipRecordedActions(rec, seat);
  return rec.inputs.map((t) => (isObj(t) ? (t[seat] ?? null) : null));
}

/** A redaction label `writeOutput` leaves behind (redact.ts); never the edge marker `[redact]` (G-40). */
const WRITE_REDACTION = /\[redacted:(?:shape|env|secret)\]/;

/**
 * G-40: a Diplomacy record whose target press was redacted on WRITE (an
 * agent-arena before C2k, or a secret registered after the run) holds engine
 * inputs the engine never saw, so it cannot re-simulate. Name that cause instead
 * of the bare hash difference.
 */
function withRedactionHint<T>(rec: EpisodeRecord, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof RedriveDriverMismatchError || rec.scenarioId !== DIPLOMACY) throw e;
    const inputs = (rec as { diplomacy?: { targetInputs?: unknown } }).diplomacy?.targetInputs;
    if (!WRITE_REDACTION.test(JSON.stringify(inputs ?? null))) throw e;
    fail(
      `${e instanceof Error ? e.message : 'the re-simulation failed'}; the record's target press holds redaction labels written after the run (the file was redacted after the engine consumed the original text), so it cannot re-simulate: re-run the evaluation with this agent-arena version, which redacts press before the engine`,
    );
  }
}

/** Load the record behind a `replay_ref` (`<report>.episode-<n>.replay.json` → `….record.json`). */
export function loadRecord(reportPath: string, replayRef: string): EpisodeRecord {
  const v = readHostileJson(resolveInside(dirname(reportPath), recordRefFor(replayRef)), MAX_RECORD_BYTES, 'episode record');
  assertRecordShape(v);
  return v;
}

/** The `Rerun` for a report at `reportPath`. */
export function makeRerun(reportPath: string, onRegenerated?: (rec: EpisodeRecord, result: EpisodeResult, ctx: RerunContext) => void, o: DipRerunOptions = {}): Rerun {
  return (spec: RunSpec, seed: number, ctx: RerunContext): RerunOutput => {
    if (!CLI_SCENARIOS.includes(spec.scenario_id)) fail(`${q(spec.scenario_id)} is not supported by this CLI version yet`);
    if (!ctx.replayRef) fail('the report carries no replay_ref for this episode; nothing to re-simulate');
    const rec = loadRecord(reportPath, ctx.replayRef);
    if (rec.scenarioId !== spec.scenario_id) fail(`record is for ${q(rec.scenarioId)}, the report for ${q(spec.scenario_id)}`);
    // G-33: the RunSpec, not the record, decides whether the target seat is replayed or regenerated.
    const driver = expectedTargetDriver(spec);
    if (rec.seed !== seed) fail(`record seed ${q(rec.seed, 12)} is not the RunSpec's seed ${seed} for this episode`);
    if (rec.tier !== ctx.tier) fail(`record tier ${q(rec.tier)} is not ${q(ctx.tier)}`);
    if (rec.mode !== ctx.mode) fail(`record seating ${q(rec.mode)} is not ${q(ctx.mode)}`);
    if (ctx.mode === 'power') driverChecked(() => dipRerunChecks(spec, rec, ctx, driver, o));
    else if (rec.targetSeat !== ctx.seat) fail(`record seat ${q(rec.targetSeat)} is not ${q(ctx.seat)}`);
    if (ctx.mode === 'member' && (rec.fill ?? 'coordinated') !== (ctx.fill ?? 'coordinated')) fail('record fill differs from the RunSpec');
    if (ctx.blindingKey && rec.blindingKey !== ctx.blindingKey) fail('record blinding key differs from the one the report discloses');
    const re = driverChecked(() => withRedactionHint(rec, () => regenerate(rec, driver)));
    // ADR-004: the RunSpec decides which seats are recorded; the record must agree.
    const controls = targetControls(re);
    for (const s of ctx.regeneratedSeats) {
      if (controls.has(s)) fail(`seat ${q(s)} is regenerated from the seed per the RunSpec, but the record has it driven by the target`);
    }
    const recordedActions: Record<string, unknown[]> = {};
    for (const rs of ctx.recordedSeats) {
      if (!controls.has(rs.seat)) fail(`seat ${q(rs.seat)} is a recorded ${q(rs.driver)} seat per the RunSpec, but the record has it driven by the engine`);
      recordedActions[rs.seat] = recordedActionsOf(re, rs.seat);
    }
    const result = toEpisodeResult(re, { episodeIndex: ctx.episodeIndex, replayRef: ctx.replayRef }) as EpisodeResult;
    onRegenerated?.(re, result, ctx);
    return { result, recordedActions };
  };
}
