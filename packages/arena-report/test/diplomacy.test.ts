/**
 * diplomacy_standard reports (contracts 2.1.0/2.2.0) and the hosted golden:
 * buildReport rebuilds report.schema.json examples[1] and [2] from their
 * inputs (catalog, budget limits, summary, the not-assessed section,
 * transcript/evaluation hash passthrough, run.hosted passthrough), and
 * verifyReport treats the LLM-peer seat as "recorded, not regenerable"
 * (ADR-004) and checks the seal first when a key is given.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DIPLOMACY_CATALOG,
  EXIT_CODES,
  buildReport,
  recordedInputsDigest,
  toSarif,
  verifyReport,
  type BuildReportInput,
  type EpisodeResult,
  type Report,
  type RerunContext,
  type RunSpec,
} from '../src/index.ts';
import { SCENARIO_IDS, scenarioModule } from 'arena-scenarios';
import { reportSchema } from '../src/schemas.ts';
import { RFC8032_TEST1_PUBLIC_JWK, buildGoldenReport, goldenRerun } from '../scripts/golden.ts';
import { clone } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const example = (i: number) => clone((reportSchema.examples as Report[])[i]);

/** The inputs a runner would have held for a contract example report. */
function inputsOf(r: Report): BuildReportInput {
  return {
    runSpec: r.run.spec,
    episodes: r.episodes,
    engineBuild: r.engine.build_hash,
    // 2.3.0: the runner records the scope it hashed with; examples[1] and [2] predate build_scope, so they carry none.
    ...(r.engine.build_scope ? { engineBuildScope: r.engine.build_scope } : {}),
    ...(r.engine.source_manifest_digest ? { engineSourceManifestDigest: r.engine.source_manifest_digest } : {}),
    scenarioVersion: r.scenario.version,
    startedAt: r.run.started_at,
    finishedAt: r.run.finished_at,
    runId: r.run.run_id,
    tool: r.run.tool,
    engineVersion: r.engine.version,
    ...(r.engine.commit ? { engineCommit: r.engine.commit } : {}),
    referencePolicyPin: '4f2c9a1',
    ...(r.run.target_ownership ? { targetOwnership: r.run.target_ownership } : {}),
    ...(r.run.hosted ? { hosted: r.run.hosted } : {}),
    notAssessed: (r.not_assessed ?? []).filter((e) => e.basis === 'recorded'),
    emitNotAssessed: r.not_assessed !== undefined,
  };
}

test('the Diplomacy catalog is exactly the one the contract examples carry', () => {
  assert.deepEqual(DIPLOMACY_CATALOG, example(1).scenario.oracles);
  assert.deepEqual(DIPLOMACY_CATALOG, example(2).scenario.oracles);
});

test('the Diplomacy catalog agrees with the arena-scenarios descriptor once diplomacy_standard is registered there', (t) => {
  if (!(SCENARIO_IDS as readonly string[]).includes('diplomacy_standard')) return t.skip('arena-scenarios does not register diplomacy_standard in this tree');
  const d = scenarioModule('diplomacy_standard' as (typeof SCENARIO_IDS)[number]).describe();
  assert.deepEqual(
    d.oracles.map((o) => [o.oracleId, o.primary, o.basis, o.severityOnFail]),
    DIPLOMACY_CATALOG.map((o) => [o.oracle_id, o.primary === true, o.basis, o.severities]),
  );
});

test('buildReport rebuilds report.schema.json examples[1] (local Diplomacy) and examples[2] (hosted, recorded LLM peer) from their inputs', () => {
  const one = example(1);
  assert.deepEqual(buildReport(inputsOf(one)), one);
  const two = example(2);
  const rebuilt = buildReport(inputsOf(two));
  const { signing: _s, ...unsigned } = two;
  assert.deepEqual(rebuilt, unsigned, 'everything but the seal, which only signReport writes');
  // Computed, not copied: the resim entries of the not-assessed section.
  assert.deepEqual(
    rebuilt.not_assessed!.filter((e) => e.basis === 'resim').map((e) => `${e.kind}:${e.id}:${e.reason_code}`),
    ['oracle:diplomacy_standard.collusion:oracle_not_assessed', 'oracle:diplomacy_standard.commitment_broken:oracle_not_assessed', 'seat:france:recorded_not_regenerated', 'property:diplomacy.commitment_signatures:commitments_unsigned'],
  );
  assert.equal(rebuilt.episodes[0].transcript_hash, two.episodes[0].transcript_hash);
  assert.equal(rebuilt.episodes[0].evaluation_hash, two.episodes[0].evaluation_hash);
  assert.equal(rebuilt.budget_limits.max_inbound_frame_bytes, 16384);
  assert.equal(rebuilt.run.mode, 'hosted');
});

/* --------------------------------------------- ADR-004 on a peer table -- */

const ACTIONS: Record<string, unknown[]> = {
  germany: [{ orders: ['A ber - kie'] }, null, { orders: ['F kie - hol'] }],
  france: [{ orders: ['A par - bur'] }, { orders: ['F bre - mao'] }, null],
};

/** examples[2] with recorded-input digests over known action arrays (the example's are placeholders). */
function peerReport(): Report {
  const r = example(2);
  delete r.signing;
  for (const s of r.episodes[0].seats!) if (s.recorded_inputs) s.recorded_inputs = { ...s.recorded_inputs, decisions: ACTIONS[s.seat].length, digest: recordedInputsDigest(ACTIONS[s.seat]) };
  return buildReport(inputsOf(r));
}

/** A stand-in for the CLI's Diplomacy rerun: the episode re-simulated from the recorded seats' actions. */
function peerRerun(episode: EpisodeResult, seen: RerunContext[] = [], actions = ACTIONS) {
  return (_spec: RunSpec, _seed: number, ctx: RerunContext) => {
    seen.push(ctx);
    const { seats: _drop, ...result } = clone(episode);
    return { result: result as EpisodeResult, recordedActions: Object.fromEntries(ctx.recordedSeats.map((s) => [s.seat, actions[s.seat]])) };
  };
}

test('verify: an LLM-peer seat is replayed from its recorded inputs and reported "recorded, not regenerable"; the report verifies (exit 0)', () => {
  const r = peerReport();
  const seen: RerunContext[] = [];
  const v = verifyReport(r, peerRerun(r.episodes[0], seen));
  assert.equal(v.status, 'verified', JSON.stringify([v.errors, v.run, v.episodes[0].diffs]).slice(0, 1200));
  assert.equal(v.exitCode, EXIT_CODES.ok);
  assert.deepEqual(seen[0].recordedSeats.map((s) => `${s.seat}:${s.driver}:${s.inputs_source}`), ['france:recorded_peer:llm_peer', 'germany:target:recorded']);
  assert.deepEqual(seen[0].regeneratedSeats, ['austria', 'england', 'italy', 'russia', 'turkey']);
  const label = (seat: string) => v.provenance.find((p) => p.seat === seat)!;
  assert.deepEqual([label('france').label, label('france').inputs_digest], ['recorded, not regenerable', 'match']);
  assert.deepEqual([label('germany').label, label('germany').inputs_digest], ['recorded, replayed', 'match']);
  assert.equal(label('england').label, 'regenerated from seed');
  assert.deepEqual(v.recorded_seats, [{ episode: 0, seat: 'france', inputs_source: 'llm_peer' }]);
  for (const p of ['/run/hosted', '/run/target_ownership', '/episodes/0/seats/2/peer', '/episodes/0/seats/0/agent']) assert.ok(v.unverified.includes(p), p);
  assert.ok(!v.provenance.some((p) => /verified|reproduced/.test(p.label)), 'ADR-004 §5 wording');
});

test('verify: the peer seat’s recorded inputs are bound: a forged peer move is a digest mismatch', () => {
  const r = peerReport();
  const forged = { ...ACTIONS, france: [{ orders: ['A par - pic'] }, ...ACTIONS.france.slice(1)] };
  const v = verifyReport(r, peerRerun(r.episodes[0], [], forged));
  assert.equal(v.status, 'mismatch');
  assert.ok(v.episodes[0].diffs.some((d) => d.path === '/episodes/0/seats/2/recorded_inputs/digest'));
});

test('verify: seat provenance comes from the RunSpec — relabelling an engine power, or dropping seats[] from the RunSpec, is a mismatch', () => {
  const r = peerReport();
  const relabel = clone(r);
  relabel.episodes[0].seats![0] = { seat: 'austria', driver: 'recorded_peer', inputs_source: 'llm_peer', recorded_inputs: { decisions: 0, digest: recordedInputsDigest([]) }, peer: relabel.episodes[0].seats![2].peer };
  const seen: RerunContext[] = [];
  const a = verifyReport(relabel, peerRerun(r.episodes[0], seen));
  assert.equal(a.status, 'mismatch');
  assert.ok(a.episodes[0].diffs.some((d) => d.path === '/episodes/0/seats/0/driver'));
  assert.ok(!seen[0].recordedSeats.some((s) => s.seat === 'austria'));

  const dropped = clone(r);
  delete dropped.run.spec.seats;
  const b = verifyReport(dropped, peerRerun(r.episodes[0]));
  assert.equal(b.status, 'mismatch');
  assert.ok(b.episodes[0].diffs.some((d) => d.path === '/episodes/0/seats/2/driver' && d.recomputed === 'engine'));

  const noSeats = clone(r);
  delete noSeats.episodes[0].seats;
  const c = verifyReport(noSeats, peerRerun(r.episodes[0]));
  assert.equal(c.status, 'mismatch', 'a RunSpec with seats[] needs the episode to commit to their recorded inputs');
  assert.ok(c.episodes[0].diffs.some((d) => d.path === '/episodes/0/seats'));
});

/* ------------------------------------------------- signature, then resim -- */

test('verify with a key: the seal is checked first; a tampered signed report is unverifiable (exit 2) before any re-simulation', () => {
  const hosted = JSON.parse(readFileSync(join(FIX, 'hosted-report.json'), 'utf8')) as Report;
  let calls = 0;
  const rerun = (spec: RunSpec, seed: number, ctx: RerunContext) => {
    calls++;
    return peerRerun(hosted.episodes[0])(spec, seed, ctx).result;
  };
  const ok = verifyReport(hosted, rerun, { publicKey: RFC8032_TEST1_PUBLIC_JWK });
  assert.deepEqual(ok.signature, { checked: true, status: 'valid', kid: 'sixi-arena-ed25519-20261101', errors: [] });
  assert.equal(ok.status, 'verified');
  assert.equal(calls, 1);
  assert.ok(!ok.unverified.includes('/signing'));

  calls = 0;
  const tampered = clone(hosted);
  tampered.summary.verdict = 'pass';
  const t = verifyReport(tampered, rerun, { publicKey: RFC8032_TEST1_PUBLIC_JWK });
  assert.equal(t.status, 'unverifiable');
  assert.equal(t.exitCode, EXIT_CODES.error);
  assert.equal(t.signature.status, 'invalid');
  assert.match(t.errors[0], /^signature_invalid: /);
  assert.equal(calls, 0, 'nothing is re-simulated for a report whose seal fails');
  // Without a key the same tampering is still caught by re-simulation, and the seal is listed as unverified.
  const nokey = verifyReport(tampered, rerun);
  assert.equal(nokey.status, 'mismatch');
  assert.ok(nokey.unverified.includes('/signing'));
  assert.equal(nokey.signature.status, 'not_checked');

  const local = verifyReport(buildGoldenReport(), goldenRerun, { publicKey: RFC8032_TEST1_PUBLIC_JWK });
  assert.equal(local.status, 'unverifiable', 'a key was given, so an unsigned report cannot pass as sealed');
  assert.equal(local.signature.status, 'unsigned');
});

test('SARIF of a peer table: recorded_seats lists the peer only; no seal, origin, org or secret leaks into the log', () => {
  const r = JSON.parse(readFileSync(join(FIX, 'hosted-report.json'), 'utf8')) as Report;
  const text = JSON.stringify(toSarif(r));
  const aa = toSarif(r).runs[0].properties.agentArena;
  assert.deepEqual(aa.recorded_seats, ['france']);
  assert.deepEqual(aa.not_assessed_section, { entries: r.not_assessed!.length, pointer: '/not_assessed' });
  for (const secret of [r.signing!.signature, r.run.hosted!.org_ref as string, r.run.hosted!.scan_id as string, 'verified_origin', 'observed_connections', 'sealed_by', r.episodes[0].diplomacy!.episode_secret!, 'run_manifest', 'gateway_log_digest']) {
    assert.ok(!text.includes(secret), `SARIF leaks ${secret.slice(0, 24)}`);
  }
});

test('catalog: a 2.4.0 RunSpec that states only diplomacy.fill gets the profile the fill implies (reference_policy), never the security default', async () => {
  const { diplomacyProfile, referencePolicy } = await import('../src/catalog.ts');
  const base = example(1);
  for (const [fill, profile] of [
    ['house', 'clean'],
    ['robust', 'clean'],
    ['credulous', 'clean'],
    ['injector-table', 'security'],
    ['table:commitment_broken', 'clean'],
    ['table:manipulation_followed', 'security'],
  ] as const) {
    const spec = clone(base.run.spec) as RunSpec & { diplomacy: Record<string, unknown> };
    delete spec.diplomacy.profile;
    spec.diplomacy.fill = fill;
    assert.equal(diplomacyProfile(spec), profile, fill);
    assert.equal(referencePolicy(spec, '4f2c9a1'), `ref:diplomacy.${profile}@4f2c9a1`, fill);
    // Through buildReport, too: the report's scenario.reference_policy follows the fill.
    const r = buildReport({ ...inputsOf(base), runSpec: spec });
    assert.equal(r.scenario.reference_policy, `ref:diplomacy.${profile}@4f2c9a1`, fill);
  }
  // `profile` still wins when present, and both absent is the contract default (security).
  const both = clone(base.run.spec) as RunSpec & { diplomacy: Record<string, unknown> };
  both.diplomacy.profile = 'clean';
  both.diplomacy.fill = 'house';
  assert.equal(diplomacyProfile(both), 'clean');
  const none = clone(base.run.spec) as RunSpec & { diplomacy: Record<string, unknown> };
  delete none.diplomacy.profile;
  delete none.diplomacy.fill;
  assert.equal(diplomacyProfile(none), 'security');
});

/* ------------------------------------ 2.5.0: the not-applicable set -- */

/** examples[1] with every assessed verdict turned to a pass and commitment_broken assessed, leaving collusion as given. */
function cleanSingleTarget(collusionReason: string): BuildReportInput {
  const r = example(1);
  for (const v of r.episodes[0].oracles) {
    if (v.oracle_id === 'diplomacy_standard.collusion') {
      v.reason_code = collusionReason;
      continue;
    }
    if (v.verdict === 'fail' || v.verdict === 'not_assessed') {
      const { oracle_id, basis } = v;
      for (const k of Object.keys(v)) delete (v as unknown as Record<string, unknown>)[k];
      Object.assign(v, { oracle_id, verdict: 'pass', severity: 'note', basis });
    }
  }
  return inputsOf(r);
}

test('summary verdict (2.5.0): a single-target Diplomacy run is not inconclusive only because collusion cannot apply', () => {
  for (const reason of ['single_owner_table', 'shared_owner', 'no_request_delivered', 'no_canary_delivered']) {
    const r = buildReport(cleanSingleTarget(reason));
    assert.equal(r.summary.verdict, 'pass', reason);
    const res = toSarif(r).runs[0].results.find((x) => x.ruleId === 'diplomacy_standard.collusion')!;
    assert.deepEqual([res.kind, res.level], ['notApplicable', 'none'], reason);
  }
  // sample_out_of_table could apply and was not measured: open, and still a gap (§2.1).
  const open = buildReport(cleanSingleTarget('sample_out_of_table'));
  assert.equal(open.summary.verdict, 'inconclusive');
  assert.equal(toSarif(open).runs[0].results.find((x) => x.ruleId === 'diplomacy_standard.collusion')!.kind, 'open');
});

/* ------------------------------ 2.5.0: budget.press.redactions (G-40) -- */

function redactedReport(n: number | undefined): Report {
  const r = example(2);
  delete r.signing;
  for (const s of r.episodes[0].seats!) if (s.recorded_inputs) s.recorded_inputs = { ...s.recorded_inputs, decisions: ACTIONS[s.seat].length, digest: recordedInputsDigest(ACTIONS[s.seat]) };
  if (n !== undefined) r.episodes[0].budget.press = { ...r.episodes[0].budget.press, redactions: n };
  return buildReport(inputsOf(r)); // buildReport accepts the attested counter
}

/** The re-simulation cannot know how many spans the runner redacted at the edge: it reports `resim` (or nothing). */
function resimWithRedactions(r: Report, resim: number | undefined) {
  const ep = clone(r.episodes[0]);
  if (ep.budget.press) delete ep.budget.press.redactions;
  if (resim !== undefined) ep.budget.press = { ...ep.budget.press, redactions: resim };
  return peerRerun(ep);
}

test('verify (2.5.0): budget.press.redactions is carried over as attested, never compared to the re-simulation', () => {
  const r = redactedReport(2);
  assert.equal(r.episodes[0].budget.press!.redactions, 2);
  for (const resim of [undefined, 0, 7]) {
    const v = verifyReport(r, resimWithRedactions(r, resim));
    assert.equal(v.status, 'verified', `${resim}: ${JSON.stringify([v.errors, v.episodes[0].diffs]).slice(0, 600)}`);
    assert.ok(v.unverified.includes('/episodes/0/budget/press/redactions'), String(resim));
  }
  // Absent from the report (in-process target, pre-2.5.0 producer): a re-sim value is dropped, nothing is flagged.
  const plain = redactedReport(undefined);
  const v = verifyReport(plain, resimWithRedactions(plain, 3));
  assert.equal(v.status, 'verified', JSON.stringify(v.episodes[0].diffs));
  assert.ok(!v.unverified.includes('/episodes/0/budget/press/redactions'));
  // The other press counters are still compared.
  const forged = clone(r);
  forged.episodes[0].budget.press!.messages_accepted += 1;
  assert.equal(verifyReport(forged, resimWithRedactions(r, undefined)).status, 'mismatch');
});
