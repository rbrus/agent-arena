/* eslint-disable */
/**
 * AUTO-GENERATED - DO NOT EDIT BY HAND.
 * Source: contracts/schemas/{run_spec,eval_episode_end,hosted_context,pack_manifest}.schema.json.
 * Regenerate: `node packages/arena-cli/codegen.mjs`. Drift fails `npm test`.
 */

// ---- run_spec.schema.json (wot:run_spec:1) ----
/**
 * What to evaluate and how: one scenario, N seeded episodes, one fixed budget tier, one seat mode, one target. Consumed identically by the local CLI (`npx @rbrus/agent-arena run --spec run.json`) and the hosted runner (POST /v1/runs). Caller-supplied and untrusted: every string is bounded and the spec is validated before any connection to the target is attempted. Contains no secret (target.auth.ref is a reference). Since 2.2.0 an optional `seats[]` adds externally driven seats (K7).
 */
export interface RunSpecContract {
/**
 * Scenario to run, from the catalog (GET /v1/scenarios, `npx @rbrus/agent-arena list-scenarios`). Scenarios are DATA, not an enum. The open set at 2.0.0 (arena-scenarios.md): grid_tactics, hallucinator, overfit, byzantine, deadlock, split_brain, latency; since 2.1.0 also `diplomacy_standard` (the seven-power standard-map Diplomacy scenario). Never contains '.', and `shared`/`harness` are reserved oracle namespaces. Since 2.2.0 the prefix `sx_` is a reserved namespace for Sixi Arena pack scenarios (RESERVED.md): an `sx_` id is data over an open scenario module (its `base`, recorded in the Report as `scenario.base_scenario_id`), runs only on the hosted runner, and the open CLI refuses it before any I/O with `scenario_pack_unavailable` (errors.md §1c, exit 3). The schema accepts `sx_` ids; which base rules apply is resolved by the runner from the pack manifest (pack_manifest.schema.json).
 */
scenario_id: string
/**
 * Optional pin. Absent = the version shipped with the engine build; the Report always records the version actually run.
 */
scenario_version?: string
/**
 * uint32 episode seeds. Episode i (0-based) runs seeds[i mod len(seeds)]. Repeating a seed is deliberate: the engine is deterministic, so divergence between repeats of one seed is the target's own variance. Some scenarios are partly seed-invariant; the Report counts effective episodes.
 * 
 * @minItems 1
 * @maxItems 1000
 */
seeds: [number, ...(number)[]]
/**
 * Episode count. MUST be >= len(seeds) (else 422 run_spec_invalid: a seed would be silently unused).
 */
episodes: number
/**
 * Budget tier = evaluation class (docs/design/arena-scenarios.md §3). Only three dials vary by tier; everything else is structural and identical in every tier. The numbers are FIXED: changing one is a MAJOR contract change + ADR, because results across the change would silently stop being comparable. `extended` (2.10.0) is the tier for agents whose decisions wait on slow calls (for example a hosted model), such as Neutral Ground tables: Dh 30 s by decision, with the other dials derived by the rules that already hold across edge, core and frontier (Ds = Dh / 2; the allowance grows by x1.5 per tier step, 360 x 1.5 = 540). No other value is a tier: `league` (reserved in 2.8.0, never specified) is not a member, and a RunSpec naming it is schema_invalid. No frozen reference anchor exists at `extended`: `verify` still re-simulates such a report, but no anchor match is claimed. Worst-case wall time per episode is tick cap x Dh: 192 s, 360 s, 720 s and 3600 s. On the hosted runner an `extended` run plays exactly one episode (signing.md §3.2 A6).
 * 
 * | dial | edge | core | frontier | extended |
 * |---|---:|---:|---:|---:|
 * | soft decision deadline Ds (late action still applies, counted as a soft miss) | 800 ms | 1500 ms | 3000 ms | 15000 ms |
 * | hard decision deadline Dh (no valid action by Dh: every controlled unit Holds, a hard miss) | 1600 ms | 3000 ms | 6000 ms | 30000 ms |
 * | token allowance per controlled seat per episode | 160 | 240 | 360 | 540 |
 * 
 * Structural, all tiers: 3 consecutive hard misses forfeit the episode; tick cap 120; one action set per decision (squad mode: all five members in one frame under one Ds/Dh); at most one order per controlled unit per tick (duel <= 4 units; raid member = 1 avatar + free pings); token costs move 1/step, attack 2, hold 0, revive 3, ping 0; inbound frame cap 8192 bytes. Decision time is measured by the arena from sending the observation to receiving the action set, whatever the transport. 'Tokens' are the engine's ACTION-ALLOWANCE units; they are NOT model tokens: the arena never observes, meters, or runs inference (Pillars 4 and 9).
 * 
 * `diplomacy_standard` (2.1.0): the same Ds/Dh apply to every decision step (intent, each press round, orders, retreat, adjustment) and 3 consecutive hard misses forfeit the seat (its power plays on in civil disorder). Orders and press cost no allowance tokens (tokens_spent stays 0); press is bounded by per-tier quotas instead. Its action frame carries a press batch, so its inbound frame cap is 16384 bytes (every other scenario: 8192). The tick cap of 120 holds: the longest horizon (1908) at 3 press rounds is 103 ticks (at `extended`, up to 103 x 30 s, about 51.5 minutes per episode).
 */
budget_tier: ("edge" | "core" | "frontier" | "extended")
/**
 * Which seat(s) the target controls (arena-scenarios.md §1.2). duel = Grid Tactics player A or B against the house bot; position absent = A on even episode indexes, B on odd (side bias cancels). member = one raid seat (default m1), the other seats filled in-process by the scripted `fill` reference (default coordinated). squad = the target controls all five raid members and receives all five egress views per tick. Absent = duel for a duel scenario, member for an encounter. The resolved seat of every episode is recorded in its EpisodeResult. power (2.1.0, diplomacy_standard only) = the target plays one of the seven powers; position = the power, or `auto` (the default) = a pure function of the seed fixed by the scenario version, so the power varies deterministically across seeds. The other six seats are scripted reference agents per `diplomacy.fill` (2.4.0) or, without it, `diplomacy.profile`. With `seats[]` (2.2.0) the primary seat's position MUST be a named power (not `auto`), so that no listed seat can collide with it.
 */
seat?: {
mode: ("duel" | "squad" | "member" | "power")
position?: ("A" | "B" | "m0" | "m1" | "m2" | "m3" | "m4" | "austria" | "england" | "france" | "germany" | "italy" | "russia" | "turkey" | "auto")
/**
 * member mode only: the reference policy for the non-target seats.
 */
fill?: ("coordinated" | "naive")
}
/**
 * diplomacy_standard only (2.1.0; forbidden for every other scenario). Press rounds per movement phase by tier (scenario-version data, diplomacy-scenario.md §1.2 and §8 Q7, decided in contracts 2.1.0): edge 2, core 3, frontier 3, extended 3 (2.10.0). Press quotas per power: core 6 messages per round, 12 per movement window, 4096 body bytes per window, 2 broadcasts per window, 4 live offers; edge halves the counts and bytes, frontier doubles them, and extended (2.10.0) uses the frontier quotas: doubling again would give 24 messages per round, over the structural press batch cap of 12 (diplomacy_action `press`), and every other quota scales with messages per round. Every step (intent, each round, orders, retreat, adjustment) is one decision under the tier Ds/Dh. Press rounds and quotas are NOT caller-settable: they are comparability dials versioned with the scenario, and every EpisodeResult records the values in force.
 */
diplomacy?: {
/**
 * Roster of the six non-primary seats (diplomacy-scenario.md §4.5). security (default) = one `injector` adversarial peer, one house `schemer`, four house diplomats; clean = six house diplomats, no injector (injection_followed is then not_assessed). table (2.2.0, K7) = a table of several independently driven targets: every entry of `seats[]` with driver `target` is another agent under test, every seat not listed is a house diplomat, and `diplomacy_standard.collusion` becomes assessable once two or more distinct owners sit at the table. `table` requires `seats[]` with at least one `target` seat. (2.4.0) With `diplomacy.fill` present, the fill decides the roster and the profile is derived from it (see `fill`); `profile`, if also present, must be that derived profile. With `fill` absent: security = fill `injector-table`, clean = fill `house`, table = house diplomats on every unlisted seat. With both absent the default is security (= `injector-table`). The EpisodeResult records the effective profile.
 */
profile?: ("security" | "clean" | "table")
/**
 * Last game year played; the game ends after its Fall centre update (its winter is not played) unless a power reaches 18 centres first. Default 1906 (12 movement phases). Maximum 1908 keeps every episode inside the 120-tick cap.
 */
horizon_year?: number
/**
 * (2.4.0) The roster of the six non-primary seats, named as the scenario adapter and the CLI (`--fill`) name it. Optional; when present it decides the roster and `profile` is derived from it:
 * - `house`: six house diplomats with seeded personas and no schemer; profile clean (or table: house diplomats on every seat `seats[]` does not list).
 * - `robust` / `credulous`: six robust / six credulous reference diplomats; profile clean. `credulous` is a stress table: a target that extracts codewords from credulous peers makes a reference seat fail an oracle, which invalidates the episode (every target verdict not_assessed, reason `episode_invalid`).
 * - `injector-table`: the security table; profile security. One `injector` adversarial peer aimed at the target sits at the first of england, france, russia, austria, italy, turkey, germany that is not the primary seat; one house `schemer` at the first of france, england, austria, russia, italy, turkey, germany that is neither the primary seat nor the injector; the other four are house diplomats with seeded personas (never a second schemer). This fixed preference order supersedes the design's hashed-neighbour placement (diplomacy-scenario.md §4.5).
 * - `table:<pair>`: the engine's frozen golden table for that oracle pair (diplomacy-scenario.md §5), which pins england and france; the primary seat, and any `seats[]` position, must be another power (with position `auto` the runner refuses a seed that seats the target at england or france: `run_spec_invalid`). Profile security, except `table:commitment_broken` = clean.
 * A seat listed in `seats[]` is never taken by a fill.
 */
fill?: ("house" | "robust" | "credulous" | "injector-table" | "table:manipulation_followed" | "table:commitment_broken" | "table:injection_followed" | "table:intent_leak" | "table:budget_violation" | "table:combined")
}
/**
 * (2.2.0, K7) Additional non-engine seats. The primary seat (`seat` + `target`) is unchanged; every seat listed here is driven from outside the engine, and every seat NOT listed is engine-driven (reference agents, regenerated from the seed by `verify`). This list is the ONLY source `verify` uses to decide which seats' inputs it takes from the episode record instead of regenerating them (ADR-004): an episode that claims a recorded seat the RunSpec does not declare is a mismatch. driver `target` = another agent under test (a `table` of models, Neutral Ground; `diplomacy.profile` must be `table`); its verdicts are reported per seat. (2.8.0) A Neutral Ground seat (a model at a league table) is ALWAYS driver `target` with `owner` = its provider slug, never `recorded_peer`: Neutral Ground is not a pack, has no pack id, and its seats verify as recorded, replayed target inputs. driver `recorded_peer` = a seat played by a Sixi-operated peer reached through the peer gateway (an `adversarial_peer` pack, HOSTED-PROFILE §5.2); the control plane adds these entries when it expands a pack, and the runner refuses one whose `peer.pack` is not mounted for the run. Allowed only with seat mode `power` (the Diplomacy family); positions must be distinct and differ from the primary seat's position (runner rule, `run_spec_invalid`).
 * 
 * @minItems 1
 * @maxItems 6
 */
seats?: [{
/**
 * The power this seat plays.
 */
position: ("austria" | "england" | "france" | "germany" | "italy" | "russia" | "turkey")
/**
 * target = an agent under test reached through `target`; recorded_peer = a Sixi-operated peer (LLM-driven) reached through the peer gateway named in the hosted context. Its moves are recorded inputs, never regenerated (ADR-004).
 */
driver: ("target" | "recorded_peer")
/**
 * The target descriptor of a `seats[]` entry with driver `target`: exactly the shape of the top-level `target` (contract-check mirrors it). Same rules: no secret, no userinfo, recorded verbatim in the Report.
 */
target?: {
/**
 * rest = HTTP POST of each observation frame, the action frame in the response body; ws = the arena dials a WebSocket served by the target; mcp = the target is an MCP server (streamable HTTP) exposing the `arena_act` tool; a2a = the target is an A2A agent (url = its agent card). Each binding is per-decision under the same Ds/Dh; the transport must not change the outcome (a deterministic target that misses no deadline produces the same replay_hash over every transport, Phase-7 gate criterion 2).
 */
transport: ("rest" | "ws" | "mcp" | "a2a")
/**
 * Target endpoint: http(s) for rest/mcp/a2a, ws(s) for ws. Userinfo (`user:pass@`) is rejected by the pattern; never put a token in the query string (use auth). The hosted runner refuses loopback, link-local, private, and cloud-metadata addresses after DNS resolution (target_forbidden); the local CLI allows localhost.
 */
url: string
/**
 * How the arena authenticates to the target. Omit for an unauthenticated target.
 */
auth?: {
/**
 * bearer = `Authorization: Bearer <value>`; header = `<header_name>: <value>`.
 */
scheme: ("bearer" | "header")
/**
 * A REFERENCE to a credential, never the credential. `env:NAME` = read from the runner process environment at connect time; the process never writes the value to disk, a report, or a log, and never keeps it beyond the process. `secret:name` = a named file in the local CLI's secrets directory (`AGENT_ARENA_SECRETS_DIR`). The pattern cannot match a JWT, an API key, or a bearer string, so a literal secret is schema_invalid by construction. Hosted runner (2.2.0, K6; HOSTED-PROFILE §2.4, §2.5): the ONLY accepted ref is `env:ARENA_TARGET_CREDENTIAL` for the primary target and `env:ARENA_SEAT_CREDENTIAL_<POWER>` (upper-case power name) for a `seats[]` target; the control plane delivers the value into that variable for the run only and the runner deletes it from its environment on load. `secret:` refs and every other `env:` name are refused with `run_spec_invalid` (detail.field `target.auth.ref`); there is no per-organisation stored secret (decision S4).
 */
ref: string
/**
 * Required when scheme=header.
 */
header_name?: string
}
/**
 * Human label for the target in reports (untrusted; display as data).
 */
label?: string
/**
 * (2.1.0) The caller attests that it owns, or is authorised to test, the target. The local CLI sets it with `npx @rbrus/agent-arena run --i-own-this-target`. The runner REFUSES a target whose URL does not resolve to a loopback address unless this is true (CLI: exit before any connection; hosted: 422 target_ownership_unattested). Loopback targets (localhost, 127.0.0.0/8, ::1) need no attestation. The schema keeps the field optional so every 2.0.0 RunSpec stays valid; the requirement is a runner rule (errors.md §1c). Recorded in the Report (`run.spec` and `run.target_ownership`).
 */
ownership_attested?: boolean
}
/**
 * driver recorded_peer only: which pack peer plays the seat. No endpoint, model credential or prompt appears here; the gateway origin and the model descriptor come from the hosted context.
 */
peer?: {
/**
 * Pack id (pack_manifest.schema.json `id`) of a mounted `adversarial_peer` pack. (2.8.0) Neutral Ground has no pack id: its seats are driver `target` (see `seats`), and `sx-neutral-ground` is not a pack id of any contract.
 */
pack: string
/**
 * The pack's peer agent id and version, e.g. `sixi-attack/negotiator@1.0.0`.
 */
agent: string
}
/**
 * driver target only: the owner key for `diplomacy_standard.collusion` (Neutral Ground: the provider slug). Seats with equal owners count as one owner; the primary target's owner is the literal `primary`. (2.8.0) The primary seat's owner stays the literal `primary`, never its provider slug: a seat whose provider is the primary seat's provider sets `owner: "primary"`, so one provider is one owner in every per-seat Report of a table. Recorded only as a hash (EpisodeResult roster `owner_key_hash`).
 */
owner?: string
}, ...({
/**
 * The power this seat plays.
 */
position: ("austria" | "england" | "france" | "germany" | "italy" | "russia" | "turkey")
/**
 * target = an agent under test reached through `target`; recorded_peer = a Sixi-operated peer (LLM-driven) reached through the peer gateway named in the hosted context. Its moves are recorded inputs, never regenerated (ADR-004).
 */
driver: ("target" | "recorded_peer")
/**
 * The target descriptor of a `seats[]` entry with driver `target`: exactly the shape of the top-level `target` (contract-check mirrors it). Same rules: no secret, no userinfo, recorded verbatim in the Report.
 */
target?: {
/**
 * rest = HTTP POST of each observation frame, the action frame in the response body; ws = the arena dials a WebSocket served by the target; mcp = the target is an MCP server (streamable HTTP) exposing the `arena_act` tool; a2a = the target is an A2A agent (url = its agent card). Each binding is per-decision under the same Ds/Dh; the transport must not change the outcome (a deterministic target that misses no deadline produces the same replay_hash over every transport, Phase-7 gate criterion 2).
 */
transport: ("rest" | "ws" | "mcp" | "a2a")
/**
 * Target endpoint: http(s) for rest/mcp/a2a, ws(s) for ws. Userinfo (`user:pass@`) is rejected by the pattern; never put a token in the query string (use auth). The hosted runner refuses loopback, link-local, private, and cloud-metadata addresses after DNS resolution (target_forbidden); the local CLI allows localhost.
 */
url: string
/**
 * How the arena authenticates to the target. Omit for an unauthenticated target.
 */
auth?: {
/**
 * bearer = `Authorization: Bearer <value>`; header = `<header_name>: <value>`.
 */
scheme: ("bearer" | "header")
/**
 * A REFERENCE to a credential, never the credential. `env:NAME` = read from the runner process environment at connect time; the process never writes the value to disk, a report, or a log, and never keeps it beyond the process. `secret:name` = a named file in the local CLI's secrets directory (`AGENT_ARENA_SECRETS_DIR`). The pattern cannot match a JWT, an API key, or a bearer string, so a literal secret is schema_invalid by construction. Hosted runner (2.2.0, K6; HOSTED-PROFILE §2.4, §2.5): the ONLY accepted ref is `env:ARENA_TARGET_CREDENTIAL` for the primary target and `env:ARENA_SEAT_CREDENTIAL_<POWER>` (upper-case power name) for a `seats[]` target; the control plane delivers the value into that variable for the run only and the runner deletes it from its environment on load. `secret:` refs and every other `env:` name are refused with `run_spec_invalid` (detail.field `target.auth.ref`); there is no per-organisation stored secret (decision S4).
 */
ref: string
/**
 * Required when scheme=header.
 */
header_name?: string
}
/**
 * Human label for the target in reports (untrusted; display as data).
 */
label?: string
/**
 * (2.1.0) The caller attests that it owns, or is authorised to test, the target. The local CLI sets it with `npx @rbrus/agent-arena run --i-own-this-target`. The runner REFUSES a target whose URL does not resolve to a loopback address unless this is true (CLI: exit before any connection; hosted: 422 target_ownership_unattested). Loopback targets (localhost, 127.0.0.0/8, ::1) need no attestation. The schema keeps the field optional so every 2.0.0 RunSpec stays valid; the requirement is a runner rule (errors.md §1c). Recorded in the Report (`run.spec` and `run.target_ownership`).
 */
ownership_attested?: boolean
}
/**
 * driver recorded_peer only: which pack peer plays the seat. No endpoint, model credential or prompt appears here; the gateway origin and the model descriptor come from the hosted context.
 */
peer?: {
/**
 * Pack id (pack_manifest.schema.json `id`) of a mounted `adversarial_peer` pack. (2.8.0) Neutral Ground has no pack id: its seats are driver `target` (see `seats`), and `sx-neutral-ground` is not a pack id of any contract.
 */
pack: string
/**
 * The pack's peer agent id and version, e.g. `sixi-attack/negotiator@1.0.0`.
 */
agent: string
}
/**
 * driver target only: the owner key for `diplomacy_standard.collusion` (Neutral Ground: the provider slug). Seats with equal owners count as one owner; the primary target's owner is the literal `primary`. (2.8.0) The primary seat's owner stays the literal `primary`, never its provider slug: a seat whose provider is the primary seat's provider sets `owner: "primary"`, so one provider is one owner in every per-seat Report of a table. Recorded only as a hash (EpisodeResult roster `owner_key_hash`).
 */
owner?: string
})[]]
/**
 * How the arena reaches the agent under test. The arena is always the CLIENT: per decision it sends one observation frame and awaits one action frame (asyncapi.yaml channel `eval_target` defines the frames and the rest/ws/mcp/a2a bindings). Recorded verbatim in the Report, so it MUST NOT contain a secret.
 */
target: {
/**
 * rest = HTTP POST of each observation frame, the action frame in the response body; ws = the arena dials a WebSocket served by the target; mcp = the target is an MCP server (streamable HTTP) exposing the `arena_act` tool; a2a = the target is an A2A agent (url = its agent card). Each binding is per-decision under the same Ds/Dh; the transport must not change the outcome (a deterministic target that misses no deadline produces the same replay_hash over every transport, Phase-7 gate criterion 2).
 */
transport: ("rest" | "ws" | "mcp" | "a2a")
/**
 * Target endpoint: http(s) for rest/mcp/a2a, ws(s) for ws. Userinfo (`user:pass@`) is rejected by the pattern; never put a token in the query string (use auth). The hosted runner refuses loopback, link-local, private, and cloud-metadata addresses after DNS resolution (target_forbidden); the local CLI allows localhost.
 */
url: string
/**
 * How the arena authenticates to the target. Omit for an unauthenticated target.
 */
auth?: {
/**
 * bearer = `Authorization: Bearer <value>`; header = `<header_name>: <value>`.
 */
scheme: ("bearer" | "header")
/**
 * A REFERENCE to a credential, never the credential. `env:NAME` = read from the runner process environment at connect time; the process never writes the value to disk, a report, or a log, and never keeps it beyond the process. `secret:name` = a named file in the local CLI's secrets directory (`AGENT_ARENA_SECRETS_DIR`). The pattern cannot match a JWT, an API key, or a bearer string, so a literal secret is schema_invalid by construction. Hosted runner (2.2.0, K6; HOSTED-PROFILE §2.4, §2.5): the ONLY accepted ref is `env:ARENA_TARGET_CREDENTIAL` for the primary target and `env:ARENA_SEAT_CREDENTIAL_<POWER>` (upper-case power name) for a `seats[]` target; the control plane delivers the value into that variable for the run only and the runner deletes it from its environment on load. `secret:` refs and every other `env:` name are refused with `run_spec_invalid` (detail.field `target.auth.ref`); there is no per-organisation stored secret (decision S4).
 */
ref: string
/**
 * Required when scheme=header.
 */
header_name?: string
}
/**
 * Human label for the target in reports (untrusted; display as data).
 */
label?: string
/**
 * (2.1.0) The caller attests that it owns, or is authorised to test, the target. The local CLI sets it with `npx @rbrus/agent-arena run --i-own-this-target`. The runner REFUSES a target whose URL does not resolve to a loopback address unless this is true (CLI: exit before any connection; hosted: 422 target_ownership_unattested). Loopback targets (localhost, 127.0.0.0/8, ::1) need no attestation. The schema keeps the field optional so every 2.0.0 RunSpec stays valid; the requirement is a runner rule (errors.md §1c). Recorded in the Report (`run.spec` and `run.target_ownership`).
 */
ownership_attested?: boolean
}
/**
 * Free caller metadata copied into the Report (e.g. git_sha, ci_run). Untrusted; never interpreted; must not hold secrets.
 */
labels?: {
[k: string]: string
}
}

// ---- eval_episode_end.schema.json (wot:eval_episode_end:1) ----
/**
 * Opt-in terminal notice for an encounter episode in an evaluation run (the duel sends the v1 `match_end`). A 50-line target may ignore it (REST: any 2xx; its body is ignored). Carries no verdict: verdicts are computed after terminal from the record and appear only in the report.
 */
export interface EvalEpisodeEndFrame {
t: "eval_episode_end"
protocol_version: "1.0"
episode_id: string
outcome: ("clear" | "wipe" | "timeout" | "forfeit")
terminal_tick: number
replay_hash: string
}

// ---- hosted_context.schema.json (wot:hosted_context:1) ----
/**
 * (2.2.0, K9) The machine input that turns an untrusted RunSpec into a hosted run (HOSTED-PROFILE §2.3, threat-model-hosted.md §2.1). The control plane writes it at admission, signs it (`signing`, signing.md §3) and passes it to the runner next to the RunSpec; `run_spec_digest` binds the two. (2.5.0, 2.6.0; signing.md §3.1) The hosted runner reads both from read-only FILES, `agent-arena run --hosted --manifest <file> --run-spec <file>`, taken from the run's storage prefix, and from nowhere else: never from a per-execution environment override, which Cloud Run keeps in execution metadata and in the Admin Activity audit log, and never from an environment variable. signing.md §3.1 is the normative list of the variables a hosted job sets (ARENA_IMAGE_DIGEST is required) and of those that MUST be absent; a runner that finds one refuses before any I/O (hosted_context_invalid). (2.7.0) ARENA_HOSTED, set by the job template, is read: it restricts the CLI to `run --hosted`, `verify --hosted-seal` and `version` (any other command exits 3, hosted_mode_only), and signing.md §3.1.3 refuses every other variable of the ARENA_, NODE_, SSL and OPENSSL families and every proxy variable. signing.md §3.2 is the normative admission list: the control plane MUST NOT sign this document for a RunSpec or job that breaks it (a target URL with userinfo, query or fragment; a target off the verified origin or not https/wss; seats[] outside a table profile; a credential mode the RunSpec or the delivered secrets contradict; a run token over 1 h; an image not promoted or without a passing cross-check), and the runner refuses the same things. This document IS the run manifest: its digest, "sha256:" + hex(sha256(JCS(document without /signing/signature))), is the run's identity and is copied into the signed Report (`run.hosted.run_manifest.digest`, `signing.run_manifest_digest`). Not secret, and it can hold no secret by construction: every string is patterned, the credential appears only as `credential_mode`, and the credential value travels separately in ARENA_TARGET_CREDENTIAL (and ARENA_SEAT_CREDENTIAL_<POWER> per seats[] target), an environment variable backed by a per-run secret reference, never an override. Validated by `agent-arena run --hosted` before any I/O; nothing here can be relaxed by a flag, a RunSpec field or another variable.
 */
export interface HostedContextContract {
context_version: "1.0"
/**
 * The contract run id; 128 bits of randomness, never derived from the org, the origin or a time.
 */
run_id: string
/**
 * The scan this run belongs to (one scan = |scenarios| x |tiers| runs).
 */
scan_id: string
/**
 * Opaque organisation reference. Never a name.
 */
org_ref: string
/**
 * The processing region (default europe-west6). (2.9.0) An explicit list of Google Cloud regions, not a pattern: the regions in EU member states plus europe-west6 (Zürich, Switzerland), the same list the Sixi control plane enforces at startup. `europe-west2` (London, not in the EU) and every region outside the EU and Switzerland are refused. No fallback region exists (HOSTED-PROFILE §4.1). A region is added to this list on purpose, as a contract MINOR, in every copy at once (hosted_context, report run.hosted, evidence_report producer and scope, deletion_receipt; signing.md §3.2 rule M9).
 */
region: ("europe-central2" | "europe-north1" | "europe-north2" | "europe-southwest1" | "europe-west1" | "europe-west10" | "europe-west12" | "europe-west3" | "europe-west4" | "europe-west6" | "europe-west8" | "europe-west9")
issued_at: string
/**
 * "sha256:" + hex(sha256(JCS(RunSpec))) of the RunSpec the runner received (the `--run-spec` file). The runner refuses a RunSpec whose digest differs.
 */
run_spec_digest: string
/**
 * The frozen hosted network policy (allowlist mode, no private, link-local, loopback or metadata addresses, no redirects, https/wss only). Not configurable.
 */
net_policy: "hosted-v1"
/**
 * The only origins the runner may connect to: exactly one `target` (the verified origin) plus one `peer_gateway` per distinct gateway only when `peers` is present (HOSTED-PROFILE §2.6).
 * 
 * @minItems 1
 * @maxItems 7
 */
egress_allowlist: [{
/**
 * An origin: scheme, lower-case host and optional port. No path, query, fragment or userinfo.
 */
origin: string
role: ("target" | "peer_gateway")
}, ...({
/**
 * An origin: scheme, lower-case host and optional port. No path, query, fragment or userinfo.
 */
origin: string
role: ("target" | "peer_gateway")
})[]]
/**
 * How the target is authenticated (HOSTED-PROFILE §2.5). Only the mode is ever recorded, never a value.
 */
credential_mode: ("none" | "sixi_run_token" | "customer_short_lived" | "customer_long_lived")
/**
 * The report-signing key id the seal step will use; written into the Report (`run.hosted.signing_key_id`) and the SARIF, and equal to the DSSE keyid.
 */
signing_key_id: string
/**
 * The verified origin the run was allowed to reach. The runner refuses to start if it differs from the RunSpec target's origin.
 */
verified_origin: {
/**
 * An origin: scheme, lower-case host and optional port. No path, query, fragment or userinfo.
 */
origin: string
/**
 * How control of the host was proven (HOSTED-PROFILE §1.2.1).
 */
method: ("dns" | "well-known")
verified_at: string
/**
 * When the control plane re-checked the proof at admission (a result cached for at most 24 hours is accepted).
 */
checked_at: string
/**
 * Opaque id of the ownership verification record.
 */
record_id?: string
}
/**
 * Per-origin request rate cap (the runner uses min(rps_cap, 50)).
 */
rps_cap: number
/**
 * Hard stop of the run (plan cap, never more than episodes x 120 x Dh + 10 minutes).
 */
wall_clock_deadline: string
/**
 * The runner image, pinned by digest, never a tag (HOSTED-PROFILE §2.2). (2.6.0) The runner proves which image it is from the job-template variable ARENA_IMAGE_DIGEST = "<index>,<platform manifest>" (signing.md §3.1): both digests here MUST be listed in it and `platform` MUST be the running platform, else hosted_context_invalid (detail.field `/image_digest/index`, `/image_digest/platform_manifest`, `/image_digest/platform`, or `/image_digest` when the variable is absent or malformed).
 */
image_digest: {
/**
 * The multi-arch image index digest (ghcr.io/rbrus/agent-arena@<index>), exactly as release.yml records and sandbox verify.sh prints as IMAGE_DIGEST.
 */
index: string
/**
 * The platform manifest digest actually run.
 */
platform_manifest: string
platform: ("linux/amd64" | "linux/arm64")
}
/**
 * The engine build the promoted image carries; the runner refuses to start if its own build differs.
 */
engine_build_hash: string
/**
 * Where the RunSpec seeds came from: fixed = the published gate seeds; fresh = drawn by the control plane's CSPRNG at admission; explicit = listed by the caller.
 */
seed_source?: ("fixed" | "fresh" | "explicit")
/**
 * Scenario packs mounted for the run (none = open scenarios only). (2.6.0, signing.md §11) Each is mounted read-only at `$ARENA_PACKS_DIR/<id>/pack.dsse.json` (plus its variant data files); ARENA_PACKS_DIR is required when this list is not empty.
 * 
 * @maxItems 16
 */
packs: {
id: string
version: string
/**
 * (2.6.0, signing.md §11.2) "sha256:" + hex(sha256(the exact bytes of the pack's `pack.dsse.json` envelope)), as fetched from the pack store and mounted. The runner refuses a mounted envelope whose bytes digest differently (scenario_pack_unavailable).
 */
digest: string
}[]
/**
 * LLM peer seats of an adversarial_peer pack. Each MUST match a RunSpec `seats[]` entry with driver recorded_peer (same seat, pack, agent).
 * 
 * @minItems 1
 * @maxItems 6
 */
peers?: [{
seat: ("austria" | "england" | "france" | "germany" | "italy" | "russia" | "turkey")
pack: string
agent: string
/**
 * An origin: scheme, lower-case host and optional port. No path, query, fragment or userinfo.
 */
gateway_origin: string
provider: string
/**
 * Model id as the provider reports it; unverified.
 */
model_reported: string
inference_region: string
prompt_digest: string
/**
 * Model output cap per decision (model tokens, metered by the gateway; never engine allowance tokens).
 */
max_output_tokens: number
/**
 * Per-run model-token budget of this peer, enforced by the gateway.
 */
token_budget: number
}, ...({
seat: ("austria" | "england" | "france" | "germany" | "italy" | "russia" | "turkey")
pack: string
agent: string
/**
 * An origin: scheme, lower-case host and optional port. No path, query, fragment or userinfo.
 */
gateway_origin: string
provider: string
/**
 * Model id as the provider reports it; unverified.
 */
model_reported: string
inference_region: string
prompt_digest: string
/**
 * Model output cap per decision (model tokens, metered by the gateway; never engine allowance tokens).
 */
max_output_tokens: number
/**
 * Per-run model-token budget of this peer, enforced by the gateway.
 */
token_budget: number
})[]]
/**
 * Diplomacy family only (K4): the commitments to the per-episode secrets, fixed before the run. The secrets themselves travel through the per-run secret channel, never in this document. (2.5.0) The runner receives the secrets in the environment variables ARENA_DIP_SECRET_<n>, one per episode index n = 0..count-1 (decimal, no leading zero), each exactly 64 lower-case hex characters, backed by per-run secret references and never by overrides. Before any I/O it requires exactly those `count` variables, checks each against its commitment and the list against `digest` (signing.md §4), and deletes them from its environment. A missing, extra, malformed or mismatching secret is hosted_context_invalid (detail.field `episode_secret_commitments`), and nothing is sent to the target. (2.10.0, signing.md §3.2 M10) count is at most 50 and equals the RunSpec's episodes: a hosted Diplomacy-family run plays at most 50 episodes, whatever the plan (the per-episode secret delivery of §3.1.2 is bounded by the secret store's version-add rate). The open CLI keeps the RunSpec limit of 1000 episodes.
 */
episode_secret_commitments?: {
count: number
/**
 * "sha256:" + hex(sha256(JCS(C))), C = the array of per-episode `episode_secret_commitment` strings in episode order (signing.md §4).
 */
digest: string
}
/**
 * Retention horizons applied to this run's stored data (HOSTED-PROFILE §4.2).
 */
retention: {
/**
 * 0 = digests only, no raw transcript kept.
 */
transcripts_days: number
replays_days: number
}
/**
 * The control plane's signature over this manifest (signing.md §3). The runner refuses a manifest whose signature does not verify against the pinned control-plane key.
 */
signing: {
algorithm: "ed25519"
/**
 * The control plane's run-manifest key id (a separate kid namespace from report keys, threat-model-hosted.md §5.3).
 */
signing_key_id: string
canonicalization: "jcs-rfc8785"
payload_type: "application/vnd.sixi.arena-run-manifest+json"
/**
 * The only member left out of the signed bytes. Anything else, including an empty list, is invalid: a signature can never sign itself.
 */
excluded: ["/signing/signature"]
/**
 * Standard base64 of the 64-byte Ed25519 signature over PAE(payload_type, JCS(this document without /signing/signature)) (signing.md §2).
 */
signature: string
}
}

// ---- pack_manifest.schema.json (wot:pack_manifest:1) ----
/**
 * (2.2.0, K9) The manifest of a closed Sixi Arena scenario pack (HOSTED-PROFILE §5). A pack crosses a trust boundary into the hosted runner and the evidence builder, so the parsed `pack.yaml` MUST validate against this schema (and its DSSE envelope, payload type `application/vnd.sixi.arena-pack+json`, MUST verify against the pinned control-plane key set; signing.md §11, 2.6.0) before anything in it is used. Kinds: clause_map (open oracle ids to corpus clause ids), scenario_variant (data-only `sx_` scenarios over an open module), adversarial_peer (LLM-driven peer seats, recorded inputs per K7). Load rules beyond the schema: the run's engine build MUST be in `engine.builds` (else `pack_engine_mismatch`); every clause id MUST resolve in the corpus at `corpus.ref`; (2.9.0) every clause id cited by `oracles[]` or `rules[]` MUST be in `coverage.clauses`; every rule's fixtures MUST pass the pack eval; only packs the org is entitled to are mounted. A pack never adds or renames an oracle id or a SARIF rule id, and never changes a level. (2.6.0) Packaging: the manifest, as JSON, is the payload of `pack.dsse.json` in the pack directory `$ARENA_PACKS_DIR/<id>/`; a `scenario_variant` entry's `data` file is an `arena-pack-variant/1` document (`pack_variant.schema.json`). Caps: envelope 524288 bytes, payload `x-max-frame-bytes`, variant file 65536 bytes.
 */
export interface PackManifestContract {
manifest_version: "1.0"
/**
 * Stable pack id, never reused. (HOSTED-PROFILE §5.3 writes this key as `pack:`; the contract name is `id`, matching `run.hosted.packs[].id`.)
 */
id: string
/**
 * SemVer: a new clause mapping or rule = MINOR; a changed condition = MAJOR.
 */
version: string
/**
 * @minItems 1
 * @maxItems 3
 */
kinds: [("clause_map" | "scenario_variant" | "adversarial_peer"), ...(("clause_map" | "scenario_variant" | "adversarial_peer"))[]]
title: string
licence: string
/**
 * The engine build range the pack is valid for.
 */
engine: {
/**
 * The exact engine build hashes the fixtures were run on. The runner refuses every other build (`pack_engine_mismatch`).
 * 
 * @minItems 1
 * @maxItems 32
 */
builds: [string, ...(string)[]]
/**
 * engine.version range, for discovery only (e.g. ">=arena@2.1.0 <arena@3.0.0"). `builds` is what is enforced.
 */
versions: string
/**
 * Contracts range the pack targets (e.g. ^2.2.0).
 */
contracts: string
}
/**
 * The clause corpus snapshot (`sixi-ai/sixi-assure-rules`).
 */
corpus: {
repo: string
/**
 * The corpus commit every clause id resolves against.
 */
ref: string
lenses: {
atlas: string
}
}
/**
 * The regimes the pack cites. Closed set for this contract release: ATLAS is a lens, not a regime (HOSTED-PROFILE §5.4, Q1). Every clause id's regime MUST be listed here (load rule).
 * 
 * @minItems 1
 * @maxItems 8
 */
regimes: [("OWASP" | "AIACT"), ...(("OWASP" | "AIACT"))[]]
/**
 * Key in corpus/disclaimers.json.
 */
disclaimer: string
/**
 * The pack-wide reproducibility statement (HOSTED-PROFILE §5.5); scenarios set their own `trials`.
 */
reproducibility: {
method: "reproduced_n_of_m"
/**
 * M counts only episodes where the oracle was assessed; not_assessed episodes go to the not-assessed list.
 */
count_basis: "assessed_episodes"
show_distinct_trajectories: true
}
/**
 * @maxItems 32
 */
scenarios?: {
/**
 * A variant: a new `sx_` scenario id (never reused), data over `base`. An overlay: an open scenario id, with `peers` seated in it and no `base` or `data`.
 */
id: string
/**
 * Variant only: the open scenario module the variant parameterises (same engine build; a variant needing new engine code is not a pack).
 */
base?: string
scenario_version: string
/**
 * @minItems 1
 * @maxItems 4
 */
seat_modes: [("duel" | "member" | "squad" | "power"), ...(("duel" | "member" | "squad" | "power"))[]]
/**
 * @minItems 1
 * @maxItems 3
 */
tiers: [("edge" | "core" | "frontier" | "extended"), ...(("edge" | "core" | "frontier" | "extended"))[]]
/**
 * Variant only: the parameter and template data file, pinned by digest.
 */
data?: {
/**
 * A path relative to the pack root; no `..` sequence, no leading `/`.
 */
ref: string
digest: string
}
/**
 * @minItems 1
 * @maxItems 6
 */
peers?: [{
/**
 * Which reference seat the peer replaces: a role of the base scenario's roster (e.g. `schemer`, `injector`) or a power.
 */
seat: string
driver: "recorded_peer"
/**
 * K7: the peer's moves are recorded inputs; `verify` never regenerates them (ADR-004).
 */
inputs_source: "llm_peer"
agent: string
/**
 * The model endpoint the Sixi peer gateway calls (through the residency chokepoint). The provider key is never in a pack.
 */
model: {
provider: string
model: string
region: string
}
/**
 * Digest of the sealed prompt template; the template itself stays in the gateway.
 */
prompt_digest: string
max_output_tokens: number
}, ...({
/**
 * Which reference seat the peer replaces: a role of the base scenario's roster (e.g. `schemer`, `injector`) or a power.
 */
seat: string
driver: "recorded_peer"
/**
 * K7: the peer's moves are recorded inputs; `verify` never regenerates them (ADR-004).
 */
inputs_source: "llm_peer"
agent: string
/**
 * The model endpoint the Sixi peer gateway calls (through the residency chokepoint). The provider key is never in a pack.
 */
model: {
provider: string
model: string
region: string
}
/**
 * Digest of the sealed prompt template; the template itself stays in the gateway.
 */
prompt_digest: string
max_output_tokens: number
})[]]
/**
 * How this scenario's findings state reproducibility.
 */
reproducibility: {
/**
 * Findings are reported as "reproduced N of M" (HOSTED-PROFILE §5.5): M = episodes where the oracle was assessed (pass or fail) for the seat, N = those where the rule held; not_assessed episodes are never counted in M; the number of distinct trajectories is always shown next to it.
 */
method: "reproduced_n_of_m"
/**
 * Repeats of each seed with the peer re-sampled (M for LLM-peer findings). 0 = reproduction not measured (run-level oracles, deterministic scenarios without peers).
 */
trials: number
}
}[]
/**
 * clause_map: open oracle id -> clause citations and ATLAS technique labels.
 * 
 * @maxItems 128
 */
oracles?: {
/**
 * An oracle id = SARIF rule id (`<open scenario>.<oracle>`, `shared.<oracle>`, `harness.<oracle>`). Pack scenarios reuse the base scenario's oracle ids; a pack never mints a rule id.
 */
oracle_id: string
/**
 * @minItems 1
 * @maxItems 16
 */
clauses: [string, ...(string)[]]
/**
 * @maxItems 8
 */
techniques?: string[]
}[]
/**
 * @maxItems 256
 */
rules?: {
/**
 * Stable finding-rule id, never reused (e.g. SXA-BYZ-001).
 */
id: string
title: string
scope: ("verdict" | "episode" | "run")
/**
 * Every oracle id the condition reads (declared so coverage and the not-assessed list can be computed without parsing CEL).
 * 
 * @minItems 1
 * @maxItems 8
 */
oracles: [string, ...(string)[]]
/**
 * A CEL expression over the typed Report model (variables r, e, v and the count helpers). Closed environment, cost- and time-limited. No model and no heuristic creates a finding.
 */
condition: string
/**
 * Evidence-view severity only; never changes a SARIF level.
 */
severity: ("critical" | "high" | "medium" | "low")
/**
 * Template over ids and counts only ({{v.oracle_id}}, {{n}}, {{m}}, {{v.seat}}); never target or peer text.
 */
message: string
/**
 * @minItems 1
 * @maxItems 16
 */
clauses: [string, ...(string)[]]
/**
 * ATLAS technique labels (lens). HOSTED-PROFILE §5.3 writes these as `lenses: {atlas: [...]}`; the contract name is `techniques[]`.
 * 
 * @maxItems 8
 */
techniques?: string[]
remediation: string
/**
 * Both are required; the pack eval must show the positive fixture fires and the negative does not.
 */
fixtures: {
/**
 * A path relative to the pack root; no `..` sequence, no leading `/`.
 */
positive: string
/**
 * A path relative to the pack root; no `..` sequence, no leading `/`.
 */
negative: string
}
/**
 * @maxItems 8
 */
tags?: string[]
}[]
/**
 * The clauses the pack claims to bear on. Feeds the not-assessed enumeration: a clause here that no assessed oracle of a run maps to is listed as not assessed (Report `not_assessed`, kind clause). (2.9.0, load rule; signing.md §11.3 step 6a) Coverage includes the clause map: `coverage.clauses` MUST contain every clause id that `oracles[].clauses` or `rules[].clauses` cites (coverage ⊇ clause map ∪ rule clauses). A pack that cites a clause outside its coverage is refused (`scenario_pack_unavailable`), because the not-assessed enumeration walks `coverage.clauses`: a mapped clause missing there would never be listed as not assessed when its oracles were not assessed. The reverse is not required: coverage MAY list a clause no oracle maps, and such a clause is always listed as not assessed (`clause_not_mapped_in_run`), never as assessed. JSON Schema cannot state inclusion between two arrays, so the rule is enforced by the pack eval, the hosted runner's pack load and the evidence builder, and `tools/contract-check.mjs` checks it on every pack example.
 */
coverage: {
/**
 * @minItems 1
 * @maxItems 128
 */
clauses: [string, ...(string)[]]
}
}

