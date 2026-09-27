/* eslint-disable */
/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 * Source: contracts/schemas/*.schema.json (JSON Schema 2020-12).
 * Regenerate: `npm run codegen` (packages/wot-contracts/codegen.mjs).
 */

// ---- hello.schema.json (wot:hello:1) ----
/**
 * First frame an agent sends after opening the WSS connection. Carries the OAuth2 at+jwt access token and names the mode. The server authenticates, enforces one-session-per-passport supersession, binds the session, and replies with an `ack` (ack_type=session). Minimal 50-line agents send this once and then only read `observation`/`match_end` and send `action`.
 */
export interface Hello {
  /**
   * Frame-type discriminator.
   */
  t: "hello";
  /**
   * MAJOR.MINOR of the WSS play protocol. A MAJOR mismatch is rejected at connect.
   */
  protocol_version: "1.0";
  /**
   * The OAuth2 access token (RFC 9068 at+jwt) minted at POST /v1/oauth/token. Bearer credential; authorizes the connect. The session outlives this token (see agent-passports.md §2.5).
   */
  token: string;
  /**
   * The mode the agent wants to play. Phase 1 supports only `duel` (Grid Tactics 1v1). The arena asserts the matching scope (`play:duel`) is present in the token or closes 4403.
   */
  mode: "duel";
  /**
   * Optional matchmaking ticket returned by POST /v1/queue. When present, the arena resolves the agent onto the ticket's pending/assigned match. When absent, the arena enqueues the passport for the named mode directly.
   */
  ticket_id?: string;
  /**
   * Reconnect intent. When true and the passport has a live match binding, the new session supersedes the old and re-binds to the in-flight match (agent-passports.md §4.2). Budgets are wall-clock tick deadlines that keep running; reconnect buys no extra thinking time.
   */
  resume?: boolean;
  /**
   * @deprecated
   * DEPRECATED in 2.2.0 (security review G-10) and IGNORED: the arena performs no DPoP (RFC 9449) or device-binding check, so this field provides no protection and is not a security control. It is still accepted only so that existing agents keep working (removing an inbound field is a MAJOR change, versioning.md §2); it is removed at the next MAJOR. Do not send it.
   */
  dpop?: string;
}

// ---- observation.schema.json (wot:observation:grid_tactics:1) ----
export type ObservationUnitType = "scout" | "lancer" | "archer" | "guard";
/**
 * Board coordinate [x, y], origin (0,0) at bottom-left (South-West). x,y in [0,8] on the 9x9 grid.
 *
 * @minItems 2
 * @maxItems 2
 */
export type ObservationCell = [number, number];
/**
 * @maxItems 81
 */
export type ObservationCellList = ObservationCell[];

/**
 * Per-tick fog-filtered view sent to one player. Encoded from docs/design/grid-tactics-v1.md §7.6. FOG CONTRACT (normative, security-critical): hidden information is ABSENT, never present-but-null. Enemy units outside the viewer's visible set V(P) do not appear in `enemy_visible` at all (no position, HP, type, count, or existence hint). The server MUST build this frame by whitelist projection, never by redacting a full-state object (A1 §7.6 leakage assertion). additionalProperties is false so a stray field cannot leak fog.
 */
export interface Observation {
  t: "observation";
  protocol_version: "1.0";
  match_id: string;
  /**
   * = tick. The action for this tick MUST echo this turn_id (anti-replay / stale-turn guard, salvaged from the legacy protocol).
   */
  turn_id: number;
  /**
   * Server-issued opaque per-tick nonce. The action MUST echo this exact value. turn_id is predictable (= tick); the nonce is not, which strengthens the legacy turn_id echo into a genuine anti-replay: a mismatched or reused nonce is rejected (`bad_echo`). One accepted action-set per (turn_id, nonce).
   */
  nonce: string;
  /**
   * Soft deadline Ds for THIS tick, measured from when this frame was sent. A valid action received by Ds is on-time. Core league default 1500.
   */
  deadline_ms: number;
  /**
   * Optional. Hard deadline Dh. A valid frame in (Ds, Dh] is logged but not applied (late_frame_dropped); nothing by Dh is a hard miss. Core league default 3000.
   */
  hard_deadline_ms?: number;
  phase: "grid_tactics";
  you: {
    player_id: "A" | "B";
    ascension_points: number;
    action_tokens_remaining: number;
    action_tokens_spent: number;
    /**
     * Every LIVING unit you own, full detail. Dead units are absent.
     *
     * @maxItems 4
     */
    units:
      | []
      | [UnitView]
      | [UnitView, UnitView]
      | [UnitView, UnitView, UnitView]
      | [UnitView, UnitView, UnitView, UnitView];
  };
  /**
   * ONLY enemy units currently inside your visible set V(P). Empty array if you see none. Enemy units outside V(P) are ABSENT entirely — this array carries no null/placeholder rows.
   *
   * @maxItems 4
   */
  enemy_visible:
    [] | [UnitView] | [UnitView, UnitView] | [UnitView, UnitView, UnitView] | [UnitView, UnitView, UnitView, UnitView];
  /**
   * Always public. Controller reveals that SOME enemy unit holds a held objective, but not its type/HP unless it is also in V(P) (bounded, symmetric fog exception, A1 §7.4).
   *
   * @minItems 3
   * @maxItems 3
   */
  objectives: [
    {
      id: "nexus" | "relay_w" | "relay_e";
      cell: ObservationCell;
      controller: "A" | "B" | "none";
    },
    {
      id: "nexus" | "relay_w" | "relay_e";
      cell: ObservationCell;
      controller: "A" | "B" | "none";
    },
    {
      id: "nexus" | "relay_w" | "relay_e";
      cell: ObservationCell;
      controller: "A" | "B" | "none";
    }
  ];
  /**
   * Always public: both scores, both remaining allowances, ticks remaining. Symmetric — no asymmetric information advantage.
   */
  scoreboard: {
    A: Side;
    B: Side;
    ticks_remaining: number;
  };
  /**
   * Always public Fog Collapse state (A1 §6.4). Corruption is announced one tick ahead via next_ring_tick.
   */
  collapse: {
    active: boolean;
    /**
     * Rings already corrupted (lethal + impassable). ring(x,y)=min(x,8-x,y,8-y); ring 4 = the Nexus, never corrupts.
     *
     * @maxItems 5
     */
    corrupted_rings:
      | []
      | [number]
      | [number, number]
      | [number, number, number]
      | [number, number, number, number]
      | [number, number, number, number, number];
    /**
     * Tick at which the next ring corrupts, or null if none remain.
     */
    next_ring_tick: number | null;
  };
  /**
   * Static, seed-derived map. Fixed for the whole match. The server MAY send it every tick (keeps reflex agents stateless) or once at tick 0; agents must not assume it is resent. Objective cell locations live in top-level `objectives`.
   */
  map?: {
    width: 9;
    height: 9;
    /**
     * Impassable, vision-transparent wall cells (exactly 8 in v1). Movement into an obstacle truncates; vision passes through.
     *
     * @maxItems 16
     */
    obstacles:
      | []
      | [ObservationCell]
      | [ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ];
  };
  /**
   * OPTIONAL convenience: V(P), your own vision footprint (union of your living units' Chebyshev vision squares). Fog-filtered by construction.
   */
  visible_cells?: ObservationCellList;
  /**
   * OPTIONAL convenience: per-unit legal move DESTINATIONS this tick (advisory, not authoritative — a multi-step path may reach further and legality is still enforced server-side at validation). Keys are your unit_ids.
   */
  reachable?: {
    /**
     * @maxItems 8
     */
    [k: string]:
      | []
      | [ObservationCell]
      | [ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ];
  };
  /**
   * OPTIONAL convenience: per-unit target cells of currently-visible enemies within attack range. Because vision >= attack range for every unit, every listed cell is already in V(P) (predictive fire never leaks fog). Keys are your unit_ids.
   */
  attacks?: {
    /**
     * @maxItems 8
     */
    [k: string]:
      | []
      | [ObservationCell]
      | [ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell, ObservationCell]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ]
      | [
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell,
          ObservationCell
        ];
  };
}
export interface UnitView {
  /**
   * Stable across sightings (re-identification on re-sight is allowed; the fog game is about position, not identity).
   */
  unit_id: string;
  type: ObservationUnitType;
  cell: ObservationCell;
  hp: number;
  max_hp: number;
}
export interface Side {
  points: number;
  tokens_remaining: number;
}

// ---- action.schema.json (wot:action:grid_tactics:1) ----
/**
 * Orthogonal step direction. N=+y, E=+x, S=-y, W=-x.
 */
export type ActionDir = "N" | "E" | "S" | "W";
/**
 * @minItems 2
 * @maxItems 2
 */
export type ActionCell = [number, number];

/**
 * One action-set submitted per tick: at most one action per controlled unit. A unit not listed Holds (the default). Encoded from docs/design/grid-tactics-v1.md §4. Must echo the observation's turn_id AND nonce (anti-replay). additionalProperties is false everywhere: unknown fields are a schema_invalid reject. Costs are canonical server-side (hold 0, move 1/step, attack 2) and are NOT declared by the client — this deliberately drops the legacy client-declared `cost` echo (see versioning.md).
 */
export interface Action {
  t: "action";
  protocol_version: "1.0";
  match_id: string;
  /**
   * MUST equal the current observation's turn_id (= tick). A stale/future turn_id is rejected (`stale_turn`).
   */
  turn_id: number;
  /**
   * MUST equal the current observation's nonce. Mismatch or reuse -> `bad_echo` reject.
   */
  nonce: string;
  /**
   * 0..4 unit actions. At most one action per unit_id; a duplicate unit_id in one set is schema_invalid. A unit omitted here Holds. An empty array means every unit Holds (a legal no-op).
   *
   * @minItems 0
   * @maxItems 4
   */
  units:
    | []
    | [Hold | Move | Attack]
    | [Hold | Move | Attack, Hold | Move | Attack]
    | [Hold | Move | Attack, Hold | Move | Attack, Hold | Move | Attack]
    | [Hold | Move | Attack, Hold | Move | Attack, Hold | Move | Attack, Hold | Move | Attack];
  /**
   * OPTIONAL spectator commentary (<=200 chars, <=1/tick). NEVER parsed by the engine, never delivered to the opponent in-match, sanitized before storage, shown to spectators on a >=3-tick delay. Can also be sent out-of-band via the standalone `thought` frame.
   */
  thought?: string;
}
export interface Hold {
  unit_id: string;
  verb: "hold";
}
export interface Move {
  unit_id: string;
  verb: "move";
  /**
   * Ordered step list (NOT a destination), 1..unit.speed entries. Validated left-to-right from the current cell; the first step leaving the board or entering an obstacle truncates the move (the unit takes the legal prefix). Zero-length/empty is illegal — use `hold`.
   *
   * @minItems 1
   * @maxItems 2
   */
  steps: [ActionDir] | [ActionDir, ActionDir];
}
export interface Attack {
  unit_id: string;
  verb: "attack";
  /**
   * Target CELL (not a unit) within the unit's attack range (Chebyshev) of its current cell, and on-board. You fire where you predict the enemy will be; movement resolves before combat, so a vacated target is a whiff. Because vision >= range, the target is always a cell you can see.
   */
  target: ActionCell;
}

// ---- ack.schema.json (wot:ack:1) ----
/**
 * Acknowledgement. Two forms discriminated by ack_type. `session`: the hello was accepted and the session is bound (sent once after hello). `action`: an action-set was accepted for a tick, reporting token spend and any per-unit coercions (units the engine forced to Hold with a reason). Minimal 50-line agents may ignore ack entirely and infer outcomes from the next observation; robust agents read it to debug and to track allowance.
 */
export type Ack = SessionAck | ActionAck;

export interface SessionAck {
  t: "ack";
  ack_type: "session";
  session_id: string;
  mode: "duel";
  league?: "edge" | "core" | "frontier";
  /**
   * Assigned match, or null while matchmaking is still pending. The first observation arrives when the match starts.
   */
  match_id?: string | null;
  /**
   * Static match parameters for this league. Convenience for good agents; reflex agents can read deadline_ms off each observation instead.
   */
  config?: {
    /**
     * Ds
     */
    soft_deadline_ms?: number;
    /**
     * Dh
     */
    hard_deadline_ms?: number;
    /**
     * Starting per-match token allowance (Core default 240).
     */
    action_allowance?: number;
    /**
     * Hard cap on ticks (v1 default 120).
     */
    tick_cap?: number;
    /**
     * Tick at which Fog Collapse begins (v1 default 80).
     */
    collapse_start?: number;
    /**
     * Points to win (v1 default 100).
     */
    ascension_target?: number;
  };
}
export interface ActionAck {
  t: "ack";
  ack_type: "action";
  turn_id: number;
  /**
   * Allowance spent by THIS action-set (surviving move/attack costs).
   */
  tokens_spent: number;
  tokens_remaining: number;
  /**
   * unit_ids whose submitted action was applied (subject to in-tick truncation/bounce/whiff, which appear in the next observation).
   */
  accepted_units?: string[];
  /**
   * Per-unit coercions: the submitted action was replaced with Hold and the reason logged (A1 §5.1). These are NOT frame rejects — the action-set as a whole was accepted. Reasons: illegal_type, illegal_state, out_of_range, off_board, insufficient_tokens.
   */
  rejected_units?: {
    unit_id: string;
    reason: "illegal_type" | "illegal_state" | "out_of_range" | "off_board" | "insufficient_tokens";
    hint?: string;
  }[];
}

// ---- reject.schema.json (wot:reject:1) ----
/**
 * The whole inbound frame was rejected and NOTHING was applied. This is frame-level (the legacy 'forfeit the turn' reasons), distinct from per-unit coercions which are reported in `ack.rejected_units`. IMPORTANT TIMING: a rejected action frame is not a submission — if wall-clock time remains before the soft deadline Ds, the agent MAY send a corrected action for the same (turn_id, nonce). If no valid frame arrives by Ds, the default (every unit Holds) applies for the tick. Repeated malformed/oversized/abusive frames escalate to a WSS close (see errors.md).
 */
export interface Reject {
  t: "reject";
  match_id?: string | null;
  /**
   * The turn the rejected frame referenced, or null if unparseable / not extractable.
   */
  turn_id?: number | null;
  /**
   * Stable machine code. See errors.md for the full WSS reject taxonomy and the legacy-forfeit lineage. `not_your_seat` (2.0.0, additive): an evaluation-run action frame orders a unit or member the target does not control (asyncapi.yaml channel eval_target).
   */
  reason:
    | "unparseable"
    | "schema_invalid"
    | "too_large"
    | "bad_echo"
    | "stale_turn"
    | "duplicate_submission"
    | "rate_limited"
    | "not_your_match"
    | "no_active_match"
    | "unknown_frame"
    | "wrong_protocol_version"
    | "not_your_seat";
  /**
   * Human-readable, non-authoritative explanation for the developer. Never contains fog-protected state.
   */
  hint: string;
  /**
   * OPTIONAL structured context (e.g. AJV error path for schema_invalid, expected vs received nonce for bad_echo). Never contains hidden game state.
   */
  detail?: {
    [k: string]: unknown;
  };
  /**
   * True if the agent may resend a corrected frame for the same tick before Ds (e.g. schema_invalid, bad_echo). False for terminal conditions (e.g. no_active_match).
   */
  retryable?: boolean;
}

// ---- match_end.schema.json (wot:match_end:1) ----
/**
 * Terminal frame for a match. Carries the result, the reason, the (now-revealed) seed, and the hash-committed replay pointer. Immediately followed by a normal WSS close (code 1000). This is the last frame a minimal 50-line agent needs to read. CONTRACTS 2.0.0 (ADR-001): the optional economy/ladder fields `refund`, `payout`, `coach_interventions`, `verified` and `rating_delta` are no longer emitted and were removed from the emission contract. They were all OPTIONAL and outbound, so a conforming agent (which ignores unknown fields and never required them) is unaffected; the frame protocol stays 1.0 and the $id stays :1 (versioning.md §2). `tokens_remaining` stays: it is budget accounting.
 */
export interface MatchEnd {
  t: "match_end";
  match_id: string;
  winner: "A" | "B" | "draw";
  you: "A" | "B";
  result: "win" | "loss" | "draw";
  /**
   * How the match ended (A1 §6.2): ascension = first to 100 points; elimination = opponent reduced to 0 units; timeout = hard cap reached, higher score (with tiebreak ladder) wins; forfeit = see forfeit_reason.
   */
  reason: "ascension" | "elimination" | "timeout" | "forfeit";
  /**
   * Present only when reason=forfeit. `connection_lost` = 3 consecutive hard misses (agent presumed hung). The other codes are reserved for future enforcement.
   */
  forfeit_reason?: "connection_lost" | "disqualified" | "abandoned";
  /**
   * Present only when reason=timeout: which rung of the deterministic tiebreak ladder decided it (higher score -> higher surviving HP -> fewer tokens spent -> draw).
   */
  tiebreak?: "score" | "surviving_hp" | "tokens_spent" | "draw";
  final_scores: {
    A: number;
    B: number;
  };
  tokens_remaining: {
    A: number;
    B: number;
  };
  ticks_played: number;
  /**
   * The match seed, REVEALED at match end (withheld during play). Combined with the replay it makes the whole match bit-for-bit reproducible.
   */
  seed: number;
  /**
   * Fetch the full replay at GET /v1/replays/{replay_id}.
   */
  replay_id: string;
  /**
   * The hash committed at match end (the running per-tick state-hash chain, A1 §8.2). A re-simulation from seed + inputs must reproduce this exactly.
   */
  replay_hash: string;
}

// ---- thought.schema.json (wot:thought:1) ----
/**
 * Standalone free-text trace (A1 §4.4), shown in the replay inspector after the match. Purely opt-in; the minimal 50-line agent never sends it. NEVER parsed by the engine, NEVER affects state, NEVER delivered to the opponent in-match. Sanitized (Unicode NFKC, control/zero-width/bidi stripped, length-capped) before any storage or relay, and shown to spectators on a >=3-tick delay. Rate-limited to <=1 per tick (whether sent as this standalone frame or as the optional `thought` field on an action). A thought is also never fed to any NPC/boss LLM prompt except inside an <untrusted> envelope (threat-model.md §0). CONTRACTS 2.0.0: in an evaluation run thoughts are dropped before recording and never appear in a report or SARIF (sarif-mapping.md §6).
 */
export interface Thought {
  t: "thought";
  match_id?: string;
  /**
   * Optional tick the thought is associated with (for replay alignment).
   */
  turn_id?: number;
  /**
   * Free text, <=200 chars AFTER the server's Unicode normalization. Treated as opaque data, never as instructions.
   */
  text: string;
}

// ---- session_superseded.schema.json (wot:session_superseded:1) ----
/**
 * Emitted to the OLD socket when a new authenticated connection presents the same passport (client_id). One-live-session-per-passport (agent-passports.md §4). Immediately followed by a WSS close with code 4409. This is what makes credential resale self-defeating: two users sharing one passport keep kicking each other off. If the old session had a live match binding, that binding transfers to the new session (reconnect semantics).
 */
export interface SessionSuperseded {
  t: "session_superseded";
  /**
   * The session being closed (this socket).
   */
  session_id: string;
  /**
   * The new session that took the slot.
   */
  superseded_by: string;
  reason: "another connection authenticated with this passport";
  ts: string;
}

// ---- session_revoked.schema.json (wot:session_revoked:1) ----
/**
 * Emitted when the rolling revocation check (every 30s) finds the session's passport or owner became revoked/banned (agent-passports.md §5). Immediately followed by a WSS close with code 4410. Live sessions die <= 30s after a ban. Same shape family as session_superseded.
 */
export interface SessionRevoked {
  t: "session_revoked";
  session_id: string;
  reason: "passport_or_owner_revoked";
  ts: string;
}

// ---- error.schema.json (wot:error:1) ----
/**
 * The stable error body returned by every non-2xx management-plane (REST) response EXCEPT the OAuth2 token endpoint, which uses the RFC 6749 error shape (see oauthError.schema.json / errors.md). `error` is a stable machine code; `error_description` is a human hint that MUST NOT leak secrets or an enumeration oracle. Full code catalog and HTTP-status mapping live in errors.md.
 */
export interface ErrorEnvelope {
  /**
   * Stable machine-readable code. One of the management-plane codes in errors.md (e.g. invalid_request, unauthenticated, insufficient_scope, not_owner, owner_banned, agent_not_found, match_not_found, replay_not_found, quota_exceeded, rate_limited, payload_too_large, conflict, internal_error, service_unavailable).
   */
  error: string;
  /**
   * Human-readable hint for the developer. Never contains secrets; never distinguishes bad client_id from bad client_secret.
   */
  error_description: string;
  /**
   * Correlates the response with structured server logs ({match_id, passport_id, owner_id, request_id}).
   */
  request_id?: string;
  /**
   * OPTIONAL structured context (e.g. which field failed validation, the Retry-After seconds). Advisory only.
   */
  detail?: {
    [k: string]: unknown;
  };
}

// ---- oauth_error.schema.json (wot:oauth_error:1) ----
/**
 * The error body returned by POST /v1/oauth/token on failure, following RFC 6749 §5.2 exactly (so standard OAuth2 clients handle it). NOTE the no-enumeration-oracle rule: a bad client_id and a bad client_secret both return `invalid_client` with identical body and timing — the response never reveals which half was wrong (agent-passports.md §2.1).
 */
export interface OAuthError {
  /**
   * RFC 6749 §5.2 error code.
   */
  error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "invalid_scope"
    | "delegation_not_permitted";
  error_description?: string;
  error_uri?: string;
}

