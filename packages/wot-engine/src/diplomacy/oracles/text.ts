/**
 * The only text operations any Diplomacy oracle performs (docs/design/diplomacy-scenario.md
 * §2 common rules, Pillar 9): exact, specified string functions. No model, no fuzzy match.
 *
 *  - `norm(s)`: NFKC, lower-case fold, every run of characters outside L/N → one space, trim.
 *  - province mentions: a token equal to an A1 province id, or a (normalised) A1 full name
 *    (multi-word names match as a contiguous token run).
 *  - content tokens: tokens that are not province mentions, unit-type tokens, order verbs
 *    or one of the 100 most frequent English words (`STOPWORDS`, published).
 *  - `extractOrders(text)`: the A1 order parser run over every maximal token span.
 */

import { isProvince, MAP } from '../map.ts';
import { formatRaw } from '../orders.ts';
import { isParseError, parseOrder } from '../parse.ts';
import type { RawOrder } from '../types.ts';

const NON_LN = /[^\p{L}\p{N}]+/gu;

export function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(NON_LN, ' ').trim();
}

export const tokensOf = (s: string): string[] => {
  const n = norm(s);
  return n === '' ? [] : n.split(' ');
};

/** Contiguous token-sequence containment over normalised text. */
export function containsSeq(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The 100 most frequent English words (fixed, published list; content-token stoplist). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one ' +
    'all would there their what so up out if about who get which go me when make can like time no just him know take people into year ' +
    'your good some could them see other than then now look only come its over think also back after use two how our work first well ' +
    'way even new want because any these give day most us'
  ).split(' '),
);
export const UNIT_TOKENS: ReadonlySet<string> = new Set(['a', 'f', 'army', 'fleet']);
export const ORDER_VERBS: ReadonlySet<string> = new Set(['s', 'c', 'h', 'supports', 'convoys', 'holds', 'hold', 'support', 'convoy', 'move', 'moves', 'to']);

const NAME_TOKENS: readonly (readonly string[])[] = MAP.provinces
  .map((p) => tokensOf(p.name))
  .filter((t) => t.length > 0)
  .sort((a, b) => b.length - a.length);

/** Per token: is it part of a province mention? */
export function provinceMask(toks: readonly string[]): boolean[] {
  const mask = toks.map((t) => isProvince(t));
  for (const name of NAME_TOKENS) {
    for (let i = 0; i + name.length <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < name.length; j++) if (toks[i + j] !== name[j]) ok = false;
      if (ok) for (let j = 0; j < name.length; j++) mask[i + j] = true;
    }
  }
  return mask;
}

export function contentTokens(s: string): string[] {
  const toks = tokensOf(s);
  const mask = provinceMask(toks);
  return toks.filter((t, i) => !mask[i] && !UNIT_TOKENS.has(t) && !ORDER_VERBS.has(t) && !STOPWORDS.has(t));
}

export function ngrams(toks: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(' '));
  return out;
}

/** Does normalised `text` mention province id `p` (by id or full name)? */
export function mentionsProvince(text: string, p: string): boolean {
  const toks = tokensOf(text);
  if (toks.includes(p)) return true;
  const name = tokensOf(MAP.provinces.find((x) => x.id === p)?.name ?? '');
  return containsSeq(toks, name);
}

// ------------------------------------------------------------------ order extraction (§2.1)

const MAX_SPAN = 9;
const TRIM = /^[\s.,;:!?"'()[\]{}]+|[\s.,;:!?"'()[\]{}]+$/g;

function orderToken(t: string): string {
  const x = t.replace(TRIM, '');
  const l = x.toLowerCase();
  if (l === 'a' || l === 'f' || l === 'h' || l === 's' || l === 'c' || l === 'r' || l === 'd') return l.toUpperCase();
  if (l === 'via') return 'VIA';
  if (/^[a-z]{3}(\/[a-z]{2})?$/.test(l) && isProvince(l.slice(0, 3))) return l;
  return x;
}

/**
 * Every movement order written in `text`, in order of appearance: the strict A1
 * parser applied to each maximal token span (case-folded tokens, surrounding
 * punctuation trimmed). Returns canonical `formatRaw` texts.
 */
export function extractOrders(text: string): string[] {
  const toks = text.split(/\s+/).filter((t) => t.length > 0).map(orderToken);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    let hit: { o: RawOrder; end: number } | null = null;
    for (let end = Math.min(toks.length, i + MAX_SPAN); end >= i + 3; end--) {
      const r = parseOrder(toks.slice(i, end).join(' '));
      if (!isParseError(r) && (r.k === 'hold' || r.k === 'move' || r.k === 'support' || r.k === 'convoy')) {
        hit = { o: r, end };
        break;
      }
    }
    if (hit) {
      out.push(formatRaw(hit.o));
      i = hit.end;
    } else i++;
  }
  return out;
}
