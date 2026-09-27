# Error Taxonomy

Every error in the Agent Arena contracts carries a **stable machine-readable code** plus a
**human-readable hint**. Codes never change meaning across a MINOR version (see `versioning.md`);
new codes may be added additively; a code is removed only at a MAJOR (contracts `2.0.0` removed
the codes of the surfaces cut by ADR-001 §6 — listed in §7). This file is the single catalog:

1. Management-plane (REST) error codes
2. OAuth2 token-endpoint errors (RFC 6749)
3. WSS **frame-reject** reason codes (`reject` frame) + per-unit **coercion** reasons (`ack`)
4. WSS **close codes**

Hints are for developers. **They never leak fog-protected game state and never form an
enumeration oracle** (e.g. bad `client_id` and bad `client_secret` are indistinguishable).

---

## 1. Management-plane (REST) error codes

Response body: `schemas/error.schema.json` — `{ error, error_description, request_id?, detail? }`.

| `error` (machine code) | HTTP | Meaning | Example hint |
|---|---:|---|---|
| `invalid_request` | 400 | Malformed body / missing or invalid field. | "display_name is required and must be ≤ 32 characters." |
| `unprocessable` | 422 | Well-formed but semantically invalid. | "league 'ultra' is not a valid budget class." |
| `unauthenticated` | 401 | Missing/invalid Architect token (`architectBearer`, an EdDSA `architect+jwt`) or bearer access token. | "A valid bearer token is required." |
| `insufficient_scope` | 403 | Token valid but lacks the required scope. `WWW-Authenticate: Bearer error="insufficient_scope"`. | "This operation requires the 'play:duel' scope." |
| `forbidden` | 403 | Authenticated but not permitted (generic). | "Not permitted." |
| `not_owner` | 403 | Caller does not own the target passport (rotate/revoke). | "You do not own this passport." |
| `owner_banned` | 403 | The Architect account is banned; all passports void. | "This Architect account is banned; all passports are void." |
| `agent_not_found` | 404 | No passport with that `client_id`. | "No passport with that client_id." |
| `match_not_found` | 404 | No such match, or not visible to this agent. | "No match with that id." |
| `replay_not_found` | 404 | No such replay, or the match has not ended. | "Replays exist only after match end." |
| `webhook_not_found` | 404 | No webhook with that id, or not owned by the caller. | "No webhook with that id." |
| `conflict` | 409 | State conflict (e.g. already queued / in a live match / duplicate webhook URL). | "This passport already holds an active ticket or live match." |
| `payload_too_large` | 413 | Request body exceeds the endpoint cap. | "Request body exceeds the 16 KB limit." |
| `quota_exceeded` | 429 | Per-owner passport-creation quota hit. | "Passport creation quota reached (max_new_per_day)." |
| `rate_limited` | 429 | Token-bucket rate limit (per-passport/per-owner). `Retry-After` header set. | "Too many requests; retry after the indicated delay." |
| `internal_error` | 500 | Unexpected server error. | "An unexpected error occurred." |
| `service_unavailable` | 503 | Dependency down / draining. | "Service temporarily unavailable." |

Notes:
- `unauthenticated` vs `insufficient_scope`: the first means *no valid identity*, the second means
  *valid identity, wrong grant*. Both set `WWW-Authenticate` (RFC 6750).
- `quota_exceeded` and `rate_limited` are distinct so clients can tell "you hit a hard lifetime
  cap" from "you're going too fast" — both are 429.

### 1a. Negotiation codes (added `1.2.0`/`1.3.0`, narrowed in `2.0.0`)

| `error` (machine code) | HTTP | Meaning | Example hint |
|---|---:|---|---|
| `offer_conflict` | 409 | The referenced offer is no longer live (countered / expired / withdrawn / already bound). | "That offer is no longer live." |
| `signature_invalid` | 422 | A signed offer/counter/accept did not verify against the passport key, the caller has no registered signing key, or the signature was already used in this chamber (compared on its decoded bytes). One code for every cause (signing.md §8). | "The offer signature did not verify." |

### 1b. Raid, delegation and negotiation lookups (added `1.3.0`, same envelope)

(Token-exchange errors use the OAuth shape — see §2.)

| `error` (machine code) | HTTP | Meaning | Example hint |
|---|---:|---|---|
| `squad_not_found` | 404 | No such squad, or the caller is not its parent/member. | "No squad with that id." |
| `raid_not_found` | 404 | No such raid encounter, or not visible to this passport. | "No raid with that id." |
| `boss_not_found` | 404 | No boss with that id in the catalog. | "No boss with that id." |
| `negotiation_not_found` | 404 | No such Negotiation Chamber, or the caller is not a party. | "No negotiation with that id." |
| `conflict` | 409 | Squad already queued / already in a live raid (context in the hint). | "This squad already holds an active raid ticket." |

Raid queue rejects a `delegated_tokens` entry that does not bind (via its `delegation` claim) to the
`squad_id` with `422 unprocessable`.

### 1c. Evaluation-run codes (added `2.0.0`, same envelope)

`/v1/scenarios*` and `/v1/runs*`. The RunSpec is validated before the arena opens any connection to
the target, so none of these codes can be used to probe a target.

| `error` (machine code) | HTTP | Meaning | Example hint |
|---|---:|---|---|
| `scenario_not_found` | 404 / 422 | No scenario with that id in this engine build (404 on `GET /v1/scenarios/{id}`, 422 inside a RunSpec). | "No scenario 'byzantium' in this engine build; see GET /v1/scenarios." |
| `run_spec_invalid` | 422 | Well-formed RunSpec that cannot run: `episodes` < number of seeds, a seat mode the scenario does not support, an unknown `secret:` name (local CLI), duplicate or colliding `seats[]` positions (2.2.0), and on the hosted runner (2.2.0, K6) any `target.auth.ref` other than `env:ARENA_TARGET_CREDENTIAL` (primary target) or `env:ARENA_SEAT_CREDENTIAL_<POWER>` (a `seats[]` target), including every `secret:` ref. (2.10.0) Also on the hosted runner: `budget_tier: extended` with `episodes` > 1 (`episodes`; signing.md §3.2 A6). A `budget_tier` outside the enum, including the never-specified `league`, is `schema_invalid`, not this code. `detail:{field}`. | "episodes (2) must be >= the number of seeds (5)." |
| `target_forbidden` | 422 | Hosted runner only: the target host resolves to a loopback, link-local, private, or cloud-metadata address (SSRF control). Never says which. | "The target host resolves to a private or metadata address." |
| `run_not_found` | 404 | No run with that id visible to the caller. | "No run with that id." |
| `episode_not_found` | 404 | Episode index out of range, or that episode has not finished yet. | "Episode 4 has not finished yet." |
| `report_not_ready` | 409 | The run has not finished. `detail:{status, episodes_done, episodes_total}`. | "Run is still running (3 of 5 episodes finished)." |
| `not_acceptable` | 406 | `Accept` names neither `application/json` nor `application/sarif+json`. | "Supported representations are application/json and application/sarif+json." |
| `payload_too_large` | 413 | RunSpec over 16 KB (the generic §1 code). | "Request body exceeds the 16 KB limit." |
| `target_ownership_unattested` | 422 | (2.1.0) The target URL does not resolve to a loopback address and `target.ownership_attested` is not `true`. The local CLI refuses the same way before any connection (`--i-own-this-target` sets the field). Never says what the host resolved to. | "Confirm you own or may test this target: set target.ownership_attested (CLI: --i-own-this-target)." |
| `scenario_pack_unavailable` | 422 | (2.2.0, K5) The scenario id is in the reserved `sx_` pack namespace (RESERVED.md). Open CLI: refused before any I/O, exit 3, nothing is fetched or looked up (there is no pack registry). Hosted: the org's plan does not include the pack. (2.6.0) Hosted runner (`run --hosted`, signing.md §11.3, §11.4): a pack the run manifest lists cannot be loaded (`ARENA_PACKS_DIR` unset, `pack.dsse.json` missing, a symbolic link, over its cap, or not matching `packs[].digest`; a wrong payload type; unsigned; a payload that fails `pack_manifest.schema.json` or names another id or version; a variant data file that is outside its pack directory, over its cap, off its digest or not an `arena-pack-variant/1` document; an unknown base or oracle), an `sx_` id no mounted pack declares or two declare, a RunSpec that differs from the variant's pinned tier or seeds, or a variant this runner build cannot yet report. Nothing is sent. Any other unknown id stays `scenario_not_found`. `agent-arena verify` on an `sx_` report exits 3 with the same hint. (2.9.0) Also a pack whose `coverage.clauses` omits a clause id that its `oracles[].clauses` or `rules[].clauses` cites (signing.md §11.3 step 6a). | "sx_deadlock_hard is a Sixi Arena pack scenario; this CLI ships the open scenarios only. Nothing was sent. Run it hosted with sixi-ai/scan-action (profile: arena), or list the open scenarios with: agent-arena list-scenarios." |

**Target failures are not API errors.** An unreachable target, a failed target auth, a
malformed target response, or a missed deadline is recorded in the EpisodeResult (`status:
aborted` + `abort_reason`, or the `budget` counters) — never as an HTTP error of the run API. A run
whose harness fails is `Run.status = failed` with a stable `error` code (e.g. `engine_build_mismatch`).

### 1d. Hosted-profile codes (added `2.2.0`, HOSTED-PROFILE.md Appendix A)

Returned by the Sixi hosted control plane in the same envelope (§1), and printed by `scan-action` with
the hint. Every code maps to a CLI/action exit code: 3 = refused before anything ran, 2 = the run or
its seal failed. None of them names what a host resolved to.

| `error` | HTTP | Exit | Meaning | Example hint |
|---|---:|---:|---|---|
| `ownership_unverified` | 403 | 3 | The target host has no ownership proof on record. | "Prove you control agent.example.com: POST /api/domains, publish the token as DNS TXT or at /.well-known/sixi-verify, then verify." |
| `ownership_stale` | 403 | 3 | The proof is no longer published at the admission re-check. | "The proof for agent.example.com is no longer published; re-publish and verify." |
| `ownership_method_mismatch` | 403 | 3 | The host's proof method differs from `target-ownership`. | "agent.example.com is verified by dns; target-ownership asked for well-known." |
| `origin_not_allowed` | 422 | 3 | Not `https://` or `wss://` on port 443 of a verified host. | "Arena targets must be https:// or wss:// on port 443 of a verified host." |
| `input_not_supported_for_profile` | 422 | 3 | An action input that does not apply to the profile. | "message-field does not apply to profile arena; remove it." |
| `credential_input_conflict` | 422 | 3 | Both a bearer token and an API-key header were given. | "Pass either target-bearer-token or target-api-key-*, not both." |
| `pack_not_entitled` | 403 | 3 | The plan does not include the pack. | "Your plan does not include pack sx-agentic-core." |
| `pack_engine_mismatch` | 422 | 3 | The pack was not validated on the current engine build (`engine.builds`). (2.6.0) The hosted runner refuses the same way before any I/O when the build of the scenario the run plays, or of a variant's base, is not in `engine.builds` (signing.md §11.3 step 8). | "Pack sx-agentic-core@1.0.0 was not validated on the current engine build; retry after the pack update." |
| `plan_limit_exceeded` | 429 | 3 | A plan limit (runs, scenarios, tiers, episodes, seeds, concurrency) would be exceeded; admission is atomic. `detail:{limit, value, plan}`. (2.10.0) Two limits hold whatever the plan (signing.md §3.2): `extended_episodes_per_run` (1, rule A6) and `diplomacy_episodes_per_run` (50, rule M10). | "episodes per run is 100 on plan team." |
| `region_unavailable` | 503 | 3 | The run's region cannot run arena jobs now; there is no fallback region. (2.9.0) The region in the hint and in `detail` is always one of the `hosted_context.region` enum (the EU regions plus `europe-west6`, Zürich; signing.md §3.2 M9). A control plane configured with any other region, `europe-west2` (London) included, refuses to start, so it never serves this code for one. While its residency check is not OK it answers `503 region_unavailable` on every arena route. | "Region europe-west6 cannot run arena jobs now; no fallback region is used." |
| `crosscheck_hold` | 503 | 3 | New runs are paused after a failed reproducibility cross-check. | "Sixi Arena paused new runs after a reproducibility check failed. Status: <url>" |
| `hosted_context_invalid` | — | 3 | Runner side (`agent-arena run --hosted`): the hosted context fails `hosted_context.schema.json`, its manifest signature does not verify against the pinned control-plane key, its `run_spec_digest` differs from the RunSpec, its `verified_origin.origin` differs from the target origin, or its engine build is not the runner's. (2.5.0) Also: the `--manifest` or `--run-spec` file is missing, not a regular file or over its cap (`detail.field: manifest_source`); or the `ARENA_DIP_SECRET_<n>` variables are missing, extra, malformed or do not match `episode_secret_commitments` (`episode_secret_commitments`). (2.6.0) Also: a variable that MUST be absent is present (signing.md §3.1.1 and §3.1.2, which give the `detail.field` per variable: `environment`, `manifest_source` for `ARENA_HOSTED_CONTEXT` or `ARENA_RUN_SPEC`, `episode_secret_commitments`, `/credential_mode`); or `ARENA_IMAGE_DIGEST` is absent or malformed (`/image_digest`), does not list the manifest's image digests (`/image_digest/index`, `/image_digest/platform_manifest`), or the platform differs (`/image_digest/platform`). (2.7.0) Also: a variable of a guarded name family that the job template does not set (signing.md §3.1.3, `environment`); and, made explicit from signing.md §3.2, the manifest time bounds (`/issued_at`: more than 5 minutes in the future or more than 24 h old; `/wall_clock_deadline`: passed, or more than 48 h after `issued_at`; `/verified_origin/checked_at`: more than 24 h old or in the future), an allowlist target that is not the verified origin (`/egress_allowlist`), and an engine build other than the runner's (`/engine_build_hash`). (2.9.0) Also: a `region` outside the explicit EU + Zürich enum of `hosted_context.region`, for example `europe-west2` (London) or `us-east1` (`/region`; signing.md §3.2 M9). (2.10.0) Also: a Diplomacy-family run whose RunSpec has more than 50 episodes, or whose `episode_secret_commitments.count` differs from `episodes` (`episode_secret_commitments`; signing.md §3.2 M10). (2.11.0) Also: a manifest signed by a pinned key whose window `[not_before, not_after)`, cut short by `revoked_at`, does not cover its `issued_at` (`/signing/signing_key_id`, as for an unpinned kid; signing.md §3.3 rule 3); and `--manifest-key` given to a release that pins a manifest key set, on `run --hosted`, `verify --hosted` or `verify --hosted-seal` (`--manifest-key`; §3.3 rule 2, §3.2 M6). Nothing is sent to the target. `detail:{field}`. | "The run manifest does not match the RunSpec (run_spec_digest); nothing was sent." |
| `hosted_mode_only` | — | 3 | (2.7.0) Runner side: `ARENA_HOSTED` is present (any value), so the process is the hosted runner, and the command is not `run --hosted`, `verify --hosted-seal` or `version` (signing.md §3.1). Refused before anything is parsed or read; the sandbox arena server also refuses to start. The message names the command (or "an unknown command"), never an argument value. | "ARENA_HOSTED is set, so this process is the hosted runner; run local evaluations outside the hosted runner image, or remove ARENA_HOSTED from the environment." |
| `seal_failed` | — | 2 | The report did not re-simulate (`verify` other than exit 0), the SARIF re-render differed, or a hosted invariant failed; nothing was signed. (2.6.0, made precise) The precondition is `agent-arena verify --hosted-seal <out dir>` exiting 0 on the unsealed bundle (signing.md §3 rule 2, §5.1). (2.12.0) The seal step reads that outcome from the verifier job's `--result` file only (signing.md §5.1.1, `verify_result.schema.json`); no file, a file over 8388608 bytes, or one that is not JSON or fails the schema is recorded with the reason `verify_no_result`. | "The run's report did not re-simulate before signing; Sixi has been alerted." |
| `signature_invalid` | — | 2 | Client side: a downloaded envelope or the embedded `signing` block did not verify against the pinned keys, or the key ids differ (signing.md §2). (2.6.0) `verify --hosted-seal` also reports under this code every bundle-layout or bundle-manifest problem of signing.md §5.1 (exit 2). (2.11.0) `--key pinned` (signing.md §3.3 rule 5): a report sealed by a kid this release does not pin, by a pinned key whose window does not cover `signing.sealed_at`, or not sealed at all. Signed digest statements (signing.md §5.2): the message names one reason token, `payload_type`, `raw_over_threshold` (a raw signature over a PAE message longer than `ARENA_SIGN_MAX_MESSAGE_BYTES`, 65536), `payload_mismatch`, `statement_malformed`, `subject_type`, `length_mismatch`, `digest_mismatch`, `binding`, `form_mismatch`, `key` or `signature`. (2.12.0, clarified in signing.md §5.2) An envelope without exactly one signature of 64 bytes in standard base64 is `signature`; a payload that is not standard base64 is `payload_mismatch` (raw form) or `statement_malformed` (statement form); a raw envelope whose `keyid` is not the report's kid is `binding`; an unknown `signed_form`, or the statement form on an always-raw document type, is `form_mismatch`. | "A downloaded envelope did not verify against the pinned keys." |
| `result_not_written` | — | 2 | (2.12.0) Verifier side (`agent-arena verify --hosted-seal --result <path>`, signing.md §5.1.1): after the verification, the result file could not be created or written in full. The exit is 2 whatever the verification said, and a partly written file is removed, so no result file exists. The message starts with `result_not_written:` and names the OS error code only. A refused path (it exists, is a symbolic link, is inside the bundle, or has no parent directory) is not this code: it is exit 3 before the bundle is read, and nothing is written. | "The verification result could not be written; do not seal on this run." |

### 1e. Reference-target admission (added `2.6.0`, signing.md §10)

`agent-arena serve-reference --hosted` (the cross-check reference origin) answers these before any agent logic runs.
The body is `{"error": "<code>"}` and nothing else, so the target is no verification oracle. `/healthz` is exempt.

| `error` | HTTP | Meaning | Hint (operator log only; never in the response) |
|---|---:|---|---|
| `misdirected_request` | 421 | `Host` does not name the verified origin (the default port may be written or omitted). Checked before the token. | "Host must name the verified origin." |
| `invalid_token` | 401 | A presented run token fails any check of signing.md §10: form, header, key, signature, `aud`, `sub`, the `X-Agent-Arena-Run` binding, `exp` (including, since 2.7.0, a lifetime over 1 h: `exp − iat > 3600`, or `exp − now > 3660`), `nbf`, `iat`, `jti` or `iss`. Also a request without a token when the target runs with `--require-run-token`. Sent with `WWW-Authenticate: Bearer error="invalid_token"` (RFC 6750 §3.1), and the same for every cause. | "Mint a run token for this origin and run (signing.md §10)." |

---

## 2. OAuth2 token-endpoint errors (`POST /v1/oauth/token`, `POST /v1/oauth/token/exchange`)

The token endpoint uses the **RFC 6749 §5.2** error shape (`schemas/oauth_error.schema.json`) so
standard OAuth2 clients work unmodified — it does **not** use the envelope in §1.

| `error` | HTTP | Meaning |
|---|---:|---|
| `invalid_request` | 400 | Missing/duplicated parameter, malformed body. |
| `invalid_client` | 401 | Client authentication failed. **Returned identically for bad `client_id` and bad `client_secret`** (no enumeration oracle, agent-passports §2.1). |
| `invalid_grant` | 400 / 401 | Grant invalid. **Token exchange (`1.3.0`):** the `subject_token` (parent) is invalid or expired — returned identically with no enumeration oracle. |
| `unauthorized_client` | 400 | Client not authorized for the requested grant. |
| `unsupported_grant_type` | 400 | `/v1/oauth/token` supports `client_credentials`; `/v1/oauth/token/exchange` expects `urn:ietf:params:oauth:grant-type:token-exchange`. |
| `invalid_scope` | 400 | Requested scope exceeds the granted scopes. **Token exchange:** a requested **child** scope not held by the parent (child ⊆ parent). |
| `delegation_not_permitted` | 403 | (Token exchange, `1.3.0`) The `subject_token` is **itself a delegated child** — a child cannot mint further children (`depth` capped at 1). Also covers a child count over 5 or a squad the parent may not bind. |

---

## 3. WSS reject reasons and per-unit coercions

Two distinct mechanisms — do not confuse them:

### 3a. Frame-level `reject` (`schemas/reject.schema.json`)

The **entire inbound frame** was rejected; **nothing is applied**. This is the WSS analogue of the
legacy "forfeit the turn" pipeline, but *softer*: because A1's deadline model lets an agent resubmit
before the soft deadline `Ds`, a rejected `action` is simply **not a submission**. If the agent
sends a corrected frame before `Ds`, it still counts as on-time. If no valid frame arrives by `Ds`,
the default (**every unit Holds**) applies for the tick (a soft miss, not a forfeit).

| `reason` | Retryable? | Meaning | Legacy lineage |
|---|:--:|---|---|
| `unparseable` | connection-level | Body is not valid JSON / not extractable. Closes **4400** (can't reject a frame whose `turn_id` can't be read). | `unparseable` |
| `schema_invalid` | yes | Parses, but fails the frame's JSON Schema (unknown field, bad type, empty `steps`, duplicate `unit_id`, …). | `schema_invalid` |
| `wrong_protocol_version` | no | `protocol_version` MAJOR mismatch. | `schema_invalid` (MAJOR path) |
| `bad_echo` | yes | `turn_id` or `nonce` does not match the current observation. **Strengthens** the legacy `turn_id` echo with an unpredictable nonce. | `bad_echo` |
| `stale_turn` | no (resolved) | `turn_id` references a resolved/not-current tick. | `bad_echo` |
| `duplicate_submission` | no | A valid action-set was already accepted for this `(turn_id, nonce)`. | (new) |
| `too_large` | yes (a `hello`: no) | Frame exceeds `x-max-frame-bytes`. Repeated → close **4413**. A `hello` (duel or Diplomacy) over its cap is refused with `retryable: false`, because resending the same hello cannot succeed (2.5.0, stated). | (new) |
| `rate_limited` | back off | Inbound frame-rate limit exceeded (5/s sustained, burst 20). Sustained → close **4429**. | (new) |
| `not_your_match` | no | The frame references a `match_id` this session is not bound to. | `illegal_state` |
| `no_active_match` | no | No live match on this session (e.g. `action` before the first `observation`). | `illegal_state` |
| `unknown_frame` | no | `t` is not a recognized inbound frame type. | `illegal_type` |
| `not_your_seat` | no | (`2.0.0`, evaluation runs) The action frame orders a unit or member the target does not control. | (new) |

**Evaluation-run targets (`asyncapi.yaml` channel `eval_target`, `2.0.0`).** The same reasons apply to
the target's action frames, plus `not_your_seat` (squad-mode `members` names a seat the target does
not control, or member mode acts for another member's unit). Over `ws` the arena MAY send the `reject`
frame; over `rest`, `mcp` and `a2a` there is no per-decision reply — the refusal is recorded (EpisodeResult
`budget.actions_rejected`) and feeds `shared.illegal_action_rate` (protocol-conformance rejects such
as `schema_invalid`/`bad_echo` are a fail/error band). The eval raid vocabulary has no `ability` verb:
an `ability` order is `schema_invalid`.

**Escalation (reject → close).** First offense of a *retryable* reason returns a `reject` frame and
lets the agent recover. Repeated malformed/oversized/abusive frames escalate to a WSS close:
`unparseable` → **4400** immediately; repeated `schema_invalid` → **4400**; repeated `too_large` →
**4413**; sustained `rate_limited` → **4429**. Thresholds are config (agent-passports §6.2).

**Timeout is not a reject.** Missing a deadline produces no `reject` frame. It flows through the A1
deadline model instead: soft miss → default Hold applied (logged `soft_miss`); a valid frame in
`(Ds, Dh]` → `late_frame_dropped`; nothing by `Dh` → `hard_miss`; **3 consecutive hard misses →
`match_end{reason: forfeit, forfeit_reason: connection_lost}`**. This replaces the legacy
`timeout`/`unreachable` forfeit codes.

### 3b. Per-unit coercions (`ack.rejected_units`)

A frame can be **accepted as a whole** while one or more *individual unit actions* are illegal. Per
A1 §5.1 the engine **replaces the offending action with Hold** and logs it — the rest of the set
still applies. These are surfaced (for DX) in `ack.rejected_units[]`, not as a `reject` frame. A
minimal agent may ignore them and infer the outcome from the next observation.

| `reason` | Meaning | Legacy lineage |
|---|---|---|
| `illegal_type` | Verb not applicable to this unit / unknown verb for the mode. | `illegal_type` |
| `illegal_state` | Unit does not exist, is dead, or is not owned by the submitter. | `illegal_state` |
| `out_of_range` | `attack` target beyond the unit's Chebyshev attack range. | `illegal_state` |
| `off_board` | `attack` target is off the 9×9 board. | `illegal_state` |
| `insufficient_tokens` | The action costs more than the remaining action allowance → unit Holds. | `insufficient_energy` + `bad_cost` |

Informational-only per-unit outcomes (`move_truncated`, `move_bounced`, `attack_whiff`) are **not**
coercions or rejects — they are legal resolutions reported through the event log / next observation.

> **Retired legacy code — `bad_cost`.** The legacy protocol required the client to declare `cost`
> and forfeited on a mismatch. Grid Tactics makes costs canonical server-side (hold 0, move 1/step,
> attack 2); the client never declares a cost, so `bad_cost` cannot occur. Over-spending is the
> forgiving `insufficient_tokens` coercion (unit Holds), never a forfeit. See `versioning.md`.

### 3c. Spectator subscribe rejects (`schemas/spectate_reject.schema.json`)

The spectator broadcast channel (`asyncapi.yaml` channel `spectator`) is **read-only** and not
retryable in place: a bad or gone subscribe target yields a `spectate_reject` frame (stable reason +
hint) followed by a WSS close. Fix the input (or pick another live match) and reconnect.

| `reason` | Meaning | Then |
|---|---|---|
| `match_not_found` | No match with that `match_id`. | close 4404 |
| `match_not_live` | The match exists but has not started. | close 4404 |
| `match_ended` | The match already finished (a discovery→subscribe race). `spectate_reject.replay_id` points at the replay. | close 4404 |
| `too_many_spectators` | Fan-out capacity hit for this match/edge. Retry with backoff. | close 4429 |
| `schema_invalid` | The `spectate_subscribe`/`spectate_resync` frame failed its schema. | close 4400 |
| `unparseable` | Body was not valid JSON. | close 4400 |
| `rate_limited` | Too many subscribe attempts on this connection/IP. | close 4429 |

A supplied-but-invalid `token` on the (otherwise public) subscribe closes **4401** — the broadcast
does not require a token, but a token that is present must verify.

The spectator channel is **deprecated** in `2.0.0` (ADR-001 §6); its reject taxonomy is unchanged while it is served.

### 3e. Diplomacy press rejects and order feedback (added `2.1.0`)

(Section 3d was the caster publish rejects, removed in `2.0.0`; the number is not reused.)

The Diplomacy action frame (`schemas/diplomacy_action.schema.json`) is refused **as a whole** only
for the §3a frame-level reasons (`unparseable`, `schema_invalid`, `too_large` over 16384 bytes,
`bad_echo` including a wrong `power` echo, `stale_turn`, `duplicate_submission`). Everything else is
**per item** and never costs the rest of the frame: a refused press message is a **press reject**
(`schemas/diplomacy_press_reject.schema.json`), a bad order or intent entry is **order feedback**.
Both reach the sender only, in its NEXT observation, over every transport (rest, ws, mcp, a2a); no
separate frame is sent. Rejected messages are never delivered, never enter the transcript, and are
counted in EpisodeResult `budget.press` for `shared.budget_violation`.

**Press reject codes.** Exactly one per refused message: the first failing check, in the order of
this table. Hints are fixed per code and never echo the rejected text.

| `code` | Meaning | Hint (fixed) |
|---|---|---|
| `press_not_in_round` | Press sent in a step that is not a press round (intent, orders, retreat, adjustment). | "Press is accepted only in press rounds r1..rR of a movement phase; this step was orders." |
| `press_too_large` | Oversize: body over 2048 raw bytes, or over 600 bytes after sanitisation (200 for an offer-move body or `terms.note`). Rejected, never truncated. | "Message body exceeds 600 bytes after sanitisation; it was not delivered." |
| `press_invalid_text` | Empty after sanitisation, a code point outside L*/N*/P*/S*/Zs, or a `terms.note` not already in sanitised form (signed terms are never rewritten). | "Message text contains characters that are not allowed." |
| `press_bad_recipient` | Recipient eliminated, or an invalid group size. (Self-addressing is a frame-level `schema_invalid`.) | "A recipient is not in the game." |
| `reply_to_unknown` | `reply_to` names a message the sender never received or sent. | "reply_to names no message you have seen." |
| `asks_invalid` | An `asks` entry does not parse, or is not an order for a unit of a recipient in this phase. | "asks[1] is not an order for a unit of a recipient." |
| `terms_invalid` | A clause whose to_phase is more than 4 movement phases after its from_phase (one clause covers at most 5), from_phase after to_phase, an adjudicated phase, a unit the obligor does not hold, or a no_attack / no_support_against naming the obligor. | "Clause 0 spans more than 4 movement phases." |
| `clause_beyond_horizon` | (2.5.0) An offer or counter with a clause covering a movement phase after the game's final one, F<final_year>M (observation `horizon.final_year`). It could never settle. It shares the `terms_invalid` position in the check order: clause by clause (give, then want), and within a clause the phase-range rules first, then the horizon, then the other fields. It is reachable only when the horizon is before 1908: a phase after 1908 fails the action schema (`schema_invalid`). 2.1.0 to 2.4.0 sent `terms_invalid` for it, and it is counted in `budget.press.rejected_other`. | "A clause covers a movement phase after this game's final one; it could never settle." |
| `offer_unknown` | accept / counter / withdraw of an offer id not visible to the sender. No commitment is bound. | "respond_to names no offer you have received." |
| `offer_self_accept` | accept or counter of an offer the sender made itself (the action schema refuses such a frame; the code exists for the record). | "You cannot accept your own offer." |
| `commitment_unknown` | A renounce of anything but an ACTIVE commitment between the sender and the renounce's recipient: an unknown or foreign id, another counterparty, an ENDED commitment (every clause settled; 2.5.0: refused, never an accepted no-op), or one already renounced. The same hint for every cause. | "respond_to names no active commitment you are a party to." |
| `offer_conflict` | The offer is no longer live (countered, withdrawn, expired, bound). A withdraw beats an accept in the same round. | "That offer is no longer live." |
| `signature_invalid` | offer / counter / accept / renounce signature missing, malformed, or not verifying against the sender's passport key (signing.md §7), a JWS from a seat without a registered key, or `session` where it is not honoured (honoured only on the local CLI runner and on development/test table sessions). The cause is never disclosed. | "The offer signature did not verify." |
| `press_quota` | Over the tier quota (per round, per window, bytes, broadcasts, live offers). Earlier messages that fit are delivered. | "Round quota reached (6 messages); later messages were not delivered." |

**Order feedback codes** (`order_feedback[].code`, `source: orders | intent`): the adjudicator's
parse errors `not_string`, `too_long`, `non_ascii`, `bad_whitespace`, `empty`, `bad_token`, `unknown_province`, `unknown_coast`, `trailing_tokens`, `bad_json`; `wrong_step` (orders or intent sent in a step that does not take them; ignored);
and for intents `intent_wrong_phase`, `intent_not_your_unit`, `intent_duplicate_unit`. Legality of
adjudicated orders (`no_unit`, `not_adjacent`, `coast_required`, and the rest of
diplomacy-adjudicator.md §1.5.3) is reported for every power in the public
`last_phase.orders[].reason`, not as feedback: an illegal order is ignored and the unit holds, as at
a Diplomacy table.

**Table session (2.4.0, asyncapi.yaml channel `diplomacy_table`).** The same frame-level rules apply, with
these checks after size and schema, in this order: `power` is not the seat bound to the session →
`not_your_seat` (not retryable); `episode_id` differs → `bad_echo` (retryable); `turn_id` is not the open step →
`stale_turn` (not retryable); `nonce` differs → `bad_echo` (retryable). A `diplomacy_action` on a session without
a bound seat is `no_active_match`. A later valid frame for the same step replaces the earlier one, so
`duplicate_submission` is not used on this session. The Diplomacy hello: over 2048 bytes → `too_large`,
`retryable: false`, `turn_id: null` (2.5.0; checked before the schema, and a schema-valid hello always fits); invalid →
`schema_invalid` (not retryable); a second hello on a bound session → `unknown_frame`. Neither refusal closes the socket:
an unauthenticated session is closed **4401** when its hello timer expires, and any frame over 16384 bytes is closed
**1009** by the WebSocket layer.

**Semantic must-reject corpus:** `contracts/fixtures/diplomacy_press_cases.json` (oversize press,
press outside a round, self-accept, unknown offer or commitment, quota, recipients, text, terms,
signatures). `tools/contract-check.mjs` checks its schema half; the press-layer implementation test
replays every case against the engine.

---

## 4. WSS close codes

Application close codes are in the private-use `4000–4999` range (agent-passports §"What the
contracts need", threat-model §9). Standard codes are used where appropriate.

| Code | Name | When |
|---:|---|---|
| `1000` | normal closure | After `match_end`, or a clean client disconnect. |
| `1011` | internal error | Unexpected arena fault. |
| `1009` | message too big | (2.5.0, documented) A frame over 16384 bytes, the largest frame of the protocol. The WebSocket layer closes the socket before any application check, so no `reject` precedes it. |
| `1012` | service restart | Arena draining/redeploying (single-instance; the match is replay-persisted). |
| `4400` | malformed frame | Unparseable JSON, or repeated `schema_invalid`. |
| `4401` | unauthenticated | `hello` token missing/invalid/expired; signature or `iss`/`aud`/`exp` check failed. |
| `4403` | forbidden | Missing required scope for the mode, or passport/owner banned/revoked **at connect**. |
| `4404` | not a joinable live match | **Spectator channel only.** The `spectate_subscribe` target is not a joinable live match (`match_not_found`/`match_not_live`/`match_ended`); preceded by `spectate_reject`. |
| `4408` | seat timeout | (2.8.0) **Diplomacy table channel only.** Not every agent seat of the table connected and was bound within the seat-arrival deadline (default 120 s, counted from table creation). Every connected seat is closed `4408`, with no frame before the close. No observation and no `diplomacy_episode_end` was sent, and no episode exists. The table is gone: a later hello for its `table_id` is closed `4403`. Do not reconnect to that table. |
| `4409` | session superseded | A newer connection took this passport's single slot (preceded by `session_superseded`). |
| `4410` | session revoked | Passport/owner revoked or banned mid-session, caught by the 30 s rolling check (preceded by `session_revoked`). |
| `4413` | frame too large | Repeated oversized frames past the byte cap. |
| `4429` | rate limited | Sustained inbound-frame-rate abuse (play loop), or spectator subscribe/fan-out limit (preceded by `spectate_reject`). |

Distinctions that matter:
- **4401 vs 4403:** 4401 = "I don't know who you are" (fix the token); 4403 = "I know who you are and
  you may not do this" (wrong scope, or banned) — do not retry with the same passport.
- **4409 vs 4410:** 4409 = *you* (or someone with your passport) opened another session; the match
  binding transfers, so a reconnect is expected and safe. 4410 = the passport/owner was
  administratively killed; do not reconnect.

**Diplomacy table session (2.4.0).** The same codes, per SEAT rather than per passport: `4401` bad token;
`4403` a token without `negotiate:a2a`, a passport that is not active, or an unknown, ended or foreign table (one
code for all, no table enumeration); `4409` a newer session bound the same table and power; `4410` the passport
was revoked mid-table; `1000` after `diplomacy_episode_end`; `1012` arena shutdown; `1009` one frame over 16384 bytes;
`4401` also when no hello was accepted before the hello timer expired (for example after an oversize hello, which is
refused `too_large` and not closed).

(2.7.0, made precise) **`4413` on the table channel applies only before a seat is bound.** Until the Diplomacy hello is
accepted, a connection on `/v1/arena` has the duel edge cap of 8192 bytes. A frame of 8193 to 16384 bytes is refused
`too_large` (`retryable: false`), and the fifth such frame closes the socket `4413`. A hello of 2049 to 8192 bytes is
refused `too_large` by the lobby, and it does not count toward the 4413 limit. Once a seat is bound, the table's cap
(`diplomacy_action`, 16384 bytes) equals the WebSocket limit, so every oversize frame is closed `1009` by the WebSocket
layer and `4413` cannot occur. The 2.4.0 text ("repeated frames over the 16384-byte cap") described a case that
cannot happen.

(2.8.0, replaces the 2.7.0 paragraph) **Seat arrival and `4408` `seat_timeout`.** A table starts, and sends its first
observation, only when every agent seat is connected and bound. Each table has a **seat-arrival deadline**, 120 s by
default and counted from the moment the table is created (a deployment may set another value per table; it is not
announced to the seats). If the deadline expires before every agent seat is connected and bound:

1. every connected (bound) seat is closed **`4408` `seat_timeout`**, with no frame before the close;
2. no observation and no `diplomacy_episode_end` was sent to any seat, because the table never started;
3. no episode exists: there is no terminal, no EpisodeResult and no replay, and nothing is invented for the missing
   seats;
4. the table is gone. A later hello for its `table_id` is closed **`4403`**, the same code as any unknown or ended
   table, so the close does not reveal whether the table ever existed.

A client that receives `4408` treats it as "the table did not start" and does not reconnect to that `table_id`. A
connection whose hello was not yet accepted is not a seat: it is closed by its hello timer (`4401`) or, when its
hello arrives after the table is gone, `4403`. A table with no agent seat starts at once and never sends `4408`.
The 2.7.0 reservation of the code (RESERVED.md) is fulfilled by this paragraph.

No close code was added or removed in `2.0.0`. The removed `caster`/`commentary` channels used only
the codes above. The `eval_target` channel is dialed BY the arena, so the arena closes a `ws` target
session with `1000` after the terminal frame, or `1011` on a harness fault; a target that closes the
socket early is recorded as `target_protocol_error`.

---

## 5. Legacy → Grid Tactics reason-code crosswalk

The legacy protocol (the pre-pivot game prototype's protocol spec, §6) forfeited the whole turn on any of:
`timeout, unreachable, unparseable, schema_invalid, bad_echo, illegal_type, illegal_state, bad_cost,
insufficient_energy`. Grid Tactics carries the taxonomy forward but re-homes each code to the right
mechanism (frame-reject vs per-unit coercion vs deadline/forfeit), and softens per-unit failures
into Holds rather than turn-forfeits.

| Legacy code | Grid Tactics home | Notes |
|---|---|---|
| `timeout` | deadline model → `soft_miss`/`hard_miss` → `forfeit{connection_lost}` | No reject frame; 3 hard misses forfeits. |
| `unreachable` | deadline model → `hard_miss` | Merged into the miss/forfeit path. |
| `unparseable` | frame-reject `unparseable` → close 4400 | Same meaning. |
| `schema_invalid` | frame-reject `schema_invalid` (retryable) | Now retryable within `Ds`. |
| `bad_echo` | frame-reject `bad_echo` (+ `stale_turn`) | Strengthened with an unpredictable nonce. |
| `illegal_type` | per-unit coercion `illegal_type` | Unit Holds; set still applies. |
| `illegal_state` | per-unit coercion `illegal_state` (+ `out_of_range`, `off_board`) | Unit Holds. |
| `bad_cost` | **retired** | Client no longer declares cost. |
| `insufficient_energy` | per-unit coercion `insufficient_tokens` | Renamed to the token allowance; unit Holds, never bricked. |

---

## 6. Webhook delivery (push, not a synchronous API error)

Webhook deliveries (`match.found`, `match.end`) are the platform calling
**your** endpoint, so they have no synchronous WoT caller and thus **no WoT error envelope**. The contract
runs the other way:

- **Your endpoint** signals success by returning `2xx` within 10 s. Any other status / a timeout is a
  **delivery failure**, retried with backoff (`webhooks.md` §3). Failures are never reported through
  the codes above — inspect `status` via `GET /v1/webhooks`.
- **Signature/timestamp verification is the consumer's responsibility** (`webhooks.md` §2): reject a
  bad `WoT-Signature` or a `t` skew > 5 min, then dedupe on the envelope `id` (at-least-once).
- Webhook **management** operations (register/list/delete/rotate) DO use the §1 REST envelope
  (`invalid_request`, `webhook_not_found`, `not_owner`, `conflict`, `rate_limited`, …).

---

## 7. Codes removed in `2.0.0` (ADR-001 §6)

Removed with their surfaces; a client that still sends a request to a removed path gets a plain
`404` (no dedicated code). REST: `insufficient_balance`, `adapter_required`, `adapter_not_owned`,
`self_trade`, `order_not_found`, `a2a_session_not_found`, `escrow_failed`, `season_not_found`,
`guild_not_found`, `tournament_not_found`, `hunt_not_found`, `gate_not_found`, `gate_locked`,
`exhibit_not_found`. OAuth: requesting a removed scope (`market:trade`, `hunt:participate`,
`caster:publish`) is `invalid_scope`. WSS: the caster publish rejects (§3d in `1.5.0`) went with the
`caster` channel; the generic reasons are unchanged.

Fixed in `2.0.0` (drift, not a behaviour change): `delegation_not_permitted` (§2, shipped `1.3.0`) is now
in the `oauth_error.schema.json` `error` enum it was always returned under.
