/**
 * Per-session token-bucket rate limiter: 5/s sustained, burst 20 (agent-
 * passports §6.2). Uses wall-clock (this is the I/O layer, not the pure engine).
 */

import { RATE_BURST, RATE_PER_SEC } from './config.ts';

export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec = RATE_PER_SEC,
    private readonly burst = RATE_BURST,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Try to consume one frame's worth of budget; false if the limit is exceeded. */
  tryConsume(now = Date.now()): boolean {
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Grant credit tied to the server's own prompting rate: the arena calls this
   * each time it sends the session an observation, so an agent that answers one
   * action per observation is never throttled however fast the tick loop runs,
   * while a client flooding many frames per prompt still depletes the bucket.
   */
  credit(n: number): void {
    this.tokens = Math.min(this.burst, this.tokens + n);
  }

  /** Non-mutating peek at the current token count (after notional refill). */
  available(now = Date.now()): number {
    const elapsed = (now - this.last) / 1000;
    return Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
  }

  /** True when the bucket is fully replenished (idle) — safe to prune. */
  isFull(now = Date.now()): boolean {
    return this.available(now) >= this.burst - 1e-6;
  }
}
