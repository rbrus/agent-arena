/**
 * The one Redactor (threat model §1.3). Every sink calls `redact()` AFTER
 * serialisation: logger, error formatter, crash handler, `--json` stdout, and
 * every file the CLI writes (report.json, report.sarif, run-spec.json, episode
 * records, replay files). Three nets, in order:
 *
 *   1. exact substring replacement of every registered secret and its common
 *      encodings (raw, base64, base64url, URL-encoded, JSON-escaped, hex);
 *   2. the same search over a NORMALISED VIEW of the text, which undoes what a
 *      sink or a target does to a string on its way to a log: backslash escapes
 *      (Markdown / JSON escaping, `ghp\_…`, `\uXXXX`, `\xXX`), HTML character
 *      references (`&#43;`, `&#x2F;`, `&amp;`), percent-encoding of any casing, and
 *      interleaved invisible or control characters, and ASCII case (URL
 *      parsing lower-cases a host name). A hit in the view redacts
 *      the corresponding span of the original text. In the same view, a PREFIX
 *      (≥ 8 chars) of a secret at the end of the text, or a SUFFIX at its start,
 *      is redacted too: that is what a truncation boundary leaves behind;
 *   3. shape-based redaction (JWT, `Bearer …`, `ghp_…`, `sk-…`, …) over both the
 *      text and the view, as a second net for credentials never registered.
 *
 * G-19: target text must reach the redactor WHOLE, before any escaping or
 * truncation; `targetExcerpt()` is the only way a transport cuts target text.
 */

interface Entry {
  label: string;
  /** Prefix/suffix matching at a boundary (bare secret material only, never `Bearer <tok>`). */
  partial: boolean;
}

const registered = new Map<string, Entry>();
/** Normalised variants for the view pass, longest first (rebuilt on register). */
let normalised: { n: string; label: string; partial: boolean }[] = [];
let sortedExact: string[] = [];
let shapeHits = 0;

/** Minimum credential length: shorter values cannot be redacted without collateral damage. */
export const MIN_SECRET_LENGTH = 8;

function variants(v: string): string[] {
  const out = new Set<string>([v]);
  const b = Buffer.from(v, 'utf8');
  out.add(b.toString('base64'));
  out.add(b.toString('base64').replace(/=+$/, ''));
  out.add(b.toString('base64url'));
  out.add(b.toString('hex'));
  out.add(encodeURIComponent(v));
  out.add(JSON.stringify(v).slice(1, -1));
  return [...out].filter((x) => x.length >= MIN_SECRET_LENGTH);
}

/**
 * Register a secret value under a label (`env`, `secret`). A header value of
 * the form `<Scheme> <token>` also registers the bare token. `partial: false`
 * keeps a value out of boundary (prefix/suffix) matching; use it for values
 * with a fixed public prefix such as `Bearer `.
 */
export function registerSecret(value: string, refKind: 'env' | 'secret', o: { partial?: boolean } = {}): void {
  const label = `[redacted:${refKind}]`;
  const add = (v: string, partial: boolean) => {
    for (const x of variants(v)) {
      const prev = registered.get(x);
      registered.set(x, { label, partial: partial || !!prev?.partial });
    }
  };
  add(value, o.partial ?? true);
  const sp = value.indexOf(' ');
  if (sp > 0 && value.length - sp - 1 >= MIN_SECRET_LENGTH) add(value.slice(sp + 1), true);
  rebuild();
}

function rebuild(): void {
  sortedExact = [...registered.keys()].sort((a, b) => b.length - a.length);
  const seen = new Map<string, { n: string; label: string; partial: boolean }>();
  for (const [k, e] of registered) {
    const n = asciiLower(normalise(k).view);
    if (n.length < MIN_SECRET_LENGTH) continue;
    const prev = seen.get(n);
    seen.set(n, { n, label: e.label, partial: e.partial || !!prev?.partial });
  }
  normalised = [...seen.values()].sort((a, b) => b.n.length - a.n.length);
}

export function clearSecrets(): void {
  registered.clear();
  rebuild();
}

/**
 * Every registered variant (exact forms): what `--ci github` hands to
 * `::add-mask::` (G-24). Never printed anywhere else.
 */
export function registeredVariants(): string[] {
  return [...sortedExact];
}

const SHAPES: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bwotk_sk_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * Invisible / format / control characters a view drops (the shared
 * sanitiser's strip set, threat model §4.1). Tab, LF and CR are kept so that
 * multi-line text (pretty JSON) keeps its structure in the view.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u{1d173}-\u{1d17a}]/u;
const NOISE = new RegExp(`[\\\\%&]|${INVISIBLE.source}`, 'u');
const HEX = /^[0-9A-Fa-f]{2}$/;
/** `\uXXXX` (JSON, JS; System.Text.Json escapes `+`, `<`, `>`, `&`, `'` this way by default). */
const U_ESC = /^u([0-9A-Fa-f]{4})/;
/** `\xXX` (JS, Python, C). */
const X_ESC = /^x([0-9A-Fa-f]{2})/;
/** HTML character references: `&#NN;` (`;` optional, as browsers accept), `&#xHH;`, and the named ones encoders emit. */
const HTML_REF = /^&(?:#([0-9]{1,7});?|#[xX]([0-9A-Fa-f]{1,6});|(amp|lt|gt|quot|apos|sol|plus|equals|colon|period|lowbar|hyphen|num|percnt);)/i;
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  sol: '/',
  plus: '+',
  equals: '=',
  colon: ':',
  period: '.',
  lowbar: '_',
  hyphen: '-',
  num: '#',
  percnt: '%',
};
/** G-44: JSON single-character escapes decoded to what they mean (`\"`, `\\`, `\/` take the generic keep-the-character rule). */
const JSON_ESC: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

interface View {
  view: string;
  /** For each UTF-16 unit of `view`: [start, end) of the original span it stands for; null = identity. */
  starts: Int32Array | null;
  ends: Int32Array | null;
}

/**
 * The normalised view of `s`, with a map back to the original offsets. Undone
 * here (G-19, G-35), each mapped back to the exact original span so that the
 * ORIGINAL bytes are masked:
 *   - `\uXXXX` (a surrogate pair `\uD83D\uDE00` decodes as one character), `\xXX`;
 *   - JSON's `\n` `\r` `\t` to that whitespace, `\b` `\f` dropped (G-44: a serialised line
 *     break is a separator, never the letter n);
 *   - any other backslash escape (Markdown, JSON `\"` `\\` `\/`): drop the backslash, keep the character;
 *   - `%XX` of a printable ASCII byte, any casing;
 *   - HTML character references `&#NN;`, `&#xHH;`, `&amp;` `&lt;` `&gt;` `&quot;`
 *     `&apos;` `&sol;` `&plus;` (and a few more named ones encoders emit);
 *   - invisible / control characters, dropped (also when they are the decoded value).
 * Two levels are undone (`&amp;#43;`, a JSON string escaped twice `\\u002B`); the
 * registered secrets go through the same function, so a secret that itself contains
 * `&amp;` or `\u0041` still matches its own echo.
 */
function normalise(s: string): View {
  const a = normaliseOnce(s);
  if (!a.starts || !a.ends || !NOISE.test(a.view)) return a;
  const b = normaliseOnce(a.view);
  if (!b.starts || !b.ends) return a;
  // Compose the maps: view₂ → view₁ → original.
  const starts = new Int32Array(b.view.length);
  const ends = new Int32Array(b.view.length);
  for (let k = 0; k < b.view.length; k++) {
    starts[k] = a.starts[b.starts[k]];
    ends[k] = a.ends[b.ends[k] - 1];
  }
  return { view: b.view, starts, ends };
}

/** One level of decoding (see `normalise`). */
function normaliseOnce(s: string): View {
  if (!NOISE.test(s)) return { view: s, starts: null, ends: null };
  const parts: string[] = [];
  const starts = new Int32Array(s.length);
  const ends = new Int32Array(s.length);
  let n = 0;
  let pending = -1;
  const push = (chunk: string, from: number, to: number) => {
    const start = pending >= 0 ? pending : from;
    pending = -1;
    parts.push(chunk);
    for (let k = 0; k < chunk.length; k++) {
      starts[n] = start;
      ends[n] = to;
      n++;
    }
  };
  /** Emit a decoded character for the original span [from, to): dropped when invisible. */
  const emit = (ch: string, from: number, to: number) => {
    if (INVISIBLE.test(ch)) {
      if (pending < 0) pending = from;
      return;
    }
    push(ch, from, to);
  };
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    if (cp === 0x5c) {
      if (i + 1 >= s.length) {
        if (pending < 0) pending = i;
        i += 1;
        continue;
      }
      const rest = s.slice(i + 1, i + 13);
      const u = U_ESC.exec(rest);
      if (u) {
        const unit = parseInt(u[1], 16);
        // A surrogate pair written as two escapes is ONE character.
        const lo = isHigh(unit) && s[i + 6] === '\\' ? U_ESC.exec(s.slice(i + 7, i + 12)) : null;
        if (lo && isLow(parseInt(lo[1], 16))) {
          emit(String.fromCharCode(unit, parseInt(lo[1], 16)), i, i + 12);
          i += 12;
        } else {
          emit(String.fromCharCode(unit), i, i + 6);
          i += 6;
        }
        continue;
      }
      const x = X_ESC.exec(rest);
      if (x) {
        emit(String.fromCharCode(parseInt(x[1], 16)), i, i + 4);
        i += 4;
        continue;
      }
      // G-44: JSON's single-character escapes mean a character, never a letter. A serialised
      // newline (`\n`) is a separator in the view exactly like a raw LF, so a file-level pass
      // sees the same tokens as the edge; `\b` and `\f` are control characters (dropped).
      const je = JSON_ESC[s[i + 1]];
      if (je !== undefined) {
        emit(je, i, i + 2);
        i += 2;
        continue;
      }
      // Any other escape (Markdown, JSON `\"` `\\` `\/`): keep the character, drop the backslash.
      if (pending < 0) pending = i;
      const ncp = s.codePointAt(i + 1)!;
      const nlen = ncp > 0xffff ? 2 : 1;
      push(s.slice(i + 1, i + 1 + nlen), i, i + 1 + nlen);
      i += 1 + nlen;
      continue;
    }
    if (cp === 0x25 && HEX.test(s.slice(i + 1, i + 3))) {
      const byte = parseInt(s.slice(i + 1, i + 3), 16);
      if (byte >= 0x20 && byte < 0x7f) {
        push(String.fromCharCode(byte), i, i + 3);
        i += 3;
        continue;
      }
    }
    if (cp === 0x26) {
      const m = HTML_REF.exec(s.slice(i, i + 12));
      if (m) {
        const code = m[1] !== undefined ? parseInt(m[1], 10) : m[2] !== undefined ? parseInt(m[2], 16) : -1;
        const ch = code >= 0 ? (code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd') : NAMED[m[3].toLowerCase()];
        emit(ch, i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    const ch = s.slice(i, i + len);
    if (INVISIBLE.test(ch)) {
      if (pending < 0) pending = i;
      i += len;
      continue;
    }
    push(ch, i, i + len);
    i += len;
  }
  return { view: parts.join(''), starts, ends };
}

/** ASCII-only lower-casing: keeps the length, so view offsets stay valid. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

type Span = [start: number, end: number, label: string];

/**
 * G-43: add a hit, MERGING it with every hit it overlaps (the union of the spans,
 * repeated until no overlap remains). Skipping an overlapping hit instead left the
 * part of it outside the earlier hit in the output, where the file-level pass (or a
 * log) found it again. Returns true when the hit overlapped nothing.
 */
function addHit(hits: Span[], a: number, b: number, label: string): boolean {
  let lo = a;
  let hi = b;
  let lab = label;
  let fresh = true;
  for (let merged = true; merged; ) {
    merged = false;
    for (let k = hits.length - 1; k >= 0; k--) {
      const [s, e, l] = hits[k];
      if (lo < e && hi > s) {
        lo = Math.min(lo, s);
        hi = Math.max(hi, e);
        lab = l;
        hits.splice(k, 1);
        merged = true;
        fresh = false;
      }
    }
  }
  hits.push([lo, hi, lab]);
  return fresh;
}

/** Trailing characters a truncation leaves after the cut (ellipsis, a split UTF-8 sequence, whitespace). */
const TAIL_JUNK = /[…�\s.]+$/u;

function viewPass(s: string): string {
  const v = normalise(s);
  const view = asciiLower(v.view);
  const hits: Span[] = []; // in VIEW coordinates
  for (const e of normalised) {
    for (let i = view.indexOf(e.n); i >= 0; i = view.indexOf(e.n, i + 1)) {
      addHit(hits, i, i + e.n.length, e.label);
    }
  }
  // Truncation boundaries: a prefix of a secret at the end, a suffix at the start.
  const end = view.length - (TAIL_JUNK.exec(view)?.[0].length ?? 0);
  for (const e of normalised) {
    if (!e.partial) continue;
    const head = e.n.slice(0, MIN_SECRET_LENGTH);
    for (let p = view.indexOf(head, Math.max(0, end - e.n.length)); p >= 0 && p + MIN_SECRET_LENGTH <= end; p = view.indexOf(head, p + 1)) {
      if (e.n.startsWith(view.slice(p, end))) {
        addHit(hits, p, end, e.label);
        break;
      }
    }
    const lead = view.slice(0, MIN_SECRET_LENGTH);
    if (lead.length === MIN_SECRET_LENGTH) {
      for (let q = e.n.indexOf(lead); q > 0; q = e.n.indexOf(lead, q + 1)) {
        const suffix = e.n.slice(q);
        if (view.startsWith(suffix)) {
          addHit(hits, 0, suffix.length, e.label);
          break;
        }
      }
    }
  }
  for (const re of SHAPES) {
    re.lastIndex = 0;
    for (const m of v.view.matchAll(re)) {
      const a = m.index!;
      const b = a + m[0].length;
      if (addHit(hits, a, b, '[redacted:shape]')) shapeHits++;
    }
  }
  if (!hits.length) return s;
  // Map view spans to original spans; apply right to left.
  const spans = hits.map(([a, b, l]) => (v.starts && v.ends ? [v.starts[a], v.ends[b - 1], l] : [a, b, l]) as Span).sort((x, y) => y[0] - x[0]);
  let out = s;
  let floor = Infinity;
  for (const [a, b, l] of spans) {
    const bb = Math.min(b, floor);
    if (bb <= a) continue;
    out = out.slice(0, a) + l + out.slice(bb);
    floor = a;
  }
  return out;
}

export function redact(text: string): string {
  let s = text;
  if (registered.size) {
    for (const k of sortedExact) if (s.includes(k)) s = s.split(k).join(registered.get(k)!.label);
  }
  // The view pass runs BEFORE the raw shape pass (G-35): a raw `Bearer <tok>` match stops at
  // the first escape (`\u002B`, `&#43;`) and would leave the rest of the token behind, while
  // the same rule over the decoded view covers the whole original span.
  if (normalised.length || NOISE.test(s)) s = viewPass(s);
  for (const re of SHAPES) {
    s = s.replace(re, () => {
      shapeHits++;
      return '[redacted:shape]';
    });
  }
  return s;
}

/**
 * The ONLY way target text is cut (G-19): redact the whole raw text first, then
 * cut to `cap` UTF-16 units without splitting a surrogate pair, then redact
 * again so that a secret prefix the cut exposed (or that the target itself
 * truncated) is caught at the boundary.
 */
export function targetExcerpt(raw: string | Buffer | Uint8Array | undefined | null, cap: number): string {
  if (raw === undefined || raw === null) return '';
  const full = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  let s = redact(full);
  if (s.length > cap) {
    let n = cap;
    const c = s.charCodeAt(n - 1);
    if (c >= 0xd800 && c <= 0xdbff) n -= 1;
    s = s.slice(0, n);
  }
  return redact(s);
}

/** Number of shape-based redactions so far (a `credential_shape_in_output` warning when > 0). */
export function credentialShapeHits(): number {
  return shapeHits;
}
