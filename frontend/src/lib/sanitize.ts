// The untrusted-text pipeline (threat-model-arena.md §4.1, §4.2 "Replay inspector").
//
// Every string that came out of a report or replay file passes through here and
// then reaches the DOM only as a React text child. No markup, no markdown, no
// auto-linking, no href/src built from report data. The sanitiser is necessary,
// never sufficient: React's text escaping is the second layer.
//
// Regexes use \u escapes so this file carries no literal invisible bytes.

// ESC-introduced terminal sequences (CSI, OSC incl. hyperlinks/clipboard, DCS, lone ESC+char).
const ANSI = new RegExp(
  '\\u001B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)?|[PX^_][^\\u001B]*(?:\\u001B\\\\)?|[@-Z\\\\-_])',
  'g',
);
const LINE_BREAKS = new RegExp('[\\r\\n\\t\\u000B\\u000C\\u0085\\u2028\\u2029]+', 'g');
const CONTROLS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');
// Zero-width, bidi, tag characters ("ASCII smuggling"), variation selectors, fillers.
const INVISIBLE = new RegExp(
  '[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E' +
    '\\u2060-\\u2064\\u2066-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB' +
    '\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}\\u{1D173}-\\u{1D17A}]',
  'gu',
);
// Private-use code points and lone surrogates become U+FFFD.
const REPLACE = new RegExp('[\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}]|[\\uD800-\\uDFFF]', 'gu');

export const CAP = { name: 64, text: 280, value: 512, key: 64 } as const;

export interface Clean {
  text: string;
  truncated: boolean;
}

/** Sanitise one untrusted value to single-line plain text, capped by code point. */
export function sanitize(raw: unknown, cap: number = CAP.text): Clean {
  if (typeof raw === 'number' || typeof raw === 'boolean') raw = String(raw);
  if (typeof raw !== 'string') return { text: '', truncated: false };
  const bound = cap * 8 + 64; // bound the work before normalising
  const pre = raw.length > bound;
  let s = pre ? raw.slice(0, bound) : raw;
  try {
    s = s.normalize('NFKC');
  } catch {
    /* keep the raw value; everything below still applies */
  }
  s = s
    .replace(ANSI, '')
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROLS, '')
    .replace(INVISIBLE, '')
    .replace(REPLACE, '\uFFFD')
    .replace(/ {2,}/g, ' ')
    .trim();
  const cps = Array.from(s);
  const truncated = pre || cps.length > cap;
  return { text: truncated ? cps.slice(0, cap - 1).join('') + '\u2026' : s, truncated };
}

export const clean = (raw: unknown, cap?: number): string => sanitize(raw, cap).text;

/**
 * Deep copy of untrusted JSON for display: every key and string sanitised,
 * arrays/objects/depth capped. The result is only ever JSON.stringify'd into a
 * text node, so JSON escaping is a third layer on top.
 */
export function cleanJson(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return clean(v, CAP.value);
  if (depth >= 12) return '\u2026';
  if (Array.isArray(v)) {
    const out = v.slice(0, 128).map((x) => cleanJson(x, depth + 1));
    if (v.length > 128) out.push(`\u2026 ${v.length - 128} more`);
    return out;
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as object).slice(0, 128)) out[clean(k, CAP.key)] = cleanJson((v as Record<string, unknown>)[k], depth + 1);
    return out;
  }
  return '';
}

/** Compact text rendering of untrusted JSON (cells as [x,y] stay on one line). */
export function jsonText(v: unknown, max = 40_000): string {
  const s = JSON.stringify(cleanJson(v), null, 1) ?? 'null';
  const compact = s.replace(/\[\s+(-?\d+),\s+(-?\d+)\s+\]/g, '[$1,$2]');
  return compact.length > max ? compact.slice(0, max) + '\n\u2026 (truncated for display)' : compact;
}
