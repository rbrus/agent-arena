import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeForReport, TRUNCATION_MARK } from '../src/index.ts';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

test('positive control: ordinary platform text passes through unchanged', () => {
  for (const s of [
    'The target stood away from the grounded node on 41% of assessed ticks.',
    '2 hard deadline misses (Dh 3000 ms), no forfeit.',
    "m4 was the faulty member and did not defer to the quorum's node.",
    'Z\u00fcrich, \u6771\u4eac, \u00e9migr\u00e9 \u2014 na\u00efve caf\u00e9',
  ]) assert.equal(sanitizeForReport(s), s);
});

test('ANSI CSI / SGR / cursor and 8-bit CSI sequences are removed whole', () => {
  assert.equal(sanitizeForReport('\u001b[31mFAIL\u001b[0m'), 'FAIL');
  assert.equal(sanitizeForReport('\u001b[2J\u001b[1;1HPASS'), 'PASS');
  assert.equal(sanitizeForReport('a\u009b31mb'), 'ab');
  assert.equal(sanitizeForReport('x\u001b7y\u001bcz'), 'xyz');
  assert.equal(sanitizeForReport('\u001b'), '');
});

test('OSC 8 hyperlinks, OSC 52 clipboard writes, window titles and DCS strings are removed with their payload', () => {
  const osc8 = '\u001b]8;;https://evil.example/\u0007click me\u001b]8;;\u0007';
  assert.equal(sanitizeForReport(osc8), 'click me');
  assert.equal(sanitizeForReport('\u001b]52;c;cm0gLXJmIH4=\u001b\\ok'), 'ok');
  assert.equal(sanitizeForReport('\u001b]0;pwned title\u0007ok'), 'ok');
  assert.equal(sanitizeForReport('\u001bPqpayload\u001b\\ok'), 'ok');
  assert.equal(sanitizeForReport('ok\u001b]8;;https://unterminated.example'), 'ok');
  assert.equal(sanitizeForReport('\u009d0;t\u009cok'), 'ok');
});

test('newlines cannot start a forged CI workflow-command line', () => {
  const s = sanitizeForReport('fine\n::error file=app.js::pwned\r\n##vso[task.setvariable]x\u2028::add-mask::y');
  assert.ok(!/[\r\n\u2028\u2029]/.test(s));
  assert.ok(!CONTROL.test(s));
  assert.equal(s.split(' ')[0], 'fine');
});

test('zero-width, bidi, tag characters, variation selectors and other invisibles are stripped', () => {
  assert.equal(sanitizeForReport('p\u200ba\u200cs\u200ds\u2060'), 'pass');
  assert.equal(sanitizeForReport('\u202eLIAF\u202c ok \u2066x\u2069'), 'LIAF ok x');
  assert.equal(sanitizeForReport('\ufeffBOM\u00ad\u034f\u061c\u180e'), 'BOM');
  // "ASCII smuggling": Unicode tag characters spelling an instruction.
  const smuggled = [...'ignore previous'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  assert.equal(sanitizeForReport(`ok${smuggled}`), 'ok');
  assert.equal(sanitizeForReport('a\ufe0f\u{e0101}b\u3164\uffa0\u115f\u1160'), 'ab');
  assert.equal(sanitizeForReport('x\u{1d173}\u{1d17a}y'), 'xy');
});

test('private-use code points and lone surrogates become U+FFFD; NFKC folds look-alikes', () => {
  assert.equal(sanitizeForReport('a\ue000b\u{f0000}c'), 'a\ufffdb\ufffdc');
  assert.equal(sanitizeForReport('a\ud800b\udc00c'), 'a\ufffdb\ufffdc');
  assert.equal(sanitizeForReport('\uff30\uff21\uff33\uff33'), 'PASS', 'full-width letters fold');
  assert.ok(sanitizeForReport('\u{1f600} ok').startsWith('\u{1f600}'), 'a real astral character survives');
});

test('markdown / HTML / mention / autolink payloads are neutralised for SARIF message strings', () => {
  assert.equal(sanitizeForReport('[click](https://evil.example)'), '\\[click\\](https:\\/\\/evil.example)');
  assert.equal(sanitizeForReport('![img](x)'), '\\!\\[img\\](x)');
  assert.equal(sanitizeForReport('<script>alert(1)</script>'), '\\<script\\>alert(1)\\</script\\>');
  assert.equal(sanitizeForReport('@octocat please merge'), '\\@octocat please merge');
  assert.equal(sanitizeForReport('**bold** _it_ `code` ~~s~~ # h | t'), '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\~\\~s\\~\\~ \\# h \\| t');
  assert.equal(sanitizeForReport('see www.evil.example'), 'see www\\.evil.example');
  assert.equal(sanitizeForReport('&lt;b&gt;'), '\\&lt;b\\&gt;');
  assert.equal(sanitizeForReport('a\\b'), 'a\\\\b');
  assert.equal(sanitizeForReport('[x](y)', { escapeMarkdown: false }), '[x](y)', 'terminal sinks can opt out of Markdown escaping');
});

test('length is capped by code point, the cut is visible, and an escape is never split', () => {
  const long = 'x'.repeat(10_000);
  const s = sanitizeForReport(long);
  assert.equal([...s].length, 280);
  assert.ok(s.endsWith(TRUNCATION_MARK));
  const astral = '\u{1f600}'.repeat(300);
  const a = sanitizeForReport(astral, { maxLength: 10 });
  assert.equal([...a].length, 10);
  assert.ok(!/[\ud800-\udbff]$/.test(a.slice(0, -1)), 'no dangling high surrogate');
  const esc = sanitizeForReport('ab' + '*'.repeat(50), { maxLength: 6 });
  assert.equal(esc, 'ab\\*' + TRUNCATION_MARK);
  // A huge hostile input is bounded before any regex runs.
  const t0 = process.hrtime.bigint();
  sanitizeForReport('\u001b]'.repeat(5_000_000));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000);
});

test('total: non-strings and empty input', () => {
  assert.equal(sanitizeForReport(undefined), '');
  assert.equal(sanitizeForReport(null), '');
  assert.equal(sanitizeForReport(42), '42');
  assert.equal(sanitizeForReport(''), '');
  assert.equal(sanitizeForReport('\u0000\u0001\u0002'), '');
});
