/**
 * Phase 8 C2k: closing the Diplomacy CLI review (docs/phase-8/SECURITY-REVIEW-DIPLOMACY.md).
 * The reviewer's own tests (security-review-diplomacy.test.ts) are no longer `todo`;
 * these pin the rest of each fix:
 *   G-40  press redacted at the edge (engine input = record), counted, verify names a write-time redaction;
 *   G-36  inert, lossless serialisation; terminal stripping; record strings cut in verify errors;
 *   G-33  a driver mismatch on every episode is `mismatch`, exit 1;
 *   G-37  DipWireView keeps projections within per-session and global byte budgets;
 *   G-38  a local record must carry the empty episode secret;
 *   G-39  Origin allowlist on the loopback reference server (HTTP and WebSocket).
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createScenario, diplomacyObservationFrame, DIP_GOLDEN_SEED, newBlindingKey } from 'arena-scenarios';
import { runCommand, type RunFlags } from '../src/commands/run.ts';
import { serveReferenceCommand } from '../src/commands/serve-reference.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { DIP_PRESS_REDACTION_MARKER, DIP_PRESS_REDACTIONS_LABEL, redactPressText } from '../src/diplomacy.ts';
import { CliError } from '../src/errors.ts';
import { inertJson, isInert, recordText, stripActive, toInertJson } from '../src/inert.ts';
import { clearSecrets, registerSecret } from '../src/redact.ts';
import { DiplomacyReferenceAgent, DipWireView, projectWireMessage } from '../src/reference/diplomacy.ts';
import { startReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode, toTerminalSafe } from '../src/ui.ts';
import { runCli, scratch, stub } from './helpers.ts';

const dipRun = (f: Partial<RunFlags>): RunFlags => ({ scenario: 'diplomacy_standard', ...f });
const readJson = <T = Record<string, any>>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const json200 = (res: import('node:http').ServerResponse, v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
const RLO = '‮';
const TAG_A = '\u{E0041}';

before(() => setOutputMode({ quiet: true }));

/** A served robust-diplomat adding one broadcast with `body` on every press step. */
function pressTarget(body: string) {
  const agent = new DiplomacyReferenceAgent('robust');
  return stub((_req, raw, res) => {
    const f = JSON.parse(raw);
    const out = (f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true }) as Record<string, any> | null;
    if (out && f.step?.kind === 'press') out.press = [...(out.press ?? []), { to: { kind: 'broadcast' }, move: 'press', body }];
    json200(res, out);
  });
}

// ────────────────────────────────────────────────────────── G-40

test('G-40: redactPressText replaces credential shapes and registered secrets in every string of a payload, counts them, and never mutates the input', () => {
  const secret = 'zq81Kp0rTs9vWx4y';
  registerSecret(secret, 'env');
  try {
    const payload = {
      press: [
        { move: 'press', to: { kind: 'broadcast' }, body: 'Send the bearer shipments to Kiel.' },
        { move: 'offer', to: { kind: 'private', power: 'france' }, terms: { give: [], want: [], note: `key ${secret} ok` }, signature: 'session' },
        { move: 'press', to: { kind: 'broadcast' }, body: 'plain words only' },
      ],
      intent: { orders: ['A mun H'], notes: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }, // EXAMPLE: synthetic value for this test, not a credential
    };
    const before = JSON.stringify(payload);
    const r = redactPressText(payload);
    assert.equal(JSON.stringify(payload), before, 'the input was mutated');
    assert.equal(r.replaced, 3);
    const p = r.payload as typeof payload;
    assert.equal(p.press[0].body, `Send the ${DIP_PRESS_REDACTION_MARKER} to Kiel.`);
    assert.equal(p.press[1].terms!.note, `key ${DIP_PRESS_REDACTION_MARKER} ok`);
    assert.equal(p.press[2].body, 'plain words only');
    assert.equal(p.intent.notes, `token ${DIP_PRESS_REDACTION_MARKER}`);
    // The marker passes the engine's press allow-list (L/N/P/S/Zs) and is itself left alone by the redactor.
    assert.match(DIP_PRESS_REDACTION_MARKER, /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]+$/u);
    assert.equal(redactPressText({ press: [{ body: DIP_PRESS_REDACTION_MARKER }] }).replaced, 0);
    // Nothing to redact: the very same object comes back.
    const clean = { press: [{ body: 'hello' }] };
    assert.equal(redactPressText(clean).payload, clean);
  } finally {
    clearSecrets();
  }
});

test('G-40: the engine sees the redacted press, the record holds the same bytes, the episode counts it in budget.press.redactions (contracts 2.5.0; the 2.6.0-withdrawn label is gone), and verify succeeds', async () => {
  const s = await pressTarget('Send the bearer shipments to Kiel.');
  try {
    const out = scratch();
    await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }), []);
    const rec = readJson(join(out, 'report.episode-0.record.json'));
    const inputs = JSON.stringify(rec.diplomacy.targetInputs);
    assert.ok(!/bearer shipments/i.test(inputs), 'the credential-shaped press reached the record');
    assert.ok(inputs.includes(`Send the ${DIP_PRESS_REDACTION_MARKER} to Kiel.`), 'the redacted press is the recorded engine input');
    assert.ok(!inputs.includes('[redacted:'), 'writeOutput had something left to redact: the engine input and the file differ');
    const rep = readJson(join(out, 'report.json'));
    assert.ok(rep.episodes[0].budget.press.redactions >= 1, 'per-episode redaction count');
    assert.equal(rep.run.spec.labels[DIP_PRESS_REDACTIONS_LABEL], undefined, 'the per-run label is withdrawn at contracts 2.6.0');
    assert.equal(readJson(join(out, 'report.run-spec.json')).labels[DIP_PRESS_REDACTIONS_LABEL], undefined);
    assert.equal(verifyCommand(join(out, 'report.json')), 0);
  } finally {
    await s.close();
  }
});

test('G-40: a record redacted AFTER the run (a pre-C2k file) fails verify with the cause named, not only "hash differs"', async () => {
  const s = await pressTarget('Send the bearer shipments to Kiel.');
  try {
    const out = scratch();
    await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }), []);
    const p = join(out, 'report.episode-0.record.json');
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll(DIP_PRESS_REDACTION_MARKER, '[redacted:shape]'));
    const r = await runCli(['verify', join(out, 'report.json'), '--json']);
    assert.equal(r.code, 2, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.match(doc.errors.join('\n'), /redaction labels written after the run/);
  } finally {
    await s.close();
  }
});

test('G-40: budget.press.redactions is 0 over a transport with clean press and absent in-process (contracts 2.5.0); no label either way', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: 'ref:robust', out }), []);
  const local = readJson(join(out, 'report.json'));
  assert.equal(local.run.spec.labels[DIP_PRESS_REDACTIONS_LABEL], undefined);
  assert.equal(local.episodes[0].budget.press?.redactions, undefined, 'absent for in-process targets');
  const s = await pressTarget('Hold in Kiel, then talk.');
  try {
    const out2 = scratch();
    await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out: out2 }), []);
    const rep = readJson(join(out2, 'report.json'));
    assert.equal(rep.episodes[0].budget.press.redactions, 0, 'written for every Diplomacy episode over a transport, 0 included');
    assert.equal(rep.run.spec.labels[DIP_PRESS_REDACTIONS_LABEL], undefined);
    assert.equal(verifyCommand(join(out2, 'report.json')), 0);
  } finally {
    await s.close();
  }
});

// ────────────────────────────────────────────────────────── G-36

const HOSTILE = [
  `a${RLO}b‭c‪d⁦e⁩`, // bidi overrides and isolates
  `x${TAG_A}\u{E007F}y`, // tag characters
  'z​w‍﻿­', // zero-width, BOM, soft hyphen
  'line para end', // Zl / Zp
  'pua\u{F0000}\u{10FFFD}', // private use (BMP and astral)
  'vs️\u{E0100}', // variation selectors
  'c1\u0085\u009B[31m', // C1 (NEL, CSI)
  'lone\uD800high and \uDC00low', // lone surrogates
  'ok: é 日本 🙂 “quotes” — dash', // printable non-ASCII stays raw
];

test('G-36: inertJson is lossless (serialise → parse → the same string) and its output carries no active code point', () => {
  for (const s of HOSTILE) {
    const v = { s, nested: [s, { k: s }] };
    for (const text of [toInertJson(v), toInertJson(v, 2), inertJson(JSON.stringify(v, null, 1))]) {
      assert.deepEqual(JSON.parse(text), v, `round trip of ${JSON.stringify(s)}`);
      assert.ok(isInert(text), `active code point left in ${JSON.stringify(text)}`);
    }
  }
  // Printable text is not escaped; pretty-printing whitespace is kept.
  assert.ok(toInertJson({ s: HOSTILE[8] }).includes('é 日本 🙂'));
  assert.equal(toInertJson({ a: 1 }, 2), '{\n  "a": 1\n}');
  // Astral active code points become a surrogate-pair escape.
  assert.equal(inertJson(JSON.stringify(TAG_A)), '"\\uDB40\\uDC41"');
});

test('G-36: terminal text strips bidi, zero-width, tag and private-use characters; record strings in errors are cut and stripped', () => {
  for (const s of HOSTILE.slice(0, 8)) {
    const t = toTerminalSafe(s, 400);
    assert.ok(isInert(t), `active code point on the terminal: ${JSON.stringify(t)}`);
  }
  assert.equal(stripActive(`a${RLO}b${TAG_A}c`), 'abc');
  const long = `${RLO}${'x'.repeat(500)}\nnext`;
  const q = recordText(long);
  assert.ok(isInert(q) && !q.includes('\n'));
  assert.ok([...q].length <= 41, `record text not cut: ${q.length}`);
});

test('G-36: a verify error built from a hostile record field is short and inert (human and --json)', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: 'ref:robust', out }), []);
  const p = join(out, 'report.episode-0.record.json');
  const rec = readJson(p);
  rec.targetSeat = `${RLO}${TAG_A}${'g'.repeat(400)}`;
  writeFileSync(p, JSON.stringify(rec));
  const human = await runCli(['verify', join(out, 'report.json')]);
  assert.equal(human.code, 2, human.stderr);
  assert.ok(!human.stdout.includes(RLO) && !human.stdout.includes(TAG_A));
  const js = await runCli(['verify', join(out, 'report.json'), '--json']);
  assert.ok(!js.stdout.includes(RLO) && !js.stdout.includes(TAG_A), 'raw bidi/tag in verify --json');
  const err: string = JSON.parse(js.stdout).errors.join('\n');
  assert.match(err, /record seat/);
  assert.ok(!err.includes(RLO) && !err.includes(TAG_A), 'the record string was interpolated unsanitised');
  assert.ok(!err.includes('g'.repeat(60)), 'the record string was interpolated uncut');
});

// ────────────────────────────────────────────────────────── G-33

test('G-33 exit code: an in-process Diplomacy report relabelled as an external target is a mismatch (exit 1), not unverifiable input', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', fill: 'table:commitment', horizon: '1904', seeds: String(DIP_GOLDEN_SEED), target: 'ref:robust', out }), []);
  const p = join(out, 'report.json');
  const rep = readJson(p);
  rep.run.spec.target = { transport: 'rest', url: 'http://localhost:8080/', label: 'my agent' };
  rep.run.target_ownership = { loopback: true, attested: false };
  writeFileSync(p, JSON.stringify(rep));
  assert.equal(verifyCommand(p), 1);
  const r = await runCli(['verify', p, '--json']);
  assert.equal(r.code, 1, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.status, 'mismatch');
  assert.match(doc.errors[0], /seat provenance mismatch \(G-33\)/);
});

test('G-33 exit code: other unverifiable input keeps exit 2 (a missing record)', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: 'ref:robust', out }), []);
  writeFileSync(join(out, 'report.episode-0.record.json'), '{}');
  assert.equal(verifyCommand(join(out, 'report.json')), 2);
});

// ────────────────────────────────────────────────────────── G-37

/** A real observation frame for germany at S1901M (the wire shape the arena sends). */
function realFrame(episodeId: string): Record<string, any> {
  const scn = createScenario('diplomacy_standard');
  scn.init(7, 'core', { mode: 'power', targetSeat: 'germany', blindingKey: newBlindingKey(), diplomacy: { horizonYear: 1901 } });
  return diplomacyObservationFrame(scn.observe('germany') as never, { episodeId, nonce: 'n0nce-c2k-000001' }) as Record<string, any>;
}
const SENDERS = ['austria', 'england', 'france', 'italy', 'russia', 'turkey'];
function fatInbox(n: number, phase = 'S1901M'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    msg_id: `prs:${phase}:r${1 + (Math.floor(i / 12) % 3)}:${SENDERS[Math.floor(i / 36) % 6]}:${1 + (i % 12)}`,
    from: SENDERS[Math.floor(i / 36) % 6],
    to: { kind: 'private', power: 'germany', junk: 'J'.repeat(10_000) },
    move: 'press',
    phase,
    round: 1,
    seq: 1,
    body: 'B'.repeat(200_000),
    asks: Array.from({ length: 50 }, () => 'A'.repeat(5000)),
    terms: { give: Array.from({ length: 40 }, () => ({ kind: 'order', phase, order: 'O'.repeat(5000), extra: 'E'.repeat(5000) })), want: [], note: 'N'.repeat(50_000) },
    delivered_tick: 1,
    extra: 'X'.repeat(100_000),
  }));
}

test('G-37: a stored message is the projection the agent reads, cut to the engine limits; unknown fields and bad ids are not kept', () => {
  const [m] = fatInbox(1);
  const p = projectWireMessage(m)!;
  assert.deepEqual(Object.keys(p).sort(), ['asks', 'body', 'delivered_tick', 'from', 'move', 'msg_id', 'phase', 'terms', 'to']);
  assert.equal(Buffer.byteLength(p.body as string), 600);
  assert.equal((p.asks as string[]).length, 6);
  const t = p.terms as { give: Record<string, unknown>[]; note: string };
  assert.equal(t.give.length, 6);
  assert.deepEqual(Object.keys(t.give[0]).sort(), ['kind', 'order', 'phase']);
  assert.equal(Buffer.byteLength(t.note), 200);
  assert.deepEqual(p.to, { kind: 'private', power: 'germany' });
  // Upper bound of any projection: body 600 + note 200 + 6 asks and 12 clauses of ≤ 64-char strings + ids.
  assert.ok(JSON.stringify(p).length < 4096, `projection is ${JSON.stringify(p).length} chars`);
  assert.equal(projectWireMessage({ ...m, msg_id: 'prs:S1901M:r1:france:13' }), null, 'a msg_id outside the contract pattern was kept');
  assert.equal(projectWireMessage({ ...m, msg_id: 'x'.repeat(100_000) }), null);
  assert.equal(projectWireMessage({ ...m, from: 'mordor' }), null);
});

test('G-37: one session stays within its byte budget and the agent within the global budget, evicting least recently used sessions (fat messages)', () => {
  // Per session, default budget (1 MiB): 216 distinct contract ids, each a fat message.
  const v = new DipWireView();
  const f = realFrame(`epi_${'C'.repeat(26)}`);
  const o = v.observe({ ...f, inbox: fatInbox(216) });
  assert.ok(v.bytes <= 1024 * 1024, `session retains ${v.bytes} bytes`);
  assert.ok(JSON.stringify(o).length < 1024 * 1024);
  assert.ok(o.inbox.length > 0 && o.inbox.every((m) => Buffer.byteLength(m.body ?? '') <= 600));

  // A small budget: the session keeps what fits and refuses the rest.
  const small = new DipWireView(16 * 1024);
  small.observe({ ...f, inbox: fatInbox(216) });
  assert.ok(small.bytes <= 16 * 1024 && small.bytes > 8 * 1024, `small session retains ${small.bytes} bytes`);

  // Global: 64 KiB across sessions of 16 KiB each; 20 fat episodes leave at most four sessions.
  const agent = new DiplomacyReferenceAgent('robust', DIP_GOLDEN_SEED, { sessions: 64, globalBytes: 64 * 1024, sessionBytes: 16 * 1024 });
  const ids = Array.from({ length: 20 }, (_, i) => `epi_${String(i).padStart(26, '0')}`);
  for (const id of ids) agent.respond({ ...realFrame(id), inbox: fatInbox(216) });
  assert.ok(agent.bytes <= 64 * 1024, `agent retains ${agent.bytes} bytes`);
  assert.ok(agent.sessions <= 5 && agent.sessions >= 1, `${agent.sessions} sessions kept`);
  // The most recent session survives; the oldest was evicted (a new view starts empty).
  const again = new DiplomacyReferenceAgent('robust', DIP_GOLDEN_SEED, { sessions: 2, globalBytes: 1 << 30, sessionBytes: 1 << 20 });
  for (const id of ids.slice(0, 3)) again.respond(realFrame(id));
  assert.equal(again.sessions, 2, 'the session count cap evicts');
});

test('G-37: the served reference still answers normally with the projected view (a plain frame gets an action)', () => {
  const agent = new DiplomacyReferenceAgent('robust');
  const out = agent.respond(realFrame(`epi_${'D'.repeat(26)}`));
  assert.ok(out && out.t === 'diplomacy_action');
});

// ────────────────────────────────────────────────────────── G-38

test('G-38: a local Diplomacy record that carries an episode secret (it would re-key every codeword) does not verify', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', horizon: '1901', seeds: '11', target: 'ref:robust', out }), []);
  const p = join(out, 'report.episode-0.record.json');
  const rec = readJson(p);
  rec.diplomacy.episodeSecret = 'ab'.repeat(32);
  writeFileSync(p, JSON.stringify(rec));
  const r = await runCli(['verify', join(out, 'report.json'), '--json']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(JSON.parse(r.stdout).errors.join('\n'), /empty secret/);
  // The commitment alone is refused too.
  rec.diplomacy.episodeSecret = '';
  rec.diplomacy.episodeSecretCommitment = `sha256:${'0'.repeat(64)}`;
  writeFileSync(p, JSON.stringify(rec));
  assert.equal(verifyCommand(join(out, 'report.json')), 2);
});

test('G-38: with neither diplomacy.fill nor the label, the profile mapping decides (and a matching record still verifies)', async () => {
  const out = scratch();
  await runCommand(dipRun({ seat: 'germany', fill: 'injector-table', horizon: '1901', seeds: '11', target: 'ref:robust', out }), []);
  const p = join(out, 'report.json');
  const rep = readJson(p);
  delete rep.run.spec.labels['arena.diplomacy_fill'];
  delete rep.run.spec.diplomacy.fill;
  writeFileSync(p, JSON.stringify(rep));
  assert.equal(verifyCommand(p), 0, 'security → injector-table agrees with the record');
  rep.run.spec.diplomacy.profile = 'clean';
  writeFileSync(p, JSON.stringify(rep));
  assert.notEqual(verifyCommand(p), 0, 'clean → house disagrees with the record');
});

// ────────────────────────────────────────────────────────── G-39

function wsStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('error', (e) => reject(e));
  });
}

test('G-39: a WebSocket upgrade with a browser Origin is refused (403); without Origin, or with an allowed one, it opens', async () => {
  const srv = await startReferenceServer({ port: 0, policy: 'robust', scenario: 'diplomacy_standard' });
  try {
    assert.equal(await wsStatus(srv.urls.ws, 'https://attacker.example'), 403);
    assert.equal(await wsStatus(srv.urls.ws, 'null'), 403);
    assert.equal(await wsStatus(srv.urls.ws), 101);
    const h = await fetch(srv.urls.healthz, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(h.status, 403, 'GET with an Origin reached the agent');
    assert.equal((await fetch(srv.urls.healthz)).status, 200);
  } finally {
    await srv.close();
  }
  const allowed = await startReferenceServer({ port: 0, policy: 'robust', scenario: 'diplomacy_standard', allowedOrigins: ['http://localhost:5173'] });
  try {
    assert.equal(await wsStatus(allowed.urls.ws, 'http://localhost:5173'), 101);
    assert.equal(await wsStatus(allowed.urls.ws, 'http://localhost:5174'), 403);
    assert.equal((await fetch(allowed.urls.healthz, { headers: { origin: 'http://localhost:5173' } })).status, 200);
  } finally {
    await allowed.close();
  }
});

test('G-39: serve-reference --allow-origin takes exact origins only', async () => {
  for (const bad of ['*', 'null', 'http://x.example/path', 'javascript:alert(1)', 'http://x.example:99999999']) {
    await assert.rejects(
      serveReferenceCommand({ scenario: 'diplomacy_standard', policy: 'robust', port: '0', allowOrigin: [bad] }),
      (e: unknown) => e instanceof CliError && e.exitCode === 3 && /exact origin/.test(e.message),
      bad,
    );
  }
});

test('G-39: a run against the served reference is unaffected (the arena sends no Origin)', async () => {
  const srv = await startReferenceServer({ port: 0, policy: 'robust', scenario: 'diplomacy_standard' });
  try {
    for (const target of [srv.urls.rest, srv.urls.ws]) {
      const out = scratch();
      const r = await runCli(['run', '--scenario', 'diplomacy_standard', '--seat', 'germany', '--horizon', '1901', '--seeds', String(DIP_GOLDEN_SEED), '--target', target, '--out', out]);
      assert.equal(r.code, 0, r.stderr);
      const rec = readJson(join(out, 'report.episode-0.record.json'));
      assert.ok(rec.diplomacy.targetInputs.length > 0, `${target}: the target answered nothing`);
    }
  } finally {
    await srv.close();
  }
});
