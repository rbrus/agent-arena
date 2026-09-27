/**
 * Structured-log redaction for the retained services (threat-model-arena §1.3,
 * finding G-6). One implementation, imported by every service log sink
 * (passports + gateway `log()`/`errorHandler`, the arena `defaultLogger`).
 *
 * Two passes, both required:
 *
 *   1. `redactForLog(value)` walks the value BEFORE serialisation: nested
 *      objects, arrays, Maps, Error objects (allowlisted fields only, never
 *      request options or stacks) and header bags. A property whose KEY looks
 *      sensitive is replaced wholesale; every string VALUE is substring-redacted.
 *   2. `redactText(line)` runs over the serialised line AFTER `JSON.stringify`,
 *      so anything the walk missed (a secret inside a key name, a toJSON that
 *      re-emits a value) is still caught as a substring.
 *
 * Value rules: every registered secret (the configured pepper, the signing
 * key's private scalar, the raw private JWK) and its base64/base64url/URI
 * encodings, plus shapes: `wotk_sk_…` passport secrets, JWTs (`eyJ…` and any
 * dotted base64url triplet), `Bearer`/`Basic` credentials, and common vendor key
 * prefixes. Mirrors `arena-cli/src/redact.ts` SHAPES; kept zero-dependency so
 * the two can be merged into one shared module later without churn.
 */

export const REDACTED = '[redacted]';

/** Registered secrets shorter than this are refused (collateral damage). */
export const MIN_SECRET_LENGTH = 8;

/** Walk depth cap: deeper structure is replaced, not logged. */
const MAX_DEPTH = 8;
/** Per-string cap after redaction, so one log field cannot flood a sink. */
const MAX_STRING = 4096;

/**
 * Key-name rule. Matches `authorization`, `cookie`/`set-cookie`, `x-api-key`,
 * `client_secret`, `access_token`, `password`, `pepper`, `private_jwk`, and any
 * key that itself carries a passport-secret prefix. Narrow benign exceptions
 * (`SAFE_KEY`) keep operational fields such as `secret_version` visible.
 */
const SENSITIVE_KEY =
  /secret|token|key|authori[sz]ation|passw(or)?d|passphrase|cookie|bearer|credential|pepper|jwk|jwt|signature|^auth$|wotk_/i;
const SAFE_KEY = /^(secret_version|token_type|token_ttl_seconds|kid|key_id|expires_in)$/i;

/** Credential shapes, matched anywhere in a string (substring, not whole-value). */
const SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/wotk_sk_[A-Za-z0-9_-]+/g, REDACTED], // passport client secret
  [/wotk_[a-z]{2,8}_[A-Za-z0-9_-]{8,}/g, REDACTED], // any other wotk_<kind>_ credential
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g, REDACTED], // JWT / JWS / JWE head
  [/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED], // any JWT-shaped triplet
  [/\b(Bearer|Basic|DPoP)(\s+|%20|\+)[A-Za-z0-9._~+/=%-]{4,}/gi, `$1 ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // The private member of a JWK in serialised form (a passport signing key, B3c),
  // plain or JSON-escaped inside another string: `"d":"<b64url scalar>"`.
  [/(\\*"d\\*"\s*:\s*\\*")[A-Za-z0-9_-]{20,}/g, `$1${REDACTED}`],
];

/** A private JWK anywhere in a logged value (has `kty` and a private member) is replaced wholesale. */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'] as const;
function isPrivateJwk(o: object): boolean {
  const j = o as Record<string, unknown>;
  return typeof j.kty === 'string' && PRIVATE_JWK_MEMBERS.some((m) => j[m] !== undefined);
}

const registered = new Set<string>();
let registeredSorted: string[] = [];

function variants(v: string): string[] {
  const out = new Set<string>([v]);
  const b = Buffer.from(v, 'utf8');
  out.add(b.toString('base64'));
  out.add(b.toString('base64').replace(/=+$/, ''));
  out.add(b.toString('base64url'));
  out.add(encodeURIComponent(v));
  out.add(JSON.stringify(v).slice(1, -1));
  return [...out].filter((x) => x.length >= MIN_SECRET_LENGTH);
}

/**
 * Register a live secret value (pepper, signing-key scalar, raw private JWK) so
 * any occurrence of it, or of its common encodings, is redacted from every log
 * line. Values shorter than MIN_SECRET_LENGTH are ignored. Idempotent.
 */
export function registerLogSecret(value: string | null | undefined): void {
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
  let changed = false;
  for (const v of variants(value)) {
    if (!registered.has(v)) {
      registered.add(v);
      changed = true;
    }
  }
  if (changed) registeredSorted = [...registered].sort((a, b) => b.length - a.length);
}

/** Test helper: forget registered secrets. */
export function _clearLogSecrets(): void {
  registered.clear();
  registeredSorted = [];
}

/** Substring redaction of one string (registered secrets first, then shapes). */
export function redactText(text: string): string {
  let s = text;
  for (const v of registeredSorted) {
    if (s.includes(v)) s = s.split(v).join(REDACTED);
  }
  for (const [re, rep] of SHAPES) s = s.replace(re, rep);
  return s;
}

export function isSensitiveKey(key: string): boolean {
  return !SAFE_KEY.test(key) && SENSITIVE_KEY.test(key);
}

function capString(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
}

/** Only these Error fields are ever logged (threat model C-3); never stacks or request options. */
function errorView(e: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const x = e as Error & { code?: unknown; status?: unknown; statusCode?: unknown; type?: unknown; cause?: unknown };
  const out: Record<string, unknown> = { name: e.name, message: capString(redactText(String(e.message))) };
  if (typeof x.code === 'string' || typeof x.code === 'number') out.code = x.code;
  const status = x.status ?? x.statusCode;
  if (typeof status === 'number') out.status = status;
  if (typeof x.type === 'string') out.type = redactText(x.type);
  if (x.cause !== undefined) out.cause = walk(x.cause, depth + 1, seen);
  return out;
}

function walk(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof v === 'string') return capString(redactText(v));
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  const o = v as object;
  if (seen.has(o)) return '[circular]';
  seen.add(o);
  try {
    if (o instanceof Error) return errorView(o, depth, seen);
    if (o instanceof Date) return o.toISOString();
    if (Buffer.isBuffer(o) || ArrayBuffer.isView(o)) return '[binary]';
    if (Array.isArray(o)) return o.map((x) => walk(x, depth + 1, seen));
    if (!(o instanceof Map) && isPrivateJwk(o)) return REDACTED;
    // Header bags and Maps: entries may be `Authorization`/`Cookie` pairs.
    let entries: Array<[string, unknown]>;
    if (o instanceof Map) entries = [...o.entries()].map(([k, x]) => [String(k), x]);
    else if (typeof (o as { entries?: unknown }).entries === 'function' && typeof (o as { get?: unknown }).get === 'function') {
      entries = [...(o as unknown as { entries(): Iterable<[string, unknown]> }).entries()];
    } else entries = Object.entries(o);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries) {
      const safeKey = redactText(k);
      out[safeKey] = isSensitiveKey(k) ? REDACTED : walk(x, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

/** Redact an arbitrary value for logging (nested objects/arrays/errors/headers). */
export function redactForLog<T>(value: T): T extends string ? string : unknown {
  return walk(value, 0, new WeakSet()) as T extends string ? string : unknown;
}

/**
 * Serialise a structured log record: walk + JSON.stringify + a final substring
 * pass over the whole line. The ONLY way a service should build a log line.
 */
export function serializeLogRecord(record: Record<string, unknown>): string {
  let line: string;
  try {
    line = JSON.stringify(walk(record, 0, new WeakSet()));
  } catch {
    line = JSON.stringify({ msg: 'log_serialisation_failed' });
  }
  return redactText(line);
}
