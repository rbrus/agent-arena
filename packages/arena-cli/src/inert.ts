/**
 * Inert text (G-36). Target-authored text is kept raw in records and replays
 * (it is an engine input, so it must re-simulate byte for byte), but the files
 * and the `--json` documents that carry it must not carry *active* code points:
 * bidi overrides and isolates, zero-width and other format characters, Unicode
 * tag characters (U+E0000-E007F, "ASCII smuggling" for LLM tooling), variation
 * selectors, private-use characters, line/paragraph separators, C1 controls and
 * lone surrogates.
 *
 *  - `inertJson(json)` rewrites every such code point in a serialised JSON text
 *    as a `\uXXXX` escape (a surrogate pair for astral ones). JSON.stringify
 *    already escapes C0 inside strings and never emits these code points outside
 *    a string, so the rewrite is lossless: `JSON.parse(inertJson(JSON.stringify(v)))`
 *    deep-equals `v`, and hashes, `verify` and the inspector see the same value.
 *  - `stripActive(s)` removes them from terminal text (ui.ts `toTerminalSafe`).
 */

/**
 * The active set: Cc, Cf, Zl, Zp, Co, Cs and every Default_Ignorable code point
 * (variation selectors, Hangul fillers, CGJ, …). Tab, LF and CR are handled by
 * the callers (structural whitespace in pretty JSON; shown as `\n` on a terminal).
 */
const ACTIVE = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

const hex4 = (u: number) => `\\u${u.toString(16).toUpperCase().padStart(4, '0')}`;

function escapeCodePoint(ch: string): string {
  let out = '';
  for (let i = 0; i < ch.length; i++) out += hex4(ch.charCodeAt(i));
  return out;
}

/** A serialised JSON text with every active code point written as `\uXXXX` (lossless; output is inert). */
export function inertJson(json: string): string {
  return json.replace(ACTIVE, escapeCodePoint);
}

/** `JSON.stringify` + `inertJson`. */
export function toInertJson(v: unknown, space?: number): string {
  return inertJson(JSON.stringify(v, null, space));
}

/** Remove every active code point except tab and newlines (terminal sinks). */
export function stripActive(s: string): string {
  return s.replace(ACTIVE, '');
}

/** True when `s` holds no active code point (tab / LF / CR allowed). */
export function isInert(s: string): boolean {
  ACTIVE.lastIndex = 0;
  const hit = ACTIVE.test(s);
  ACTIVE.lastIndex = 0;
  return !hit;
}

/**
 * A record- or report-derived string for an error message: active code points
 * removed, newlines shown as `\n`, cut to `cap` code points. Record files are
 * hostile until verified; their strings are never interpolated raw.
 */
export function recordText(v: unknown, cap = 40): string {
  const s = stripActive(String(v)).replace(/\r?\n|\r/g, '\\n').replace(/\t/g, ' ');
  const cps = [...s];
  return cps.length > cap ? `${cps.slice(0, cap).join('')}…` : s;
}
