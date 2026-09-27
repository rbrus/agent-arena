/**
 * Deterministic JSON helpers.
 *
 * `jcs` is RFC 8785, the JSON Canonicalization Scheme (contracts/signing.md §1):
 *   - object members sorted by their keys as arrays of UTF-16 code units
 *     (JavaScript's default string order is exactly that; NOT locale order, NOT
 *     code-point order: U+10000 (D800 DC00) sorts before U+FB33);
 *   - no whitespace;
 *   - strings serialised as ECMAScript `JSON.stringify` does (RFC 8785 §3.2.2.2:
 *     `\b \t \n \f \r \" \\` short escapes, other C0 controls as lower-case
 *     `\u00xx`, everything else, `/` and non-ASCII included, as is);
 *   - numbers serialised as ECMAScript `Number.prototype.toString` (RFC 8785
 *     §3.2.2.3; `JSON.stringify` of a finite number is exactly that, and -0 is 0);
 *   - `true`, `false`, `null` as literals.
 * Refused: non-finite numbers, BigInt, functions, symbols, `undefined` where a
 * value is required, non-plain objects (Date, Map, class instances: RFC 8785
 * operates on the I-JSON data model, never on `toJSON` side effects) and, in
 * `strict` mode (the signing path), lone UTF-16 surrogates (I-JSON, RFC 7493
 * §2.1, which RFC 8785 §3.1 requires). Undefined object members are skipped,
 * as `JSON.parse(JSON.stringify(x))` would drop them.
 *
 * `canonicalize` is the non-strict form used for digests since contracts 2.0.0
 * (run id, recorded-input digests). For every contract document it produces
 * the same bytes as the strict form and as the 12-line `jcs` of
 * contracts/tools/contract-check.mjs.
 */

import { createHash } from 'node:crypto';

export interface JcsOptions {
  /** Refuse lone surrogates in strings and keys (I-JSON). Default false. */
  strict?: boolean;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_DEPTH = 1000;

function str(s: string, strict: boolean, where: string): string {
  if (strict && LONE_SURROGATE.test(s)) throw new Error(`JCS: lone surrogate in a string at ${where || '/'} (not I-JSON)`);
  return JSON.stringify(s);
}

function ser(v: unknown, strict: boolean, where: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new Error(`JCS: nesting deeper than ${MAX_DEPTH}`);
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`JCS: non-finite number at ${where || '/'}`);
      return JSON.stringify(v); // ECMAScript Number::toString; -0 → "0"
    case 'string':
      return str(v, strict, where);
    case 'object':
      break;
    default:
      throw new Error(`JCS: ${typeof v} is not JSON at ${where || '/'}`);
  }
  if (Array.isArray(v)) {
    // An index loop, not map(): map() skips the holes of a sparse array (JSON.stringify writes null there).
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) parts.push(v[i] === undefined ? 'null' : ser(v[i], strict, `${where}/${i}`, depth + 1));
    return `[${parts.join(',')}]`;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error(`JCS: non-plain object at ${where || '/'}`);
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${str(k, strict, where)}:${ser(obj[k], strict, `${where}/${k}`, depth + 1)}`).join(',')}}`;
}

/** RFC 8785 canonical JSON text of `value`. */
export function jcs(value: unknown, opts: JcsOptions = {}): string {
  if (value === undefined) throw new Error('JCS: undefined is not JSON');
  return ser(value, opts.strict === true, '', 0);
}

/** Canonical form for digests (JCS, non-strict). */
export function canonicalize(value: unknown): string {
  return jcs(value);
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex');
}

/** sha256 over the canonical form: equal iff the JSON values are equal. */
export function canonicalDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

/** The on-disk form of report.json / report.sarif: 2-space JSON, LF, trailing newline. Byte-stable for a given value. */
export function toFileJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
