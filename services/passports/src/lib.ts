/**
 * Cross-cutting HTTP helpers for the management plane: the stable error
 * envelope (contracts/schemas/error.schema.json + errors.md), structured logs
 * that NEVER emit secrets/tokens (redacted by key and value at any depth, G-6),
 * per-request ids, a memory-bounded token-bucket rate limiter (agent-passports
 * §6, G-5), and the shared 404 / error tail.
 *
 * This file is intentionally self-contained and duplicated byte-for-byte in the
 * gateway service: passports and gateway are separate Cloud Run services
 * (ADR-000) that must not import each other's source. The sandbox composes them
 * in-process by importing these helpers once (from passports).
 */

import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { serializeLogRecord } from 'wot-auth';

// ---------------------------------------------------------------------------
// Error envelope (errors.md §1)
// ---------------------------------------------------------------------------

/** Machine error code -> HTTP status (errors.md §1). */
export const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  unprocessable: 422,
  unauthenticated: 401,
  insufficient_scope: 403,
  forbidden: 403,
  not_owner: 403,
  owner_banned: 403,
  agent_not_found: 404,
  match_not_found: 404,
  replay_not_found: 404,
  not_found: 404, // generic unknown-route (non-catalogued; schema `error` is free-form string)
  conflict: 409,
  payload_too_large: 413,
  quota_exceeded: 429,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
};

export interface ErrorOptions {
  /** Advisory structured context (error.schema.json `detail`). */
  detail?: Record<string, unknown>;
  /** Extra `WWW-Authenticate` value (RFC 6750). Auto-set for auth codes. */
  wwwAuthenticate?: string;
  /** Extra response headers (e.g. Retry-After). */
  headers?: Record<string, string | number>;
}

/**
 * Send a management-plane error using the stable envelope. `error_description`
 * must never leak a secret or an enumeration oracle (errors.md preamble).
 */
export function sendError(
  res: Response,
  code: string,
  description: string,
  opts: ErrorOptions = {},
): void {
  const status = ERROR_STATUS[code] ?? 500;
  const requestId = (res.locals?.requestId as string | undefined) ?? undefined;

  // RFC 6750 challenge headers for the two auth failures.
  let www = opts.wwwAuthenticate;
  if (!www && code === 'unauthenticated') www = 'Bearer error="invalid_token"';
  if (!www && code === 'insufficient_scope') www = 'Bearer error="insufficient_scope"';
  if (www) res.setHeader('WWW-Authenticate', www);

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) res.setHeader(k, String(v));
  }

  const body: Record<string, unknown> = { error: code, error_description: description };
  if (requestId) body.request_id = requestId;
  if (opts.detail) body.detail = opts.detail;
  res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// Request id + structured logging (never logs secrets/tokens)
// ---------------------------------------------------------------------------

export function newRequestId(): string {
  return `req_${randomBytes(9).toString('base64url')}`;
}

/** Idempotent: assigns a request id + start time so it is safe when composed. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.requestId) {
    res.locals.requestId = newRequestId();
    res.locals.startTime = Date.now();
  }
  next();
}

// Log redaction (threat-model-arena §1.3, G-6) lives in `wot-auth`
// (`serializeLogRecord`): it walks nested objects/arrays/Maps/header bags and
// Error objects (allowlisted fields only), redacts sensitive KEYS (secret,
// token, key, authorization, password, cookie, pepper, jwk, wotk_ …) wholesale
// and every string VALUE by substring (registered pepper / signing key and
// their encodings, `wotk_sk_…`, JWTs, `Bearer …`), then re-runs the substring
// pass over the serialised line. Every log line from this service goes through
// it; call sites still never pass secrets to log() in the first place.

export type LogLevel = 'info' | 'warn' | 'error';
/** A log sink receives the already-redacted, serialised line. */
export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};
let logSink: LogSink = defaultSink;

/** Swap the log sink (tests, or a Cloud Logging transport). Returns the previous sink. */
export function setLogSink(sink: LogSink | null): LogSink {
  const prev = logSink;
  logSink = sink ?? defaultSink;
  return prev;
}

/** Structured JSON log line; redacted by key AND by value, at any depth. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  logSink(level, serializeLogRecord({ ts: new Date().toISOString(), level, msg, ...fields }));
}

// ---------------------------------------------------------------------------
// Shared 404 + error tail
// ---------------------------------------------------------------------------

/** 404 for any unmatched route (mount LAST, after all service routes). */
export function notFound(_req: Request, res: Response): void {
  sendError(res, 'not_found', 'No such resource.');
}

/**
 * Terminal error handler. Maps body-parser failures to contract codes and
 * everything else to a leak-free 500. Must be mounted last (4-arg signature).
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;
  const e = err as { type?: string; status?: number; statusCode?: number } & Error;
  const status = e?.status ?? e?.statusCode;
  if (e?.type === 'entity.too.large' || status === 413) {
    sendError(res, 'payload_too_large', 'Request body exceeds the 16 KB limit.');
    return;
  }
  if (e instanceof SyntaxError && 'body' in (e as object)) {
    sendError(res, 'invalid_request', 'Request body is not valid JSON.');
    return;
  }
  // The Error object itself is passed: the redactor keeps only name/message/
  // code/status/cause (substring-redacted), never request options or stacks.
  log('error', 'unhandled_error', {
    request_id: res.locals?.requestId,
    method: _req?.method,
    path: _req?.path,
    err: err instanceof Error ? err : String(err),
  });
  sendError(res, 'internal_error', 'An unexpected error occurred.');
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (agent-passports §6)
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Hard cap on tracked keys; the least-recently-used bucket is evicted beyond it. */
  maxKeys?: number;
  /**
   * Idle time after which a bucket is dropped. Defaults to `windowMs`: by then
   * the bucket has refilled to capacity, so dropping it changes no decision.
   */
  ttlMs?: number;
  /** Longest key kept verbatim; longer keys are truncated (with a marker). */
  maxKeyLength?: number;
  /** Clock (tests). */
  now?: () => number;
}

/** Default caps (G-5): 10k keys per limiter, 128-char keys. */
export const RATE_LIMITER_MAX_KEYS = 10_000;
export const RATE_LIMITER_MAX_KEY_LENGTH = 128;

/**
 * Normalise an attacker-influenced bucket key: NFC, strip control and
 * format characters, cap the length. Two spellings of one id share a bucket and
 * no key can carry unbounded bytes into the map.
 */
export function normalizeRateKey(raw: unknown, maxLen = RATE_LIMITER_MAX_KEY_LENGTH): string {
  let k = typeof raw === 'string' ? raw : String(raw);
  if (k.length > maxLen * 4) k = k.slice(0, maxLen * 4); // bound the work below
  k = k.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  if (k.length > maxLen) k = `${k.slice(0, maxLen)}~`;
  return k === '' ? '(empty)' : k;
}

/**
 * In-memory token bucket keyed by an arbitrary string. Exact for a single
 * instance (Phase 1: gateway/passports run min=max=1); the forward path is a
 * shared counter store (agent-passports §6.1, same seam as the session
 * registry). `capacity` tokens, refilled at `capacity/windowMs`.
 *
 * Memory is bounded (G-5): the map is kept in least-recently-used order
 * (a hit re-inserts the key at the tail); idle buckets older than `ttlMs` are
 * swept from the head (at most once a second), and beyond `maxKeys` the
 * least-recently-used buckets are evicted in a batch down to 90% of the cap. Keys are normalised and length-capped. Evicting a bucket can only
 * reset that key to a full bucket, the same state an idle key reaches anyway.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  private readonly ttlMs: number;
  private readonly maxKeyLength: number;
  private readonly now: () => number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    opts: RateLimiterOptions = {},
  ) {
    this.maxKeys = Math.max(1, opts.maxKeys ?? RATE_LIMITER_MAX_KEYS);
    this.ttlMs = Math.max(1, opts.ttlMs ?? windowMs);
    this.maxKeyLength = Math.max(8, opts.maxKeyLength ?? RATE_LIMITER_MAX_KEY_LENGTH);
    this.now = opts.now ?? Date.now;
  }

  /** Number of tracked buckets (bounded by `maxKeys`). */
  get size(): number {
    return this.buckets.size;
  }

  private lastSweep = -Infinity;

  /**
   * Drop expired buckets from the head (Map iteration order == LRU order), then,
   * if still over the cap, evict the least-recently-used down to 90% of it in
   * the same pass. Batching matters: deleting from a Map's head leaves
   * tombstones every later head scan re-skips, so scanning on every call would
   * make each request O(maxKeys).
   */
  private evict(now: number, force: boolean): void {
    if (!force && now - this.lastSweep < Math.min(this.ttlMs, 1000)) return;
    this.lastSweep = now;
    const target = this.buckets.size > this.maxKeys ? Math.floor(this.maxKeys * 0.9) : Infinity;
    for (const [k, b] of this.buckets) {
      if (now - b.updatedAt < this.ttlMs && this.buckets.size <= target) break;
      this.buckets.delete(k);
    }
  }

  take(rawKey: string, cost = 1): RateResult {
    const now = this.now();
    const key = normalizeRateKey(rawKey, this.maxKeyLength);
    this.evict(now, false);
    const refillPerMs = this.capacity / this.windowMs;
    const existing = this.buckets.get(key);
    const b = existing ?? { tokens: this.capacity, updatedAt: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updatedAt) * refillPerMs);
    b.updatedAt = now;
    if (existing) this.buckets.delete(key); // re-insert at the tail (most recent)
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.evict(now, true);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const deficit = cost - b.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
    return { allowed: false, retryAfterSeconds };
  }
}

/** Send the standard 429 for a rate-limit breach (Retry-After + detail). */
export function sendRateLimited(res: Response, retryAfterSeconds: number, code = 'rate_limited'): void {
  const description =
    code === 'quota_exceeded'
      ? 'Passport creation quota reached (max_new_per_day).'
      : 'Too many requests; retry after the indicated delay.';
  sendError(res, code, description, {
    headers: { 'Retry-After': retryAfterSeconds },
    detail: { retry_after_seconds: retryAfterSeconds },
  });
}
