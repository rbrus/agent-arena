/**
 * arena-crosscheck (qa/crosscheck.ts) — regression suite (sim-qa, Phase 9 B1-crosscheck).
 *
 *   node --test --import tsx qa/crosscheck.test.ts        (from ascension/; ~1.5 min)
 *
 * qa/ is outside the `npm test` glob (packages/*\/test, services/*\/test); wire it in the same way
 * services/arena/test/phase7-gate.test.ts wires qa/phase7-gate.ts.
 *
 * Everything goes through the runner's own CLI (a child process), which drives the public
 * arena CLI; only the pure verdict functions are imported.
 *
 *   1. verdict algebra (HOSTED-PROFILE §2.8): match / environmental / divergent / missing, anchor
 *      comparison, job verdict precedence per scope (2.5.0: a hosted pass needs H, a local one
 *      does not), the embedded anchor leg;
 *   2. `--legs npm` over the whole matrix: every cell matches, every frozen anchor reproduces and
 *      is embedded as leg A, exit 0, `scope: local` and job `pass`, the record validates and —
 *      with `--sign` — its signature verifies with the RFC 8032 §7.1 TEST 1 key under the
 *      CROSSCHECK payload type;
 *   3. `--stable` twice: record and summary byte-identical, and `--compare` finds them equal;
 *   4. a missing leg (`binary` without `--binary`) → `missing` cells, the run still exits 0;
 *   5. a tampered hosted report (one replay_hash rewritten) → that cell `divergent`, leg V
 *      counts a verify mismatch, job `fail`, exit 1, `scope: hosted`;
 *   6. `--compare`: seal and wall-clocks ignored, any cell or leg field difference found, exit
 *      0 / 1 / 2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CROSSCHECK_PAYLOAD_TYPE, verifyDocumentSignature } from 'arena-report';
import { anchorFor } from 'arena-scenarios';
import { anchorId, anchorLeg, buildMatrix, cellVerdict, compareRecords, jobVerdict, loadCrosscheckValidator, type LegEntry } from './crosscheck.ts';

const ASC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ASC, 'qa', 'crosscheck.ts');
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const TMP = mkdtempSync(join(tmpdir(), 'arena-crosscheck-test-'));

// RFC 8032 §7.1 TEST 1 (contracts/fixtures/signing_vectors.json uses the same key).
const RFC8032_TEST1_SEED = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const RFC8032_TEST1_PUBLIC_JWK = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' } as const;
const KEY_PEM = join(TMP, 'rfc8032-test1.pem');
writeFileSync(
  KEY_PEM,
  createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), RFC8032_TEST1_SEED]), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }) as string,
);

interface Summary {
  job_verdict: string;
  exit_code: number;
  counts: Record<string, Record<string, number>>;
  legs: { leg: string; state: string; reason?: string }[];
  matrix: { groups: number; cells: number };
  leg_v: { reports_total: number; verify_exit_codes: Record<string, number> };
  cells: { cell_id: string; group: string; episode_index: number; verdict: string; anchor?: string; compared_legs: string[]; diffs: string[]; missing?: { leg: string; cause: string }[] }[];
}
interface RecordDoc {
  job_verdict: string;
  scope?: string;
  legs: string[];
  leg_v: { reports_total: number; reports_verified: number };
  cells: { cell_id: string; verdict: string; seed: number; legs: Record<string, { replay_hash: string; outcome: string; terminal_tick: number; anchor_id?: string }>; missing_legs?: string[]; missing_cause?: string }[];
  signing: { signing_key_id: string; signature: string };
  finished_at: string;
}

function xc(args: string[]): { code: number; out: string; summary: Summary; record: RecordDoc; recordText: string; summaryText: string } {
  const outDir = args[args.indexOf('--out') + 1];
  const p = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--digest', DIGEST, ...args], { cwd: ASC, encoding: 'utf8', timeout: 900_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  const recordText = readFileSync(join(outDir, 'crosscheck_record.json'), 'utf8');
  const summaryText = readFileSync(join(outDir, 'crosscheck_summary.json'), 'utf8');
  return { code: p.status ?? -1, out: `${p.stdout}\n${p.stderr}`, summary: JSON.parse(summaryText), record: JSON.parse(recordText), recordText, summaryText };
}

const E = (o: Partial<LegEntry> = {}): LegEntry => ({ status: 'completed', replay_hash: `sha256:${'1'.repeat(64)}`, outcome: 'clear', terminal_tick: 38, trajectory_class: `sha256:${'2'.repeat(64)}`, deadline_miss: false, target_abort: false, ...o });

// ── 1. verdict algebra ──────────────────────────────────────────────────────────
test('cell verdicts: match, divergent, environmental, missing, anchor', () => {
  assert.equal(cellVerdict({ O1: E(), O2: E() }, ['O1', 'O2']).verdict, 'match');
  const d = cellVerdict({ O1: E(), H: E({ replay_hash: `sha256:${'3'.repeat(64)}` }) }, ['H', 'O1']);
  assert.equal(d.verdict, 'divergent');
  assert.match(d.diffs[0], /^replay_hash: H=/);
  assert.equal(cellVerdict({ O1: E(), H: E({ terminal_tick: 40, deadline_miss: true }) }, ['H', 'O1']).verdict, 'environmental');
  assert.equal(cellVerdict({ O1: E({ status: 'aborted', abort_reason: 'target_unreachable', outcome: 'aborted', target_abort: true }), H: E() }, ['H', 'O1']).verdict, 'environmental');
  // harness_error is not target_*: a difference with it is divergent.
  assert.equal(cellVerdict({ O1: E({ status: 'aborted', abort_reason: 'harness_error', outcome: 'aborted' }), H: E() }, ['H', 'O1']).verdict, 'divergent');
  const m = cellVerdict({ O1: E() }, ['O1', 'O2']);
  assert.deepEqual([m.verdict, m.missing], ['missing', ['O2']]);
  // A difference outranks a missing leg.
  assert.equal(cellVerdict({ O1: E(), O3: E({ outcome: 'wipe' }) }, ['O1', 'O2', 'O3']).verdict, 'divergent');
  // Anchor: the one leg that ran must still reproduce the frozen value.
  const anchor = { name: 'x', replay_hash: `sha256:${'1'.repeat(64)}`, outcome: 'clear', terminal_tick: 38 };
  assert.equal(cellVerdict({ O1: E() }, ['O1'], anchor).verdict, 'match');
  assert.equal(cellVerdict({ O1: E({ terminal_tick: 39 }) }, ['O1'], anchor).verdict, 'divergent');
  // Evaluation hash is compared; a failed Diplomacy verify is an extra difference.
  assert.equal(cellVerdict({ O1: E({ evaluation_hash: `sha256:${'4'.repeat(64)}` }), O2: E() }, ['O1', 'O2']).verdict, 'divergent');
  assert.equal(cellVerdict({ O1: E(), O2: E() }, ['O1', 'O2'], undefined, ['verify: O2 mismatch']).verdict, 'divergent');
});

test('job verdict precedence: fail > inconclusive > pass; a hosted-scope pass needs H, a local-scope pass does not', () => {
  const ok = { legVFailed: false, buildMismatch: false, hostedRan: true };
  assert.equal(jobVerdict([{ verdict: 'match' }], ok), 'pass');
  assert.equal(jobVerdict([{ verdict: 'match' }], { ...ok, hostedRan: false }), 'inconclusive', 'scope absent = hosted');
  assert.equal(jobVerdict([{ verdict: 'match' }], { ...ok, hostedRan: false, scope: 'hosted' }), 'inconclusive');
  const local = { ...ok, hostedRan: false, scope: 'local' as const };
  assert.equal(jobVerdict([{ verdict: 'match' }], local), 'pass');
  assert.equal(jobVerdict([{ verdict: 'match' }, { verdict: 'missing', missing_cause: 'other' }], local), 'inconclusive');
  assert.equal(jobVerdict([{ verdict: 'match' }, { verdict: 'environmental' }], local), 'inconclusive');
  assert.equal(jobVerdict([{ verdict: 'divergent' }], local), 'fail');
  assert.equal(jobVerdict([{ verdict: 'match' }], { ...local, buildMismatch: true }), 'fail');
  assert.equal(jobVerdict([{ verdict: 'match' }, { verdict: 'environmental' }], ok), 'inconclusive');
  assert.equal(jobVerdict([{ verdict: 'missing', missing_cause: 'other' }], ok), 'inconclusive');
  assert.equal(jobVerdict([{ verdict: 'missing', missing_cause: 'harness_error' }], ok), 'fail');
  assert.equal(jobVerdict([{ verdict: 'divergent' }, { verdict: 'environmental' }], ok), 'fail');
  assert.equal(jobVerdict([{ verdict: 'match' }], { ...ok, legVFailed: true }), 'fail');
  assert.equal(jobVerdict([{ verdict: 'match' }], { ...ok, buildMismatch: true }), 'fail');
});

test('leg A (2.5.0): the frozen anchor embeds as {replay_hash, outcome, terminal_tick, anchor_id} and validates', () => {
  assert.equal(anchorId('byzantine core seed 20260720 squad coordinated'), 'byzantine/core/seed/20260720/squad/coordinated');
  assert.equal(anchorId('byzantine core seed 1 squad naive (gate)'), 'byzantine/core/seed/1/squad/naive/gate');
  assert.equal(anchorId('x'.repeat(81)), undefined, 'over the schema length: omitted');
  const a = { name: 'byzantine core seed 20260720 squad coordinated', id: 'byzantine/core/seed/20260720/squad/coordinated', replay_hash: `sha256:${'1'.repeat(64)}`, outcome: 'clear', terminal_tick: 38 };
  assert.deepEqual(anchorLeg(a), { replay_hash: a.replay_hash, outcome: 'clear', terminal_tick: 38, anchor_id: a.id });
  assert.equal(anchorLeg({ ...a, terminal_tick: undefined }), undefined, 'the schema requires terminal_tick');
  assert.equal(anchorLeg(undefined), undefined);
});

test('matrix: 69 runs, 321 cells (X1 300, X2 15, X3 6)', () => {
  const g = buildMatrix();
  const cells = (b: string) => g.filter((x) => x.block === b).reduce((n, x) => n + x.seeds.length, 0);
  assert.equal(g.length, 69);
  assert.deepEqual([cells('X1'), cells('X2'), cells('X3')], [300, 15, 6]);
  assert.equal(new Set(g.map((x) => x.id)).size, g.length, 'group ids are unique (they name the hosted report directories)');
  // Duels pin seat A (the CLI alternates A/B when --position is absent).
  for (const x of g.filter((x) => x.seatMode === 'duel')) assert.ok(x.args.includes('--position') && x.args[x.args.indexOf('--position') + 1] === 'A');
});

// ── 2. the whole matrix on the npm leg, signed ──────────────────────────────────
test('--legs npm: every cell matches and every frozen anchor reproduces as leg A; scope local, pass; the signed record validates and verifies', { timeout: 900_000 }, () => {
  const out = join(TMP, 'full');
  const r = xc(['--legs', 'npm', '--out', out, '--sign', KEY_PEM, '--kid', 'rfc8032-test1', '--stable']);
  assert.equal(r.code, 0, r.out.slice(-3000));
  assert.equal(r.summary.exit_code, 0);
  assert.equal(r.record.scope, 'local', 'no hosted leg requested');
  assert.equal(r.summary.job_verdict, 'pass', 'a clean local-scope run passes (it never promotes)');
  assert.equal(r.record.job_verdict, 'pass');
  assert.deepEqual([r.record.leg_v.reports_total, r.record.leg_v.reports_verified], [0, 0]);
  assert.deepEqual(r.record.legs, ['O1', 'A']);
  assert.equal(r.summary.matrix.cells, 321);
  assert.equal(r.record.cells.length, 321);
  const bad = r.summary.cells.filter((c) => c.verdict !== 'match');
  assert.deepEqual(bad.map((c) => `${c.cell_id} ${c.group} ${c.diffs.join(';')}`), []);
  // Every anchored cell carries the frozen anchor and the leg value equals it (re-checked here
  // straight from anchors.ts, independent of the runner's comparison).
  const anchored = r.summary.cells.filter((c) => c.anchor);
  assert.equal(anchored.length, 87, 'X1 squad raids 60 + X1 duel 12 + X2 15');
  const byId = new Map(r.record.cells.map((c) => [c.cell_id, c]));
  for (const c of anchored) {
    assert.ok(c.compared_legs.includes('A'));
    const rec = byId.get(c.cell_id)!;
    const g = buildMatrix().find((x) => x.id === c.group)!;
    const a = anchorFor({ scenario: g.scenario, seat: (g.seatMode === 'duel' ? 'A' : 'squad') as never, tier: g.tier, seed: rec.seed, policy: g.policy });
    assert.ok(a, `${c.cell_id} anchor`);
    assert.equal(rec.legs.O1.replay_hash, a!.replayHash, `${c.cell_id} ${a!.name}`);
    assert.equal(rec.legs.O1.outcome, a!.outcome);
    assert.equal(rec.legs.O1.terminal_tick, a!.ticks);
    // 2.5.0: the anchor is in the record, as leg A of the cell.
    assert.deepEqual(rec.legs.A, { replay_hash: a!.replayHash, outcome: a!.outcome, terminal_tick: a!.ticks, anchor_id: anchorId(a!.name) }, c.cell_id);
  }
  assert.equal(r.record.cells.filter((c) => c.legs.A).length, 87, 'no unanchored cell carries a leg A');
  assert.ok(r.record.cells.every((c) => !c.legs.A || c.legs.A.anchor_id), 'every embedded anchor is named');
  const validate = loadCrosscheckValidator();
  assert.ok(validate(r.record), JSON.stringify(validate.errors?.slice(0, 3)));
  const sig = verifyDocumentSignature(r.record, RFC8032_TEST1_PUBLIC_JWK, CROSSCHECK_PAYLOAD_TYPE);
  assert.equal(sig.status, 'valid', sig.errors.join('; '));
  // Domain separation and tamper evidence.
  assert.equal(verifyDocumentSignature(r.record, RFC8032_TEST1_PUBLIC_JWK, 'application/vnd.sixi.arena-report+json').ok, false);
  const forged = JSON.parse(r.recordText) as RecordDoc;
  forged.cells[0].legs.O1.terminal_tick += 1;
  assert.equal(verifyDocumentSignature(forged, RFC8032_TEST1_PUBLIC_JWK, CROSSCHECK_PAYLOAD_TYPE).ok, false);
});

// ── 3–5. X2 block: determinism, missing leg, tampered hosted report ─────────────
test('--stable: two runs give byte-identical record and summary', { timeout: 300_000 }, () => {
  const a = xc(['--legs', 'npm', '--blocks', 'X2', '--out', join(TMP, 'stable-a'), '--sign', KEY_PEM, '--kid', 'rfc8032-test1', '--stable']);
  const b = xc(['--legs', 'npm', '--blocks', 'X2', '--out', join(TMP, 'stable-b'), '--sign', KEY_PEM, '--kid', 'rfc8032-test1', '--stable']);
  assert.equal(a.code, 0, a.out.slice(-2000));
  assert.equal(a.recordText, b.recordText);
  assert.equal(a.summaryText, b.summaryText);
  assert.ok(!/wall-clock/.test(a.out), '--stable prints no timing');
  assert.ok(!/"started_at": "20/.test(a.recordText), '--stable record carries no real timestamp');
  assert.equal(a.record.scope, 'local');
  assert.equal(a.record.job_verdict, 'pass');
  // The seal route's check on two independent runs of the same job.
  const cmp = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--compare', join(TMP, 'stable-a', 'crosscheck_record.json'), join(TMP, 'stable-b', 'crosscheck_record.json'), '--json'], { cwd: ASC, encoding: 'utf8' });
  assert.equal(cmp.status, 0, cmp.stdout + cmp.stderr);
  assert.deepEqual(JSON.parse(cmp.stdout), { equal: true, cells_compared: 15, cells_differing: 0, differences: [], ignored: ['/signing', '/started_at', '/finished_at'] });
});

test('--compare: seal and wall-clocks ignored; a cell, leg or verdict difference is found; exit 0 / 1 / 2', { timeout: 120_000 }, () => {
  const a = JSON.parse(readFileSync(join(TMP, 'stable-a', 'crosscheck_record.json'), 'utf8')) as RecordDoc;
  // The public job's unsigned record against the sealer's signed one, finished at another instant: equal.
  const unsigned = structuredClone(a);
  unsigned.signing.signing_key_id = 'arena-crosscheck-unsigned';
  unsigned.signing.signature = `${'A'.repeat(86)}==`;
  unsigned.finished_at = '2026-11-01T02:41:10Z';
  assert.equal(compareRecords(a, unsigned).equal, true);
  // One leg field of one cell.
  const leg = structuredClone(a);
  leg.cells[3].legs.O1.terminal_tick += 1;
  const r1 = compareRecords(a, leg);
  assert.deepEqual([r1.equal, r1.cells_differing], [false, 1]);
  assert.match(r1.differences[0], new RegExp(`^cell ${a.cells[3].cell_id} leg O1 terminal_tick: A=\\d+ B=\\d+$`));
  // The anchor leg is compared like any other leg.
  const anchor = structuredClone(a);
  delete (anchor.cells[0].legs.A as { anchor_id?: string }).anchor_id;
  assert.match(compareRecords(a, anchor).differences[0], /leg A anchor_id: A="byzantine\/core\/seed\/20260720\/squad\/coordinated" B=\(absent\)/);
  // A dropped cell, a reordered cell list, a different top-level member.
  const dropped = structuredClone(a);
  dropped.cells.pop();
  assert.ok(compareRecords(a, dropped).differences.some((d) => /only in record A$/.test(d)));
  const reordered = structuredClone(a);
  reordered.cells.reverse();
  assert.deepEqual(compareRecords(a, reordered).differences, ['cells: same cells in a different order']);
  const trigger = structuredClone(a) as RecordDoc & { trigger?: string };
  trigger.trigger = 'nightly';
  assert.deepEqual(compareRecords(a, trigger).differences, ['/trigger: A="pre_promotion" B="nightly"']);
  // Without scope a local pass would be a hosted pass without H: invalid, so refused before comparing.
  const noScope = structuredClone(a);
  delete noScope.scope;
  assert.throws(() => compareRecords(a, noScope), /record B is invalid/);
  // CLI: 1 on a difference, 2 on an invalid record or bad usage.
  const f = (name: string, doc: unknown) => {
    const p = join(TMP, name);
    writeFileSync(p, JSON.stringify(doc));
    return p;
  };
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--compare', ...args], { cwd: ASC, encoding: 'utf8' });
  const pa = join(TMP, 'stable-a', 'crosscheck_record.json');
  assert.equal(run(pa, f('cmp-leg.json', leg)).status, 1);
  const invalid = structuredClone(a) as unknown as Record<string, unknown>;
  invalid.job_verdict = 'maybe';
  const bad = run(pa, f('cmp-invalid.json', invalid));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /record B is invalid/);
  assert.equal(run(pa).status, 2);
  assert.equal(run(pa, join(TMP, 'no-such.json')).status, 2);
});

test('a missing leg yields `missing` cells and does not fail the run', { timeout: 300_000 }, () => {
  const r = xc(['--legs', 'npm,binary', '--blocks', 'X2', '--out', join(TMP, 'missing')]);
  assert.equal(r.code, 0, r.out.slice(-2000));
  assert.equal(r.summary.job_verdict, 'inconclusive');
  assert.deepEqual(r.summary.legs.find((l) => l.leg === 'O2'), { leg: 'O2', name: 'binary', state: 'missing', reason: 'no --binary given' } as never);
  assert.equal(r.record.cells.length, 15);
  for (const c of r.record.cells) {
    assert.equal(c.verdict, 'missing');
    assert.deepEqual(c.missing_legs, ['O2']);
    assert.equal(c.missing_cause, 'other');
    assert.ok(c.legs.O1, 'the leg that ran is still recorded');
  }
  assert.ok(loadCrosscheckValidator()(r.record));
});

test('a tampered hosted report yields `divergent`, a leg-V mismatch and job `fail`', { timeout: 300_000 }, () => {
  // Hosted fixture: the O1 reports of the stable run, placed where the hosted leg reads them
  // (<hosted-dir>/<group id>/report.json); one replay_hash rewritten in the ws group.
  const hosted = join(TMP, 'hosted');
  const ws = 'x2-core-byzantine-squad-coordinated-ws';
  const mcp = 'x2-core-byzantine-squad-coordinated-mcp';
  for (const g of [ws, mcp]) {
    mkdirSync(join(hosted, g), { recursive: true });
    cpSync(join(TMP, 'stable-a', 'legs', 'O1', g), join(hosted, g), { recursive: true });
  }
  const rp = join(hosted, ws, 'report.json');
  const rep = JSON.parse(readFileSync(rp, 'utf8'));
  rep.episodes[2].replay_hash = `sha256:${'e'.repeat(64)}`;
  writeFileSync(rp, JSON.stringify(rep, null, 2));

  const r = xc(['--legs', 'npm,hosted', '--hosted-dir', hosted, '--blocks', 'X2', '--out', join(TMP, 'tampered')]);
  assert.equal(r.code, 1, r.out.slice(-2000));
  assert.equal(r.record.scope, 'hosted', 'H requested: hosted scope');
  assert.equal(r.summary.job_verdict, 'fail');
  assert.equal(r.record.job_verdict, 'fail');
  const cells = r.summary.cells;
  const tampered = cells.find((c) => c.group === ws && c.episode_index === 2)!;
  assert.equal(tampered.verdict, 'divergent');
  assert.ok(tampered.diffs.some((d) => /^replay_hash: H=sha256:e{64} O1=/.test(d)), tampered.diffs.join(' | '));
  assert.ok(tampered.diffs.some((d) => /anchor=/.test(d)), 'the frozen anchor disagrees with the tampered leg too');
  // The untampered ws episodes and the copied mcp group match H against O1; a2a has no hosted report.
  for (const c of cells.filter((c) => c !== tampered && (c.group === ws || c.group === mcp))) assert.equal(c.verdict, 'match', `${c.cell_id} ${c.diffs.join(';')}`);
  for (const c of cells.filter((c) => c.group.endsWith('-a2a'))) {
    assert.equal(c.verdict, 'missing');
    assert.deepEqual(c.missing?.map((m) => [m.leg, m.cause]), [['H', 'other']]);
  }
  // Leg V: two hosted reports, the tampered one fails `verify` (exit 1, mismatch).
  assert.equal(r.summary.leg_v.reports_total, 2);
  assert.equal(r.summary.leg_v.verify_exit_codes['1'], 1);
  assert.ok(loadCrosscheckValidator()(r.record));
});
