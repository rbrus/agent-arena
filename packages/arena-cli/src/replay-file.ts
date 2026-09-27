/**
 * The replay tick log the inspector (Phase 7 B5) loads:
 * `ascension/frontend/src/lib/replay-format.ts` owns the shape; this module
 * emits exactly it. Built by RE-DRIVING the episode record (seed + the target
 * seat's recorded inputs + timing), never from live transport bytes, so
 *
 *   - `run` writes it and `replay --json` prints it byte-for-byte identically;
 *   - `action` is the canonical payload the engine applied (whitelisted by
 *     arena-scenarios' parser: no `thought`, no ping text, no unknown keys),
 *     so no target-authored free text is ever persisted;
 *   - the hash chain fold(initial_state_hash, state_hash…) equals replay_hash.
 *
 * On disk next to report.json: `report.episode-<n>.replay.json` (the
 * EpisodeResult's `replay_ref`) and the full record `report.episode-<n>.record.json`
 * (what `verify` re-simulates: timing log and adapter coercions included).
 *
 * diplomacy_standard (mode `power`): one entry per ENGINE step (intent, press
 * rounds, orders, retreat, adjustment). `initial_state_hash` is the head of the
 * adjudicator chain at genesis (`dipInit(...).chain`) and each `state_hash` is
 * the chain head after that step, so the LAST one equals `replay_hash`. The
 * adjudicator chain is not the Phase-7 per-tick fold (it folds the orders
 * digest and the state hash at each adjudication and is unchanged by press
 * steps), so the inspector's fold check (frontend lib/chain.ts) does not apply
 * to power mode yet; `verify` re-simulates it instead. `action` is the payload
 * the engine accepted from the target (wire form: orders / intent / press,
 * `thought` dropped, signatures attested). Press bodies are TARGET TEXT: the
 * record must keep them (they are engine inputs), every file is redacted on
 * write, and the inspector renders them as inert text. Steps the references
 * play after the target is eliminated or forfeited carry no seat.
 */

import { initialDuelState, initialRaidState, isDiplomacyRecord, tapDuel, tapRaid, type EpisodeRecord, type RaidScenarioId } from 'arena-scenarios';
import { dipInit, foldHash, raidStateHash, stateHash } from 'wot-engine';
import type { EpisodeResult } from './report.ts';
import { redrive, type DecisionTrace } from './rerun.ts';

export { replayRefFor, recordRefFor } from './files.ts';

type Scalar = string | number | boolean | null;
type Json = Scalar | Json[] | { [k: string]: Json };

export interface ReplayAck {
  status: 'accepted' | 'rejected' | 'miss' | 'none';
  reason?: string;
  coercions?: { unit_id: string; reason: string }[];
  late?: boolean;
}
export interface ReplaySeat {
  seat: string;
  observation: Json | null;
  action: Json | null;
  ack: ReplayAck;
}
export interface OracleEvent {
  oracle_id: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
}
export interface ReplayTick {
  tick: number;
  state_hash: string;
  seats: ReplaySeat[];
  engine_events: { type: string; [k: string]: Json }[];
  oracle_events: OracleEvent[];
}
export interface ReplayFile {
  replay_version: '1.0';
  scenario_id: string;
  episode_index: number;
  seed: number;
  tier: 'edge' | 'core' | 'frontier' | 'extended';
  mode: 'duel' | 'squad' | 'member' | 'power';
  seat: string;
  replay_hash: string;
  initial_state_hash: string;
  ticks: ReplayTick[];
}

/** Loader caps of the inspector (REPLAY_LIMITS): ≤ 121 ticks, ≤ 5 seats per tick, ≤ 64 events per list. */
export const REPLAY_LIMITS = { ticks: 121, seats: 5, events: 64 } as const;

function initialHash(rec: EpisodeRecord): string {
  if (isDiplomacyRecord(rec)) {
    // Genesis of the adjudicator chain: ruleset, map, the seeded seats and the horizon (always the recorded one).
    const d = rec.diplomacy;
    return dipInit(rec.seed, rec.tier, { horizonYear: d.horizonYear, secret: d.episodeSecret }).chain;
  }
  return rec.scenarioId === 'grid_tactics'
    ? stateHash(initialDuelState(rec.seed, rec.tier, rec.blindingKey))
    : raidStateHash(initialRaidState(rec.scenarioId as RaidScenarioId, rec.seed, rec.tier));
}

function toJson(v: unknown): Json {
  return JSON.parse(JSON.stringify(v ?? null)) as Json;
}

function oracleEventsOf(episode: EpisodeResult): Map<number, OracleEvent[]> {
  const oracleEvents = new Map<number, OracleEvent[]>();
  for (const v of episode.oracles) {
    if (v.verdict !== 'fail' || !v.evidence_ref) continue;
    for (const t of v.evidence_ref.ticks) {
      const list = oracleEvents.get(t) ?? [];
      if (list.length < REPLAY_LIMITS.events) list.push({ oracle_id: v.oracle_id, severity: v.severity, ...(v.evidence_ref.code ? { code: v.evidence_ref.code } : {}) });
      oracleEvents.set(t, list);
    }
  }
  return oracleEvents;
}

/** The power-mode tick log (see the header): one entry per engine step. */
function buildDipTicks(rec: EpisodeRecord, decisions: readonly DecisionTrace[], episode: EpisodeResult, initial: string): ReplayTick[] {
  if (!isDiplomacyRecord(rec)) throw new Error('not a diplomacy_standard record');
  const d = rec.diplomacy;
  const power = d.power;
  const inProcess = d.roster[power]?.agent !== 'external';
  const byTick = new Map(decisions.map((x) => [x.tick, x]));
  const oracleEvents = oracleEventsOf(episode);
  let prev = initial;
  return rec.perTickHashes.slice(0, REPLAY_LIMITS.ticks).map((h, t) => {
    const inp = (rec.inputs[t] ?? {}) as { step?: unknown; forfeit?: unknown; actions?: Record<string, unknown> };
    const events: ReplayTick['engine_events'] = [];
    if (typeof inp.step === 'string') events.push({ type: 'step', step: inp.step });
    if (h !== prev) events.push({ type: 'adjudicated', ...(typeof inp.step === 'string' ? { phase: inp.step.split(':')[0] } : {}) });
    for (const f of Array.isArray(inp.forfeit) ? inp.forfeit : []) if (typeof f === 'string') events.push({ type: 'civil_disorder', power: f });
    prev = h;
    const dt = byTick.get(t);
    let seats: ReplaySeat[] = [];
    if (dt) {
      // An in-process reference exchanges no frame: its decision is the engine action it took.
      const action = inProcess ? (inp.actions?.[power] ?? null) : dt.action;
      seats = [{ seat: dt.seat, observation: toJson(dt.observation), action: action ? toJson(action) : null, ack: dt.ack }];
    }
    return { tick: t, state_hash: h, seats, engine_events: events.slice(0, REPLAY_LIMITS.events), oracle_events: oracleEvents.get(t) ?? [] };
  });
}

export function buildReplayFile(rec: EpisodeRecord, episode: EpisodeResult): ReplayFile {
  const decisions: DecisionTrace[] = [];
  const scn = redrive(rec, (d) => decisions.push(d));
  if (scn.replayHash() !== rec.replayHash) throw new Error('the record does not re-simulate to its replay hash');
  if (isDiplomacyRecord(rec)) {
    const initial = initialHash(rec);
    // The adjudicator chain: its head after the last step IS the replay hash.
    if (!rec.perTickHashes.length || rec.perTickHashes[rec.perTickHashes.length - 1] !== rec.replayHash) throw new Error('the per-step chain does not end at the replay hash');
    return {
      replay_version: '1.0',
      scenario_id: rec.scenarioId,
      episode_index: episode.episode_index,
      seed: rec.seed,
      tier: rec.tier,
      mode: rec.mode,
      seat: rec.targetSeat,
      replay_hash: rec.replayHash,
      initial_state_hash: initial,
      ticks: buildDipTicks(rec, decisions, episode, initial),
    };
  }
  const tap = rec.scenarioId === 'grid_tactics' ? tapDuel(rec) : tapRaid(rec);
  const initial = initialHash(rec);
  let chain = initial;
  for (const h of rec.perTickHashes) chain = foldHash(chain, h);
  if (chain !== rec.replayHash) throw new Error('hash chain does not fold to the replay hash');

  const oracleEvents = oracleEventsOf(episode);
  const byTick = new Map(decisions.map((d) => [d.tick, d]));
  const ticks: ReplayTick[] = tap.ticks.slice(0, REPLAY_LIMITS.ticks).map((tt, i) => {
    const d = byTick.get(tt.t);
    return {
      tick: tt.t,
      state_hash: rec.perTickHashes[i],
      seats: d ? [{ seat: d.seat, observation: toJson(d.observation), action: d.action ? toJson(d.action) : null, ack: d.ack }] : [],
      engine_events: tt.events.slice(0, REPLAY_LIMITS.events).map(({ tick: _t, seq: _s, ...rest }) => toJson(rest) as ReplayTick['engine_events'][number]),
      oracle_events: oracleEvents.get(tt.t) ?? [],
    };
  });
  return {
    replay_version: '1.0',
    scenario_id: rec.scenarioId,
    episode_index: episode.episode_index,
    seed: rec.seed,
    tier: rec.tier,
    mode: rec.mode,
    seat: rec.targetSeat,
    replay_hash: rec.replayHash,
    initial_state_hash: initial,
    ticks,
  };
}
