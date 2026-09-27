/**
 * `runTable(spec, peers, opts)`: play one Neutral Ground table.
 *
 *  1. Admission: validate the spec and every peer's meta, then reserve the
 *     per-game budget against the monthly cap (no peer is called if it does
 *     not fit), and take a baseline of every peer's cost counters.
 *  2. Per tick, every live peer is asked CONCURRENTLY for its decision with the
 *     tier's deadlines: the observation is the exact `diplomacy_observation`
 *     frame the CLI sends (a private copy per peer); the answer goes through
 *     the CLI's edge (edge.ts). No answer by Dh (or a throw) is a hard miss
 *     with no retry, and the late answer is dropped: a slow peer only hurts
 *     itself, never the tick. Decisions are applied in POWERS order, so the
 *     outcome does not depend on which peer answered first.
 *  3. Cost: after each decision the peer's counters are metered; once every
 *     live peer's decision for the tick is in, a game total above the budget
 *     (or a broken counter) stops the game BEFORE the tick is applied, and the
 *     episode is recorded as aborted (`budget_exceeded` / `cost_meter_invalid`).
 *  4. The record (record.ts) holds every peer's accepted payloads and the
 *     attested timing; the reports are built by re-driving that record
 *     (reports.ts), and the re-drive must reproduce the live board chain bit
 *     for bit (a difference is a P1 engine bug and throws).
 *
 * Deterministic given deterministic peers and a deterministic `clock`: the
 * random episode id and nonces never reach the record, a hash or a report.
 */

import { diplomacyObservationFrame, DIP_DEFAULT_HORIZON, type TierId } from 'arena-scenarios';
import type { Report } from 'arena-report';
import { randomBytes } from 'node:crypto';
import { POWERS, type Power } from 'wot-engine';
import { GameMeter, type MonthlyCostCap, type Reservation } from './cost.ts';
import { edgeAccept, type EdgeResult } from './edge.ts';
import { assertPeerMeta, slug, type DiplomacyObservationFrame, type Peer, type PeerCost } from './peer.ts';
import { assertTableTier, TABLE_RECORD_FORMAT, type AbortReason, type DecisionLog, type TableRecord, type TableSeatRecord } from './record.ts';
import { buildTableReports, redriveTable, type EngineBuildInfo, type SeatReport } from './reports.ts';
import { TableCore, type CoreDecision } from './table.ts';

export interface TableSeatSpec {
  power: Power;
  /**
   * The connector origin as a RunSpec target descriptor (default: a `.invalid` placeholder naming
   * provider/model). Every seat is `driver: target` with `owner` = its provider slug (contracts 2.8.0);
   * there is no seat role to choose and no pack id.
   */
  endpoint?: { transport: 'rest' | 'ws' | 'mcp' | 'a2a'; url: string };
}

export interface TableSpec {
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`, e.g. `s2026-10-t003`. */
  table_id: string;
  seed: number;
  /** edge, core or frontier; `league` is reserved (contracts 2.8.0) and refused until specified. */
  tier: TierId;
  /** Default 1906 (the RunSpec default). */
  horizon_year?: number;
  seats: TableSeatSpec[];
}

export interface RunTableOptions {
  /** Per-game budget in CHF: the hard stop, and the reservation against the monthly cap. */
  gameBudgetChf: number;
  cap?: MonthlyCostCap;
  /** Monotonic milliseconds for latency (default `performance.now`). */
  clock?: () => number;
  /** Wall time for `started_at` / `finished_at` (default `new Date()`). */
  now?: () => Date;
  engineBuild?: EngineBuildInfo;
}

export type TableOutcome = 'completed' | AbortReason;

export interface TableRun {
  outcome: TableOutcome;
  record: TableRecord;
  reports: SeatReport[];
  cost: TableRecord['cost'];
}

const TABLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const opaqueId = (): string => 'epi_' + [...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('');
const nonce = (): string => randomBytes(12).toString('hex');

function seatRecord(s: TableSeatSpec, peer: Peer): TableSeatRecord {
  const legacy = s as TableSeatSpec & { as?: unknown; pack?: unknown };
  if ((legacy.as !== undefined && legacy.as !== 'target') || legacy.pack !== undefined) {
    throw new Error(`seat ${s.power}: Neutral Ground seats are driver target with owner = provider slug; there is no recorded_peer role and no pack id (contracts 2.8.0)`);
  }
  const m = peer.meta;
  const role = 'target' as const;
  const endpoint = s.endpoint ?? { transport: 'rest' as const, url: `https://neutral-ground.invalid/${m.provider_id}/${slug(m.model_id)}` };
  const out: TableSeatRecord = { power: s.power, role, provider_id: m.provider_id, model_id: m.model_id, region: m.region, endpoint };
  if (m.prompt_digest) out.prompt_digest = m.prompt_digest;
  if (m.connector_version) out.connector_version = m.connector_version;
  return out;
}

interface Asked {
  power: Power;
  result: EdgeResult | { kind: 'fault'; fault: 'timeout' | 'error' };
}

async function ask(peer: Peer, frame: DiplomacyObservationFrame, ctx: Omit<Parameters<Peer>[1], 'signal'>, hardMs: number, clock: () => number): Promise<{ ok: true; value: unknown; latencyMs: number } | { ok: false; fault: 'timeout' | 'error' }> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t0 = clock();
  const timeout = new Promise<{ ok: false; fault: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ ok: false, fault: 'timeout' });
    }, hardMs);
  });
  const call = Promise.resolve()
    .then(() => peer(frame, { ...ctx, signal: ac.signal }))
    .then(
      (value) => ({ ok: true as const, value, latencyMs: Math.max(0, clock() - t0) }),
      () => ({ ok: false as const, fault: 'error' as const }),
    );
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}

export async function runTable(spec: TableSpec, peers: Readonly<Partial<Record<Power, Peer>>>, opts: RunTableOptions): Promise<TableRun> {
  /* ---- admission ---- */
  if (!TABLE_ID_RE.test(spec.table_id)) throw new Error('table_id must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  assertTableTier(spec.tier);
  const horizon = spec.horizon_year ?? DIP_DEFAULT_HORIZON;
  const seatPowers = spec.seats.map((s) => s.power);
  if (seatPowers.length < 1 || seatPowers.length > 7 || new Set(seatPowers).size !== seatPowers.length) throw new Error('a table seats 1..7 peers on distinct powers');
  const peerKeys = Object.keys(peers).filter((k) => peers[k as Power] !== undefined).sort();
  if (peerKeys.join() !== [...seatPowers].sort().join()) throw new Error(`peers [${peerKeys.join(', ')}] do not match the seated powers [${[...seatPowers].sort().join(', ')}]`);
  for (const p of seatPowers) assertPeerMeta(peers[p]!.meta, `peers.${p}.meta`);
  const ordered = (POWERS as readonly Power[]).filter((p) => seatPowers.includes(p));
  const seats = ordered.map((p) => seatRecord(spec.seats.find((s) => s.power === p)!, peers[p]!));
  const clock = opts.clock ?? (() => performance.now());
  const now = opts.now ?? (() => new Date());
  const core = new TableCore({ seed: spec.seed, tier: spec.tier, horizonYear: horizon, secret: '', peerPowers: ordered });

  let reservation: Reservation | undefined;
  if (opts.cap) reservation = opts.cap.admit(spec.table_id, opts.gameBudgetChf);
  const meter = new GameMeter(opts.gameBudgetChf, reservation);
  try {
    for (const p of ordered) meter.baseline(p, peers[p]!.meta.cost);
    const startedAt = now().toISOString();
    const episodeId = opaqueId();

    const actions: Partial<Record<Power, (CoreDecision['payload'])[]>> = {};
    const log: Partial<Record<Power, DecisionLog[]>> = {};
    for (const p of ordered) {
      actions[p] = [];
      log[p] = [];
    }
    let abort: TableRecord['abort'] = null;

    /* ---- the game ---- */
    while (!core.terminal) {
      const tick = core.tick;
      const live = core.livePeers();
      const asked: Asked[] = await Promise.all(
        live.map(async (p): Promise<Asked> => {
          const n = nonce();
          const frame = diplomacyObservationFrame(core.observe(p), { episodeId, nonce: n }) as DiplomacyObservationFrame;
          const r = await ask(peers[p]!, structuredClone(frame), { table_id: spec.table_id, power: p, turn_id: tick, deadline_ms: core.softDeadlineMs, hard_deadline_ms: core.hardDeadlineMs }, core.hardDeadlineMs, clock);
          if (!r.ok) return { power: p, result: { kind: 'fault', fault: r.fault } };
          return { power: p, result: edgeAccept(r.value, { episodeId, turnId: tick, nonce: n, power: p }, r.latencyMs, { softMs: core.softDeadlineMs, hardMs: core.hardDeadlineMs }) };
        }),
      );
      // Meter in POWERS order (deterministic), then decide whether the tick may be applied.
      const costs = new Map<Power, PeerCost>();
      let broken = false;
      for (const a of [...asked].sort((x, y) => ordered.indexOf(x.power) - ordered.indexOf(y.power))) {
        const d = meter.read(a.power, peers[a.power]!.meta.cost, { decision: true });
        if (!d) broken = true;
        costs.set(a.power, d ?? { input_tokens: 0, output_tokens: 0, chf: 0 });
      }
      if (broken || meter.exceeded()) {
        abort = { tick, reason: broken ? 'cost_meter_invalid' : 'budget_exceeded' };
        break;
      }
      const decisions: Partial<Record<Power, CoreDecision>> = {};
      for (const a of asked) {
        const r = a.result;
        const cost = costs.get(a.power)!;
        let entry: DecisionLog;
        if (r.kind === 'accepted') {
          decisions[a.power] = { payload: r.payload, miss: r.miss };
          actions[a.power]!.push(r.payload);
          entry = { tick, miss: r.miss, latency_ms: Math.round(r.latencyMs), frame_bytes: r.frameBytes, cost };
        } else if (r.kind === 'rejected') {
          decisions[a.power] = { payload: null, miss: 'hard' };
          actions[a.power]!.push(null);
          entry = { tick, miss: 'hard', latency_ms: Math.round(r.latencyMs), frame_bytes: r.frameBytes, reject: r.reason, cost };
        } else {
          decisions[a.power] = { payload: null, miss: 'hard' };
          actions[a.power]!.push(null);
          entry = { tick, miss: 'hard', latency_ms: null, frame_bytes: null, fault: r.fault, cost };
        }
        log[a.power]!.push(entry);
      }
      core.step(decisions);
    }

    /* ---- final sweep: late answers and cancelled calls that still billed ---- */
    for (const p of ordered) meter.read(p, peers[p]!.meta.cost, { decision: false, late: true });
    const finishedAt = now().toISOString();

    const record: TableRecord = {
      format: TABLE_RECORD_FORMAT,
      table_id: spec.table_id,
      seed: spec.seed,
      tier: spec.tier,
      horizon_year: horizon,
      secret: '',
      seats,
      actions,
      log,
      abort,
      cost: meter.ledger(),
    };
    const rd = redriveTable(record);
    if (rd.ep.chain !== core.episode().chain || rd.ep.transcript !== core.episode().transcript) {
      throw new Error('P1: re-driving the table record did not reproduce the live board chain or transcript');
    }
    const reports = buildTableReports(record, { startedAt, finishedAt, ...(opts.engineBuild ? { engineBuild: opts.engineBuild } : {}) }, rd);
    return { outcome: abort ? abort.reason : 'completed', record, reports, cost: record.cost };
  } finally {
    reservation?.close();
  }
}

/** The reports of a run, by model (`provider/model`). */
export function reportsByModel(runs: readonly TableRun[]): Map<string, Report[]> {
  const out = new Map<string, Report[]>();
  for (const r of runs) {
    for (const s of r.reports) {
      const k = `${s.provider_id}/${s.model_id}`;
      out.set(k, [...(out.get(k) ?? []), s.report]);
    }
  }
  return out;
}
