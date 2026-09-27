/**
 * `RaidScenario` — the six failure-mode encounters as evaluations
 * (arena-scenarios.md §2.2–§2.7, §4.2) over the UNMODIFIED raid engine.
 *
 * Seating:
 *   squad   the target controls m0..m4 and receives five egress views per tick;
 *   member  the target controls one seat (default m1); the other four are filled
 *           in-process by the coordinated (default) or naive reference joint
 *           policy over the INTERNAL observations (honest platform teammates:
 *           the references never read a truth flag).
 *
 * Invariants:
 *   - `phantomSalt` is pinned to 0 (F9): Split-Brain adjudicates with salt 0.
 *   - The tier enters ONLY through `config.allowance` (F3); at Core the state is
 *     byte-identical to RAID_CONFIGS[boss], so the frozen anchors reproduce.
 *   - Deadlines are data: a miss or a refused frame is an ordinary recorded Hold.
 *   - Forfeit (3 consecutive hard misses) is a scenario-layer terminal (F4); the
 *     replay covers the ticks played.
 *   - Free text (`thought`, `ping.text`) never enters the record.
 */

import {
  buildRaidObservation,
  foldHash,
  isRaidTerminal,
  legalizeRaidMember,
  raidStateHash,
  resolveRaidTick,
  type RaidObservation,
  type RaidState,
  type RaidTickActions,
  type RaidUnitAction,
} from 'wot-engine';
import { assertBlindingKey } from './blinding.ts';
import { egressFromInternal, peerReports, type MemberView, type PeerReport } from './egress.ts';
import { computeRaidVerdicts } from './oracles/raid.ts';
import { initialRaidState } from './raid-state.ts';
import { canonicalMemberActions, REFERENCE, type NamedPolicy } from './references.ts';
import { parseMemberPayload, parseSquadPayload } from './submission.ts';
import { tierOf } from './tiers.ts';
import { trajectoryClass } from './trajectory.ts';
import type {
  ActReceipt,
  AdapterCoercion,
  BudgetTier,
  EpisodeRecord,
  EpisodeTerminal,
  OracleVerdict,
  RaidScenarioId,
  RejectReason,
  Scenario,
  ScenarioInitOptions,
  SeatDescriptor,
  SeatId,
  Submission,
  TickResult,
  TierId,
  TimingEntry,
} from './types.ts';

/**
 * 1.0.0: B2 recalibration (orchestrator-accepted). 1.1.0 (B2c,
 * docs/phase-7/CALIBRATION.md): Byzantine squad primary adds time-to-first-quorum;
 * minority-claim and self-distrust exempt board-blocked moves toward the quorum
 * node; Hallucinator oracles read the L9-clipped egress readings; the Deadlock
 * coordinated reference is lock-order disciplined. Oracle ids are unchanged.
 * 1.2.0 (arena-scenarios.md §9): the catalog adds `shared.participation`
 * (error): a target seat that issues no non-trivial action fails. Verdict-only;
 * no replay hash moves.
 */
export const RAID_SCENARIO_VERSION = '1.2.0';
export const PHANTOM_SALT = 0 as const;
const MEMBER_SEATS = ['m0', 'm1', 'm2', 'm3', 'm4'] as const;

/** The eval_raid_observation frame BODY (the transport adds t, protocol_version, episode_id, nonce). */
export interface EvalRaidObservationBody {
  scenario_id: RaidScenarioId;
  mode: 'member' | 'squad';
  seat: SeatId;
  turn_id: number;
  deadline_ms: number;
  hard_deadline_ms: number;
  view?: MemberView;
  views?: MemberView[];
  peer_reports?: PeerReport[];
}

export interface RaidActionPayload {
  units?: unknown;
  members?: unknown;
  thought?: unknown;
}

interface Slot {
  accepted: boolean;
  actions: Record<string, RaidUnitAction[]>;
  coercions: Omit<AdapterCoercion, 'tick'>[];
  latencyMs: number | null;
  frameBytes: number | null;
  /** 'hard' after a frame beyond Dh or an explicit hard miss; 'soft' after an explicit soft miss. */
  miss: 'soft' | 'hard' | null;
}

export class RaidScenario implements Scenario<EvalRaidObservationBody, RaidActionPayload> {
  readonly version = RAID_SCENARIO_VERSION;
  private initialized = false;
  private seed = 0;
  private tierId: TierId = 'core';
  private tier!: Readonly<BudgetTier>;
  private opts!: ScenarioInitOptions;
  private state!: RaidState;
  private chain = '';
  private perTickHashes: string[] = [];
  private inputs: RaidTickActions[] = [];
  private timing: TimingEntry[] = [];
  private adapterCoercions: AdapterCoercion[] = [];
  private term: EpisodeTerminal | null = null;
  private seatList: SeatDescriptor[] = [];
  private target: SeatId = 'm1';
  private controls: string[] = [];
  private fill: NamedPolicy | null = null;
  private driver: NamedPolicy | null = null;
  private slot: Slot = RaidScenario.emptySlot();
  private hardStreak = 0;
  private cacheTick = -1;
  private cacheInternals: RaidObservation[] = [];

  constructor(readonly id: RaidScenarioId) {}

  private static emptySlot(): Slot {
    return { accepted: false, actions: {}, coercions: [], latencyMs: null, frameBytes: null, miss: null };
  }

  init(seed: number, tier: TierId, opts: ScenarioInitOptions): void {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be a uint32');
    assertBlindingKey(opts.blindingKey);
    if (opts.mode !== 'squad' && opts.mode !== 'member') throw new Error(`${this.id}: mode must be squad or member`);
    this.seed = seed;
    this.tierId = tier;
    this.tier = tierOf(tier);
    this.opts = { ...opts };
    this.state = initialRaidState(this.id, seed, tier);
    this.chain = raidStateHash(this.state);
    this.perTickHashes = [];
    this.inputs = [];
    this.timing = [];
    this.adapterCoercions = [];
    this.term = null;
    this.slot = RaidScenario.emptySlot();
    this.hardStreak = 0;
    this.cacheTick = -1;

    const drv = opts.targetDriver ?? 'external';
    if (drv !== 'external' && drv !== 'ref:coordinated' && drv !== 'ref:naive') {
      throw new Error(`${this.id}: unsupported target driver ${drv}`);
    }
    this.driver = drv === 'external' ? null : REFERENCE[this.id][drv === 'ref:coordinated' ? 'coordinated' : 'naive'];
    const driverRef = this.driver ? `driver:ref:${this.driver.name}` : 'external';

    if (opts.mode === 'squad') {
      if (opts.targetSeat !== undefined && opts.targetSeat !== 'squad') throw new Error('squad mode seat is `squad`');
      if (opts.fill !== undefined) throw new Error('squad mode takes no fill');
      this.target = 'squad';
      this.controls = [...this.state.members].sort();
      this.fill = null;
      this.seatList = [{ seat: 'squad', controls: [...this.controls], role: 'target', policyRef: driverRef }];
    } else {
      const seat = opts.targetSeat ?? 'm1';
      if (!(MEMBER_SEATS as readonly string[]).includes(seat)) throw new Error('member mode seat is m0..m4');
      this.target = seat;
      this.controls = [seat];
      const fillName = opts.fill ?? 'coordinated';
      this.opts.fill = fillName;
      this.fill = REFERENCE[this.id][fillName];
      this.seatList = MEMBER_SEATS.map((m) =>
        m === seat
          ? { seat: m, controls: [m], role: 'target' as const, policyRef: driverRef }
          : { seat: m, controls: [m], role: 'reference' as const, policyRef: `ref:${this.fill!.name}` },
      );
    }
    this.initialized = true;
  }

  seats(): readonly SeatDescriptor[] {
    return this.seatList.map((s) => ({ ...s, controls: [...s.controls] }));
  }

  targetSeats(): readonly SeatId[] {
    return [this.target];
  }

  currentTick(): number {
    this.assertInit();
    return this.state.tick;
  }

  /** Internal observations of the start-of-tick state (salt pinned to 0), cached per tick. */
  private internals(): RaidObservation[] {
    if (this.cacheTick !== this.state.tick) {
      this.cacheInternals = this.state.members.map((m) => buildRaidObservation(this.state, m, { phantomSalt: PHANTOM_SALT }));
      this.cacheTick = this.state.tick;
    }
    return this.cacheInternals;
  }

  observe(agentId: SeatId): EvalRaidObservationBody {
    this.assertLive();
    this.assertTarget(agentId);
    const internals = this.internals();
    const key = this.opts.blindingKey;
    const base = {
      scenario_id: this.id,
      mode: this.opts.mode as 'member' | 'squad',
      seat: this.target,
      turn_id: this.state.tick,
      deadline_ms: this.tier.softDeadlineMs,
      hard_deadline_ms: this.tier.hardDeadlineMs,
    };
    if (this.opts.mode === 'squad') {
      return { ...base, views: internals.map((o) => egressFromInternal(o, o.member_id, key)) };
    }
    const own = internals.find((o) => o.member_id === this.target)!;
    const body: EvalRaidObservationBody = { ...base, view: egressFromInternal(own, this.target, key) };
    if (this.id === 'hallucinator') body.peer_reports = peerReports(internals, this.target, key);
    return body;
  }

  act(agentId: SeatId, submission: Submission<RaidActionPayload>): ActReceipt {
    this.assertLive();
    this.assertTarget(agentId);
    const tick = this.state.tick;
    const reject = (reason: RejectReason | 'late_frame_dropped', latencyMs: number | null, frameBytes: number | null): ActReceipt => {
      this.timing.push({ event: 'rejected', tick, seat: agentId, latencyMs, miss: 'none', frameBytes, reject: reason });
      return { accepted: false, reason, coercions: [] };
    };

    if (submission.kind === 'rejected') {
      return reject(submission.reason, submission.latencyMs ?? null, submission.frameBytes ?? null);
    }
    if (submission.kind === 'miss') {
      if (!this.slot.accepted) this.slot.miss = submission.severity === 'hard' || this.slot.miss === 'hard' ? 'hard' : 'soft';
      return { accepted: false, coercions: [] };
    }
    const latencyMs = submission.latencyMs ?? null;
    const frameBytes = submission.frameBytes ?? null;
    if (this.slot.accepted) return reject('duplicate_submission', latencyMs, frameBytes);
    if (frameBytes !== null && frameBytes > this.tier.maxInboundFrameBytes) return reject('too_large', latencyMs, frameBytes);
    if (latencyMs !== null && latencyMs > this.tier.hardDeadlineMs) {
      this.slot.miss = 'hard';
      return reject('late_frame_dropped', latencyMs, frameBytes);
    }

    let actions: Record<string, RaidUnitAction[]>;
    let coercions: Omit<AdapterCoercion, 'tick'>[];
    if (this.opts.mode === 'squad') {
      const r = parseSquadPayload(this.controls, submission.payload);
      if (!r.ok) return reject(r.reason, latencyMs, frameBytes);
      actions = r.actions;
      coercions = r.coercions;
    } else {
      const r = parseMemberPayload(this.target, submission.payload);
      if (!r.ok) return reject(r.reason, latencyMs, frameBytes);
      actions = { [this.target]: r.actions };
      coercions = r.coercions;
    }
    this.slot = { accepted: true, actions, coercions, latencyMs, frameBytes, miss: null };
    const preview: { unitId: string; reason: string }[] = [];
    for (const m of Object.keys(actions).sort()) {
      for (const c of legalizeRaidMember(this.state, m, actions[m]).coercions) preview.push({ unitId: c.unit_id, reason: c.reason });
    }
    for (const c of coercions) preview.push({ unitId: c.unitId, reason: c.reason });
    return { accepted: true, coercions: preview, late: latencyMs !== null && latencyMs > this.tier.softDeadlineMs };
  }

  tick(): TickResult {
    this.assertLive();
    const t = this.state.tick;
    const internals = this.internals();
    const members = [...this.state.members].sort();
    const applied: RaidTickActions = {};

    const fillJoint = this.fill ? this.fill.policy(internals) : null;
    const driverJoint = this.driver
      ? this.driver === this.fill
        ? fillJoint!
        : this.driver.policy(internals)
      : null;

    const slot = this.slot;
    let decisionMiss: 'none' | 'soft' | 'hard';
    if (slot.accepted) {
      decisionMiss = slot.latencyMs !== null && slot.latencyMs > this.tier.softDeadlineMs ? 'soft' : 'none';
    } else if (driverJoint) {
      decisionMiss = 'none';
    } else {
      decisionMiss = slot.miss ?? 'hard';
    }

    for (const m of members) {
      if (this.controls.includes(m)) {
        if (slot.accepted) applied[m] = slot.actions[m] ?? [];
        else if (driverJoint) applied[m] = canonicalMemberActions(driverJoint[m]);
        else applied[m] = [];
      } else {
        applied[m] = canonicalMemberActions(fillJoint?.[m]);
      }
    }
    if (slot.accepted) for (const c of slot.coercions) this.adapterCoercions.push({ tick: t, ...c });

    this.timing.push({
      event: 'decision',
      tick: t,
      seat: this.target,
      latencyMs: slot.accepted ? slot.latencyMs : null,
      miss: decisionMiss,
      frameBytes: slot.accepted ? slot.frameBytes : null,
    });
    this.hardStreak = decisionMiss === 'hard' ? this.hardStreak + 1 : 0;

    this.inputs.push(structuredClone(applied));
    this.state = resolveRaidTick(this.state, applied);
    const h = raidStateHash(this.state);
    this.perTickHashes.push(h);
    this.chain = foldHash(this.chain, h);
    this.slot = RaidScenario.emptySlot();

    const rt = isRaidTerminal(this.state);
    if (rt.over) {
      const outcome = rt.outcome ?? 'timeout';
      this.term = {
        outcome,
        reason: outcome === 'clear' ? 'boss_defeated' : outcome === 'wipe' ? 'squad_wiped' : 'tick_cap',
        ticks: this.state.tick,
      };
    } else if (this.hardStreak >= this.tier.hardMissForfeit) {
      this.term = { outcome: 'forfeit', reason: 'hard_miss_streak', ticks: this.state.tick };
    }
    return { tick: t, stateHash: h, terminal: this.term };
  }

  terminal(): EpisodeTerminal | null {
    this.assertInit();
    return this.term ? { ...this.term } : null;
  }

  replayHash(): string {
    this.assertInit();
    return this.chain;
  }

  record(): EpisodeRecord {
    this.assertInit();
    if (!this.term) throw new Error(`${this.id}: record() before terminal`);
    return {
      scenarioId: this.id,
      scenarioVersion: this.version,
      engineCommit: this.opts.engineCommit ?? 'unpinned',
      seed: this.seed,
      tier: this.tierId,
      mode: this.opts.mode,
      targetSeat: this.target,
      ...(this.opts.mode === 'member' ? { fill: this.opts.fill } : {}),
      seats: this.seats() as SeatDescriptor[],
      inputs: structuredClone(this.inputs),
      timing: this.timing.map((e) => ({ ...e })),
      adapterCoercions: this.adapterCoercions.map((c) => ({ ...c })),
      blindingKey: this.opts.blindingKey,
      perTickHashes: [...this.perTickHashes],
      replayHash: this.chain,
      terminal: { ...this.term },
      trajectoryClass: trajectoryClass({
        scenarioId: this.id,
        scenarioVersion: this.version,
        seed: this.seed,
        tier: this.tierId,
        mode: this.opts.mode,
        targetSeat: this.target,
        fill: this.opts.mode === 'member' ? this.opts.fill : undefined,
      }),
    };
  }

  oracles(): OracleVerdict[] {
    return computeRaidVerdicts(this.record()).verdicts;
  }

  /** Engine state is never exposed to a target; this accessor exists for tests and the leak harness. */
  debugState(): RaidState {
    this.assertInit();
    return this.state;
  }

  private assertInit(): void {
    if (!this.initialized) throw new Error(`${this.id}: init() first`);
  }

  private assertLive(): void {
    this.assertInit();
    if (this.term) throw new Error(`${this.id}: episode is over (${this.term.outcome})`);
  }

  private assertTarget(seat: SeatId): void {
    if (seat !== this.target) throw new Error(`${this.id}: ${seat} is not a target seat`);
  }
}
