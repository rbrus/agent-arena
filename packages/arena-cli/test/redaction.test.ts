/**
 * Stage C2a, G-19 / G-24 / G-26 (docs/phase-7/SECURITY-REVIEW.md): a target
 * credential never reaches any sink in any recoverable form. Target text is
 * redacted WHOLE before any escaping or truncation, on every path it can take
 * (rest, mcp, a2a, ws, error messages, `--json`, file writers); the redactor
 * also catches escaped, percent-encoded, invisible-interleaved and truncated
 * forms. In GitHub Actions every form is `::add-mask::`ed first. The secret
 * file is read in one step, and an env credential is scrubbed from the
 * environment once read.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { loadCredential } from '../src/credentials.ts';
import { writeOutput } from '../src/files.ts';
import { clearSecrets, redact, registerSecret, registeredVariants, targetExcerpt } from '../src/redact.ts';
import { startReferenceServer } from '../src/reference/serve.ts';
import { frameAnswer } from '../src/transports/jsonrpc.ts';
import { outJson, setOutputMode, targetText } from '../src/ui.ts';
import { allFiles, assertNoLeak, runCli, scratch } from './helpers.ts';

/** A canary with Markdown-significant `_`, upper and lower case, long enough for every cut in the transports. */
const newCanary = () => `tok_${randomBytes(16).toString('hex')}_ZzQq`;

/** The forms a careless target echoes a credential in. `cut` is the transport's excerpt length for that path. */
function echoForms(bare: string, cut: number): Record<string, string> {
  const half = Math.floor(bare.length / 2);
  return {
    raw: `bad credentials: Bearer ${bare}`,
    markdownEscaped: `bad credentials: Bearer ${bare.replace(/[_*~[\]<>#|!&@`]/g, (c) => `\\${c}`)}`,
    jsonEscaped: JSON.stringify({ error: `got "Bearer ${bare}"` }),
    percentUpper: `token=${[...Buffer.from(bare)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')}`,
    base64: `auth ${Buffer.from(`Bearer ${bare}`).toString('base64')}`,
    zeroWidth: `got ${[...bare].join('​')}`,
    straddlesCut: `${'.'.repeat(cut - half)}${bare}`,
    targetTruncated: `you sent ${bare.slice(0, Math.ceil(bare.length * 0.6))}`,
  };
}

const RUN = (target: string, out: string, extra: string[] = []) => ['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--tier', 'edge', '--target', target, '--auth', 'env:ARENA_C2A', '--out', out, ...extra];

/**
 * Every server this file starts is tracked and closed in after() even when a test fails
 * midway: a listening loopback server left behind keeps the test process alive and hung the
 * full parallel `npm test` (Phase 7 gate harness). The last test asserts no TCP handle is left.
 */
const live = new Set<() => Promise<void>>();
function tracked(close: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  const once = () => (done ??= (live.delete(once), close()));
  live.add(once);
  return once;
}
async function closeAll(): Promise<void> {
  await Promise.all([...live].map((c) => c()));
}
after(closeAll);

async function server(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return {
    s,
    url,
    close: tracked(
      () =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  };
}

async function assertRunLeaksNothing(canary: string, target: string, label: string, extra: string[] = []): Promise<{ stderr: string }> {
  const out = scratch();
  const r = await runCli(RUN(target, out, extra), { ARENA_C2A: canary });
  assert.match(r.stderr, /target> |could not reach|lost the target/, `${label}: the target's text was shown or reported (${r.stderr.slice(0, 300)})`);
  assertNoLeak(canary, [
    { where: `${label} stdout`, text: r.stdout },
    { where: `${label} stderr`, text: r.stderr },
    ...allFiles(out).map((f) => ({ where: `${label} ${f.path}`, text: f.text })),
  ]);
  return r;
}

test('G-19 rest: every echo form of the credential in an error body is redacted before it is escaped or cut', async () => {
  for (const form of Object.keys(echoForms('PLACEHOLDER', 512))) {
    const canary = newCanary();
    const body = echoForms(canary, 512)[form];
    const t = await server((_q, _b, res) => res.writeHead(500, { 'content-type': 'text/plain' }).end(body));
    try {
      const r = await assertRunLeaksNothing(canary, `${t.url}/act`, `rest/${form}`);
      // (straddlesCut: the credential sits past the 200-character display cap, so only dots are shown.)
      if (form !== 'straddlesCut') assert.match(r.stderr, /\[redacted:env\]/, `rest/${form}: the redaction is visible`);
    } finally {
      await t.close();
    }
  }
});

test('G-19 rest: a 401 echo (auth path) and a redirect Location carrying the credential are redacted', async () => {
  const canary = newCanary();
  const t = await server((_q, _b, res) => res.writeHead(401, { 'content-type': 'text/plain' }).end(echoForms(canary, 512).markdownEscaped));
  const r = await assertRunLeaksNothing(canary, `${t.url}/act`, 'rest/401');
  assert.equal(r.stderr.includes('never retries authentication'), true);
  await t.close();

  const canary2 = newCanary();
  const t2 = await server((_q, _b, res) => res.writeHead(302, { location: `/login?next=${encodeURIComponent(`Bearer ${canary2}`)}` }).end());
  await assertRunLeaksNothing(canary2, `${t2.url}/act`, 'rest/redirect');
  await t2.close();
});

test('G-19 errors: a credential echoed in a response header that becomes an error message is redacted', async () => {
  const canary = newCanary();
  const t = await server((_q, _b, res) => res.writeHead(200, { 'content-encoding': `x${canary}` }).end('{}'));
  const r = await assertRunLeaksNothing(canary, `${t.url}/act`, 'rest/content-encoding');
  assert.match(r.stderr, /Content-Encoding/);
  await t.close();
});

/** A minimal MCP server whose tools/call fails with target text (JSON-RPC error or isError content). */
async function mcpEcho(mode: 'rpc-error' | 'is-error', text: (bare: string) => string) {
  return server((req, body, res) => {
    if (req.method !== 'POST') return void res.writeHead(204).end();
    const m = JSON.parse(body) as { id?: number; method: string };
    if (m.id === undefined) return void res.writeHead(202).end();
    const bare = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const reply = (x: unknown) => res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(x as object) }));
    if (m.method === 'initialize') return reply({ result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x', version: '1' } } });
    if (m.method === 'tools/list') return reply({ result: { tools: [{ name: 'arena_act' }] } });
    if (mode === 'rpc-error') return reply({ error: { code: -32000, message: text(bare) } });
    return reply({ result: { isError: true, content: [{ type: 'text', text: text(bare) }] } });
  });
}

test('G-19 mcp: JSON-RPC error messages and isError tool text carrying the credential are redacted (256-char cut)', async () => {
  for (const mode of ['rpc-error', 'is-error'] as const) {
    for (const form of ['markdownEscaped', 'straddlesCut', 'targetTruncated', 'percentUpper'] as const) {
      const canary = newCanary();
      const t = await mcpEcho(mode, (bare) => echoForms(bare, 256)[form]);
      try {
        await assertRunLeaksNothing(canary, `${t.url}/mcp`, `mcp/${mode}/${form}`);
      } finally {
        await t.close();
      }
    }
  }
});

test('G-19 a2a: JSON-RPC errors carrying the credential (256-char cut) and a card naming a credential-bearing host are redacted', async () => {
  for (const form of ['markdownEscaped', 'straddlesCut', 'targetTruncated'] as const) {
    const canary = newCanary();
    const t = await server((req, body, res) => {
      const bare = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'x', url: '/a2a' }));
      const m = JSON.parse(body) as { id: number };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: echoForms(bare, 256)[form] } }));
    });
    try {
      await assertRunLeaksNothing(canary, `${t.url}/.well-known/agent-card.json`, `a2a/${form}`);
    } finally {
      await t.close();
    }
  }
  // The card's endpoint host is target text too, and URL parsing lower-cases it.
  const canary = newCanary();
  const t = await server((req, _b, res) => {
    const bare = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'x', url: `http://${bare}.example/a2a` }));
  });
  try {
    const out = scratch();
    const r = await runCli(RUN(`${t.url}/.well-known/agent-card.json`, out), { ARENA_C2A: canary });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /another origin/);
    const lower = canary.toLowerCase();
    assert.ok(!r.stderr.toLowerCase().includes(lower.slice(4, 20)), `the lower-cased credential reached stderr: ${r.stderr}`);
    assert.match(r.stderr, /\[redacted:env\]/);
  } finally {
    await t.close();
  }
});

test('G-19 ws: a close reason carrying the credential never reaches a sink', async () => {
  const canary = newCanary();
  const s = createServer();
  const wss = new WebSocketServer({ server: s });
  wss.on('connection', (ws, req) => ws.on('message', () => ws.close(4001, String(req.headers.authorization ?? '').slice(0, 100))));
  const close = tracked(
    () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        s.closeAllConnections();
        s.close(() => r());
      }),
  );
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  try {
    await assertRunLeaksNothing(canary, `ws://127.0.0.1:${(s.address() as AddressInfo).port}/ws`, 'ws/close-reason');
  } finally {
    await close();
  }
});

test('G-19 --json: stdout stays free of the credential for a target that echoes it', async () => {
  const canary = newCanary();
  const t = await server((_q, _b, res) => res.writeHead(500).end(echoForms(canary, 512).markdownEscaped));
  const out = scratch();
  const r = await runCli(RUN(`${t.url}/act`, out, ['--json']), { ARENA_C2A: canary });
  JSON.parse(r.stdout);
  assertNoLeak(canary, [
    { where: 'stdout', text: r.stdout },
    { where: 'stderr', text: r.stderr },
  ]);
  await t.close();
});

test('G-19 unit: redact() catches escaped, encoded, interleaved and boundary-truncated forms; targetExcerpt redacts before the cut', () => {
  clearSecrets();
  const tok = 'ghp_unit_0123456789abcdefABCDEF';
  registerSecret(tok, 'env');
  registerSecret(`Bearer ${tok}`, 'env', { partial: false });
  const forms = echoForms(tok, 512);
  for (const [name, text] of Object.entries(forms)) {
    const r = redact(text);
    assertNoLeak(tok, [{ where: `redact(${name})`, text: r }]);
    assert.match(r, /\[redacted:env\]/, name);
  }
  // A prefix shorter than 8 characters is left alone (no collateral damage); `Bearer <1 char>` is not a secret.
  assert.equal(redact(`abc ${tok.slice(0, 7)}`), `abc ${tok.slice(0, 7)}`);
  assert.equal(redact('see: Bearer g'), 'see: Bearer g');
  // A suffix at the start of a text (a cut from the front) is redacted too.
  assert.equal(redact(`${tok.slice(10)} and more`), '[redacted:env] and more');
  // The excerpt: the whole text is redacted first, so the cut cannot expose a prefix.
  const ex = targetExcerpt(`${'​'.repeat(495)}${tok}`, 512);
  assert.ok(!ex.includes(tok.slice(0, 10)), ex.slice(-40));
  // targetText: Markdown-escaping never happens before redaction.
  const line = targetText(`{"got":"Bearer ${tok}"}`);
  assert.ok(line.startsWith('  target> '));
  assertNoLeak(tok, [{ where: 'targetText', text: line }]);
  // Nothing is redacted in text with no secret: escapes, percent signs and JSON survive byte for byte.
  const benign = '{"a":"50% \\"quoted\\" \\\\ path","b":"%41%42"}';
  assert.equal(redact(benign), benign);
  clearSecrets();
});

test('G-19 unit: the report/record/replay writer and --json redact escaped and encoded forms after serialisation', () => {
  clearSecrets();
  const tok = 'sek_writer_0123456789abcdef_XY';
  registerSecret(tok, 'secret');
  const doc = { note: `x\\${tok}`, url: `/cb?t=${encodeURIComponent(tok).toUpperCase()}`, md: tok.replace(/_/g, '\\_') };
  const dir = scratch();
  writeOutput(join(dir, 'report.json'), JSON.stringify(doc, null, 2));
  const written = readFileSync(join(dir, 'report.json'), 'utf8');
  assertNoLeak(tok, [{ where: 'report.json', text: written }]);
  JSON.parse(written);
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (c: string) => (chunks.push(String(c)), true);
  try {
    setOutputMode({ json: true });
    outJson(doc);
  } finally {
    (process.stdout as { write: unknown }).write = orig;
    setOutputMode({});
  }
  assertNoLeak(tok, [{ where: '--json stdout', text: chunks.join('') }]);
  clearSecrets();
});

test('G-24: in GitHub Actions every form of the credential is ::add-mask::ed before any other output (stderr under --json)', async () => {
  const canary = `mask_${randomBytes(12).toString('hex')}%x`;
  const ref = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
  const closeRef = tracked(() => ref.close());
  const target = ref.urls.rest.replace(/\/$/, '');
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const esc = (s: string) => s.replace(/%/g, '%25');
  const expected = [canary, `Bearer ${canary}`, b64(canary), b64(`Bearer ${canary}`), Buffer.from(canary).toString('base64url'), encodeURIComponent(canary)].map((v) => `::add-mask::${esc(v)}`);

  const human = await runCli(RUN(target, scratch(), ['--ci', 'github']), { ARENA_C2A: canary, GITHUB_ACTIONS: 'true' });
  assert.equal(human.code, 0, human.stderr);
  const lines = human.stdout.split('\n');
  const masks = lines.filter((l) => l.startsWith('::add-mask::'));
  for (const e of expected) assert.ok(masks.includes(e), `missing ${e.slice(0, 24)}…`);
  assert.ok(lines.slice(0, masks.length).every((l) => l.startsWith('::add-mask::')), 'the masks come before anything else on stdout');

  const json = await runCli(RUN(target, scratch(), ['--ci', 'github', '--json']), { ARENA_C2A: canary, GITHUB_ACTIONS: 'true' });
  assert.equal(json.code, 0, json.stderr);
  JSON.parse(json.stdout); // stdout stays one JSON document
  const errMasks = json.stderr.split('\n').filter((l) => l.startsWith('::add-mask::'));
  for (const e of expected) assert.ok(errMasks.includes(e));
  assert.equal(json.stderr.split('\n')[0].startsWith('::add-mask::'), true, 'masks first on stderr');

  const off = await runCli(RUN(target, scratch(), ['--ci', 'github']), { ARENA_C2A: canary });
  assert.ok(!off.stdout.includes('::add-mask::') && !off.stdout.includes(canary), 'outside GitHub Actions nothing is masked (or printed)');
  await closeRef();
});

test('G-26: an env credential is scrubbed from process.env once read and is not serialisable or inspectable', () => {
  clearSecrets();
  const v = `envtok_${randomBytes(12).toString('hex')}`;
  process.env.ARENA_C2A_UNIT = v;
  const loaded = loadCredential({ scheme: 'bearer', ref: 'env:ARENA_C2A_UNIT' });
  assert.equal(process.env.ARENA_C2A_UNIT, undefined, 'the variable is gone from the environment');
  assert.equal(loaded.credential.value, `Bearer ${v}`, 'the value still works for the request header');
  for (const text of [JSON.stringify(loaded), inspect(loaded, { depth: 5, showHidden: false }), Object.keys(loaded.credential).join(',')]) {
    assert.ok(!text.includes(v), `the value leaked through serialisation: ${text.slice(0, 120)}`);
  }
  assert.ok(registeredVariants().includes(v) && registeredVariants().includes(`Bearer ${v}`));
  clearSecrets();
});

test('G-26: the secret file is opened once (O_NOFOLLOW) and checked on the descriptor: symlink, FIFO, loose mode, oversize refused', async () => {
  const dir = scratch('arena-secrets-');
  mkdirSync(dir, { recursive: true });
  const value = `filetok_${randomBytes(12).toString('hex')}`;
  writeFileSync(join(dir, 'real'), `${value}\n`, { mode: 0o600 });
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  execFileSync('mkfifo', [join(dir, 'fifo')]);
  writeFileSync(join(dir, 'loose'), value, { mode: 0o640 });
  writeFileSync(join(dir, 'big'), 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });
  const cases: [string, RegExp][] = [
    ['link', /is a symlink/],
    ['fifo', /not a regular file/],
    ['loose', /readable by group\/others/],
    ['big', /larger than 16 KiB/],
    ['missing', /not found/],
  ];
  for (const [name, msg] of cases) {
    const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', 'http://127.0.0.1:9/act', '--auth', `secret:${name}`, '--out', scratch()], { AGENT_ARENA_SECRETS_DIR: dir });
    assert.equal(r.code, 3, `${name}: ${r.stderr}`);
    assert.match(r.stderr, msg, name);
    assert.ok(!r.stderr.includes(value), `${name}: the secret value was quoted`);
  }
  process.env.AGENT_ARENA_SECRETS_DIR = dir;
  try {
    assert.equal(loadCredential({ scheme: 'header', ref: 'secret:real', header_name: 'X-Api-Key' }).credential.value, value);
  } finally {
    delete process.env.AGENT_ARENA_SECRETS_DIR;
    clearSecrets();
  }
});

test('G-28: startup errors never quote key material (bad credential value, unknown flag carrying a value)', async () => {
  const value = `startup_${randomBytes(10).toString('hex')}`;
  const r1 = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--target', 'http://127.0.0.1:9/act', '--auth', 'env:ARENA_C2A', '--out', scratch()], { ARENA_C2A: `${value}\r\nX-Evil: 1` });
  assert.equal(r1.code, 3);
  assert.ok(!r1.stderr.includes(value), r1.stderr);
  const r2 = await runCli(['run', `--tokenx=${value}`]);
  assert.equal(r2.code, 3);
  assert.ok(!r2.stderr.includes(value), r2.stderr);
  const r3 = await runCli(['run', '--scenario', 'byzantine', '--target', 'ref:coordinated', '--out', scratch()], { NODE_OPTIONS: `--inspect=127.0.0.1:0` });
  assert.equal(r3.code, 3);
  assert.ok(!r3.stderr.includes('127.0.0.1:0'), 'diagnostic flag values are not quoted');
});

test('G-28a: a deeply nested RPC result is a malformed answer, not an exception', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 30_000; i++) deep = [deep];
  const a = frameAnswer(deep);
  assert.equal(a.kind, 'refused');
  assert.match((a as { detail?: string }).detail ?? '', /nested deeper than 64/);
  const ok = frameAnswer({ t: 'eval_raid_action', a: [[[1]]] });
  assert.equal(ok.kind, 'frame');
});

// ── G-35 (docs/phase-7/SECURITY-REVIEW.md §8.4): \uXXXX, \xXX and HTML character references ──

test('G-35: every escaped echo of a standard-base64 key (+, /, =) is masked in the ORIGINAL bytes', () => {
  const tok = `Zk3+Qa9/${randomBytes(18).toString('base64')}==`.replace(/=+$/, '==');
  registerSecret(tok, 'env');
  try {
    const hex4 = (c: string) => c.charCodeAt(0).toString(16).padStart(4, '0');
    const esc = (f: (c: string) => string) => tok.replace(/[+/=]/g, f);
    const named: Record<string, string> = { '+': '&plus;', '/': '&sol;', '=': '&equals;' };
    const forms: [string, string][] = [
      ['\\u upper (System.Text.Json)', `{"got":"${esc((c) => `\\u${hex4(c).toUpperCase()}`)}"}`],
      ['\\u lower', `{"got":"${esc((c) => `\\u${hex4(c)}`)}"}`],
      ['\\x', `got=${esc((c) => `\\x${c.charCodeAt(0).toString(16)}`)};`],
      ['&#NN;', `<b>${esc((c) => `&#${c.charCodeAt(0)};`)}</b>`],
      // Without `;` a following digit extends the number (as in browsers), so only drop it before a non-digit.
      ['&#NN without ;', `<b>${tok.replace(/[+/=](?=\D|$)/g, (c) => `&#${c.charCodeAt(0)}`).replace(/[+/=]/g, (c) => `&#${c.charCodeAt(0)};`)}</b>`],
      ['&#xHH; upper', `<b>${esc((c) => `&#X${c.charCodeAt(0).toString(16).toUpperCase()};`)}</b>`],
      ['&#x0HH; padded', `<b>${esc((c) => `&#x00${c.charCodeAt(0).toString(16)};`)}</b>`],
      ['named', `<b>${esc((c) => named[c])}</b>`],
      ['double HTML (&amp;#43;)', `<b>${esc((c) => `&amp;#${c.charCodeAt(0)};`)}</b>`],
      ['JSON inside JSON (\\\\u002B)', `{"inner":"{\\"got\\":\\"${esc((c) => `\\\\u${hex4(c)}`)}\\"}"}`],
      ['mixed', `${esc((c) => (c === '+' ? '\\u002B' : c === '/' ? '&#x2F;' : '%3D'))}`],
      ['Bearer, escaped', `authorization: Bearer ${esc((c) => `\\u${hex4(c)}`)} (rejected)`],
    ];
    for (const [why, f] of forms) {
      const out = targetExcerpt(f, 1024);
      assert.ok(!out.includes(tok.slice(8, 20)), `${why}: the credential body survived: ${out}`);
      assert.ok(!out.includes(tok.slice(-14, -4)), `${why}: the credential tail survived: ${out}`);
      assert.match(out, /\[redacted:(?:env|shape)\]/, why);
    }
    // The mask covers the escape sequences themselves: nothing of the encoded token is left around the label.
    const html = redact(`<b>${esc((c) => `&#${c.charCodeAt(0)};`)}</b>`);
    assert.equal(html, '<b>[redacted:env]</b>');
    const json = redact(`{"got":"${esc((c) => `\\u${hex4(c).toUpperCase()}`)}"}`);
    assert.equal(json, '{"got":"[redacted:env]"}');
  } finally {
    clearSecrets();
  }
});

test('G-35: unregistered Bearer tokens with an escaped + are redacted whole (shape rule over the decoded view)', () => {
  clearSecrets();
  const out = redact('WWW-Authenticate failed for Bearer abcDEF123\\u002Bxyz789\\u002Fqrs456 next');
  assert.equal(out, 'WWW-Authenticate failed for [redacted:shape] next');
  const html = redact('<p>Bearer abcDEF123&#43;xyz789&#x2F;qrs456</p>');
  assert.equal(html, '<p>[redacted:shape]</p>');
});

test('G-35: text without secrets keeps its escapes and entities, surrogate-pair escapes decode as one character', () => {
  clearSecrets();
  for (const plain of ['a &amp; b &lt;tag&gt; &#169; \\u00e9 \\x41 plain', 'emoji \\uD83D\\uDE00 and a lone \\uD800 and &#0; &#xFFFFFF;', 'AT&T & co; 100% &unknown; &#;']) {
    assert.equal(redact(plain), plain);
  }
  const tok = `pair\u{1F600}secret_${randomBytes(6).toString('hex')}`;
  registerSecret(tok, 'secret');
  try {
    const out = redact(`{"t":"${tok.replace('\u{1F600}', '\\uD83D\\uDE00')}"}`);
    assert.equal(out, '{"t":"[redacted:secret]"}');
    const ref = redact(`<i>${tok.replace('\u{1F600}', '&#128512;')}</i>`);
    assert.equal(ref, '<i>[redacted:secret]</i>');
  } finally {
    clearSecrets();
  }
});

test('G-44: the view decodes JSON single-character escapes to what they mean (a serialised line break is a separator, never the letter n)', () => {
  clearSecrets();
  // Harmless raw, harmless serialised: `bonds\nto` must not read as `bondsnto` (8 chars after "bearer").
  for (const body of ['Bring the bearer bonds\nto Kiel.', 'the bearer bonds\tto Kiel', 'bearer bonds\rto', 'bearer bonds\r\nto', 'bearer bonds\fto', 'bearer bonds\bto', 'a "bearer" bonds\\to']) {
    assert.equal(redact(body), body, `premise: ${JSON.stringify(body)} is harmless raw`);
    const file = JSON.stringify({ body });
    assert.equal(redact(file), file, `${JSON.stringify(body)} is rewritten once serialised`);
  }
  // A token after an escaped TAB or LF is still a `Bearer <token>`: the escape is whitespace in the view, as raw.
  assert.equal(redact(JSON.stringify({ h: 'Bearer\tabcdefgh12345' })), '{"h":"[redacted:shape]"}');
  assert.equal(redact(JSON.stringify({ h: 'Bearer\nabcdefgh12345' })), '{"h":"[redacted:shape]"}');
  // `\/` (PHP, some Java encoders) decodes to `/`, so the whole token goes.
  assert.equal(redact('{"a":"Bearer abcd\\/efgh\\/ijkl"}'), '{"a":"[redacted:shape]"}');
  // Markdown escapes keep the character (unchanged behaviour).
  assert.equal(redact(`ghp\\_${'a'.repeat(36)}`), '[redacted:shape]');
});

test('G-43: a shape hit overlapping a registered-secret hit is merged, not skipped: nothing of the echoed credential survives', () => {
  const SECRET = 'Zq9+Xy/w8Kp3Lm7Tv2Rs';
  registerSecret(SECRET, 'env');
  try {
    const out = redact(`x Bearer ‮wotk_sk_9${SECRET.slice(0, 8)}`);
    assert.ok(!/wotk_sk|Bearer/.test(out), `a part of the overlapping shape survived: ${JSON.stringify(out)}`);
    assert.equal(redact(out), out, 'the result is a fixed point');
    // The secret echoed JSON-escaped (the exact pass misses it, the view finds it) inside a Bearer token
    // whose own head is too short to match on its own once the secret is gone.
    const esc = redact(`auth: Bearer tok1234${SECRET.replace('+', '\\u002B')} more`);
    assert.equal(esc, 'auth: [redacted:env] more', 'the union of the secret hit and the Bearer hit is replaced');
  } finally {
    clearSecrets();
  }
});

// Must stay the LAST test of this file (top-level tests in a file run in order).
test('no loopback server or socket outlives this file: every tracked server is closed and no TCP handle is active', async () => {
  await closeAll();
  const tcp = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap' || r === 'TCPSocketWrap');
  // A socket that is closing may need a turn of the event loop to release its handle.
  for (let i = 0; i < 50 && tcp().length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(tcp(), [], `live TCP handles at the end of redaction.test.ts: ${process.getActiveResourcesInfo().join(', ')}`);
});
