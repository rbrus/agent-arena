/**
 * Security closure pass 2026-09-26 (docs/phase-7/SECURITY-REVIEW.md §9).
 *
 * Plain tests pin the two edges C2k added and that this pass hand-reviewed:
 *   - net/server.ts: Origin allowlist refuses before the body is read, on plain
 *     requests and on WebSocket upgrades;
 *   - runner.ts attested(): signature attestation runs before press redaction
 *     (a JWS never reaches the redactor), and the redaction is a fixed point of
 *     writeOutput's backstop.
 * The findings this pass opened (G-41 … G-44) are closed by C2l; their tests
 * below are plain tests.
 */

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createScenario, newBlindingKey, parseDiplomacyActionFrame } from 'arena-scenarios';
import { sanitizePressText } from 'wot-engine';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { attestLocalSignatures, DIP_PRESS_REDACTION_MARKER, DIP_UNVERIFIED_SIGNATURE, redactPressText } from '../src/diplomacy.ts';
import { assertNoDiagnostics, diagnosticFlags } from '../src/hardening.ts';
import { serve } from '../src/net/server.ts';
import { clearSecrets, MIN_SECRET_LENGTH, redact, registerSecret } from '../src/redact.ts';
import { DiplomacyReferenceAgent } from '../src/reference/diplomacy.ts';
import { setOutputMode } from '../src/ui.ts';
import { runCli, scratch, stub } from './helpers.ts';

before(() => setOutputMode({ quiet: true }));

// ────────────────────────────────────────────────────────── net/server.ts (G-39 edge)

function post(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'text/plain', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function upgrade(port: number, origin?: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    ws.on('error', () => resolve(0));
  });
}

test('closure G-39: a foreign Origin is refused with 403 before onRequest runs; no Origin and allowlisted Origins pass; `null` and duplicated Origins are refused', async () => {
  let handled = 0;
  const srv = await serve({
    port: 0,
    allowedOrigins: ['http://localhost:5173'],
    onRequest: () => {
      handled++;
      return { status: 200, body: '{}' };
    },
    onWsMessage: () => null,
  });
  try {
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:' + srv.port, 'http://localhost:5173/']) {
      const r = await post(srv.port, { origin }, '{"t":"x"}');
      assert.equal(r.status, 403, `Origin ${origin} was not refused`);
    }
    assert.equal(handled, 0, 'a refused request reached onRequest');
    assert.equal((await post(srv.port, {}, '{}')).status, 200, 'control: an arena client (no Origin) is served');
    assert.equal((await post(srv.port, { origin: 'http://localhost:5173' }, '{}')).status, 200, 'control: an allowlisted Origin is served');
    assert.equal(handled, 2);
    // WebSocket upgrades: no CORS in browsers, so the upgrade itself is refused.
    assert.equal(await upgrade(srv.port, 'https://evil.example'), 403);
    assert.equal(await upgrade(srv.port, 'null'), 403);
    assert.equal(await upgrade(srv.port), 'open', 'control: an upgrade without Origin opens');
    assert.equal(await upgrade(srv.port, 'http://localhost:5173'), 'open', 'control: an allowlisted Origin opens');
  } finally {
    await srv.close();
  }
});

// ────────────────────────────────────────────────────────── runner.ts attested() (G-40 edge)

const ENV = { episodeId: `epi_${'A'.repeat(26)}`, turnId: 0, nonce: 'n0nce-review-01', power: 'germany' as const };
const frameOf = (extra: Record<string, unknown>) =>
  JSON.stringify({ t: 'diplomacy_action', protocol_version: '1.0', episode_id: ENV.episodeId, turn_id: 0, nonce: ENV.nonce, power: 'germany', ...extra });

/** The same two steps, in the same order, as runner.ts attested(). */
function edge(raw: string) {
  const sub = parseDiplomacyActionFrame(raw, ENV, 5);
  if (sub.kind !== 'action') return { sub, payload: null, replaced: 0 };
  const att = attestLocalSignatures(sub.payload as Record<string, unknown>);
  const red = redactPressText(att.payload);
  return { sub, payload: red.payload, replaced: red.replaced };
}

function freshScenario() {
  const scn = createScenario('diplomacy_standard');
  scn.init(7, 'core', { mode: 'power', targetSeat: 'germany', blindingKey: newBlindingKey(), diplomacy: { horizonYear: 1901 } });
  return scn;
}

test('closure G-40: attestation runs before redaction, so a credential-shaped signature becomes the sentinel instead of `[redacted]` (which would fail the signature pattern and drop the whole frame)', () => {
  // Matches the contract's detached-JWS pattern AND the `sk-` credential shape.
  const jws = 'sk-' + 'A'.repeat(20) + '..' + 'B'.repeat(20);
  const offer = { move: 'offer', to: { kind: 'private', power: 'france' }, terms: { give: [{ kind: 'order', phase: 'S1901M', order: 'A mun H' }], want: [] }, signature: jws };
  const e = edge(frameOf({ press: [offer] }));
  assert.equal(e.sub.kind, 'action');
  assert.equal((e.payload!.press as { signature: string }[])[0].signature, DIP_UNVERIFIED_SIGNATURE);
  assert.equal(e.replaced, 0, 'the sentinel must match no redaction shape');
  // Reverse order (redact first) would have hit the JWT shape inside the JWS.
  assert.notEqual(redact(jws), jws, 'premise: the signature alone matches a credential shape');
});

/** Random press bodies built from credential shapes, escapes, invisibles and (optionally) pieces of a registered secret. */
function fuzzFixedPoint(secret: string | null, n: number): string | null {
  const alpha = ['Bearer ', 'bearer\t', 'ghp_', 'eyJ', 'eyJabcdefgh.', '.', '\\', '\\u002B', 'u', '&', '&#43;', '&amp;', '%2B', ' ', '\u200b', '\u202e', 'a', 'Z', '9', '+', '/', '"', 'AKIA', 'sk-', 'wotk_sk_', 'github_pat_', 'AAAAAAAA', '[redacted]'];
  if (secret) alpha.push(secret.slice(0, 8), secret.slice(-8), secret, secret.slice(0, 12));
  let seed = 20260926;
  const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % k);
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let j = 1 + rnd(12); j > 0; j--) s += alpha[rnd(alpha.length)];
    const out = (redactPressText({ press: [{ body: s }] }).payload.press as { body: string }[])[0].body;
    const file = JSON.stringify({ press: [{ body: out }] });
    if (redact(file) !== file) return s;
    // The transcript / replay file carry the engine's sanitised text of the same body.
    const san = sanitizePressText(out, Infinity, Infinity, true);
    if (san.ok && redact(JSON.stringify(san.text)) !== JSON.stringify(san.text)) return s;
    if (out.length > s.length) return s;
  }
  return null;
}

test(
  'G-44: with no registered secret, edge-redacted press is a fixed point of writeOutput\'s backstop (JSON escapes such as \\n are not read as letters)',
  () => {
    clearSecrets();
    const body = 'Bring the bearer bonds\nto Kiel.';
    assert.equal(redact(body), body, 'premise: the raw text matches no shape at the edge');
    const file = JSON.stringify({ press: [{ body }] });
    assert.equal(redact(file), file, 'the serialised record is redacted on write although the edge found nothing');
    const bad = fuzzFixedPoint(null, 30000);
    assert.equal(bad, null, `backstop changed an edge-redacted body; input ${JSON.stringify(bad)}`);
  },
);

test(
  'G-44: honest multi-line press ("bearer bonds" then a line break) keeps the report verifiable',
  async () => {
    clearSecrets();
    const agent = new DiplomacyReferenceAgent('robust');
    const s = await stub((_req, body, res) => {
      const f = JSON.parse(body);
      const out = (f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true }) as Record<string, any> | null;
      if (out && f.step?.kind === 'press') out.press = [...(out.press ?? []), { to: { kind: 'broadcast' }, move: 'press', body: 'Bring the bearer bonds\nto Kiel.' }];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
    try {
      const out = scratch();
      await runCommand({ scenario: 'diplomacy_standard', seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }, []);
      assert.equal(verifyCommand(join(out, 'report.json')), 0, 'a Diplomacy report with honest multi-line press became unverifiable');
    } finally {
      await s.close();
    }
  },
);

test(
  'G-43: with the run\'s credential registered, edge-redacted press is still a fixed point of the backstop',
  () => {
    const SECRET = 'Zq9+Xy/w8Kp3Lm7Tv2Rs';
    registerSecret(SECRET, 'env');
    try {
      // Deterministic case: a Bearer shape, an RLO the raw shape rule stops at, and the credential's first 8 chars at the end.
      const body = `Bearer \u202ewotk_sk_9${SECRET.slice(0, 8)}`;
      const out = (redactPressText({ press: [{ body }] }).payload.press as { body: string }[])[0].body;
      const file = JSON.stringify({ press: [{ body: out }] });
      assert.equal(redact(file), file, `edge output ${JSON.stringify(out)} is redacted again on write`);
      const bad = fuzzFixedPoint(SECRET, 30000);
      assert.equal(bad, null, `backstop changed an edge-redacted body; input ${JSON.stringify(bad)}`);
    } finally {
      clearSecrets();
    }
  },
);

test(
  'G-42: edge redaction never grows a field, so a schema-valid frame is never turned into schema_invalid by act()',
  () => {
    assert.ok(DIP_PRESS_REDACTION_MARKER.length <= MIN_SECRET_LENGTH, `the edge marker (${DIP_PRESS_REDACTION_MARKER.length} chars) is longer than the shortest span it replaces (${MIN_SECRET_LENGTH})`);
    const SECRET = 'tgtTok3nXq9Lm7Tv2Rs5';
    registerSecret(SECRET, 'env');
    try {
      const intent = (notes: string) => ({ intent: { phase: 'S1901M', orders: [], notes } });
      const control = edge(frameOf(intent('x'.repeat(1024))));
      assert.equal(freshScenario().act('germany', { ...control.sub, payload: control.payload } as never).accepted, true, 'control: a 1024-char note is accepted');
      // The target's note is exactly at the schema cap and ends with the first 8 chars of the run's own credential.
      const e = edge(frameOf(intent('x'.repeat(1016) + SECRET.slice(0, 8))));
      assert.equal(e.sub.kind, 'action', 'premise: the frame is schema-valid at the edge');
      assert.ok(e.replaced >= 1, 'premise: the secret prefix is redacted');
      const notes = (e.payload!.intent as { notes: string }).notes;
      assert.ok(notes.length <= 1024, `edge redaction grew intent.notes to ${notes.length} chars`);
      const r = freshScenario().act('germany', { ...e.sub, payload: e.payload } as never);
      assert.equal(r.accepted, true, `act() refused the redacted frame (${(r as { reason?: string }).reason}); the orders in it are lost and the decision is a hard miss`);
    } finally {
      clearSecrets();
    }
  },
);

// ────────────────────────────────────────────────────────── hardening.ts (G-41)

test(
  'G-41: Node\'s underscore spelling of a diagnostic flag in NODE_OPTIONS is refused like the dash spelling',
  () => {
    assert.deepEqual(diagnosticFlags([], '--heapsnapshot-signal=SIGUSR2'), ['--heapsnapshot-signal'], 'control: the dash spelling is refused');
    for (const flag of ['--heapsnapshot_signal=SIGUSR2', '--inspect_brk=0', '--report_on_signal', '--heapsnapshot_near_heap_limit=3']) {
      assert.notEqual(diagnosticFlags([], flag).length, 0, `${flag} (accepted by Node) was not refused`);
    }
    assert.deepEqual(diagnosticFlags(['--inspect_brk'], ''), ['--inspect_brk'], 'execArgv: the flag is named as written');
    assert.deepEqual(diagnosticFlags([], '"--heapsnapshot_signal=SIGUSR2"'), ['--heapsnapshot_signal'], 'quoted underscore spelling');
    assert.deepEqual(diagnosticFlags([], '--report_dir=/tmp/a_b --inspect_port=0 --heapsnapshot_near_heap_limit=0 --max_old_space_size=100'), [], 'configuring flags stay allowed in either spelling');
    assert.throws(() => assertNoDiagnostics({ NODE_OPTIONS: '--heapsnapshot_signal=SIGUSR2' }, []), /--heapsnapshot_signal/);
    assert.throws(() => assertNoDiagnostics({}, ['--inspect_brk']), /--inspect_brk/);
  },
);

test('G-41: the CLI refuses `NODE_OPTIONS=--heapsnapshot_signal=SIGUSR2` with exit 3, like the dash spelling', async () => {
  // (`--inspect_brk` is refused by diagnosticFlags above; spawned, Node itself would stop at the first line waiting for a debugger.)
  for (const opt of ['--heapsnapshot_signal=SIGUSR2', '--report_on_signal']) {
    const r = await runCli(['list-scenarios'], { NODE_OPTIONS: opt, ARENA_DEBUG: undefined });
    assert.equal(r.code, 3, `${opt}: ${r.stderr}`);
    assert.match(r.stderr, /refusing to run with Node diagnostics enabled/);
  }
});

// ────────────────────────────────────────────────────────── G-44 end to end, randomised

/** Random multi-line press made of words (some credential-looking) and every JSON-escapable character. */
function randomPress(rnd: (k: number) => number): string {
  const words = ['Bring', 'the', 'bearer', 'Bearer', 'bonds', 'to', 'Kiel', 'token', 'tokens', 'eyJ', 'sk-', 'ghp_', 'AAAAAAAA', 'Munich', 'hold', 'ok.', 'u002B', 'x41'];
  const seps = ['\n', '\t', '\r', '\r\n', '"', '\\', '/', '\b', '\f', ' ', ' ', ' ', '\\n', '\n\n'];
  let s = words[rnd(words.length)];
  for (let j = 2 + rnd(14); j > 0; j--) s += seps[rnd(seps.length)] + words[rnd(words.length)];
  return s;
}

test('G-44: 200+ random multi-line press strings with JSON-escapable characters round-trip run → verify (exit 0), and the record is exactly the engine input', async () => {
  clearSecrets();
  const agent = new DiplomacyReferenceAgent('robust');
  let seed = 44;
  const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % k);
  const sent: string[] = [];
  const others = ['france', 'england', 'italy', 'austria', 'russia', 'turkey'];
  const s = await stub((_req, body, res) => {
    const f = JSON.parse(body);
    const out = (f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true }) as Record<string, any> | null;
    if (out && f.step?.kind === 'press') {
      const extra = others.map((power) => ({ to: { kind: 'private', power }, move: 'press', body: randomPress(rnd) }));
      sent.push(...extra.map((m) => m.body));
      out.press = [...(out.press ?? []), ...extra];
    }
    if (out?.intent && typeof out.intent === 'object') {
      out.intent.notes = randomPress(rnd);
      sent.push(out.intent.notes);
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  try {
    const out = scratch();
    await runCommand({ scenario: 'diplomacy_standard', seat: 'germany', horizon: '1901', seeds: '11,12,13,14,15,16', target: s.url, out }, []);
    assert.ok(sent.length >= 200, `premise: only ${sent.length} random strings were sent`);
    let recorded = 0;
    for (let i = 0; i < 6; i++) {
      const text = readFileSync(join(out, `report.episode-${i}.record.json`), 'utf8');
      assert.ok(!text.includes('[redacted:'), `episode ${i}: the write-time redactor changed the record`);
      // The replay file carries the engine's SANITISED press (line breaks deleted, words joined).
      assert.ok(!readFileSync(join(out, `report.episode-${i}.replay.json`), 'utf8').includes('[redacted:'), `episode ${i}: the write-time redactor changed the replay file`);
      recorded += (JSON.stringify(JSON.parse(text).diplomacy.targetInputs).match(/Kiel|Munich|bonds|token|hold|Bring|the|to/g) ?? []).length ? 1 : 0;
    }
    assert.equal(recorded, 6, 'premise: every record carries target press');
    assert.equal(verifyCommand(join(out, 'report.json')), 0, 'a report with random multi-line press became unverifiable');
  } finally {
    await s.close();
  }
});

/** The engine's derived text (what the transcript and the replay file carry). */
const engineText = (s: string): string | null => {
  const r = sanitizePressText(s, Infinity, Infinity, true);
  return r.ok ? r.text : null;
};

test('G-44: edge output is a fixed point of the write path in both forms a file carries it (raw, and the engine-sanitised text); harmless text passes unchanged', () => {
  clearSecrets();
  let seed = 4444;
  const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % k);
  for (let i = 0; i < 2000; i++) {
    const body = randomPress(rnd);
    const edge = (redactPressText({ press: [{ body }] }).payload.press as { body: string }[])[0].body;
    const file = JSON.stringify({ press: [{ body: edge }] });
    assert.equal(redact(file), file, `not a fixed point: ${JSON.stringify(body)}`);
    const san = engineText(edge);
    if (san !== null) assert.equal(redact(JSON.stringify(san)), JSON.stringify(san), `sanitised form not a fixed point: ${JSON.stringify(body)}`);
    // Where the raw text and the engine's text are harmless, the edge changes nothing.
    const rawSan = engineText(body);
    if (redact(body) === body && (rawSan === null || redact(JSON.stringify(rawSan)) === JSON.stringify(rawSan))) assert.equal(edge, body, `edge changed a harmless body ${JSON.stringify(body)}`);
  }
});

test('G-44: a line break the engine deletes cannot join honest words into a credential shape in the replay file; only the joined span is replaced', () => {
  clearSecrets();
  const body = 'Bring the bearer bonds\nwith you to Kiel.';
  assert.equal(redact(body), body, 'premise: harmless at the edge (the line break ends the token)');
  assert.notEqual(redact(JSON.stringify(engineText(body))), JSON.stringify(engineText(body)), 'premise: the engine joins "bondswith", which the write path would redact');
  const edge = (redactPressText({ press: [{ body }] }).payload.press as { body: string }[])[0].body;
  assert.equal(edge, `Bring the ${DIP_PRESS_REDACTION_MARKER} you to Kiel.`);
  assert.equal(engineText(edge), edge);
});

test('verify: a record redacted after the run names the episode and the record difference, never a version mismatch', async () => {
  const agent = new DiplomacyReferenceAgent('robust');
  const s = await stub((_req, body, res) => {
    const f = JSON.parse(body);
    const out = (f.t === 'diplomacy_observation' ? agent.respond(f) : { ok: true }) as Record<string, any> | null;
    if (out && f.step?.kind === 'press') out.press = [...(out.press ?? []), { to: { kind: 'broadcast' }, move: 'press', body: 'Send the bearer shipments to Kiel.' }];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  try {
    const out = scratch();
    await runCommand({ scenario: 'diplomacy_standard', seat: 'germany', horizon: '1901', seeds: '11', target: s.url, out }, []);
    const p = join(out, 'report.episode-0.record.json');
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll(DIP_PRESS_REDACTION_MARKER, '[redacted:shape]'));
    const r = await runCli(['verify', join(out, 'report.json')]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stdout, /the record differs from what the run wrote \(episode 0\)/);
    assert.doesNotMatch(r.stdout + r.stderr, /agent-arena version/);
    const j = await runCli(['verify', join(out, 'report.json'), '--json']);
    const doc = JSON.parse(j.stdout);
    assert.match(doc.errors.join('\n'), /the record differs from what the run wrote \(episode 0\)/);
    assert.doesNotMatch(JSON.stringify(doc), /this agent-arena version/);
  } finally {
    await s.close();
  }
});
