/**
 * The report/SARIF text sanitiser (docs/security/threat-model-arena.md §4.1–4.2).
 *
 * Every string that reaches a SARIF message, a terminal line or a log from a
 * field that is not a compile-time template passes through here. By contract
 * (sarif-mapping.md §6) no target-originated text reaches the report at all;
 * this is defence in depth for the oracle-templated `evidence_ref.message`
 * (platform text, but carried in a file an attacker can edit before `verify`
 * or the SARIF renderer sees it) and for anything a later CLI flag may add.
 *
 * Order (each step assumes the previous one):
 *   1. NFKC normalisation (folds full-width / compatibility look-alikes).
 *   2. Terminal escape sequences removed whole: 7-bit and 8-bit CSI, OSC
 *      (incl. OSC 8 hyperlinks and OSC 52 clipboard writes, BEL- or
 *      ST-terminated, or unterminated to end of input), DCS/SOS/PM/APC strings,
 *      and any remaining two-byte ESC sequence.
 *   3. Line breaks (CR, LF, NEL, U+2028/2029) and TAB become one space, so
 *      nothing can start a new line (no forged `::workflow-command::` line).
 *   4. C0/C1 controls, DEL, and the invisible/format set of §4.1 (zero-width,
 *      bidi embeddings/overrides/isolates, marks, BOM, Unicode tag characters,
 *      variation selectors, Hangul fillers, Mongolian FVS, interlinear
 *      annotation, musical formatting) are removed.
 *   5. Private-use code points and lone surrogates become U+FFFD.
 *   6. Markdown/HTML-significant characters are backslash-escaped, `@` cannot
 *      form a mention, and `://` / `www.` cannot form an autolink.
 *   7. The result is capped by CODE POINT (never splitting a surrogate pair or
 *      an escape), and a cut is made visible with a trailing `…`.
 *
 * Pure and total: any input (including non-strings) yields a string.
 */

export interface SanitizeOptions {
  /** Maximum output length in code points, including the `…` marker. Default 280 (evidence_ref.message cap). */
  maxLength?: number;
  /** Escape Markdown/HTML-significant characters (default true). Terminal sinks may pass false. */
  escapeMarkdown?: boolean;
}

export const DEFAULT_MAX_LENGTH = 280;
export const TRUNCATION_MARK = '\u2026';

/* 2. Escape sequences. ST = ESC \ or 8-bit 0x9C; BEL terminates OSC too. */
const ESCAPE_SEQUENCES = new RegExp(
  [
    '(?:\\u001b\\[|\\u009b)[\\u0030-\\u003f]*[\\u0020-\\u002f]*[\\u0040-\\u007e]?', // CSI (7/8-bit)
    '(?:\\u001b\\]|\\u009d)[\\s\\S]*?(?:\\u0007|\\u001b\\\\|\\u009c|$)', // OSC
    '(?:\\u001b[PX^_]|[\\u0090\\u0098\\u009e\\u009f])[\\s\\S]*?(?:\\u001b\\\\|\\u009c|$)', // DCS, SOS, PM, APC
    '\\u001b[\\u0020-\\u002f]*[\\u0030-\\u007e]?', // any other ESC sequence (nF, Fp, Fe, Fs), or a bare ESC
  ].join('|'),
  'g',
);

/* 3. Line and tab separators → one space. */
const BREAKS = /[\r\n\t\u000b\u000c\u0085\u2028\u2029]+/g;

/* 4. Removed outright: C0, DEL, C1, and the invisible/format set of threat-model-arena.md §4.1. */
const INVISIBLE = new RegExp(
  '[' +
    [
      '\\u0000-\\u001f', '\\u007f-\\u009f', // C0, DEL, C1
      '\\u00ad', '\\u034f', '\\u061c', '\\u115f', '\\u1160', '\\u17b4', '\\u17b5', '\\u180b-\\u180f',
      '\\u200b-\\u200f', // ZWSP, ZWNJ, ZWJ, LRM, RLM
      '\\u202a-\\u202e', // bidi embeddings / overrides
      '\\u2060-\\u2064', '\\u2066-\\u2069', '\\u206a-\\u206f', // word joiner..invisible plus, isolates, deprecated format
      '\\u3164', '\\ufe00-\\ufe0f', '\\ufeff', '\\uffa0', '\\ufff9-\\ufffb',
      '\\u{1d173}-\\u{1d17a}', '\\u{e0000}-\\u{e007f}', '\\u{e0100}-\\u{e01ef}',
    ].join('') +
    ']',
  'gu',
);

/* 5. Private use (BMP + planes 15/16) and lone surrogates → U+FFFD. */
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/* 6. Markdown / HTML significant characters (CommonMark + GFM): escaped one by one. */
const MD_CHARS = new Set(['\\', '`', '*', '_', '[', ']', '<', '>', '#', '|', '~', '!', '&', '@']);

/**
 * One output unit per input code point, escaped where needed, so the length cap
 * can never split an escape from the character it protects.
 */
function escapeMarkdownUnits(s: string): string[] {
  const cps = [...s];
  const units: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    // "://" can never form an autolink: both slashes escaped (renders as "://" in Markdown, inert as a link).
    if (ch === '/' && ((cps[i - 1] === ':') || (cps[i - 1] === '/' && cps[i - 2] === ':'))) {
      units.push('\\/');
      continue;
    }
    // "www." can never form an extended autolink.
    if (ch === '.' && i >= 3 && cps.slice(i - 3, i).join('').toLowerCase() === 'www' && !/[\p{L}\p{N}_]/u.test(cps[i - 4] ?? '')) {
      units.push('\\.');
      continue;
    }
    units.push(MD_CHARS.has(ch) ? `\\${ch}` : ch);
  }
  return units;
}

export function sanitizeForReport(input: unknown, opts: SanitizeOptions = {}): string {
  const maxLength = Math.max(1, Math.floor(opts.maxLength ?? DEFAULT_MAX_LENGTH));
  let s = typeof input === 'string' ? input : input == null ? '' : String(input);
  // Bound the work before any regex runs: at most 8 code units per output code point.
  if (s.length > maxLength * 8 + 64) s = s.slice(0, maxLength * 8 + 64);
  s = s.replace(LONE_SURROGATE, '\ufffd'); // NFKC needs well-formed input
  s = s.normalize('NFKC');
  s = s.replace(ESCAPE_SEQUENCES, '');
  s = s.replace(BREAKS, ' ');
  s = s.replace(INVISIBLE, '');
  s = s.replace(PRIVATE_USE, '\ufffd').replace(LONE_SURROGATE, '\ufffd');
  s = s.replace(/ {2,}/g, ' ').trim();

  const units = opts.escapeMarkdown === false ? [...s] : escapeMarkdownUnits(s);
  let len = 0;
  for (const u of units) len += [...u].length;
  if (len <= maxLength) return units.join('');
  const budget = maxLength - 1; // room for the marker
  let out = '';
  let used = 0;
  for (const u of units) {
    const w = [...u].length;
    if (used + w > budget) break;
    out += u;
    used += w;
  }
  return out.trimEnd() + TRUNCATION_MARK;
}
