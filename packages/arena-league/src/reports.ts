/**
 * Table record → one Report per peer seat ("perspective reports"), and the
 * verify path.
 *
 * Why one report per seat: an EpisodeResult carries the oracle verdicts of ONE
 * primary seat (the catalog order is per episode), and the contract's K7
 * tables report "verdicts per seat". So a table of k peers yields k Reports of
 * the same game (same seed, same `replay_hash`): in report i, peer i is the
 * primary seat (`driver: target`, `inputs_source: recorded`) and every other
 * peer is a `seats[]` entry. Contracts 2.8.0 (run_spec `seats[]`): every
 * Neutral Ground seat is driver `target`, `owner` = the provider slug (the
 * literal `primary` when it is the primary's provider, so one provider is one
 * owner for `collusion`), inputs_source `recorded` → verify: "recorded,
 * replayed". There is no `recorded_peer` seat and no pack id here (Neutral
 * Ground is not a pack; `sx-neutral-ground` is not a contract id).
 * `diplomacy.profile` is `table` when there is any other seat (K7 needs one
 * `target`), else `clean`; `diplomacy.fill` is `house` in both cases.
 *
 * Every report is built by RE-DRIVING the table record through the same core
 * the live run used (`redriveTable`): house seats regenerated from the seed,
 * peer seats from their recorded payloads and attested misses. `verifyTableReport`
 * hands arena-report's `verifyReport` a `rerun` that does exactly that, so the
 * live report and the verified one come from one code path.
 */

import {
  buildReport,
  recordedInputsDigest,
  verifyReport,
  engineBuildDigest,
  engineBuildScopeFor,
  type ContractRunSpec,
  type EngineBuildScope,
  type EpisodeResult,
  type Report,
  type Rerun,
  type SeatProvenanceInput,
  type VerifyOptions,
  type VerifyResult,
} from 'arena-report';
import {
  computeDipVerdicts,
  contractEvaluationHash,
  dipEngagementOf,
  dipOutcomeOf,
  toDipEpisodeResult,
  DIPLOMACY_ORACLE_CATALOG,
  DIPLOMACY_SCENARIO_VERSION,
  type DiplomacyEpisodeRecord,
  type EpisodeResultJson,
  type TimingEntry,
} from 'arena-scenarios';
import { createHash } from 'node:crypto';
import { dipOracles, DIP_SCENARIO_VERSION, POWERS, type DipEpisode, type Power } from 'wot-engine';
import { modelKey } from './peer.ts';
import { assertTableRecord, recordPointer, type TableRecord, type TableSeatRecord } from './record.ts';
import { powerAlive, TableCore, type CoreDecision } from './table.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface EngineBuildInfo {
  digest: string;
  scope: EngineBuildScope;
  manifestDigest?: string;
}

let cachedBuild: EngineBuildInfo | null = null;
/** The scoped engine build digest of this workspace (arena-report `engineBuildDigest`), cached. */
export function defaultEngineBuild(): EngineBuildInfo {
  if (!cachedBuild) {
    const d = engineBuildDigest({ scope: engineBuildScopeFor('diplomacy_standard') });
    cachedBuild = { digest: d.digest, scope: d.scope, manifestDigest: d.manifestDigest };
  }
  return cachedBuild;
}

/* ------------------------------------------------------------- re-drive -- */

export interface Redrive {
  core: TableCore;
  ep: DipEpisode;
  aborted: TableRecord['abort'];
}

/** Re-simulate a table record: house seats from the seed, peer seats from their recorded payloads and misses. */
export function redriveTable(rec: TableRecord): Redrive {
  assertTableRecord(rec);
  const core = new TableCore({ seed: rec.seed, tier: rec.tier, horizonYear: rec.horizon_year, secret: rec.secret, peerPowers: rec.seats.map((s) => s.power) });
  const at = new Map<Power, number>(rec.seats.map((s) => [s.power, 0]));
  while (!core.terminal) {
    if (rec.abort && core.tick === rec.abort.tick) break;
    const decisions: Partial<Record<Power, CoreDecision>> = {};
    for (const p of core.livePeers()) {
      const i = at.get(p)!;
      const log = rec.log[p]![i];
      if (!log || log.tick !== core.tick) throw new Error(`table record: ${p} has no decision recorded for tick ${core.tick}`);
      decisions[p] = { payload: rec.actions[p]![i] ?? null, miss: log.miss };
      at.set(p, i + 1);
    }
    core.step(decisions);
  }
  if (rec.abort && (core.terminal || core.tick !== rec.abort.tick)) throw new Error(`table record: the abort at tick ${rec.abort.tick} is not reachable (the game ended at tick ${core.tick})`);
  for (const s of rec.seats) {
    if (at.get(s.power) !== rec.log[s.power]!.length) throw new Error(`table record: ${s.power} has decisions recorded after its last live tick`);
  }
  return { core, ep: core.episode(), aborted: rec.abort };
}

/* ----------------------------------------------------- perspective data -- */

/** Engine owner keys (collusion is owner-keyed): the primary is `primary`, its provider's other seats too. */
export function ownerOf(rec: TableRecord, primary: Power, p: Power): string {
  const me = rec.seats.find((s) => s.power === primary)!;
  const s = rec.seats.find((x) => x.power === p);
  if (!s) return 'ref:house-diplomat';
  if (p === primary || s.provider_id === me.provider_id) return 'primary';
  return s.provider_id;
}

export function profileFor(rec: TableRecord, primary: Power): 'table' | 'clean' {
  return rec.seats.some((s) => s.power !== primary) ? 'table' : 'clean';
}

/** The RunSpec of the report in which `primary` is the primary seat. Everything here is data from the record. */
export function tableRunSpec(rec: TableRecord, primary: Power): ContractRunSpec {
  const me = rec.seats.find((s) => s.power === primary);
  if (!me) throw new Error(`${primary} is not a peer seat of table ${rec.table_id}`);
  const others = rec.seats.filter((s) => s.power !== primary);
  const spec: ContractRunSpec = {
    scenario_id: 'diplomacy_standard',
    seeds: [rec.seed],
    episodes: 1,
    budget_tier: rec.tier,
    seat: { mode: 'power', position: primary },
    diplomacy: { profile: profileFor(rec, primary), horizon_year: rec.horizon_year, fill: 'house' } as ContractRunSpec['diplomacy'],
    target: { ...me.endpoint, label: modelKey(me).slice(0, 64) },
    labels: { 'ng.table': rec.table_id, 'ng.provider': me.provider_id, 'ng.model': me.model_id },
  };
  if (others.length) {
    spec.seats = others.map((s) => ({ position: s.power, driver: 'target' as const, target: { ...s.endpoint, label: modelKey(s).slice(0, 64) }, owner: ownerOf(rec, primary, s.power) }));
  }
  return spec;
}

function timingOf(rec: TableRecord, p: Power): TimingEntry[] {
  const out: TimingEntry[] = [];
  const actions = rec.actions[p]!;
  rec.log[p]!.forEach((e, i) => {
    const accepted = actions[i] !== null && actions[i] !== undefined;
    if (e.reject) out.push({ event: 'rejected', tick: e.tick, seat: p as TimingEntry['seat'], latencyMs: e.latency_ms, miss: 'none', frameBytes: e.frame_bytes, reject: e.reject as TimingEntry['reject'] });
    out.push({ event: 'decision', tick: e.tick, seat: p as TimingEntry['seat'], latencyMs: accepted ? e.latency_ms : null, miss: e.miss, frameBytes: accepted ? e.frame_bytes : null });
  });
  return out;
}

/** Trajectory class of a table episode: the seed plus the table configuration (conservative, like `dipTrajectoryClass`). */
export function tableTrajectoryClass(rec: TableRecord, primary: Power): string {
  return `sha256:${sha(JSON.stringify({ scenario: 'diplomacy_standard', version: DIPLOMACY_SCENARIO_VERSION, tier: rec.tier, mode: 'power', seat: primary, fill: 'house', table: rec.seats.map((s) => s.power), horizon: rec.horizon_year, secret: null, seeded: { seed: rec.seed } }))}`;
}

/** The arena-scenarios episode record of the game from `primary`'s seat (what `computeDipVerdicts` evaluates). */
export function perspectiveRecord(rec: TableRecord, rd: Redrive, primary: Power): DiplomacyEpisodeRecord {
  const { core, ep } = rd;
  const peers = new Set(rec.seats.map((s) => s.power));
  const kinds = {} as Record<Power, 'target' | 'reference'>;
  const owners = {} as Record<Power, string>;
  for (const p of POWERS) {
    kinds[p] = peers.has(p) ? 'target' : 'reference';
    owners[p] = ownerOf(rec, primary, p);
  }
  const actions = rec.actions[primary]!;
  const targetInputs = rec.log[primary]!.flatMap((e, i) => (actions[i] ? [{ tick: e.tick, payload: structuredClone(actions[i]) as Record<string, unknown> }] : []));
  const { perTickHashes, perTickTranscript } = core.hashes();
  const terminal = rd.aborted ? { outcome: 'aborted' as never, reason: rd.aborted.reason, ticks: ep.tick } : dipOutcomeOf(ep, primary);
  const draft: DiplomacyEpisodeRecord = {
    scenarioId: 'diplomacy_standard',
    scenarioVersion: DIPLOMACY_SCENARIO_VERSION,
    engineCommit: 'unpinned',
    seed: rec.seed,
    tier: rec.tier,
    mode: 'power',
    targetSeat: primary,
    seats: POWERS.map((p) => {
      const r = core.roster[p];
      if (p === primary) return { seat: p, controls: [p], role: 'target' as const, policyRef: 'external' };
      if (peers.has(p)) return { seat: p, controls: [p], role: 'opponent' as const, policyRef: 'external' };
      return { seat: p, controls: [p], role: 'reference' as const, policyRef: `ref:house-diplomat${r.agent === 'house' && r.persona ? `:${r.persona}` : ''}` };
    }) as DiplomacyEpisodeRecord['seats'],
    inputs: structuredClone(ep.inputs) as unknown[],
    timing: timingOf(rec, primary),
    adapterCoercions: [],
    blindingKey: sha(`wot-ng/blinding|${rec.table_id}|${rec.seed}`),
    perTickHashes,
    replayHash: ep.chain,
    terminal,
    trajectoryClass: tableTrajectoryClass(rec, primary),
    diplomacy: {
      engineScenarioVersion: DIP_SCENARIO_VERSION,
      power: primary,
      seatRequest: primary,
      fill: 'house',
      profile: profileFor(rec, primary),
      horizonYear: rec.horizon_year,
      pressRounds: ep.config.pressRounds,
      seatPowers: [...ep.seats] as Power[],
      roster: structuredClone(core.roster),
      seatKinds: kinds,
      owners,
      episodeSecret: '',
      episodeSecretCommitment: null,
      canaryRegistrySeed: rec.seed,
      targetInputs,
      transcriptHash: ep.transcript,
      perTickTranscript,
      engineEvaluationHash: '',
    },
  } as DiplomacyEpisodeRecord;
  // The engine's verdict-object hash of THIS record (misses of the other peers are attested per
  // perspective, so it is derived from the record, then carried as the recorded claim).
  const derived = computeDipVerdicts(draft).engineEvaluationHash;
  return { ...draft, diplomacy: { ...draft.diplomacy, engineEvaluationHash: derived } };
}

function rosterRows(rec: TableRecord, d: DiplomacyEpisodeRecord['diplomacy']): Record<string, unknown>[] {
  const peers = new Set(rec.seats.map((s) => s.power));
  return (POWERS as readonly Power[]).map((p) => {
    const r = d.roster[p];
    const kind = peers.has(p) ? 'target' : 'reference';
    const row: Record<string, unknown> = { power: p, seat_kind: kind };
    if (r.agent === 'house') {
      row.agent = 'house-diplomat';
      if (r.persona) row.persona = r.persona;
    }
    row.owner_key_hash = dipOracles.ownerHash(d.owners[p]);
    return row;
  });
}

const counts = (ep: DipEpisode): { sc: Record<Power, number>; units: Record<Power, number> } => {
  const sc = {} as Record<Power, number>;
  const units = {} as Record<Power, number>;
  for (const p of POWERS) {
    sc[p] = 0;
    units[p] = 0;
  }
  for (const owner of Object.values(ep.state.sc)) if (owner) sc[owner as Power]++;
  for (const u of ep.state.units) units[u.power as Power]++;
  return { sc, units };
};

/** The EpisodeResult of the game from `primary`'s seat (completed, or aborted by the cost meter). */
export function perspectiveResult(rec: TableRecord, rd: Redrive, primary: Power): EpisodeResult {
  const r = perspectiveRecord(rec, rd, primary);
  const replayRef = `${rec.table_id}.table.json`;
  if (!rd.aborted) {
    const res = toDipEpisodeResult(r, { episodeIndex: 0, replayRef }) as EpisodeResultJson & { diplomacy: Record<string, unknown> };
    res.diplomacy.roster = rosterRows(rec, r.diplomacy);
    return res as unknown as EpisodeResult;
  }
  // Aborted by the cost meter: no terminal, every oracle not_assessed (episode_result.schema.json).
  const v = computeDipVerdicts(r);
  const verdicts = DIPLOMACY_ORACLE_CATALOG.map((id) => ({ oracle_id: id, seat: primary, verdict: 'not_assessed' as const, severity: 'note' as const, basis: id === 'shared.budget_violation' ? ('attested' as const) : ('resim' as const), reason_code: 'episode_aborted' }));
  const ep = v.ep ?? rd.ep;
  const c = counts(ep);
  const keyed = ep.press.log.some((m) => m.from === primary && m.sig_mode === 'key');
  return {
    episode_index: 0,
    seed: rec.seed,
    scenario_id: 'diplomacy_standard',
    mode: 'power',
    seat: primary,
    status: 'aborted',
    abort_reason: 'harness_error',
    outcome: 'aborted',
    outcome_reason: rd.aborted.reason,
    terminal_tick: ep.tick,
    replay_hash: ep.chain,
    transcript_hash: ep.transcript,
    evaluation_hash: contractEvaluationHash(verdicts),
    replay_ref: replayRef,
    trajectory_class: r.trajectoryClass,
    budget: v.budget as EpisodeResult['budget'],
    oracles: verdicts,
    diplomacy: {
      power: primary,
      profile: r.diplomacy.profile,
      horizon_year: rec.horizon_year,
      press_rounds: r.diplomacy.pressRounds,
      sig_mode: keyed ? 'key' : 'session',
      sc_counts: c.sc,
      unit_counts: c.units,
      eliminated: (POWERS as readonly Power[]).filter((p) => !powerAlive(ep, p)),
      civil_disorder: ep.forfeited.map((f) => f.power),
      roster: rosterRows(rec, r.diplomacy),
      engagement: dipEngagementOf(ep, primary),
    },
  };
}

/** Seat provenance (EpisodeResult `seats[]`) of the report in which `primary` is the primary seat. */
export function provenanceOf(rec: TableRecord, primary: Power): SeatProvenanceInput[] {
  return (POWERS as readonly Power[]).map((p): SeatProvenanceInput => {
    const s = rec.seats.find((x) => x.power === p);
    if (!s) return { seat: p, driver: 'engine', inputs_source: 'seed_regenerated', agent: 'house-diplomat' };
    const recorded_inputs = { decisions: rec.actions[p]!.length, digest: recordedInputsDigest(rec.actions[p]!), record_pointer: recordPointer(p) };
    return { seat: p, driver: 'target', inputs_source: 'recorded', recorded_inputs };
  });
}

export interface TableReportOptions {
  startedAt: string;
  finishedAt: string;
  engineBuild?: EngineBuildInfo;
}

export interface SeatReport {
  power: Power;
  provider_id: string;
  model_id: string;
  report: Report;
}

/** One Report per peer seat, each built from a re-drive of the record. */
export function buildTableReports(rec: TableRecord, opts: TableReportOptions, rd: Redrive = redriveTable(rec)): SeatReport[] {
  const build = opts.engineBuild ?? defaultEngineBuild();
  return rec.seats.map((s) => {
    const report = buildReport({
      runSpec: tableRunSpec(rec, s.power),
      episodes: [perspectiveResult(rec, rd, s.power)],
      engineBuild: build.digest,
      engineBuildScope: build.scope,
      ...(build.manifestDigest ? { engineSourceManifestDigest: build.manifestDigest } : {}),
      scenarioVersion: DIPLOMACY_SCENARIO_VERSION,
      startedAt: opts.startedAt,
      finishedAt: opts.finishedAt,
      mode: 'local',
      seats: [provenanceOf(rec, s.power)],
    });
    return { power: s.power, provider_id: s.provider_id, model_id: s.model_id, report };
  });
}

/* --------------------------------------------------------------- verify -- */

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/**
 * `verifyReport` over a table report and its record (ADR-004): house seats are regenerated from
 * the seed, every seat the RunSpec declares as recorded is replayed from the record, the recorded
 * inputs' digests are recomputed, and the whole report is rebuilt and compared. `llm_peer` seats
 * come back as "recorded, not regenerable". A record that does not fit the report's RunSpec makes
 * the report unverifiable; a record whose moves were altered re-simulates to different claims.
 */
export function verifyTableReport(report: unknown, record: unknown, opts: VerifyOptions = {}): VerifyResult {
  const rerun: Rerun = (spec, seed, ctx) => {
    assertTableRecord(record);
    const rec = record;
    if (spec.scenario_id !== 'diplomacy_standard') throw new Error('not a diplomacy_standard run');
    if (seed !== rec.seed || spec.budget_tier !== rec.tier) throw new Error('the record is of another seed or tier');
    const primary = ctx.seat;
    if (primary === 'auto' || !rec.seats.some((s) => s.power === primary)) throw new Error(`the record has no peer at the primary seat ${String(primary)}`);
    const want = tableRunSpec(rec, primary as Power);
    if (canon(spec) !== canon(want)) throw new Error('the report\'s RunSpec does not describe this table record (seats, roles, owners, endpoints or labels differ)');
    const roles = new Map(rec.seats.map((s) => [s.power as string, 'target']));
    if (ctx.recordedSeats.length !== roles.size || ctx.recordedSeats.some((r) => roles.get(r.seat) !== r.driver)) throw new Error('the RunSpec\'s recorded seats differ from the record\'s peer seats');
    if (ctx.regeneratedSeats.some((p) => roles.has(p))) throw new Error('a peer seat was declared as engine-regenerated');
    const rd = redriveTable(rec);
    const result = perspectiveResult(rec, rd, primary as Power);
    const recordedActions: Partial<Record<Power, readonly unknown[]>> = {};
    for (const s of rec.seats) recordedActions[s.power] = rec.actions[s.power]!;
    return { result, recordedActions };
  };
  return verifyReport(report, rerun, opts);
}
