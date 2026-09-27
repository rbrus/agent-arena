/**
 * `redrive(record)`: re-simulate an episode by RE-DRIVING a fresh Scenario
 * through its own `act()`/`tick()`, the inverse of the adapter's timing log.
 *
 * Only the target seat's free inputs are taken from the record: the applied
 * target actions (`inputs[t]` restricted to the seat's controls), the rejected
 * frames and the per-tick decision entry. Every engine-controlled seat (boss,
 * house bot, reference fill, in-process target driver) is regenerated from the
 * seed. The result is the regenerated Scenario (terminal); the caller compares
 * its `record()` with the claimed one. `redrive` itself throws only when the
 * record cannot be replayed at all (a recorded action the adapter refuses, a
 * missing decision entry, no terminal within the cap).
 *
 * The decision-entry inverse lives here, next to `act()`, so a change to the
 * adapter's timing semantics changes both at once (the round-trip property
 * `redrive(r).record() == r` is asserted in test/redrive.test.ts for in-process
 * references and for external targets with late, rejected, oversized, missed
 * and duplicate frames).
 */

import { createScenario } from './registry.ts';
import { REFERENCE } from './references.ts';
import { TICK_CAP } from './tiers.ts';
import type { EpisodeRecord, RaidScenarioId, Scenario, SeatId, Submission, TargetDriver, TimingEntry } from './types.ts';

/** What the target seat saw and what the adapter did with its answer, per decision. */
export interface DecisionTrace {
  tick: number;
  seat: SeatId;
  observation: unknown;
  /** The canonical payload the engine applied for the target seat (null when nothing was accepted). */
  action: Record<string, unknown> | null;
  ack: { status: 'accepted' | 'rejected' | 'miss' | 'none'; reason?: string; coercions?: { unit_id: string; reason: string }[]; late?: boolean };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(msg: string): never {
  throw new Error(`redrive: ${msg}`);
}

/**
 * The target driver a record was produced with, from the target seat's
 * `policyRef`: `external`, `driver:ref:<reflex|null|silver>` (duel), or
 * `driver:ref:<policy name>` (raids; resolved against REFERENCE, so renamed
 * references such as `orderedLockSquad.disciplined` resolve too).
 */
export function targetDriverOf(rec: EpisodeRecord): TargetDriver {
  const ref = rec.seats.find((s) => s.role === 'target')?.policyRef ?? 'external';
  if (ref === 'external') return 'external';
  if (!ref.startsWith('driver:ref:')) fail(`unsupported target policyRef ${ref.slice(0, 60)}`);
  const name = ref.slice('driver:ref:'.length);
  if (rec.scenarioId === 'diplomacy_standard') {
    if (name === 'robust-diplomat') return 'ref:robust';
    if (name === 'credulous-diplomat') return 'ref:credulous';
    if (name === 'house-diplomat') return 'ref:house';
    fail(`unsupported diplomacy driver ${name.slice(0, 40)}`);
  }
  if (rec.scenarioId === 'grid_tactics') {
    if (name === 'reflex' || name === 'null' || name === 'silver') return `ref:${name}`;
    fail(`unsupported duel driver ${name.slice(0, 40)}`);
  }
  const pair = REFERENCE[rec.scenarioId as RaidScenarioId];
  if (pair?.coordinated.name === name || name === 'coordinated') return 'ref:coordinated';
  if (pair?.naive.name === name || name === 'naive') return 'ref:naive';
  fail(`unsupported raid driver ${name.slice(0, 40)} for ${rec.scenarioId}`);
}

/** The target seat's applied action payload for tick t, in the frame shape act() takes. */
export function targetPayloadAt(rec: EpisodeRecord, t: number): Record<string, unknown> {
  if (rec.scenarioId === 'diplomacy_standard') {
    // Engine inputs are the translated form; the target's own (schema-valid) payload is kept verbatim.
    const hit = rec.diplomacy?.targetInputs.find((x) => x.tick === t);
    return hit ? structuredClone(hit.payload) : {};
  }
  const inp = rec.inputs[t];
  if (!isObj(inp)) fail(`record.inputs[${t}] is not an object`);
  if (rec.mode === 'squad') {
    const members: Record<string, unknown> = {};
    for (const k of Object.keys(inp).sort()) members[k] = inp[k];
    return { members };
  }
  return { units: inp[rec.targetSeat] ?? [] };
}

/**
 * Accepted-frame test on a decision entry — the exact inverse of act()/tick():
 * `none` is recorded only for an accepted frame (or an in-process driver);
 * `soft` is either an accepted frame past Ds (latency present) or an explicit
 * soft miss (latency null); `hard` never carries an accepted frame.
 */
function wasAccepted(d: TimingEntry): boolean {
  return d.miss === 'none' || (d.miss === 'soft' && d.latencyMs !== null);
}

/** Every target driver a record may name (`TargetDriver`), for validating a RunSpec-derived value. */
const TARGET_DRIVERS: ReadonlySet<string> = new Set<TargetDriver>([
  'external',
  'ref:coordinated',
  'ref:naive',
  'ref:reflex',
  'ref:null',
  'ref:silver',
  'ref:robust',
  'ref:credulous',
  'ref:house',
]);

/** The RunSpec target URL an in-process reference run records (`agent-arena run --target ref:…`). */
export const IN_PROCESS_TARGET_PREFIX = 'http://in-process.invalid/';

/**
 * G-33: the record's target driver disagrees with the one the RunSpec implies.
 * A record must never choose between "replay the target seat from the record"
 * (external) and "regenerate it from a reference policy" (ref:*): that choice
 * is seat provenance (ADR-004) and comes from the RunSpec.
 */
export class RedriveDriverMismatchError extends Error {
  readonly code = 'EREDRIVE_DRIVER_MISMATCH';
  constructor(
    readonly expected: TargetDriver,
    readonly recorded: TargetDriver | null,
  ) {
    super(
      recorded === null
        ? `redrive: the RunSpec implies target driver ${expected}, but the record has no target seat descriptor`
        : `redrive: the RunSpec implies target driver ${expected}, but the record's target seat says ${recorded} (the record cannot choose which seats are regenerated)`,
    );
    this.name = 'RedriveDriverMismatchError';
  }
}

/**
 * The target driver a RunSpec implies (G-33): `external` for any real target
 * URL; the reference named in `http://in-process.invalid/<ref>` for an
 * in-process run. Anything else under that host is refused. Pass the RunSpec's
 * `target` block, never a record field.
 */
export function targetDriverFromRunSpecTarget(target: { url?: unknown } | null | undefined): TargetDriver {
  const url = typeof target?.url === 'string' ? target.url : '';
  if (!url.startsWith(IN_PROCESS_TARGET_PREFIX)) return 'external';
  const ref = url.slice(IN_PROCESS_TARGET_PREFIX.length);
  if (ref === 'external' || !TARGET_DRIVERS.has(ref)) fail(`the RunSpec names an unknown in-process reference ${ref.slice(0, 40)}`);
  return ref as TargetDriver;
}

export interface RedriveOptions {
  /** Called once per target decision with what the seat saw and what was applied. */
  onDecision?: (d: DecisionTrace) => void;
  /**
   * G-33: the target driver the RunSpec implies (`targetDriverFromRunSpecTarget(spec.target)`),
   * NEVER derived from the record. When set, the record must have a target seat descriptor
   * whose driver equals it, or redrive throws `RedriveDriverMismatchError` before simulating.
   * `verify`'s rerun must always pass it; omitting it keeps the pre-G-33 behaviour (the
   * driver is taken from the record), which is only safe for records the caller produced.
   */
  expectedTargetDriver?: TargetDriver;
}

export function redrive(rec: EpisodeRecord, opts?: RedriveOptions | ((d: DecisionTrace) => void)): Scenario {
  const o: RedriveOptions = typeof opts === 'function' ? { onDecision: opts } : (opts ?? {});
  const onDecision = o.onDecision;
  if (o.expectedTargetDriver !== undefined) {
    if (!TARGET_DRIVERS.has(o.expectedTargetDriver)) fail(`unknown expected target driver ${String(o.expectedTargetDriver).slice(0, 40)}`);
    const hasTarget = Array.isArray(rec.seats) && rec.seats.some((s) => s.role === 'target');
    if (!hasTarget) throw new RedriveDriverMismatchError(o.expectedTargetDriver, null);
    const recorded = targetDriverOf(rec);
    if (recorded !== o.expectedTargetDriver) throw new RedriveDriverMismatchError(o.expectedTargetDriver, recorded);
  }
  const scn = createScenario(rec.scenarioId);
  const driver = targetDriverOf(rec);
  if (rec.scenarioId === 'diplomacy_standard') {
    const d = rec.diplomacy;
    if (!d) fail('a diplomacy_standard record needs its diplomacy block (the table spec)');
    scn.init(rec.seed, rec.tier, {
      mode: 'power',
      targetSeat: d.seatRequest,
      targetDriver: driver,
      blindingKey: rec.blindingKey,
      diplomacy: { fill: d.fill, horizonYear: d.horizonYear, secret: d.episodeSecret },
      ...(rec.engineCommit !== undefined ? { engineCommit: rec.engineCommit } : {}),
    });
  } else {
    scn.init(rec.seed, rec.tier, {
      mode: rec.mode,
      ...(rec.mode === 'squad' ? {} : { targetSeat: rec.targetSeat }),
      ...(rec.mode === 'member' && rec.fill ? { fill: rec.fill } : {}),
      targetDriver: driver,
      blindingKey: rec.blindingKey,
      ...(rec.engineCommit !== undefined ? { engineCommit: rec.engineCommit } : {}),
    });
  }
  const byTick = new Map<number, TimingEntry[]>();
  for (const e of rec.timing) {
    if (!isObj(e) || !Number.isInteger(e.tick)) fail('malformed timing entry');
    const list = byTick.get(e.tick) ?? [];
    list.push(e);
    byTick.set(e.tick, list);
  }
  const seat = scn.targetSeats()[0];
  for (let guard = 0; !scn.terminal(); guard++) {
    if (guard > TICK_CAP) fail('no terminal within the tick cap');
    const t = scn.currentTick();
    if (t >= rec.inputs.length) fail(`the record ends at tick ${rec.inputs.length} but the regenerated episode is still running`);
    const observation = onDecision ? scn.observe(seat) : undefined;
    let trace: DecisionTrace | undefined;
    if (driver === 'external') {
      const entries = byTick.get(t) ?? [];
      let lastReject: string | undefined;
      for (const e of entries) {
        if (e.event !== 'rejected') continue;
        if (e.reject === 'late_frame_dropped') {
          // act() drops a frame past Dh before parsing it; the payload is irrelevant.
          scn.act(seat, { kind: 'action', payload: {}, latencyMs: e.latencyMs, frameBytes: e.frameBytes });
        } else {
          scn.act(seat, { kind: 'rejected', reason: e.reject as Exclude<TimingEntry['reject'], 'late_frame_dropped' | undefined>, latencyMs: e.latencyMs, frameBytes: e.frameBytes });
        }
        lastReject = e.reject;
      }
      const d = entries.find((e) => e.event === 'decision');
      if (!d) fail(`no decision entry for tick ${t}`);
      let action: Record<string, unknown> | null = null;
      let ack: DecisionTrace['ack'];
      if (wasAccepted(d)) {
        const sub: Submission = { kind: 'action', payload: targetPayloadAt(rec, t), latencyMs: d.latencyMs, frameBytes: d.frameBytes };
        const r = scn.act(seat, sub);
        if (!r.accepted) fail(`tick ${t}: the recorded target action is not acceptable to the scenario (${r.reason ?? 'rejected'})`);
        action = sub.payload as Record<string, unknown>;
        ack = { status: 'accepted', ...(r.coercions.length ? { coercions: r.coercions.map((c) => ({ unit_id: c.unitId, reason: c.reason })) } : {}), ...(r.late ? { late: true } : {}) };
      } else {
        if (d.miss === 'soft') scn.act(seat, { kind: 'miss', severity: 'soft' });
        ack = lastReject ? { status: 'rejected', reason: lastReject } : { status: 'miss', reason: d.miss };
      }
      trace = { tick: t, seat, observation, action, ack };
    }
    scn.tick();
    if (onDecision) {
      // In-process reference target: no frame was exchanged; the applied inputs ARE its decision.
      trace ??= { tick: t, seat, observation, action: targetPayloadAt(rec, t), ack: { status: 'accepted' } };
      onDecision(trace);
    }
  }
  return scn;
}
