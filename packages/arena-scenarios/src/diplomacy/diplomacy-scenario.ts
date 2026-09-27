/**
 * `DiplomacyScenario` — the standard-map Diplomacy table as an evaluation
 * (contracts 2.1.0; docs/design/diplomacy-scenario.md) over the UNMODIFIED
 * engine game loop (`dipInit / dipAct / dipMiss / dipTick`).
 *
 * Seating (mode `power`): the target plays one power — named, or `auto` =
 * `dipSeatPowers(seed)[0]`, the engine's seeded shuffle. The other six seats
 * are in-process reference agents per `fill` (tables.ts), driven exactly as the
 * engine's `runTable` drives them: POWERS order, each on its own
 * `dipObserve`, skipped once it has neither a unit nor a centre.
 *
 * One tick = one engine step (intent → press r1..rR → orders; retreat and
 * adjustment phases one orders step). Deadlines are DATA: an accepted frame
 * past Ds is applied and reported to the engine as a soft miss (`dipMiss`);
 * no frame, a refused frame or a frame past Dh is an empty input (no intent,
 * no press, all units hold / NMR) and a hard miss. The engine forfeits the
 * power after three consecutive hard misses (civil disorder). A forfeited or
 * eliminated target has no decisions left: the adapter then plays the rest of
 * the game with the references inside the same `tick()` call, so the episode
 * always ends at a real game terminal (the contract's `diplomacy_episode_end`
 * requires one) and `terminal()` is set after that call.
 *
 * Press never enters `replay_hash` (the engine's board chain); it enters
 * `transcript_hash`. Rejected frames, misses and latencies are attested timing
 * evidence (never hashed). Egress is built only from `dipProjectForPower` and
 * validated against `diplomacy_observation` before it leaves (fail closed).
 */

import { createHash } from 'node:crypto';
import {
  buildDipObservation,
  diplomacyOracleHook,
  dipAct,
  dipEvaluate,
  dipInit,
  dipMiss,
  dipObserve,
  dipProjectForPower,
  dipTick,
  DIP_SCENARIO_VERSION,
  POWERS,
  type DipCanary,
  type DipEpisode,
  type Power,
} from 'wot-engine';
import { assertBlindingKey } from '../blinding.ts';
import { tierOf } from '../tiers.ts';
import type {
  ActReceipt,
  BudgetTier,
  EpisodeRecord,
  EpisodeTerminal,
  OracleVerdict,
  PowerSeat,
  RejectReason,
  Scenario,
  ScenarioInitOptions,
  SeatDescriptor,
  SeatId,
  Submission,
  TargetDriver,
  TickResult,
  TierId,
  TimingEntry,
} from '../types.ts';
import { dipSchemaErrors, dipValidators } from './contracts.ts';
import type { DipFill, DipSeatKind, DipSeatRoster, DiplomacyRecord } from './record.ts';
import {
  agentOf,
  AGENT_NAME,
  DIP_DEFAULT_HORIZON,
  DIP_MAX_HORIZON,
  DIP_POWERS,
  evalContext,
  isPowerSeat,
  obsAlive,
  profileOf,
  resolveSeat,
  rosterFor,
  seatKindsOf,
  targetRoster,
  type DipAgent,
} from './tables.ts';
import { dipTrajectoryClass } from './trajectory.ts';
import { computeDipVerdicts } from './verdicts.ts';
import { buildWireObservation, dipRenounceSigModes, DIP_MAX_INBOUND_FRAME_BYTES, toEngineAction, type DiplomacyActionPayload, type DiplomacyObservationBody, type OrderFeedback } from './wire.ts';

/**
 * Adapter version (the engine's scenario layer is versioned separately as
 * `DIP_SCENARIO_VERSION`). 1.0.0: first release (Phase 8 B3b). 1.1.0: engine
 * `wot-dip-scenario/2` (Phase 8 F-1) — an offer or counter whose clause runs past the
 * horizon's final movement phase is refused (`terms_invalid` on the wire, engine code
 * `clause_beyond_horizon`) and house seats clamp their truce spans to the horizon, so a
 * `--horizon 1907|1908` table no longer carries clause phases the contract cannot express.
 * 1.2.0: engine `wot-dip-scenario/3` (contracts 2.5.0) — a renounce of an ended commitment is
 * refused `commitment_unknown`, private/group press to an eliminated power `press_bad_recipient`, and a
 * `terms.note` not in sanitised form `press_invalid_text`; the wire sends `clause_beyond_horizon` as is and each clause carries
 * `settlements[]` with the aggregate status and the LAST settlement's phase and tick.
 */
export const DIPLOMACY_SCENARIO_VERSION = '1.2.0';
export const DIPLOMACY_TICK_CAP = 120;
const EGRESS_ENVELOPE = { t: 'diplomacy_observation', protocol_version: '1.0', episode_id: `epi_${'0'.repeat(26)}`, nonce: 'egress-check' } as const;
const HEX64 = /^[0-9a-f]{64}$/;

export function secretCommitment(secret: string): string {
  return 'sha256:' + createHash('sha256').update(`wot-dip/secret-commit|${secret}`, 'utf8').digest('hex');
}

interface Slot {
  accepted: boolean;
  payload: Record<string, unknown> | null;
  latencyMs: number | null;
  frameBytes: number | null;
  miss: 'soft' | 'hard' | null;
}
const emptySlot = (): Slot => ({ accepted: false, payload: null, latencyMs: null, frameBytes: null, miss: null });

/** A power with a unit (incl. dislodged) or a centre: the engine's `alivePowers` rule. */
export const powerAlive = (ep: DipEpisode, p: Power): boolean =>
  ep.state.units.some((u) => u.power === p) || ep.state.dislodged.some((d) => d.unit.power === p) || Object.values(ep.state.sc).includes(p);

export const isForfeited = (ep: DipEpisode, p: Power): boolean => ep.forfeited.some((f) => f.power === p);

/** Per-target outcome (contracts 2.1.0 `diplomacy_episode_end.outcome`). */
export function outcomeOf(ep: DipEpisode, me: Power): EpisodeTerminal {
  const t = ep.terminal;
  if (!t) throw new Error('outcomeOf: not terminal');
  if (isForfeited(ep, me)) return { outcome: 'forfeit', reason: 'hard_miss_streak', ticks: ep.tick };
  const eliminated = t.eliminated.includes(me);
  let outcome: EpisodeTerminal['outcome'];
  if (t.kind === 'horizon') outcome = eliminated ? 'eliminated' : 'survived';
  else if (t.winner === me) outcome = 'solo';
  else outcome = eliminated ? 'eliminated' : 'loss';
  return { outcome, reason: t.kind, ticks: ep.tick };
}

export class DiplomacyScenario implements Scenario<DiplomacyObservationBody, DiplomacyActionPayload> {
  readonly id = 'diplomacy_standard' as const;
  readonly version = DIPLOMACY_SCENARIO_VERSION;
  private initialized = false;
  private seed = 0;
  private tierId: TierId = 'core';
  private tier!: Readonly<BudgetTier>;
  private opts!: ScenarioInitOptions;
  private ep!: DipEpisode;
  private power: PowerSeat = 'germany';
  private seatRequest: PowerSeat | 'auto' = 'auto';
  private fill: DipFill = 'house';
  private horizonYear = DIP_DEFAULT_HORIZON;
  private secret = '';
  private roster!: Record<PowerSeat, DipSeatRoster>;
  private kinds!: Record<PowerSeat, DipSeatKind>;
  private owners!: Record<PowerSeat, string>;
  private agents = {} as Record<PowerSeat, DipAgent | null>;
  private driverName: TargetDriver = 'external';
  private registry: DipCanary[] = [];
  private timing: TimingEntry[] = [];
  private perTickHashes: string[] = [];
  private perTickTranscript: string[] = [];
  private targetInputs: { tick: number; payload: Record<string, unknown> }[] = [];
  private edgeFeedback = new Map<number, OrderFeedback[]>();
  private slot: Slot = emptySlot();
  private term: EpisodeTerminal | null = null;
  private engineEvaluationHash = '';
  private cache: { tick: number; body: DiplomacyObservationBody } | null = null;

  init(seed: number, tier: TierId, opts: ScenarioInitOptions): void {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be a uint32');
    assertBlindingKey(opts.blindingKey);
    if (opts.mode !== 'power') throw new Error('diplomacy_standard: mode must be power');
    if (opts.fill !== undefined) throw new Error('diplomacy_standard: use diplomacy.fill (the member-mode fill does not apply)');
    const req = opts.targetSeat ?? 'auto';
    if (req !== 'auto' && !isPowerSeat(req)) throw new Error('diplomacy_standard: seat must be a power or auto');
    const d = opts.diplomacy ?? {};
    const horizon = d.horizonYear ?? DIP_DEFAULT_HORIZON;
    if (!Number.isInteger(horizon) || horizon < 1901 || horizon > DIP_MAX_HORIZON) throw new Error(`diplomacy_standard: horizonYear must be 1901..${DIP_MAX_HORIZON}`);
    const secret = d.secret ?? '';
    if (secret !== '' && !HEX64.test(secret)) throw new Error('diplomacy_standard: secret must be empty (local) or 64 lower-case hex chars');
    const driver = opts.targetDriver ?? 'external';

    this.seed = seed;
    this.tierId = tier;
    this.tier = tierOf(tier);
    this.opts = { ...opts, diplomacy: { ...d } };
    this.seatRequest = req;
    this.power = resolveSeat(seed, req);
    this.fill = d.fill ?? 'house';
    this.horizonYear = horizon;
    this.secret = secret;
    this.driverName = driver;
    this.roster = rosterFor(seed, this.power, this.fill, targetRoster(driver));
    const sk = seatKindsOf(this.power, this.roster);
    this.kinds = sk.kinds;
    this.owners = sk.owners;
    for (const p of DIP_POWERS) this.agents[p] = agentOf(seed, this.roster[p]);
    this.ep = dipInit(seed, tier, { horizonYear: horizon, secret });
    this.registry = [];
    this.timing = [];
    this.perTickHashes = [];
    this.perTickTranscript = [];
    this.targetInputs = [];
    this.edgeFeedback = new Map();
    this.slot = emptySlot();
    this.term = null;
    this.engineEvaluationHash = '';
    this.cache = null;
    this.initialized = true;
  }

  seats(): readonly SeatDescriptor[] {
    this.assertInit();
    return DIP_POWERS.map((p) => {
      const r = this.roster[p];
      if (p === this.power) {
        return { seat: p, controls: [p], role: 'target' as const, policyRef: r.agent === 'external' ? 'external' : `driver:ref:${AGENT_NAME[r.agent]}` };
      }
      const persona = r.agent === 'house' && r.persona ? `:${r.persona}` : '';
      return { seat: p, controls: [p], role: r.agent === 'injector' ? ('opponent' as const) : ('reference' as const), policyRef: `ref:${AGENT_NAME[r.agent]}${persona}` };
    });
  }

  targetSeats(): readonly SeatId[] {
    this.assertInit();
    return [this.power];
  }

  currentTick(): number {
    this.assertInit();
    return this.ep.tick;
  }

  /** The target's contract frame body for the current step (validated; cached per tick). */
  observe(agentId: SeatId): DiplomacyObservationBody {
    this.assertLive();
    this.assertTarget(agentId);
    if (this.cache?.tick === this.ep.tick) return this.cache.body;
    const proj = dipProjectForPower(this.ep, this.power);
    const prevPayload = this.targetInputs.find((x) => x.tick === this.ep.tick - 1)?.payload;
    const prevMoves = Array.isArray(prevPayload?.press) ? (prevPayload!.press as { move?: string }[]).map((m) => m?.move) : undefined;
    const body = buildWireObservation(proj, buildDipObservation(proj), {
      deadlineMs: this.tier.softDeadlineMs,
      hardDeadlineMs: this.tier.hardDeadlineMs,
      pressRounds: this.ep.config.pressRounds,
      edgeFeedback: this.edgeFeedback.get(this.ep.tick - 1) ?? [],
      renounceSigModes: dipRenounceSigModes(this.ep.press.log, this.power),
      ...(prevMoves ? { previousPressMoves: prevMoves } : {}),
    });
    const v = dipValidators.diplomacy_observation;
    if (!v({ ...EGRESS_ENVELOPE, ...body })) {
      throw new Error(`diplomacy_standard: egress frame violates diplomacy_observation (${dipSchemaErrors(v)}); refusing to send it`);
    }
    this.cache = { tick: this.ep.tick, body };
    return body;
  }

  act(agentId: SeatId, submission: Submission<DiplomacyActionPayload>): ActReceipt {
    this.assertLive();
    this.assertTarget(agentId);
    const tick = this.ep.tick;
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
    if (frameBytes !== null && frameBytes > DIP_MAX_INBOUND_FRAME_BYTES) return reject('too_large', latencyMs, frameBytes);
    if (latencyMs !== null && latencyMs > this.tier.hardDeadlineMs) {
      this.slot.miss = 'hard';
      return reject('late_frame_dropped', latencyMs, frameBytes);
    }
    const payload = submission.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return reject('schema_invalid', latencyMs, frameBytes);
    const clean: Record<string, unknown> = {};
    for (const k of Object.keys(payload)) {
      if (k === 'thought') continue; // accepted by the schema, never reaches the engine or the record
      if (k !== 'orders' && k !== 'intent' && k !== 'press') return reject('schema_invalid', latencyMs, frameBytes);
      clean[k] = (payload as Record<string, unknown>)[k];
    }
    // The same whole-frame validator as the edge, over a pseudo-envelope echoing this seat.
    const v = dipValidators.diplomacy_action;
    if (!v({ t: 'diplomacy_action', protocol_version: '1.0', episode_id: EGRESS_ENVELOPE.episode_id, turn_id: tick, nonce: EGRESS_ENVELOPE.nonce, power: this.power, ...clean })) {
      return reject('schema_invalid', latencyMs, frameBytes);
    }
    this.slot = { accepted: true, payload: structuredClone(clean), latencyMs, frameBytes, miss: null };
    return { accepted: true, coercions: [], late: latencyMs !== null && latencyMs > this.tier.softDeadlineMs };
  }

  tick(): TickResult {
    this.assertLive();
    const t = this.ep.tick;
    const me = this.power;
    const targetLive = powerAlive(this.ep, me) && !isForfeited(this.ep, me);
    const slot = this.slot;
    const driver = this.agents[me];
    let ep = this.ep;
    let feedback: OrderFeedback[] = [];
    for (const p of POWERS as readonly PowerSeat[]) {
      if (p === me) {
        if (!targetLive) continue;
        if (slot.accepted) {
          const r = toEngineAction(slot.payload as DiplomacyActionPayload, ep.step.phaseId);
          feedback = r.feedback;
          ep = dipAct(ep, p, r.action);
        } else if (driver) {
          const o = dipObserve(ep, p);
          if (!obsAlive(o, p)) continue;
          const r = driver(o);
          this.registry.push(...r.canaries);
          ep = dipAct(ep, p, r.action);
        }
        continue;
      }
      ep = this.referenceAct(ep, p);
    }
    let decisionMiss: 'none' | 'soft' | 'hard' = 'none';
    if (targetLive) {
      if (slot.accepted) decisionMiss = slot.latencyMs !== null && slot.latencyMs > this.tier.softDeadlineMs ? 'soft' : 'none';
      else if (driver) decisionMiss = 'none';
      else decisionMiss = slot.miss ?? 'hard';
      this.timing.push({ event: 'decision', tick: t, seat: me, latencyMs: slot.accepted ? slot.latencyMs : null, miss: decisionMiss, frameBytes: slot.accepted ? slot.frameBytes : null });
      if (decisionMiss !== 'none') ep = dipMiss(ep, me, decisionMiss);
      if (slot.accepted) this.targetInputs.push({ tick: t, payload: structuredClone(slot.payload!) });
      if (feedback.length) this.edgeFeedback.set(t, feedback);
    }
    ep = this.advance(ep);
    this.slot = emptySlot();
    this.cache = null;

    // A forfeited or eliminated target has no decisions left: play the game out with the references.
    if (!ep.terminal && (isForfeited(ep, me) || !powerAlive(ep, me))) {
      while (!ep.terminal) {
        for (const p of POWERS as readonly PowerSeat[]) if (p !== me) ep = this.referenceAct(ep, p);
        ep = this.advance(ep);
      }
    }
    this.ep = ep;
    if (ep.terminal) this.finish();
    return { tick: t, stateHash: this.perTickHashes[t], terminal: this.term };
  }

  private referenceAct(ep: DipEpisode, p: PowerSeat): DipEpisode {
    const agent = this.agents[p];
    if (!agent) return ep;
    const o = dipObserve(ep, p);
    if (!obsAlive(o, p)) return ep;
    const r = agent(o);
    this.registry.push(...r.canaries);
    return dipAct(ep, p, r.action);
  }

  private advance(ep: DipEpisode): DipEpisode {
    if (ep.tick >= DIPLOMACY_TICK_CAP) throw new Error(`diplomacy_standard: no game terminal within ${DIPLOMACY_TICK_CAP} ticks (horizon ${this.horizonYear})`);
    const next = dipTick(ep).ep;
    this.perTickHashes.push(next.chain);
    this.perTickTranscript.push(next.transcript);
    return next;
  }

  private finish(): void {
    this.term = outcomeOf(this.ep, this.power);
    const ctx = evalContext(this.roster, this.kinds, this.owners, this.registry);
    this.engineEvaluationHash = dipEvaluate(this.ep, diplomacyOracleHook(ctx)).evaluationHash;
  }

  terminal(): EpisodeTerminal | null {
    this.assertInit();
    return this.term ? { ...this.term } : null;
  }

  replayHash(): string {
    this.assertInit();
    return this.ep.chain;
  }

  transcriptHash(): string {
    this.assertInit();
    return this.ep.transcript;
  }

  record(): EpisodeRecord {
    this.assertInit();
    if (!this.term) throw new Error('diplomacy_standard: record() before terminal');
    const dip: DiplomacyRecord = {
      engineScenarioVersion: DIP_SCENARIO_VERSION,
      power: this.power,
      seatRequest: this.seatRequest,
      fill: this.fill,
      profile: profileOf(this.fill),
      horizonYear: this.horizonYear,
      pressRounds: this.ep.config.pressRounds,
      seatPowers: [...this.ep.seats] as PowerSeat[],
      roster: structuredClone(this.roster),
      seatKinds: { ...this.kinds },
      owners: { ...this.owners },
      episodeSecret: this.secret,
      episodeSecretCommitment: this.secret === '' ? null : secretCommitment(this.secret),
      canaryRegistrySeed: this.seed,
      targetInputs: structuredClone(this.targetInputs),
      transcriptHash: this.ep.transcript,
      perTickTranscript: [...this.perTickTranscript],
      engineEvaluationHash: this.engineEvaluationHash,
    };
    return {
      scenarioId: this.id,
      scenarioVersion: this.version,
      engineCommit: this.opts.engineCommit ?? 'unpinned',
      seed: this.seed,
      tier: this.tierId,
      mode: 'power',
      targetSeat: this.power,
      seats: this.seats() as SeatDescriptor[],
      inputs: structuredClone(this.ep.inputs) as unknown[],
      timing: this.timing.map((e) => ({ ...e })),
      adapterCoercions: [],
      blindingKey: this.opts.blindingKey,
      perTickHashes: [...this.perTickHashes],
      replayHash: this.ep.chain,
      terminal: { ...this.term },
      trajectoryClass: dipTrajectoryClass({ version: this.version, seed: this.seed, tier: this.tierId, power: this.power, fill: this.fill, horizonYear: this.horizonYear, secret: this.secret }),
      diplomacy: dip,
    };
  }

  oracles(): OracleVerdict[] {
    return computeDipVerdicts(this.record()).verdicts;
  }

  /** Engine state is never exposed to a target; this accessor exists for tests and the leak harness. */
  debugEpisode(): DipEpisode {
    this.assertInit();
    return this.ep;
  }

  private assertInit(): void {
    if (!this.initialized) throw new Error('diplomacy_standard: init() first');
  }

  private assertLive(): void {
    this.assertInit();
    if (this.term) throw new Error(`diplomacy_standard: episode is over (${this.term.outcome})`);
  }

  private assertTarget(seat: SeatId): void {
    if (seat !== this.power) throw new Error(`diplomacy_standard: ${seat} is not a target seat`);
  }
}
