/**
 * Politeness limits (threat model §8.1): a per-origin token bucket in front of
 * every outbound request / frame. Defaults: 5 requests/s for a non-loopback
 * target; unlimited for a loopback target the user typed (their own machine).
 * `--max-rps` lowers freely and raises only up to 50.
 */

export const DEFAULT_REMOTE_RPS = 5;
export const MAX_RPS = 50;

export class RateLimiter {
  private tokens: number;
  private last: number;

  /** `rps <= 0` disables the limiter. `burst` defaults to one second's worth (min 1). */
  constructor(
    readonly rps: number,
    private readonly now: () => number = () => performance.now(),
    readonly burst = Math.max(1, Math.floor(rps)),
  ) {
    this.tokens = this.burst;
    this.last = this.now();
  }

  /** Milliseconds to wait before the next request may go out (and reserve it). */
  reserve(): number {
    if (this.rps <= 0) return 0;
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rps);
    this.last = t;
    this.tokens -= 1;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.rps) * 1000);
  }

  async take(): Promise<void> {
    const wait = this.reserve();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

export function effectiveRps(requested: number | undefined, loopback: boolean): number {
  if (requested === undefined) return loopback ? 0 : DEFAULT_REMOTE_RPS;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error('--max-rps must be a positive number');
  return Math.min(requested, MAX_RPS);
}
