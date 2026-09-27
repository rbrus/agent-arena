/**
 * `GridTacticsScenario` — the control scenario (arena-scenarios.md §2.1): a duel
 * against a fresh scripted house bot (`silver`) per episode, over the UNMODIFIED
 * duel engine. The target-facing frame is the existing whitelist fog projection
 * `buildObservation` (already fog-fuzzed by wot-engine test/fog.test.ts); the
 * only adapter change is that `match_id` is derived from the blinding key, never
 * from the seed (L6), and the nonce is a transport placeholder.
 */

import {
  buildObservation,
  foldHash,
  isTerminal,
  legalizeAction,
  resolveTick,
  stateHash,
  type MatchState,
  type Player,
  type TickActions,
  type UnitAction,
} from 'wot-engine';
import type { Observation } from 'wot-contracts';
import { assertBlindingKey } from './blinding.ts';
import { initialDuelState } from './duel-state.ts';
import { computeGridVerdicts } from './oracles/grid.ts';
import { houseBot, nullDriver, reflexDriver, type DuelPolicy } from './references.ts';
import { parseDuelPayload } from './submission.ts';
import { tierOf } from './tiers.ts';
import { trajectoryClass } from './trajectory.ts';
import type {
  ActReceipt,
  AdapterCoercion,
  BudgetTier,
  EpisodeRecord,
  EpisodeTerminal,
  OracleVerdict,
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

/** 1.1.0 (arena-scenarios.md §9): the catalog adds `shared.participation` (error). Verdict-only; no replay hash moves. */
export const GRID_SCENARIO_VERSION = '1.1.0';
/** The transport overwrites this with the real per-decision nonce; it never enters state or the hash. */
export const NONCE_PLACEHOLDER = 'n0000000';
export const HOUSE_BOT_REF = 'house-bot:silver';

export interface DuelActionPayload {
  units?: unknown;
}

interface Slot {
  accepted: boolean;
  units: UnitAction[];
  coercions: Omit<AdapterCoercion, 'tick'>[];
  latencyMs: number | null;
  frameBytes: number | null;
  miss: 'soft' | 'hard' | null;
}
const emptySlot = (): Slot => ({ accepted: false, units: [], coercions: [], latencyMs: null, frameBytes: null, miss: null });

export class GridTacticsScenario implements Scenario<Observation, DuelActionPayload> {
  readonly id = 'grid_tactics' as const;
  readonly version = GRID_SCENARIO_VERSION;
  private initialized = false;
  private seed = 0;
  private tierId: TierId = 'core';
  private tier!: Readonly<BudgetTier>;
  private opts!: ScenarioInitOptions;
  private state!: MatchState;
  private chain = '';
  private perTickHashes: string[] = [];
  private inputs: TickActions[] = [];
  private timing: TimingEntry[] = [];
  private adapterCoercions: AdapterCoercion[] = [];
  private term: EpisodeTerminal | null = null;
  private target: Player = 'A';
  private opponent!: DuelPolicy;
  private driver: DuelPolicy | null = null;
  private driverRef = 'external';
  private slot: Slot = emptySlot();
  private hardStreak = 0;

  init(seed: number, tier: TierId, opts: ScenarioInitOptions): void {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be a uint32');
    assertBlindingKey(opts.blindingKey);
    if (opts.mode !== 'duel') throw new Error('grid_tactics: mode must be duel');
    if (opts.fill !== undefined) throw new Error('grid_tactics: duel takes no fill');
    const seat = opts.targetSeat ?? 'A';
    if (seat !== 'A' && seat !== 'B') throw new Error('grid_tactics: seat is A or B');
    this.seed = seed;
    this.tierId = tier;
    this.tier = tierOf(tier);
    this.opts = { ...opts };
    this.target = seat;
    this.state = initialDuelState(seed, tier, opts.blindingKey);
    this.chain = stateHash(this.state);
    this.perTickHashes = [];
    this.inputs = [];
    this.timing = [];
    this.adapterCoercions = [];
    this.term = null;
    this.slot = emptySlot();
    this.hardStreak = 0;
    this.opponent = houseBot('silver'); // a FRESH instance per episode
    const drv = opts.targetDriver ?? 'external';
    switch (drv) {
      case 'external':
        this.driver = null;
        break;
      case 'ref:reflex':
        this.driver = reflexDriver;
        break;
      case 'ref:null':
        this.driver = nullDriver;
        break;
      case 'ref:silver':
        this.driver = houseBot('silver');
        break;
      default:
        throw new Error(`grid_tactics: unsupported target driver ${drv}`);
    }
    this.driverRef = drv === 'external' ? 'external' : `driver:${drv}`;
    this.initialized = true;
  }

  seats(): readonly SeatDescriptor[] {
    const opp: Player = this.target === 'A' ? 'B' : 'A';
    const list: SeatDescriptor[] = [
      { seat: this.target, controls: [this.target], role: 'target', policyRef: this.driverRef },
      { seat: opp, controls: [opp], role: 'opponent', policyRef: HOUSE_BOT_REF },
    ];
    return list.sort((a, b) => (a.seat < b.seat ? -1 : 1));
  }

  targetSeats(): readonly SeatId[] {
    return [this.target];
  }

  currentTick(): number {
    this.assertInit();
    return this.state.tick;
  }

  private frame(p: Player): Observation {
    return buildObservation(this.state, p, this.state.tick, NONCE_PLACEHOLDER, this.tier.softDeadlineMs, this.tier.hardDeadlineMs);
  }

  observe(agentId: SeatId): Observation {
    this.assertLive();
    this.assertTarget(agentId);
    return this.frame(this.target);
  }

  act(agentId: SeatId, submission: Submission<DuelActionPayload>): ActReceipt {
    this.assertLive();
    this.assertTarget(agentId);
    const tick = this.state.tick;
    const reject = (reason: RejectReason | 'late_frame_dropped', latencyMs: number | null, frameBytes: number | null): ActReceipt => {
      this.timing.push({ event: 'rejected', tick, seat: agentId, latencyMs, miss: 'none', frameBytes, reject: reason });
      return { accepted: false, reason, coercions: [] };
    };
    if (submission.kind === 'rejected') return reject(submission.reason, submission.latencyMs ?? null, submission.frameBytes ?? null);
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
    const r = parseDuelPayload(this.target, submission.payload);
    if (!r.ok) return reject(r.reason, latencyMs, frameBytes);
    this.slot = { accepted: true, units: r.actions, coercions: r.coercions, latencyMs, frameBytes, miss: null };
    const preview = legalizeAction(this.state, this.target, r.actions).coercions.map((c) => ({ unitId: c.unit_id, reason: c.reason as string }));
    for (const c of r.coercions) preview.push({ unitId: c.unitId, reason: c.reason });
    return { accepted: true, coercions: preview, late: latencyMs !== null && latencyMs > this.tier.softDeadlineMs };
  }

  tick(): TickResult {
    this.assertLive();
    const t = this.state.tick;
    const opp: Player = this.target === 'A' ? 'B' : 'A';
    const oppUnits = this.opponent(this.frame(opp));
    const slot = this.slot;
    let targetUnits: UnitAction[];
    let miss: 'none' | 'soft' | 'hard';
    if (slot.accepted) {
      targetUnits = slot.units;
      miss = slot.latencyMs !== null && slot.latencyMs > this.tier.softDeadlineMs ? 'soft' : 'none';
      for (const c of slot.coercions) this.adapterCoercions.push({ tick: t, ...c });
    } else if (this.driver) {
      targetUnits = this.driver(this.frame(this.target));
      miss = 'none';
    } else {
      targetUnits = [];
      miss = slot.miss ?? 'hard';
    }
    this.timing.push({
      event: 'decision',
      tick: t,
      seat: this.target,
      latencyMs: slot.accepted ? slot.latencyMs : null,
      miss,
      frameBytes: slot.accepted ? slot.frameBytes : null,
    });
    this.hardStreak = miss === 'hard' ? this.hardStreak + 1 : 0;

    const applied: TickActions = this.target === 'A' ? { A: targetUnits, B: oppUnits } : { A: oppUnits, B: targetUnits };
    this.inputs.push(structuredClone(applied));
    this.state = resolveTick(this.state, applied);
    const h = stateHash(this.state);
    this.perTickHashes.push(h);
    this.chain = foldHash(this.chain, h);
    this.slot = emptySlot();

    const tr = isTerminal(this.state);
    if (tr.over) {
      const outcome = tr.winner === 'draw' ? 'draw' : tr.winner === this.target ? 'win' : 'loss';
      const reason = tr.reason === 'timeout' ? `timeout_${tr.tiebreak ?? 'draw'}` : tr.reason;
      this.term = { outcome, reason, ticks: this.state.tick };
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
    if (!this.term) throw new Error('grid_tactics: record() before terminal');
    return {
      scenarioId: this.id,
      scenarioVersion: this.version,
      engineCommit: this.opts.engineCommit ?? 'unpinned',
      seed: this.seed,
      tier: this.tierId,
      mode: 'duel',
      targetSeat: this.target,
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
        mode: 'duel',
        targetSeat: this.target,
      }),
    };
  }

  oracles(): OracleVerdict[] {
    return computeGridVerdicts(this.record()).verdicts;
  }

  debugState(): MatchState {
    this.assertInit();
    return this.state;
  }

  private assertInit(): void {
    if (!this.initialized) throw new Error('grid_tactics: init() first');
  }

  private assertLive(): void {
    this.assertInit();
    if (this.term) throw new Error(`grid_tactics: episode is over (${this.term.outcome})`);
  }

  private assertTarget(seat: SeatId): void {
    if (seat !== this.target) throw new Error(`grid_tactics: ${seat} is not a target seat`);
  }
}
