/**
 * Arena runtime configuration + defaults. Deadlines are configurable so tests
 * and the demo can run fast; the Core-league defaults are 1500/3000 ms (A1 §3.2).
 */

export interface DeadlineConfig {
  /** Soft deadline Ds — the tick resolves at the earlier of both-on-time or Ds. */
  softMs: number;
  /** Hard deadline Dh — no valid frame by Dh is a hard miss. */
  hardMs: number;
  /** Backfill wait before a lone waiting session is paired with a house bot. */
  backfillMs: number;
  /** Max time to wait for the first `hello` frame before closing the socket. */
  helloTimeoutMs: number;
  /** Rolling revocation re-check interval (A1 / agent-passports §5.4). */
  revocationIntervalMs: number;
}

export const DEFAULT_DEADLINES: DeadlineConfig = {
  softMs: 1500,
  hardMs: 3000,
  backfillMs: 2000,
  helloTimeoutMs: 10_000,
  revocationIntervalMs: 30_000,
};

/** Consecutive hard misses that forfeit the match (A1 §3.2). */
export const HARD_MISS_FORFEIT = 3;

/**
 * Inbound frame-rate limit (agent-passports §6.2). The wall-clock floor (5/s,
 * burst 20) governs the pre-match / un-prompted phases where a client could
 * flood without being asked. IN a match the arena drives the cadence: each
 * observation it sends CREDITS the session's bucket, so the legitimate
 * one-action-per-observation rhythm is never throttled no matter how fast the
 * tick loop runs, while a client that floods MORE than a few frames per prompt
 * still depletes the bucket and gets rate-limited (a client can never send
 * faster than it is prompted). This fixes the spurious soft/hard misses that a
 * fixed 5/s cap caused in fast matches (tick rate >> 5/s).
 */
export const RATE_PER_SEC = 5;
export const RATE_BURST = 20;
/** Tokens granted to a session each time the arena sends it an observation. */
export const CREDIT_PER_OBSERVATION = 4;

/** Repeated retryable rejects that escalate to a connection close (agent-passports §6.2). */
export const MAX_SCHEMA_INVALID = 5;
export const MAX_TOO_LARGE = 5;

/**
 * Pre-auth connect-storm caps enforced at the WSS upgrade path (SR-2). The arena
 * is the stated trust boundary — it must not assume a load balancer throttles
 * connects. An unauthenticated peer is bounded by (a) a per-IP connect-RATE
 * token bucket (churn), (b) a per-IP concurrency cap (idle-socket hoarding), and
 * (c) a global concurrency cap (single-instance availability). Over-limit
 * upgrades are refused before a session is allocated.
 */
export interface ConnectLimits {
  maxSocketsGlobal: number;
  maxSocketsPerIp: number;
  connectRatePerSec: number;
  connectBurst: number;
}

export const DEFAULT_CONNECT_LIMITS: ConnectLimits = {
  maxSocketsGlobal: 512,
  maxSocketsPerIp: 32,
  connectRatePerSec: 10,
  connectBurst: 20,
};

/** WSS close codes (errors.md §4). */
export const CLOSE = {
  NORMAL: 1000,
  SERVICE_RESTART: 1012,
  MALFORMED: 4400,
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  NOT_LIVE: 4404, // raid channel: the squad has no joinable raid
  /**
   * Diplomacy table only (Phase 9 hardening, O-1): not every agent seat connected within the
   * seat-arrival deadline, so the table was abandoned before its first observation. Pending in
   * contracts/errors.md §4 (api-architect).
   */
  SEAT_TIMEOUT: 4408,
  SUPERSEDED: 4409,
  REVOKED: 4410,
  TOO_LARGE: 4413,
  RATE_LIMITED: 4429,
} as const;

/** The WSS path the arena serves the play loop on. */
export const ARENA_PATH = '/v1/arena';
