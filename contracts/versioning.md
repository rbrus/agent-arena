# Versioning Policy

The contracts in this directory are the **source of truth**; TS types and Python SDK models are
**generated** from them (ADR-000). Handwritten models are contract drift by definition. This policy
says what may change without breaking consumers, what requires a version bump + ADR, and how the
frame `t` / schema-`$id` conventions encode versions.

---

## 1. What "version" means here

Three coordinated version surfaces, all starting at `1.0.0` / `1` / `"1.0"` for Phase 1:

| Surface | Where | Form | Bumps when |
|---|---|---|---|
| **Contract release** | `openapi.yaml` `info.version`, `asyncapi.yaml` `info.version`, `CHANGELOG.md` | SemVer `MAJOR.MINOR.PATCH` | Any change to any file here. |
| **Frame protocol** | `protocol_version` field on WSS frames | `MAJOR.MINOR` (e.g. `"1.0"`) | A wire-visible change to frame semantics. |
| **Schema identity** | JSON Schema `$id` (e.g. `wot:observation:grid_tactics:1`) | trailing integer = MAJOR | A breaking change to that specific frame. |

The REST path prefix `/v1/` tracks the **frame protocol MAJOR** for coarse routing; a MAJOR frame
bump implies a new path prefix (`/v2/`) served alongside `/v1/` during migration.

---

## 2. Breaking vs additive

**Additive (MINOR / PATCH, no break, no ADR required):**
- Adding a new **optional** field to a frame or response.
- Adding a new **event** message or a new **enum value that consumers already ignore-by-default**
  (e.g. a new `reject.reason`, a new `match_end.reason`) — consumers MUST treat unknown reason codes
  as their nearest category and not crash.
- Adding a whole new operation / channel / message.
- Relaxing a constraint (raising a `maxItems`, widening a range).
- Documentation, examples, description edits.

> **Worked example — the `1.1.0` Phase-2 bump is a pure MINOR.** It adds the `spectator` WSS
> channel + its six frames, the public `GET /v1/matches` directory, the `/v1/webhooks*` management
> ops + the outgoing `match.found`/`match.end` webhooks, the `webhook_event`/`shot_list` schemas,
> and **optional** fields on `Replay` (`broadcast_cadence_ms`, per-tick `thoughts`). Every change is
> a new surface or a new optional field — **no** Phase-1 frame, field, scope, or code changed
> meaning, so the 50-line player path is untouched and no ADR is required.

> **Worked example — the `1.2.0` Phase-3 (economy & ladder) bump is also a pure MINOR.** It adds
> whole new REST surfaces (balance/ledger, `/v1/market/*`, `/v1/a2a/*`, `/v1/adapters`,
> `/v1/leagues`, `/v1/season*`, `/v1/leaderboards/{league}`, `/v1/agents/{id}/profile` +
> `/reliability`, `/v1/quests/*`), the additive `market.fill` webhook `oneOf` branch, an optional
> `stake` on `POST /v1/queue`, optional economy fields on the match summary + `Replay`, and — the one
> subtlety — it turns `match_end.payout` from `type: null` into `type: ["object","null"]`. **That is
> a *relaxation*, not a break:** `null` still validates (the casual-match contract is preserved),
> and staked matches now additionally emit the object — exactly the "fill in a reserved placeholder
> shape" additive path (`RESERVED.md`). The new `match_end` fields (`coach_interventions`,
> `verified`, `rating_delta`, `refund.rate_bps`) are all **optional/outbound**, and the new scope
> **`market:trade`** is *granted* (filling a reserved name, §5 rule 4) — no existing scope changed.
> No inbound frame, required field, or reject/close code changed meaning, so the 50-line play loop
> and the spectator broadcast are byte-for-byte untouched and **no ADR is required**. (A hypothetical
> *narrowing* of `payout` back to a single type, or making any of these required, WOULD be MAJOR.)

> **Worked example — the `1.3.0` Phase-4 (multi-agent & social) bump is also a pure MINOR.** It adds a
> whole new **channel** (`raid`, with new frames `raid_hello`/`raid_observation`/`raid_action`/`raid_ack`/
> `raid_end`) and whole new REST surfaces (`/v1/oauth/token/exchange`, `/v1/raids/*`, `/v1/squads/*`,
> `/v1/negotiations/*`, `/v1/guilds/*`, `/v1/tournaments/*`). Every existing surface is untouched: the two
> new scopes **`play:raid`** + **`negotiate:a2a`** are *granted* (filling reserved names), the `LedgerRef.kind`
> enum is only *extended* (adding an enum member is additive — consumers already tolerate unknown members per
> the obligations below), and the optional `guild` field on `LeaderboardEntry` is outbound-optional. Adding a channel/message/operation is inherently additive (§ additive list). No
> existing frame, required field, scope, reject, or close code changed meaning — the duel play loop, the
> spectator broadcast, and every Phase-3 economy surface are byte-for-byte untouched and **no ADR is required**.
> The delegated child token is a normal `at+jwt` with one extra claim (`delegation`) — existing verifiers
> that ignore unknown claims keep working.

> **Worked example — the `1.4.0` Phase-5 (The Great Hunt & capstone) bump is also a pure MINOR.** It adds
> whole new REST surfaces (`/v1/hunt*`, `/v1/matches/{id}/caster/attach`, `/v1/matches/{id}/analytics`,
> `/v1/agents/{id}/analytics`, `/v1/vault/exhibits{,/:id}`), **two whole new WSS channels** (`caster` +
> `commentary`, with new frames `caster_hello`/`caster.say`/`caster_ack`/`commentary_subscribe`/
> `commentary_ack`/`caster_commentary`), an additive **`hunt.clue`** webhook `oneOf` branch, and two newly
> **granted** scopes (**`hunt:participate`** + **`caster:publish`** — filling reserved names, §5 rule 4).
> Every existing surface is untouched: the `WebhookEventType` enum is only *extended*, and adding a
> channel/message/operation/scope is inherently additive (§ additive list). No existing frame, required
> field, scope, reject, or close code changed meaning — the duel play loop, the spectator broadcast, the
> raid loop, and every economy/social surface are byte-for-byte untouched, so **no ADR is required**. The
> caster `commentary` subscribe reuses the existing `spectate_reject` frame and the caster publish channel
> reuses the generic `reject`; both reuse the existing WSS close-code table with **no new code**.

> **Worked example — the `1.5.0` Phase-6 (the Failure Modes pillar) bump is also a pure MINOR.** It adds
> **optional** fields to `BossDescriptor` (`failure_mode_id` the taxonomy key, `robust_pattern`, `lesson`,
> `availability`), one whole new REST operation (`GET /v1/raids/bosses/{boss_id}/records`), and four new inline
> REST schemas (`BossRecords`/`WorldFirstClear`/`FastestClearEntry`/`RaidClearParty`). Every change is a new
> optional field or a whole new operation/schema (§ additive list). **Crucially, the existing required prose
> `failure_mode` field is NOT retyped or renamed** — `failure_mode_id` is added *beside* it as the disambiguated
> taxonomy KEY, so every shipped boss stays valid; `failure_mode_id` is a constrained string (not an enum) so a
> future failure mode is pure DATA. The records endpoint reuses the existing `boss_not_found` response — **no new
> error code, scope, frame, or close code**, and no `asyncapi.yaml` frame changed (the new bosses run on the
> existing `raid` channel; their corrupted-feed / lock / partition mechanics are engine-side observation
> projections, never new wire fields — mirroring The Hallucinator's `suspect` phantom discipline). The duel play
> loop, the spectator broadcast, the raid loop, and every economy/social/capstone surface are byte-for-byte
> untouched, so **no ADR is required**.

> **Worked example — the `2.0.0` pivot (ADR-001) is a MAJOR contract release that leaves the frame
> protocol at `1.0`.** The three version surfaces (§1) move independently, and this release is the first
> to show it:
>
> * **Contract release → `2.0.0` (MAJOR, ADR-001 is the record).** Whole operations, channels, messages,
>   scopes, webhook types and error codes were **removed** (the Great Hunt, the Bazaar + A2A trade escrow,
>   Adapters, the Vault, Coach analytics, the caster/commentary channels, guilds, tournaments, the Golden
>   List/leaderboards/Weights, seasons, quests, balances/ledger, world-first records, the Director's shot
>   list; scopes `market:trade`, `hunt:participate`, `caster:publish`). Removal is breaking by the list
>   below, hence MAJOR + ADR. Negotiation Chambers changed the *meaning* of `give`/`want` (scenario-scoped
>   commitments instead of Tokens + items) and of acceptance (binding instead of escrowed settlement), and
>   `QueueRequest.stake` / `RaidQueueRequest.stake` were removed: REST bodies, also MAJOR.
> * **Frame protocol → stays `1.0`; REST prefix stays `/v1/`.** No inbound frame changed, no required field
>   changed, and no reject reason or close code changed meaning. `match_end` lost the optional outbound
>   fields `refund`, `payout`, `coach_interventions`, `verified`, `rating_delta`, and `raid_end` lost
>   `reward` and `verified`. For the **agent** (the consumer of an outbound frame) that is a narrowing of
>   what the server emits: every new frame validates against the old schema, and an agent that honours
>   the consumer obligations below (ignore unknown fields, never require an optional one) cannot tell.
>   So the `$id`s keep `:1` and `protocol_version` stays `"1.0"`: the 50-line agent is untouched. The
>   break is on the **producer** side (the arena must stop emitting them), which the contract release
>   MAJOR covers.
> * **Additive inside the MAJOR:** the evaluation-run contract (`wot:run_spec:1`, `wot:episode_result:1`,
>   `wot:report:1`, `/v1/scenarios*`, `/v1/runs*`, scope `eval:run`), the `eval_target` channel with its
>   new frames (`wot:observation:eval_raid:1`, `wot:action:eval_raid:1`, `wot:eval_episode_end:1`), the
>   `not_your_seat` reject reason, and `delegation_not_permitted` in the `oauth_error` enum (it was always
>   returned; the enum had drifted).
> * **Deprecated, not removed:** the `spectator` channel and `GET /v1/matches` (the viewer survives only as a
>   replay inspector). Removal waits for the next MAJOR.
> * **Measurement standards are MAJOR.** The budget-tier limits (`run_spec` `budget_tier`), the SARIF rule
>   ids / level table / fingerprints (`sarif-mapping.md` §2–§5), and the oracle-id namespace are
>   comparability contracts: changing any of them silently changes what an existing result means, so it is
>   a MAJOR change + ADR even where the JSON shape is unchanged. Oracle thresholds (`[DIAL]`s) are not: they
>   version with the scenario (`scenario_version`), which every Report records.

> **Worked example — the `2.1.0` Phase-8 (Diplomacy) bump is a pure MINOR, with one pre-release erratum.**
>
> * **New surfaces only.** Nine new schemas with new `$id`s: the frames `wot:observation:diplomacy:1`,
>   `wot:action:diplomacy:1`, `wot:diplomacy_episode_end:1` on the existing `eval_target` channel, and
>   the records `wot:diplomacy_press_message:1`, `wot:diplomacy_press_reject:1`, `wot:diplomacy_offer:1`,
>   `wot:diplomacy_commitment:1`, `wot:diplomacy_renounce:1`, `wot:oracle_evidence:1`. A new scenario is
>   DATA (`diplomacy_standard`), and its five rule ids are new ids (append-only from now on).
> * **Additive edits to existing documents.** `run_spec`: a new seat mode `power` (+ positions), an
>   optional `diplomacy` block, an optional `target.ownership_attested`; every new constraint is
>   conditional on the new scenario id or the new field, so every 2.0.0 RunSpec still validates.
>   `episode_result` and `report`: enum members added to outbound documents (`mode`, `seat`, `outcome`,
>   `summary.outcomes`), new optional fields (`transcript_hash`, `evaluation_hash`, `diplomacy`,
>   `budget.press`, `evidence_ref.items`, `review_required`, catalog `risk`, `run.target_ownership`).
>   `budget_limits.max_inbound_frame_bytes` went from `const 8192` to `enum [8192, 16384]` with a
>   conditional that still pins 8192 for every scenario except `diplomacy_standard`: a relaxation for the
>   new scenario, byte-identical for the old ones. The `$id`s keep `:1`.
> * **Why the Diplomacy frame cap (16384) is not a measurement-standard change.** The tier table
>   (Ds, Dh, allowance, 8192) is unchanged for all seven 2.0.0 scenarios; a new scenario declares its
>   own structural cap, recorded in every Report's `budget_limits`. No existing result changes meaning.
> * **Runner rule, not schema tightening.** A non-loopback target now needs `target.ownership_attested:
>   true`, but the schema keeps the field optional (making it required would reject 2.0.0 RunSpecs, a
>   MAJOR); the runner enforces it with the new code `target_ownership_unattested`.
> * **Erratum (sarif-mapping.md §5).** The fingerprint formula now also hashes scenario, tier and seed,
>   because `replay_hash` does not commit to the seed in every scenario. §5 is a comparability contract,
>   normally MAJOR; it is corrected in a MINOR only because no released tool ever emitted the 2.0.0
>   formula (the open arena ships 2026-10-25). After the first public release this exception is closed.

> **Worked example — the `2.9.0` residency and pack-coverage correction is a MINOR with one precise tightening.**
>
> * **Pattern replaced by an enum, not a MAJOR tightening:** `hosted_context.region` and its four copies (`report`
>   `run.hosted.region`, `evidence_report` `producer.region` and `scope.region`, `deletion_receipt.region`). The pattern
>   `^europe-[a-z]{4,9}[0-9]{1,2}$` admitted `europe-west2` (London), which is outside the stated EU-or-Switzerland
>   boundary, so the old pattern contradicted its own description. The enum refuses exactly the values the
>   description already excluded. No producer ever wrote one. The only signer of a manifest, the Sixi control plane,
>   is unreleased, and it refuses to start with a region outside this same list. Every example, fixture, harness and
>   design document uses a listed region (`europe-west6` by default). Tightening a value a producer actually used would
>   be MAJOR (§2). This exception, like 2.7.0's `anchor_id`, holds only because no document outside the enum was ever
>   written, and a residency boundary that admits a non-EU region is a defect, not a feature.
> * **New load rule, stated where JSON Schema cannot:** a pack's `coverage.clauses` must include every clause its clause
>   map or rules cite (signing.md §11.3 step 6a). The schema is unchanged. The only pack that broke the rule was the
>   contract's own fixture, now corrected and re-signed. No Sixi pack has been published.
> * **Fixture and vector changes:** the fixture pack's payload and envelope digests change (`pack_vectors`), and the
>   other signing vectors are byte-identical. The `hosted_context` example pins a placeholder pack digest (§11.4), so the
>   signed example chain (run manifest, report, SARIF golden, evidence report) does not move.
> * **Oracle ids and SARIF rule ids do not change.** `diplomacy_standard.participation` and the `league` tier stay
>   reserved.

> **Worked example — the `2.8.0` participation release is a pure MINOR.**
>
> * **New oracle id and SARIF rule id:** `shared.participation`. Rule ids are append-only within a MAJOR, so adding one
>   is additive. Consumers already key alerts by rule id and tolerate a rule they have not seen.
> * **New conditional on a new id, not a tightening:** `episode_result` constrains verdicts whose `oracle_id` is
>   `shared.participation` (severity, evidence code and ticks, reason codes). No verdict with that id was written
>   under an earlier contract, so nothing that was valid becomes invalid.
> * **New `not_assessed` reason code** `never_actable` (the field is a pattern, not an enum), of SARIF kind `open`. The
>   not-applicable set of sarif-mapping.md §3 is unchanged.
> * **Scenario versions moved, not the contract's comparability rules:** raid 1.2.0 and `grid_tactics` 1.1.0 add one
>   verdict per episode. The Report records `scenario.version`, and `verify` compares within one build, so no
>   fingerprint input changes (sarif-mapping.md §5).
> * **New close code** `4408` on one channel (reserved in 2.7.0), sent only to a seat of a table that never started.
> * **Reserved, not specified:** `diplomacy_standard.participation` and the budget tier `league`. Adding the tier later
>   is an enum extension (additive), and the three existing tiers' numbers do not change.

> **Worked example — the `2.7.0` hosted-mode closure is a MINOR with one pattern made precise and one scheme rename.**
>
> * **New optional member:** `report.run.hosted.observed_truncated` (outbound, written only as `true`).
> * **Newly specified surfaces that describe the runner as built:** `ARENA_HOSTED` is read (signing.md §3.1, new code
>   `hosted_mode_only`), the guarded name families (§3.1.3), the hosted-admission rules for the control plane (§3.2)
>   and the run-token lifetime cap (§10). No hosted runner or control plane was released before them.
> * **Pattern made precise, not a MAJOR tightening:** `crosscheck_record` leg A `anchor_id`. The only producer, the
>   cross-check runner, has written `anchorId(name)` since 2.5.0, and every anchor name starts
>   `<scenario> <tier> seed <seed>`, so every id it ever wrote matches the new pattern. The value it could not write,
>   the old example `byzantine/core/squad/20260720`, is the one now refused. `maxLength` is raised from 80 to 128, a
>   relaxation. Tightening a pattern a producer actually used would be MAJOR (§2). This exception, like 2.6.0's
>   withdrawal, holds only because no record outside the new pattern was ever written.
> * **Scheme rename, not a MAJOR:** the OpenAPI management security scheme is renamed `architectBearer`
>   (`bearerFormat: architect+jwt`). A scheme name is a document-internal key. It is never sent on the wire, and the
>   header stays `Authorization: Bearer <token>`, so no client sends anything different. What the server accepts
>   changed with ADR-003 §3 (an EdDSA `architect+jwt` from a configured issuer), and the scheme now describes it.
> * **Oracle ids and SARIF rule ids do not change.**

> **Worked example — the `2.6.0` hosted-mode gaps are a MINOR with one withdrawal.**
>
> * **New document, new `$id`:** `wot:pack_variant:1` (`arena-pack-variant/1`). It is the format of a file the 2.2.0
>   pack manifest already pinned by digest (`scenarios[].data`), which had no schema.
> * **Newly specified, previously unspecified surfaces:** the pack envelope payload type, the pack directory layout
>   and load order (signing.md §11), the run-token profile (§10), the `ARENA_IMAGE_DIGEST` variable and the list of
>   variables that MUST be absent (§3.1), and the hosted bundle layout that `verify --hosted-seal` checks (§5.1). They
>   describe the hosted runner as built. No hosted runner was released before them, so none of them tightens a
>   shipped surface.
> * **Description edits only** in existing schemas: `hosted_context` (and its mirrors in `report`, `evidence_report`
>   and `crosscheck_record`), `pack_manifest` and `bundle_manifest`. No `type`, `pattern`, `required` or enum changes.
>   A new description in a mirrored field is copied into every mirror in the same release.
> * **Withdrawal, not a MAJOR removal:** the environment form of the run manifest and the RunSpec
>   (`ARENA_HOSTED_CONTEXT`, `ARENA_RUN_SPEC`). 2.5.0 introduced it already deprecated, and no runner ever read it: the
>   hosted CLI refused it from its first build, and the sandbox passes files. So no conforming producer or consumer
>   depended on it. Removing an input that something accepted would be MAJOR (§2). This exception, like the 2.1.0
>   fingerprint erratum, holds only because nothing ever accepted the input.
> * **Oracle ids and SARIF rule ids do not change.** A pack still never adds or renames either one, and a variant's
>   `oracle_thresholds` may name only oracles of its base.

> **Worked example — the `2.5.0` gap closure is a pure MINOR.**
>
> * **New outbound enum value:** `diplomacy_press_reject.code` gains `clause_beyond_horizon`. Consumers already
>   treat an unknown press-reject code as a generic refusal (the field's own rule since 2.1.0). The conditional
>   that restricts it to offers and counters applies only to the new value.
> * **Relaxation:** `renounce.releases_from_phase` also accepts `S1909M` (widening a pattern, §2).
> * **New optional members:** `settlements` on a commitment clause, and `budget.press.redactions` on the
>   EpisodeResult.
> * **Documentation of existing behaviour:** the oversize Diplomacy hello, close code `1009`, the hello-time
>   `signature_modes` snapshot, `build_scope` and `source_manifest_digest` coverage, and the SARIF review sentence
>   and `evidence_ids` rules. The clause status and `settled_phase` definitions are what the evaluation adapter
>   already emits. The table session differs only for a broken multi-phase clause, and its fix is an implementation
>   follow-up.
> * **Not a contract change:** a renounce of an ended commitment was already outside "an active commitment the
>   sender is a party to" (2.1.0). The engine accepted it, and now has to catch up.
> * **Hosted additions:** a whole new schema (`deletion_receipt`, `wot:deletion_receipt:1`); the optional
>   `evidence_report.not_assessed.unresolved_clauses`; and on the cross-check record the optional `scope` plus a
>   relaxed leg `A` (three required fields instead of seven). A 2.2.0 record keeps its meaning, because an absent
>   `scope` is `hosted` and the pass rule for it is unchanged. The file form of the manifest and RunSpec is additive,
>   and the env form is deprecated rather than removed (§5).
> * **Golden correction, not a rule change:** the hosted SARIF golden renders `single_owner_table` as `notApplicable`,
>   as sarif-mapping §2.1 has said since 2.1.0. `kind` is not a fingerprint input, so no alert moves.

> **Worked example — the `2.4.0` Phase-8 transport bump is a MINOR with one pre-release erratum.**
>
> * **Additive:** the optional `signing_key` on two REST responses (a client that ignores unknown fields is
>   unaffected, and a 2.3.0-shaped response still validates); a new channel (`diplomacy_table`) with two new
>   `$id`s (`wot:hello:diplomacy:1`, `wot:ack:diplomacy:1`), so the duel `hello` and `ack` schemas do not change;
>   the optional RunSpec `diplomacy.fill`, whose conditionals apply only when it is present; three
>   `not_assessed` reason codes (the field is a pattern, not an enum); description edits.
> * **Erratum:** `diplomacy_observation.offers` now lists live offers only and the schema pins
>   `status: pending`. 2.1.0 to 2.3.0 also promised offers closed at the last round close, which no arena
>   ever emitted and the design never asked for. Narrowing an outbound field is normally MAJOR; it is a MINOR
>   here for the reason the 2.1.0 fingerprint erratum was: no released server emitted the wider form, and
>   the table session was not documented as public before this release.

> **Worked example — the `2.3.0` gap closure is a MINOR with two documentation errata.**
>
> * **Additive:** the optional members `engine.build_scope`, `engine.source_manifest_digest` and
>   `diplomacy.engine_evaluation_hash`.
> * **Conditional on the 2.2.0 member `seats[]`:** the per-mode seat rules. Every `seats[]` a conforming
>   writer emits still validates: engine and target raid and duel seats, a squad of five target members,
>   and Diplomacy seats. The rules reject only a forged `recorded_peer` or `llm_peer` outside power mode,
>   which already contradicted its RunSpec. `verify` now reports that case as `unverifiable` (schema)
>   instead of `mismatch`.
> * **The hosted SARIF golden now renders the §2 and §4 members 2.1.0 already required.** The golden was
>   brought to the rule, not the reverse.
> * **§1 errata:** the §1 rows now document what every emitter rendered (`revision_id`, the driver
>   disclosure). No rule id, level or fingerprint changes, so no code-scanning alert moves.

> **Worked example — the `2.2.0` Phase-9 (hosted profile) bump is a pure MINOR.** HOSTED-PROFILE.md
> §0.1 K1–K9; ADR-004 records the one semantic addition.
>
> * **New documents only, with new `$id`s:** `wot:hosted_context:1` (the signed run manifest),
>   `wot:pack_manifest:1`, `wot:crosscheck_record:1`, `wot:evidence_report:1`, `wot:bundle_manifest:1`,
>   plus `signing.md` and two fixtures.
> * **Additive edits.** New optional members: `run.hosted`, `not_assessed`, `signing`,
>   `scenario.base_scenario_id`, RunSpec `seats[]`, EpisodeResult `seats[]`,
>   `diplomacy.episode_secret(_commitment)`. New enum members: `target_ownership.source:
>   sixi_verified`, `diplomacy.profile: table`, roster `seat_kind: recorded_peer`. Every new
>   constraint is conditional on a new member (`run.hosted`, `signing`, `seats`, an `sx_` id), so every
>   2.1.0 document still validates. The `$id`s keep `:1`.
> * **One relaxation.** `sx_` scenario ids no longer get the non-Diplomacy conditionals. Such ids were
>   pattern-valid but never emitted.
> * **Verify semantics (ADR-004).** `inputs_source: llm_peer` seats verify as "recorded, not
>   regenerated" instead of making an episode `unverifiable`. No existing report changes outcome,
>   because without `seats[]` only the target is recorded.
> * **Runner rules, not schema tightening.** The hosted runner's `env:ARENA_TARGET_CREDENTIAL`-only
>   rule (K6) and the `sx_` refusal in the open CLI (K5) are runner rules with error codes. The schema
>   pattern for `target.auth.ref` is unchanged.
> * **Deprecation, not removal (G-10).** `hello.dpop`, `raid_hello.dpop` and
>   `RegisterAgentRequest.device_binding` were advertised but never enforced. They are now marked
>   `deprecated`, documented as ignored, and dropped from every example. Removing them would reject
>   inbound frames that are valid today, which is MAJOR, so removal waits for `3.0.0` (§5 process).
> * **Oracle ids and SARIF rule ids do not change.** The SARIF gains only run-level
>   `properties.agentArena` members, copied from the Report.

**Breaking (MAJOR, requires a version bump **and** an ADR — MISSION §7):**
- Removing or renaming a field, operation, channel, message, scope, or error code.
- Changing a field's type, or making an optional field required.
- Tightening validation in a way that rejects previously-valid input (lowering a cap, narrowing an
  enum, adding a `required` entry, flipping `additionalProperties` to `false` on an inbound frame).
- Changing the semantics of an existing field or reason/close code.
- Changing a `maximum frame size` **downward** (agents may already emit near the old cap).

**Consumer obligations (so additive changes stay non-breaking):**
- **Outbound frames (server → agent):** agents MUST ignore unknown fields. The canonical schemas set
  `additionalProperties: false` as the **server's emission contract** (it is a *security* property
  for `observation` — a stray field could leak fog, A1 §7.6), but agents SHOULD parse leniently.
- **Inbound frames (agent → server):** `additionalProperties: false` is enforced at the edge — an
  unknown field is a `schema_invalid` reject. Agents therefore MUST NOT invent fields (same rule as
  the legacy Action schema).

---

## 3. Frame `t` and schema-`$id` conventions

- Every WSS frame carries a `t` discriminator. Play loop (`arena` channel): `"hello"`,
  `"observation"`, `"action"`, `"ack"`, `"reject"`, `"match_end"`, `"thought"`,
  `"session_superseded"`, `"session_revoked"`. Broadcast (`spectator` channel, added `1.1.0`, deprecated `2.0.0`):
  `"spectate_subscribe"`, `"spectate_resync"`, `"spectate_ack"`, `"spectator_frame"`,
  `"spectate_reject"`, `"spectator_match_end"`. Raid (`raid` channel, added `1.3.0`): `"raid_hello"`,
  `"raid_observation"`, `"raid_action"`, `"raid_ack"`, `"raid_end"` (+ generic `"reject"`). Evaluation-run
  target session (`eval_target` channel, added `2.0.0`): the duel frames verbatim, plus
  `"eval_raid_observation"`, `"eval_raid_action"`, `"eval_episode_end"` (+ generic `"reject"` over `ws`),
  and since `2.1.0` the Diplomacy frames `"diplomacy_observation"`, `"diplomacy_action"`,
  `"diplomacy_episode_end"`. Diplomacy table session (`diplomacy_table` channel, `/v1/arena`, added `2.4.0`):
  `"hello"` and `"ack"` in their Diplomacy forms (`wot:hello:diplomacy:1`, `wot:ack:diplomacy:1`, selected by
  `scenario_id` and `mode: "diplomacy"`), then the three Diplomacy frames, the `wot:ack:1` action ack, `"reject"`
  and the session events.
  The `caster` and `commentary` channels (added `1.4.0`) were removed in `2.0.0`. The edge routes on `t`
  **within a channel**, then validates against that frame's schema.
- Schema `$id`s follow `wot:<frame>:<major>` for mode-agnostic frames (`wot:hello:1`,
  `wot:reject:1`, `wot:match_end:1`, `wot:spectator_frame:1`, `wot:spectate_ack:1`) and
  `wot:<frame>:<mode>:<major>` for **mode-specific** frames (`wot:observation:grid_tactics:1`,
  `wot:action:grid_tactics:1`).
- Non-frame **artifact** schemas follow the same `wot:<name>:<major>` convention:
  `wot:webhook_event:1` (the signed delivery envelope) and, since `2.0.0`, the evaluation-run
  documents `wot:run_spec:1`, `wot:episode_result:1` and `wot:report:1`. (`wot:shot_list:1`, the
  Director's output, was removed in `2.0.0` with the Director.) The eval target frames use the mode
  segment: `wot:observation:eval_raid:1`, `wot:action:eval_raid:1`; so do the Diplomacy frames
  (`wot:observation:diplomacy:1`, `wot:action:diplomacy:1`). Diplomacy records use the artifact form
  (`wot:diplomacy_offer:1`, `wot:oracle_evidence:1`, ...). A record that a frame carries is embedded as
  an exact copy under the frame's `$defs` (self-contained rule below; the check is in
  `tools/contract-check.mjs`).
- **Self-contained schemas.** No schema `$ref`s another file (codegen and the edge validators load one
  file at a time). Where one document embeds another — `report` embeds `run_spec` and `episode_result`
  under `$defs` — the copy must be exact; `contracts/tools/contract-check.mjs` fails on drift.
- The mode segment is why a second mode (e.g. Negotiation Chambers, Phase 4) can add
  `wot:observation:negotiation:1` **additively** without touching Grid Tactics — the `t` stays
  `"observation"`, the `phase` field disambiguates, and the mode-scoped `$id` selects the schema.
- **Phase-3 economy REST schemas live inline in `openapi.yaml` `components/schemas`** (same as
  `MatchSummary`/`Replay`/`QueueTicket` — REST bodies are not versioned wire frames and carry no
  `$id`). Only the two touched **frame/artifact** schemas keep their `$id` and took **additive**
  changes with **no MAJOR bump**: `wot:match_end:1` (payout widened to `["object","null"]`, new
  optional fields) and `wot:webhook_event:1` (new `market.fill` `oneOf` branch + `$defs`). Additive
  ⇒ the trailing integer does not move.
- `protocol_version` on the frame is the coarse gate: a MAJOR mismatch at `hello` is rejected
  (`wrong_protocol_version` / close 4401); MINOR is tolerated (additive).

---

## 4. The `legal_actions[]` reconciliation (the one deliberate model change)

This is the single semantic break between the legacy protocol and the WSS v1 play loop, called out
per the api-architect charter.

**Legacy model (retired).** The protocol spec of the pre-pivot game prototype made the observation's
`legal_actions[]` **authoritative**: the server enumerated every permitted action `type` for the
turn, and "the server rejects anything not in this list" (§2, §6 step 5 `illegal_type`). That works
when the action space is a short, enumerable list of verbs over named nodes.

**Grid Tactics model (v1).** There is **no `legal_actions[]`**. Rationale (A1 §7.6): the action
space is *spatial and combinatorial* — every unit may `move` an ordered 1–2 step path in any of 4
directions or `attack` any in-range cell. Enumerating it exhaustively each tick is neither compact
nor useful. Instead:

- **Legality is defined declaratively** by the roster constants (per-unit speed/range/vision) plus
  the validation pipeline (A1 §5.1), and **enforced server-side at submit** — an agent cannot make
  an illegal move "stick".
- **Optional convenience fields** `reachable` (per-unit legal move destinations) and `attacks`
  (per-unit in-range visible-enemy target cells) hand reflex agents a ready shortlist. These are
  **advisory, not authoritative**: they are fog-filtered and may under-list (e.g. a legal 2-step
  path can reach a cell not in the single-step `reachable` set). The server validates every action
  regardless of what these fields contained.

**Why this is safe / correct:**
- It preserves the pillar: "knowing the rules is part of the skill" (the legacy `cost`-echo intent)
  now expresses as "compute your own legal moves, or lean on `reachable`/`attacks`."
- It keeps the 50-line floor low: the reflex agent reads `attacks`/`reachable` and never computes
  geometry.
- It removes a large, redundant payload from every observation (fewer bytes, fewer fog-leak
  surfaces — an over-broad `legal_actions` could itself leak information).

**Consequences captured elsewhere:**
- The legacy per-turn `illegal_type` *forfeit* becomes a per-unit **coercion to Hold** (`errors.md`
  §3b) — softer and reflex-agent-friendly.
- The legacy client-declared **`cost` echo** and its `bad_cost` forfeit are **retired**: costs are
  canonical server-side; over-spend is the `insufficient_tokens` coercion (`errors.md` §5).

Because the legacy transport (HTTP / OpenAI Chat Completions) is discarded wholesale and the play
loop is a brand-new WSS surface, this is a **clean-slate v1**, not an in-place break of a shipped
WSS contract — so it does not itself trigger a MAJOR bump of *this* contract. It is recorded here (and
in `CHANGELOG.md`) as the intentional divergence from the salvaged spec. Any *future* change to the
no-`legal_actions` decision would be a MAJOR frame bump + ADR.

---

## 5. Deprecation process

1. Mark the field/operation deprecated in the spec (`deprecated: true` / a note) and in
   `CHANGELOG.md`; keep it functioning.
2. Ship the replacement additively; update the generated SDK.
3. Announce a removal version. Removal is a MAJOR bump with an ADR and a migration note.
4. Reserved-but-unimplemented surfaces (see `RESERVED.md`) may be *named* in enums now (e.g. the
   forward scopes) — filling them in later is additive, not breaking, which is the whole point of
   reserving them.
