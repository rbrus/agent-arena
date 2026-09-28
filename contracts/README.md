# `contracts/` — Agent Arena (contracts `2.14.0`)

**The API is the product.** This directory is the merge-before-implementation contract of the open-core
agent evaluation arena (ADR-001). It is the **single source of truth**: the services validate against
these files at the edge, and the TypeScript types and SDK models are **generated** from them (ADR-000:
handwritten models are contract drift by definition). Contracts merge before code (MISSION §7; the
PLAN's Stage A → B).

`2.0.0` is a MAJOR release. ADR-001 (`docs/adr/ADR-001-eval-arena-pivot.md`) is its breaking-change
record; `CHANGELOG.md` lists every removal with a migration note; `versioning.md` §2 explains why the
**frame protocol stays `1.0`** (the 50-line agent is untouched) while the contract release is MAJOR.

---

## File map

| File | What it is | Standard |
|---|---|---|
| `openapi.yaml` | Management plane (REST): passports (register, rotate, revoke), OAuth token + RFC 8693 delegation + JWKS, **scenarios** (`/v1/scenarios*`), **evaluation runs** (`/v1/runs*`: submit a RunSpec, poll, episode results, Report as JSON or SARIF), the duel queue, match summaries + replays, raids (boss catalog, squads, raid queue, raid summaries), Negotiation Chambers, webhook registration + the outgoing `webhooks:`. | OpenAPI 3.1 |
| `asyncapi.yaml` | Data plane (WSS): the duel **play loop** (`arena`), the **encounter** loop (`raid`), the **evaluation-run target session** (`eval_target`: how the arena drives an agent under test over rest / ws / mcp / a2a), the **Diplomacy table session** (`diplomacy_table`, 2.4.0: an agent dials in and plays its seat at a server-created table), and the deprecated **broadcast** (`spectator`). | AsyncAPI 3.0 |
| `schemas/*.schema.json` | One JSON Schema per WSS frame (inbound and outbound, each with `x-max-frame-bytes`), the REST error envelopes, the webhook envelope, and the evaluation-run documents `run_spec`, `episode_result`, `report`. Since `2.1.0` also the Diplomacy frames (`diplomacy_observation`, `diplomacy_action`, `diplomacy_episode_end`) and records (`diplomacy_press_message`, `diplomacy_press_reject`, `diplomacy_offer`, `diplomacy_commitment`, `diplomacy_renounce`, `oracle_evidence`). Since `2.4.0` the Diplomacy table-session frames `diplomacy_hello` (`wot:hello:diplomacy:1`) and `diplomacy_session_ack` (`wot:ack:diplomacy:1`). | JSON Schema 2020-12 |
| `fixtures/diplomacy_press_cases.json` | (2.1.0) Must-reject corpus for the Diplomacy press layer: frame + engine context + required outcome; checked here, replayed by the implementation test. (2.5.0) Two more cases, marked `since`: `clause_beyond_horizon` (context `horizon_year`) and a renounce of an ended commitment (context `ended_commitments`). | — |
| `schemas/{hosted_context,pack_manifest,crosscheck_record,evidence_report,bundle_manifest}.schema.json` | (2.2.0) The Sixi Arena hosted profile: the signed run manifest (hosted context), the scenario-pack manifest, the signed cross-check record, the machine-readable evidence report, and the bundle manifest (HOSTED-PROFILE.md §0.1). | JSON Schema 2020-12 |
| `schemas/deletion_receipt.schema.json` | (2.5.0) The signed receipt of a hosted deletion (run, scan, data before a date, organisation): what was deleted, when, what is retained and why, and the backup horizon. Signed with the report key, payload type `application/vnd.sixi.arena-deletion+json` (signing.md §9). | JSON Schema 2020-12 |
| `signing.md` | (2.2.0) Canonical form (RFC 8785 JCS), the signed message (DSSE PAE + Ed25519), the run-manifest digest, Diplomacy secret commitments, and the contract tests. (2.4.0) §7 press signatures (passport key, detached JWS, header allow-list, payload, `sig_mode`), §8 Negotiation Chamber signatures. (2.5.0) §9 deletion receipts. (2.6.0) §3.1 the hosted runner's environment (`ARENA_IMAGE_DIGEST`, the variables that MUST be absent), §5.1 the hosted bundle layout and `verify --hosted-seal`, §10 run tokens (`at+jwt`, EdDSA), §11 scenario packs (envelope `application/vnd.sixi.arena-pack+json`, layout, load order, must-rejects). (2.7.0) §3.1.3 guarded name families, §3.2 hosted admission (normative for the control plane), §10 run-token lifetime cap. (2.11.0) §3.3 the pinned key set (what an open release bundles, the key window, rotation, `verify --key pinned`), §5.2 signed digest statements (payloads over the 65536-byte KMS limit, `ARENA_SIGN_MAX_MESSAGE_BYTES`). (2.12.0) §5.1.1 `verify --hosted-seal --result` (the result file the seal step reads), §5.2 reason tokens for malformed envelopes, non-base64 payloads, a foreign raw `keyid` and a disallowed `signed_form`, §5.3 the seal order and the evidence report (rendered after the report and SARIF are signed, never listing `bundle-manifest.json`). (2.13.0) §5.3 step 4: the renderer is the open CLI's `agent-arena evidence`, its seal-side facts come from `evidence_input.schema.json`, and seal time, region, organisation, origin, image digest, engine build and key id from the signed report only. | RFC 8785, DSSE v1, RFC 8032, RFC 7515, RFC 9068 (media type), RFC 6750 |
| `schemas/pinned_keys.schema.json` | (2.11.0) `agent-arena-pinned-keys/1`, the control-plane key set an open release bundles (signing.md §3.3): the `?purpose=manifest` and `?purpose=report` JWKS bodies as served, public Ed25519 keys with derived kids and windows of at most 120 days, no run-token key. Its example is the set pinned on 2026-09-27. | JSON Schema 2020-12, RFC 7517, RFC 7638, RFC 8037 |
| `schemas/digest_statement.schema.json` | (2.11.0) The signed digest statement (signing.md §5.2): payload type, sha256 and length of a covered payload, its run binding and seal time, signed with payload type `application/vnd.sixi.arena-digest-statement+json` in place of a payload whose PAE message is over 65536 bytes. | JSON Schema 2020-12, DSSE v1 |
| `fixtures/digest_statement_vectors.json`, `fixtures/digest_statement/bundle-manifest.json` | (2.11.0) 23 vectors for §5.2 (RFC 8032 test key): raw and statement forms over one small and one 80070-byte payload, the embedded report and cross-check forms, and must-rejects; `tools/digest-statement-vectors.mjs` regenerates them. | DSSE v1, RFC 8032 |
| `schemas/verify_result.schema.json` | (2.12.0) The file `verify --hosted-seal --result <path>` writes: byte for byte the `--json` document, for every exit 0-2 and for a misuse found after the path was accepted (signing.md §5.1.1). The Sixi seal step reads the seal precondition from it and from nothing else. | JSON Schema 2020-12 |
| `schemas/evidence_input.schema.json` | (2.13.0) The document `agent-arena evidence --inputs <path>` reads (the Sixi seal step's `render/input.json`): the facts the evidence renderer needs and the signed report does not carry (`jwks_url`, the admission record's dates, actor and incident reference, the cross-check record, the corpus snapshot). Closed at every level; `run_id` must equal the report's. HOSTED-PROFILE §2.7 step 6 gives the command, the mounts and the exit codes. | JSON Schema 2020-12 |
| `schemas/pack_variant.schema.json` | (2.6.0) `arena-pack-variant/1`, the data file of an `sx_` scenario variant: an optional pinned tier, fixed seeds, and oracle thresholds of the base's own oracles. Data-only, 65536 bytes. | JSON Schema 2020-12 |
| `fixtures/packs/sx-agentic-core/` | (2.6.0) A loadable pack directory: `pack.dsse.json` (the pack example signed with the RFC 8032 test key) and `variants/deadlock-hard.json`. Regenerated by `tools/signing-vectors.mjs`. (2.9.0) Its `engine.builds` is a placeholder, so a real runner refuses it with `pack_engine_mismatch`; a harness re-signs a copy with `node contracts/tools/signing-vectors.mjs --engine-build sha256:<hex> --out <dir>` (signing.md §11.4). | DSSE v1 |
| `fixtures/hosted_env.json` | (2.6.0) The hosted environment contract of signing.md §3.1 in machine-readable form (job-template variables, secret variables, the must-be-absent lists, `ARENA_IMAGE_DIGEST` cases) for implementation tests. (2.7.0) `ARENA_HOSTED` is read, and `guarded_families` (signing.md §3.1.3) with test cases. | — |
| `fixtures/signing_vectors.json`, `fixtures/hosted_report.sarif` | (2.2.0) Ed25519 test vectors over the signed examples (RFC 8032 test key, not a Sixi key; `tools/signing-vectors.mjs` regenerates them), and the hosted SARIF golden rendered from `report.schema.json` `examples[2]`. (2.5.0) `receipt_vectors`; (2.6.0) `pack_vectors` and `run_token_vectors`. | — |
| `fixtures/press_signing_vectors.json` | (2.4.0) Press-signature vectors (signing.md §7): detached EdDSA JWS over the JCS press payload with the RFC 8032 test key, accepted and must-reject (forged header members, wrong field order, scenario id, abbreviated power, moved position); `tools/signing-vectors.mjs` regenerates them. | RFC 7515, RFC 8037, RFC 8785 |
| `sarif-mapping.md` | Report → SARIF 2.1.0: rule ids, the level table, `not_assessed` handling, fingerprints, untrusted-content rules, a worked example. (2.8.0) §2.3 the shared rule `shared.participation` and the reserved `diplomacy_standard.participation`. | SARIF 2.1.0 |
| `errors.md` | Error taxonomy: REST codes, OAuth errors, WSS reject reasons + per-unit coercions, close codes, the codes removed in `2.0.0`. | — |
| `webhooks.md` | Webhook delivery: envelope, HMAC `WoT-Signature`, retry/backoff, idempotency. | — |
| `versioning.md` | SemVer + frame / `$id` policy, with a worked example per release. | — |
| `CHANGELOG.md` | Change history; consumed by sdk-engineer + lore-docs-writer. | — |
| `RESERVED.md` | Surfaces named but not yet specified, and the names retired in `2.0.0`. | — |
| `tools/contract-check.mjs` | Contract checks beyond Tier 0 (see below). | — |

---

## The evaluation run (new in `2.0.0`)

```
  RunSpec (schemas/run_spec.schema.json)          ─▶  local CLI: npx @sixi4ai/agent-arena run --spec run.json
    scenario_id · seeds[] · episodes                   hosted:    POST /v1/runs   (scope eval:run, Phase 9)
    budget_tier: edge | core | frontier | extended  (fixed Ds / Dh / token allowance per controlled seat)
    seat: duel | member(m0..m4, fill) | squad
    target: { transport: rest|ws|mcp|a2a, url, auth: { scheme, ref: env:NAME | secret:name } }
                         │
                         ▼   per episode, per decision (asyncapi.yaml channel eval_target)
  arena ── observation ─▶ agent under test      duel: the v1 observation / action / match_end frames verbatim
  arena ◀── action ────── agent under test      encounters: eval_raid_observation / eval_raid_action / eval_episode_end
                         │
                         ▼
  EpisodeResult × N (schemas/episode_result.schema.json)
    outcome · terminal_tick · replay_hash · trajectory_class · budget counters
    oracles[]: { oracle_id <scenario|shared|harness>.<name>, seat, verdict pass|fail|not_assessed,
                 severity error|warning|note, basis resim|attested, measures, thresholds, evidence_ref }
                         │
                         ▼
  Report (schemas/report.schema.json) ── sarif-mapping.md ──▶ report.sarif (GitHub code scanning)
    run + spec · engine build_hash · scenario version + oracle catalog · budget_limits ·
    episodes[] · run_oracles[] · summary (verdict, effective_episodes) · disclosure (conflict of interest)
```

**Load-bearing invariants:**

- **Pillar 9: the referee runs no model.** Every opponent, boss and reference squadmate is scripted, and
  every `resim` verdict is a pure function of `(seed, tier, inputs, blinding key)`, recomputed
  bit-for-bit by `npx @sixi4ai/agent-arena verify`. No field anywhere implies platform-side inference.
  "Tokens" are the engine's action-allowance units, never model tokens.
- **Budget tiers are measurement standards.** Their limits are fixed in `run_spec` `budget_tier`;
  changing one is MAJOR + ADR (results would stop being comparable).
- **`not_assessed` is never a pass**, in the Report summary and in SARIF.
- **No ground truth reaches the target.** The encounter egress frames are whitelist projections:
  no `real` flags, blinded reading ids, advisories in member order, hidden Split-Brain members absent,
  an opaque episode id (docs/design/arena-scenarios.md §1.4). `tools/contract-check.mjs` has negative
  cases for each leak.
- **Targets are untrusted, and so is everything they send.** The RunSpec holds no secret (auth is a
  `env:`/`secret:` reference, enforced by pattern); target free text is dropped before recording and
  never reaches a report or SARIF; the hosted runner refuses private and metadata addresses
  (`target_forbidden`).
- **Transport never changes the hash.** Replaying a record always reproduces its `replay_hash`;
  re-running a live target reproduces it only if the target is deterministic and misses no deadline
  (every Report says so in `disclosure.determinism`).

## The play planes (kept from `1.x`)

- **Duel** (`arena` channel): `hello` → `observation` → `action` → `ack`/`reject` → `match_end`.
  Queue with `POST /v1/queue` (`league` = the budget tier). Unchanged frames.
- **Encounters** (`raid` channel): the six failure-mode bosses as co-op squads on delegated child
  tokens (`POST /v1/oauth/token/exchange`; child scope ⊆ parent, depth ≤ 1, revocation cascades).
- **Replays**: `GET /v1/replays/{id}` — seed + inputs + per-tick state hashes; the replay inspector's
  input.
- **Negotiation Chambers** (`/v1/negotiations*`, scope `negotiate:a2a`): signed offer / counter /
  accept / withdraw over scenario-scoped `Commitment` terms; an accept **binds** an agreement
  (`agreement_hash`) — nothing is escrowed. Phase 8 extends it additively (`2.1.0`).
- **Deprecated**: the `spectator` broadcast and `GET /v1/matches`.

## The 50-line-agent minimal path

The minimal observe → act loop needs only **four** frames: `hello`, `observation`, `action`,
`match_end`. Everything else is opt-in.

```python
# Pseudocode — the entire competitive loop against the live arena. No ack/reject handling required.
tok    = POST("/v1/oauth/token", client_credentials).access_token
ticket = POST("/v1/queue", {"mode": "duel", "league": "core"})
ws     = connect(ticket["arena_url"])
ws.send({"t": "hello", "protocol_version": "1.0", "token": tok,
         "mode": "duel", "ticket_id": ticket["ticket_id"]})

while True:
    msg = ws.recv()
    if msg["t"] == "observation":
        units = []
        for u in msg["you"]["units"]:                  # reflex policy:
            tgt = msg.get("attacks", {}).get(u["unit_id"])
            if tgt:                                     #   attack if something's in range
                units.append({"unit_id": u["unit_id"], "verb": "attack", "target": tgt[0]})
            elif msg.get("reachable", {}).get(u["unit_id"]):
                units.append({"unit_id": u["unit_id"], "verb": "move", "steps": ["N"]})
        ws.send({"t": "action", "protocol_version": "1.0", "match_id": msg["match_id"],
                 "turn_id": msg["turn_id"], "nonce": msg["nonce"], "units": units})  # echo turn_id + nonce
    elif msg["t"] == "match_end":
        break
```

Under evaluation (`transport: rest`), the same policy is an HTTP handler: the arena POSTs each
`observation` frame and the response body is the `action` frame. No `hello`, no token handling.

---

## How the pieces reference each other

- `asyncapi.yaml` message payloads and `openapi.yaml` bodies `$ref` the files in `schemas/`. **The
  schemas are the one place a frame shape or a size limit is defined** (`x-max-frame-bytes`).
- Schemas are **self-contained** (no cross-file `$ref`) so codegen and the edge validators can load one
  file at a time. `report` embeds exact copies of `run_spec` and `episode_result` under `$defs`; drift
  fails `tools/contract-check.mjs`.
- **Fog contract** (security-critical): hidden info is **absent, never null**; every outbound
  observation is `additionalProperties: false` so a stray field cannot leak. Build observations by
  whitelist projection, never by redacting full state.
- **Anti-replay:** the observation's unpredictable `nonce` and `turn_id` must both be echoed.

---

## Contract checks (CI — the api-architect Definition of Done)

**Tier 0 — self-consistency** (`cd ascension && npm run contracts:tier0`): every schema compiles under
AJV 2020-12 strict, every schema's `examples[]` validates, every `./schemas/` ref in the specs resolves,
and the OAuth scopes appear in the `Scope` enum.

**Contract checks** (`node contracts/tools/contract-check.mjs`, from the repo root; uses the AJV and
js-yaml already installed under `ascension/`):
1. **Mirrors** — `report.$defs.run_spec` / `$defs.episode_result` equal their source schemas.
2. **OpenAPI examples** — every request/response example (inline or `$ref`) validates against its
   media-type schema, resolving `#/components/...` and `./schemas/...` refs.
3. **Negative cases** — documents the eval schemas MUST reject: literal secrets, userinfo URLs,
   transport/URL mismatch, incoherent seats, a fail without evidence, a `not_assessed` without a
   reason or with a fail severity, an aborted episode with a pass, un-namespaced oracle ids, ground-truth
   leaks in the egress observation (`real`, unblinded ids, raid ids, seeds), an `ability` verb or a
   client-declared cost in the egress action.
   Since 2.1.0 also the Diplomacy must-rejects: oversize press, press outside a round, self-accept,
   self-addressing, a commitment whose offer is not the proposer's (unknown offer), a renounce naming an
   offer, spoofed senders, another power's intent or the canary registry in an observation, prose in
   evidence, and the new RunSpec / EpisodeResult / Report conditionals.
4. **Diplomacy mirrors (2.1.0)** — records embedded in frames equal their source schemas, and a `$def`
   name means the same body in every `diplomacy_*` schema.
5. **Press corpus (2.1.0)** — `fixtures/diplomacy_press_cases.json` is schema-valid or schema-invalid
   exactly as annotated, and names only defined reject codes.
6. **Lint (2.1.0)** — every example signature and codeword contains `EXAMPLE`; no contract file uses a
   conformity-claim word from the checker's list (the arena measures; it does not attest conformity).
7. **2.4.0** — `signing_key` must-rejects (kid not 43 base64url chars, `d` missing, wrong key type or use), the
   Diplomacy hello (never names a power) and session ack, live-only observation `offers`, RunSpec
   `diplomacy.fill` against `profile`, and the press-signature vectors replayed by an independent verifier
   written from signing.md §7 (every OpenAPI `signing_key.d` example contains `EXAMPLE`).
8. **2.5.0** — the `clause_beyond_horizon` reject (offers and counters only; a phase after 1908 is `schema_invalid` at
   the edge), the clause settlement linkage over every commitment in the contracts (per-phase `settlements` in phase
   order, the aggregate `status`, `settled_phase`/`settled_tick` = the last settlement, `state` against escrowed
   clauses, `renounced` settlements only from `releases_from_phase` on and after the renounce), `releases_from_phase`
   `S1909M`, the Diplomacy hello size bound (the largest schema-valid hello fits in 2048 bytes), `budget.press.redactions`,
   and the SARIF review sentence keyed off the verdict flag. Also the SARIF not-applicable set on the hosted golden,
   evidence `unresolved_clauses` (cited nowhere else), the cross-check anchor leg and `scope: local` (no H, leg V
   empty, never promotes), and the signed deletion receipt (scope conditionals, timestamps against the backup horizon,
   field mirrors of the hosted context, and a test vector in `fixtures/signing_vectors.json` `receipt_vectors`).
9. **2.6.0** — the run-token vectors (`run_token_vectors`: 4 accepts, 17 must-rejects) replayed by a verifier written
   from signing.md §10; the fixture pack opened as signing.md §11.3 says (digest pin, payload type, signature, schema,
   variant digest and schema, engine build), with envelope must-rejects (wrong payload type, unsigned, a signature for
   another payload, a tampered payload, a pin mismatch, over the cap) and traversal must-rejects on the pack id and
   the data ref; `pack_variant` must-rejects; the signing.md §3.1 tables against `fixtures/hosted_env.json` and the
   `ARENA_IMAGE_DIGEST` cases; the §5.1 bundle-list rule; and a lint that no contract text still offers the withdrawn
   env form of the run manifest or RunSpec.
10. **2.7.0** — the run-token lifetime cap (two more must-rejects, 23 tokens in all, each new one shown to be valid
   apart from the cap and to break exactly one bound); the guarded name families of signing.md §3.1.3 against
   `fixtures/hosted_env.json`; the `ARENA_HOSTED` row read in both places and `hosted_mode_only` in errors.md; every
   hosted-admission rule id of signing.md §3.2 present once; the `observed_truncated` example at a cap; the
   cross-check `anchor_id` grammar (the pre-2.7.0 example refused, the runner's spellings accepted); and the
   `architectBearer` security scheme, with no pre-ADR-003 identity-provider name left in the live contract files.
11. **2.8.0** — `shared.participation` (sarif-mapping.md §2.3): 14 must-rejects against the verdict conditionals of
   `episode_result` and its `report` mirror (severity, evidence code and first/last ticks, `basis`, reason codes) and a
   RunSpec naming the reserved `league` tier; the positive spellings (`[t, t]`, `never_actable`, `episode_aborted`);
   every raid or duel example at scenario 1.2.0 / 1.1.0 with the rule in catalog position and matching summary
   tallies; no Diplomacy example or golden carrying a participation rule; close `4408` `seat_timeout` specified in
   errors.md and asyncapi.yaml and no longer reserved; the Neutral Ground decisions stated in `run_spec` and no
   `sx-neutral-ground` pack id in any example.
12. **2.9.0** — the hosted region enum: exactly the twelve EU + Zürich regions the Sixi control plane enforces, one
   identical copy in `hosted_context`, `report` `run.hosted`, `evidence_report` `producer` and `scope`, and
   `deletion_receipt`, no `^europe-` pattern left, must-rejects for `europe-west2` (London), `us-east1`, a mixed-case and a
   padded spelling, and every listed region accepted in every copy; the pack coverage rule (signing.md §11.3 step 6a:
   `coverage.clauses` ⊇ every clause the clause map or a rule cites) on every pack example and on the signed fixture
   payload, with must-rejects; the fixture's placeholder engine build recorded in `pack_vectors`, and the harness
   `--engine-build` re-sign documented.
13. **2.10.0** — the `extended` budget tier (Ds 15000 ms, Dh 30000 ms, allowance 540) in every tier enum and copy
   (`run_spec` and its `report` mirror, `episode_result` and its mirror, `report` `budget_limits`, `evidence_report`
   `budget_tier`, `tiers_not_run` and the SARIF category pattern, `crosscheck_record` `budget_tier`, `pack_manifest`
   `tiers`, `pack_variant` `tier`, openapi `BudgetTier` / `BudgetTierLimits` and the catalog example); `league`
   refused everywhere a tier is read, `extended` accepted; the cross-check `anchor_id` grammar keeps three tiers (no
   frozen anchor at `extended`); the hosted caps of signing.md §3.2 A6 (an `extended` run plays one episode) and M10
   (a Diplomacy-family run plays at most 50, `episode_secret_commitments.count` ≤ 50 and equal to `episodes`), each
   with must-rejects on the report conditionals and on a verifier written from the rule text; `ARENA_DIP_SECRET_<n>`
   with `n` ≤ 49 in `fixtures/hosted_env.json`; the live queue `League` keeps three tiers.
14. **2.11.0** — the pinned key set (signing.md §3.3): `pinned_keys.schema.json` over its example and over the file the
   CLI bundles (`packages/arena-cli/src/hosted/pinned-keys.json`), plus the rules JSON Schema cannot say (each set's body
   reproduces its `source_sha256`; set sources; kids unique and no key in both sets; windows of at most 120 days; kid =
   namespace + 80-bit RFC 7638 thumbprint hex; `sixi_thumbprint`; canonical `x`), 29 must-rejects each re-sealed to
   break one rule, and the key-window boundary vectors of rule 3. Signed digest statements (signing.md §5.2): the 23
   vectors of `fixtures/digest_statement_vectors.json` replayed with a verifier written from steps D1-D9 and E1-E4 (each
   reject for the reason it names), the large payload schema-valid and over `ARENA_SIGN_MAX_MESSAGE_BYTES`, the raw
   report vector byte-identical to `signing_vectors.json`, and statement / `signed_form` schema must-rejects.
15. **2.12.0** — `verify_result.schema.json` over its five CLI-produced examples, must-rejects for each status/exit
   pairing, and the seal precondition of signing.md §5.1.1 rule 6 evaluated from the text (only the `verified` example
   passes); the §5.2 clarifications (malformed envelope → `signature`, non-base64 payload → `payload_mismatch` /
   `statement_malformed`, foreign raw `keyid` → `binding`, unknown or disallowed `signed_form` → `form_mismatch`)
   replayed on mutated vectors; the evidence render order of §5.3 (no example lists `bundle-manifest.json`, two
   entries validate, the deprecated member still validates); the prose.
16. **2.13.0** — `evidence_input.schema.json`: its cap, direction and `$id`; its three examples (example[0] equal to the
   CLI's fixture `packages/arena-cli/test/fixtures/sixi-pr7c/render/input.json` but for the `EXAMPLE` signature, every
   example's `crosscheck_record` valid against `crosscheck_record.schema.json`); must-rejects for every bound and pattern,
   an unknown member at every level, each seal fact the signed report carries offered as an input member, and a
   cross-check record that fails its own schema; the CLI compiles the contract file and defines no schema in code; the
   prose (HOSTED-PROFILE §2.7 step 6 names the command, the mounts, `create-only`, the four exits and never
   `bundle-manifest.json`; signing.md §5.3 step 4 names the renderer and the report-only facts; errors.md §1d has the three
   rows at exit 2 with the `not_rendered:<code>` next step; Appendix A lists them).
17. **2.14.0** — the tool identity: every `tool.name` / `tool.driver.name` in a schema example, an OpenAPI example,
   `fixtures/hosted_report.sarif` and the sarif-mapping.md excerpt is `@sixi4ai/agent-arena`, every `informationUri` is
   still the GitHub repository; the CLI's package name and the report writer's `TOOL_NAME` agree; no contract file but
   `CHANGELOG.md` names the previous npm scope.

Recommended wiring (platform-engineer, Phase-7 A5): run both in the CI job that runs Tier 0.

**Tier 1 — implementation conformance** (sim-qa + platform, Stage B/C): drive each REST operation and
assert responses validate; every server-emitted frame validates against its schema; every documented
reject reason is reachable; oversized and unknown-field inbound frames are refused at the edge; the
auth/scope matrix (e.g. a token without `eval:run` is refused on `/v1/runs`); fog and egress leakage
(arena-scenarios.md §1.4 differential property); determinism (`verify` round-trips a Report); and
`report.sarif` validates against the SARIF 2.1.0 schema and uploads to GitHub code scanning (Phase-7
gate criterion 4).

---

## Consuming these contracts (Phase 7 Stage B)

- **B0 (platform, the cut):** delete the code of every surface in `RESERVED.md` "Removed"; stop
  emitting the removed `match_end`/`raid_end` fields; drop the removed scopes from token issuance.
  Note that the runtime validators under `ascension/packages/wot-contracts/src/` load schema files by
  name — `caster-validators.ts` references schema files deleted in `2.0.0` and goes with the cut.
- **B1 (sdk, CLI):** `run_spec` is the CLI's `--spec` input; `report` + `sarif-mapping.md` its outputs;
  `eval_target` its transport bindings. Never persist a resolved `env:` secret.
- **B2 (arena, scenario adapters):** the egress builders must produce exactly
  `eval_raid_observation` (member ids `m0..m4`, blinded ids, canonical advisory order, L5 filtering)
  and accept exactly `eval_raid_action`; oracle ids follow the namespaced form.
- **B3 (sim-qa, reports):** the Report and the SARIF rendering, including `effective_episodes` and the
  `not_assessed` rules; the golden-file test in `sarif-mapping.md` §8.
- **B5 (spectator, replay inspector):** reads `report.json` + episode records; renders agent-authored
  text as inert plain text.
- **lore-docs-writer:** the minimal path + `CHANGELOG.md` are the quickstart's backbone.

Changes go through `versioning.md`: additive is fine; breaking = version bump + ADR.
