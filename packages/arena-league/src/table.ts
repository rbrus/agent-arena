/**
 * The table core: a SYNCHRONOUS step machine over the unmodified engine game
 * loop (`dipInit / dipAct / dipMiss / dipTick`), seating up to seven external
 * peers and a house diplomat on every other power.
 *
 * It is the multi-seat generalisation of arena-scenarios' `DiplomacyScenario`
 * (which seats exactly one external target) and follows it line for line:
 *  - egress is built only from `dipProjectForPower` through arena-scenarios'
 *    `buildWireObservation` and validated against `diplomacy_observation`
 *    before it leaves (fail closed);
 *  - per tick, every power acts in POWERS order: a live peer's accepted
 *    payload goes through `toEngineAction`, a house seat is played by the
 *    engine's own agent (`dipAgentFor`, the seat setup `runTable` uses);
 *  - then each peer's miss is reported to the engine (`dipMiss`, POWERS
 *    order): three consecutive hard misses forfeit the power (civil disorder);
 *  - press never enters the board chain (`replay_hash`); misses and latencies
 *    are attested timing evidence (never hashed).
 *
 * No clock, no I/O, no RNG beyond the engine's: the live runner (run-table.ts)
 * and the verify path (reports.ts `redriveTable`) drive this same class, so a
 * recorded table re-simulates bit for bit.
 */

import { buildWireObservation, dipToEngineAction, dipValidators, DIPLOMACY_TICK_CAP, tierOf, type DiplomacyActionPayload, type DiplomacyObservationBody, type DipSeatRoster, type OrderFeedback, type TierId } from 'arena-scenarios';
import {
  buildDipObservation,
  dipAct,
  dipAgentAlive,
  dipAgentFor,
  dipInit,
  dipMiss,
  dipObserve,
  dipProjectForPower,
  dipReference,
  dipTick,
  POWERS,
  type DipCanary,
  type DipDeliveredMessage,
  type DipEpisode,
  type DipSeatSpec,
  type DipTableAgent,
  type DipTableSpec,
  type Power,
} from 'wot-engine';

export type Miss = 'none' | 'soft' | 'hard';

/** One peer decision as the core applies it: the accepted payload (or null) and the miss the edge assessed. */
export interface CoreDecision {
  payload: DiplomacyActionPayload | null;
  miss: Miss;
}

export interface TableCoreConfig {
  seed: number;
  tier: TierId;
  horizonYear: number;
  /** '' (local; codewords are a function of seed and power). Hosted secrets are Sixi-side (K4). */
  secret: string;
  /** The powers played by external peers (1..7, distinct). Every other power is a house diplomat. */
  peerPowers: readonly Power[];
}

const EGRESS_ENVELOPE = { t: 'diplomacy_observation', protocol_version: '1.0', episode_id: `epi_${'0'.repeat(26)}`, nonce: 'egress-check' } as const;

/** A power with a unit (incl. dislodged) or a centre: the engine's `alivePowers` rule (arena-scenarios `powerAlive`). */
export const powerAlive = (ep: DipEpisode, p: Power): boolean =>
  ep.state.units.some((u) => u.power === p) || ep.state.dislodged.some((d) => d.unit.power === p) || Object.values(ep.state.sc).includes(p);

export const isForfeited = (ep: DipEpisode, p: Power): boolean => ep.forfeited.some((f) => f.power === p);

/** The recorded `sig_mode` of every renounce `power` sent or received (arena-scenarios wire.ts `dipRenounceSigModes`). */
function renounceSigModes(log: readonly DipDeliveredMessage[], power: Power): Map<string, 'key' | 'session'> {
  const out = new Map<string, 'key' | 'session'>();
  for (const m of log) {
    if (m.move !== 'renounce' || m.sig_mode === null) continue;
    if (m.from !== power && !m.recipients.includes(power)) continue;
    out.set(m.msg_id, m.sig_mode);
  }
  return out;
}

/**
 * The house roster: every peer power pinned (placeholder spec, never driven), every other power a
 * house diplomat with the engine's seeded persona draw (`withHouse`, no schemer) — exactly what
 * arena-scenarios' `rosterFor(seed, target, 'house', …)` does for one target.
 */
export function houseRoster(seed: number, peerPowers: readonly Power[]): { roster: Record<Power, DipSeatRoster>; spec: Record<Power, DipSeatSpec> } {
  const fixed: Partial<Record<Power, DipSeatSpec>> = {};
  for (const p of peerPowers) fixed[p] = { agent: 'robust' };
  const seats = dipReference.withHouse(seed, fixed);
  const roster = {} as Record<Power, DipSeatRoster>;
  for (const p of POWERS) {
    if (peerPowers.includes(p)) roster[p] = { agent: 'external' };
    else {
      const s = seats[p];
      if (s.agent !== 'house') throw new Error(`withHouse seated ${s.agent} at ${p}`);
      roster[p] = { agent: 'house', ...(s.persona ? { persona: s.persona } : {}) };
    }
  }
  return { roster, spec: seats };
}

export class TableCore {
  readonly seed: number;
  readonly tier: TierId;
  readonly horizonYear: number;
  readonly secret: string;
  readonly peerPowers: readonly Power[];
  readonly roster: Record<Power, DipSeatRoster>;
  readonly softDeadlineMs: number;
  readonly hardDeadlineMs: number;
  private ep: DipEpisode;
  private readonly house: Partial<Record<Power, DipTableAgent>> = {};
  private readonly registry: DipCanary[] = [];
  private readonly perTickHashes: string[] = [];
  private readonly perTickTranscript: string[] = [];
  /** Per peer: accepted payload by tick (the observation's `previousPressMoves`). */
  private readonly accepted = new Map<Power, Map<number, DiplomacyActionPayload>>();
  /** Per peer: edge feedback of the tick it was produced at. */
  private readonly feedback = new Map<Power, Map<number, OrderFeedback[]>>();
  private cache = new Map<Power, { tick: number; body: DiplomacyObservationBody }>();

  constructor(cfg: TableCoreConfig) {
    if (!Number.isInteger(cfg.seed) || cfg.seed < 0 || cfg.seed > 0xffffffff) throw new Error('table: seed must be a uint32');
    if (!Number.isInteger(cfg.horizonYear) || cfg.horizonYear < 1901 || cfg.horizonYear > 1908) throw new Error('table: horizonYear must be 1901..1908');
    if (cfg.secret !== '') throw new Error('table: only the local (empty) episode secret is supported by the harness; hosted secrets are Sixi-side (K4)');
    const peers = [...cfg.peerPowers];
    if (peers.length < 1 || peers.length > 7) throw new Error('table: 1..7 peer seats');
    if (new Set(peers).size !== peers.length || peers.some((p) => !(POWERS as readonly string[]).includes(p))) throw new Error('table: peer powers must be distinct powers');
    this.seed = cfg.seed;
    this.tier = cfg.tier;
    this.horizonYear = cfg.horizonYear;
    this.secret = cfg.secret;
    this.peerPowers = (POWERS as readonly Power[]).filter((p) => peers.includes(p));
    const t = tierOf(cfg.tier);
    this.softDeadlineMs = t.softDeadlineMs;
    this.hardDeadlineMs = t.hardDeadlineMs;
    const { roster, spec } = houseRoster(cfg.seed, this.peerPowers);
    this.roster = roster;
    const tableSpec: DipTableSpec = { seed: cfg.seed, seats: spec, cls: cfg.tier, overrides: { horizonYear: cfg.horizonYear, secret: cfg.secret } };
    for (const p of POWERS) if (!this.peerPowers.includes(p)) this.house[p] = dipAgentFor(tableSpec, p, new Map());
    for (const p of this.peerPowers) {
      this.accepted.set(p, new Map());
      this.feedback.set(p, new Map());
    }
    this.ep = dipInit(cfg.seed, cfg.tier, { horizonYear: cfg.horizonYear, secret: cfg.secret });
  }

  get tick(): number {
    return this.ep.tick;
  }

  get terminal(): boolean {
    return this.ep.terminal !== null;
  }

  get phaseId(): string {
    return this.ep.step.phaseId;
  }

  episode(): DipEpisode {
    return this.ep;
  }

  hashes(): { perTickHashes: string[]; perTickTranscript: string[] } {
    return { perTickHashes: [...this.perTickHashes], perTickTranscript: [...this.perTickTranscript] };
  }

  /** Peers that have a decision this tick: on the board and not in civil disorder. */
  livePeers(): Power[] {
    if (this.ep.terminal) return [];
    return this.peerPowers.filter((p) => powerAlive(this.ep, p) && !isForfeited(this.ep, p));
  }

  /** The `diplomacy_observation` frame body for a live peer (validated against the contract before it leaves). */
  observe(p: Power): DiplomacyObservationBody {
    if (!this.livePeers().includes(p)) throw new Error(`table: ${p} has no decision at tick ${this.ep.tick}`);
    const hit = this.cache.get(p);
    if (hit?.tick === this.ep.tick) return hit.body;
    const proj = dipProjectForPower(this.ep, p);
    const prev = this.accepted.get(p)!.get(this.ep.tick - 1);
    const prevMoves = Array.isArray(prev?.press) ? (prev!.press as { move?: string }[]).map((m) => m?.move) : undefined;
    const body = buildWireObservation(proj, buildDipObservation(proj), {
      deadlineMs: this.softDeadlineMs,
      hardDeadlineMs: this.hardDeadlineMs,
      pressRounds: this.ep.config.pressRounds,
      edgeFeedback: this.feedback.get(p)!.get(this.ep.tick - 1) ?? [],
      renounceSigModes: renounceSigModes(this.ep.press.log, p),
      ...(prevMoves ? { previousPressMoves: prevMoves } : {}),
    });
    const v = dipValidators.diplomacy_observation;
    if (!v({ ...EGRESS_ENVELOPE, ...body })) throw new Error('table: egress frame violates diplomacy_observation; refusing to send it');
    this.cache.set(p, { tick: this.ep.tick, body });
    return body;
  }

  /**
   * Play the current tick. `decisions` must hold exactly the live peers. Returns the tick played.
   * Never waits: a peer without an accepted payload is an empty input (all units hold / NMR).
   */
  step(decisions: Readonly<Partial<Record<Power, CoreDecision>>>): number {
    if (this.ep.terminal) throw new Error('table: the game is over');
    const t = this.ep.tick;
    const live = this.livePeers();
    const given = Object.keys(decisions).sort();
    if (given.join() !== [...live].sort().join()) throw new Error(`table: tick ${t} needs decisions for [${live.join(', ')}], got [${given.join(', ')}]`);
    let ep = this.ep;
    for (const p of POWERS) {
      const d = decisions[p];
      if (d) {
        if (d.payload) {
          const r = dipToEngineAction(d.payload, ep.step.phaseId);
          if (r.feedback.length) this.feedback.get(p)!.set(t, r.feedback);
          this.accepted.get(p)!.set(t, structuredClone(d.payload));
          ep = dipAct(ep, p, r.action);
        }
        continue;
      }
      const agent = this.house[p];
      if (!agent) continue; // a peer with no decision this tick (eliminated or in civil disorder)
      const o = dipObserve(ep, p);
      if (!dipAgentAlive(o, p)) continue;
      const r = agent(o);
      this.registry.push(...r.canaries);
      ep = dipAct(ep, p, r.action);
    }
    for (const p of POWERS) {
      const d = decisions[p];
      if (!d) continue;
      const miss: Miss = d.payload ? d.miss : d.miss === 'none' ? 'hard' : d.miss;
      if (miss !== 'none') ep = dipMiss(ep, p, miss);
    }
    if (ep.tick >= DIPLOMACY_TICK_CAP) throw new Error(`table: no game terminal within ${DIPLOMACY_TICK_CAP} ticks (horizon ${this.horizonYear})`);
    const next = dipTick(ep).ep;
    this.perTickHashes.push(next.chain);
    this.perTickTranscript.push(next.transcript);
    this.ep = next;
    this.cache.clear();
    return t;
  }
}
