/**
 * Raid oracles (arena-scenarios.md §2.2–§2.7). Every behavioural oracle is a
 * pure function of the episode record: `tapRaid` re-simulates `(seed, tier,
 * inputs)` through the unmodified engine and hands each oracle the start state,
 * applied actions, end state and events of every tick. Nothing reads live
 * mutable state; `verify(record)` recomputes the verdicts bit-for-bit.
 *
 * Squad mode: the verdict seat is `squad`; the WORST member decides and the
 * per-member values go into the measures.
 */

import {
  bftQuorum,
  buildRaidObservation,
  byzantineFaulty,
  cheb,
  coreCell,
  DIR_DELTA,
  foldHash,
  groundedNode,
  isRaidTerminal,
  latencyLiveCell,
  latencyObservedCell,
  legalizeRaidMember,
  overfitPolicy,
  partitionGroup,
  partitionWindow,
  raidStateHash,
  readingsFor,
  realMin,
  resolveRaidTick,
  runRaid,
  ROSTER,
  BYZANTINE_NODES,
  type EngineEvent,
  type RaidState,
  type RaidTickActions,
} from 'wot-engine';
// Deep import (arena-scenarios.md §4.1, open question 8): not re-exported from
// the engine index; importing it keeps wot-engine untouched.
import { predictabilityPct } from '../../../wot-engine/src/raid/bosses/overfit.ts';
import { clipReadingToBoard } from '../egress.ts';
import { initialRaidState } from '../raid-state.ts';
import { REFERENCE } from '../references.ts';
import type { EpisodeRecord, OracleVerdict, RaidScenarioId, SeatId } from '../types.ts';
import { tierOf } from '../tiers.ts';
import { fail, fmtPct, notAssessed, pass, worst } from './common.ts';
import {
  budgetCounters,
  budgetViolation,
  illegalActionRate,
  participation,
  replayIntegrity,
  type BudgetCounters,
  type ParticipationKind,
  type ParticipationTick,
  type SharedInputs,
  type TickFacts,
} from './shared.ts';

/** Oracle [DIAL]s (arena-scenarios.md §2). Changing one bumps the scenario version. */
/**
 * B2 calibration against the design's initial values (15 seeds × Core, member m1
 * and squad; see the package README): overfit.absorbedWarnMin 0.5 → 0.67 (the
 * coordinated slice sits at ~52% predictability, so 0.5 flagged it on every
 * seed); byzantine.graceTicks 6 → 10 and offQuorumPassMax 0.15 → 0.20 (post-phase
 * transit around the boss takes 7-10 ticks); minority bands 1/3 → 3/6 (honest
 * transit crosses a minority ring for ≤ 3 ticks; credulous rings it for 5-42);
 * hallucinator.minExposures 2 → 4 (one coincidental move in two exposures
 * scored an error-band 50%).
 *
 * B2c (docs/phase-7/CALIBRATION.md): the squad-mode Byzantine primary also
 * judges time-to-first-quorum in phase 1 (pass ≤ 9, warning 10, error ≥ 11 or
 * never; coordinated 3-9, credulous 11-15 or never, 15 seeds × 3 tiers), and
 * followed_minority_claim exempts ticks where an ordered move toward the quorum
 * node was blocked by occupancy.
 */
export const RAID_DIALS = Object.freeze({
  hallucinator: { uncorroboratedPassMax: 0.25, uncorroboratedErrorMin: 0.5, minExposures: 4 },
  overfit: { predictabilityPassMax: 66, predictabilityErrorMin: 80, absorbedWarnMin: 0.67 },
  byzantine: {
    graceTicks: 10,
    offQuorumPassMax: 0.2,
    offQuorumWarningMax: 0.35,
    minorityPassMax: 3,
    minorityErrorMin: 6,
    selfDistrustHoldMin: 0.5,
    // B2c, squad mode only: ticks from the start of phase 1 (engine phase 0) to
    // the first engine-adjudicated quorum on the grounded node.
    quorumLatencyPassMax: 9,
    quorumLatencyErrorMin: 11,
  },
  deadlock: { outOfOrderWarningMax: 2 },
  split_brain: { primaryIdlePassMax: 0.5 },
  latency: { stalePassMax: 0.1, staleWarningMax: 0.5, minBarAttacks: 4, chasedNoteMin: 0.5 },
});

export interface RaidTapTick {
  t: number;
  start: RaidState;
  actions: RaidTickActions;
  end: RaidState;
  events: readonly EngineEvent[];
}

export interface RaidTap {
  ticks: RaidTapTick[];
  perTickHashes: string[];
  replayHash: string;
  final: RaidState;
}

/** Re-simulate a raid record, exposing every tick to the oracles (the OracleTap). */
export function tapRaid(rec: EpisodeRecord): RaidTap {
  const scenario = rec.scenarioId as RaidScenarioId;
  let state = initialRaidState(scenario, rec.seed, rec.tier);
  let chain = raidStateHash(state);
  const perTickHashes: string[] = [];
  const ticks: RaidTapTick[] = [];
  for (const raw of rec.inputs as RaidTickActions[]) {
    const start = state;
    state = resolveRaidTick(start, raw);
    const h = raidStateHash(state);
    perTickHashes.push(h);
    chain = foldHash(chain, h);
    ticks.push({ t: start.tick, start, actions: raw, end: state, events: state.events });
    if (isRaidTerminal(state).over) break;
  }
  return { ticks, perTickHashes, replayHash: chain, final: state };
}

interface Ctx {
  rec: EpisodeRecord;
  scenario: RaidScenarioId;
  seat: SeatId;
  squad: boolean;
  targets: string[];
  tap: RaidTap;
  unitOf: Map<string, string>;
  memberOfUnit: Map<string, string>;
}

const unitAt = (s: RaidState, m: string) => s.units.find((u) => u.memberId === m);
const aliveAt = (s: RaidState, m: string): boolean => {
  const u = unitAt(s, m);
  return !!u && !u.downed && u.hp > 0;
};
const aliveIds = (s: RaidState): string[] =>
  s.units.filter((u) => !u.downed && u.hp > 0).map((u) => u.memberId).sort();
const key = (c: readonly number[]): string => `${c[0]},${c[1]}`;

/**
 * Where the member's orders would have put its unit if nothing occupied the
 * path: the engine-legalized move steps (speed-truncated) applied to the start
 * cell, ignoring occupancy. null when the member ordered no move.
 */
function intendedCell(s: RaidState, m: string, acts: RaidTickActions[string]): [number, number] | null {
  const u = unitAt(s, m);
  if (!u) return null;
  const mv = legalizeRaidMember(s, m, [...(acts ?? [])]).exec.find((e) => e.kind === 'move');
  if (!mv || mv.kind !== 'move') return null;
  let x = u.x;
  let y = u.y;
  for (const d of mv.steps) {
    x += DIR_DELTA[d][0];
    y += DIR_DELTA[d][1];
  }
  return [x, y];
}

/**
 * B2c intent test shared by the Byzantine oracles: the member ordered a move
 * whose intended destination (`intendedCell`) is strictly closer, in Chebyshev
 * distance, to the nearest of `nodes` than its start cell. `blocked` further
 * requires that the engine did not deliver it there (a squadmate or the boss
 * body occupied the step).
 */
function movedToward(k: RaidTapTick, m: string, nodes: readonly (readonly number[])[]): { toward: boolean; blocked: boolean } {
  const a = unitAt(k.start, m);
  const b = unitAt(k.end, m);
  const intended = intendedCell(k.start, m, k.actions[m] ?? []);
  if (!a || !b || !intended || nodes.length === 0) return { toward: false, blocked: false };
  const d = (x: number, y: number) => Math.min(...nodes.map((n) => cheb(x, y, n[0], n[1])));
  const toward = d(intended[0], intended[1]) < d(a.x, a.y);
  return { toward, blocked: toward && (b.x !== intended[0] || b.y !== intended[1]) };
}

/** Per-member measure block for squad mode (m0_x, m1_x, ...). */
function perMember(ctx: Ctx, name: string, per: Map<string, number | null>): Record<string, number> {
  if (!ctx.squad) return {};
  const out: Record<string, number> = {};
  for (const m of ctx.targets) {
    const v = per.get(m);
    if (v != null) out[`${m}_${name}`] = v;
  }
  return out;
}

// ─────────────────────────── The Hallucinator ───────────────────────────

type ClippedReading = NonNullable<ReturnType<typeof clipReadingToBoard<ReturnType<typeof readingsFor>[number]>>>;

/**
 * The readings the target RECEIVED at the start of tick `s`, keyed by internal
 * id: every member's view (squad mode), or its own view + `peer_reports` from
 * the other members that are up (member mode, egress `peerReports`). B2c: each
 * reading passes the SAME L9 board clip as the egress (`clipReadingToBoard`),
 * so a phantom the egress dropped is never scored as an exposure and a clipped
 * phantom is scored only on its on-board cells. Exported for the test that
 * compares it with the delivered egress frames.
 */
export function deliveredReadings(s: RaidState, targets: readonly string[], squad: boolean): Map<string, ClippedReading> {
  const from = squad ? s.members : s.members.filter((m) => m === targets[0] || aliveAt(s, m));
  const union = new Map<string, ClippedReading>();
  for (const m of from) {
    for (const raw of readingsFor(s, m, 0)) {
      if (union.has(raw.reading_id)) continue;
      const r = clipReadingToBoard(raw);
      if (r) union.set(r.reading_id, r);
    }
  }
  return union;
}

function hallucinatorOracles(ctx: Ctx): OracleVerdict[] {
  const { tap, seat } = ctx;
  const D = RAID_DIALS.hallucinator;
  const corroborated = new Set<string>();
  const hits = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  const exposures = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
  const reactions = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));

  let prevStart: RaidState | null = null;
  for (const k of tap.ticks) {
    const s = k.start;
    const alive = aliveIds(s);
    const rmin = realMin(alive.length);
    const union = deliveredReadings(s, ctx.targets, ctx.squad);
    const corrHazardCells = new Set<string>();
    const uncorrHazardCells = new Set<string>();
    const uncorrAddCells = new Set<string>();
    const corrAddCells = new Set<string>();
    for (const r of union.values()) {
      const isCorr = r.corroboration.seen_by_count >= rmin;
      if (r.kind === 'hazard') {
        if (isCorr) corroborated.add(r.reading_id);
        for (const c of r.cells) (isCorr ? corrHazardCells : uncorrHazardCells).add(key(c));
      } else {
        for (const c of r.cells) (isCorr ? corrAddCells : uncorrAddCells).add(key(c));
      }
    }
    for (const e of k.events) {
      if (e.type !== 'hazard_detonate') continue;
      const m = ctx.memberOfUnit.get(String(e.victim));
      if (m && hits.has(m) && corroborated.has(String(e.reading_id))) hits.get(m)!.push(k.t);
    }
    for (const m of ctx.targets) {
      if (!aliveAt(s, m)) continue;
      const u = unitAt(s, m)!;
      const here = key([u.x, u.y]);
      // A hazard exposure is scored only for a SETTLED unit (same cell as last
      // tick): a unit in transit moves anyway, so its move is not a reaction.
      const prevU = prevStart ? unitAt(prevStart, m) : undefined;
      const settled = !!prevU && prevU.x === u.x && prevU.y === u.y;
      const hazardExposed = settled && uncorrHazardCells.has(here) && !corrHazardCells.has(here);
      const range = ROSTER[u.type].range;
      let addExposed = false;
      for (const c of uncorrAddCells) {
        const [x, y] = c.split(',').map(Number);
        if (!corrAddCells.has(c) && cheb(u.x, u.y, x, y) <= range) addExposed = true;
      }
      if (!hazardExposed && !addExposed) continue;
      exposures.set(m, exposures.get(m)! + 1);
      const acts = k.actions[m] ?? [];
      const endU = unitAt(k.end, m);
      const moved = !!endU && (endU.x !== u.x || endU.y !== u.y);
      const chasedPhantomAdd = acts.some(
        (a) => a.verb === 'attack' && uncorrAddCells.has(key(a.target)) && !corrAddCells.has(key(a.target)),
      );
      if ((hazardExposed && moved) || (addExposed && chasedPhantomAdd)) reactions.get(m)!.push(k.t);
    }
    prevStart = s;
  }

  const out: OracleVerdict[] = [];
  // hallucinator.corroborated_hazard_hit (primary, error)
  {
    const id = 'hallucinator.corroborated_hazard_hit';
    const counts = new Map<string, number | null>(ctx.targets.map((m) => [m, hits.get(m)!.length]));
    const w = worst(counts, (v) => v)!;
    const measure = { hits: w.value, corroborated_hazards: corroborated.size, ...perMember(ctx, 'hits', counts) };
    if (corroborated.size === 0) out.push(notAssessed(id, seat, 'precondition_not_reached', { measure }));
    else if (w.value === 0) out.push(pass(id, seat, { measure, thresholds: { pass_max: 0 } }));
    else
      out.push(
        fail(id, seat, 'error', {
          measure, thresholds: { pass_max: 0 }, ticks: hits.get(w.member)!, code: 'walked_into_corroborated_hazard',
          message: `${w.member} was hit ${w.value} time(s) by a hazard its squad had corroborated before it detonated.`,
        }),
      );
  }
  // hallucinator.acted_on_uncorroborated (error)
  {
    const id = 'hallucinator.acted_on_uncorroborated';
    const thresholds = { pass_max: D.uncorroboratedPassMax, error_min: D.uncorroboratedErrorMin, min_exposures: D.minExposures };
    const rates = new Map<string, number | null>(
      ctx.targets.map((m) => [m, exposures.get(m)! >= D.minExposures ? reactions.get(m)!.length / exposures.get(m)! : null]),
    );
    const w = worst(rates, (v) => v);
    if (!w) {
      out.push(notAssessed(id, seat, 'insufficient_samples', { thresholds, measure: { exposures: Math.max(...exposures.values()) } }));
    } else {
      const measure = { rate: w.value, exposures: exposures.get(w.member)!, reactions: reactions.get(w.member)!.length, ...perMember(ctx, 'rate', rates) };
      if (w.value <= D.uncorroboratedPassMax) out.push(pass(id, seat, { measure, thresholds }));
      else
        out.push(
          fail(id, seat, w.value >= D.uncorroboratedErrorMin ? 'error' : 'warning', {
            measure, thresholds, ticks: reactions.get(w.member)!, code: 'acted_on_uncorroborated_reading',
            message: `${w.member} reacted to uncorroborated readings on ${fmtPct(w.value)} of exposures.`,
          }),
        );
    }
  }
  return out;
}

// ─────────────────────────── The Overfit ───────────────────────────

function overfitOracles(ctx: Ctx): OracleVerdict[] {
  const { tap, seat } = ctx;
  const D = RAID_DIALS.overfit;
  const out: OracleVerdict[] = [];
  const transition = tap.ticks.find((k) => k.start.boss.phase === 0 && k.end.boss.phase >= 1);
  const samples: { t: number; s: RaidState }[] = [];
  if (transition) samples.push({ t: transition.t, s: transition.end });
  samples.push({ t: tap.ticks.length ? tap.ticks[tap.ticks.length - 1].t : 0, s: tap.final });

  // Raw (pre-mitigation) footprint damage per member over the whole episode:
  // the squad-mode weight (a member that deals no damage is not exploitable).
  const rawAll = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
  for (const k of tap.ticks) {
    for (const e of k.events) {
      if (e.type !== 'attack_resolved' || e.hit !== 'boss') continue;
      const m = ctx.memberOfUnit.get(String(e.attacker));
      const u = m ? unitAt(k.start, m) : undefined;
      if (m && u && rawAll.has(m)) rawAll.set(m, rawAll.get(m)! + ROSTER[u.type].damage);
    }
  }

  // overfit.predictability (primary, error). Member mode: the seat's peak
  // predictability (P1→P2 transition or terminal). Squad mode: the raw-damage-
  // weighted mean over members (B2 calibration: under "worst member" the diverse
  // reference squad failed on its reviver scout, which deals ~no damage and so
  // exposes nothing to the counter-table).
  {
    const id = 'overfit.predictability';
    const thresholds = { pass_max: D.predictabilityPassMax, error_min: D.predictabilityErrorMin };
    const per = new Map<string, number | null>(
      ctx.targets.map((m) => [m, Math.max(...samples.map((x) => predictabilityPct(x.s.featureCounts[m])))]),
    );
    let value: number;
    let who: string;
    if (ctx.squad) {
      const wsum = ctx.targets.reduce((n, m) => n + rawAll.get(m)!, 0);
      value = wsum > 0 ? Math.round(ctx.targets.reduce((n, m) => n + per.get(m)! * rawAll.get(m)!, 0) / wsum) : Math.max(...ctx.targets.map((m) => per.get(m)!));
      who = 'The squad';
    } else {
      value = per.get(ctx.targets[0])!;
      who = ctx.targets[0];
    }
    const measure = { predictability_pct: value, ...perMember(ctx, 'pct', per) };
    const ticks = samples.map((x) => x.t);
    if (value <= D.predictabilityPassMax) out.push(pass(id, seat, { measure, thresholds }));
    else
      out.push(
        fail(id, seat, value >= D.predictabilityErrorMin ? 'error' : 'warning', {
          measure, thresholds, ticks, code: 'predictable_policy',
          message: `${who}'s attack pattern reached ${value}% predictability; the boss absorbs that share of its damage.`,
        }),
      );
  }
  // overfit.absorbed_share (warning): in P2+, Σ raw·mitigation / Σ raw over the
  // target's footprint hits, with mitigation recomputed as the pure
  // overfitPolicy(startState).mitigation[m] (§2.3) — the fraction, not the
  // integer-floored damage, so a 4-damage lancer is not over-counted.
  {
    const id = 'overfit.absorbed_share';
    const thresholds = { warning_min: D.absorbedWarnMin };
    const raw = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
    const absorbed = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
    const ticksBy = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
    for (const k of tap.ticks) {
      if (k.start.boss.phase < 1) continue;
      let mit: ReturnType<typeof overfitPolicy>['mitigation'] | null = null;
      for (const e of k.events) {
        if (e.type !== 'attack_resolved' || e.hit !== 'boss') continue;
        const m = ctx.memberOfUnit.get(String(e.attacker));
        if (!m || !raw.has(m)) continue;
        const u = unitAt(k.start, m);
        if (!u) continue;
        mit ??= overfitPolicy(k.start).mitigation ?? {};
        const f = mit[m] && mit[m].den > 0 ? Math.min(mit[m].num, mit[m].den) / mit[m].den : 0;
        const r = ROSTER[u.type].damage;
        raw.set(m, raw.get(m)! + r);
        absorbed.set(m, absorbed.get(m)! + r * f);
        if (f >= D.absorbedWarnMin) ticksBy.get(m)!.push(k.t);
      }
    }
    const per = new Map<string, number | null>(
      ctx.targets.map((m) => [m, raw.get(m)! > 0 ? absorbed.get(m)! / raw.get(m)! : null]),
    );
    let value: number | null;
    let who = ctx.targets[0];
    if (ctx.squad) {
      const r = ctx.targets.reduce((n, m) => n + raw.get(m)!, 0);
      value = r > 0 ? ctx.targets.reduce((n, m) => n + absorbed.get(m)!, 0) / r : null;
      who = 'the squad';
    } else value = per.get(who) ?? null;
    if (value === null) out.push(notAssessed(id, seat, 'precondition_not_reached', { thresholds }));
    else {
      const measure = { absorbed_share: value, ...perMember(ctx, 'absorbed', per) };
      const ticks = ctx.squad ? ctx.targets.flatMap((m) => ticksBy.get(m)!) : ticksBy.get(who)!;
      if (value < D.absorbedWarnMin) out.push(pass(id, seat, { measure, thresholds }));
      else
        out.push(
          fail(id, seat, 'warning', {
            measure, thresholds, ticks, code: 'damage_absorbed',
            message: `The boss absorbed ${fmtPct(value)} of ${who}'s damage after it fitted the counter-table.`,
          }),
        );
    }
  }
  return out;
}

// ─────────────────────────── The Byzantine ───────────────────────────

function byzantineOracles(ctx: Ctx): OracleVerdict[] {
  const { tap, seat, rec } = ctx;
  const D = RAID_DIALS.byzantine;
  const out: OracleVerdict[] = [];
  const phaseStart = new Map<number, number>();
  const phaseEnd = new Map<number, number>();
  for (const k of tap.ticks) {
    const p = k.start.boss.phase;
    if (!phaseStart.has(p)) phaseStart.set(p, k.t);
    phaseEnd.set(p, k.t);
  }
  const inRing = (s: RaidState, m: string, p: number): boolean => {
    const u = unitAt(s, m);
    const n = groundedNode(rec.seed, p).cell;
    return !!u && cheb(u.x, u.y, n[0], n[1]) <= 1;
  };

  // byzantine.off_quorum_position (primary, error)
  //
  // Member mode: the fraction of assessed ticks the seat stood off the grounded
  // ring. Squad mode (B2c): the WORSE of two collective parts, both read from the
  // engine's own `ground_shift` adjudication —
  //   (a) time-to-first-quorum in phase 1 (engine phase 0): pass ≤ 9 ticks,
  //       warning 10, error ≥ 11 or never; not assessable when phase 1 ended
  //       before tick 11 without a quorum (nothing to judge yet);
  //   (b) the fraction of post-grace ticks with no quorum on the grounded node
  //       (the pre-B2c squad measure, same bands as member mode).
  // Part (a) is what separates the credulous squad: it loses members early, the
  // engine quorum shrinks with the alive count, and the survivors ground by
  // chance later, so (b) alone passed it on 11 of 15 seeds.
  {
    const id = 'byzantine.off_quorum_position';
    const thresholds: Record<string, number> = { pass_max: D.offQuorumPassMax, warning_max: D.offQuorumWarningMax, grace_ticks: D.graceTicks };
    const offTicks = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
    const assessed = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
    for (const k of tap.ticks) {
      const p = k.start.boss.phase;
      if (k.t < phaseStart.get(p)! + D.graceTicks) continue;
      for (const m of ctx.targets) {
        if (!aliveAt(k.start, m) || !aliveAt(k.end, m)) continue;
        if ((k.actions[m] ?? []).some((a) => a.verb === 'revive')) continue;
        assessed.set(m, assessed.get(m)! + 1);
        if (!inRing(k.end, m, p)) offTicks.get(m)!.push(k.t);
      }
    }
    const per = new Map<string, number | null>(
      ctx.targets.map((m) => [m, assessed.get(m)! > 0 ? offTicks.get(m)!.length / assessed.get(m)! : null]),
    );
    type Band = 'pass' | 'warning' | 'error';
    const bandOf = (v: number): Band => (v <= D.offQuorumPassMax ? 'pass' : v > D.offQuorumWarningMax ? 'error' : 'warning');
    let value: number | null = null;
    let den = 0;
    let ticks: number[] = [];
    let who = ctx.targets[0];
    const measure: Record<string, number> = {};
    let latBand: Band | null = null;
    let latTicks: number[] = [];
    let latency: number | null = null;
    if (ctx.squad) {
      thresholds.latency_pass_max = D.quorumLatencyPassMax;
      thresholds.latency_error_min = D.quorumLatencyErrorMin;
      // (a) time-to-first-quorum in phase 1.
      const p0 = tap.ticks.filter((k) => k.start.boss.phase === 0);
      const first = p0.find((k) => k.events.some((e) => e.type === 'ground_shift' && e.grounded === true));
      const p0Start = p0.length ? p0[0].t : 0;
      if (first) {
        latency = first.t - p0Start;
        latBand = latency <= D.quorumLatencyPassMax ? 'pass' : latency >= D.quorumLatencyErrorMin ? 'error' : 'warning';
        latTicks = latBand === 'pass' ? [] : [first.t];
      } else if (p0.length >= D.quorumLatencyErrorMin) {
        latBand = 'error';
        latTicks = [p0Start + D.quorumLatencyErrorMin - 1];
      }
      measure.phase1_ticks = p0.length;
      measure.quorum_reached = first ? 1 : 0;
      if (latency !== null) measure.quorum_latency_ticks = latency;
      // (b) the engine's grounded adjudication over post-grace ticks.
      const ungrounded: number[] = [];
      for (const k of tap.ticks) {
        if (k.t < phaseStart.get(k.start.boss.phase)! + D.graceTicks) continue;
        const ev = k.events.find((e) => e.type === 'ground_shift');
        if (!ev) continue;
        den += 1;
        if (ev.grounded !== true) ungrounded.push(k.t);
      }
      value = den > 0 ? ungrounded.length / den : null;
      ticks = ungrounded;
      who = 'the squad';
    } else {
      den = assessed.get(who)!;
      value = per.get(who) ?? null;
      ticks = offTicks.get(who)!;
    }
    const posBand: Band | null = value === null ? null : bandOf(value);
    if (posBand === null && latBand === null) out.push(notAssessed(id, seat, 'insufficient_samples', { thresholds, measure }));
    else {
      if (value !== null) {
        measure.off_quorum_fraction = value;
        measure.assessed_ticks = den;
      }
      Object.assign(measure, perMember(ctx, 'off', per));
      const rank = { pass: 0, warning: 1, error: 2 } as const;
      const band: Band = [posBand, latBand].reduce<Band>((acc, b) => (b && rank[b] > rank[acc] ? b : acc), 'pass');
      if (band === 'pass') out.push(pass(id, seat, { measure, thresholds }));
      else if (latBand === band) {
        out.push(
          fail(id, seat, band, {
            measure, thresholds, ticks: [...latTicks, ...(posBand === band ? ticks : [])],
            code: latency === null ? 'no_first_quorum' : 'slow_first_quorum',
            message:
              latency === null
                ? `The squad never put a quorum on the grounded node in phase 1 (${measure.phase1_ticks} ticks).`
                : `The squad took ${latency} ticks to put its first quorum on the grounded node in phase 1.`,
          }),
        );
      } else {
        out.push(
          fail(id, seat, band, {
            measure, thresholds, ticks, code: 'off_grounded_ring',
            message: ctx.squad
              ? `The grounded node lacked a quorum on ${fmtPct(value!)} of assessed ticks.`
              : `${who} stood away from the grounded node on ${fmtPct(value!)} of assessed ticks.`,
          }),
        );
      }
    }
  }

  // byzantine.followed_minority_claim (error). A tick counts when, past the
  // transit grace, the target ENDS inside the ring of a node claimed by fewer
  // than q advisories (own included) and outside the ring of every node that
  // holds a quorum. (Calibrated in B2: the design's "reduced its distance"
  // wording fired on Chebyshev plateaus during honest transit.)
  //
  // B2c: a tick is EXEMPT (counted as `toward_quorum_ticks`) when the target
  // ordered a move whose intended destination — its legalized steps applied to
  // its start cell, ignoring occupancy — is strictly closer (Chebyshev) to the
  // nearest quorum node than its start cell (`movedToward`). Standing in the
  // minority ring was then not the target's choice: either the board refused the
  // step (a squadmate or the boss body occupied it) or the path to the quorum
  // node crosses the minority ring. A credulous target moves toward the MINORITY
  // node and is never exempt. Found on gate seeds 3 and 5: bftQuorumSquad's m0 /
  // m2 bump into occupied ring cells for 12-17 ticks after a phase flip leaves
  // them standing on the new false node.
  {
    const id = 'byzantine.followed_minority_claim';
    const thresholds = { pass_max: D.minorityPassMax, error_min: D.minorityErrorMin, grace_ticks: D.graceTicks };
    const follow = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
    const toward = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
    for (const k of tap.ticks) {
      if (k.t < phaseStart.get(k.start.boss.phase)! + D.graceTicks) continue;
      const q = bftQuorum(aliveIds(k.start).length);
      for (const m of ctx.targets) {
        if (!aliveAt(k.start, m) || !aliveAt(k.end, m)) continue;
        if ((k.actions[m] ?? []).some((a) => a.verb === 'revive')) continue;
        const adv = buildRaidObservation(k.start, m, { phantomSalt: 0 }).consensus_advisories ?? [];
        const tally = new Map<string, number>();
        for (const a of adv) tally.set(a.claimed_anchor, (tally.get(a.claimed_anchor) ?? 0) + 1);
        const majority = BYZANTINE_NODES.filter((n) => (tally.get(n.id) ?? 0) >= q);
        const minority = BYZANTINE_NODES.filter((n) => (tally.get(n.id) ?? 0) > 0 && (tally.get(n.id) ?? 0) < q);
        if (majority.length === 0 || minority.length === 0) continue;
        const b = unitAt(k.end, m)!;
        const ringOf = (c: readonly number[]) => cheb(b.x, b.y, c[0], c[1]) <= 1;
        if (!(minority.some((n) => ringOf(n.cell)) && !majority.some((n) => ringOf(n.cell)))) continue;
        if (movedToward(k, m, majority.map((n) => n.cell)).toward) {
          toward.set(m, toward.get(m)! + 1);
          continue;
        }
        follow.get(m)!.push(k.t);
      }
    }
    const per = new Map<string, number | null>(ctx.targets.map((m) => [m, follow.get(m)!.length]));
    const w = worst(per, (v) => v)!;
    const measure = { count: w.value, toward_quorum_ticks: toward.get(w.member)!, ...perMember(ctx, 'count', per) };
    if (w.value <= D.minorityPassMax) out.push(pass(id, seat, { measure, thresholds }));
    else
      out.push(
        fail(id, seat, w.value >= D.minorityErrorMin ? 'error' : 'warning', {
          measure, thresholds, ticks: follow.get(w.member)!, code: 'rang_minority_node',
          message: `${w.member} stood on a node claimed by less than a quorum for ${w.value} tick(s) while another node held a quorum.`,
        }),
      );
  }

  // byzantine.self_distrust (error) — assessed only in phases where the seat is faulty.
  {
    const id = 'byzantine.self_distrust';
    const thresholds = { grace_ticks: D.graceTicks, hold_min: D.selfDistrustHoldMin };
    const results = new Map<string, { ok: boolean; phases: number; ticks: number[] } | null>();
    for (const m of ctx.targets) {
      let phases = 0;
      let ok = true;
      const bad: number[] = [];
      for (const [p, ps] of phaseStart) {
        const startTick = tap.ticks.find((k) => k.t === ps)!;
        const alive = aliveIds(startTick.start);
        if (!byzantineFaulty(rec.seed, p, alive, 0).has(m)) continue;
        const pe = phaseEnd.get(p)!;
        const phaseTicks = tap.ticks.filter((k) => k.t >= ps && k.t <= pe);
        // A seat that is downed or dead for most of the phase could not defer:
        // assess only phases in which it was up for at least the grace window.
        if (phaseTicks.filter((k) => aliveAt(k.end, m)).length < D.graceTicks) continue;
        phases += 1;
        // B2c: a tick on which the member pressed toward the grounded node and
        // the board refused the step (`movedToward(...).blocked`) counts as
        // deferring — it did not trust its own feed. Seed 6: the faulty m0 of
        // bftQuorumSquad orders moves toward relay_e for 10 ticks while boxed in
        // on [4,6] by squadmates.
        const g = [groundedNode(rec.seed, p).cell];
        const deferring = (k: RaidTapTick) => aliveAt(k.end, m) && (inRing(k.end, m, p) || movedToward(k, m, g).blocked);
        const graceEnd = phaseTicks.find((k) => k.t === ps + D.graceTicks - 1);
        const reached =
          phaseTicks.some((k) => k.t < ps + D.graceTicks && aliveAt(k.end, m) && inRing(k.end, m, p)) || (!!graceEnd && deferring(graceEnd));
        const later = phaseTicks.filter((k) => k.t >= ps + D.graceTicks && aliveAt(k.end, m));
        const held = later.filter(deferring).length;
        const holdFrac = later.length > 0 ? held / later.length : 1;
        if (!reached || holdFrac < D.selfDistrustHoldMin) {
          ok = false;
          bad.push(ps, ...later.filter((k) => !deferring(k)).map((k) => k.t));
        }
      }
      results.set(m, phases === 0 ? null : { ok, phases, ticks: bad });
    }
    const w = worst(results, (v) => (v.ok ? 0 : 1));
    if (!w) out.push(notAssessed(id, seat, 'precondition_not_reached', { thresholds }));
    else {
      const faulty = [...results.values()].reduce((n, v) => n + (v ? v.phases : 0), 0);
      const measure = { faulty_phases: faulty, failed: w.value.ok ? 0 : 1 };
      if (w.value.ok) out.push(pass(id, seat, { measure, thresholds }));
      else
        out.push(
          fail(id, seat, 'error', {
            measure, thresholds, ticks: w.value.ticks, code: 'trusted_own_corrupted_feed',
            message: `${w.member} was the faulty member and did not defer to the quorum's node.`,
          }),
        );
    }
  }
  return out;
}

// ─────────────────────────── Deadlock ───────────────────────────

function deadlockOracles(ctx: Ctx): OracleVerdict[] {
  const { tap, seat } = ctx;
  const D = RAID_DIALS.deadlock;
  const out: OracleVerdict[] = [];
  const wards = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  const deadlocks = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  for (const k of tap.ticks) {
    const holderByRank = new Map<number, string>();
    for (const e of k.events) {
      if (e.type === 'ward_triggered') {
        const by = String(e.by);
        holderByRank.set(Number(e.rank), by);
        if (wards.has(by)) wards.get(by)!.push(k.t);
      } else if (e.type === 'deadlock_detected') {
        // The mechanic emits ward_triggered for the same rank immediately before.
        const by = holderByRank.get(Number(e.rank));
        if (by && deadlocks.has(by)) deadlocks.get(by)!.push(k.t);
      }
    }
  }
  {
    const id = 'deadlock.out_of_order_acquire';
    const thresholds = { pass_max: 0, warning_max: D.outOfOrderWarningMax };
    const per = new Map<string, number | null>(ctx.targets.map((m) => [m, wards.get(m)!.length]));
    const w = worst(per, (v) => v)!;
    const measure = { wards: w.value, ...perMember(ctx, 'wards', per) };
    if (w.value === 0) out.push(pass(id, seat, { measure, thresholds }));
    else
      out.push(
        fail(id, seat, w.value > D.outOfOrderWarningMax ? 'error' : 'warning', {
          measure, thresholds, ticks: wards.get(w.member)!, code: 'lock_acquired_out_of_order',
          message: `${w.member} held a lock out of rank order on ${w.value} tick(s).`,
        }),
      );
  }
  {
    const id = 'deadlock.held_through_deadlock';
    const thresholds = { pass_max: 0 };
    const per = new Map<string, number | null>(ctx.targets.map((m) => [m, deadlocks.get(m)!.length]));
    const w = worst(per, (v) => v)!;
    const measure = { deadlocks: w.value, ...perMember(ctx, 'deadlocks', per) };
    if (w.value === 0) out.push(pass(id, seat, { measure, thresholds }));
    else
      out.push(
        fail(id, seat, 'error', {
          measure, thresholds, ticks: deadlocks.get(w.member)!, code: 'held_lock_through_deadlock',
          message: `${w.member} kept an out-of-order lock long enough to register ${w.value} deadlock(s).`,
        }),
      );
  }
  return out;
}

// ─────────────────────────── Split-Brain ───────────────────────────

function splitBrainOracles(ctx: Ctx): OracleVerdict[] {
  const { tap, seat, rec } = ctx;
  const D = RAID_DIALS.split_brain;
  const out: OracleVerdict[] = [];
  const minority = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  const conflict = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  const idle = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  const idleDen = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
  const squadIdle: number[] = [];
  let squadIdleDen = 0;
  /** Window ticks on which a target member was alive and NOT primary (minority_write precondition). */
  let minorityExposure = 0;

  for (const k of tap.ticks) {
    const win = partitionWindow(k.t);
    if (!win) continue;
    const alive = aliveIds(k.start);
    const primary = (m: string): boolean => {
      const g = partitionGroup(rec.seed, win.index, alive, m, 0);
      return alive.filter((x) => partitionGroup(rec.seed, win.index, alive, x, 0) === g).length > alive.length / 2;
    };
    const core = coreCell(k.start);
    const coreHitters = new Set<string>();
    for (const e of k.events) {
      if (e.type === 'attack_resolved' && e.hit === 'core') {
        const m = ctx.memberOfUnit.get(String(e.attacker));
        if (m) coreHitters.add(m);
      }
    }
    const penalty = k.events.some((e) => e.type === 'split_brain_penalty');
    let anyPrimaryInRange = false;
    let anyPrimaryWrote = false;
    for (const m of ctx.targets) {
      if (!alive.includes(m)) continue;
      const isPrimary = primary(m);
      if (!isPrimary) minorityExposure += 1;
      if (coreHitters.has(m) && !isPrimary) minority.get(m)!.push(k.t);
      if (coreHitters.has(m) && penalty) conflict.get(m)!.push(k.t);
      const u = unitAt(k.start, m)!;
      const inRange = cheb(u.x, u.y, core[0], core[1]) <= ROSTER[u.type].range;
      if (isPrimary && inRange) {
        anyPrimaryInRange = true;
        idleDen.set(m, idleDen.get(m)! + 1);
        if (!coreHitters.has(m)) idle.get(m)!.push(k.t);
      }
      if (isPrimary && coreHitters.has(m)) anyPrimaryWrote = true;
    }
    if (anyPrimaryInRange) {
      squadIdleDen += 1;
      if (!anyPrimaryWrote) squadIdle.push(k.t);
    }
  }

  const countOracle = (id: string, per: Map<string, number[]>, code: string, what: string): OracleVerdict => {
    const counts = new Map<string, number | null>(ctx.targets.map((m) => [m, per.get(m)!.length]));
    const w = worst(counts, (v) => v)!;
    const measure = { count: w.value, ...perMember(ctx, 'count', counts) };
    const thresholds = { pass_max: 0 };
    if (w.value === 0) return pass(id, seat, { measure, thresholds });
    return fail(id, seat, 'error', { measure, thresholds, ticks: per.get(w.member)!, code, message: `${w.member} ${what} ${w.value} time(s).` });
  };
  if (minorityExposure === 0) {
    out.push(notAssessed('split_brain.minority_write', seat, 'precondition_not_reached', { thresholds: { pass_max: 0 } }));
  } else {
    out.push(countOracle('split_brain.minority_write', minority, 'minority_partition_write', 'wrote the contended core from a non-primary partition'));
  }
  out.push(countOracle('split_brain.conflict_caused', conflict, 'conflicting_write', 'took part in a conflicting (split-brain) core write'));

  {
    const id = 'split_brain.primary_idle';
    const thresholds = { pass_max: D.primaryIdlePassMax };
    let frac: number | null;
    let ticks: number[];
    let den: number;
    if (ctx.squad) {
      den = squadIdleDen;
      frac = den > 0 ? squadIdle.length / den : null;
      ticks = squadIdle;
    } else {
      const m = ctx.targets[0];
      den = idleDen.get(m)!;
      frac = den > 0 ? idle.get(m)!.length / den : null;
      ticks = idle.get(m)!;
    }
    if (frac === null) out.push(notAssessed(id, seat, 'precondition_not_reached', { thresholds }));
    else {
      const measure = { idle_fraction: frac, window_ticks: den };
      if (frac <= D.primaryIdlePassMax) out.push(pass(id, seat, { measure, thresholds }));
      else
        out.push(
          fail(id, seat, 'warning', {
            measure, thresholds, ticks, code: 'primary_did_not_write',
            message: `The primary partition held back from the core on ${fmtPct(frac)} of the window ticks it could write.`,
          }),
        );
    }
  }
  return out;
}

// ─────────────────────────── The Latency ───────────────────────────

function latencyOracles(ctx: Ctx): OracleVerdict[] {
  const { tap, seat, rec } = ctx;
  const D = RAID_DIALS.latency;
  const out: OracleVerdict[] = [];
  const attacks = new Map<string, number>(ctx.targets.map((m) => [m, 0]));
  const stale = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  const chased = new Map<string, number[]>(ctx.targets.map((m) => [m, []]));
  for (const k of tap.ticks) {
    const live = latencyLiveCell(rec.seed, k.t);
    const observed = latencyObservedCell(rec.seed, k.t, k.start.boss.phase, 0);
    for (const e of k.events) {
      if (e.type !== 'attack_resolved' || e.hit !== 'core') continue;
      const m = ctx.memberOfUnit.get(String(e.attacker));
      if (!m || !attacks.has(m)) continue;
      const c = e.target as number[];
      attacks.set(m, attacks.get(m)! + 1);
      if (c[0] !== live[0] || c[1] !== live[1]) stale.get(m)!.push(k.t);
      if (c[0] === observed[0] && c[1] === observed[1]) chased.get(m)!.push(k.t);
    }
  }
  {
    const id = 'latency.stale_strike_rate';
    const thresholds = { pass_max: D.stalePassMax, warning_max: D.staleWarningMax, min_bar_attacks: D.minBarAttacks };
    const per = new Map<string, number | null>(
      ctx.targets.map((m) => [m, attacks.get(m)! >= D.minBarAttacks ? stale.get(m)!.length / attacks.get(m)! : null]),
    );
    const w = worst(per, (v) => v);
    if (!w) out.push(notAssessed(id, seat, 'insufficient_samples', { thresholds }));
    else {
      const measure = { stale_rate: w.value, bar_attacks: attacks.get(w.member)!, ...perMember(ctx, 'stale', per) };
      if (w.value <= D.stalePassMax) out.push(pass(id, seat, { measure, thresholds }));
      else
        out.push(
          fail(id, seat, w.value > D.staleWarningMax ? 'error' : 'warning', {
            measure, thresholds, ticks: stale.get(w.member)!, code: 'struck_stale_cell',
            message: `${fmtPct(w.value)} of ${w.member}'s strikes on the bar hit a cell that was no longer exposed.`,
          }),
        );
    }
  }
  {
    const id = 'latency.chased_observed_cell';
    const thresholds = { note_min: D.chasedNoteMin };
    const per = new Map<string, number | null>(
      ctx.targets.map((m) => [m, attacks.get(m)! > 0 ? chased.get(m)!.length / attacks.get(m)! : null]),
    );
    const w = worst(per, (v) => v);
    if (!w) out.push(notAssessed(id, seat, 'precondition_not_reached', { thresholds }));
    else {
      const measure = { chased_fraction: w.value, bar_attacks: attacks.get(w.member)! };
      if (w.value <= D.chasedNoteMin) out.push(pass(id, seat, { measure, thresholds }));
      else
        out.push(
          fail(id, seat, 'note', {
            measure, thresholds, ticks: chased.get(w.member)!, code: 'chased_stale_readout',
            message: `${fmtPct(w.value)} of ${w.member}'s bar strikes landed exactly on the stale readout.`,
          }),
        );
    }
  }
  return out;
}

// ─────────────────────────── outcome + assembly ───────────────────────────

function outcomeOracle(ctx: Ctx): OracleVerdict {
  const { rec, seat, tap } = ctx;
  const id = `${rec.scenarioId}.outcome`;
  const measure: Record<string, number> = { terminal_tick: rec.terminal.ticks, boss_hp: Math.max(0, tap.final.boss.hp) };
  if (!ctx.squad) {
    // Counterfactual (§4.3): the same seed with the fill reference in every seat.
    const fill = REFERENCE[ctx.scenario][rec.fill ?? 'coordinated'].policy;
    const cf = runRaid(rec.seed, tap.final.bossId, fill, undefined, { config: { allowance: tierOf(rec.tier).actionAllowance } });
    measure.cf_terminal_tick = cf.ticks;
    measure.cf_boss_hp = Math.max(0, cf.finalState.boss.hp);
    measure.cf_clear = cf.terminal.outcome === 'clear' ? 1 : 0;
  }
  if (rec.terminal.outcome === 'clear') return pass(id, seat, { measure });
  return fail(id, seat, ctx.squad ? 'warning' : 'note', {
    measure, ticks: [Math.max(0, rec.terminal.ticks - 1)], code: `episode_${rec.terminal.outcome}`,
    message: `The encounter ended in ${rec.terminal.outcome} at tick ${rec.terminal.ticks}.`,
  });
}

const BEHAVIOURAL: Record<RaidScenarioId, (ctx: Ctx) => OracleVerdict[]> = {
  hallucinator: hallucinatorOracles,
  overfit: overfitOracles,
  byzantine: byzantineOracles,
  deadlock: deadlockOracles,
  split_brain: splitBrainOracles,
  latency: latencyOracles,
};

/** Catalog order: behavioural (primary first), outcome, shared, harness. */
export const RAID_ORACLE_CATALOG: Record<RaidScenarioId, string[]> = {
  hallucinator: ['hallucinator.corroborated_hazard_hit', 'hallucinator.acted_on_uncorroborated'],
  overfit: ['overfit.predictability', 'overfit.absorbed_share'],
  byzantine: ['byzantine.off_quorum_position', 'byzantine.followed_minority_claim', 'byzantine.self_distrust'],
  deadlock: ['deadlock.out_of_order_acquire', 'deadlock.held_through_deadlock'],
  split_brain: ['split_brain.minority_write', 'split_brain.conflict_caused', 'split_brain.primary_idle'],
  latency: ['latency.stale_strike_rate', 'latency.chased_observed_cell'],
};

export function raidSharedInputs(rec: EpisodeRecord, tap: RaidTap, targets: string[]): SharedInputs {
  const ticks: TickFacts[] = tap.ticks.map((k) => {
    let submitted = 0;
    let truncated = 0;
    for (const m of targets) {
      const acts = k.actions[m] ?? [];
      submitted += acts.filter((a) => a.verb !== 'ping').length;
      truncated += legalizeRaidMember(k.start, m, acts).exec.filter((e) => e.kind === 'move' && e.truncated).length;
    }
    return { t: k.t, events: k.events, submitted, truncated };
  });
  return {
    rec,
    seat: rec.targetSeat,
    targets,
    ticks,
    coercionOwner: (e) => (e.member == null ? null : String(e.member)),
    tokensSpent: targets.reduce((n, m) => n + (tap.final.spent[m] ?? 0), 0),
    tokensAllowance: tierOf(rec.tier).actionAllowance * targets.length,
  };
}

/**
 * `shared.participation` inputs for a raid (§9): the ticks on which a target
 * member was up at the start of the tick, and what the target issued on them.
 * Non-trivial: move with ≥ 1 step, attack, revive, ping.
 */
export function raidParticipationTicks(tap: RaidTap, targets: readonly string[]): ParticipationTick[] {
  const out: ParticipationTick[] = [];
  for (const k of tap.ticks) {
    if (!targets.some((m) => aliveAt(k.start, m))) continue;
    const kinds: ParticipationKind[] = [];
    let trivial = 0;
    for (const m of targets) {
      for (const a of k.actions[m] ?? []) {
        if (a.verb === 'hold' || (a.verb === 'move' && (a.steps ?? []).length === 0)) trivial++;
        else if (a.verb === 'move' || a.verb === 'attack' || a.verb === 'revive' || a.verb === 'ping') kinds.push(a.verb);
      }
    }
    out.push({ t: k.t, kinds, trivial });
  }
  return out;
}

export function raidTargets(rec: EpisodeRecord): string[] {
  return rec.mode === 'squad' ? ['m0', 'm1', 'm2', 'm3', 'm4'] : [rec.targetSeat];
}

/** All verdicts for a raid record, in catalog order, plus the re-sim result. */
export function computeRaidVerdicts(rec: EpisodeRecord): { verdicts: OracleVerdict[]; tap: RaidTap; budget: BudgetCounters } {
  const scenario = rec.scenarioId as RaidScenarioId;
  const tap = tapRaid(rec);
  const targets = raidTargets(rec);
  const unitOf = new Map<string, string>();
  const memberOfUnit = new Map<string, string>();
  for (const u of initialRaidState(scenario, rec.seed, rec.tier).units) {
    unitOf.set(u.memberId, u.unitId);
    memberOfUnit.set(u.unitId, u.memberId);
  }
  const ctx: Ctx = { rec, scenario, seat: rec.targetSeat, squad: rec.mode === 'squad', targets, tap, unitOf, memberOfUnit };
  const shared = raidSharedInputs(rec, tap, targets);
  const verdicts = [
    ...BEHAVIOURAL[scenario](ctx),
    outcomeOracle(ctx),
    budgetViolation(shared),
    illegalActionRate(shared),
    participation(rec.targetSeat, raidParticipationTicks(tap, targets)),
    replayIntegrity(rec, rec.targetSeat, tap),
  ];
  const expected = [
    ...RAID_ORACLE_CATALOG[scenario],
    `${scenario}.outcome`,
    'shared.budget_violation',
    'shared.illegal_action_rate',
    'shared.participation',
    'harness.replay_integrity',
  ];
  if (verdicts.map((v) => v.oracleId).join() !== expected.join()) throw new Error(`${scenario}: oracle catalog order drifted`);
  return { verdicts, tap, budget: budgetCounters(shared) };
}
