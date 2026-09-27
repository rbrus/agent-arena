/**
 * Phase 8 C2g: diplomacy_standard in the CLI.
 *
 *  - e2e (gate criteria 1-2 for Diplomacy): `serve-reference --scenario
 *    diplomacy_standard --policy robust` driven by `run --seat germany --fill
 *    table:commitment --horizon 1904 --seeds 20261115` over REST, WS, MCP and
 *    A2A reproduces the engine golden's replay, transcript and engine
 *    evaluation hashes on every transport, and every report re-verifies;
 *  - in-process references, `auto` seating, replay --json (mode power),
 *    episode_invalid accounting, the local signature attestation, misuse
 *    (exit 3 before any I/O), verify tamper detection, list-scenarios.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DIP_GOLDEN_SEED, dipAnchorFor, resolveDipSeat, type EpisodeRecord } from 'arena-scenarios';
import { runCommand, type RunFlags } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { replayCommand } from '../src/commands/replay.ts';
import { serveReferenceCommand } from '../src/commands/serve-reference.ts';
import { attestLocalSignatures, canonicalFill, DIP_UNVERIFIED_SIGNATURE, dipRecordedActions } from '../src/diplomacy.ts';
import { CliError } from '../src/errors.ts';
import { DipWireView, DiplomacyReferenceAgent } from '../src/reference/diplomacy.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { recordedInputsDigest } from '../src/report.ts';
import { setOutputMode } from '../src/ui.ts';
import { allFiles, runCli, scratch, stub } from './helpers.ts';

const GOLDEN = { seat: 'germany', fill: 'table:commitment', horizon: '1904', seeds: String(DIP_GOLDEN_SEED) } as const;
const anchor = (policy: 'robust' | 'credulous') => dipAnchorFor({ seat: 'germany', tier: 'core', seed: DIP_GOLDEN_SEED, policy, fill: 'table:commitment_broken', horizonYear: 1904 })!;
const readJson = <T = Record<string, any>>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const dipRun = (f: Partial<RunFlags>): RunFlags => ({ scenario: 'diplomacy_standard', ...f });

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'robust', scenario: 'diplomacy_standard' });
});
after(async () => {
  await srv.close();
});

function targetFor(t: 'rest' | 'ws' | 'mcp' | 'a2a'): string {
  const u = new URL(srv.urls[t]);
  if (t === 'a2a') u.hostname = 'localhost'; // the card names the endpoint on the Host the client used
  return u.toString();
}

const byTransport: Record<string, { replay: string; transcript: string; evaluation: string; engineEvaluation: string }> = {};

for (const transport of ['rest', 'ws', 'mcp', 'a2a'] as const) {
  test(`${transport}: served robust-diplomat at germany, fill table:commitment, horizon 1904 reproduces the engine golden and re-verifies`, async () => {
    const out = scratch();
    const r = await runCommand(dipRun({ ...GOLDEN, target: targetFor(transport), transport, out }), []);
    assert.equal(r.exitCode, 0, 'robust reference: no findings at --fail-on error');
    const report = readJson(join(out, 'report.json'));
    const ep = report.episodes[0];
    const a = anchor('robust');
    assert.equal(ep.seat, 'germany');
    assert.equal(ep.mode, 'power');
    assert.equal(ep.outcome, a.outcome);
    assert.equal(ep.terminal_tick, a.ticks);
    assert.equal(ep.replay_hash, a.replayHash, `${transport}: replay hash`);
    assert.equal(ep.transcript_hash, a.transcriptHash, `${transport}: transcript hash`);
    assert.equal(ep.diplomacy.engine_evaluation_hash, a.engineEvaluationHash, `${transport}: engine evaluation hash`);
    assert.match(ep.evaluation_hash, /^sha256:[0-9a-f]{64}$/);
    // RunSpec per contracts 2.4.0: power seating, diplomacy block with the explicit horizon and the fill
    // (the deprecated label is still written for one version), no seats[].
    assert.deepEqual(report.run.spec.seat, { mode: 'power', position: 'germany' });
    assert.deepEqual(report.run.spec.diplomacy, { profile: 'clean', horizon_year: 1904, fill: 'table:commitment_broken' });
    assert.equal(report.run.spec.labels['arena.diplomacy_fill'], 'table:commitment_broken');
    assert.equal(report.run.spec.seats, undefined);
    assert.equal(report.run.spec.target.transport, transport);
    assert.equal(report.budget_limits.max_inbound_frame_bytes, 16384);
    // seats[]: the target power recorded (digest over its accepted payloads), the six references regenerated.
    const rec = readJson<EpisodeRecord>(join(out, 'report.episode-0.record.json'));
    const seats = ep.seats as { seat: string; driver: string; inputs_source: string; recorded_inputs?: { decisions: number; digest: string } }[];
    assert.deepEqual(seats.map((s) => s.seat), ['austria', 'england', 'france', 'germany', 'italy', 'russia', 'turkey']);
    for (const s of seats) {
      if (s.seat === 'germany') {
        assert.deepEqual([s.driver, s.inputs_source], ['target', 'recorded']);
        const actions = dipRecordedActions(rec);
        assert.equal(s.recorded_inputs!.decisions, actions.length);
        assert.equal(s.recorded_inputs!.digest, recordedInputsDigest(actions));
      } else assert.deepEqual([s.driver, s.inputs_source, s.recorded_inputs], ['engine', 'seed_regenerated', undefined]);
    }
    byTransport[transport] = { replay: ep.replay_hash, transcript: ep.transcript_hash, evaluation: ep.evaluation_hash, engineEvaluation: ep.diplomacy.engine_evaluation_hash };
    assert.equal(verifyCommand(join(out, 'report.json')), 0, `${transport}: verify`);
    // SARIF comes from arena-report unchanged; a Diplomacy run produces a valid log.
    const sarif = readJson(join(out, 'report.sarif'));
    assert.equal(sarif.version, '2.1.0');
  });
}

test('transport does not affect outcome: identical replay, transcript and both evaluation hashes over rest, ws, mcp and a2a', () => {
  assert.equal(Object.keys(byTransport).length, 4, 'all four transports ran');
  const [first, ...rest] = Object.values(byTransport);
  for (const h of rest) assert.deepEqual(h, first);
});

test('in-process ref:robust and ref:credulous reproduce their goldens; replay --json is the inspector shape (mode power) and byte-identical to the file', async () => {
  for (const policy of ['robust', 'credulous'] as const) {
    const out = scratch();
    const r = await runCommand(dipRun({ ...GOLDEN, target: `ref:${policy}`, out }), []);
    const report = readJson(join(out, 'report.json'));
    const ep = report.episodes[0];
    assert.equal(ep.replay_hash, anchor(policy).replayHash, policy);
    assert.equal(ep.transcript_hash, anchor(policy).transcriptHash, policy);
    assert.equal(ep.diplomacy.engine_evaluation_hash, anchor(policy).engineEvaluationHash, policy);
    if (policy === 'credulous') assert.equal(r.exitCode, 0, 'commitment_broken fails at warning, below --fail-on error');
    assert.equal(verifyCommand(join(out, 'report.json')), 0);
    const file = readFileSync(join(out, 'report.episode-0.replay.json'), 'utf8');
    const replay = JSON.parse(file);
    assert.equal(replay.mode, 'power');
    assert.equal(replay.seat, 'germany');
    assert.equal(replay.replay_hash, ep.replay_hash);
    assert.equal(replay.ticks.length, ep.terminal_tick);
    assert.equal(replay.ticks.at(-1).state_hash, ep.replay_hash, 'the adjudicator chain ends at the replay hash');
    assert.match(replay.initial_state_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(replay.ticks[0].engine_events[0].step, 'S1901M:intent');
    assert.ok(replay.ticks.every((t: { seats: unknown[] }) => t.seats.length <= 1));
    const cli = await runCli(['replay', join(out, 'report.json'), '--episode', '0', '--json']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(cli.stdout, file, 'replay --json prints the file run wrote, byte for byte');
  }
});

test('--seat auto (default): the power is the seed\'s seat shuffle; spec position auto; the fill defaults to the contract\'s (security = injector-table); the report re-verifies', async () => {
  const out = scratch();
  const r = await runCommand(dipRun({ seeds: '1,2', horizon: '1901', target: 'ref:house', out }), []);
  assert.ok(r.exitCode === 0 || r.exitCode === 1, String(r.exitCode));
  const report = readJson(join(out, 'report.json'));
  assert.deepEqual(report.run.spec.seat, { mode: 'power', position: 'auto' });
  // No --fill = the RunSpec default (neither fill nor profile = security = injector-table), not house.
  assert.deepEqual(report.run.spec.diplomacy, { profile: 'security', horizon_year: 1901, fill: 'injector-table' });
  assert.equal(report.run.spec.labels['arena.diplomacy_fill'], 'injector-table');
  assert.deepEqual(report.episodes.map((e: { seat: string }) => e.seat), [resolveDipSeat(1, 'auto'), resolveDipSeat(2, 'auto')]);
  assert.equal(verifyCommand(join(out, 'report.json')), 0);
});

test('the horizon default is the RunSpec\'s 1906, passed to the adapter explicitly (never the engine\'s 1908)', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', seeds: '7', target: 'ref:robust', out }), []);
  const report = readJson(join(out, 'report.json'));
  assert.equal(report.run.spec.diplomacy.horizon_year, 1906);
  assert.equal(report.episodes[0].diplomacy.horizon_year, 1906);
  assert.equal(readJson<EpisodeRecord>(join(out, 'report.episode-0.record.json')).diplomacy!.horizonYear, 1906);
});

test('episode_invalid: an injector target that pries codewords out of credulous references invalidates its own episode (not_assessed, excluded from pass/fail)', async () => {
  const inj = await startReferenceServer({ port: 0, policy: 'injector', scenario: 'diplomacy_standard' });
  try {
    const out = scratch();
    const r = await runCli(['run', '--scenario', 'diplomacy_standard', '--seat', 'germany', '--fill', 'credulous', '--horizon', '1901', '--seeds', String(DIP_GOLDEN_SEED), '--target', inj.urls.rest, '--out', out, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.episodes_invalid, 1);
    assert.equal(summary.episodes[0].episode_invalid, true);
    assert.equal(summary.exit_code, 0, 'no target verdict can fail in an invalid episode');
    const report = readJson(join(out, 'report.json'));
    const target = report.episodes[0].oracles.filter((o: { oracle_id: string }) => o.oracle_id !== 'harness.replay_integrity');
    assert.ok(target.every((o: { verdict: string; reason_code?: string }) => o.verdict === 'not_assessed' && o.reason_code === 'episode_invalid'));
    for (const o of report.summary.oracles.filter((x: { oracle_id: string }) => x.oracle_id !== 'harness.replay_integrity')) assert.equal(o.pass + o.fail, 0, o.oracle_id);
    assert.ok(report.not_assessed.some((e: { verdict_reasons?: Record<string, number> }) => e.verdict_reasons?.episode_invalid === 1));
    assert.equal(verifyCommand(join(out, 'report.json')), 0);
  } finally {
    await inj.close();
  }
});

test('signatures: a JWS from the target never reaches the engine or any file (local attestation → signature_invalid in place); the run re-verifies', async () => {
  const FAKE_JWS = 'eyJhbGciOiJFZERTQSJ9..c2lnbmF0dXJlLWJ5dGVzLWZyb20tdGFyZ2V0';
  const agent = new DiplomacyReferenceAgent('robust');
  const s = await stub((_req, body, res) => {
    const f = JSON.parse(body);
    const out = f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true };
    const text = JSON.stringify(out).replaceAll('"signature":"session"', `"signature":"${FAKE_JWS}"`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(text);
  });
  try {
    const out = scratch();
    await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }), []);
    const signedSent = s.requests.some((q) => q.body.includes('"move":"offer"') || q.body.includes('"move":"accept"'));
    const rec = readJson<EpisodeRecord>(join(out, 'report.episode-0.record.json'));
    const payloads = JSON.stringify(rec.diplomacy!.targetInputs);
    assert.ok(payloads.includes(DIP_UNVERIFIED_SIGNATURE) || !signedSent, 'signed moves are recorded with the sentinel');
    for (const f of allFiles(out)) assert.ok(!f.text.includes(FAKE_JWS), `JWS bytes leaked into ${f.path}`);
    assert.equal(verifyCommand(join(out, 'report.json')), 0);
  } finally {
    await s.close();
  }
});

test('edge: a frame over 16 KiB is too_large and a frame for another power is not_your_seat; three refusals in a row forfeit the power (civil disorder)', async () => {
  let n = 0;
  const s = await stub((_req, body, res) => {
    const f = JSON.parse(body);
    if (f.t !== 'diplomacy_observation') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    n++;
    const frame: Record<string, unknown> = { t: 'diplomacy_action', protocol_version: '1.0', episode_id: f.episode_id, turn_id: f.turn_id, nonce: f.nonce, power: n === 1 ? f.power : 'france' };
    if (n === 1) frame.thought = 'x'.repeat(17_000);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(frame));
  });
  try {
    const out = scratch();
    const r = await runCommand(dipRun({ seat: 'germany', horizon: '1902', seeds: '4', target: s.url, out }), []);
    assert.equal(r.exitCode, 1, 'a forfeit is a budget violation at error (contracts 2.3.0)');
    const budget = readJson(join(out, 'report.json')).episodes[0].oracles.find((o: { oracle_id: string }) => o.oracle_id === 'shared.budget_violation');
    assert.deepEqual([budget.verdict, budget.severity], ['fail', 'error']);
    const rec = readJson<EpisodeRecord>(join(out, 'report.episode-0.record.json'));
    const rejects = rec.timing.filter((e) => e.event === 'rejected').map((e) => e.reject);
    assert.deepEqual(rejects, ['too_large', 'not_your_seat', 'not_your_seat']);
    assert.equal(rec.terminal.outcome, 'forfeit');
    assert.equal(n, 3, 'no observation is sent to a forfeited power');
    assert.equal(verifyCommand(join(out, 'report.json')), 0);
  } finally {
    await s.close();
  }
});

test('attestLocalSignatures: session passes, anything else becomes the sentinel; the input is not mutated', () => {
  const p = { press: [{ move: 'offer', signature: 'session' }, { move: 'accept', signature: 'x'.repeat(20) + '..' + 'y'.repeat(20) }, { move: 'press', body: 'hi' }] };
  const r = attestLocalSignatures(p);
  assert.equal(r.replaced, 1);
  assert.deepEqual((r.payload.press as { signature?: string }[]).map((m) => m.signature), ['session', DIP_UNVERIFIED_SIGNATURE, undefined]);
  assert.equal(p.press[1].signature, 'x'.repeat(20) + '..' + 'y'.repeat(20));
  assert.match(DIP_UNVERIFIED_SIGNATURE, /^(session|[A-Za-z0-9_-]{16,256}\.\.[A-Za-z0-9_-]{16,256})$/, 'schema-valid, so act() re-validation keeps the frame');
});

test('canonicalFill: full ids and the table short forms', () => {
  assert.equal(canonicalFill('table:commitment'), 'table:commitment_broken');
  assert.equal(canonicalFill('table:intent'), 'table:intent_leak');
  assert.equal(canonicalFill('table:combined'), 'table:combined');
  assert.equal(canonicalFill('injector-table'), 'injector-table');
  assert.equal(canonicalFill('table:nope'), null);
  assert.equal(canonicalFill('naive'), null);
});

test('misuse: every Diplomacy misconfiguration is exit 3 before any I/O, with a next step', async () => {
  const no = { target: 'http://127.0.0.1:9/' };
  const cases: [Partial<RunFlags>, RegExp][] = [
    [{ ...no, secret: true }, /hosted episode secret/],
    [{ ...no, horizon: '1909' }, /--horizon must be a year 1901\.\.1908/],
    [{ ...no, horizon: '19o4' }, /--horizon must be a year/],
    [{ ...no, fill: 'naive' }, /not a diplomacy_standard fill/],
    [{ ...no, fill: 'table:nope' }, /not a diplomacy_standard fill/],
    [{ ...no, seat: 'squad' }, /not a power/],
    [{ ...no, position: 'm1' }, /--position does not apply/],
    [{ ...no, seat: 'england', fill: 'table:commitment' }, /pins england and france/],
    [{ ...no, target: 'ref:reflex' }, /not a reference for diplomacy_standard/],
    [{ scenario: 'byzantine', seat: 'squad', horizon: '1904', target: 'ref:coordinated' }, /--horizon applies to diplomacy_standard only/],
  ];
  // `auto` seating that lands on a pinned power for some seed is refused up front, naming the seed.
  let clash = 0;
  while (!['england', 'france'].includes(resolveDipSeat(clash, 'auto'))) clash++;
  cases.push([{ ...no, fill: 'table:combined', seeds: `${clash}` }, new RegExp(`seed\\(s\\) ${clash}`)]);
  for (const [f, re] of cases) {
    await assert.rejects(
      runCommand(dipRun({ out: scratch(), ...f }), []),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && re.test(`${e.message} ${e.next ?? ''}`) && !!e.next,
      `${JSON.stringify(f)} → ${re}`,
    );
  }
  // Through the real argv parser: --secret is refused with the Diplomacy message, and its value is never echoed.
  const secret = 'ab'.repeat(32);
  const r = await runCli(['run', '--scenario', 'diplomacy_standard', '--secret', secret, '--target', 'ref:robust', '--out', scratch()]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /hosted episode secret/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});

test('serve-reference: Diplomacy policies need --scenario diplomacy_standard; --seat and a bad --agent-seed are refused', async () => {
  const bad: [Parameters<typeof serveReferenceCommand>[0], RegExp][] = [
    [{ policy: 'injector', port: '0' }, /diplomacy_standard reference/],
    [{ scenario: 'diplomacy_standard', policy: 'reflex', port: '0' }, /--policy for diplomacy_standard/],
    [{ scenario: 'diplomacy_standard', seat: 'squad', port: '0' }, /--seat does not apply/],
    [{ scenario: 'diplomacy_standard', agentSeed: '-1', port: '0' }, /--agent-seed must be a uint32/],
    [{ scenario: 'byzantine', agentSeed: '5', port: '0' }, /--agent-seed applies to/],
  ];
  for (const [f, re] of bad) {
    await assert.rejects(serveReferenceCommand(f), (e: unknown) => e instanceof CliError && e.exitCode === 3 && re.test(e.message), JSON.stringify(f));
  }
});

test('verify catches tampering with either evaluation hash, the fill (field, or the deprecated label without it) or the horizon', async () => {
  const out = scratch();
  await runCommand(dipRun({ ...GOLDEN, target: 'ref:robust', out }), []);
  const path = join(out, 'report.json');
  const recPath = join(out, 'report.episode-0.record.json');
  const report = readFileSync(path, 'utf8');
  const record = readFileSync(recPath, 'utf8');
  const edits: [string, (r: Record<string, any>, rec: Record<string, any>) => void, number][] = [
    ['report engine_evaluation_hash', (r) => (r.episodes[0].diplomacy.engine_evaluation_hash = `sha256:${'0'.repeat(64)}`), 1],
    ['report evaluation_hash', (r) => (r.episodes[0].evaluation_hash = `sha256:${'1'.repeat(64)}`), 1],
    ['report transcript_hash', (r) => (r.episodes[0].transcript_hash = `sha256:${'2'.repeat(64)}`), 1],
    ['record engineEvaluationHash', (_r, rec) => (rec.diplomacy.engineEvaluationHash = `sha256:${'3'.repeat(64)}`), 2],
    ['diplomacy.fill', (r) => (r.run.spec.diplomacy.fill = 'robust'), 2],
    ['fill label, field absent', (r) => { delete r.run.spec.diplomacy.fill; r.run.spec.labels['arena.diplomacy_fill'] = 'house'; }, 2],
    ['fill field and label absent (profile clean = house)', (r) => { delete r.run.spec.diplomacy.fill; delete r.run.spec.labels['arena.diplomacy_fill']; }, 2],
    ['profile contradicts the fill', (r) => (r.run.spec.diplomacy.profile = 'security'), 2],
    ['profile table with a non-house fill', (r) => (r.run.spec.diplomacy.profile = 'table'), 2],
    ['horizon', (r) => (r.run.spec.diplomacy.horizon_year = 1906), 2],
  ];
  for (const [what, edit, code] of edits) {
    const r = JSON.parse(report);
    const rec = JSON.parse(record);
    edit(r, rec);
    writeFileSync(path, JSON.stringify(r));
    writeFileSync(recPath, JSON.stringify(rec));
    assert.equal(verifyCommand(path), code, what);
  }
  writeFileSync(path, report);
  writeFileSync(recPath, record);
  assert.equal(verifyCommand(path), 0, 'restored');
  assert.equal(replayCommand(path, { hash: JSON.parse(report).episodes[0].replay_hash }), 0);
});

test('list-scenarios: diplomacy_standard is runnable, with its fills, in-process targets and served policies', async () => {
  const l = await runCli(['list-scenarios', '--json']);
  assert.equal(l.code, 0, l.stderr);
  const dip = (JSON.parse(l.stdout) as { scenarios: Record<string, any>[] }).scenarios.find((s) => s.scenario_id === 'diplomacy_standard')!;
  assert.equal(dip.runnable, true);
  assert.deepEqual(dip.seats, ['power']);
  assert.ok(dip.fills.includes('table:commitment_broken') && dip.fills.includes('injector-table'));
  assert.deepEqual(dip.serve_policies, ['robust', 'credulous', 'injector', 'house']);
  assert.ok(dip.in_process_targets.includes('ref:robust'));
  const human = await runCli(['list-scenarios']);
  assert.match(human.stdout, /--seat <power>\|auto {2}--fill house \| robust/);
  assert.doesNotMatch(human.stdout, /not runnable/);
});

test('DipWireView keeps the movement window and the commitment history, bounded', () => {
  const v = new DipWireView();
  const base = JSON.parse(
    JSON.stringify({
      phase: 'S1901M',
      power: 'germany',
      turn_id: 1,
      step: { kind: 'press', round: 1, rounds_total: 3 },
      horizon: { final_year: 1904, years_remaining: 3 },
      board: { units: [], supply_centers: {}, sc_counts: {}, unit_counts: {} },
      dislodged: [],
      adjustment: null,
      last_phase: null,
      private: { brief: { codeword: 'x', instruction: 'y' }, intent: null },
      sent: [],
      press_rejects: [],
      order_feedback: [],
      offers: [],
      commitments: [],
      quotas: { messages_round: 6, messages_window: 12, body_bytes_window: 4096, broadcasts_window: 2, live_offers: 4 },
      limits: { press_rounds: 3 },
    }),
  );
  const msg = (i: number) => ({ msg_id: `prs:S1901M:r1:france:${i}`, from: 'france', to: { kind: 'private', power: 'germany' }, move: 'press', phase: 'S1901M', round: 1, seq: i, delivered_tick: 1, body: 'b' });
  const a = v.observe({ ...base, inbox: [msg(1)] });
  const b = v.observe({ ...base, turn_id: 2, inbox: [msg(2)] });
  assert.equal(a.inbox.length, 1);
  assert.deepEqual(b.inbox.map((m) => m.msg_id), ['prs:S1901M:r1:FRA:1', 'prs:S1901M:r1:FRA:2'], 'window accumulates, engine ids');
  const c = v.observe({ ...base, phase: 'F1901M', turn_id: 5, inbox: [] });
  assert.equal(c.inbox.length, 0, 'a new movement phase starts a new window');
  for (let i = 0; i < 600; i++) v.observe({ ...base, phase: 'F1901M', turn_id: 6, inbox: [{ ...msg(1000 + i), msg_id: `prs:F1901M:r1:france:${i}`, phase: 'F1901M' }] });
  assert.ok(v.observe({ ...base, phase: 'F1901M', turn_id: 7, inbox: [] }).inbox.length <= 512, 'bounded');
});

test('diplomacy.fill (2.4.0): the field wins over the deprecated label; a 2.3.0-style report (label only) still verifies', async () => {
  const out = scratch();
  await runCommand(dipRun({ ...GOLDEN, target: 'ref:robust', out }), []);
  const path = join(out, 'report.json');
  const report = readFileSync(path, 'utf8');
  const cases: [string, (r: Record<string, any>) => void, number][] = [
    ['label contradicts the field: field wins', (r) => (r.run.spec.labels['arena.diplomacy_fill'] = 'house'), 0],
    ['label removed, field present', (r) => delete r.run.spec.labels['arena.diplomacy_fill'], 0],
    ['2.3.0 report: field removed, label present', (r) => delete r.run.spec.diplomacy.fill, 0],
  ];
  for (const [what, edit, code] of cases) {
    const r = JSON.parse(report);
    edit(r);
    writeFileSync(path, JSON.stringify(r));
    assert.equal(verifyCommand(path), code, what);
  }
  writeFileSync(path, report);
});

test('dipSpecFill: the contract profile mapping (security = injector-table, clean = house, table = house or absent)', async () => {
  const { dipSpecFill } = await import('../src/verify-diplomacy.ts');
  const spec = (diplomacy: Record<string, unknown>, labels?: Record<string, string>) =>
    ({ scenario_id: 'diplomacy_standard', seeds: [1], episodes: 1, budget_tier: 'core', target: { transport: 'rest', url: 'http://in-process.invalid/ref:robust' }, diplomacy, ...(labels ? { labels } : {}) }) as never;
  assert.equal(dipSpecFill(spec({})), 'injector-table');
  assert.equal(dipSpecFill(spec({ profile: 'security' })), 'injector-table');
  assert.equal(dipSpecFill(spec({ profile: 'clean' })), 'house');
  assert.equal(dipSpecFill(spec({ profile: 'table' })), 'house');
  assert.equal(dipSpecFill(spec({ profile: 'table', fill: 'house' })), 'house');
  assert.equal(dipSpecFill(spec({ profile: 'security', fill: 'injector-table' })), 'injector-table');
  assert.equal(dipSpecFill(spec({ profile: 'clean', fill: 'table:commitment_broken' })), 'table:commitment_broken');
  assert.equal(dipSpecFill(spec({ profile: 'security', fill: 'table:combined' })), 'table:combined');
  assert.equal(dipSpecFill(spec({ fill: 'robust' }, { 'arena.diplomacy_fill': 'credulous' })), 'robust', 'the field wins');
  assert.equal(dipSpecFill(spec({ profile: 'clean' }, { 'arena.diplomacy_fill': 'credulous' })), 'credulous', 'the label when the field is absent');
  for (const [d, re] of [
    [{ profile: 'clean', fill: 'injector-table' }, /profile clean is not the profile fill injector-table implies \(security\)/],
    [{ profile: 'security', fill: 'house' }, /implies \(clean\)/],
    [{ profile: 'table', fill: 'robust' }, /profile table takes fill house/],
    [{ fill: 'table:bogus' }, /is not a diplomacy_standard fill/],
  ] as [Record<string, unknown>, RegExp][]) {
    assert.throws(() => dipSpecFill(spec(d)), re, JSON.stringify(d));
  }
  assert.throws(() => dipSpecFill(spec({}, { 'arena.diplomacy_fill': 'nope' })), /label arena.diplomacy_fill=nope is not a diplomacy_standard fill/);
});
