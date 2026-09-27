/**
 * DiplomacyTable — one Diplomacy episode driven over the arena session layer
 * (docs/design/diplomacy-scenario.md §1.3; asyncapi `eval_target` round-close
 * contract), on top of the pure `wot-engine` scenario loop.
 *
 * Per step (= one engine tick):
 *   1. every seat whose power is alive and not forfeited is prompted: an agent seat
 *      gets a `diplomacy_observation` (fresh unpredictable nonce, built from the
 *      engine's `dipObserve` whitelist view); a house seat is played in-process;
 *   2. actions are collected until every prompted agent answered or Dh elapsed;
 *      a later valid frame for the same step replaces the earlier one (DATC 4.D.1);
 *   3. the step resolves: signatures were verified at ingest (signatures.ts), each
 *      action is handed to `dipAct`; an answer after Ds is a soft miss, no answer by
 *      Dh a hard miss (`dipMiss`; 3 in a row forfeit inside the engine);
 *   4. `dipTick` closes the step (round-close delivery happens in the engine);
 *   5. at terminal every agent gets `diplomacy_episode_end`.
 *
 * The session never lets the client choose anything the engine hashes except its
 * own actions: `episodeId` and `secret` come from the table (set by the lobby),
 * the sender is the seat's power, and message ids are engine-assigned. The
 * resulting `replay_hash` / `transcript_hash` are exactly those of the same
 * inputs fed to the engine directly (test/diplomacy-e2e.test.ts).
 */

import { randomBytes } from 'node:crypto';
import type { Ed25519PublicJwk } from 'wot-auth';
import {
  dipAct,
  dipInit,
  dipMiss,
  dipObserve,
  dipResult,
  dipTick,
  houseDiplomat,
  POWERS,
  type DipAction,
  type DipConfig,
  type DipEpisode,
  type DipEvalClass,
  type DipResult,
  type Power,
} from 'wot-engine';
import type { LogFields } from '../log.ts';
import type { TableEndCause } from './results.ts';
import { attestBatch, type SignatureEvidence, type SignaturePolicy } from './signatures.ts';
import { fromWireAction, renounceSigModes, toWireEpisodeEnd, toWireObservation, type TransportFeedback } from './wire.ts';

export interface DipSeatSide {
  send(frame: unknown): void;
  close(code: number, reason?: string): void;
}

export type DipSeatSpec = { kind: 'agent'; agentId: string } | { kind: 'house'; persona?: 'loyal' | 'opportunist' | 'schemer' | 'turtle' };

export interface DipTableOptions {
  tableId: string;
  seed: number;
  cls: DipEvalClass;
  /** Run identity, set by the lobby (never by a client): transcript genesis + signature binding. */
  episodeId: string;
  /** Episode secret for codewords (disclosed after terminal). */
  secret: string;
  horizonYear?: number;
  /** Fixed seat order (else the engine's seeded shuffle). */
  seatPowers?: readonly Power[];
  /** Who plays each power. */
  seats: Readonly<Record<Power, DipSeatSpec>>;
  softMs: number;
  hardMs: number;
  policy: SignaturePolicy;
  log: (f: LogFields) => void;
  onEnd: (table: DiplomacyTable) => void;
}

interface Pending {
  action: DipAction;
  late: boolean;
  transport: TransportFeedback;
  moves: (string | undefined)[];
  /** Signature evidence of THIS frame; kept only if it is the one applied (latest replaces). */
  evidence: SignatureEvidence[];
}

export type SubmitResult = { ok: true } | { ok: false; reason: 'bad_echo' | 'stale_turn' | 'not_your_seat' | 'no_active_match'; hint: string };

const newNonce = (): string => `n_${randomBytes(12).toString('hex')}`;

export class DiplomacyTable {
  readonly tableId: string;
  readonly episodeId: string;
  private ep: DipEpisode;
  private readonly opts: DipTableOptions;
  private readonly sides = new Map<Power, DipSeatSide>();
  private nonces = new Map<Power, string>();
  private prompted = new Set<Power>();
  private pending = new Map<Power, Pending>();
  private promptedAt = 0;
  private resolved = true;
  /** A deferred resolve() is queued for the open step (reset by prompt()). */
  private resolveScheduled = false;
  private started = false;
  private ended = false;
  private cause: { cause: TableEndCause; closeCode: number } | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  /** Previous step's phase/round and each power's batch moves (annotates rejects in the next observation). */
  private prevStep: { phase: string; round: number | null } | null = null;
  private prevMoves = new Map<Power, (string | undefined)[]>();
  private prevTransport = new Map<Power, TransportFeedback>();
  /** Signature evidence (JWS bytes, kid, verdicts); never hashed. */
  readonly signatures: SignatureEvidence[] = [];

  constructor(opts: DipTableOptions) {
    this.opts = opts;
    this.tableId = opts.tableId;
    this.episodeId = opts.episodeId;
    const overrides: Partial<DipConfig> = { episodeId: opts.episodeId, secret: opts.secret };
    if (opts.horizonYear !== undefined) overrides.horizonYear = opts.horizonYear;
    if (opts.seatPowers) overrides.seatPowers = opts.seatPowers;
    this.ep = dipInit(opts.seed, opts.cls, overrides);
  }

  /** The power an agent id is seated at, or null. */
  powerOf(agentId: string): Power | null {
    for (const p of POWERS) {
      const s = this.opts.seats[p];
      if (s.kind === 'agent' && s.agentId === agentId) return p;
    }
    return null;
  }

  agentSeats(): Power[] {
    return POWERS.filter((p) => this.opts.seats[p].kind === 'agent');
  }

  get episode(): DipEpisode {
    return this.ep;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Why the table stopped and the close code its connected seats got (null while live). */
  get endCause(): { cause: TableEndCause; closeCode: number } | null {
    return this.cause;
  }

  get config(): { softMs: number; hardMs: number; pressRounds: number; cls: DipEvalClass; sessionSignatures: boolean } {
    return { softMs: this.opts.softMs, hardMs: this.opts.hardMs, pressRounds: this.ep.config.pressRounds, cls: this.opts.cls, sessionSignatures: this.opts.policy.allowSession };
  }

  /**
   * Everything `verify` needs to re-simulate this episode without the transport or any
   * key: seed, class, config overrides and the recorded per-tick inputs (attested
   * signature MODES, never JWS bytes). `resimulateDip(...)` over it reproduces both hashes.
   */
  recording(): { seed: number; cls: DipEvalClass; overrides: Partial<DipConfig>; inputs: DipEpisode['inputs'] } {
    const c = this.ep.config;
    return {
      seed: this.opts.seed,
      cls: this.opts.cls,
      overrides: { episodeId: c.episodeId, secret: c.secret, horizonYear: c.horizonYear, ...(this.opts.seatPowers ? { seatPowers: this.opts.seatPowers } : {}) },
      inputs: this.ep.inputs,
    };
  }

  /**
   * Bind (or re-bind, on supersession) a seat's live connection. The passport signing key is NOT bound
   * here: the lobby resolves the current key for every signed frame (signing.md §7.5, rotation).
   */
  attach(power: Power, side: DipSeatSide): void {
    this.sides.set(power, side);
    // A re-bind mid-step re-sends the current prompt so the new session can answer it.
    if (this.started && !this.resolved && this.prompted.has(power)) this.sendObservation(power);
  }

  detach(power: Power, side: DipSeatSide): void {
    if (this.sides.get(power) === side) this.sides.delete(power);
  }

  allConnected(): boolean {
    return this.agentSeats().every((p) => this.sides.has(p));
  }

  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.opts.log({ event: 'diplomacy_start', match_id: this.tableId, detail: { seed: this.opts.seed, cls: this.opts.cls } });
    this.prompt();
  }

  private alive(p: Power): boolean {
    const o = this.ep.state;
    return o.units.some((u) => u.power === p) || o.dislodged.some((d) => d.unit.power === p) || Object.values(o.sc).includes(p);
  }

  private forfeited(p: Power): boolean {
    return this.ep.forfeited.some((f) => f.power === p);
  }

  private sendObservation(p: Power): void {
    const side = this.sides.get(p);
    const nonce = this.nonces.get(p);
    if (!side || !nonce) return;
    const obs = dipObserve(this.ep, p);
    side.send(
      toWireObservation(obs, {
        episodeId: this.episodeId,
        nonce,
        softMs: this.opts.softMs,
        hardMs: this.opts.hardMs,
        pressRounds: this.ep.config.pressRounds,
        quotas: this.ep.config.quotas,
        ...(this.prevStep ? { prev: { ...this.prevStep, moves: this.prevMoves.get(p) ?? [] } } : {}),
        renounceSigModes: renounceSigModes(this.ep.press.log, p),
        ...(this.prevTransport.has(p) ? { transport: this.prevTransport.get(p)! } : {}),
      }),
    );
  }

  private prompt(): void {
    if (this.ended) return;
    if (this.ep.terminal) {
      this.finish();
      return;
    }
    this.resolved = false;
    this.resolveScheduled = false;
    this.pending = new Map();
    this.nonces = new Map();
    this.prompted = new Set();
    this.promptedAt = Date.now();
    for (const p of POWERS) {
      if (!this.alive(p) || this.forfeited(p)) continue;
      const seat = this.opts.seats[p];
      if (seat.kind === 'house') {
        const obs = dipObserve(this.ep, p);
        const action = houseDiplomat(obs, { seed: this.opts.seed, ...(seat.persona ? { persona: seat.persona } : {}) });
        this.pending.set(p, { action, late: false, transport: { orderFeedback: [] }, moves: [], evidence: [] });
        continue;
      }
      this.prompted.add(p);
      this.nonces.set(p, newNonce());
      this.sendObservation(p);
    }
    this.hardTimer = setTimeout(() => this.resolve(), this.opts.hardMs);
    if (typeof this.hardTimer.unref === 'function') this.hardTimer.unref();
    this.maybeResolve();
  }

  /**
   * A schema-valid `diplomacy_action` from the session bound to `power`. `publicJwk` is the seat's passport
   * key as resolved for THIS frame (null: no key, revoked, or the frame has no JWS-signed move).
   */
  submit(power: Power, frame: Record<string, unknown>, publicJwk: Ed25519PublicJwk | null = null): SubmitResult {
    if (this.ended || !this.started) return { ok: false, reason: 'no_active_match', hint: 'the table is not live' };
    if (frame.power !== power) return { ok: false, reason: 'not_your_seat', hint: 'power does not match the seat bound to this session' };
    if (frame.episode_id !== this.episodeId) return { ok: false, reason: 'bad_echo', hint: 'episode_id does not match' };
    if (this.resolved || frame.turn_id !== this.ep.tick) return { ok: false, reason: 'stale_turn', hint: 'turn_id is not the open step' };
    if (!this.prompted.has(power)) return { ok: false, reason: 'stale_turn', hint: 'no open prompt for this power' };
    if (frame.nonce !== this.nonces.get(power)) return { ok: false, reason: 'bad_echo', hint: 'nonce does not match' };

    const s = this.ep.step;
    let attest: ReturnType<typeof attestBatch>['attest'] = [];
    let evidence: SignatureEvidence[] = [];
    if (Array.isArray(frame.press) && s.kind === 'press') {
      const r = attestBatch(frame.press, {
        episodeId: this.episodeId,
        phase: s.phaseId,
        round: s.round,
        tick: this.ep.tick,
        power,
        publicJwk,
        policy: this.opts.policy,
      });
      attest = r.attest;
      evidence = r.evidence;
    }
    // Press outside a press step is refused by the engine (wrong_step) with no signature to check.
    const mapped = fromWireAction(frame, s.phaseId, attest);
    this.pending.set(power, { action: mapped.action, late: Date.now() - this.promptedAt > this.opts.softMs, transport: mapped.transport, moves: mapped.batchMoves, evidence });
    this.maybeResolve();
    return { ok: true };
  }

  private maybeResolve(): void {
    if (this.resolved || this.resolveScheduled) return;
    if ([...this.prompted].every((p) => this.pending.has(p))) {
      // Defer so a burst of frames in the same I/O turn cannot reorder a resolution
      // (a later frame for this step still replaces the earlier one until then).
      // Scheduled ONCE per step, and bound to this step's tick: a second deferred
      // resolve() would otherwise run after prompt() re-opened the table and close the
      // NEXT step with no answers (every prompted seat a hard miss; chaos case 3, D-3).
      this.resolveScheduled = true;
      const tick = this.ep.tick;
      setImmediate(() => {
        if (this.ep.tick === tick) this.resolve();
      });
    }
  }

  private resolve(): void {
    if (this.resolved || this.ended) return;
    this.resolved = true;
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.hardTimer = null;
    let ep = this.ep;
    const s = ep.step;
    for (const p of POWERS) {
      const got = this.pending.get(p);
      if (got) {
        this.signatures.push(...got.evidence);
        ep = dipAct(ep, p, got.action);
        if (got.late) ep = dipMiss(ep, p, 'soft');
      } else if (this.prompted.has(p)) {
        ep = dipMiss(ep, p, 'hard');
      }
    }
    this.prevStep = { phase: s.phaseId, round: s.kind === 'press' ? s.round : null };
    this.prevMoves = new Map([...this.pending].map(([p, v]) => [p, v.moves]));
    this.prevTransport = new Map([...this.pending].map(([p, v]) => [p, v.transport]));
    this.ep = dipTick(ep).ep;
    this.prompt();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.cause = { cause: 'terminal', closeCode: 1000 };
    if (this.hardTimer) clearTimeout(this.hardTimer);
    const r = dipResult(this.ep);
    this.opts.log({ event: 'diplomacy_end', match_id: this.tableId, reason: this.ep.terminal?.kind ?? 'aborted', detail: { ticks: r.ticks, replay_hash: r.replayHash, transcript_hash: r.transcriptHash } });
    for (const p of this.agentSeats()) {
      const side = this.sides.get(p);
      if (!side) continue;
      side.send(toWireEpisodeEnd(this.ep, p, this.episodeId));
      side.close(1000, 'diplomacy_episode_end');
    }
    this.opts.onEnd(this);
  }

  result(): DipResult & { episodeId: string; signatures: readonly SignatureEvidence[] } {
    return { ...dipResult(this.ep), episodeId: this.episodeId, signatures: this.signatures };
  }

  /** Arena shutdown: every connected seat is closed `code` (1012); no result is invented. */
  forceClose(code: number): void {
    this.abort(code, 'arena shutdown', 'shutdown');
  }

  /**
   * Stop the table without a terminal (no `diplomacy_episode_end`, `result().terminal === null`):
   * every connected seat is closed with `code`, then the owner's `onEnd` runs.
   */
  abort(code: number, reason: string, cause: Exclude<TableEndCause, 'terminal'>): void {
    if (this.ended) return;
    this.ended = true;
    this.cause = { cause, closeCode: code };
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.hardTimer = null;
    this.opts.log({ event: 'diplomacy_aborted', match_id: this.tableId, code, reason: cause, detail: { ticks: this.ep.tick, started: this.started } });
    for (const side of [...this.sides.values()]) side.close(code, reason);
    this.opts.onEnd(this);
  }
}
