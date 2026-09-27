/**
 * `verifyReport`: treat a Report as INPUTS plus CLAIMS and recompute every
 * claim from the inputs (docs/security/threat-model-arena.md §3.2).
 *
 * Inputs taken from the report: the RunSpec (scenario, seeds, tier, seating),
 * each episode's disclosed blinding key and replay reference, and the run
 * metadata (id, times, tool, engine build). Everything else is a claim:
 * replay hashes, outcomes, terminal ticks, trajectory classes, budget
 * counters, every oracle verdict, the run-level verdicts, the summary, the
 * oracle catalog, the budget limits and the disclosure. None of them is ever
 * read back: each episode is re-simulated through `rerun`, the report is
 * rebuilt from the regenerated episodes with `buildReport`, and the two are
 * compared field by field.
 *
 * The seed and seat handed to `rerun` are derived from the RunSpec
 * (`seeds[i mod n]`, duel A/B alternation), NOT from the episode record, so a
 * report that relabels an episode's seed cannot steer its own re-simulation.
 *
 * Contract for `rerun` (the CLI's implementation; ADR-004): regenerate every
 * `seed_regenerated` seat (bosses, house bot, reference fill, Byzantine peers,
 * house diplomats) from the seed and take the `ctx.recordedSeats` (the target,
 * and the `run.spec.seats[]` of a table or an LLM-peer pack) from the episode
 * record, never regenerating them; throw if the episode cannot be re-simulated
 * (record missing, unsupported build, inputs for a regenerated seat that
 * differ from the regenerated ones). A throw makes the episode `unverifiable`,
 * never `match`. Which seats are recorded comes from the RunSpec (the primary
 * seat plus `seats[]`), never from the episode's own `seats[]` list.
 *
 * A rerun that also returns the action arrays it replayed for the recorded
 * seats (`RerunOutput.recordedActions`) lets `verifyReport` recompute each
 * `recorded_inputs.digest`: a forged digest is a mismatch, and forged recorded
 * actions re-simulate to a different `replay_hash`, which is a mismatch too.
 * Recorded seats are reported as "recorded, replayed" and `llm_peer` seats as
 * "recorded, not regenerable" (the peer model is never re-run), not as
 * unverifiable; the exit code is unchanged by them (ADR-004 §3).
 *
 * Signed reports (contracts 2.2.0): with `opts.publicKey` the `signing` seal
 * is checked FIRST, before anything is re-simulated; a missing or failing
 * signature makes the report `unverifiable` (exit 2, errors.md
 * `signature_invalid`). Without a key, `signing`, `run.hosted`,
 * `run.target_ownership` and every `recorded` not-assessed entry are listed
 * as unverified (attribution, not reproducibility).
 *
 * Only fields that are wall-clock observations and cannot be re-derived
 * (`duration_ms`, `budget.decision_ms_*`) are carried over from the report
 * when the re-run does not produce them; they are listed in `unverified`.
 * `budget.press.redactions` (contracts 2.5.0) is attested by the redacting
 * producer and is carried over as recorded, never compared to a re-sim
 * value; it is listed in `unverified` when present.
 */

import { buildReport, expectedSeatProvenance, recordedInputsDigest, resolvedFill, resolvedSeat, seatModeOf, seedFor, type ExpectedSeat } from './build.ts';
import { EXIT_CODES, type ExitCode } from './exit-codes.ts';
import { formatErrors, validateEpisodeResultSchema, validateReportSchema } from './schemas.ts';
import { verifyReportSignature, type Ed25519KeyInput } from './signing.ts';
import type { Basis, ContractRunSpec, EpisodeResult, EpisodeSeat, InputsSource, PlayerSeat, RecordedInputs, Report, SeatDriver, SeatMode, TierId, VerdictSeat } from './types.ts';

/** A seat whose actions `rerun` must take from the episode record (ADR-004). */
export interface RecordedSeatContext {
  seat: PlayerSeat;
  driver: Exclude<SeatDriver, 'engine'>;
  inputs_source: Exclude<InputsSource, 'seed_regenerated'>;
  /** The report's commitment to the seat's actions (absent on a report without `seats[]`). */
  recorded_inputs?: RecordedInputs;
}

export interface RerunContext {
  episodeIndex: number;
  seed: number;
  /** The target's seat from the RunSpec (`auto` = a power chosen by the scenario from the seed). */
  seat: VerdictSeat | 'auto';
  mode: SeatMode;
  fill?: 'coordinated' | 'naive';
  tier: TierId;
  /** The episode's disclosed egress blinding key (an input of the re-simulation), when the report carries one. */
  blindingKey?: string;
  /** Where the episode record lives (relative to the report), when the report carries one. */
  replayRef?: string;
  /** ADR-004: replay these seats from the record; never regenerate them. Derived from the RunSpec. */
  recordedSeats: RecordedSeatContext[];
  /** ADR-004: regenerate these seats from the seed; a record that disagrees makes the episode unverifiable. */
  regeneratedSeats: PlayerSeat[];
}

/** What a rerun may return instead of a bare EpisodeResult: plus the recorded action arrays it replayed, per seat, in decision order. */
export interface RerunOutput {
  result: EpisodeResult;
  recordedActions?: Partial<Record<PlayerSeat, readonly unknown[]>>;
}

/**
 * The re-simulation callback. Declared with method syntax so its `spec`
 * parameter is bivariant: a rerun written for Phase-7 RunSpecs (the CLI's)
 * stays assignable although verify can hand it any contract RunSpec; a rerun
 * that cannot run a scenario throws, which makes the episode unverifiable.
 */
export type Rerun = { rerun(spec: ContractRunSpec, seed: number, ctx: RerunContext): EpisodeResult | RerunOutput }['rerun'];

export interface VerifyOptions {
  /** Engine build hashes this verifier can re-simulate. When given, any other build is refused (exit 3). */
  engineBuilds?: readonly string[];
  /** Diffs listed per episode before truncation (default 64). */
  maxDiffsPerEpisode?: number;
  /** Check the `signing` seal with this key before anything else; a missing or bad signature is unverifiable (exit 2). */
  publicKey?: Ed25519KeyInput;
}

/** How one seat's actions were obtained by this verification (ADR-004). */
export interface SeatProvenanceResult {
  episode_index: number;
  seat: PlayerSeat;
  driver: SeatDriver;
  inputs_source: InputsSource;
  verification: 'regenerated' | 'recorded_replayed' | 'recorded_not_regenerable';
  /** Human wording. Never "verified", "reproduced" or "regenerated" for a recorded seat (ADR-004 §5). */
  label: 'regenerated from seed' | 'recorded, replayed' | 'recorded, not regenerable';
  /** `recorded_inputs.digest` recomputed from the actions the re-run replayed. */
  inputs_digest: 'match' | 'mismatch' | 'unchecked' | 'not_applicable';
}

export interface SignatureResult {
  checked: boolean;
  status: 'valid' | 'invalid' | 'unsigned' | 'not_checked';
  kid?: string;
  errors: string[];
}

export interface VerifyDiff {
  /** JSON pointer into the report. */
  path: string;
  reported: unknown;
  recomputed: unknown;
  /** For an oracle verdict: its basis (attested verdicts depend on the timing log). */
  basis?: Basis;
}

export interface EpisodeVerification {
  episode_index: number;
  seed: number;
  status: 'match' | 'mismatch' | 'unverifiable';
  replay_hash: { reported: string | null; recomputed: string | null };
  diffs: VerifyDiff[];
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  status: 'verified' | 'mismatch' | 'unverifiable' | 'unsupported_engine';
  exitCode: ExitCode;
  episodes: EpisodeVerification[];
  /** Run-level differences (catalog, budget limits, run oracles, summary, disclosure, episode count). */
  run: VerifyDiff[];
  /** Input errors (schema, hostile structure, engine build). */
  errors: string[];
  /** Report fields accepted as recorded because nothing can re-derive them. */
  unverified: string[];
  /** Per seat of every episode: how its actions were obtained (ADR-004). */
  provenance: SeatProvenanceResult[];
  /** The seats other than the primary target whose moves are recorded inputs (ADR-004 §3), sorted. */
  recorded_seats: { episode: number; seat: PlayerSeat; inputs_source: InputsSource }[];
  signature: SignatureResult;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 64;

function hostileStructure(v: unknown): string | null {
  const stack: [unknown, number, string][] = [[v, 0, '']];
  while (stack.length) {
    const [x, depth, path] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (depth > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH} at ${path || '/'}`;
    for (const k of Object.keys(x)) {
      if (FORBIDDEN_KEYS.has(k)) return `forbidden key ${k} at ${path || '/'}`;
      stack.push([(x as Record<string, unknown>)[k], depth + 1, `${path}/${k}`]);
    }
  }
  return null;
}

function esc(k: string | number): string {
  return String(k).replace(/~/g, '~0').replace(/\//g, '~1');
}

function diff(reported: unknown, recomputed: unknown, path: string, out: VerifyDiff[], max: number): void {
  if (out.length >= max) return;
  if (reported === recomputed) return;
  const ro = reported !== null && typeof reported === 'object';
  const co = recomputed !== null && typeof recomputed === 'object';
  if (ro && co && Array.isArray(reported) === Array.isArray(recomputed)) {
    if (Array.isArray(reported)) {
      const b = recomputed as unknown[];
      const n = Math.max(reported.length, b.length);
      for (let i = 0; i < n; i++) diff(reported[i], b[i], `${path}/${i}`, out, max);
      return;
    }
    const a = reported as Record<string, unknown>;
    const b = recomputed as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) diff(a[k], b[k], `${path}/${esc(k)}`, out, max);
    return;
  }
  out.push({ path, reported: reported === undefined ? null : reported, recomputed: recomputed === undefined ? null : recomputed });
}

function annotateBasis(diffs: VerifyDiff[], ep: EpisodeResult, base: string): void {
  for (const d of diffs) {
    const m = d.path.slice(base.length).match(/^\/oracles\/(\d+)/);
    if (m) {
      const v = ep.oracles[Number(m[1])];
      if (v) d.basis = v.basis;
    }
  }
}

function result(status: VerifyResult['status'], parts: Partial<VerifyResult>): VerifyResult {
  const exitCode: ExitCode =
    status === 'verified' ? EXIT_CODES.ok : status === 'mismatch' ? EXIT_CODES.findings : status === 'unverifiable' ? EXIT_CODES.error : EXIT_CODES.misconfig;
  return {
    ok: status === 'verified',
    status,
    exitCode,
    episodes: [],
    run: [],
    errors: [],
    unverified: [],
    provenance: [],
    recorded_seats: [],
    signature: { checked: false, status: 'not_checked', errors: [] },
    ...parts,
  };
}

const LABEL = { regenerated: 'regenerated from seed', recorded_replayed: 'recorded, replayed', recorded_not_regenerable: 'recorded, not regenerable' } as const;

function isRerunOutput(x: unknown): x is RerunOutput {
  return typeof x === 'object' && x !== null && 'result' in x && !('episode_index' in x);
}

/** The recorded pin of `scenario.reference_policy` (`ref:<name>@<commit>`), '' when unpinned. */
function referencePin(policy: string | undefined): string {
  return /@([0-9a-f]{7,40})$/.exec(policy ?? '')?.[1] ?? '';
}

/** Pin the per-episode spec to one seed and the resolved seat, so the callback cannot mis-seat an episode. */
function episodeSpec(spec: ContractRunSpec, index: number): ContractRunSpec {
  const mode = seatModeOf(spec);
  const seat = resolvedSeat(spec, index);
  const s: ContractRunSpec = { ...(JSON.parse(JSON.stringify(spec)) as ContractRunSpec), seeds: [seedFor(spec, index)], episodes: 1 };
  if (mode === 'squad') s.seat = { mode };
  else if (mode === 'duel') s.seat = { mode, position: seat as 'A' | 'B' };
  else if (mode === 'power') s.seat = { mode, position: seat as 'auto' };
  else s.seat = { mode, position: seat as 'm1', fill: resolvedFill(spec) };
  return s;
}

/** Compare an episode's `seats[]` with the RunSpec-derived provenance (ADR-004 §2); disagreements are mismatches. */
function provenanceDiffs(rep: EpisodeResult, expected: readonly ExpectedSeat[], base: string, requireSeats: boolean): { diffs: VerifyDiff[]; bySeat: Map<PlayerSeat, { entry?: EpisodeSeat; index: number }> } {
  const diffs: VerifyDiff[] = [];
  const bySeat = new Map<PlayerSeat, { entry?: EpisodeSeat; index: number }>();
  if (!rep.seats) {
    if (requireSeats) diffs.push({ path: `${base}/seats`, reported: null, recomputed: 'required: run.spec.seats[] declares recorded seats, whose recorded_inputs the episode must commit to' });
    return { diffs, bySeat };
  }
  const listed = rep.seats.map((s) => s.seat);
  const want = expected.map((x) => x.seat);
  if (listed.join() !== want.join()) diffs.push({ path: `${base}/seats`, reported: listed, recomputed: want });
  rep.seats.forEach((s, k) => {
    bySeat.set(s.seat, { entry: s, index: k });
    const x = expected.find((y) => y.seat === s.seat);
    if (!x) return;
    if (s.driver !== x.driver) diffs.push({ path: `${base}/seats/${k}/driver`, reported: s.driver, recomputed: x.driver });
    if (!x.allowed.includes(s.inputs_source)) diffs.push({ path: `${base}/seats/${k}/inputs_source`, reported: s.inputs_source, recomputed: x.allowed.join(' | ') });
  });
  return { diffs, bySeat };
}

export function verifyReport(report: unknown, rerun: Rerun, opts: VerifyOptions = {}): VerifyResult {
  const maxDiffs = opts.maxDiffsPerEpisode ?? 64;

  // 1. Hostile-file handling BEFORE anything is re-simulated (threat-model-arena.md §3.2.6).
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return result('unverifiable', { errors: ['the report is not a JSON object'] });
  const hostile = hostileStructure(report);
  if (hostile) return result('unverifiable', { errors: [`hostile structure: ${hostile}`] });
  if (!validateReportSchema(report)) return result('unverifiable', { errors: formatErrors(validateReportSchema.errors, 20).map((e) => `report.schema.json: ${e}`) });
  const r = report as Report;

  // 2. The seal, when a key is given: before anything is re-simulated (signing.md §2; errors.md signature_invalid).
  let signature: SignatureResult = { checked: false, status: 'not_checked', errors: [] };
  if (opts.publicKey !== undefined) {
    const c = verifyReportSignature(r, opts.publicKey);
    signature = { checked: true, status: c.status, ...(c.kid ? { kid: c.kid } : {}), errors: c.errors };
    if (!c.ok) return result('unverifiable', { signature, errors: c.errors.map((e) => `signature_invalid: ${e}`) });
  }

  // 3. Build pin: never "best-effort" verify with a different engine (§3.2.4).
  if (opts.engineBuilds && !opts.engineBuilds.includes(r.engine.build_hash)) {
    return result('unsupported_engine', { signature, errors: [`the report was produced by engine build ${r.engine.build_hash} (${r.engine.version}); this verifier has ${opts.engineBuilds.join(', ') || 'none'}`] });
  }

  const spec = r.run.spec;
  const unverified = new Set<string>(['/run/started_at', '/run/finished_at', '/run/mode', '/run/tool']);
  if (r.run.target_ownership) unverified.add('/run/target_ownership');
  if (r.run.hosted) unverified.add('/run/hosted');
  if (r.signing && !signature.checked) unverified.add('/signing');
  (r.not_assessed ?? []).forEach((e, k) => {
    if (e.basis === 'recorded') unverified.add(`/not_assessed/${k}`);
  });
  const episodes: EpisodeVerification[] = [];
  const regenerated: EpisodeResult[] = [];
  const runDiffs: VerifyDiff[] = [];
  const provenance: SeatProvenanceResult[] = [];
  if (r.episodes.length !== spec.episodes) runDiffs.push({ path: '/episodes/length', reported: r.episodes.length, recomputed: spec.episodes });
  const mode = seatModeOf(spec);

  // 4. Re-simulate every episode the RunSpec asked for.
  for (let i = 0; i < spec.episodes; i++) {
    const seed = seedFor(spec, i);
    const rep = r.episodes[i];
    const base = `/episodes/${i}`;
    const ev: EpisodeVerification = { episode_index: i, seed, status: 'unverifiable', replay_hash: { reported: rep?.replay_hash ?? null, recomputed: null }, diffs: [] };
    episodes.push(ev);
    const specSeat = resolvedSeat(spec, i);
    // With `auto`, the power is the scenario's function of the seed: take the episode's claim here; the re-run's seat is compared below.
    const primary: VerdictSeat | undefined = specSeat === 'auto' ? rep?.seat : specSeat;
    const expected = primary ? expectedSeatProvenance(spec, mode, primary) : [];
    const pv: ReturnType<typeof provenanceDiffs> = rep ? provenanceDiffs(rep, expected, base, !!spec.seats?.length) : { diffs: [], bySeat: new Map() };
    const recordedSeats: RecordedSeatContext[] = [];
    for (const x of expected) {
      if (x.driver === 'engine') continue;
      const entry = pv.bySeat.get(x.seat)?.entry;
      const source = (entry && x.allowed.includes(entry.inputs_source) ? entry.inputs_source : x.allowed[0]) as RecordedSeatContext['inputs_source'];
      recordedSeats.push({ seat: x.seat, driver: x.driver as RecordedSeatContext['driver'], inputs_source: source, ...(entry?.recorded_inputs ? { recorded_inputs: { ...entry.recorded_inputs } } : {}) });
    }
    const ctx: RerunContext = {
      episodeIndex: i,
      seed,
      seat: specSeat,
      mode,
      ...(resolvedFill(spec) ? { fill: resolvedFill(spec) } : {}),
      tier: spec.budget_tier,
      ...(rep?.blinding_key ? { blindingKey: rep.blinding_key } : {}),
      ...(rep?.replay_ref ? { replayRef: rep.replay_ref } : {}),
      recordedSeats,
      regeneratedSeats: expected.filter((x) => x.driver === 'engine').map((x) => x.seat),
    };
    let re: EpisodeResult;
    let recordedActions: RerunOutput['recordedActions'];
    try {
      const out = rerun(episodeSpec(spec, i), seed, ctx);
      if (isRerunOutput(out)) {
        re = out.result;
        recordedActions = out.recordedActions;
      } else re = out;
    } catch (e) {
      ev.error = `episode ${i} (seed ${seed}) cannot be regenerated: ${(e as Error)?.message ?? String(e)}`.slice(0, 500);
      continue;
    }
    re = JSON.parse(JSON.stringify(re ?? null)) as EpisodeResult;
    if (re && typeof re === 'object') re.episode_index = i;
    if (!validateEpisodeResultSchema(re)) {
      ev.error = `episode ${i}: the re-simulation did not produce a valid EpisodeResult: ${formatErrors(validateEpisodeResultSchema.errors, 3).join('; ')}`;
      continue;
    }
    if (re.seed !== seed || re.scenario_id !== spec.scenario_id || re.budget.tier !== spec.budget_tier) {
      ev.error = `episode ${i}: the re-simulation ran ${re.scenario_id}/${re.budget.tier}/seed ${re.seed}, not ${spec.scenario_id}/${spec.budget_tier}/seed ${seed}`;
      continue;
    }
    // Wall-clock observations: accepted as recorded, flagged as unverified.
    if (rep) {
      if (rep.duration_ms !== undefined && re.duration_ms === undefined) {
        re.duration_ms = rep.duration_ms;
        unverified.add(`${base}/duration_ms`);
      }
      for (const k of ['decision_ms_p50', 'decision_ms_p95', 'decision_ms_max'] as const) {
        if (rep.budget?.[k] !== undefined && re.budget[k] === undefined) {
          re.budget[k] = rep.budget[k];
          unverified.add(`${base}/budget/${k}`);
        }
      }
      if (rep.replay_ref !== undefined && re.replay_ref === undefined) re.replay_ref = rep.replay_ref;
    }
    // 2.5.0 `budget.press.redactions` (G-40): attested by the producer that redacted at the edge; the
    // record holds only the redacted bytes, so no re-simulation can re-derive it. Never compared: the
    // reported value (or its absence) is carried over as recorded, and flagged when present.
    {
      const reported = rep?.budget?.press?.redactions;
      if (reported !== undefined) {
        re.budget.press = { ...(re.budget.press ?? {}), redactions: reported };
        unverified.add(`${base}/budget/press/redactions`);
      } else if (re.budget.press && 'redactions' in re.budget.press) {
        const { redactions: _drop, ...press } = re.budget.press;
        re.budget.press = press;
      }
    }

    // ADR-004: recorded inputs. The digest is recomputed from the actions the re-run replayed; the
    // replayed actions themselves are covered by the replay_hash comparison (forged moves re-simulate
    // to a different hash).
    const digestState = new Map<PlayerSeat, SeatProvenanceResult['inputs_digest']>();
    for (const rs of recordedSeats) {
      const at = pv.bySeat.get(rs.seat);
      const actions = recordedActions?.[rs.seat];
      if (!rs.recorded_inputs || !at) {
        digestState.set(rs.seat, 'unchecked');
        continue;
      }
      const p = `${base}/seats/${at.index}/recorded_inputs`;
      if (!actions) {
        digestState.set(rs.seat, 'unchecked');
        unverified.add(`${p}/digest`);
        continue;
      }
      let ok = true;
      const digest = recordedInputsDigest(actions);
      if (digest !== rs.recorded_inputs.digest) {
        pv.diffs.push({ path: `${p}/digest`, reported: rs.recorded_inputs.digest, recomputed: digest });
        ok = false;
      }
      if (actions.length !== rs.recorded_inputs.decisions) {
        pv.diffs.push({ path: `${p}/decisions`, reported: rs.recorded_inputs.decisions, recomputed: actions.length });
        ok = false;
      }
      digestState.set(rs.seat, ok ? 'match' : 'mismatch');
    }
    // Seat provenance is an input fixed by the RunSpec (checked above) plus the recorded-input commitments
    // (checked just now); a re-run that does not rebuild the list gets the reported one.
    if (rep?.seats && re.seats === undefined) {
      re.seats = JSON.parse(JSON.stringify(rep.seats)) as EpisodeSeat[];
      rep.seats.forEach((s, k) => {
        if (s.peer) unverified.add(`${base}/seats/${k}/peer`);
        if (s.agent) unverified.add(`${base}/seats/${k}/agent`);
      });
    }
    for (const x of expected) {
      const entry = pv.bySeat.get(x.seat)?.entry;
      const source = entry && x.allowed.includes(entry.inputs_source) ? entry.inputs_source : x.allowed[0];
      const verification: SeatProvenanceResult['verification'] = x.driver === 'engine' ? 'regenerated' : source === 'llm_peer' ? 'recorded_not_regenerable' : 'recorded_replayed';
      provenance.push({
        episode_index: i,
        seat: x.seat,
        driver: x.driver,
        inputs_source: source,
        verification,
        label: LABEL[verification],
        inputs_digest: x.driver === 'engine' ? 'not_applicable' : (digestState.get(x.seat) ?? 'unchecked'),
      });
    }

    regenerated.push(re);
    ev.replay_hash.recomputed = re.replay_hash;
    ev.diffs.push(...pv.diffs.slice(0, maxDiffs));
    diff(rep, re, base, ev.diffs, maxDiffs);
    if (rep) annotateBasis(ev.diffs, rep, base);
    ev.status = ev.diffs.length ? 'mismatch' : 'match';
  }

  // 5. Rebuild the run-level claims from the regenerated episodes only.
  const allRegenerated = episodes.every((e) => e.status !== 'unverifiable');
  if (allRegenerated) {
    try {
      const rebuilt = buildReport({
        runSpec: spec,
        episodes: regenerated,
        engineBuild: r.engine.build_hash,
        scenarioVersion: r.scenario.version,
        startedAt: r.run.started_at,
        finishedAt: r.run.finished_at,
        runId: r.run.run_id,
        mode: r.run.mode,
        tool: r.run.tool,
        engineVersion: r.engine.version,
        ...(r.engine.commit ? { engineCommit: r.engine.commit } : {}),
        ...(r.engine.build_scope ? { engineBuildScope: r.engine.build_scope } : {}),
        ...(r.engine.source_manifest_digest ? { engineSourceManifestDigest: r.engine.source_manifest_digest } : {}),
        referencePolicyPin: referencePin(r.scenario.reference_policy),
        ...(r.run.target_ownership ? { targetOwnership: r.run.target_ownership } : {}),
        ...(r.run.hosted ? { hosted: r.run.hosted } : {}),
        // `recorded` entries are inputs (bound by the signature, listed as unverified); every `resim` entry is recomputed.
        notAssessed: (r.not_assessed ?? []).filter((e) => e.basis === 'recorded'),
        emitNotAssessed: r.not_assessed !== undefined,
      });
      const keys = ['report_version', 'scenario', 'budget_limits', 'run_oracles', 'summary', 'disclosure', ...(r.not_assessed !== undefined ? (['not_assessed'] as const) : [])] as const;
      for (const k of keys) diff(r[k], rebuilt[k], `/${k}`, runDiffs, 256);
    } catch (e) {
      runDiffs.push({ path: '/', reported: 'report', recomputed: `the regenerated episodes do not form a valid report: ${(e as Error).message.slice(0, 400)}` });
    }
  }

  const anyMismatch = runDiffs.length > 0 || episodes.some((e) => e.status === 'mismatch');
  const status: VerifyResult['status'] = anyMismatch ? 'mismatch' : allRegenerated ? 'verified' : 'unverifiable';
  const errors = episodes.filter((e) => e.error).map((e) => e.error as string);
  const recorded_seats = provenance
    .filter((p) => p.driver !== 'engine' && !(r.episodes[p.episode_index] && (mode === 'squad' || p.seat === r.episodes[p.episode_index].seat)))
    .map((p) => ({ episode: p.episode_index, seat: p.seat, inputs_source: p.inputs_source }));
  return result(status, { episodes, run: runDiffs, errors, unverified: [...unverified].sort(), provenance, recorded_seats, signature });
}
