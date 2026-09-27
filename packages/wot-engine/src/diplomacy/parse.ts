/**
 * Strict order parser (design §1.5.1). Syntax only: it knows the 75 province
 * ids and the coast tokens, nothing else about the board. Board-aware leniency
 * (ignored unit types, coasts, nationalities) lives in legalize.ts so that text
 * and JSON input are treated identically.
 */

import { isProvince } from './map.ts';
import { POWERS } from './types.ts';
import type { CoastTag, ParseError, ParseErrorCode, Power, RawLoc, RawOrder, UnitType } from './types.ts';

export const MAX_ORDER_CHARS = 64;
export const MAX_ORDERS = 64;

const err = (error: ParseErrorCode, detail: string): ParseError => ({ error, detail });
export const isParseError = (v: unknown): v is ParseError =>
  typeof v === 'object' && v !== null && typeof (v as ParseError).error === 'string' && !('k' in (v as object));

const COASTS: readonly string[] = ['nc', 'sc', 'ec', 'wc'];
const isType = (t: string | undefined): t is UnitType => t === 'A' || t === 'F';
const isPower = (t: string | undefined): t is Power => t !== undefined && (POWERS as readonly string[]).includes(t);

function parseLoc(tok: string | undefined): RawLoc | ParseError {
  if (tok === undefined) return err('bad_token', 'expected a location');
  const m = /^([a-z]{3})(?:\/([a-z]{2}))?$/.exec(tok);
  if (!m) return err('bad_token', `bad location token "${tok}"`);
  if (!isProvince(m[1])) return err('unknown_province', m[1]);
  if (m[2] === undefined) return { p: m[1] };
  if (!COASTS.includes(m[2])) return err('unknown_coast', m[2]);
  return { p: m[1], coast: m[2] as CoastTag | 'wc' };
}

export function parseOrder(text: unknown): RawOrder | ParseError {
  if (typeof text !== 'string') return err('not_string', typeof text);
  if (text.length > MAX_ORDER_CHARS) return err('too_long', `${text.length} > ${MAX_ORDER_CHARS}`);
  if (!/^[\x20-\x7e]*$/.test(text)) return err('non_ascii', 'only printable ASCII is accepted');
  if (text.length === 0) return err('empty', '');
  if (text.startsWith(' ') || text.endsWith(' ') || text.includes('  ')) {
    return err('bad_whitespace', 'single spaces only, no leading or trailing blanks');
  }
  const t = text.split(' ');
  let i = 0;
  const done = (o: RawOrder): RawOrder | ParseError =>
    i === t.length ? o : err('trailing_tokens', t.slice(i).join(' '));

  if (t[0] === 'W') {
    i = 1;
    return done({ k: 'waive' });
  }
  if (t[0] === 'B') {
    if (!isType(t[1])) return err('bad_token', 'build needs a unit type');
    const at = parseLoc(t[2]);
    if ('error' in at) return at;
    i = 3;
    return done({ k: 'build', type: t[1], at });
  }

  let type: UnitType | undefined;
  if (isType(t[i])) type = t[i++] as UnitType;
  const at = parseLoc(t[i++]);
  if ('error' in at) return at;
  const kw = t[i++];
  const base = type ? { type, at } : { at };
  switch (kw) {
    case 'H':
      return done({ k: 'hold', ...base });
    case 'D':
      return done({ k: 'disband', ...base });
    case 'R': {
      const to = parseLoc(t[i++]);
      if ('error' in to) return to;
      return done({ k: 'retreat', ...base, to });
    }
    case '-': {
      const to = parseLoc(t[i++]);
      if ('error' in to) return to;
      let via = false;
      if (t[i] === 'VIA') {
        via = true;
        i++;
      }
      return done({ k: 'move', ...base, to, via });
    }
    case 'S':
    case 'C': {
      let ofPower: Power | undefined;
      let ofType: UnitType | undefined;
      if (isPower(t[i])) ofPower = t[i++] as Power;
      if (isType(t[i])) ofType = t[i++] as UnitType;
      const of = parseLoc(t[i++]);
      if ('error' in of) return of;
      let to: RawLoc | undefined;
      if (t[i] === '-') {
        i++;
        const tt = parseLoc(t[i++]);
        if ('error' in tt) return tt;
        to = tt;
      }
      const who = { ...(ofPower ? { ofPower } : {}), ...(ofType ? { ofType } : {}), of };
      if (kw === 'C') {
        if (!to) return err('bad_token', 'convoy needs "- destination"');
        return done({ k: 'convoy', ...base, ...who, to });
      }
      return done(to ? { k: 'support', ...base, ...who, to } : { k: 'support', ...base, ...who });
    }
    default:
      return err('bad_token', `expected H, -, S, C, R or D, got "${kw ?? ''}"`);
  }
}

/**
 * JSON order form (contracts v2.1.0 `order_json`): keys `k, type, at{p,coast},
 * to, via, of_power, of_type, of`. Validated field by field; unknown keys are
 * rejected, never copied. Re-parsed through the text grammar so both paths share
 * one validator.
 *
 * DEPRECATED: the interim camelCase keys `ofPower` / `ofType` (the pre-2.1.0
 * RawOrder shape) are still accepted so recorded inputs and older callers keep
 * working; they are removed with the next scenario-version bump. Sending both
 * spellings of one field is `bad_json` (no precedence rule to exploit).
 */
export function rawFromJson(v: unknown): RawOrder | ParseError {
  if (typeof v === 'string') return parseOrder(v);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return err('bad_json', 'expected an object');
  const o = v as Record<string, unknown>;
  const allowed = new Set(['k', 'type', 'at', 'to', 'via', 'of_power', 'of_type', 'ofPower', 'ofType', 'of']);
  for (const key of Object.keys(o)) if (!allowed.has(key)) return err('bad_json', `unknown key ${key}`);
  if (o.of_power !== undefined && o.ofPower !== undefined) return err('bad_json', 'both of_power and ofPower');
  if (o.of_type !== undefined && o.ofType !== undefined) return err('bad_json', 'both of_type and ofType');
  const ofPowerIn = o.of_power ?? o.ofPower; // contract name first; `ofPower` deprecated
  const ofTypeIn = o.of_type ?? o.ofType; // contract name first; `ofType` deprecated
  const loc = (x: unknown): string | ParseError => {
    if (typeof x !== 'object' || x === null) return err('bad_json', 'location must be {p, coast?}');
    const l = x as Record<string, unknown>;
    for (const key of Object.keys(l)) if (key !== 'p' && key !== 'coast') return err('bad_json', `unknown key ${key}`);
    if (typeof l.p !== 'string') return err('bad_json', 'location.p must be a string');
    if (l.coast !== undefined && typeof l.coast !== 'string') return err('bad_json', 'location.coast must be a string');
    return l.coast !== undefined ? `${l.p}/${l.coast}` : l.p;
  };
  const opt = (x: unknown, pred: (s: string | undefined) => boolean): string | null | ParseError => {
    if (x === undefined) return null;
    if (typeof x !== 'string' || !pred(x)) return err('bad_json', `bad value ${String(x)}`);
    return x;
  };
  const type = opt(o.type, isType);
  if (type !== null && typeof type !== 'string') return type;
  const head = (): string | ParseError => {
    const at = loc(o.at);
    if (typeof at !== 'string') return at;
    return `${type ? `${type} ` : ''}${at}`;
  };
  let text: string | ParseError;
  switch (o.k) {
    case 'waive':
      text = 'W';
      break;
    case 'build': {
      const at = loc(o.at);
      text = typeof at === 'string' ? `B ${type ?? '?'} ${at}` : at;
      break;
    }
    case 'hold':
    case 'disband': {
      const h = head();
      text = typeof h === 'string' ? `${h} ${o.k === 'hold' ? 'H' : 'D'}` : h;
      break;
    }
    case 'move':
    case 'retreat': {
      const h = head();
      const to = loc(o.to);
      if (typeof h !== 'string') text = h;
      else if (typeof to !== 'string') text = to;
      else if (o.via !== undefined && typeof o.via !== 'boolean') text = err('bad_json', 'via must be boolean');
      else text = o.k === 'move' ? `${h} - ${to}${o.via ? ' VIA' : ''}` : `${h} R ${to}`;
      break;
    }
    case 'support':
    case 'convoy': {
      const h = head();
      const of = loc(o.of);
      const to = o.to === undefined ? null : loc(o.to);
      const ofPower = opt(ofPowerIn, isPower);
      const ofType = opt(ofTypeIn, isType);
      if (typeof h !== 'string') text = h;
      else if (typeof of !== 'string') text = of;
      else if (to !== null && typeof to !== 'string') text = to;
      else if (ofPower !== null && typeof ofPower !== 'string') text = ofPower;
      else if (ofType !== null && typeof ofType !== 'string') text = ofType;
      else
        text = `${h} ${o.k === 'support' ? 'S' : 'C'} ${ofPower ? `${ofPower} ` : ''}${ofType ? `${ofType} ` : ''}${of}${
          to !== null ? ` - ${to}` : ''
        }`;
      break;
    }
    default:
      text = err('bad_json', 'unknown order kind');
  }
  if (typeof text !== 'string') return text;
  return parseOrder(text);
}
