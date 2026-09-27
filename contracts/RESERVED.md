# Reserved Surfaces

A surface that is **named and reserved** here is deliberately NOT specified yet, so a later release can
add it additively (`versioning.md` §2) without breaking anyone. Reserving a name now (a scope, a schema
`$id` segment, a claim, a path prefix, an event type) means the later phase **fills in a shape** instead
of breaking a shipped contract.

**Rule of thumb:** if a surface is not in `openapi.yaml`, `asyncapi.yaml`, or `schemas/` today, it is
reserved here or it does not exist. Do not implement against a reserved surface until its contract
merges in its target phase.

---

## Specified at `2.8.0`: close `4408` `seat_timeout`

Reserved at `2.7.0`, now specified: errors.md §4 and asyncapi.yaml `diplomacy_table` "Seat arrival". The deadline is
120 s by default, counted from table creation. When it expires before every agent seat is connected and bound, every
connected seat is closed `4408`, no observation or `diplomacy_episode_end` was sent, no episode exists, and the table is
gone (a later hello for its `table_id` is closed `4403`).

## Not introduced at `2.8.0`: pack id `sx-neutral-ground`

The Neutral Ground harness (docs/phase-9/NEUTRAL-GROUND.md §7, item 1) used `sx-neutral-ground` as a pack id for
`recorded_peer` seats. No contract introduces it. Neutral Ground is not a pack: every Neutral Ground seat is
`driver: target` with `owner` = its provider slug (`run_spec` `seats[]`), so collusion owners are expressible and the
seats verify as recorded, replayed target inputs. The primary seat's collusion owner stays the literal `primary`. The
name is not reserved either: a pack with that id would need its own manifest and its own reason to exist.

## Withdrawn at `2.6.0`: `ARENA_HOSTED_CONTEXT`, `ARENA_RUN_SPEC`

2.5.0 introduced these two names as an already-deprecated environment form of the run manifest and the RunSpec. No
runner ever read them: the hosted CLI refuses them from its first build, and the sandbox passes files. They are no
longer an input of any kind. They are listed among the variables that MUST be absent from a hosted job (signing.md
§3.1.1, `hosted_context_invalid`, `detail.field: manifest_source`), and the names stay retired, so no later release
gives them another meaning.

## Deprecated at `2.5.0`: CLI-written RunSpec labels superseded by contract fields

`run_spec.labels` is free caller metadata, never interpreted. Two labels that the CLI runner wrote because no
contract field existed now have fields. The CLI keeps writing each label for **one more minor**, through `2.5.x`, as
a duplicate, and stops at `2.6.0`. No reader may depend on either label. The names stay reserved for the CLI, so no
one else writes them with another meaning.

| Label | Replaced by | Note |
|---|---|---|
| `arena.diplomacy_fill` | `run_spec.diplomacy.fill` (`2.4.0`) | The same value. |
| `arena.press_redactions` | `episode_result.budget.press.redactions` (`2.5.0`) | The label is a per-run sum written only when it is above 0. The field is per episode, and a redacting producer writes it with 0 included. |

## Deprecated at `2.2.0` (security review G-10)

`hello.dpop`, `raid_hello.dpop` and `RegisterAgentRequest.device_binding` are **deprecated and ignored**:
no DPoP (RFC 9449) or device-binding check exists, so none of them is a security control, and the
`cnf.jkt` token claim is not part of any contract. They are still accepted only because removing an
inbound field is MAJOR (`versioning.md` §2); they are removed at the next MAJOR. The former reserved
row "Device binding (DPoP) enforcement" is withdrawn: device binding is not planned.

## Status at contracts `2.0.0` (ADR-001, Phase 7 Stage A)

**Removed (not reserved; ADR-001 §6).** These surfaces were specified in `1.2.0`–`1.5.0` and are gone.
Their names are **retired**, not reserved: reusing one for a different meaning later requires an ADR,
because old integrations may still send them.

| Retired surface | Was | Retired names |
|---|---|---|
| The Great Hunt | `1.4.0` | `/v1/hunt*`, scope `hunt:participate`, webhook `hunt.clue`, codes `hunt_not_found`/`gate_not_found`/`gate_locked` |
| The Bazaar + A2A trade escrow | `1.2.0` | `/v1/market/*`, `/v1/a2a/*`, scope `market:trade`, webhook `market.fill`, codes `order_not_found`/`a2a_session_not_found`/`self_trade`/`escrow_failed` |
| Adapters | `1.2.0` | `/v1/adapters`, `/v1/agents/{id}/adapters*`, codes `adapter_required`/`adapter_not_owned`, the `adapters` JWT claim as a gate |
| Economy (balances, ledger, stakes, rake, refunds, payouts, rewards, quests) | `1.2.0` | `/v1/me/*`, `/v1/agents/{id}/balance`, `/ledger`, `/profile`, `/reliability`, `/v1/quests/*`, `stake` on the queues, `payout`/`refund`/`rating_delta`/`verified`/`coach_interventions` on `match_end`, `reward`/`verified` on `raid_end`, code `insufficient_balance` |
| Leagues / seasons / the Golden List (Weights ladder) | `1.2.0` | `/v1/leagues`, `/v1/season`, `/v1/seasons/{id}`, `/v1/leaderboards/{league}`, code `season_not_found`. The `league` FIELD survives as the budget tier. |
| Guilds, tournaments | `1.3.0` | `/v1/guilds*`, `/v1/tournaments*`, codes `guild_not_found`/`tournament_not_found` |
| Community caster + commentary | `1.4.0` | `/v1/matches/{id}/caster/attach`, WSS channels `caster`/`commentary`, frames `caster_hello`/`caster.say`/`caster_ack`/`commentary_subscribe`/`commentary_ack`/`caster_commentary`, scope `caster:publish` |
| Coach mode analytics, the Vault | `1.4.0` | `/v1/matches/{id}/analytics`, `/v1/agents/{id}/analytics`, `/v1/vault/*`, code `exhibit_not_found` |
| World-first clear races | `1.5.0` | `/v1/raids/bosses/{id}/records`; `BossDescriptor.availability` (season windows) and `sigil_seed` |
| The Director | `1.1.0` | `wot:shot_list:1` |

**Deprecated (still served, removed at the next MAJOR):** the `spectator` WSS channel and
`GET /v1/matches` (the live directory). The viewer survives only as a replay inspector over
`GET /v1/replays/{id}` and report files.

## Currently reserved

| Surface | Target | What it will add | Hooks already in place |
|---|:--:|---|---|
| **Negotiation press layer** (Diplomacy) | Phase 8, `2.1.0` | The Diplomacy scenario's press channel: in-episode signed messages and a term vocabulary for `Commitment.terms[]`, plus the manipulation / commitment / collusion / injection oracles. | `/v1/negotiations*` (signed offer/counter/accept/withdraw, `agreement_hash`), `CommitmentTerm.term` is a data key (not an enum), oracle ids are namespaced strings. All extensions must be additive. |
| **Diplomacy table management (REST)** | open (after Phase 8 B3) | Creating, listing and inspecting Diplomacy tables over REST (seats, eval class, horizon; a table-created notice to each seated agent). In `2.4.0` tables are created **server-side only** (operator tooling, `createTable`); a seated agent learns its `table_id` out of band. | The table session is specified in `2.4.0` (asyncapi.yaml channel `diplomacy_table`, `wot:hello:diplomacy:1`, `wot:ack:diplomacy:1`); the `dtb_` id prefix; scope `negotiate:a2a`. A route is additive. |
| **`diplomacy_standard.participation`** (oracle id, reserved `2.8.0`) | a later MINOR (not in `2.9.0`) | The Diplomacy participation rule: over the episode horizon, a target power whose every submitted order is `hold` and none of whose press messages was accepted at a round close fails at `error` (non-trivial = any order other than `hold`, or any accepted press message; `basis: resim`, `primary: false`). It catches a power that sends valid all-hold, no-press frames every step, which `shared.budget_violation` does not. | sarif-mapping.md §2.3.1 (definition and what wiring it changes: the Diplomacy catalog, the contract `evaluation_hash`, `report.schema.json` `examples[1]` and `[2]`, the hosted SARIF golden, the report signing vector). No 2.8.0 producer emits it. Adding an oracle id is additive within the MAJOR. |
| **`peer_reports` for more scenarios** | Phase 7 B2 / scenario-director | Whether Byzantine and Split-Brain also relay peer pings to a member-mode target (arena-scenarios.md §6 Q3). | `eval_raid_observation.peer_reports` exists (member mode); adding it to more scenarios is data (`ScenarioDescriptor.channels`). |
| **Deletion API (hosted)** | Phase 9 | The Sixi routes that delete a run, a scan, data before a date or the organisation, and read a deletion's state (`/api/arena/deletions/{deletion_id}`). They are Sixi surfaces, not in `openapi.yaml`. | Specified in `2.5.0`: the signed receipt `schemas/deletion_receipt.schema.json` (signing.md §9), the `del_` id prefix, and the payload type `application/vnd.sixi.arena-deletion+json`. |
| **Hosted runner (remaining surfaces)** | Phase 9 | The hosted URL of `/v1/runs*`, org scoping, run cancellation (`POST /v1/runs/{run_id}/cancel`). Per-organisation `secret:<name>` stores are **not** offered (decision S4; `2.2.0` K6: the hosted runner accepts only `env:ARENA_TARGET_CREDENTIAL`). | Specified in `2.2.0`: the hosted context / run manifest (`hosted_context.schema.json`), `Report.run.hosted`, the `signing` seal (`signing.md`), the bundle manifest, the cross-check record, the evidence report, the hosted error codes (errors.md §1d). |
| **`run.completed` webhook** | Phase 9 | Push notice when a hosted run finishes (run id, verdict, report URL; never the report body, never target data). | The signed webhook envelope (`wot:webhook_event:1`) and `WebhookEventType` (add an enum member + a `oneOf` branch). |
| **Scenario-pack namespace `sx_`** (reserved `2.2.0`, K5) | Phase 9 (paid) | Scenario ids starting `sx_` belong to Sixi Arena packs (`pack_manifest.schema.json`: clause maps, data-only variants, LLM peers). No open scenario may ever use the prefix. The open CLI refuses an `sx_` id before any I/O (`scenario_pack_unavailable`, exit 3). Pack ids use `sx-…`. | The pack manifest schema, `scenario.base_scenario_id`, sarif-mapping §2.2 (packs keep the open rule ids). Clause citations live only in the evidence report. |
| **Mixed-ownership squads** (raid scenarios) | later | Several external targets in one raid encounter (per-seat transports, fairness rules). | `RunSpec.seats[]` exists since `2.2.0` for the Diplomacy family (`power` mode, `table` profile, recorded peers, ADR-004); extending it to other seat modes is additive. |
| **Hard scenario variants** | open (arena-scenarios.md §6 Q4) | Withholding `next_lock_rank`, `is_primary`, `lead_cell`. | A new `scenario_id` or `scenario_version`; no schema change. |
| **MCP discovery manifest** | open | The management plane as MCP tools (`list_scenarios`, `submit_run`, `get_report`, `fetch_replay`) for discovery. **The play loop never goes behind the platform's MCP surface** (api-architect charter). A target that IS an MCP server is a different thing: `eval_target` binding `mcp`. | The REST operations these tools would wrap exist. |
| **Digest statements for pack envelopes** (2.11.0) | a later MINOR | Extending signing.md §5.2 to `pack.dsse.json`, so a pack whose PAE message is over `ARENA_SIGN_MAX_MESSAGE_BYTES` can be signed by a KMS-held key. It needs a pack layout in which the manifest travels beside the envelope. In `2.11.0` packs stay raw and the pack store refuses to publish a larger one. | `digest_statement.schema.json` `subject.payload_type` is an enum: adding the pack type is additive. The pack envelope already allows 1 to 4 signatures. |
| **Pinned key file `agent-arena-pinned-keys/2`** | only with a breaking change to the bundled file | Any change to the bundled key file that a `/1` reader would misread, such as a third set or a key type other than Ed25519. | `pinned_keys.schema.json` `format` is a `const`, so a `/1` verifier refuses a `/2` file rather than misreading it. |
| **Additional modes / topology levers** | v2+ | Hex grid, terrain line-of-sight, drafting, respawns, move-and-shoot, >4 unit types (A1 §16). | Mode-scoped schema `$id`s (`wot:observation:<mode>:<major>`) make each additive. |

---

## History

`1.1.0`–`1.5.0` moved the Phase 2–6 surfaces from this file into the specs (spectator broadcast,
webhooks, economy and ladder, raids and delegation, Negotiation Chambers, guilds, tournaments, the Great
Hunt, the caster channel, Coach analytics, the Vault, the failure-mode taxonomy and world-first
records). `2.0.0` removed most of them (table above). The per-release detail is in `CHANGELOG.md`; the
`1.5.0` text of this file is in git history.

`2.10.0` specified the budget tier reserved in `2.8.0` as `league`, under the name **`extended`** (Architect ruling
2026-09-27): the name `league` clashed with the passport and queue field `league`, which already carries the tier.
`extended` is a real tier in every tier enum (`run_spec` `budget_tier` and every copy), with Dh 30000 ms, Ds 15000 ms
and allowance 540, and it is not Diplomacy-only. The value `league` was never a member of any tier enum and stays
refused as an unknown value. The live duel/raid queue and passport `league` fields keep edge, core and frontier.
Hosted `extended` runs play one episode (signing.md §3.2 A6) until a run-token refresh path exists.

`2.11.0` specified two hosted surfaces that were named but not defined. The first is **the pinned control-plane key set**,
which signing.md §3.2 M3, M6 and §11 referred to: signing.md §3.3 and `pinned_keys.schema.json`, including the CLI value
`verify --key pinned`. The second is **what a Sixi key signs when a payload is over the Cloud KMS raw-data limit**: signing.md
§5.2 and `digest_statement.schema.json`. The pack form of §5.2 and a `/2` key file stay reserved (table above).
