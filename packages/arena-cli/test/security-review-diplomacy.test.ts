/**
 * Phase 8 gate, security review of the Diplomacy CLI path (C2g, commit 4312e3e):
 * docs/phase-8/SECURITY-REVIEW-DIPLOMACY.md. Plain tests pin controls the review
 * verified. The findings G-33 (power mode), G-36, G-37, G-38, G-39 and G-40 were
 * `todo` tests; C2k closed them and removed the `todo` options (further C2k tests:
 * diplomacy-c2k.test.ts).
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { createScenario, DIP_GOLDEN_SEED, newBlindingKey, parseDiplomacyActionFrame } from 'arena-scenarios';
import { dipCodewordFor } from 'wot-engine';
import { runCommand, type RunFlags } from '../src/commands/run.ts';
import { serveReferenceCommand } from '../src/commands/serve-reference.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { attestLocalSignatures, DIP_UNVERIFIED_SIGNATURE } from '../src/diplomacy.ts';
import { CliError } from '../src/errors.ts';
import { DiplomacyReferenceAgent, DipWireView } from '../src/reference/diplomacy.ts';
import { startReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { allFiles, runCli, scratch, stub } from './helpers.ts';

const POWERS = ['austria', 'england', 'france', 'germany', 'italy', 'russia', 'turkey'] as const;
const dipRun = (f: Partial<RunFlags>): RunFlags => ({ scenario: 'diplomacy_standard', ...f });
const readJson = <T = Record<string, any>>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const json200 = (res: import('node:http').ServerResponse, v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));

/** Invisible / reordering characters a terminal or an LLM would act on: bidi override, a Unicode tag character. */
const RLO = '‮';
const TAG_A = '\u{E0041}';
const CANARY = 'PRESSCANARYq7x9';

/**
 * A served robust-diplomat that, on every press step, adds one broadcast whose
 * raw body carries a canary, an ANSI sequence, a bidi override, a line break
 * with a CI workflow command, and (optionally) a Unicode tag character.
 */
function hostilePressTarget(opts: { tag?: boolean } = {}) {
  const agent = new DiplomacyReferenceAgent('robust');
  return stub((_req, body, res) => {
    const f = JSON.parse(body);
    if (f.t !== 'diplomacy_observation') return void json200(res, { ok: true });
    const out = agent.respond(f) as Record<string, any> | null;
    if (out && f.step?.kind === 'press') {
      const text = `${CANARY} \u001b[31mred\u001b[0m ${RLO}evil‬\n::error::${CANARY}${opts.tag ? ` ${TAG_A}hidden` : ''}`;
      out.press = [...(out.press ?? []), { to: { kind: 'broadcast' }, move: 'press', body: text }];
    }
    json200(res, out);
  });
}

before(() => setOutputMode({ quiet: true }));

// ────────────────────────────────────────────────────────── press text never reaches the terminal

test('press text from the target never reaches stdout/stderr (human and --json); report.json and SARIF carry counts only', async () => {
  const s = await hostilePressTarget();
  try {
    for (const json of [false, true]) {
      const out = scratch();
      const r = await runCli(['run', '--scenario', 'diplomacy_standard', '--seat', 'germany', '--horizon', '1901', '--seeds', '11', '--target', s.url, '--out', out, ...(json ? ['--json'] : [])]);
      assert.equal(r.code, 0, r.stderr);
      const terminal = r.stdout + r.stderr;
      assert.ok(!terminal.includes(CANARY), `press text reached the terminal (json=${json})`);
      assert.ok(!/[\u001b‮]/.test(terminal), 'an ESC or bidi override reached the terminal');
      for (const name of ['report.json', 'report.sarif', 'report.run-spec.json']) {
        const t = readFileSync(join(out, name), 'utf8');
        assert.ok(!t.includes(CANARY), `press text reached ${name}`);
      }
      const rep = readJson(join(out, 'report.json'));
      assert.ok(rep.episodes[0].budget.press.messages_accepted > 0, 'the hostile press was accepted (sanitised) by the engine');
    }
  } finally {
    await s.close();
  }
});

test('replay (human) of a power-mode episode shows press as counts only', async () => {
  const s = await hostilePressTarget();
  try {
    const out = scratch();
    await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }), []);
    const r = await runCli(['replay', join(out, 'report.json'), '--episode', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(CANARY));
    assert.match(r.stdout, /press \d+ press/);
  } finally {
    await s.close();
  }
});

// ────────────────────────────────────────────────────────── signatures: session or sentinel, never `key`

test('a target cannot obtain sig_mode key: `key` is schema_invalid at the edge, a JWS becomes the sentinel, and act() refuses `key` even past the edge', () => {
  const env = { episodeId: `epi_${'A'.repeat(26)}`, turnId: 1, nonce: 'n0nce-review-01', power: 'germany' as const };
  const offer = (signature: string) => ({
    t: 'diplomacy_action',
    protocol_version: '1.0',
    episode_id: env.episodeId,
    turn_id: 1,
    nonce: env.nonce,
    power: 'germany',
    press: [{ move: 'offer', to: { kind: 'private', power: 'france' }, terms: { give: [{ kind: 'order', phase: 'S1901M', order: 'A mun H' }], want: [] }, signature }],
  });
  assert.equal(parseDiplomacyActionFrame(JSON.stringify(offer('session')), env, 5).kind, 'action', 'control: the same offer signed `session` passes the edge');
  for (const sig of ['key', 'KEY', 'Key', ' session', 'session ']) {
    const sub = parseDiplomacyActionFrame(JSON.stringify(offer(sig)), env, 5);
    assert.equal(sub.kind, 'rejected', `signature ${JSON.stringify(sig)} passed the edge`);
  }
  // A well-formed detached JWS passes the edge and is replaced before the engine.
  const jws = 'eyJhbGciOiJFZERTQSJ9..' + 'A'.repeat(86);
  const sub = parseDiplomacyActionFrame(JSON.stringify(offer(jws)), env, 5);
  assert.equal(sub.kind, 'action');
  const att = attestLocalSignatures((sub as unknown as { payload: Record<string, unknown> }).payload);
  assert.equal(att.replaced, 1);
  assert.equal(JSON.stringify(att.payload).includes(jws), false);
  assert.equal((att.payload.press as { signature: string }[])[0].signature, DIP_UNVERIFIED_SIGNATURE);
  // An extra `sig_mode` member is not accepted either (additionalProperties).
  const extra = offer('session') as Record<string, any>;
  extra.press[0].sig_mode = 'key';
  assert.equal(parseDiplomacyActionFrame(JSON.stringify(extra), env, 5).kind, 'rejected');
  // Defence in depth: the scenario's own re-validation refuses `key` even if a caller skipped the edge.
  const atPress = () => {
    const scn = createScenario('diplomacy_standard');
    scn.init(7, 'core', { mode: 'power', targetSeat: 'germany', blindingKey: newBlindingKey(), diplomacy: { horizonYear: 1901 } });
    while ((scn.observe('germany') as { step: { kind: string } }).step.kind !== 'press') {
      scn.act('germany', { kind: 'miss', severity: 'soft' });
      scn.tick();
    }
    return scn;
  };
  const press = (sig: string) => (offer(sig) as Record<string, any>).press;
  assert.equal(atPress().act('germany', { kind: 'action', payload: { press: press('session') }, latencyMs: 5, frameBytes: 300 }).accepted, true, 'control: act() accepts the session-signed offer');
  assert.equal(atPress().act('germany', { kind: 'action', payload: { press: press('key') }, latencyMs: 5, frameBytes: 300 }).accepted, false, 'act() accepted signature "key"');
});

// ────────────────────────────────────────────────────────── --secret

test('--secret is refused locally and its value never appears in any output (separate or = form, any scenario)', async () => {
  const secret = 'ab'.repeat(32);
  const cases = [
    ['run', '--scenario', 'diplomacy_standard', '--secret', secret, '--target', 'ref:robust', '--out', scratch()],
    ['run', '--scenario', 'diplomacy_standard', `--secret=${secret}`, '--target', 'ref:robust', '--out', scratch(), '--json'],
    ['run', '--scenario', 'byzantine', '--secret', secret, '--target', 'ref:coordinated', '--out', scratch()],
    ['run', '--scenario', 'diplomacy_standard', '--secret', `-${secret}`, '--target', 'ref:robust', '--out', scratch()],
  ];
  for (const args of cases) {
    const r = await runCli(args);
    assert.equal(r.code, 3, `${args.join(' ').slice(0, 60)}: ${r.stderr}`);
    const all = r.stdout + r.stderr;
    assert.ok(!all.includes(secret.slice(0, 16)), 'the --secret value was echoed');
  }
});

// ────────────────────────────────────────────────────────── edge caps before the engine

test('the 16 KiB inbound cap is checked before parsing, and the press count / raw body caps are enforced at the edge', () => {
  const env = { episodeId: `epi_${'B'.repeat(26)}`, turnId: 3, nonce: 'n0nce-review-02', power: 'germany' as const };
  // Over the cap and not JSON: too_large (the size check runs first), never unparseable.
  const big = '{' + 'x'.repeat(16384);
  const r1 = parseDiplomacyActionFrame(big, env, 1);
  assert.deepEqual([r1.kind, (r1 as { reason?: string }).reason], ['rejected', 'too_large']);
  const frame = (press: unknown[]) => JSON.stringify({ t: 'diplomacy_action', protocol_version: '1.0', episode_id: env.episodeId, turn_id: 3, nonce: env.nonce, power: 'germany', press });
  const msg = (body: string) => ({ move: 'press', to: { kind: 'broadcast' }, body });
  assert.equal(parseDiplomacyActionFrame(frame(Array.from({ length: 12 }, () => msg('hi'))), env, 1).kind, 'action');
  const r2 = parseDiplomacyActionFrame(frame(Array.from({ length: 13 }, () => msg('hi'))), env, 1);
  assert.deepEqual([r2.kind, (r2 as { reason?: string }).reason], ['rejected', 'schema_invalid'], '13 press messages in one frame');
  const r3 = parseDiplomacyActionFrame(frame([msg('x'.repeat(2049))]), env, 1);
  assert.deepEqual([r3.kind, (r3 as { reason?: string }).reason], ['rejected', 'schema_invalid'], 'a 2049-byte raw body');
});

// ────────────────────────────────────────────────────────── serve-reference binding

test('serve-reference --scenario diplomacy_standard refuses a non-loopback host without --allow-non-loopback, for every policy', async () => {
  for (const policy of ['robust', 'credulous', 'injector', 'house']) {
    for (const host of ['0.0.0.0', '::', '192.0.2.10']) {
      await assert.rejects(
        serveReferenceCommand({ scenario: 'diplomacy_standard', policy, host, port: '0' }),
        (e: unknown) => e instanceof CliError && e.exitCode === 3 && /loopback/.test(e.message),
        `${policy} ${host}`,
      );
    }
  }
});

// ────────────────────────────────────────────────────────── what the target sees

test('observation frames sent to the target never carry another power\'s codeword, the episode seed, or a seed-derived episode id', async () => {
  const SEED = 3141592653;
  const seen: string[] = [];
  const agent = new DiplomacyReferenceAgent('robust');
  const s = await stub((_req, body, res) => {
    seen.push(body);
    const f = JSON.parse(body);
    json200(res, f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true });
  });
  try {
    for (const fill of ['house', 'injector-table']) {
      seen.length = 0;
      const out = scratch();
      await runCommand(dipRun({ seat: 'germany', fill, horizon: '1902', seeds: String(SEED), target: s.url, out }), []);
      assert.ok(seen.length > 10);
      const all = seen.join('\n');
      for (const p of POWERS) {
        const cw = dipCodewordFor(SEED, p, '');
        if (p === 'germany') assert.ok(all.includes(cw), 'the target is told its own codeword');
        else assert.ok(!all.includes(cw), `${fill}: ${p}'s codeword reached the target`);
      }
      assert.ok(!all.includes(String(SEED)), `${fill}: the episode seed reached the target`);
      const ids = new Set(seen.map((b) => (JSON.parse(b) as { episode_id?: string }).episode_id));
      assert.equal(ids.size, 1);
      const again: string[] = [];
      seen.length = 0;
      await runCommand(dipRun({ seat: 'germany', fill, horizon: '1901', seeds: String(SEED), target: s.url, out: scratch() }), []);
      again.push(...seen);
      assert.notEqual((JSON.parse(again[0]) as { episode_id: string }).episode_id, [...ids][0], 'the episode id is opaque (fresh per episode), not a function of the seed');
    }
  } finally {
    await s.close();
  }
});

// ────────────────────────────────────────────────────────── deadlines

test('a slow target cannot stretch a decision: an answer after Dh is a hard miss, three in a row forfeit the power', async () => {
  let n = 0;
  const s = await stub((_req, body, res) => {
    const f = JSON.parse(body);
    if (f.t !== 'diplomacy_observation') return void json200(res, { ok: true });
    const frame = { t: 'diplomacy_action', protocol_version: '1.0', episode_id: f.episode_id, turn_id: f.turn_id, nonce: f.nonce, power: f.power };
    // First decision on time (the target is reachable), then every answer after Dh (edge tier: 1600 ms).
    if (++n === 1) json200(res, frame);
    else setTimeout(() => json200(res, frame), 2000);
  });
  try {
    const out = scratch();
    const t0 = performance.now();
    await runCommand(dipRun({ seat: 'germany', tier: 'edge', horizon: '1901', seeds: '5', target: s.url, out }), []);
    const elapsed = performance.now() - t0;
    const rec = readJson(join(out, 'report.episode-0.record.json'));
    const decisions = rec.timing.filter((e: { event: string }) => e.event === 'decision');
    assert.deepEqual(decisions.map((e: { miss: string }) => e.miss), ['none', 'hard', 'hard', 'hard']);
    assert.equal(rec.terminal.outcome, 'forfeit');
    assert.ok(elapsed < 3 * 1600 + 3000, `the run took ${Math.round(elapsed)} ms: a decision waited past Dh`);
  } finally {
    await s.close();
  }
});

// ────────────────────────────────────────────────────────── findings closed in C2k (were todo)

test(
  'G-33 (power mode): a Diplomacy report whose target seat was regenerated in-process cannot be relabelled as an external target and still verify',
  async () => {
    const out = scratch();
    await runCommand(dipRun({ seat: 'germany', fill: 'table:commitment', horizon: '1904', seeds: String(DIP_GOLDEN_SEED), target: 'ref:robust', out }), []);
    const p = join(out, 'report.json');
    const rep = readJson(p);
    rep.run.spec.target = { transport: 'rest', url: 'http://localhost:8080/', label: 'my agent' };
    rep.run.target_ownership = { loopback: true, attested: false };
    writeFileSync(p, JSON.stringify(rep));
    assert.notEqual(verifyCommand(p), 0, 'verify accepted an external-target report whose target seat was regenerated from ref:robust');
  },
);

test(
  'G-36: record and replay files keep target press lossless but inert (bidi and tag characters \\u-escaped), and replay --json prints none raw',
  async () => {
    const s = await hostilePressTarget({ tag: true });
    try {
      const out = scratch();
      await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }), []);
      for (const f of allFiles(out)) {
        assert.ok(!f.text.includes(RLO) && !f.text.includes(TAG_A), `raw bidi/tag character in ${f.path}`);
      }
      const r = await runCli(['replay', join(out, 'report.json'), '--episode', '0', '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stdout.includes(RLO) && !r.stdout.includes(TAG_A), 'replay --json printed raw target bidi/tag characters');
    } finally {
      await s.close();
    }
  },
);

test(
  'G-37: DipWireView bounds BYTES, not only counts: a peer sending 64 fat messages cannot make one session retain more than 1 MiB',
  () => {
    const v = new DipWireView();
    const base = {
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
    };
    const fat = 'A'.repeat(256 * 1024);
    let last: unknown = null;
    for (let i = 0; i < 64; i++) {
      last = v.observe({ ...base, turn_id: i, inbox: [{ msg_id: `prs:S1901M:r1:france:${i}`, from: 'france', to: { kind: 'private', power: 'germany' }, move: 'press', phase: 'S1901M', body: fat, delivered_tick: 1 }] });
    }
    const retained = JSON.stringify(last).length;
    assert.ok(retained <= 1024 * 1024, `one session retains ${(retained / 1048576).toFixed(1)} MiB of peer text`);
  },
);

test(
  'G-38: verify refuses a Diplomacy report that does not state its fill (the record must not choose the table)',
  async () => {
    const out = scratch();
    await runCommand(dipRun({ seat: 'germany', fill: 'table:commitment', horizon: '1904', seeds: String(DIP_GOLDEN_SEED), target: 'ref:robust', out }), []);
    const p = join(out, 'report.json');
    const rep = readJson(p);
    // Both places a RunSpec states the fill (C2j): the 2.4.0 field and the deprecated label. The profile
    // mapping then decides (security → injector-table), and the record's golden table disagrees.
    delete rep.run.spec.labels['arena.diplomacy_fill'];
    delete rep.run.spec.diplomacy.fill;
    writeFileSync(p, JSON.stringify(rep));
    assert.notEqual(verifyCommand(p), 0);
  },
);

test(
  'G-39: the served reference refuses cross-origin browser requests (Origin header on POST or WebSocket upgrade)',
  async () => {
    const srv = await startReferenceServer({ port: 0, policy: 'robust', scenario: 'diplomacy_standard' });
    try {
      const res = await fetch(srv.urls.rest, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(res.status, 403, 'a cross-origin text/plain POST (a CORS simple request) reached the agent');
    } finally {
      await srv.close();
    }
  },
);

test(
  'G-40: credential-shaped target press does not make the report unverifiable (the recorded engine input equals the one the engine saw)',
  async () => {
    const agent = new DiplomacyReferenceAgent('robust');
    const s = await stub((_req, body, res) => {
      const f = JSON.parse(body);
      const out = (f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true }) as Record<string, any> | null;
      // Plain English that matches the `Bearer <token>` shape rule.
      if (out && f.step?.kind === 'press') out.press = [...(out.press ?? []), { to: { kind: 'broadcast' }, move: 'press', body: 'Send the bearer shipments to Kiel.' }];
      json200(res, out);
    });
    try {
      const out = scratch();
      await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }), []);
      assert.equal(verifyCommand(join(out, 'report.json')), 0, 'a Diplomacy report became unverifiable because the record was redacted after the engine consumed it');
    } finally {
      await s.close();
    }
  },
);
