/**
 * Reusable untrusted-edge guards (Phase 5 B5, fuzz surface F1–F7) — the
 * enumerated edge-hardening invariants from docs/security/resilience-and-review.md
 * §1.6, factored so every untrusted WSS/REST edge (play, raid, negotiation)
 * applies them the same way, BEFORE any engine or store work.
 *
 * The invariants these encode (each an assertion the fuzz suite proves):
 *  - AJV-before-processing: schema-validate at the edge; malformed → reject, never
 *    a partial engine touch.
 *  - Size caps, LAYERED: a byte cap per frame, plus a bounded-depth JSON guard so a
 *    deeply-nested "billion-laughs" body is rejected cheaply (the single instance
 *    is the availability chokepoint).
 *  - Anti-replay: a one-time nonce acceptor with bounded memory.
 *  - No secret / oracle leakage: a constant-time string compare.
 *
 * These are pure helpers with no I/O — the route handlers (built by B1/B4) call
 * them; where those handlers do not exist yet, these are the guards + tests they
 * will use (the task does not block on those services).
 */

// ---------------------------------------------------------------------------
// Layered edge guard: byte cap → parse → depth guard → schema validate
// ---------------------------------------------------------------------------

export type EdgeReason = 'ok' | 'too_large' | 'unparseable' | 'too_deep' | 'schema_invalid';

export interface EdgeResult<T> {
  ok: boolean;
  reason: EdgeReason;
  value?: T;
}

export interface EdgeGuardOptions {
  /** Hard per-frame byte cap (from the contract's `x-max-frame-bytes`). */
  maxBytes: number;
  /** Max JSON nesting depth accepted (default 32). Cheap billion-laughs defense. */
  maxDepth?: number;
  /** The compiled AJV validator for this frame (AJV-before-processing). */
  validate?: (obj: unknown) => boolean;
}

/**
 * Measure JSON nesting depth ITERATIVELY (explicit stack, so a hostile deep body
 * cannot blow our own call stack), short-circuiting once the cap is exceeded.
 */
export function jsonDepth(value: unknown, cap = 64): number {
  let max = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > max) max = depth;
    if (depth > cap) return depth; // exceeded — stop early
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (node !== null && typeof node === 'object') {
      for (const k of Object.keys(node as Record<string, unknown>)) {
        stack.push({ node: (node as Record<string, unknown>)[k], depth: depth + 1 });
      }
    }
  }
  return max;
}

/**
 * Run the layered guard on a raw inbound frame. Returns the FIRST failing layer's
 * reason (uniform envelope — no differential detail that could oracle), or the
 * parsed value on success. The engine/store is touched ONLY on `ok:true`.
 */
export function guardFrame<T = unknown>(raw: string | Buffer, opts: EdgeGuardOptions): EdgeResult<T> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > opts.maxBytes) return { ok: false, reason: 'too_large' };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  const maxDepth = opts.maxDepth ?? 32;
  if (jsonDepth(obj, maxDepth) > maxDepth) return { ok: false, reason: 'too_deep' };
  if (opts.validate && !opts.validate(obj)) return { ok: false, reason: 'schema_invalid' };
  return { ok: true, reason: 'ok', value: obj as T };
}

// ---------------------------------------------------------------------------
// Anti-replay: one-time nonce acceptance with bounded memory
// ---------------------------------------------------------------------------

/**
 * Accept a submission key (a nonce, or `${turn_id}:${nonce}`) EXACTLY once. A
 * replayed, cross-match, or post-resume-stale key is refused. Bounded memory (an
 * FIFO cap) so a flood of distinct nonces cannot grow it unbounded — the single
 * instance is the availability chokepoint.
 */
export class SubmissionNonceGuard {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly cap = 4096) {}

  /** True the first time `key` is seen; false on every replay. */
  accept(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }
}

// ---------------------------------------------------------------------------
// Constant-time compare (no timing oracle on where two strings diverge)
// ---------------------------------------------------------------------------

/**
 * Length-independent, position-independent equality. Scans a FIXED number of code
 * units (the longer of the two) with NO early exit, so timing depends only on the
 * lengths — never on WHERE or HOW BADLY the inputs diverge.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
