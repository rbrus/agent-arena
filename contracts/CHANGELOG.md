# Changelog — Agent Arena Contracts (including the pre-pivot game prototype)

All notable changes to the `contracts/` source of truth. This file is consumed by **sdk-engineer**
(generates the models, the WSS client and the CLI's I/O types) and **lore-docs-writer** (quickstart +
reference).
Format follows [Keep a Changelog](https://keepachangelog.com/); versions are SemVer per
`versioning.md`. Breaking changes require an ADR (MISSION §7).

## [Unreleased]

_Nothing pending._

## [2.14.0] — 2026-09-28

**The open CLI's tool identity is `@sixi4ai/agent-arena`.** **MINOR**: one string value in examples, a fixture and
normative text; no schema constraint, `$id`, error code, oracle id or SARIF rule id changes. `versioning.md` §2 has the
worked example. Source: GATE-DECISIONS NPM-1 (2026-09-28): the npm scope `@rbrus` is not the Architect's, so the package
`@rbrus/agent-arena` is never published and the first npm release is `@sixi4ai/agent-arena` 0.1.2. The GitHub
repository stays `rbrus/agent-arena`, the bin stays `agent-arena`.

### Changed

- **sarif-mapping.md §1**: `runs[0].tool.driver.name` (from `run.tool.name`) is `@sixi4ai/agent-arena` for the open CLI,
  no longer an "e.g."; `informationUri` stays `https://github.com/rbrus/agent-arena`. The §8 excerpt follows.
- **Examples and fixtures**: `run.tool.name` in `report.schema.json` examples[0]–[3], the OpenAPI Report example,
  `evidence_report.schema.json` `producer.tool.name` in both examples, and `fixtures/hosted_report.sarif`. Every
  install and command line in the schema descriptions, `openapi.yaml` and `README.md` reads `npx @sixi4ai/agent-arena`.
- **contract-check §19** asserts the identity at every site, the unchanged `informationUri`, agreement with the CLI's
  package name and the report writer's `TOOL_NAME`, and that no contract file but this changelog names the previous scope.

### Re-signed (test vectors; the tool name is inside signed payloads)

The tool name is a member of the signed `report.schema.json` examples[2] and of the bytes of
`fixtures/hosted_report.sarif`, so their vectors move. Regenerated with `tools/signing-vectors.mjs` and
`tools/digest-statement-vectors.mjs` (same RFC 8032 TEST 1 key, deterministic Ed25519). Every other vector is
byte-identical: the hosted_context and crosscheck_record vectors, the deletion receipt, the pack envelope, the run tokens,
the press signatures and the large bundle-manifest payload.

| Vector | Before | After |
|---|---|---|
| `signing_vectors.json` report examples[2] `jcs_sha256` (14378 → 14380 bytes) | `sha256:c5b8ae431713adcd719d11475c71a4ec1961079fe11337201ac77eebd68f5a65` | `sha256:c75db013f7a456a82c6c200d61cedf50e256776f49e75547716e7058d9ead875` |
| `fixtures/hosted_report.sarif` (17857 → 17859 bytes; `digest_statement_vectors.json` `payloads.sarif`) | `sha256:fb4312525f231ec84d661f6fb46a2e72c804c3f14af5fbb734142ae19052266a` | `sha256:80f2ec63880648334a49ec26fd6fdf76c431200ff6d4db36124c5b2533c9d947` |
| `digest_statement_vectors.json` `accept-embedded-report-digest` `statement_jcs_sha256` | `sha256:aabfbb2bd72b556665d7976a1b15fe3f5155a07a568ba79551d172fb0809a45e` | `sha256:34a9e1be5b2899ae841862d3bd7808d7463b30eedb9e7f6aeca75ff570454bdf` |

Envelopes and signatures move with them in `accept-raw-sarif`, `accept-digest-sarif`, `accept-embedded-report-raw`,
`accept-embedded-report-digest`, `reject-embedded-form-mismatch`, `reject-embedded-form-removed` and
`reject-embedded-form-raw-with-digest-signature`; each still verifies (or rejects) for the reason it names. A consumer
that vendors these files (the Sixi Go verifier's `testdata/contracts/`) re-vendors 2.14.0.

### Not changed

- **Replay hashes, transcript hashes, evaluation hashes and SARIF fingerprints.** None of them hashes the tool name; the
  frozen anchors and the replay inspector's sample hashes do not move.
- `$id`s, the frame protocol `1.0`, oracle ids, SARIF rule ids and levels, error codes.
- The evidence report's `producer.contracts_version` now says `2.14.0`, as every release before it moved it.

## [2.13.0] — 2026-09-27

**The evidence renderer's inputs, its command, and its three refusal codes.** **MINOR**: one new `$id`, three new error
codes and normative text for a command the open CLI already ships. `versioning.md` §2 has the worked example. Source: the
sdk-engineer's `agent-arena evidence` (`packages/arena-cli/src/commands/evidence.ts`), which defined its `--inputs`
document in code, and the Sixi seal step (sixi-scanner PR 7c), which writes that document and runs the command.

No ADR is needed. The frame protocol stays `1.0`, and every existing `$id` keeps `:1`. **No oracle id or SARIF rule id is
added, renamed or re-levelled.** Every signing vector, digest-statement vector and signed example is byte-identical. The
only rendered byte that moves is the evidence report's contracts version (`producer.contracts_version`, and the
"Contracts version" row of `evidence.md`), which names the release a renderer validates against.

### Added: `schemas/evidence_input.schema.json` (`wot:evidence_input:1`)

- The document `agent-arena evidence --inputs <path>` reads, and the Sixi seal step writes to `render/input.json`. At most
  8388608 bytes, `x-direction: inbound`. Promoted from the CLI's in-code schema with the same constraints; the CLI now
  compiles this file, as it does the other hosted schemas.
- **Members.** `input_version` `"1.0"`; `run_id` (1 to 64 characters, no C0 control character, MUST equal the sealed
  report's `run.run_id`); `jwks_url` (at most 256, `^https://[^\s?#]+$`); `admission` {`reports_until`, `audit_until`,
  `credential_destroyed_at`?, `requested_by`? {`actor_kind` `user` | `pipeline_token` | `system`, `actor_id`
  `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$`}, `incident_ref`? `^[A-Za-z0-9_-]{1,64}$`}; `crosscheck_record`?; `corpus`? (at most
  4096 entries keyed by clause id of at most 128 characters: `instrument`, `reference`, `paraphrase`, `url` https,
  `title`?).
- **Closed at every level.** Unknown members are refused, so none of the seal facts the signed report carries (seal time,
  region, organisation, origin, image digest, engine build, key id) can be supplied here. `crosscheck_record` is closed by
  `crosscheck_record.schema.json`, which the consumer applies to it (no contract schema references another file), and its
  signature must verify with the report key set.
- **Examples.** The Sixi PR 7c input with a cross-check record (the CLI's fixture, with the record's signature replaced by
  an `EXAMPLE` value), the same input without a record, and one with every optional admission member and a two-entry
  corpus.

### Changed (text): HOSTED-PROFILE §2.7 step 6 and signing.md §5.3 step 4

- **HOSTED-PROFILE §2.7 step 6** now specifies the evidence step as built: a keyless job from the same digest (no
  `ARENA_HOSTED`, no network, only `render/` writable) runs `agent-arena evidence --hosted-seal <seal>/report.json --sarif
  <out>/report.sarif --verify-result <seal>/verify.json --packs <in>/packs --inputs <render>/input.json --key pinned --out
  <render>`. It verifies the sealed report with the pinned report keys, the SARIF as the re-rendering of the report,
  `verify.json` stating the seal precondition, the mounted packs and the cross-check record's signature, then renders
  `evidence.md` and, when every sealed input is present, `evidence.json`, create-only. Exit 0 both files, 1 `evidence.md`
  only, 2 an input fails or the renderer refused (nothing written), 3 misuse. The evidence lists `report.json` and
  `report.sarif` by digest, never `bundle-manifest.json`. Appendix A gains the three codes below.
- **signing.md §5.3 step 4** names the open CLI's `evidence` as the renderer, `evidence_input.schema.json` as the only
  source of the seal-side facts the signed report does not carry, and the signed report as the only source of seal time,
  region, organisation, origin, image digest, engine build and key id. The seal order does not change.

### Added: errors.md §1d `input_invalid`, `renderer_refused`, `evidence_not_written`

All three are exit 2 with nothing written, and the seal step then seals the run without the evidence and records
`not_rendered:<code>`.

- `input_invalid`: an input failed its check (report, SARIF, `verify.json`, packs, `input.json` or its cross-check
  record's schema). A signature that does not verify keeps `signature_invalid`.
- `renderer_refused`: `renderer_refused: <code>: <reason>`, with `<code>` one of `wording`, `input`, `schema` or `output`.
- `evidence_not_written`: an output could not be created or written in full, or `--out` changed after it was checked. A
  file already written by the call is removed.

### Implementation (same change)

- `arena-cli`: `src/hosted/schemas.ts` compiles `evidence_input.schema.json` (the in-code schema is gone; its `$id` was
  `agent-arena:evidence_input:1`). `evidence` now checks a present `crosscheck_record` against
  `crosscheck_record.schema.json` at the input stage, so a malformed record is `input_invalid` before its signature is
  verified; before, it failed the signature check or the renderer. `src/generated/contracts.ts` does not change: the CLI's
  codegen covers `run_spec`, `eval_episode_end`, `hosted_context` and `pack_manifest` only.
- The evidence goldens (`arena-cli` `test/fixtures/sixi-pr7c/golden/`, `arena-report` `test/fixtures/evidence-*.md`)
  move their contracts version from `2.12.0` to `2.13.0`. Nothing else in them changes.

## [2.12.0] — 2026-09-27

**The verifier's result file, four §5.2 reason tokens, and the evidence render order.** **MINOR**: a clarifying
release that adds surfaces. `versioning.md` §2 has the worked example, which also says why this is not `2.11.1`.
Source: the sdk-engineer's 2.11.0 CLI (`packages/arena-cli/src/result-file.ts`, `src/hosted/digest-statement.ts`),
which had to choose behaviour that the contract did not state, and the Sixi seal step (sixi-scanner PR 6), which reads
the verifier's result from a file.

No ADR is needed. The frame protocol stays `1.0`, and every existing `$id` keeps `:1`. There is one new `$id`. **No
oracle id or SARIF rule id is added, renamed or re-levelled.** Every signing vector, every digest-statement vector and
every signed example is byte-identical.

### Added: `verify --hosted-seal --result <path>` (signing.md §5.1.1, HOSTED-PROFILE §2.7)

- `schemas/verify_result.schema.json` (`wot:verify_result:1`, at most 8388608 bytes, `x-direction: inbound` to the seal
  step). Its five examples are real CLI outputs: `verified`, `mismatch`, `unverifiable` (a foreign
  `--expect-manifest-digest`), `misuse`, and an unreadable report.
- **Content.** The file is byte-identical to the `--json` document, whether or not `--json` is given. stdout does not
  change.
- **When it is written.**
  - For every exit 0, 1 and 2.
  - For exit 3, once the path has been accepted: a misuse is written as
    `{"ok":false,"status":"misuse","exitCode":3,"errors":[…],"signed_forms":{}}`, and `unsupported_engine` as a full
    result.
  - `exitCode` equals the process exit code.
- **The path.** It is checked after the `--manifest-key` refusal and before the bundle is read. It must not exist, must
  not be a symbolic link, must have an existing parent directory, and must be outside the bundle. Otherwise the exit is
  3 and nothing is written. The file is created create-only and synced.
- **Write failure.** A failure after verification is exit 2 with the prefix `result_not_written`, and a partial file is
  removed.
- **Only with `--hosted-seal`.** `--result` without `--hosted-seal` is exit 3.
- **The seal precondition** (signing.md §3 rule 2) is read from the file only: `exitCode` 0, `status` `verified`,
  `hosted_seal.sarif_equal` true, and empty `hosted_seal.seal` and `hosted_seal.mismatch`. No usable file (absent, over
  the cap, not JSON, schema-invalid) is `seal_failed` with the reason `verify_no_result`.
- HOSTED-PROFILE §2.7 now describes the verifier job as built. It had still named `agent-arena verify /out/report.json`
  and a future `verify --sarif` flag. Appendix A gains `result_not_written`.

### Added: errors.md §1d `result_not_written`

Exit 2. The verifier could not create or fully write the result file. A refused path is not this code (exit 3, nothing
written). The `seal_failed` row names the reason `verify_no_result`.

### Clarified: signing.md §5.2 reason tokens the CLI had to choose

Each case was already `signature_invalid`, exit 2. Only the token is now fixed:

- an envelope that is not an object, does not have exactly one signature, or whose `sig` is not standard base64 of 64
  bytes → `signature` (D1, and E3 for `report.json.dsse.json`);
- a `payload` that is not standard base64 → `payload_mismatch` (raw form, D2 and E3) or `statement_malformed`
  (statement form, D3);
- a raw envelope whose `keyid` differs from the report's kid → `binding` (§5.1 rule 7), checked after payload equality
  and before D8;
- a `signed_form` other than `raw` or `digest_statement`, or `digest_statement` on an always-raw document type (run
  manifest, deletion receipt) → `form_mismatch` (E1); a document without a well-formed `signing` block → `signature`.

`tools/contract-check.mjs` §17 replays each case with the §16 verifier, which follows the clarified text. The cases are
built by mutating existing vectors, so the vector file is unchanged.

### Decided: the evidence render order (signing.md §5.3)

- **The problem.** `evidence.json` listed the sha256 of `bundle-manifest.json`, while `bundle-manifest.json` lists
  `evidence.json`. Both cannot hold. The keyless pre-seal verifier also lacks the seal time, the cross-check record and
  the admission record.
- **The decision.** The seal step renders the evidence after it signs `report.json` and `report.sarif`, and before it
  writes `bundle-manifest.json`. `evidence.json` drops the `bundle-manifest.json` entry, and the evidence gets no
  envelope of its own. §5.3 gives the six-step order and says why a separate envelope was rejected: a fourth KMS
  signature, a new payload type, and a file outside the §5.1 layout.
- **`evidence_report.schema.json`.**
  - `signature.files` `minItems` 3 → 2 (a relaxation).
  - `path` `bundle-manifest.json` is deprecated: MUST NOT be emitted, ignored by readers, removed at 3.0.0.
  - Both examples drop the entry.
- **EVIDENCE-REPORT-TEMPLATE.md.** The inputs, the §11 table and R7 are updated.
- **Follow-ups.** The arena-report renderer and the Phase-9 gate still pass a `bundle-manifest.json` entry. That stays
  schema-valid, but a 2.12.0 renderer must drop it; the owners are the sdk-engineer and sim-qa. On the Sixi side, the
  sealer (not the verifier job) must render the evidence.

## [2.11.0] — 2026-09-27

**The pinned key set, and signed digest statements.** **MINOR**: additive (`versioning.md` §2 has the worked example).
Sources:
- the sdk-engineer's pinned key set in the CLI (`packages/arena-cli/src/hosted/pinned-keys.{json,ts}`, `verify --key
  pinned`), which implements SECURITY-REVIEW-HOSTED S-1, SIXI-INTEGRATION OQ-3 and Sixi review condition A8, and which
  found that signing.md §3.2 M3, M6 and §11 name "the pinned control-plane key set" without defining it;
- a production measurement: Cloud KMS `asymmetricSign` with an `EC_SIGN_ED25519` key (SOFTWARE, `europe-west6`) signs at
  most 65536 bytes of raw data (`deploy/arena/kms-cap-probe.sh`, sixi-scanner PR 6). A hosted Diplomacy report's JCS body
  is about 192 KiB at the M10 cap.

No ADR is needed. The frame protocol stays `1.0`, and every existing `$id` keeps `:1`. There are two new `$id`s. **No
oracle id or SARIF rule id is added, renamed or re-levelled.** Every signed example and every signing vector is
byte-identical.

### Added: the pinned key set (signing.md §3.3)

- `schemas/pinned_keys.schema.json` (`wot:pinned_keys:1`, `format: agent-arena-pinned-keys/1`, at most 65536 bytes,
  `x-direction: inbound`). The example is the set pinned on 2026-09-27: manifest kid
  `sixi-arena-manifest-ed25519-86c88a43cdcdb910e8f4` and report kid `sixi-arena-ed25519-c2f84888ae5d69e9f7df`, both
  valid from 2026-09-27T00:00:00Z to 2026-12-26T00:00:00Z.
- **Rule 1, what is pinned.** Two sets, as served at `https://sixi.ch/.well-known/arena-jwks.json?purpose=manifest` and
  `?purpose=report`. Each body is reproduced exactly: `JSON.stringify({keys}) + LF` hashes to its `source_sha256`.
  - Keys are public only: OKP Ed25519, `use: sig`, `not_before`, `not_after`, and optional `revoked_at`. A key with `d`
    is invalid.
  - Each kid is derived from its key: `sixi-arena-manifest-ed25519-` or `sixi-arena-ed25519-`, followed by the first 80
    bits of the RFC 7638 thumbprint in hex. This makes normative the PR 3 derivation already in production.
  - Kids are unique across the file, and no key appears in both sets.
  - A window is at most 120 days.
  - The run-token key is not bundled.
- **Rule 2, use.**
  - The manifest set is the only trust anchor for run manifests and packs.
  - A pinning release refuses `--manifest-key` on `run --hosted`, `verify --hosted` and `verify --hosted-seal`:
    `hosted_context_invalid`, with the new detail field `--manifest-key`.
  - The runner never fetches keys.
- **Rule 3, the window.** `not_before ≤ t < not_after`, and `t < revoked_at` when set.
  - `t` is the signing time of each document: `issued_at` for a manifest, `signing.sealed_at` for a report and its
    envelopes, `finished_at` for a cross-check record, `purged_at` for a deletion receipt.
  - For a pack, `t` is the `issued_at` of the run manifest that lists it. This is a decision: packs carry no signing
    time, and the rule asks whether the key is trusted for this run.
  - Outside its window a document is refused like one signed by an unpinned kid.
  - M1 bounds a manifest's use to 24 h after `not_after`.
- **Rule 4, rotation.**
  - A key signs for at most 90 days, followed by at most 30 days of overlap.
  - A new key must be in a promoted open release, with a green cross-check, before the control plane signs with it and
    before the current key's `not_after`. So there is at least one promoted open release per quarter.
  - Retired keys stay published.
  - Revocation reaches a runner only through a release.
- **Rule 5, `verify --key pinned`.**
  - The key is chosen by `signing.signing_key_id` and checked at `signing.sealed_at`.
  - An unpinned kid, a key outside its window, or an unsealed report is `signature_invalid` (exit 2).
  - An older report verifies with the release that was current when it was sealed, or with the key passed explicitly.
- M3, M6, §3 rule 1, §5.1, §11.1 and §11.3 step 5 now point to §3.3, and §11.3 step 5 applies the pack window.

### Added: signed digest statements (signing.md §5.2)

- **The constant** `ARENA_SIGN_MAX_MESSAGE_BYTES = 65536`: the largest PAE message a Sixi key signs directly. Sixi's
  `SIXI_ARENA_KMS_SIGN_MAX_BYTES` maps to it and must not exceed it.
- **The statement.** `schemas/digest_statement.schema.json` (`wot:digest_statement:1`, payload type
  `application/vnd.sixi.arena-digest-statement+json`) holds:
  - `subject {payload_type, sha256, bytes}`;
  - for the seal outputs, `run_id` and `run_manifest_digest`;
  - a `signing` block with `sealed_at`.
  It is signed as §1 and §2 describe.
- **When each form is allowed.** The statement form is allowed at any size and is mandatory above the threshold. The raw
  form is unchanged below the threshold and refused above it (`raw_over_threshold`).
- **Scope.** The report, `report.sarif`, `bundle-manifest.json` and the cross-check record. The run manifest and the
  deletion receipt always fit raw. Packs stay raw in 2.11.0, and the pack store refuses a larger one (RESERVED.md).
- **Detached files.** The envelope carries the statement as its payload.
- **Embedded signatures.** The new optional `signing.signed_form` (`raw` | `digest_statement`, absent = `raw`) is added
  to `report` and `crosscheck_record`. The statement is derived from the document, and `signed_form` lies inside the
  signed body.
- **Verifier.** Steps D1 to D9 and E1 to E4, in a fixed order. Every refusal is `signature_invalid` with one of eleven
  reason tokens.
- **Reporting the form.** `verify --hosted-seal` names the form per file, and `--json` carries `signed_forms`. The
  evidence report gets an optional `signature.files[].signed_form`.
- **Vectors.** `fixtures/digest_statement_vectors.json` holds 23 vectors (RFC 8032 test key): the raw and statement
  pairs over `report.sarif` and an 80070-byte `bundle-manifest.json` (`fixtures/digest_statement/`), the embedded report
  in both forms, an embedded cross-check record, and 17 must-rejects. `tools/digest-statement-vectors.mjs` regenerates
  them deterministically.

### Changed (documentation)

- `errors.md`: `hosted_context_invalid` (the key window; `--manifest-key`), and `signature_invalid` (`--key pinned` and
  the §5.2 reason tokens).
- `docs/phase-9/HOSTED-PROFILE.md` §3.1 and §3.2 had drifted and are corrected:
  - the JWKS URL is `https://sixi.ch/.well-known/arena-jwks.json`, not the placeholder
    `https://sixi.ai/.well-known/sixi-arena-signing-keys.json`;
  - the verify flag is `--key pinned`, not `--keys <file>`;
  - the `openssl` steps cover the statement form;
  - Q12's location is marked resolved.
- `tools/contract-check.mjs` adds §15 (the pinned key set, over the example and over the CLI's bundled file) and §16
  (digest statements). Tier 0: 49 schemas.

### For implementers

- **sdk-engineer:**
  - apply the pack window in `openPackEnvelope` (t = the manifest's `issued_at`), which is not yet applied;
  - `pinnedKeyFileProblems` could add the kid-derivation and as-served checks (contract-check §15 covers them at
    release time);
  - implement §5.2 in `verify --hosted` and `verify --hosted-seal` (D1 to D9, E1 to E4, `signed_forms`), and in the
    test sealer if one signs reports over 64 KiB;
  - no generated type changes (`contracts.ts` covers run_spec, eval_episode_end, hosted_context and pack_manifest, none
    of which changed).
- **Sixi control plane and sealer:** sign through the statement when the PAE message is over
  `SIXI_ARENA_KMS_SIGN_MAX_BYTES`, set `signing.signed_form`, replay `digest_statement_vectors.json`, and follow §3.3
  rule 4 for rotation.

## [2.10.0] — 2026-09-27

**The `extended` budget tier, and two hosted episode caps.** **MINOR**: additive (`versioning.md` §2 has the worked
example). Sources, both Architect rulings of 2026-09-27 (`docs/phase-7/GATE-DECISIONS.md`, "2026-09-27 rulings"):
- the budget tier reserved in 2.8.0 as `league` is **renamed `extended`** and specified with a **30 s hard decision
  deadline**. The name clashed with the passport and queue field `league`, which already carries the tier;
- **OQ-18**: a hosted Diplomacy-family run plays at most **50 episodes** (sixi-scanner `a56243c`,
  `MaxDiplomacyEpisodesPerRun` in `go/arena/manifest.go`; derivation in docs/phase-9/SIXI-INTEGRATION.md OQ-18).

No ADR is needed. The frame protocol stays `1.0`, every schema `$id` keeps `:1`, and there is no new `$id`. **No oracle
id or SARIF rule id is added, renamed or re-levelled.** The three existing tiers' numbers do not change.
`diplomacy_standard.participation` stays reserved.

### Added: budget tier `extended`

| dial | edge | core | frontier | **extended** |
|---|---:|---:|---:|---:|
| soft deadline Ds | 800 ms | 1500 ms | 3000 ms | **15000 ms** |
| hard deadline Dh | 1600 ms | 3000 ms | 6000 ms | **30000 ms** |
| action-token allowance per controlled seat per episode | 160 | 240 | 360 | **540** |
| Diplomacy press rounds R | 2 | 3 | 3 | **3** |
| Diplomacy press quotas (messages per round / per window, body bytes per window, broadcasts, live offers) | 3 / 6, 2048, 1, 2 | 6 / 12, 4096, 2, 4 | 12 / 24, 8192, 4, 8 | **12 / 24, 8192, 4, 8** |
| worst-case episode wall time (tick cap 120 × Dh) | 192 s | 360 s | 720 s | **3600 s** |

Everything structural is as in every tier: 3 consecutive hard misses forfeit, tick cap 120, one order per unit, token
costs, inbound frame caps (8192 bytes; 16384 for `diplomacy_standard`).

**Derivation.** The Architect fixed Dh = 30000 ms. The other members follow the rules that already hold across the
three tiers the economy-designer sized (arena-scenarios.md §3.1, `docs/economy/params.json` `leagues`, wot-engine
`PRESS_QUOTAS`), applied one tier step beyond Frontier:
- **Ds = Dh / 2** at every tier (800/1600, 1500/3000, 3000/6000), so Ds = **15000 ms**.
- **The allowance grows ×1.5 per tier step** (160 → 240 → 360; it does not follow Dh, whose steps are ×1.875 and ×2),
  so 360 × 1.5 = **540**. Nothing structural caps it: the coordinated references spend at most 131 per member, and a
  duel side can spend at most 8 per tick.
- **R saturates at 3** (edge 2, core 3, frontier 3). R = 4 would add movement-phase ticks, and the 1908 horizon is
  103 ticks at R = 3 under the 120-tick cap, so R = **3**. `episode_result` `press_rounds` keeps its maximum of 3.
- **Press quotas double per tier step** (edge halves Core, Frontier doubles it). One more doubling would give 24
  messages per round, which is over the structural press-batch cap of 12 (`diplomacy_action` `press` `maxItems`;
  frame caps are structural, arena-scenarios.md §3.1). Every other press quota is proportional to messages per round
  in all three tiers (per window = 2×, broadcasts = ⅓×, live offers = ⅔×, bytes = 2048 × per-round / 3). So the
  capped doubling leaves every press quota at the **Frontier** value. No schema bound moves.
- The 2.8.0 candidate text named the Frontier allowance (360). The ruling asks for the same scaling rule, which gives
  540. The candidate's Ds of 15000 ms is confirmed.

**Where it appears (the enum, and the one tier list, everywhere a RunSpec-class tier is read):**
- `run_spec` `budget_tier` and its `report` `$defs` mirror, with the four-column table and the derivation in the
  description, and `diplomacy` (R and quotas at `extended`);
- `episode_result` `budget.tier` and its `report` mirror, and `report` `budget_limits` (`tier`, plus Ds 15000, Dh
  30000 and allowance 540 in the value enums);
- `evidence_report` `runs[].budget_tier`, `not_assessed.coverage.tiers_not_run` (`maxItems` 3 → 4), and the
  `sarif_category` pattern. Both evidence examples now list `extended` among the tiers not run: the evidence builder
  enumerates every tier, and a tier not run is never implied to be covered;
- `crosscheck_record` `cells[].budget_tier`, `pack_manifest` `scenarios[].tiers`, and `pack_variant` `tier`;
- `openapi.yaml`: a new `BudgetTier` component (the four values); `BudgetTierLimits.tier` references it, with the
  extended values in its enums; `ScenarioCatalog.budget_tiers` has `maxItems` 4, and the catalog example has the extended
  row;
- SARIF: `automationDetails.id` and the fingerprint take the tier as data. `agent-arena/<scenario>/extended/<seat>/` is
  a new category, and no existing category or fingerprint moves (sarif-mapping.md §1 now says four tiers);
- `asyncapi.yaml` and `diplomacy_action` text (R and the quota at `extended`).

**Not changed, on purpose:**
- **The value `league` is not a tier.** It was never in any tier enum, so it stays refused as an unknown value (`schema_invalid`).
- **The run-spec field and the queue field `league` keep their meaning.** The live duel/raid queue, the passport and
  the old frames (`ack`, `raid_ack`, `spectate_ack`, `webhook_event`, and openapi `League`) keep edge, core and
  frontier. The live arena does not offer `extended`, and `League`'s description says so. The `diplomacy_session_ack`
  `eval_class` of the live Diplomacy table session is also unchanged: tables there are created server-side, and the
  lobby offers the three tiers.
- **No anchor is frozen at `extended`.** The `crosscheck_record` `anchor_id` grammar keeps `(edge|core|frontier)`, so an
  anchor id naming `extended` is refused. A cross-check cell may be at `extended`, with its legs compared with each
  other and leg A empty. `verify` re-simulates an `extended` report like any other, but no anchor match is claimed.
- The existing signed examples do not change. They all run at `core`, and no enum is embedded in a signed payload. All
  signing vectors (report, run manifest, cross-check, deletion receipt, pack, run tokens, press) are byte-identical.

### Added: hosted caps (signing.md §3.2 A6 and M10)

- **A6: an `extended` run plays exactly one episode**, so it has exactly one seed, whatever the `credential_mode`.
  - Why: one 30 s-deadline Diplomacy episode at horizon 1908 (103 ticks) can take about **51.5 min**, and a
    `sixi_run_token` run ends within 55 min of minting (C3). A second episode cannot fit.
  - The cap holds until a run-token refresh path is specified.
  - Refusals:
    - control plane: `plan_limit_exceeded`, `detail.limit` `extended_episodes_per_run`, whatever the plan;
    - runner: `run_spec_invalid` (`episodes`).
  - `report` conditional: a hosted report whose `run.spec.budget_tier` is `extended` has `run.spec.episodes` = 1 and at
    most one EpisodeResult.
  - C3 still applies. An `extended` episode of a raid or duel can take up to 120 × 30 s = 60 min, so the run deadline
    can end it (`deadline_exceeded`, no report).
- **M10 (OQ-18): a Diplomacy-family run plays at most 50 episodes.** A Diplomacy-family run is `diplomacy_standard`,
  or an `sx_` scenario whose base is `diplomacy_standard`.
  - `hosted_context` `episode_secret_commitments.count`: `maximum` 1000 → **50**. It must equal the RunSpec's
    `episodes`, which was already implied by M7 and is now stated.
  - Hosted only. The open CLI keeps the RunSpec limit of 1000.
  - Refusals:
    - control plane: `plan_limit_exceeded`, `detail` `{limit: "diplomacy_episodes_per_run", value, plan}`, at most 50
      whatever the plan;
    - runner: `hosted_context_invalid` (`episode_secret_commitments`).
  - `report` conditional: a hosted Diplomacy-family report has `run.spec.episodes` ≤ 50 and at most 50 EpisodeResults.
  - `fixtures/hosted_env.json`: the `ARENA_DIP_SECRET_<n>` secret pattern is `^ARENA_DIP_SECRET_([0-9]|[1-4][0-9])$`
    (`n` ≤ 49). The malformed-name pattern is unchanged. A canonical index of 50 or more is not malformed: it is
    refused as `n` ≥ `count`.
  - **The two caps compose.** An `extended` run plays 1 episode, and a Diplomacy-family run at another tier plays at
    most 50.
- **Why the `count` maximum is MINOR, not a MAJOR tightening:**
  - `hosted_context` is a hosted-only document, and its only signer, the Sixi control plane, is unreleased and already
    refuses more than 50 (`a56243c`);
  - every example and fixture commits to 1 episode.

  See `versioning.md`, "2.10.0".
- errors.md: `plan_limit_exceeded` names the two limits, `run_spec_invalid` names A6, and `hosted_context_invalid`
  names M10.

### Contract checks (`tools/contract-check.mjs` §14)

- **Tier list:**
  - one list, `edge, core, frontier, extended`, in 11 enums (the mirrors and copies above, plus openapi `BudgetTier`);
  - `tiers_not_run` `maxItems` equals the tier count;
  - `League` stays three tiers;
  - the extended values are present in `budget_limits`, `BudgetTierLimits` and the catalog example;
  - the `run_spec` description states the table and the derivation.
- **Must-rejects (17 schema cases):**
  - `league` in `run_spec`, `report` (`run.spec`, `budget_limits`), `episode_result`, `evidence_report` (tier,
    `tiers_not_run`, SARIF category), `pack_variant`, `pack_manifest`, and a `crosscheck_record` cell;
  - `Extended` (wrong case);
  - Dh 60000;
  - an `anchor_id` at `extended`;
  - a hosted `extended` report with `episodes` 2, or with two EpisodeResults;
  - a hosted Diplomacy report with `episodes` 51;
  - `episode_secret_commitments.count` 51.
- **Admission verifier (A6 and M10, written from the §3.2 text):**
  - four must-rejects: `extended` with 2 episodes; Diplomacy with 51; `count` ≠ `episodes`; Diplomacy `extended` with
    2;
  - four passes, including a byzantine run with 51 episodes (M10 is Diplomacy-family only).
- **Positive controls:** `extended` accepted in every copy. A local report at `extended` with 3 episodes, a hosted
  Diplomacy report at 50, and a local Diplomacy report at 51 are all valid.
- **Existing checks:**
  - the §12 check now requires `league` to be gone from "Currently reserved" and recorded in History;
  - the admission-rule list gains A6, M9 and M10;
  - the `ARENA_DIP_SECRET` pattern cases separate "accepted" (0..49) from "malformed".
- **Totals:** Tier 0 checks 47 schemas and 106 examples. Negative cases 396 → 417, mirrors 32 → 43.
- `openapi.yaml` and `asyncapi.yaml` `info.version` are 2.10.0. `README.md`, `versioning.md`, `RESERVED.md` (the
  `league` row moved to History) and `sarif-mapping.md` §1 are updated.

### Migration notes (implementation follow-ups; done in the same change unless marked)

- **arena-scenarios:**
  - `tiers.ts` gains `extended` in `BUDGET_TIERS` and `TIER_IDS`, plus `ANCHORED_TIER_IDS`
    (edge, core, frontier) for anything that looks up a frozen anchor;
  - no anchor is frozen, and no existing anchor or golden moves.
- **wot-engine:** `EvalClass` gains `extended`, and `PRESS_QUOTAS.extended` equals Frontier.
- **arena-cli:**
  - `--tier extended` is accepted;
  - `src/generated/contracts.ts` is regenerated (`node packages/arena-cli/codegen.mjs`);
  - the hosted admission checks A6 and M10 are in `src/hosted/admission.ts`;
  - `HOSTED_SECRET_PATTERNS` follows `hosted_env.json`.
- **arena-report:** `TierId` gains `extended`; the evidence builder lists `extended` among the tiers not run; the
  evidence goldens are regenerated.
- **arena-league:** tables may be played at `extended`, and `league` is refused as an unknown tier.
- **qa:** the gate harnesses and `crosscheck.ts` keep the three anchored tiers (edge for the fault tests). `extended`
  is outside every frozen-anchor check.
- **Not done (live arena, `services/arena`, `wot-store` `LEAGUES`):** the live queue does not offer `extended`.
  Offering it there would be a separate MINOR (openapi `League`, the frame enums, and the lobby's `DIP_DEADLINES`).
- **Sixi control plane:**
  - admission must refuse `extended` with `episodes` > 1 (A6), alongside the existing 50-episode Diplomacy cap (M10);
  - the plan table (HOSTED-PROFILE §7) gains both rows.

## [2.9.0] — 2026-09-27

**Residency region enum, pack coverage rule, fixture pack re-signed.** **MINOR**: additive and corrective, with one
precise tightening (`versioning.md` §2 has the worked example). Sources:
- sixi-scanner PR 1 (`go/arena/config.go` `euRegions`, docs/phase-9/pr/PR1.md "Where the plan was wrong": the region
  pattern admits London);
- docs/phase-9/GATE-EVIDENCE.md finding **C2-PACK-COVERAGE** and the C3 note that the fixture pins a placeholder engine
  build.

No ADR is needed. The frame protocol stays `1.0`, every schema `$id` keeps `:1`, and there is no new `$id`. **No oracle
id or SARIF rule id is added, renamed or re-levelled.** `diplomacy_standard.participation` and the budget tier `league`
stay reserved. The Architect has not ruled on `league`, and RESERVED.md now says "a later MINOR" for both.

### Changed: `region` is an explicit EU + Zürich enum (was a pattern)

- `hosted_context.region` was `^europe-[a-z]{4,9}[0-9]{1,2}$`. That pattern admitted `europe-west2` (London), which is
  outside the EU, while the field's description promised "EU or CH regions only". It is now exactly this enum, the same
  list the Sixi control plane enforces at startup:

  `europe-central2`, `europe-north1`, `europe-north2`, `europe-southwest1`, `europe-west1`, `europe-west10`,
  `europe-west12`, `europe-west3`, `europe-west4`, `europe-west6`, `europe-west8`, `europe-west9`

  (Warsaw, Finland, Stockholm, Madrid, Belgium, Berlin, Turin, Frankfurt, Netherlands, **Zürich (default)**, Milan,
  Paris). The match is whole-value and case-sensitive.
- The same enum, byte-identical, replaces the pattern in every copy: `report` `run.hosted.region`, `evidence_report`
  `producer.region` and `scope.region`, and `deletion_receipt.region`.
  - `crosscheck_record` has no region field, so it is unchanged.
  - `bundle_manifest` has none either.
- **Refused:** `europe-west2`, `us-east1`, and any spelling not in the list (`Europe-West6`, `europe-west6 ` with a
  trailing space, `europe-west66`).
- **Runner:** a manifest with another region is `hosted_context_invalid`, `detail.field` `/region` (errors.md §1d).
- **Control plane:** signing.md §3.2 gains rule **M9**. The control plane never signs another region, and refuses to start
  with one.
- errors.md `region_unavailable` now states that the region it names is always in the list.
- sarif-mapping.md §1.1 now says the `region` property is always in the list.
- **Why MINOR:** the old pattern contradicted its own description. No producer ever wrote a value outside the new list:
  - the only manifest signer, the Sixi control plane, is unreleased and enforces the same list;
  - every example, fixture, harness and design document uses a listed region.

  See `versioning.md`, "2.9.0". Adding a region later is a MINOR that changes all five copies at once.
- **Not changed:** the model-inference regions (`hosted_context.peers[].inference_region`, `pack_manifest`
  `scenarios[].peers[].model.region`, and the EpisodeResult and Report peer `inference_region`). They name a model
  provider's region, not the Sixi processing region, and keep their generic pattern. A follow-up is listed below.

### Added: pack coverage rule (signing.md §11.3 step 6a; `pack_manifest` descriptions)

- **Rule:** a pack's `coverage.clauses` MUST contain every clause id cited by `oracles[].clauses` or
  `rules[].clauses`. In short: coverage ⊇ clause map ∪ rule clauses.
- **Why this direction:** the not-assessed enumeration walks `coverage.clauses`. A mapped clause missing there would
  never be listed as not assessed when its oracles were not assessed (C2-PACK-COVERAGE).
- **The reverse is not required.** Coverage may list a clause that no oracle maps, like the fixture's
  `OWASP:AgenticTop10:ASI07`. Such a clause is always listed as not assessed (`clause_not_mapped_in_run`).
- **Enforcement:** JSON Schema cannot express inclusion between two arrays, so this is a load rule. The pack eval, the
  hosted runner's pack load (`scenario_pack_unavailable`, errors.md §1d) and the evidence builder enforce it.
  `tools/contract-check.mjs` §13 checks it on every pack example and on the signed fixture payload, with must-rejects.

### Fixed: the fixture pack (`fixtures/packs/sx-agentic-core/`)

- `pack_manifest` `examples[0]` `coverage.clauses` gains `OWASP:LLMTop10:LLM01` and `OWASP:LLMTop10:LLM10`. Its clause map
  cites both (`diplomacy_standard.injection_followed`, `shared.budget_violation`). The list now has 7 clauses.
- `pack.dsse.json` is re-signed with the RFC 8032 §7.1 TEST 1 key (`node contracts/tools/signing-vectors.mjs`), keyid
  `sixi-arena-manifest-ed25519-20261101`.
- `signing_vectors.json` `pack_vectors[0]` changes:
  - payload: 2786 bytes, `sha256:7a61219d293decbd23dab6af91574ff318b4cc7f03e432c4697df63596d1b5e3`;
  - envelope: 3987 bytes, `sha256:82ce9b7e0fc02f4c96c65306587c956595690f018c87b052e8c807b05e3d3069`;
  - new members `engine_builds_placeholder: true` and `note`.

  Every other vector (report, run manifest, cross-check, deletion receipt, run tokens, press) is byte-identical.
- **The signed example chain does not move.** The `hosted_context` example pins a placeholder pack digest (§11.4). The
  run-manifest digest, the report example, the hosted SARIF golden and the evidence report examples are unchanged. The
  two added clauses are assessed in the hosted example (`injection_followed` fails, `budget_violation` is held), so no
  not-assessed entry changes.
- **Placeholder engine build, made explicit (signing.md §11.4).** `engine.builds` is the `hosted_context` example's
  `engine_build_hash`, not a real build. A real runner therefore refuses the fixture as shipped with
  `pack_engine_mismatch`, by design (gate check C3-FIXTURE-ENGINE).
- **Harness `--engine-build` override.** A harness that needs a loadable pack runs
  `node contracts/tools/signing-vectors.mjs --engine-build sha256:<hex> --out <dir>`. This re-signs a **copy** for its
  own build (same test key and keyid), prints its digests, and writes nothing under `contracts/`. The tool refuses an
  `--out` inside `contracts/`.

### Contract checks (`tools/contract-check.mjs` §13)

- **Region:**
  - the enum equals the twelve-region list in all five copies, and no `^europe-` pattern is left in a hosted document;
  - must-rejects for `europe-west2` and `us-east1` in every copy, plus the case, padding and suffix spellings in
    `hosted_context`;
  - every listed region is accepted in every copy.
- **Coverage rule:**
  - checked on every pack example and on the signed fixture payload;
  - three must-rejects: a clause-map clause removed, the 2.8.0 fixture coverage, and a rule clause outside coverage;
  - one positive: an extra unmapped coverage clause is allowed.
- **Fixture:** its `engine.builds` is exactly the placeholder, and `pack_vectors` records it.
- **Prose:** signing.md M9, step 6a and the `--engine-build` note, and the errors.md rows, are all present.
- Negative cases 379 → 396; mirrors 27 → 32.

### Follow-ups (not in contracts)

- **sdk-engineer, CLI codegen:**
  - `node packages/arena-cli/codegen.mjs` must be re-run. `src/generated/contracts.ts` changes `region: string` to the
    twelve-member union, plus two description comments. The drift test "generated contract types match
    contracts/schemas" fails until it is re-run. wot-contracts codegen is unaffected.
  - The pack loader (`loadPacks`) and the evidence builder should enforce step 6a (`scenario_pack_unavailable`).
- **sim-qa, Phase 9 harness (`qa/phase9-gate.ts`):**
  - replace the harness's own re-sign of the fixture copy with the `--engine-build` mode, or keep it and pin the same
    inputs;
  - C2-PACK-COVERAGE now reports PASS against the fixture;
  - update GATE-EVIDENCE.md, which quotes the old envelope digest `sha256:1ffbc82d8955…`.
- **sim-qa / api-architect, known gap in an example (not changed here):** `report` `examples[2]` lists only
  `OWASP:AgenticTop10:ASI08` as a clause not assessed. The fixture's coverage also holds `OWASP:AgenticTop10:ASI07` (no
  oracle maps it) and `AIACT:2024/1689:Art15(4)` (mapped only by `byzantine.followed_minority_claim`, which is not in a
  Diplomacy run), and the evidence renderer lists both. Aligning the example moves the signed chain (run manifest,
  report vector, SARIF golden, evidence examples), so it is a separate change.
- **security-architect:** whether the model-inference region fields should also be constrained to a residency list, or
  to a provider-qualified form.
- **Sixi control plane:** the Go `euRegions` list and this enum must change together. A contract test on the Go side
  that compares `EURegions()` with `hosted_context.schema.json` would catch drift.

## [2.8.0] — 2026-09-26

**The participation oracle, the seat-timeout close, and the Neutral Ground decisions.** **MINOR**: additive
(`versioning.md` §2 has the worked example). Sources:
- the participation oracle as committed (165cbf3): arena-scenarios `src/oracles/shared.ts` (`participation`),
  `raidParticipationTicks` and `duelParticipationTicks`, the scenario registry, and arena-report `catalog.ts`;
  arena-scenarios.md §9;
- the Diplomacy lobby's seat-arrival deadline (`services/arena/src/diplomacy/lobby.ts`, `CLOSE.SEAT_TIMEOUT`) and
  docs/phase-9/CHAOS-DIPLOMACY.md "Update 2026-09-26";
- docs/phase-9/NEUTRAL-GROUND.md §7, open items 1, 2 and 4.

No ADR is needed. The frame protocol stays `1.0`, every schema `$id` keeps `:1`, and there is no new `$id`. **One oracle
id and SARIF rule id is added (`shared.participation`); none is renamed or re-levelled.**

### Added: `shared.participation`, normative (sarif-mapping.md §2.1 row, new §2.3)

- The "2.8.0 candidate" row is now normative: a shared rule, `primary: false`, `basis: resim`, fail severity **`error`**,
  `defaultConfiguration.level` `error`, precision `very-high`, no `risk`, no review flag. Catalog position: after
  `shared.illegal_action_rate`, before `harness.replay_integrity`.
- **Emitted by** the six raid scenarios from scenario version **1.2.0** and by `grid_tactics` from **1.1.0**, for every
  target seat and seat mode. **Not by `diplomacy_standard`**: its catalog, examples and hosted golden are unchanged.
- **Fail:** zero non-trivial actions over every actable tick of the episode. Evidence code **`no_participation`**;
  evidence ticks are exactly two, **the first and the last actable tick** (equal when there is one).
- **`not_assessed`:** the new reason code **`never_actable`** (the seat had no actable tick at all), or `episode_aborted`.
  `never_actable` is SARIF kind **`open`**: it is not in the not-applicable set, which stays exactly seven codes, so it
  keeps a run from `pass`. The open scenarios never produce it (every target unit is up at tick 0).
- **Schema enforcement:** `episode_result` (and its mirror `report` `$defs.episode_result`) gains one conditional on
  verdicts with this oracle id: `basis` `resim`; a `fail` is severity `error`, `evidence_ref.code` `no_participation`,
  two `evidence_ref.ticks`; a `not_assessed` reason is `never_actable` or `episode_aborted`. The id is new in this
  release, so no verdict written under an earlier contract is affected.
- **Accepted weakness, stated:** the threshold is 1 non-trivial action, and a `ping` counts, so a ping-every-tick target
  passes this rule.

### Reserved: `diplomacy_standard.participation` (2.9.0 candidate; sarif-mapping.md §2.3.1, RESERVED.md)

- The Diplomacy form of the rule (arena-scenarios.md §9): over the episode horizon, a target power whose every order is
  `hold` and none of whose press messages was accepted at a round close fails at `error`. It catches a power that sends
  valid all-hold, no-press frames every step, which `shared.budget_violation` does not.
- It is a scenario rule id rather than `shared.participation`, because its inputs (orders and press) differ and one
  shared id keeps one definition.
- **Not emitted in 2.8.0.** Wiring it changes the pinned Diplomacy catalog, the contract `evaluation_hash`,
  `report.schema.json` `examples[1]` and `[2]`, `fixtures/hosted_report.sarif` and the report signing vector, so it is
  its own release.

### Changed (examples): raid scenario 1.2.0, `grid_tactics` 1.1.0

Every place the contract pins a raid or duel scenario version now carries the version that emits the rule:
- `report.schema.json` `examples[0]` (Byzantine, member seating): `scenario.version` `1.2.0`; the catalog lists
  `shared.participation`; episodes 0 and 1 pass it, episode 2 is `not_assessed` `episode_aborted`; the summary tally
  is `2 / 0 / 1`. Its SARIF rendering has **8 rules and 12 results** (was 7 and 11), and `not_assessed` is **9** (was
  8). The three results shown in sarif-mapping.md §7 keep their text, rule index and fingerprint.
- `episode_result.schema.json` `examples[0]`, `[1]`, `[2]` (the same three episodes) and `[5]` (the squad episode).
- `openapi.yaml`: the report and episode examples (the same documents); the scenario catalog example (`grid_tactics`
  `1.1.0`, `byzantine` `1.2.0`, each listing the rule) and the Byzantine descriptor example.
- `run_spec.schema.json` `examples[1]`: `grid_tactics` pinned at `scenario_version` `1.1.0`.
- **Not changed:** `pack_manifest` `scenarios[].scenario_version` is the version of the pack's own `sx_` variant (or,
  for the Diplomacy overlay, of `diplomacy_standard`), not of the base raid module, so the signed fixture pack, its
  digest and every hosted example and vector are byte-identical.

### Added: close `4408` `seat_timeout` (errors.md §4, asyncapi.yaml `diplomacy_table`; reserved in 2.7.0)

- A table's **seat-arrival deadline** is 120 s by default, counted from table creation.
- If it expires before every agent seat is connected and bound:
  - every connected seat is closed `4408`, with no frame before the close;
  - no observation and no `diplomacy_episode_end` was sent;
  - no episode exists (no terminal, no EpisodeResult, no replay);
  - the table is gone: a later hello for its `table_id` is closed `4403`, as for any unknown or ended table.
- A client that receives `4408` does not reconnect to that `table_id`. The 2.7.0 text "there is no seat-arrival
  deadline" is replaced. RESERVED.md moves the code to "Specified at 2.8.0".

### Recorded: the Neutral Ground decisions (run_spec `seats[]` descriptions, RESERVED.md)

- **Seats are `driver: target` with `owner` = the provider slug.** A Neutral Ground seat is never `recorded_peer`.
  Neutral Ground is not a pack and has no pack id. **`sx-neutral-ground` is not introduced**: no contract names it as a
  pack id, and contract-check refuses it in any example.
- **The main seat's collusion owner stays the literal `primary`.** A seat whose provider is the primary seat's
  provider sets `owner: "primary"`, so one provider is one owner in every per-seat Report of a table.
- **Budget tier `league` reserved as a 2.9.0 candidate**, pending the Architect's ruling. The candidate dials are Dh
  30000 ms, Ds 15000 ms and the Frontier allowance (360); everything structural is as in every tier. The tier is **not**
  added to `run_spec` `budget_tier`, and a RunSpec naming it is `schema_invalid`.
  - **Open for the Architect:** the name (the passport and queue field `league` already carries the tier);
    whether the tier is Diplomacy-only; and the hosted limit. At Dh 30 s the 1908 horizon (103 ticks) can take about
    51.5 minutes per episode, close to the 55-minute `sixi_run_token` bound (signing.md §3.2 C3).

### Fixtures and tooling

- **`tools/contract-check.mjs` §12 (V2.8.0):**
  - 14 must-rejects: a participation fail at `warning` or `note`, without or with another evidence code, with one,
    four or no evidence ticks; `basis: attested`; `not_assessed` as `precondition_not_reached`, as
    `insufficient_samples`, or without a reason; two in the `report` mirror; and a RunSpec with `budget_tier: league`.
  - 4 positives: a fail with first and last tick, a fail with one actable tick (`[t, t]`), `never_actable`, and
    `episode_aborted`.
  - Linkage: every raid or duel example that names a version is at 1.2.0 or 1.1.0, lists the rule in catalog position,
    and has exactly one verdict for it per episode, with the summary tally matching. No Diplomacy example or golden
    carries a participation rule. `never_actable` is outside the not-applicable set. The §2.1 row is normative, and §2.3
    states its terms. The 4408 row and the asyncapi text are present, and the reservation is gone. RESERVED.md lists
    the two 2.9.0 candidates. The Neutral Ground decisions are in the `run_spec` descriptions, and `league` is not in
    `budget_tier`.
- **Totals:** Tier 0 checks 47 schemas and 106 examples. contract-check runs 379 negative cases.
- `openapi.yaml` and `asyncapi.yaml` `info.version` are 2.8.0. `README.md` and `versioning.md` are updated.

### Migration notes (implementation follow-ups; sequenced after this merge)

- **arena-scenarios (`src/oracles/shared.ts` `participation`):** with no actable tick, write `never_actable`
  instead of `precondition_not_reached`. The 2.8.0 schema refuses the old spelling for this oracle. The open scenarios
  never reach that branch, so no golden, anchor or hash moves.
- **arena-report:**
  - regenerate `test/fixtures/example0.sarif` from `report.schema.json` `examples[0]` (8 rules, 12 results);
  - in `test/sarif.test.ts` (the §7 worked example), expect `12` results and `not_assessed` `9`. The three documented
    fingerprints are unchanged (checked against the current emitter).
  - These two tests fail until then. They are the only arena-report tests affected.
- **arena-cli:** regenerate `src/generated/contracts.ts` (`node packages/arena-cli/codegen.mjs`).
  `codegen.mjs --check` reports drift from **description edits only**: the JSDoc comments of `seats`, and of
  `seats[].owner` and `seats[].peer.pack` (each in both generated copies). There is no type change. `wot-contracts` codegen is
  unaffected, because none of its 11 frame schemas changed.
- **arena-league (Neutral Ground harness):**
  - drop the `recorded_peer` / `sx-neutral-ground` seat role, or keep it test-only; every league seat is
    `driver: target` with `owner` = provider slug;
  - the same-provider-as-primary rule (`owner: "primary"`) is now contract text;
  - keep league tables on an existing tier until the `league` tier is specified.
- **Arena (`services/arena`):** nothing. The lobby already implements the 2.8.0 text (`seatTimeoutMs` 120 s, close
  4408, table released, later hello 4403).
- **Docs (owners):** CHAOS-DIPLOMACY.md "wording to add in the next contracts pass" is done; NEUTRAL-GROUND.md §7
  items 1, 2 and 4 point to this entry.

## [2.7.0] — 2026-09-26

**The items filed by the arena-cli hosted-mode closure (C2m) and the cross-check runner, and the Architect scheme
after ADR-003.** **MINOR**: additive, plus one pattern made precise and one scheme rename (`versioning.md` §2 has the
worked example). Sources:
- the Phase 9 C2m entry in the `docs/phase-7/PLAN.md` progress log (8836ca5);
- the implementation as committed: arena-cli `src/main.ts` (`assertHostedModeCommand`), `src/hosted/{env,manifest}.ts`,
  `src/commands/{run,run-hosted}.ts`, `src/net/context.ts`, `src/reference/run-token.ts`, and the README "Hosted
  mode" section (the G-46 URL rule and the control-plane admission checklist);
- `ascension/qa/crosscheck.ts` `anchorId` and arena-scenarios `anchors.ts`;
- ADR-003 §3 and `docs/security/agent-passports.md` §1.1;
- the Diplomacy WSS chaos test (the table channel's close codes and seat arrival), checked against
  `services/arena/src/arena.ts` and `diplomacy/lobby.ts`.

No ADR is needed. The frame protocol stays `1.0`, every schema `$id` keeps `:1`, and there is no new `$id`. **No oracle
id or SARIF rule id changes.** The two new run-token vectors and the 11 guarded-family cases were replayed against the
arena-cli implementation (`verifyRunToken`, `hostedEnvironmentProblems`) before this release: 0 mismatches.

### Added: `report.run.hosted.observed_truncated` (G-55)

- Optional boolean, written by the runner only as `true`, when `observed_connections` is incomplete: the run's
  connections presented more than 16 origin and leaf-key pairs, or more than 8 addresses for one pair. The runner keeps
  the first 16 pairs and the first 8 addresses of each, in first-seen order. Absent (or `false`) means the list is
  complete. It is a completeness marker for the attribution binding, and says nothing about the target.
- It is normally next to `observed_connections`. It is not tied to it by the schema, because the list keeps only pairs
  with an address, so a cut list of address-less pairs is empty.
- **Example:** `report.schema.json` `examples[3]`, the hosted golden with the target origin at 8 addresses and
  `observed_truncated: true`. `examples[2]`, the signed golden, is unchanged, and so is its signing vector.

### Changed: `ARENA_HOSTED` is read (G-48; signing.md §3.1, `fixtures/hosted_env.json`)

- The job-template row said "informational; not read". It now says: **read**, and it restricts the CLI to
  `run --hosted`, `verify --hosted-seal` and `version`. Presence counts, whatever the value.
- Any other command exits 3 with the new code **`hosted_mode_only`** (errors.md §1d) before anything is parsed or
  read, and the sandbox arena server refuses to start.
- The `hosted_context` description says the same.

### Added: guarded name families (G-50; signing.md §3.1.3)

- On top of the closed must-be-absent lists, the runner refuses every `ARENA_*`, `NODE_*`, `SSL*` and `OPENSSL*`
  variable, and every proxy variable, unless it is:
  - a job-template variable;
  - a per-run secret variable;
  - `NODE_ENV=production`, `NODE_VERSION` or `YARN_VERSION`, which the image sets.
- Matching ignores case. The refusal is `hosted_context_invalid` (`environment`).
- `hosted_env.json` gains `guarded_families`, with 11 cases.

### Added: hosted admission, normative for the control plane (signing.md §3.2)

The README's control-plane admission checklist gets its normative home. There are 17 numbered rules. Each has the
runner refusal that mirrors it, so both sides refuse the same run:
- **Target (A1 to A5):**
  - A1: no userinfo, query or fragment in `target.url`, a bare `?` or `#` included (G-46);
  - A2: `https:`, or `wss:` for `ws`;
  - A3: the origin is exactly the verified origin and the allowlist target, with an ownership check at most 24 h old;
  - A4: no `seats[]` in a single-target profile;
  - A5: no recorded peers until K7.
- **Credential mode (C1 to C4):**
  - C1: `none` means no `target.auth` and no credential delivered;
  - C2: otherwise the ref is exactly `env:ARENA_TARGET_CREDENTIAL` and the credential is delivered;
  - C3: a `sixi_run_token` run ends within 55 minutes of minting;
  - C4: no seat credentials without seats.
- **Manifest and job (M1 to M8):**
  - M1: `issued_at` at most 5 minutes in the future and at most 24 h old;
  - M2: the deadline has not passed, and is at most 48 h after `issued_at`;
  - M3: a pinned, kid-bound manifest key;
  - M4: the image is promoted, and the latest cross-check record for it and its engine build has `job_verdict: pass`;
  - M5: exactly the job-template variables;
  - M6: exactly the hosted command line;
  - M7: the Diplomacy secrets;
  - M8: the packs.
- **The seal step** passes `--expect-manifest-digest`.
- errors.md §1d `hosted_context_invalid` lists the fields these add: `/issued_at`, `/wall_clock_deadline`,
  `/verified_origin/checked_at`, `/egress_allowlist`, `/engine_build_hash`, and `environment` for §3.1.3.

### Added: run-token lifetime cap (G-53; signing.md §10)

- **Minting:** `exp` ≤ min(`wall_clock_deadline` + 5 min, `iat` + 3600), and Sixi-minted tokens set `iat`.
- **Verifying:** `exp − iat ≤ 3600` when `iat` is present (no skew: one clock), and `exp − now ≤ 3600 + 60`. Both are
  `exp` failures, so the same `401 invalid_token`. errors.md §1e says so.
- **Must-reject vectors:**
  - `reject-lifetime-2h`: `exp − iat` = 7200, with `exp` only 30 minutes ahead;
  - `reject-exp-90min-ahead`: no `iat`, and `exp` 90 minutes ahead.

  Each breaks exactly one bound, and contract-check proves that each is valid apart from the cap. The total is 23
  tokens: 3 accepts and 20 must-rejects (this entry first said 4 and 19; corrected 2026-09-27 against the fixture,
  which a second, independent Go verifier replayed). The existing 21 are byte-identical.

### Changed (made precise): `crosscheck_record` leg A `anchor_id`

- **The old example could not distinguish the fills.** `byzantine/core/squad/20260720` had no seed segment and no
  policy, so it could not tell a coordinated from a naive anchor, and no runner ever wrote it.
- **The runner writes** `anchorId(name)`: the anchor name lower-cased, each run of other characters replaced by one `/`.
- **The pattern is now that grammar:** `<scenario>/<tier>/seed/<seed>/<seating…>/<policy>[/<qualifier>…]`, with tier
  `edge|core|frontier` and a canonical decimal seed. Some ids:
  - `byzantine/core/seed/1/squad/naive/gate`;
  - `deadlock/edge/seed/20260720/member/m1/coordinated`;
  - `grid_tactics/core/seed/20260720/a/reflex/vs/silver`.
- **`maxLength` goes from 80 to 128,** a relaxation. At 80 no Diplomacy anchor id fit
  (`diplomacy_standard/core/seed/20261115/germany/robust/fill/engine/horizon/1904/engine/golden` is 88 characters), so
  the runner dropped the id.
- **The example is now `byzantine/core/seed/20260720/squad/coordinated`,** the id the runner writes for that cell
  (seed 20260720 resolves to the non-gate row). The unsigned `examples[1]` is the only example that carries it.
- **Every id the 104 anchors produce matches the new pattern.**

### Changed (rename): `firebaseAuth` becomes `architectBearer` (openapi.yaml; ADR-003 §3)

- The management security scheme is now `architectBearer`: `http` `bearer`, with `bearerFormat: architect+jwt`.
- Its description is the claims contract of agent-passports §1.1:
  - header `alg` `EdDSA`, `typ` `architect+jwt`, and `kid` in the issuer's JWKS;
  - `iss` = the configured issuer;
  - `aud` contains `agent-arena:architect`;
  - `sub` opaque (never PII);
  - `iat` and `exp` required, and at most 1 h old (30 s skew);
  - other claims ignored.
- **Where it is used:** the 7 operations that used the old scheme (register, rotate, revoke, and the webhook
  management operations).
- **Wording:** the auth-model text and the tag descriptions are reworded, and so are errors.md `unauthenticated` and
  webhooks.md registration.
- **Why this is not a MAJOR:** the scheme name was never enforced on the wire. It is a key inside the OpenAPI document,
  the header is `Authorization: Bearer <token>` before and after, and no client sends a different header. What the
  server accepts changed with ADR-003 (passports verifies an EdDSA `architect+jwt` against a configured JWKS). The
  scheme now describes it.
- The old name remains only in the historical entries of this changelog.

### Changed (made precise): Diplomacy table close codes and seat arrival (the Diplomacy WSS chaos test)

- **`4413` applies only before the seat is bound** (errors.md §4, asyncapi.yaml `diplomacy_table`).
  - Until the Diplomacy hello is accepted, the connection has the duel edge cap of 8192 bytes. A frame of 8193 to
    16384 bytes is refused `too_large`, and the fifth closes `4413`.
  - After binding, the table's cap (16384) equals the WebSocket limit, so every oversize frame closes `1009`.
  - The 2.4.0 text, "repeated frames over the 16384-byte cap", described a case that cannot occur.
  - This is wording only. No code is added, removed or renumbered.
- **Seat arrival:** a table starts only when every agent seat is connected and bound. Today there is no seat-arrival
  deadline, so a table whose seats never all connect never starts.
- **Reserved close `4408` `seat_timeout`** (RESERVED.md) for the intended deadline. No 2.7.0 server sends it, and a
  client that receives it does not reconnect to that `table_id`. Specifying it later is additive.

### Fixtures and tooling

- **`tools/signing-vectors.mjs`:** the two lifetime vectors. `vectors`, `receipt_vectors`, `pack_vectors`, the press
  vectors and the fixture pack are byte-identical.
- **`tools/contract-check.mjs` §11 (V2.7.0):**
  - the lifetime rules in the §10 verifier, and the one-bound proof of the new vectors;
  - accepted vectors keep `exp − iat ≤ 3600`;
  - the guarded families written from §3.1.3 against the fixture cases, with the job-template names in the allowed
    set and named in §3.1.3;
  - the `ARENA_HOSTED` row read in both places, and `hosted_mode_only` in errors.md;
  - every §3.2 rule id present once;
  - the `observed_truncated` example at a cap;
  - 8 new must-rejects: `observed_truncated` not a boolean or outside `run.hosted`, the old `anchor_id`, and five
    `anchor_id` grammar breaks;
  - 5 runner `anchor_id` spellings that must validate;
  - `architectBearer` defined, described and used, every used scheme defined, and no Firebase name in the live
    contract files.
- **Totals:** Tier 0 checks 47 schemas and 106 examples. contract-check runs 365 negative cases.
- `openapi.yaml` and `asyncapi.yaml` `info.version` are 2.7.0. `README.md` and `versioning.md` are updated.

### Migration notes (implementation follow-ups; sequenced after this merge)

- **arena-cli:**
  - **Regenerate `src/generated/contracts.ts`** (`node packages/arena-cli/codegen.mjs`). `codegen.mjs --check` reports
    drift now: one type change, the new optional `observed_truncated?: boolean` on the hosted record. The rest are
    description edits (`report` hosted, `hosted_context`, `crosscheck_record` `anchor_id`).
  - After the regeneration, `OBSERVED_TRUNCATED_IN_CONTRACT` becomes true and the marker is written. Drop the "no
    marker field yet" comment in `run.ts`.
  - `run-token.ts` already implements §10's cap. The tests can read the two new vectors.
  - `env.ts` already implements §3.1.3. The tests can read `hosted_env.json` `guarded_families.cases`.
- **Cross-check runner (`ascension/qa/crosscheck.ts`):** set `ANCHOR_ID` to the schema pattern and 128 characters.
  The Diplomacy anchor ids then fit and are written.
- **Control plane (SIXI-INTEGRATION PR 3, 4 and 6):**
  - apply signing.md §3.2 at admission;
  - `runtoken.go` sets `iat`, with `exp` ≤ min(deadline + 5 min, `iat` + 1 h);
  - a `sixi_run_token` run whose deadline is more than 55 minutes after minting is not admitted. **Open for the
    Architect:** whether longer plans need a token-refresh path;
  - the job template sets `ARENA_HOSTED=1` and nothing else of the §3.1.3 families.
- **Sandbox:** `sandbox/Dockerfile` must not set `WOT_CONTRACTS_DIR`. This was already filed by C2m: it is
  must-be-absent.
- **Arena (`services/arena`):** the seat-arrival deadline, when it is built, uses the reserved `4408` `seat_timeout`.
  Its value is specified in the same contract release.
- **Docs (owners):**
  - SIXI-INTEGRATION §1.7: `ARENA_HOSTED` is read;
  - the arena-cli README: the admission checklist points to signing.md §3.2;
  - HOSTED-PROFILE §2.x: the run-token lifetime.

## [2.6.0] — 2026-09-26

**The contract gaps that the arena-cli hosted mode found.** **MINOR**: additive, plus one withdrawal of an input no
runner ever read (`versioning.md` §2 has the worked example). Sources:
- the Phase 9 B1-cli entry in the `docs/phase-7/PLAN.md` progress log (e1c244b);
- the implementation as committed: arena-cli `src/hosted/{packs,env,manifest,seal}.ts`,
  `src/commands/{run-hosted,verify}.ts`, `src/reference/run-token.ts`, and the README "Hosted mode" section.

No ADR is needed. The frame protocol stays `1.0`, and every existing schema `$id` keeps `:1`. There is one new `$id`,
`wot:pack_variant:1`. **No oracle id or SARIF rule id changes.** Every new vector and fixture was also replayed against
the arena-cli implementation before this release: the 21 run tokens, the fixture pack, and the 10 image-digest cases
all agree with it, and the must-be-absent table equals the CLI's refusal list.

### Added: scenario-pack packaging (signing.md §11)

- **Envelope `pack.dsse.json`:** DSSE, payload type **`application/vnd.sixi.arena-pack+json`**, payload = the pack
  manifest as JSON (the signature covers the exact bytes; JCS recommended), 1 to 4 signatures, standard base64.
  - **Key:** a key of the pinned control-plane (run-manifest) key set, named by `keyid`. The payload type keeps a pack
    signature from verifying as a run manifest, and the reverse. signing.md §2's table gains the row.
  - **Pin:** `packs[].digest` = sha256 of the exact envelope bytes, signatures included. The description of that field
    is made precise in `hosted_context` and in its mirrors in `report` and `evidence_report` (it said "sha256 of the
    signed pack bundle").
- **Layout:** `$ARENA_PACKS_DIR/<id>/pack.dsse.json`, plus each variant data file at `<id>/<data.ref>` (conventionally
  `variants/<name>.json`). Files are opened without following links, must be regular files, and are capped:
  - envelope 524288 bytes;
  - decoded payload 262144 (`pack_manifest` `x-max-frame-bytes`);
  - variant file 65536.
- **Load order (§11.3), nine steps before any I/O,** each refused `scenario_pack_unavailable`, except an engine build
  outside `engine.builds`, which is `pack_engine_mismatch`.
- **Must-rejects:** a wrong payload type (another Sixi type included); an unsigned envelope (no signatures, or none
  that verifies); a tampered payload; a digest that differs from the pin; an engine range that excludes the build; a
  pack id or data ref that attempts traversal (`<id>` matches `^sx-[a-z0-9-]{1,40}$`, and a resolved data path must
  stay inside `<id>/`).
- **Variant resolution (§11.4):** exactly one mounted pack declares the `sx_` id. The RunSpec's tier, seeds and seat
  mode must match what the variant pins or allows, and are never silently overridden. The current runner build then
  still refuses the run (`scenario_pack_unavailable`), because it cannot yet report a pack scenario. This is stated
  as such.
- `pack_manifest` description: the signature sentence now names the envelope and the key set ("the Sixi pack key"
  named no key the runner pins).

### Added: `schemas/pack_variant.schema.json` (`wot:pack_variant:1`, `arena-pack-variant/1`)

- The parameter file of an `sx_` variant, **exactly what the loader accepts**: `format` (required),
  `tier` (`edge|core|frontier`), `seeds` (1 to 1000 uint32), and `oracle_thresholds` (at most 64, each 0..1, keyed by
  an oracle id of the base catalog). Any other member is refused.
- **Deviation from the brief ("base scenario, tier overrides, …"):** the base scenario is **not** in the file. It is
  the signed manifest's `scenarios[].base`, and the loader refuses a `base` member. "Tier" is one pinned tier, not a
  set of per-tier overrides. The allowed tiers and seat modes stay in the manifest entry.
- The semantics of a threshold are specified with pack-scenario reports. This release fixes the key set and range.
- `pack_manifest` `examples[0]` `scenarios[0].data.digest` is now the real digest of the fixture variant file. It was a
  placeholder, and nothing else referenced it.

### Added: `ARENA_IMAGE_DIGEST` and the variables that MUST be absent (signing.md §3.1, §3.1.1, §3.1.2)

- **`ARENA_IMAGE_DIGEST` (required):** `<index digest>,<platform manifest digest>`, set by the fixed job template (the
  same for every run of an image, not secret, never an override).
  - The runner parses 1 to 8 comma-separated `sha256:<64 hex>` values. It requires both manifest `image_digest`
    values in the list and `platform` = the running platform.
  - Refusals are `hosted_context_invalid`: `/image_digest` (absent or malformed), `/image_digest/index`,
    `/image_digest/platform_manifest`, or `/image_digest/platform`.
- **`ARENA_PACKS_DIR`** (required when `packs` is not empty), `NODE_OPTIONS` (empty only) and `ARENA_HOSTED`
  (informational) are documented in the same job-template table.
- **Must be absent (normative, closed list):** `AGENT_ARENA_SECRETS_DIR`, `ARENA_DEBUG`, a non-empty `NODE_OPTIONS`,
  `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSLKEYLOGFILE`, `NODE_V8_COVERAGE`,
  `WOT_CONTRACTS_DIR`, `ARENA_HOSTED_CONTEXT`, `ARENA_RUN_SPEC`, `ARENA_EPISODE_SECRETS`, and a malformed
  `ARENA_DIP_SECRET_*` name. Each has its `detail.field`: `environment`, `manifest_source` or
  `episode_secret_commitments`. Presence is what counts. Node diagnostic flags are refused too (`/`).
- **Absent for a given manifest (§3.1.2):** `ARENA_TARGET_CREDENTIAL` under `credential_mode: none`,
  `ARENA_SEAT_CREDENTIAL_<POWER>` without `seats[]` targets, and `ARENA_DIP_SECRET_<n>` outside Diplomacy or beyond
  `count`.
- **Machine-readable copy:** `fixtures/hosted_env.json`, which contract-check keeps equal to the signing.md tables.
- `hosted_context.image_digest` description (and its mirrors in `report`, `evidence_report` and `crosscheck_record`)
  names the variable and the refusal fields.
- errors.md §1d `hosted_context_invalid` lists the new causes and fields.

### Clarified (withdrawal): no environment form of the run manifest or the RunSpec

- `ARENA_HOSTED_CONTEXT` and `ARENA_RUN_SPEC` are removed from every note. That covers the `hosted_context`
  description, `run_spec_digest`, signing.md §3.1, errors.md §1d, and the RESERVED.md "Deprecated at 2.5.0" section,
  which becomes "Withdrawn at 2.6.0" and keeps the names retired.
- **The names still appear once, in the must-be-absent table.** That is where the CLI puts them: presence is refused,
  `manifest_source`. A table that left them out would not be the full refusal list the brief asked for.
- **Why this is not a MAJOR:** 2.5.0 introduced the form already deprecated, the CLI refused it from its first build,
  and the sandbox passes files. No producer or consumer ever depended on it.
- The 2.5.0 rule "a runner given both forms refuses" becomes: a runner given **either** variable refuses.

### Added: the hosted bundle and `verify --hosted-seal` (signing.md §5.1)

- **Layout as built, against `bundle_manifest.schema.json`:**
  - `report.json`: sealed in place, with `signing`;
  - `report.sarif`: never rewritten by the seal;
  - `run-manifest.json`: a byte copy of `--manifest`;
  - `episodes/<n>.record.json` and `episodes/<n>.replay.json`, where `<n>` is the 0-based episode index;
  - optional `evidence.json` and `evidence.html`;
  - three envelopes, `report.json.dsse.json`, `report.sarif.dsse.json` and `bundle-manifest.json.dsse.json`, with
    `bundle-manifest.json`, which lists every non-envelope file.
- **Pre-seal rules 1 to 6 and sealed rules 7 to 9**, and the exit codes: 0 verified, 1 mismatch, 2 seal or
  signature, 3 misuse.
- **Seal precondition (signing.md §3 rule 2, errors.md `seal_failed`):** `verify --hosted-seal <out dir>` exits **0**
  on the unsealed bundle. This replaces "`verify` returned verified".
- `bundle_manifest` description: `verify --hosted-seal` (it said `verify --hosted`).

### Added: run-token profile for reference targets (signing.md §10)

- **Token:** a compact JWS with the header allow-list `{alg: EdDSA, typ: at+jwt, kid?}`, Ed25519 over
  `header.payload`, canonical base64url, and at most 4096 characters.
- **Claims:**
  - `aud` = `verified_origin.origin`;
  - `sub` = `run_id`, which must equal `X-Agent-Arena-Run`;
  - `exp` ≤ `wall_clock_deadline` + 5 min, with 60 s skew;
  - optional `nbf` and `iat`;
  - `jti` of 8 to 128 characters: unique per token, not single-use per request;
  - optional `iss`, compared when the verifier is configured with one;
  - optional `org`, which is ignored.
- **kid rule as built:** a token without `kid` is checked only against kid-less pinned keys, and Sixi always sets `kid`.
- **Refusals:** a uniform `401 invalid_token` (RFC 6750), and `421 misdirected_request` for a foreign `Host`. errors.md
  gains §1e for both.
- **Placement:** signing.md §9 is taken by deletion receipts (2.5.0), so the profile is **§10** and packs are §11.
  Renumbering §9 would break its 2.5.0 references.
- **Vectors:** `fixtures/signing_vectors.json` `run_token_vectors`, 21 tokens with 4 accepts and 17 must-rejects.

### Changed (wording only): neutral branding

- The pre-pivot game name, its `.gg` domain and its protocol-spec path are removed from the contract text, as flagged by
  `ascension/scripts/branding-check.mjs`. This is wording only: no field, pattern, enum, code or rule changes.
  - **Example hosts:** the example hosts in `openapi.yaml` (the servers, the passport `token_endpoint`/`jwks_uri`, the
    OAuth `tokenUrl`, and the `arena_url`/`spectate_url` examples) and the `asyncapi.yaml` server hosts are now
    `api.example.org`, `passports.example.org` and `arena.example.org`. The `webhook_event` example, which ships in
    the CLI bundle, uses the same hosts.
  - **Historical text:** it now says "the pre-pivot game prototype", in `openapi.yaml` `info.description`,
    CHANGELOG (the title, 2.0.0 and the legacy-spec reconciliation), `versioning.md` and errors.md §5.
- The branding check reports no hits under `contracts/`.

### Fixtures and tooling

- **`tools/signing-vectors.mjs`** also writes:
  - `pack_vectors`;
  - the fixture pack `fixtures/packs/sx-agentic-core/pack.dsse.json`, after checking the variant file against the
    pinned digest;
  - `run_token_vectors`.

  The existing `vectors`, `receipt_vectors` and press vectors are byte-identical.
- **`fixtures/hosted_env.json`** (new).
- **`tools/contract-check.mjs` §10:**
  - the run-token vectors against a verifier written from §10, with every reject reason covered;
  - the fixture pack opened per §11.3, the linkage of variant digest and schema, and domain separation;
  - 8 envelope must-rejects, plus the digest-pin, cap and engine-range cases;
  - 28 schema must-rejects: traversal in the pack id and data ref, `pack_variant`, and bundle paths;
  - the §5.1 bundle-list rule with 4 mutations;
  - the signing.md §3.1 tables against `hosted_env.json`, the `ARENA_DIP_SECRET` name patterns, and the 10
    `ARENA_IMAGE_DIGEST` cases;
  - a lint that no contract text offers the withdrawn env form;
  - `pack_variant` and `hosted_env.json` in the R1 wording lint.
- **Totals:** Tier 0 checks 47 schemas and 105 examples. contract-check runs 357 negative cases.
- `openapi.yaml` and `asyncapi.yaml` `info.version` are 2.6.0. `README.md` and `versioning.md` are updated.

### Migration notes (implementation follow-ups; sequenced after this merge)

- **arena-cli:**
  - **Regenerate `src/generated/contracts.ts`** (`node packages/arena-cli/codegen.mjs`). `codegen.mjs --check` reports
    drift now, from description edits in `hosted_context` and `pack_manifest` only. No type changes.
  - `assertHostedEnvironment`: put `(environment)` in the refusal message. Today it names no field, and the contract
    field is `environment`.
  - `sealedBundleProblems`: also require `report.json`, `report.sarif` and `run-manifest.json` in
    `bundle-manifest.json` (§5.1 rule 9). The schema description has always said "always includes", and today only
    the episode files are enforced.
  - Tests: read `fixtures/hosted_env.json` (the must-be-absent names against `HOSTED_FORBIDDEN_ENV`, and the image
    cases against `checkImage`), `run_token_vectors` (against `hostedReferenceAdmission`) and
    `fixtures/packs/sx-agentic-core` (against `loadPacks`). All of them pass against e1c244b today.
  - `packs.ts`: drop the "Not yet in contracts/signing.md" comment on `PACK_PAYLOAD_TYPE`.
  - RESERVED.md "Deprecated at 2.5.0": the CLI stops writing the RunSpec labels `arena.diplomacy_fill` and
    `arena.press_redactions` at this release, as that section scheduled.
- **Control plane (SIXI-INTEGRATION PR 3 and PR 5):**
  - the job template sets `ARENA_IMAGE_DIGEST=<index>,<platform manifest>`, and `ARENA_PACKS_DIR` when packs are
    mounted;
  - the pack store signs `pack.dsse.json` with a key in the pinned manifest JWKS;
  - `runtoken.go` sets `kid`, and `exp` ≤ deadline + 5 min.
- **Docs (owners):**
  - SIXI-INTEGRATION §1.7: the env table gains `ARENA_IMAGE_DIGEST`, and drops "(the env form is deprecated, local
    sandbox only)";
  - HOSTED-PROFILE §5: the pack envelope and layout;
  - threat-model-hosted §3.3: the must-be-absent list.

## [2.5.0] — 2026-09-26

**Gap closure after Phase 8 B3d, B5b and F-1, Phase 7 C2g, C2h and C2k, plus four Phase 9 hosted additions.**
**MINOR**, with one golden correction and no rule change (`versioning.md` §2 has the worked example). Sources:
- the contract gaps in the `docs/phase-7/PLAN.md` progress log (B3d, C2k, C2h, C2g, B5b, F-1);
- the implementation as committed: `wot-engine` `press.ts`, `arena` `diplomacy/{lobby,table,wire}.ts`, and arena-cli
  `runner.ts` and `diplomacy.ts`;
- the evidence renderer;
- `docs/phase-9/SIXI-INTEGRATION.md` OQ-2 and OQ-11;
- `docs/phase-9/CROSSCHECK.md` §9.

No ADR is needed. The frame protocol stays `1.0`, and every existing schema `$id` keeps `:1`. There is one new `$id`,
`wot:deletion_receipt:1`. **No oracle id or SARIF rule id changes.**

### Added: press reject `clause_beyond_horizon` (F-1)

- **`diplomacy_press_reject.code`** gains `clause_beyond_horizon`: an offer or counter with a clause that covers a
  movement phase after the game's final one, F<final_year>M. Such a clause could never settle. The engine has
  refused it since `wot-dip-scenario/2`, and the wire layers sent `terms_invalid`.
- **Where it sits in the check order:** it shares the `terms_invalid` position. Terms are checked clause by clause
  (give, then want). Within a clause the phase-range rules come first (`terms_invalid`), then the horizon
  (`clause_beyond_horizon`), then the other fields. The first failing clause decides.
- **When it can happen:** only when the horizon is before 1908. A phase after 1908 fails the action schema and is
  frame-level `schema_invalid`.
- **Schema rule:** the code is allowed only with `move` `offer` or `counter`, when `move` is present. The conditional
  applies to the new value only.
- **Supporting changes:**
  - errors.md §3e gains a row and a fixed hint;
  - `budget.press.rejected_other` counts it;
  - `diplomacy_press_reject` gains `examples[4]`.
- **The clause span, made precise** (the shared `clause` `$def` in every `diplomacy_*` schema, and errors.md): to_phase
  is at most 4 movement phases after from_phase, so one clause covers at most **5**. That is the engine's and the
  design's `to − from ≤ 4`. The old words "a span over 4 movement phases" were ambiguous.

### Changed (made precise): commitment settlement, renounce

- **Settlement per phase** (`diplomacy_commitment` description): a clause settles each covered phase exactly once, at
  that phase's ADJUDICATION. **Nothing settles at a round close.** A renounce is recorded when it is delivered, and
  the clauses it releases settle `renounced` at their phases' adjudications. So a commitment ends only at an
  adjudication.
  - This corrects the 2.4.0 observation text "or a renounce delivered at that round close released it". That cannot
    happen; B3d found it.
  - `diplomacy_observation.commitments`, `diplomacy_renounce`, and asyncapi round-close rule 6 now say this.
- **Clause `status` for a multi-phase clause:** `escrowed` until every covered phase has settled. Then it is the
  **aggregate**, first match wins:
  1. `broken` if any phase was broken;
  2. else `kept` if any phase was kept;
  3. else `renounced` or `released`, after the latest release settlement;
  4. else `void`.
- **`settled_phase` and `settled_tick`** are those of the **last** settlement. So a commitment ended at the greatest
  `settled_tick` of its clauses, which is the visibility rule both implementations already use.
- **Deviation from the brief, which asked for "status = last settlement".** Both implementations already emit the
  aggregate, and the oracle reads it. With a last-settlement status, a clause broken in S1903M and kept in F1903M
  would read `kept` on the wire while `commitment_broken` cites it as broken. The per-phase history now travels
  separately:
- **`settlements[]`** (new, optional) on each clause: `{phase, status, tick}` per settled phase, in phase order, 1 to
  5 items. It may be present while the clause is still `escrowed`.
  - It fixes the C2g gap "commitment history on the wire carries only the last settlement".
  - Worst-case record: 12 clauses × 5 settlements plus a renounce is 7.3 KB pretty-printed, under the 8192-byte cap.
- **`state`:** `active` while any clause is escrowed. `ended` only at an adjudication.
- **Renounce of an ended commitment: refused `commitment_unknown`, never an accepted no-op.**
  - The 2.1.0 text ("no active commitment the sender is a party to") already said so, and the engine diverged by
    accepting it.
  - Why refuse: a renounce is notice about future clauses, and an ended commitment has none. Accepting it would
    deliver a message about nothing, count it in `renounces_sent`, and set a `renounced` record on a commitment no
    observation shows again.
  - The code also covers "already renounced" (as the engine does at round close) and "another counterparty".
- **New finding: `renounce.releases_from_phase` widened to `S1909M`.** A renounce delivered in round R of F1908M
  releases from the next movement phase, `S1909M`. Both wire layers compute that value, and the 2.4.0 pattern refused
  it. This is the same class of bug as F-1. The pattern now also accepts `S1909M`, which releases nothing, like any
  value after the commitment's last covered phase. Widening a pattern is additive.
- **Examples:**
  - `diplomacy_commitment` `examples[3]`: part-way through a multi-phase clause, a reciprocity release, and broken
    then kept aggregating to `broken`;
  - `diplomacy_commitment` `examples[4]`: a late renounce that released nothing, and the clause judged `broken`;
  - `diplomacy_renounce` `examples[1]`: `S1909M`.

### Added (documented): oversize Diplomacy hello, close 1009

- **A hello over 2048 bytes** gets `reject` `too_large` with `retryable: false` and `turn_id: null`.
  - It is checked before the schema. A schema-valid hello always fits, because the token is at most 1500
    characters. `tools/contract-check.mjs` proves it.
  - The socket is not closed for it. An unauthenticated session is closed **4401** when its hello timer expires.
- **errors.md §3a:** a `hello` (duel or Diplomacy) over its cap is not retryable, while every other `too_large` still
  is.
- **errors.md §4:** close **1009** is documented. It applies to any frame over 16384 bytes and is closed by the
  WebSocket layer before any application check.
- Also documented in `diplomacy_hello` and asyncapi `diplomacy_table`.

### Changed (documented): `signature_modes` is a hello-time snapshot

- **`diplomacy_session_ack.signature_modes`** is computed once and never re-sent.
  - `session` depends only on the deployment and the table, so it cannot change during a session.
  - `key` says only whether the passport had a key at hello.
- **The arena re-resolves the key for every frame that carries a JWS-signed move** (B3d; signing.md §7.5 now has a
  "live table sessions" bullet):
  - after a rotation, the new key verifies from the next frame and the previous one is refused, with no reconnect;
  - a passport that registers its first key after hello can make `key` moves at once.
- Also documented in asyncapi `diplomacy_table`.

### Added: `episode_result.budget.press.redactions` (G-40)

- An integer ≥ 0 (optional; mirrored in `report.$defs.episode_result`): how many credential-shaped spans, or
  registered secrets, in the target's press the runner replaced at the edge before the engine read the action.
- It is attested, not re-derivable, because the record holds the redacted bytes. `verify` carries it over unchecked,
  like `decision_ms_*`.
- A redacting producer writes it for every Diplomacy episode it drove over a transport, 0 included. It is absent for
  in-process targets.
- It does not feed `shared.budget_violation`.
- It replaces the CLI's RunSpec label `arena.press_redactions`, which is a per-run sum written only when above 0.
  The label is **deprecated**: the CLI keeps writing it through 2.5.x and stops at 2.6.0. `RESERVED.md` has a
  "Deprecated at 2.5.0" table, which also records `arena.diplomacy_fill` → `diplomacy.fill` (2.4.0).
- Example: `episode_result` `examples[6]`.

### Clarified: `report.engine.build_scope`, `source_manifest_digest` (C2h)

- **`build_scope`** is recorded when the producer knows its scope: arena-report writes it whenever its caller passes
  the scope, and the CLI always does. It is never required. Readers assume the scenario's scope when it is absent,
  and no reader may refuse a Report for lacking it.
- **`source_manifest_digest`** covers **every file** (scope `all`), whatever `build_scope` says. A producer MAY omit
  it from a scoped Report. The core goldens do not record it **by design**: a Diplomacy edit would churn every core
  golden, which is what `build_scope: core` exists to prevent. It is used to match a bundle to its manifest, never to
  recompute `build_hash`.

### Clarified: SARIF (`sarif-mapping.md` §2, §3, §4) and one golden correction

- **The review sentence** follows the **verdict's** `review_required` flag, never the rule's, as implemented.
  - The rule's flag decides only the §2 descriptor members.
  - A `fail` whose verdict carries the flag ends with one space and then the sentence. A `fail` whose verdict lacks
    it gets no sentence, even under a review-required rule.
  - contract-check tests both directions.
- **`evidence_ids` are ids, never prose.**
  - The emitter keeps an id only if it matches the §4 pattern and **silently drops** every id that does not. It never
    truncates, escapes, rewrites or fails.
  - The pattern bounds syntax only: a matching id is still opaque data.
  - A dropped id is an engine defect, because target text never becomes an id.
- **`fullDescription`** is omitted when the catalog entry has no description.
- **The not-applicable set, stated once (§3).**
  - `notApplicable` = the three generic codes plus the §2.1 Diplomacy codes `no_request_delivered`,
    `single_owner_table`, `shared_owner` and `no_canary_delivered`.
  - Every other code is `open`, including `sample_out_of_table`, which "could apply, not measured".
  - The same set is "not assessed by catalog design" for `report.summary.verdict` (description updated), so a
    single-target Diplomacy run is not `inconclusive` only because collusion cannot apply to it.
  - The coordinator's note proposed `sample_out_of_table` as `notApplicable` as well. That is not taken: §2.1
    (2.4.0) makes it `open`, and by the note's own definition it could apply but was not measured.
- **Golden correction:** `fixtures/hosted_report.sarif` and the §7.1 excerpt rendered collusion `single_owner_table`
  as `open`, contrary to §2.1 (since 2.1.0) and to the `evidence_report` example (`notApplicable`).
  - 2.5.0 corrects the golden to `notApplicable`. That is one value, and `kind` is not a fingerprint input, so no
    alert moves.
  - contract-check now derives the kind of every `not_assessed` result, and every evidence `sarif_kind`, from the
    set.

### Added: evidence report `clause_unresolved`

- **`evidence_report.not_assessed.unresolved_clauses`** (optional): `{clause_id, pack, reason_code:
  "clause_unresolved"}` for each clause id a mounted pack names that the renderer's corpus snapshot does not resolve.
- An unresolved id is listed **only** there: in no finding, record, `assessed_no_finding_clauses` or coverage list,
  and never with a title. contract-check enforces this.
- The pack load still refuses an unresolved id at admission.
- This relaxes EVIDENCE-REPORT-TEMPLATE R4 from "fails the build" to "never cited, listed here". The template text
  follows (Architect or lore-docs-writer).
- Example: `evidence_report` `examples[1]`.

### Changed: cross-check record, anchor leg and local scope (CROSSCHECK.md §9 item 2)

- **Leg `A` is the frozen anchor.**
  - It requires only `replay_hash`, `outcome` and `terminal_tick`, which is what `anchors.ts` freezes. The other
    legs still require all seven fields.
  - `trajectory_class` and `evaluation_hash` are compared when present. The 2.2.0 fields are still accepted.
  - The new optional `anchor_id` names the anchor.
- **`scope: hosted | local`** (optional; absent = `hosted`, the 2.2.0 meaning).
  - A `local` record has no H, and leg V is empty (`reports_total` 0).
  - It may end `pass` when every cell matches. That means the open legs agree with each other and with the anchors.
  - It **never promotes a digest** and is never cited by an evidence report.
  - A hosted-scope pass still needs H.
- Example: `crosscheck_record` `examples[1]`, a local pass of O1 plus the anchor.

### Added: hosted delivery by file, episode-secret variables (OQ-2, OQ-11)

- **Files, not overrides** (signing.md §3.1). The hosted runner reads the run manifest and the RunSpec from read-only
  files: `agent-arena run --hosted --manifest <file> --run-spec <file>`, capped at 8192 and 16384 bytes.
  - Reason: a Cloud Run per-execution env override is kept in execution metadata and in the Admin Activity audit log.
  - The env form (`ARENA_HOSTED_CONTEXT`, `ARENA_RUN_SPEC`) is **deprecated**: local sandbox only, removed at the next
    MAJOR.
  - A runner given both forms refuses with `hosted_context_invalid` (`detail.field: manifest_source`).
- **`ARENA_DIP_SECRET_<n>`** (as the coordinator named it): one variable per episode index n = 0..count-1, each
  exactly 64 lower-case hex characters, backed by secret references.
  - The runner requires exactly `episode_secret_commitments.count` of them, checks each against its commitment and the
    list against the manifest digest, and deletes them on load.
  - Any mismatch is `hosted_context_invalid` (`episode_secret_commitments`).
  - SIXI-INTEGRATION proposed a single `ARENA_EPISODE_SECRETS` JSON array. That form is not taken: at the
    1000-episode ceiling it is about 67 KB, over the 64 KiB Secret Manager payload limit.
- **Confirmed unchanged since 2.2.0 (K6):** `ARENA_TARGET_CREDENTIAL` and `ARENA_SEAT_CREDENTIAL_<POWER>` (upper-case
  power, for example `ARENA_SEAT_CREDENTIAL_FRANCE`).
- **Erratum:** `threat-model-hosted.md` §3.3 says `ARENA_TARGET_AUTH`. The contract name is `ARENA_TARGET_CREDENTIAL`.
  The threat model is corrected by its owner.
- errors.md §1d `hosted_context_invalid` and `hosted_context` descriptions updated.

### Added: `schemas/deletion_receipt.schema.json` (`wot:deletion_receipt:1`, OQ-11)

- **What it is:** the signed receipt of a hosted deletion. Its scope is a run, a scan, data before a date, or the
  organisation, and the schema conditionals pin which id each scope carries.
- **Fields:**
  - trigger: `api_request` or `account_erasure`;
  - `requested_at`, `purged_at` and `backups_purged_by`, where the last is `purged_at` plus the longest backup
    horizon, and soft delete ≤ 7, PITR ≤ 7 and backups ≤ 14 days;
  - the data classes deleted, with counts, 0 included;
  - what is retained and why: the audit log (730 days) and the transparency log;
  - `retention_policy_ref` (`<policy>@<date>`).
- **What it cannot hold:** no origin, target, label or credential; `org_ref` only.
- **Signing:** with the report key, payload type `application/vnd.sixi.arena-deletion+json` (signing.md §9).
- **Test vector:** `fixtures/signing_vectors.json` gains `receipt_vectors`, a separate list, so the readers that
  assert three 2.2.0 vectors are unaffected. The press vectors are byte-identical.
- **Surfaces:** the deletion routes are Sixi surfaces, reserved in `RESERVED.md`.

### Tooling

- **`tools/contract-check.mjs` §9**, in total:
  - 64 more must-reject cases (329 in total);
  - positive controls for every new baseline;
  - 4 more mirrors (the deletion receipt's `org_ref`, `region`, `run_id` and `scan_id` against `hosted_context`);
  - a settlement linkage over every commitment in the contracts (6);
  - the hello size bound;
  - the SARIF not-applicable set;
  - the evidence `unresolved_clauses` rule;
  - receipt timestamps;
  - the receipt vector, verified with the other signing vectors;
  - `deletion_receipt` added to the R1 wording lint.
- **`fixtures/diplomacy_press_cases.json`:** two more cases, marked `since: 2.5.0`, with new context fields
  `horizon_year` and `ended_commitments`:
  - `clause_beyond_horizon` (horizon 1906; the in-horizon offer after it is delivered);
  - `renounce_ended_commitment`.
- **`tools/signing-vectors.mjs`** writes `receipt_vectors`.
- `README.md`, `versioning.md` (the 2.5.0 worked example), `RESERVED.md`, and `openapi.yaml`/`asyncapi.yaml`
  `info.version` 2.5.0 are updated.

### Migration notes (implementation follow-ups; sequenced after this merge)

- **arena-cli:**
  - **Regenerate `src/generated/contracts.ts`.** `codegen.mjs --check` reports drift now, because the
    `hosted_context` descriptions changed. That is expected and sequenced.
  - Write `budget.press.redactions` per Diplomacy episode over a transport, 0 included. `state.pressRedactions` is
    per run today, so it needs a per-episode count. Keep the label through 2.5.x.
  - PR 5: `--manifest`/`--run-spec` files; refuse both forms; read `ARENA_DIP_SECRET_<n>`, renamed from
    `ARENA_EPISODE_SECRETS`.
  - Unrelated to this release but observed: two CLI tests are red because the bundle VFS lacks
    `evidence_report.schema.json` (in-flight evidence work).
- **arena-report:**
  - Add the four Diplomacy codes to `NOT_APPLICABLE_REASONS` (`build.ts`). That drives `kindAndLevel` and the summary
    verdict. The hosted golden test is red until then; its expected-set line is `sarif.test.ts` line 25.
  - `verify`: carry `budget.press.redactions` over as attested, like `decision_ms_*`, or a report carrying it is a
    mismatch.
  - The evidence renderer may now emit JSON with `unresolved_clauses` instead of withholding it.
- **wot-engine (`press.ts`):** refuse a renounce of an ENDED commitment (`commitment_unknown`). It changes accepted
  press, and so transcripts, only where it occurs; the scenario-version decision is arena-engineer's, as F-1 was. No
  change for `clause_beyond_horizon`.
- **arena-scenarios (`wire.ts`):**
  - Send `clause_beyond_horizon`: delete the `terms_invalid` mapping at line 309.
  - Emit `settlements[]` from `cl.settlements`.
  - `S1909M` now validates.
- **arena (`services/arena/src/diplomacy/wire.ts`):**
  - `pressRejectCode` passes `clause_beyond_horizon`.
  - `clauseStatusToWire` uses the last settlement for `settled_phase`/`settled_tick` (today the first broken one), and
    `renounced` only when the latest release was by the renounce (today any).
  - Emit `settlements[]`.
- **arena (lobby):** an unauthenticated frame of 8193 to 16384 bytes is answered by the generic guard with
  `retryable: true`. Make it `false` for a session with no accepted hello, which can only be sending a hello.
- **arena (`test/diplomacy-press-cases.test.ts`):** pass `context.horizon_year` to `closePressRound`, and build
  `ended_commitments` as commitments with every clause settled. `press corpus: clause_beyond_horizon` is red until the
  test and the wire mapping follow. `renounce_ended_commitment` passes today only vacuously: the test does not build
  the ended commitment.
- **qa/crosscheck.ts:**
  - Embed leg A per cell (anchor fields plus `anchor_id`).
  - Write `scope: local` and `pass` for a clean run without H. The test "a pass needs H" then applies to the hosted
    scope only.
- **CLI (replay format, not a contract):** to let the inspector fold the adjudicator chain (B5b), the replay file needs
  a per-adjudication `orders_digest` and board-state hash. This is for the CLI owner.
- **Docs (owners):**
  - threat-model-hosted §3.3 `ARENA_TARGET_AUTH` → `ARENA_TARGET_CREDENTIAL` (security-architect);
  - EVIDENCE-REPORT-TEMPLATE R4;
  - HOSTED-PROFILE §2.3 (files, not env);
  - SIXI-INTEGRATION §1.6 (`ARENA_DIP_SECRET_<n>`).

## [2.4.0] — 2026-09-26

**Phase 8 transport and key wiring.** **MINOR** (additive, plus one pre-release erratum on an outbound field;
`versioning.md` §2 has the worked example). Sources: the Phase 8 B3a open items 1 to 4 (`docs/phase-7/PLAN.md`
progress log), the B3c passport-key wiring (`services/passports/src/app.ts`), the committed arena table session
(`services/arena/src/diplomacy/`), `wot-auth` `press-signing.ts`, and the Diplomacy docs review (fill, reason
codes). No ADR is needed. The frame protocol stays `1.0`; every existing schema `$id` keeps `:1`; the duel
`hello` and `ack` schemas are unchanged. **No oracle id or SARIF rule id changes.**

### Added: passport signing key (`openapi.yaml`)

- **`PassportSigningKey`** (new component): the passport's Ed25519 key as a private JWK
  `{kty: OKP, crv: Ed25519, x, d, kid, alg: EdDSA, use: sig}`. `x`, `d` and `kid` are 43 base64url characters;
  `kid` is the RFC 7638 thumbprint of the public key. Shown exactly once, never stored, never logged.
- **`signing_key`** (optional) on **`RegisterAgentResponse`** (`POST /v1/agents` 201) and
  **`RotateSecretResponse`** (`POST /v1/agents/{client_id}/rotate` 200). Optional so a 2.3.0-shaped response
  stays valid; the passports service always sends it. Rotation revokes the previous key.
- Both responses document the `Cache-Control: no-store` header.
- Examples: `d` is an `EXAMPLE` placeholder; `x` and `kid` are the RFC 8032 TEST 1 and TEST 2 public keys and
  their real thumbprints. A second registration example shows the response without `signing_key`.
- `RegisterAgentResponse.scopes` now documents the default set as issued: `play:duel`, `spectate:read`,
  `play:raid`, `negotiate:a2a`. A Diplomacy table seat needs `negotiate:a2a`.
- Negotiation Chambers: the `signature` descriptions now name the real scheme (`signing.md` §8), replacing
  "detached signature over the canonical offer bytes".

### Added: the Diplomacy table session (B3a item 1)

- **`asyncapi.yaml` channel `diplomacy_table`** (`/v1/arena`, same servers as the duel). An agent with a
  passport dials in and plays the seat it was given at a server-created table. It defines:
  - seat binding (the agent never names its power);
  - scope `negotiate:a2a`;
  - one live session per seat, with supersession re-sending the open step with the same nonce;
  - the action echo checks and their reject codes, in order: `not_your_seat`, `bad_echo` (episode),
    `stale_turn`, `bad_echo` (nonce);
  - the `wot:ack:1` action ack with zero tokens, and latest-frame-wins within a step;
  - `press_rejects` delivered in the next observation, in the refused message's batch position;
  - close codes 4401, 4403, 4409, 4410, 1000 and 1012.

  Five operations: send hello, receive observation, send action, receive end, receive session event.
- **`schemas/diplomacy_hello.schema.json`** (`wot:hello:diplomacy:1`, inbound, 2048 bytes). It has `t: hello`,
  `protocol_version`, `token`, `scenario_id: diplomacy_standard` and `table_id` (`dtb_…`). There is no power, no
  `mode`, no `dpop`, no seed and no episode id.
- **`schemas/diplomacy_session_ack.schema.json`** (`wot:ack:diplomacy:1`, outbound). It has `t: ack`,
  `ack_type: session`, `mode: diplomacy`, `session_id`, `table_id`, `episode_id`, the assigned `power`,
  `signature_modes` (subset of `key`, `session`) and `config` (Ds, Dh, press rounds, eval class).
- **`diplomacy_action`**: the top-level description gives the table-session check order. The four `signature`
  descriptions now state the scheme, the single-use binding and where `session` is honoured.
- **`diplomacy_observation`**: `nonce` is documented as re-sent unchanged on a mid-step re-bind.
- **`errors.md`**:
  - §3e: the table-session reject order;
  - §3e and §1a: the `signature_invalid` meanings;
  - §4: the close codes per seat.
- **Not in scope: a REST route to create or list tables.** Tables are created server-side only (operator
  tooling). A seated agent learns its `table_id` out of band. `RESERVED.md` reserves "Diplomacy table
  management (REST)"; adding the route later is additive.

### Added: press signatures (`signing.md` §7, §8; B3a item 2)

- **§7 Press signatures:**
  - The JWS form: a detached compact JWS, RFC 7515 Appendix F, EdDSA over Ed25519, made with the passport key.
  - The header allow-list: `alg` = `EdDSA` (required); `kid`, which must equal the passport key's; `typ`, not
    interpreted. Any other member refuses the signature (`crit`, `b64`, `jwk`, `jku`, `x5u`, …).
  - Canonical base64url only, one encoding per signature (security review G-34).
  - The eight-member payload `{scenario: "diplomacy", episode_id, msg_id_expected, from, to, move, respond_to,
    terms_hash}` signed as **JCS bytes**: key-sorted, so the listed order is not the byte order. `null` members
    are present, not omitted. `msg_id_expected` uses the **full power name** and the 1-based batch position.
    `terms_hash` is sha256 of JCS(terms) as sent.
  - What the signature does not cover: `body`, `asks`, `reply_to`, `expires_after_round`.
  - `sig_mode: key | session`. `session` is honoured only on the local CLI runner and on development or test
    table sessions; production tables and hosted runs honour `key` only. A failure is refused
    `signature_invalid` in place, and the cause is never disclosed.
  - Single use by construction.
  - Rotation and revocation of the key.
- **§8 Negotiation Chamber signatures:**
  - the chamber payload `{scenario: "negotiation_chamber", negotiation_id, action, from_agent_id, respond_to,
    terms_hash, expires_at}`;
  - **single use per chamber**, compared on the decoded signature bytes;
  - no `session` mode.
- **`fixtures/press_signing_vectors.json`** (new) holds 15 vectors built with the RFC 8032 TEST 1 key over the
  `diplomacy_action` examples:
  - 4 accepted;
  - 11 must-reject, including:
    - **forged header members** (`jwk`; `crit` with `b64`);
    - **wrong field order** (the listed order instead of JCS);
    - the scenario id in place of `"diplomacy"`;
    - an abbreviated power (`GER`);
    - a moved batch position;
    - another episode;
    - omitted nulls;
    - a wrong `alg`;
    - a `kid` mismatch;
    - a non-canonical encoding.

  `tools/signing-vectors.mjs` regenerates the file, and `fixtures/signing_vectors.json` is unchanged byte for
  byte. Every vector except the G-34 one reproduces through `wot-auth` `verifyPressSignature` today; the G-34
  vector is accepted there until that finding is fixed.
- The `sig_mode` `$def` description (identical in every `diplomacy_*` schema) now states the `session`
  restriction and the commitment rule: `key` only if offer and accept were both `key`.

### Added: RunSpec `diplomacy.fill` (Diplomacy docs review)

- **`run_spec.diplomacy.fill`** (optional; mirrored in `report.$defs.run_spec`) takes one of `house`, `robust`,
  `credulous`, `injector-table`, or `table:<pair>` over the six engine golden tables. It uses the adapter's and
  the CLI's names. When present it decides the roster, and `profile` is derived from it:

  | `fill` | `profile` |
  |---|---|
  | `house` | `clean`, or `table` for the house seats of a multi-target table |
  | `robust`, `credulous`, `table:commitment_broken` | `clean` |
  | `injector-table` and the other five golden tables | `security` |

  A `profile` given alongside `fill` must match; schema conditionals enforce this. A `table:<pair>` fill pins
  england and france, so neither the primary seat nor a `seats[]` entry may play them. With position `auto`,
  the runner refuses a clashing seed. Without `fill`: `security` means `injector-table`, and `clean` means
  `house`. With neither `fill` nor `profile`, the default is `security`.
- **Deviation from the review note:** `profile: table` is the 2.2.0 multi-target table (`seats[]` with
  `driver: target`). It is not the adapter's `table:<pair>` fill, which is a single-target golden fixture
  table. `profile: table` therefore takes fill `house` or none.
- **Injector seating** replaces the design's hashed-neighbour rule (diplomacy-scenario.md §4.5), as the adapter
  implements it:
  - the injector sits at the first of england, france, russia, austria, italy, turkey, germany that is not
    the target;
  - the house schemer sits at the first of france, england, austria, russia, italy, turkey, germany that is
    neither the target nor the injector;
  - the other four seats are house diplomats with seeded personas, never a second schemer.
- **Examples:** `run_spec` `examples[6]` (fill only) and `examples[7]` (`table:combined` at germany, horizon
  1904). The existing examples, including the signed hosted example, are unchanged.

### Added: SARIF (`sarif-mapping.md` §2.1)

- Three Diplomacy `not_assessed` reason codes the engine and adapter emit:

  | Reason code | Oracle | SARIF kind | Meaning |
  |---|---|---|---|
  | `shared_owner` | collusion | `notApplicable` | independently owned pairs exist, but none includes this seat |
  | `sample_out_of_table` | collusion | `open` | the opportunity count is outside the frozen threshold table |
  | `episode_invalid` | all | `open` | a reference seat failed an oracle (engine `dipEpisodeValidity`); every target verdict of the episode carries it |

  `reason_code` is a pattern, so no schema changes.
- The sentence "`intent_leak` is never `not_assessed`" is corrected: it is not assessed only with
  `episode_aborted` or `episode_invalid`.

### Changed: erratum on `diplomacy_observation.offers` (B3a item 3)

- **Contract, 2.1.0 to 2.3.0:** live offers plus those that reached a terminal status at the last round close.
- **Both implementations** (the arena table session and the arena-scenarios egress) emit live offers only, and
  so does the design ("own live offers", diplomacy-scenario.md §1.3).
- **2.4.0: the contract follows the implementation.** `offers` lists live offers only, and each item is
  pinned to `status: pending`. **No implementation changes.**
- **Closed offers are not needed:** every terminal status is already visible in the same observation.
  - `accepted`: the bound commitment `cmt:<offer_id>`, seen by both parties.
  - `countered`: a live counter whose `counters` names the offer.
  - `withdrawn`: the withdraw message in the recipient's `inbox` and the proposer's `sent`.
  - `expired`: after the announced `expires_after_round`.
- `diplomacy_observation` `examples[1]` drops its accepted offer.

### Changed: renounce `sig_mode` and ended commitments (B3a item 4)

- **`renounced.sig_mode` is the renounce message's own attested mode,** recorded when the engine accepted it.
  It is never inherited from the commitment. Documented on `diplomacy_renounce.sig_mode` and its two embedded
  copies, and in signing.md §7.4. The fallback semantics are resolved as "no fallback".
- **`commitments` visibility, made precise.** Both implementations disagreed with each other and with the old
  text ("ended at the last adjudication"). The contract now reads: every active commitment, plus each one that
  ended at the close of the previous step, whether at an adjudication or at a round close through a renounce.
  An ended commitment appears in **exactly one** observation, like every other round-close delivery. This is
  the arena-scenarios egress behaviour.
- **Implementation impact** is in the migration notes below: arena table visibility, and the two `sig_mode`
  paths.

### B3a open items: resolution

| # | Item | Resolution | Side that changes |
|---|---|---|---|
| 1 | hello and session ack were duel-only | New `wot:hello:diplomacy:1`, `wot:ack:diplomacy:1`, channel `diplomacy_table` | contract only (matches the lobby) |
| 2 | registration key field | `signing_key` on register and rotate (`PassportSigningKey`) | contract only (matches passports) |
| 3 | `offers`: live only, or also those closed at the last round close | live only; `status: pending` pinned | contract (erratum); implementation unchanged |
| 4 | renounce `sig_mode` fallback | own mode, never inherited | implementation: arena-scenarios egress; arena table (dead code) |

### Tooling

- **`tools/contract-check.mjs` §8:**
  - 40 more must-reject cases (265 in total), including:
    - `signing_key` with a `kid` of 42 or 44 characters, or with a non-base64url character;
    - `signing_key` with `d` missing, on both responses;
    - an RSA key, an unknown member, or `use: enc`;
    - a Diplomacy hello that names its power;
    - a duel hello and a Diplomacy hello crossed;
    - a terminal offer in `offers`;
    - fill and profile mismatches;
    - a golden table at england or france.
  - 7 positive controls.
  - A lint that every OpenAPI `signing_key.d` contains `EXAMPLE`.
  - The press vectors replayed by an independent verifier written from signing.md §7. It checks that each
    vector is authentic, that every reject reason is covered, and that the listed-order vector really is
    non-JCS.
- **`tools/signing-vectors.mjs`** also writes `fixtures/press_signing_vectors.json`.
- `README.md`, `versioning.md` (§3 frames; the 2.4.0 worked example) and `RESERVED.md` are updated.

### Migration notes

- **CLI (arena-cli):**
  - Regenerate `src/generated/contracts.ts` after this merge. `RunSpecContract` gains `diplomacy.fill`. Any
    generated file older than this release fails the drift test; that is expected and sequenced. As of this
    writing the committed file (C2g, `4312e3e`) was already generated from this release's `run_spec`, and
    `codegen.mjs --check` passes. Re-run it anyway after the merge.
  - `wot-contracts` `src/generated/frames.ts` has been stale since 2.2.0 (the deprecated `hello.dpop`
    description); 2.4.0 does not touch the duel `hello`. Its `codegen.mjs` has no `--check` mode and rewrites
    the file.
  - Write `diplomacy.fill`, and drop the `arena.diplomacy_fill` label, or keep it as a duplicate.
  - Keep writing the derived `profile`.
  - Resolve a RunSpec without `fill`: `security` → `injector-table`, `clean` → `house`, `table` → `house`,
    absent → `injector-table`. The adapter default `house` must not be used for a RunSpec that omits both.
- **arena-scenarios (egress):** `wire.ts` sets `renounced.sig_mode` from the commitment (lines 253-254). It must
  carry the renounce message's own mode, which the engine records per delivered message. The value is the same
  under today's policies (local runs are all `session`, hosted runs all `key`), so no golden moves.
- **arena (table session):**
  1. `commitmentVisible()` must show an ended commitment once, in the observation after the close at which it
     ended. Today it shows it until the next adjudication, and never before the first one.
  2. The renounce `sig_mode` lookup's `?? c.sig_mode` fallback is unreachable; replace it with the recorded
     mode.
  3. Enforce the 2048-byte cap on the Diplomacy hello.
  4. Stop accepting `dpop` in it.
- **wot-auth:** replay `fixtures/press_signing_vectors.json` in a test. The `reject-noncanonical-signature`
  vector stays red until G-34 is closed; the lenient `unb64u` is the `todo` test in `security-review.test.ts`.
- **Security (for security-architect):** the arena resolves a seat's public key once, at hello. A key rotated
  during a live table therefore keeps verifying until the seat re-binds, while signing.md §7.5 requires that
  the previous key stop verifying at rotation.
- **arena-report (emitter):** map `shared_owner` to `notApplicable`. `sample_out_of_table` and
  `episode_invalid` take the default `open`.
- **Passports:** nothing to do; the service already returns `signing_key` with `Cache-Control: no-store`.

## [2.3.0] — 2026-09-26

**Gap closure after Phase 7 C2c and Phase 8 B4/B5.** **MINOR** (additive, plus two documentation errata that change
no rule id, level or fingerprint). Sources: the contract gaps the reports workstream filed at C2c and the contract
mismatches of Phase 8 B4+B5 (`docs/phase-7/PLAN.md` progress log). No ADR is needed (`versioning.md` §2). The
frame protocol stays `1.0` and every schema `$id` keeps `:1`. **No oracle id or SARIF rule id changes.**

### Added

- **`report.engine.build_scope`** (optional; `core | diplomacy | all`). It names the file set `engine.build_hash`
  covers, matching `engineBuildDigest({scope})` in arena-report:
  - `core` = the engine source roots without any `src/diplomacy/**`, recorded by every non-Diplomacy scenario;
  - `diplomacy` = core plus `src/diplomacy/**` without `datc/` and `testing/`, recorded by `diplomacy_standard`
    and pack scenarios over it;
  - `all` = every file (release pins; a Report may record it).

  When the member is absent (Reports before 2.3.0), readers assume the scenario's scope. The `build_hash`
  description now gives the scoped digest formula.
- **`report.engine.source_manifest_digest`** (optional). `"sha256:" + hex(sha256(JCS(M)))` over the embedded
  `agent-arena/engine-sources@1` manifest (scope `all`). It names the manifest the build hash was derived from. The
  manifest itself is never embedded, and `engine` still rejects any other member.
- **`episode_result.diplomacy.engine_evaluation_hash`** (optional). This is the engine's own hash over the full
  verdict objects (`dipEvaluate`, domain `diplomacy-evaluation:`, engine canonical form). The contract
  `evaluation_hash` (the 5-tuple vector) is unchanged. Both descriptions now state the difference:
  - `evaluation_hash` is comparable across builds;
  - `engine_evaluation_hash` also commits to the evidence but is comparable only within one `engine.build_hash`.

  A mismatch is a `harness.replay_integrity` fail with code `evaluation_hash_mismatch`. A future MAJOR may unify
  the two.
- **EpisodeResult seat provenance per mode** (conditional on `seats[]`, the 2.2.0 member):
  - **squad:** exactly m0..m4, every one `driver: target`, `inputs_source: recorded`. All five members are the
    target.
  - **duel, member, squad:** no `recorded_peer` and no `llm_peer`.
  - **Seat names follow the mode:** A/B, m0..m4, or the seven powers.

  **Tightening, called out.** These rules reject only EpisodeResults that already contradicted their own RunSpec.
  The 2.2.0 RunSpec forbids `seats[]` outside Diplomacy, so a raid `recorded_peer` could never be RunSpec-consistent,
  and no conforming writer emits one. `verify` used to report such a forged seat as `mismatch`. It now reports it
  as `unverifiable`, because the Report is schema-invalid. The arena-report test `verify: member seating ...
  relabelled engine seat is a mismatch` forges exactly this case, so it needs one of two changes:
  - relabel m0 as `driver: target`, which stays schema-valid and is still a RunSpec mismatch;
  - or expect `unverifiable`.
- **Examples:**
  - `report` `examples[0]` records `build_scope: core` and a `source_manifest_digest`. `examples[1]` and `[2]` are
    unchanged: arena-report rebuilds them byte-for-byte, and `[2]` is signed.
  - `episode_result` `examples[3]` carries `engine_evaluation_hash`.
  - New `episode_result` `examples[5]` is a squad Byzantine episode with `seats[]`.
- **`tools/contract-check.mjs`:** 17 more must-reject cases (225 in total), including:
  - a Diplomacy `evaluation_hash` as bare hex, in upper case, or as an object;
  - `engine_evaluation_hash` malformed or misplaced;
  - a squad member marked `recorded_peer` or `llm_peer`, or regenerated by the engine;
  - a four-member squad;
  - an unknown build scope, a bare-hex manifest digest, or an embedded manifest.

  New checks:
  - **Seat-linkage rule, generalised:** the primary is every member in squad mode. The old rule read `squad` as a
    seat name and flagged every squad member. Every mode lists each seat once, and `seats[]` entries must appear.
    Self-tests cover both a squad and a peer table.
  - **`build_scope` linkage:** a Report records its scenario's scope or `all`.
  - **Hosted SARIF golden:** the §2 and §4 members and their order are checked against the Report.
  - **Diplomacy consistency:** 103 steps at horizon 1908 with 3 press rounds fit the evidence tick cap of 120. The
    evidence phase pattern accepts exactly 1901 to 1908, and the EpisodeResult horizon and terminal year maxima
    equal the RunSpec's 1908.
  - **`shared.budget_violation`** declares `[error, warning]`.

### Changed: SARIF (`sarif-mapping.md`, `fixtures/hosted_report.sarif`)

- **§2 and §4 are authoritative for the Diplomacy members; the golden was wrong.** Since 2.1.0, §2 and §4 require:
  - descriptor `risk`, `review_required`, the `review-required` tag and `medium` precision for a review-required
    rule;
  - result `transcript_hash`, `evidence_ids` and `review_required`.

  The 2.2.0 golden omitted them, and the emitter followed the golden, so collusion was rendered at `very-high`
  precision. 2.3.0 re-renders `fixtures/hosted_report.sarif` with them. §2 and §4 now fix their member order, and
  §4 bounds `evidence_ids` to engine id syntax. §7.1 is re-cut verbatim from the golden. §8 states the authority
  rule: the golden decides byte layout, §2 to §4 decide which members exist.
- **§1 erratum:** the commit is `runs[0].properties.agentArena.revision_id`. `versionControlProvenance` needs a
  `repositoryUri` the Report must not emit, and no emitter wrote it. The row for
  `tool.driver.properties.agentArena` (`conflict_of_interest`, `determinism`) is added. Both rows match what the
  emitter already renders.
- **§2.1 budget row:** Diplomacy `shared.budget_violation` is `error` only for a forfeit, and `warning` for an
  orders-deadline hard miss or more than 2 counted press rejects (the Phase 8 B4 engine). It is never `note`. The
  design note "per Phase 7 (low)" is superseded.

### Checked, unchanged

- **Evidence limits:** `oracle_evidence.tick` ≤ 120 and phases 1901 to 1908 are consistent with
  `run_spec.diplomacy.horizon_year` ≤ 1908 (2.1.0). They are now asserted by the check.
- **Power ids** stay full names in every contract document. The engine's three-letter ids are converted at the
  adapter (`contractId()`) and never appear in a frame or a Report.

### Migration notes

- **arena-report (emitter):** render sarif-mapping §2 and §4 as specified. The fixture test
  `hosted-report.json renders byte-for-byte to contracts/fixtures/hosted_report.sarif` is red until it does. The
  work in `rule()`:
  - `agentArena.risk` and `agentArena.review_required`;
  - the `review-required` tag;
  - `precision: medium` when review is required.

  The work in `result()`:
  - `transcript_hash` after `replay_hash`;
  - `evidence_ids` after `evidence_ticks`, filtered by the §4 pattern;
  - `review_required` last;
  - the review sentence at the end of a review-required fail's message.

  The core goldens (`golden-report.sarif`, `example0.sarif`) are unaffected. `buildReport` may write `engine.build_scope` from its existing `engineBuildScope` input and
  `source_manifest_digest` from the manifest. When it does, update `examples[1]` and `[2]` in the same change
  (re-sign `[2]` with `tools/signing-vectors.mjs`).
- **arena-scenarios (Diplomacy adapter):** copy `DiplomacyEpisodeRecord.engineEvaluationHash` to
  `diplomacy.engine_evaluation_hash`.
- **arena-report (verify test):** update `test/provenance.test.ts` line 240 as described under "Added"; nothing
  else in `verify` changes.
- **CLI:** regenerate `src/generated/contracts.ts`. `verify` uses `engine.build_scope` when present, and otherwise
  `engineBuildScopeFor(scenario_id)`.
- **Default horizon, open follow-up:** the engine `DEFAULT_HORIZON_YEAR` is 1908, but the contract RunSpec
  default is 1906. The runner must pass the RunSpec value. This is not a contract change.

## [2.2.0] — 2026-09-26

**Phase-9 Stage A3: the hosted-run contract.** **MINOR** (additive; `versioning.md` §2 has the worked
example). Source: `docs/phase-9/HOSTED-PROFILE.md` §0.1, contract changes K1 to K9, with
`docs/security/threat-model-hosted.md` §2.1, §2.5 and §5, and `threat-model-arena.md` §3. Record of the
one semantic addition: **ADR-004** (`docs/adr/ADR-004-verify-semantics-for-recorded-seats.md`, what
`verify` establishes for recorded and LLM-peer seats). The frame protocol stays `1.0`, every existing
schema `$id` keeps `:1`, and **no oracle id or SARIF rule id changes**.

### Added: schemas (JSON Schema 2020-12, `additionalProperties: false`, every string bounded, a size cap each)

- **`hosted_context.schema.json`** (`wot:hosted_context:1`, 8192 bytes, K9). The hosted context is also
  the run manifest. It is signed by the control plane (`signing`), and `run_spec_digest` binds it to
  the RunSpec. It carries the verified origin, an egress allowlist (exactly one target plus peer
  gateways only with peers), `net_policy: hosted-v1`, `credential_mode` (never a value), the image
  digest and engine build, packs, LLM peers, Diplomacy secret commitments (a digest, never the
  secrets), retention, rate cap and deadline.
- **`pack_manifest.schema.json`** (`wot:pack_manifest:1`, 256 KiB, K9):
  - Header: id `sx-…`, SemVer, kinds `clause_map | scenario_variant | adversarial_peer`, pinned engine
    builds plus version and contracts ranges, corpus snapshot, `regimes` (closed set `OWASP`, `AIACT`).
  - `scenarios[]`: `sx_` variants over an open `base` with pinned data, or overlays with LLM `peers`
    (`driver: recorded_peer`, `inputs_source: llm_peer`).
  - `oracles[]`: open oracle id → corpus clause ids (`OWASP:AgenticTop10:ASI01`, `AIACT:2024/1689:Art15(4)`)
    and ATLAS `techniques[]` (lens labels, never clauses).
  - `rules[]`: CEL condition, the oracle ids it reads, both fixtures.
  - Reproducibility `reproduced_n_of_m` over assessed episodes, and `coverage.clauses`.
- **`crosscheck_record.schema.json`** (`wot:crosscheck_record:1`, 4 MiB). The signed result of
  `arena-crosscheck` per image digest (HOSTED-PROFILE §2.8):
  - legs H, O1, O2, O3, A;
  - cells (at least 1) with the compared fields per leg and a verdict `match | environmental |
    divergent | missing`;
  - leg V (verify exit codes, signatures);
  - job verdict `pass | inconclusive | fail`.

  A `pass` requires every cell `match`, and a `divergent` cell forces `fail`.
- **`evidence_report.schema.json`** (`wot:evidence_report:1`, 8 MiB, K8). The machine-readable evidence
  document (EVIDENCE-REPORT-TEMPLATE Part 1 and Appendix A):
  - the fixed status line;
  - behaviour states `broke | held | not_assessed`;
  - findings with "reproduced N of M" and distinct trajectories;
  - gap-only clause records;
  - a mandatory not-assessed section that copies every signed Report entry and requires all six
    standing exclusions;
  - limitation codes;
  - signature file digests.
- **`bundle_manifest.schema.json`** (`wot:bundle_manifest:1`). The file list, with sha256 and size, of a
  sealed bundle. It is DSSE-signed over its exact bytes.

### Added: to existing documents (all optional, or conditional on a new member)

- **`report`:**
  - **K1:** `run.hosted` holds `signing_key_id`, `region`, `image_digest` {index, platform manifest,
    platform}, `verified_origin` {origin, method, verified_at, checked_at, record_id}, `org_ref`,
    `scan_id`, `credential_mode`, `seed_source`, `packs[]` {id, version, digest}, `retention`,
    `run_manifest` {digest, signing_key_id, path}, `observed_connections[]` (addresses and leaf SPKI
    digest, the threat-model §5.2 attribution binding) and `sealed_by`.
  - **K2:** `run.target_ownership.source` gains **`sixi_verified`**. `run.hosted` implies mode `hosted`
    and `{loopback: false, attested: true, source: sixi_verified}`, and `sixi_verified` implies
    `run.hosted`.
  - **Not assessed:** a first-class **`not_assessed[]`** section. Each entry has a kind `scenario |
    oracle | clause | seat | property`, an id, a stable `reason_code` (10 codes) and a basis `resim`
    (recomputed by `verify`) or `recorded` (bound by the signature). It is required on every hosted
    report.
  - **Signing:** the **`signing`** seal holds `ed25519`, `signing_key_id`, `canonicalization:
    jcs-rfc8785`, `payload_type`, `excluded: ["/signing/signature"]` (a `const`, so a signature can
    never be inside its own signed payload), `run_manifest_digest`, `sealed_at` and `signature`.
    `signing` requires `run.hosted` and `not_assessed`.
  - **Pack scenarios:** `scenario.base_scenario_id`, required if and only if the scenario is an `sx_`
    pack scenario.
  - **K4:** every Diplomacy-family episode of a hosted report must disclose its secret and commitment.
  - **Examples:** `examples[2]` is the golden sealed hosted Diplomacy run with a recorded LLM peer.
- **`episode_result`:**
  - **K4:** `diplomacy.episode_secret` (hex64, disclosed after the run) and
    `diplomacy.episode_secret_commitment` (both or neither).
  - **K7:** **`seats[]` provenance**, per seat `driver: engine | target | recorded_peer` and
    `inputs_source: seed_regenerated | recorded | llm_peer`. `recorded_inputs` {decisions, digest over
    the JCS action array, record_pointer} is required for `recorded` and `llm_peer`, and `peer`
    {pack, agent, provider, model_reported (unverified), inference_region, prompt_digest,
    gateway_log_digest} is required for `llm_peer`.
  - Roster `seat_kind: recorded_peer`, and `diplomacy.profile: table`.
- **`run_spec`:**
  - **K7:** optional **`seats[]`** (power mode, named primary position). Each entry is either
    `driver: target` with a full target descriptor and an `owner` for collusion (requires the
    **`table`** profile, and `table` requires one), or `driver: recorded_peer` with `peer {pack, agent}`.
  - **K6:** the `target.auth.ref` description gains the hosted rule.
  - **Pack scenarios:** the `scenario_id` description reserves `sx_`.
- **`sarif-mapping.md`:**
  - **§1.1 (K3):** `runs[0].properties.agentArena` gains `hosted: true`, `signing_key_id`, `region` and
    `packs`, all copied from `run.hosted`. It also gains the pointer `not_assessed_section {entries,
    pointer: "/not_assessed"}` and `recorded_seats`. Clause ids and `security-severity` never appear.
  - **§2.2:** pack scenarios keep the base scenario's rule ids, and only `automationDetails.id` uses
    the `sx_` id.
  - The hosted golden is `fixtures/hosted_report.sarif`, which validates against the OASIS schema.
- **`signing.md`** (new): the canonical form, the signed message `PAE(payload_type, JCS(D without
  /signing/signature))`, derived DSSE envelopes, kid equality, the run-manifest digest, the Diplomacy
  secret commitment formula, and the contract tests.
- **`errors.md`:**
  - **§1c:** `scenario_pack_unavailable` (K5, 422, exit 3). The `run_spec_invalid` meaning now includes
    the hosted auth-ref rule (K6).
  - **§1d:** new hosted-profile codes with exit codes and hints: the HOSTED-PROFILE Appendix A codes,
    `hosted_context_invalid`, `seal_failed` and `signature_invalid`.
- **`openapi.yaml`:**
  - `POST /v1/runs` now says the hosted runner accepts only `env:ARENA_TARGET_CREDENTIAL` and offers no
    per-organisation `secret:` store (K6, amending the 2.0.0 text that conflicted with decision S4).
  - Examples updated: `authRef`, `packScenario`.
- **`asyncapi.yaml`:** the `eval_target` server notes per-seat endpoints (K7).
- **`RESERVED.md`:**
  - the `sx_` namespace is reserved (K5);
  - the hosted-runner row is narrowed;
  - the mixed-ownership row points at `seats[]`;
  - the DPoP row is withdrawn.
- **`tools/contract-check.mjs`:**
  - 15 more mirrors and 81 more negative cases (208 in total), including:
    - a signed report whose signature is inside the signed payload;
    - an `llm_peer` seat without recorded inputs;
    - a pack citing an unknown regime;
    - a cross-check record with no cells.
  - Signing-vector verification (`fixtures/signing_vectors.json`, RFC 8032 test key; regenerate with
    `tools/signing-vectors.mjs`).
  - Example linkage: manifest digest, RunSpec digest, secret commitments, kid equality, `run.hosted` =
    manifest, seat provenance = RunSpec.
  - The hosted SARIF golden check.
  - The evidence-report wording rule R1 over every string of the run and hosted schemas.

### Deprecated (security review G-10)

- **`hello.dpop`, `raid_hello.dpop`, `RegisterAgentRequest.device_binding`:** a never-enforced optional
  field (G-10). No DPoP or device-binding check exists anywhere, so the contracts no longer present one:
  - each field is now `deprecated: true` and documented as ignored and not a security control;
  - the `cnf.jkt` wording, the registration example that enabled it, and the reserved "DPoP
    enforcement" row are removed.

  The fields themselves stay accepted until the next MAJOR, because deleting an inbound field rejects
  frames that are valid today (`versioning.md` §2). The removal is prepared for `3.0.0` with an ADR.

### Design reconciliations (where HOSTED-PROFILE and the threat models disagreed)

| Topic | HOSTED-PROFILE | Threat model / brief | Contract (2.2.0) |
|---|---|---|---|
| Report signature payload | DSSE over the exact file bytes (§3.1) | Ed25519 over RFC 8785 canonical bytes plus the manifest digest (§5.2) | JCS of the report without `/signing/signature`, inside DSSE PAE. The manifest digest is a signed member. The report's DSSE envelope is derived (payload = those JCS bytes, same signature). `report.sarif` and `bundle-manifest.json` keep exact-bytes envelopes |
| Run manifest | `ARENA_HOSTED_CONTEXT`, unsigned, "not secret" (§2.3) | a separate control-plane-signed manifest (§2.1) | one document: the hosted context is the manifest, signed in place. Its digest is the run identity |
| Diplomacy secret commitments | — | per-episode `sha256(secret)` in the manifest | a digest over the ordered commitment list (the 8 KiB cap cannot hold 1000 hashes). The per-episode commitments travel in the EpisodeResults |
| K7 seat vocabulary | `seats[].driver: target \| recorded_peer`, "already reserved" (it was not) | `seat_kind: "sixi-llm"`; brief: `inputs_source` | both: RunSpec `driver` (who plays) plus EpisodeResult `inputs_source` (how `verify` obtains the moves) |
| Hosted credential refs (K6) | only `env:ARENA_TARGET_CREDENTIAL` | table seats need one credential each | plus `env:ARENA_SEAT_CREDENTIAL_<POWER>` for `seats[]` targets |
| Pack manifest keys | `pack:`, `lenses: {atlas: …}` | brief: `id`, `techniques[]` | `id` and `techniques[]` |
| SARIF location of `signing_key_id` | `runs[0].properties.agentArena` (K3) | brief: `tool.driver.properties.agentArena` | `runs[0].properties.agentArena` only (K3 and gate 1) |
| `sx_` variants and rule ids | "rule ids do not change" | rule id = `<scenario_id>.<oracle>` | variants keep the base oracle ids (§2.2) |

### Migration notes

- **Existing consumers:** nothing to do. Every 2.1.0 RunSpec, EpisodeResult and Report still validates,
  and local reports render byte-identical SARIF.
- **Stage B implementers** (no TypeScript changed by this release):
  - **B1:** `run --hosted` validates the hosted context and its signature, refuses on a digest or
    origin mismatch (`hosted_context_invalid`), and copies `run.hosted`. It writes `not_assessed` and
    discloses `episode_secret`. The seal step adds `run.hosted.sealed_by` and `signing` (signing.md
    §3). `verify --hosted` checks kid equality, the manifest digest and the secret commitments.
  - **arena-report:**
    - `sarif.ts` renders §1.1.
    - `verify.ts` implements ADR-004: recorded seats come from `run.spec.seats[]`, and `llm_peer` seats
      are reported as recorded, not regenerated.
    - `not_assessed` `resim` entries are recomputed, and `recorded` entries are listed as unverified.
    - `buildReport` accepts `hosted`.
  - **CLI (K5):** refuse `sx_` ids before any I/O with `scenario_pack_unavailable`.
  - **G-10:** the passports service and `wot-auth` stop minting or reading `cnf.jkt` and ignore
    `device_binding`. The Python SDK and `wot-contracts` regenerate their types.
  - **Codegen:** the new outbound documents `hosted_context`, `pack_manifest`, `crosscheck_record`,
    `evidence_report` and `bundle_manifest`.

## [2.1.0] — 2026-09-26

**Phase-8 Stage A3 — the Diplomacy scenario contract.** **MINOR** (additive; no ADR required,
`versioning.md` §2 has the worked example). Sources: `docs/design/diplomacy-scenario.md` (A2: press,
commitments, intent, the six oracles) and `docs/design/diplomacy-adjudicator.md` (A1: order grammar,
`observe(power)`, steps). The frame protocol stays `1.0`; every existing schema `$id` keeps `:1`.

### Added — schemas (`schemas/`, all JSON Schema 2020-12, `additionalProperties: false`, every string bounded)

- **Frames** on the `eval_target` channel: `diplomacy_observation.schema.json`
  (`wot:observation:diplomacy:1`; whitelist view: public board, own intent echo and brief, own offers
  and commitments, the press delivered at the previous round close, own press rejects and order
  feedback, quotas, limits), `diplomacy_action.schema.json` (`wot:action:diplomacy:1`, inbound, 16384-byte
  cap; `power` echo; `orders` in the text grammar or the JSON order form, private `intent`, a `press`
  batch of up to 12 moves), `diplomacy_episode_end.schema.json` (`wot:diplomacy_episode_end:1`; outcome
  `solo | survived | eliminated | loss | forfeit`, terminal `solo | horizon | last_standing`, centre and
  unit counts, civil disorder, `replay_hash` + `transcript_hash`; `evaluation_hash` never on the target
  channel).
- **Records:** `diplomacy_press_message` (delivered press: engine-stamped `msg_id`/`from`/`phase`/`round`/
  `seq`/`delivered_tick`; recipients private / group 2..5 / broadcast; body <= 600 after sanitisation),
  `diplomacy_press_reject` (13 codes, one per refused message, fixed check order), `diplomacy_offer`
  (offer/counter lifecycle; clause kinds `order`, `no_enter`, `no_attack`, `no_support_against`),
  `diplomacy_commitment` (clause escrow `escrowed | kept | broken | void | released | renounced`),
  `diplomacy_renounce`, `oracle_evidence` (`wot:oracle_evidence:1`: evidence by id and tick, never text).
- **Schema-level must-rejects** (via the `power` echo and id patterns): self-addressed press, accepting
  or countering one's own offer, withdrawing another power's offer, a renounce that names an offer, a
  commitment whose offer was not sent by its proposer, press delivered outside rounds r1..r3 of a
  movement phase, raw bodies over 2048.

### Added — to existing documents (all optional or conditional on the new scenario)

- **`run_spec`:** scenario id `diplomacy_standard` (data); seat mode **`power`** with position = a power
  or **`auto`**; optional **`diplomacy`** block (`profile: security | clean`, `horizon_year` 1901..1908,
  default 1906); optional **`target.ownership_attested`** (the CLI's `--i-own-this-target`; the runner
  refuses a non-loopback target without it, code `target_ownership_unattested`). The `budget_tier`
  description records the Diplomacy rules: press rounds edge 2 / core 3 / frontier 3, quotas per tier,
  no token cost for orders or press, 16384-byte frame cap, tick cap 120 respected.
- **`episode_result`:** `mode: power`, the seven powers as seats, outcomes `solo | survived | eliminated`;
  optional **`transcript_hash`** and **`evaluation_hash`** (required for `diplomacy_standard`); a
  `diplomacy` block (power, profile, horizon, R, `sig_mode`, terminal, counts, roster with hashed owner
  keys, engagement; reported, never scored); `budget.press` counters; `evidence_ref.items`
  (`oracle_evidence` copies); verdict `review_required`.
- **`report`:** catalog `risk` and `review_required`; `run.target_ownership` echo; `summary.outcomes`
  gains `solo`, `survived`, `eliminated`; `budget_limits.max_inbound_frame_bytes` is `enum [8192, 16384]`,
  still pinned to 8192 for every non-Diplomacy report; `examples[1]` is the golden Diplomacy report.
- **`openapi.yaml`:** `ScenarioDescriptor.kind` `negotiation`, seat mode `power`, `default_seat` powers +
  `auto`, optional `max_inbound_frame_bytes`; `OracleDescriptor.risk` / `review_required`; a
  `diplomacy_standard` row in the catalog example.
- **`asyncapi.yaml`:** the three Diplomacy messages on `eval_target`, and the **round-close delivery
  contract** (nothing visible before its round closes; offer moves applied withdraw, counter, accept,
  offer, renounce; canonical delivery by power order then `seq`; deliveries, own `sent` and
  `press_rejects` in the next step's observation; round rR visible in the orders step).
- **`sarif-mapping.md` §2.1:** rule ids `diplomacy_standard.injection_followed` (critical, error),
  `.intent_leak` (high, error), `.collusion` (high, error, **review required**, precision medium),
  `.manipulation_followed` (medium, warning), `.commitment_broken` (medium, warning); budget stays
  `shared.budget_violation`; the Diplomacy `not_assessed` reason codes with their SARIF kinds; the
  review-required message suffix; `evidence_ids` and `transcript_hash` in result properties; a worked
  excerpt validated against the OASIS SARIF 2.1.0 schema.
- **`errors.md`:** §1c `target_ownership_unattested`; §3e Diplomacy press rejects (with check order)
  and order-feedback codes.
- **`fixtures/diplomacy_press_cases.json`:** 21 must-reject cases with engine context (oversize, press
  outside a round, self-accept, unknown offer and commitment, quota, recipients, text, terms, signature).
- **`tools/contract-check.mjs`:** 6 more mirrors plus a same-name-same-body rule over all Diplomacy
  `$defs`, 82 more negative cases (127 in total), the corpus check, and a lint (example signatures and
  codewords contain `EXAMPLE`; no conformity-claim wording from the checker's word list).

### Fixed

- **`sarif-mapping.md` §5 fingerprint (erratum):** `F = sha256(rule_id | scenario_id | budget_tier | seat |
  seed | H)`, `H = replay_hash` (plus `| transcript_hash` for Diplomacy). 2.0.0 hashed only
  `(replay_hash, oracle_id, seat)` and claimed `replay_hash` commits to the seed; it does not for the duel
  (obstacles are excluded from the state hash) or for Overfit and Deadlock (seed-fixed fixtures), so
  fingerprints could collide across seeds. §5 is normally MAJOR; corrected here because no released tool
  has emitted the 2.0.0 formula. The key stays `agentArena/v1`. The worked-example fingerprints are
  recomputed.

### Design reconciliations (where A2, A1 and the interim engine disagreed)

| Topic | A2 scenario design | A1 adjudicator / interim code | Contract (2.1.0) |
|---|---|---|---|
| Power ids | `AUS … TUR` | `austria … turkey` (types.ts, grammar) | full lower-case names everywhere (same tokens as the order grammar) |
| Order text | `A RUH - BEL` (upper case) | provinces lower case, keywords upper (`A ruh - bel`), parser case-sensitive | the adjudicator grammar; A2 examples rewritten |
| JSON order form | — | interim `rawFromJson` keys `k, type, at{p,coast}, to, via, ofPower, ofType, of` | same shape, but `of_power` / `of_type` (snake_case wire convention); builds require `type` |
| Steps | intent, r1..rR, orders | R press steps then orders; `plan` string on any action | A2's steps; structured `intent {phase, orders, notes}` replaces `plan` |
| Press rounds R | core 3, edge 2 (§8 Q7) | edge 1, core 2, frontier 3 | edge 2, core 3, frontier 3 (A2 owns the dial; Q7 was assigned to A3) |
| Horizon default | W1906A (§8 Q10) | 1908 | `horizon_year` default 1906, max 1908 (keeps 120-tick cap) |
| Message id | `prs:<phase>:r<n>:<FROM>:<seq>` | `<phase>.<round>.<sender>.<seq>` | `prs:<phase>:r<n>:<power>:<seq>` |
| Per-round limit | 6 msgs, body 600 bytes (2048 raw) | 6 msgs x 1000 chars | A2's numbers; schema caps at the frontier maxima (12 msgs, 2048 raw) |
| Frame cap | 16 KiB press batch | — | 16384 for `diplomacy_action` only |
| Hash names | `transcript_hash`, `evaluation_hash` | `press_digest`, `plans_digest` | `transcript_hash` (covers press and intents) + `evaluation_hash` |
| Budget oracle | §9 table: `diplomacy.budget_violation` (low); §2.6: the shared Phase-7 oracle, unchanged | — | `shared.budget_violation` (§2.6 and the Phase-7 contract) |
| Rule-id prefix | `diplomacy.<oracle>` | — | `diplomacy_standard.<oracle>` (rule id = `<scenario_id>.<oracle>`, sarif-mapping §2) |
| Clause span fields | `from`, `to` | — | `from_phase`, `to_phase` (no collision with message `from`/`to`) |
| Renounce effect | clauses `released` | — | distinct clause status `renounced` (reciprocity release stays `released`) |
| Outcome names | `solo, draw, survived, eliminated` | terminal `solo, horizon, last_standing` | per target: `solo, survived, eliminated, loss, forfeit`; game terminal kept as A1's |

### Migration notes

- **Existing consumers:** nothing to do. Every 2.0.0 RunSpec, EpisodeResult and Report still validates;
  ignore unknown enum members and fields per `versioning.md` §2.
- **Stage B implementers** (TS untouched by this release):
  - `wot-engine/src/diplomacy/parse.ts` `rawFromJson`: accept `of_power` / `of_type` (wire) instead of
    `ofPower` / `ofType`; reject a build without `type` at the schema edge.
  - `arena-report/src/sarif.ts` `fingerprint()`: implement the corrected §5 inputs and regenerate the
    SARIF golden; render `review_required`, `risk`, `evidence_ids`, `transcript_hash`.
  - Press layer (B3): the check order and codes of `diplomacy_press_reject`; replay
    `fixtures/diplomacy_press_cases.json`; stamp `from` from the session; never send `evaluation_hash`
    on the target channel.
  - CLI: `--i-own-this-target` writes `target.ownership_attested: true` and the Report's
    `run.target_ownership`; refuse non-loopback targets without it.
  - Codegen: new frames `diplomacy_observation`, `diplomacy_action`, `diplomacy_episode_end`.

## [2.0.0] — 2026-09-26

**Phase-7 Stage A2 — the evaluation-arena contract.** **MAJOR.** Breaking-change record: **ADR-001**
(`docs/adr/ADR-001-eval-arena-pivot.md`, gate decisions D1–D7 approved 2026-09-26). The pre-pivot game prototype
becomes Agent Arena, an open-core agent evaluation arena; this release removes the game surfaces cut by ADR-001 §6,
adds the evaluation-run contract (RunSpec → EpisodeResult → Report → SARIF), and adds the target-facing
egress frames the scenario design requires (`docs/design/arena-scenarios.md`, A3). Titles/licence move
to "Agent Arena" / Apache-2.0 (D5). The CLI is `npx @rbrus/agent-arena`.

**What does NOT change: the frame protocol stays `1.0`, every schema `$id` keeps `:1`, and the REST
prefix stays `/v1/`.** No inbound frame, required field, reject reason, or close code changed meaning,
so the 50-line agent (`hello` / `observation` / `action` / `match_end`) is byte-for-byte unaffected.
`versioning.md` §2 has the worked example explaining why removing optional OUTBOUND fields does not
bump a frame `$id`.

### Removed (ADR-001 §6) — `openapi.yaml`

- **The Great Hunt:** `GET /v1/hunt`, `/v1/hunt/clues`, `POST /v1/hunt/gates/{gate_id}/submissions`,
  `/v1/hunt/standings`, `/v1/hunt/golden-prompt`; scope `hunt:participate`; webhook `hunt.clue`.
- **The Bazaar / market + A2A trade escrow:** `/v1/market/orders{,/{order_id}}`, `/v1/market/trades`,
  `/v1/a2a/sessions{,/{session_id}{,/offers}}`; scope `market:trade`; webhook `market.fill`.
- **Adapters:** `/v1/adapters`, `/v1/agents/{client_id}/adapters{,/{adapter_id}}`.
- **Economy:** `/v1/me/balance`, `/v1/me/ledger`, `/v1/agents/{client_id}/balance`, `/ledger`,
  `/profile`, `/reliability`, `/v1/quests/{catalog,slate,streak}`; `stake` on `QueueRequest` and
  `RaidQueueRequest`; `ranked`/`stake`/`pot`/`rake_bps`/`rating` on `QueueTicket`; `stake` on
  `RaidTicket`; `payout`/`refund`/`ratings`/`verified`/`ranked`/`stake`/per-player
  `coach_interventions`/`no_hands` on `MatchSummary`; `refund`/`payout` on `Replay.final`; `reward` on
  `RaidSummary`. The Token ledger survives only as per-episode budget accounting (`tokens_remaining`,
  EpisodeResult `budget`).
- **Leagues / seasons / the Golden List:** `/v1/leagues`, `/v1/season`, `/v1/seasons/{season_id}`,
  `/v1/leaderboards/{league}`. The `league` FIELD stays on the duel/raid surfaces as the **budget tier**.
- **Guilds and tournaments:** `/v1/guilds*`, `/v1/tournaments*`.
- **Community caster, Coach analytics, the Vault:** `POST /v1/matches/{match_id}/caster/attach`,
  `/v1/matches/{match_id}/analytics`, `/v1/agents/{client_id}/analytics`, `/v1/vault/exhibits{,/{id}}`;
  scope `caster:publish`.
- **World-first races:** `GET /v1/raids/bosses/{boss_id}/records` (+ `BossRecords`, `WorldFirstClear`,
  `FastestClearEntry`, `RaidClearParty`); `BossDescriptor.availability` (season windows) and `sigil_seed`.
- **Components** that only served the above (148: 94 schemas, 12 parameters, 9 responses, 33 examples), including
  `InsufficientBalance` (402) and `Instrument`/`OfferBundle`.
- **Error codes:** `insufficient_balance`, `adapter_required`, `adapter_not_owned`, `self_trade`,
  `order_not_found`, `a2a_session_not_found`, `escrow_failed`, `season_not_found`, `guild_not_found`,
  `tournament_not_found`, `hunt_not_found`, `gate_not_found`, `gate_locked`, `exhibit_not_found`
  (`errors.md` §7).

### Removed — `asyncapi.yaml` + `schemas/`

- The **`caster`** and **`commentary`** channels, their servers and operations, and the schemas
  `caster_hello`, `caster_say`, `caster_ack`, `commentary_subscribe`, `commentary_ack`,
  `caster_commentary`.
- `shot_list.schema.json` (`wot:shot_list:1`, the Director's output; the Director is cut).
- From the `match_end` emission contract: optional `refund`, `payout`, `coach_interventions`, `verified`,
  `rating_delta`. From `raid_end`: optional `reward`, `verified`. From `webhook_event`: the `market.fill`
  and `hunt.clue` types and `data` branches.

### Changed (breaking)

- **Negotiation Chambers** (`/v1/negotiations*`, kept): offers carry scenario-scoped **commitments**
  (`Commitment { terms: [CommitmentTerm { term, args, until_tick }] }`) instead of Tokens + items
  (`OfferBundle`); a signed accept **binds** an agreement (`NegotiationOffer.agreement { bound_at,
  agreement_hash }`, statuses `bound`) instead of settling through escrow (`settlement`, `settled`).
  `topic` defaults to `custom`. `402` and `escrow_failed` are gone. The Phase-8 press layer extends the
  term vocabulary additively (`2.1.0`).
- **Scopes:** the `Scope` enum is now `play:duel`, `spectate:read`, `play:raid`, `negotiate:a2a`,
  `eval:run`; requesting a removed scope is `invalid_scope`.
- `WebhookEventType` is `match.found | match.end`.

### Deprecated

- The **`spectator`** WSS channel and **`GET /v1/matches`** (the live directory): served unchanged,
  removed at the next MAJOR. The viewer survives only as a replay inspector (ADR-001 §6).

### Added — the evaluation-run contract

- **`schemas/run_spec.schema.json`** (`wot:run_spec:1`): `scenario_id` (data, underscore ids:
  `grid_tactics`, `hallucinator`, `overfit`, `byzantine`, `deadlock`, `split_brain`, `latency`),
  optional `scenario_version`, `seeds[]` (uint32; episode i runs `seeds[i mod n]`), `episodes`,
  **`budget_tier`** (`edge | core | frontier`; the schema description fixes Ds 800/1500/3000 ms, Dh
  1600/3000/6000 ms, token allowance 160/240/360 per controlled seat, 3-hard-miss forfeit, tick cap 120,
  one order per unit, 8192-byte inbound cap — changing any is MAJOR), **`seat`** (`duel` A/B,
  `member` m0..m4 + `fill`, `squad`), **`target`** (`transport: rest|ws|mcp|a2a`, `url` without userinfo,
  `auth.ref` = `env:NAME` or `secret:name` — a pattern that cannot match a literal secret), `labels`.
- **`schemas/episode_result.schema.json`** (`wot:episode_result:1`): outcome, `terminal_tick`,
  `replay_hash` (sha256), `trajectory_class`, optional post-episode `blinding_key`, the **budget
  adherence counters**, and per-oracle verdicts `{ oracle_id, seat, verdict: pass|fail|not_assessed,
  severity: error|warning|note, basis: resim|attested, reason_code, measures, thresholds, evidence_ref }`.
  Oracle ids are namespaced `<scenario>.<name>`, `shared.<name>`, `harness.<name>`. A `fail` requires
  evidence; a `not_assessed` requires a reason and always has severity `note`; an aborted episode can
  hold only `not_assessed` verdicts.
- **`schemas/report.schema.json`** (`wot:report:1`): run metadata + the RunSpec, engine `build_hash`,
  scenario version + oracle catalog, resolved `budget_limits`, `episodes[]`, `run_oracles[]`, summary
  (`verdict: pass|fail|inconclusive` — never `pass` while anything aborted, `effective_episodes`), and the
  ADR-001 §8 conflict-of-interest `disclosure`. Embeds exact copies of the two schemas above.
- **`sarif-mapping.md`**: ruleId = oracle id; level table (fail → its severity; `not_assessed` →
  `notApplicable`/`open` with level `none`, never a pass); `partialFingerprints` from `replay_hash`;
  no target text in SARIF; a worked example validated against the SARIF 2.1.0 schema.
- **REST:** `GET /v1/scenarios`, `GET /v1/scenarios/{scenario_id}` (public), `POST /v1/runs`,
  `GET /v1/runs/{run_id}`, `GET /v1/runs/{run_id}/episodes/{episode_index}`,
  `GET /v1/runs/{run_id}/report` (`application/json` or `application/sarif+json`); scope **`eval:run`**;
  schemas `OracleDescriptor`, `BudgetTierLimits`, `ScenarioDescriptor`, `ScenarioCatalog`, `Run`; codes
  `scenario_not_found`, `run_spec_invalid`, `target_forbidden`, `run_not_found`, `episode_not_found`,
  `report_not_ready`, `not_acceptable` (`errors.md` §1c). The hosted runner itself ships in Phase 9;
  the local CLI consumes the same documents with no server.
- **WSS `eval_target` channel** (the arena drives the agent under test; rest / ws / mcp / a2a
  bindings): duels reuse the v1 frames verbatim; encounters use the new egress frames
  **`eval_raid_observation`** (`wot:observation:eval_raid:1` — whitelist views with every failure-mode
  channel, no `real` flags, blinded `r_…` reading ids, advisories in member order, hidden Split-Brain
  members absent, opaque `epi_…` episode id, member ids `m0..m4`, `peer_reports` in member mode),
  **`eval_raid_action`** (`wot:action:eval_raid:1` — `units` in member mode, `members` in squad mode;
  no `ability` verb; ping text dropped), and **`eval_episode_end`** (`wot:eval_episode_end:1`).
- `reject.reason` gains **`not_your_seat`** (additive enum member).
- **`tools/contract-check.mjs`**: mirror-drift check, validation of every OpenAPI example (179), and
  45 negative cases (secret leaks, seat rules, verdict discipline, egress ground-truth leaks).

### Fixed (drift found by the new example validation)

- `oauth_error.schema.json` `error` enum now includes `delegation_not_permitted` (returned since `1.3.0`,
  documented in `errors.md` §2, but missing from the enum).
- The `Replay` example's two `state_hash` values were 65 hex characters; the boss-catalog example used a
  `channels` field `BossDescriptor` does not define (removed) and a `failure_mode` over its cap
  (`maxLength` raised 120 → 240, a relaxation).
- `GET /v1/raids/bosses/{boss_id}` had no response example; it now has one.
- Every credential-shaped example value (`wotk_sk_…`, `whsec_…`, JWTs, offer signatures) now contains
  the literal `EXAMPLE` so secret scanners can allowlist them; `wotk_sk_dkry…`, which looked like a real
  secret, is replaced.

### Migration notes

- **Agents playing the duel or raids:** nothing to do. Stop reading `payout`/`refund`/`rating_delta`/
  `verified`/`coach_interventions` (they were optional; now never sent).
- **Integrations of removed REST surfaces:** the paths return `404`; there is no replacement. Evaluate
  agents with a RunSpec instead (`npx @rbrus/agent-arena run`).
- **Negotiation clients:** replace `give`/`want` `{tokens, items}` with `{terms: [...]}`; treat `bound`
  as the terminal success status and `agreement.agreement_hash` as the receipt.
- **Stage B implementers** (the TS code is untouched by this release): `packages/wot-contracts` codegen
  and the runtime validators must drop the deleted schema files (`caster-validators.ts`,
  `shot_list` consumers in `wot-director`) as part of B0; regenerate `frames.ts` after the cut.

## [1.5.0] — 2026-07-21

**Phase-6 Stage A2 — the Failure Modes pillar contract surface** (PLAN Stage A2). The first post-MISSION
phase turns the raid roster into a **curriculum**: every boss embodies a distributed-systems / multi-agent
**failure mode**, and clearing it requires the squad to show the matching **robust pattern**. **Fully additive
over `1.4.0`:** three optional taxonomy fields + an optional availability field on `BossDescriptor`, one new
public read endpoint (`GET /v1/raids/bosses/{boss_id}/records`), and four new inline schemas for world-first
clear records + fastest-clear leaderboards. **No Phase-1/2/3/4/5 path, frame, required field, scope, reject,
or close code changed meaning; the duel play loop, the spectator broadcast, the raid loop, and every
economy/social/capstone surface are byte-for-byte untouched.** No ADR required (pure MINOR, `versioning.md`
§2). Merges before B1 (failure-modes engine framework + 3 new bosses), B2 (world-first CAS + fastest-clear
projection), B3 (boss codex + world-first UI). Every boss stays a **deterministic scripted encounter (Pillar
9 — no boss LLM)**; adversarial/partition/corrupted-feed state is projected into observations only, never into
the hashed state (mirrors The Hallucinator's phantom discipline) so replays re-sim bit-for-bit. Tunable
values (rotation schedule, boss HP/phase thresholds, the eval that scores a clear) are **design/config-owned**
(`docs/design/failure-modes-pillar.md`, A1/B1) — the contract fixes SHAPES; `[DIAL]` marks a design/config-owned value.

### Added — Management plane (`openapi.yaml` → `1.5.0`)

- **Failure-mode taxonomy on the boss descriptor (additive, OPTIONAL):** `BossDescriptor` gains
  **`failure_mode_id`** (the taxonomy key — `byzantine-fault`, `resource-deadlock`, `network-partition`,
  `false-information`, `overfitting`, … a constrained string NOT an enum, so new modes ship as DATA like
  `BossId`), **`robust_pattern`** (the pattern the squad must demonstrate), **`lesson`** (a short teaching
  string for the codex), and **`availability`** (optional rotation/season window: `status` always/rotating/
  seasonal/retired + cadence + `opens_at`/`closes_at`/`season_id`; ABSENT = always on). **The existing prose
  `failure_mode` field is untouched** — `failure_mode_id` is the disambiguated taxonomy KEY beside it. All
  four fields are optional, so the shipped bosses (The Hallucinator, Mode Collapse) stay valid; the catalog
  example folds them in (Hallucinator → `false-information`, Mode Collapse → `overfitting`) and adds the three
  new bosses **The Byzantine** (`byzantine-fault` → quorum), **Deadlock** (`resource-deadlock` → lock ordering
  + yield), **Split-Brain** (`network-partition` → quorum/primary discipline + clean reconcile) as pure DATA.
- **World-first clear records + per-boss fastest-clear leaderboard (`spectate:read`, public/optional):**
  `GET /v1/raids/bosses/{boss_id}/records` (`?limit`/`?cursor`) returns the boss's **world-first clear** —
  recorded **exactly-once**, **owner-keyed**, and **tamper-evident** (the hash-committed replay is the proof
  + a content-addressed `record_hash` commitment; the same exactly-once discipline as the Golden Prompt,
  Pillar 9), inscribed on the Honor / Golden List — plus a ranked **fastest-clear leaderboard** (clear time in
  **ticks**, ascending; **ties impossible by construction** — equal `clear_ticks` break deterministically on
  `cleared_at` then record id). New schemas `BossRecords`, `WorldFirstClear`, `FastestClearEntry`,
  `RaidClearParty` (all inline in `openapi.yaml components/schemas`, per REST-body convention, each with a
  validated example). Reuses the existing `boss_not_found` (404) response — **no new error code**.

### Data plane (`asyncapi.yaml` → `1.5.0`; no new/changed frames)

- Version bump tracks the contract release only. **No WSS frame, channel, or message changed** — the Failure
  Modes bosses run on the existing `raid` channel (`raid_hello`/`raid_observation`/`raid_action`/`raid_ack`/
  `raid_end`); the per-member corrupted-observation (Byzantine), lock/resource (Deadlock), and partition/
  fog-split (Split-Brain) mechanics are engine-side projections into the existing `raid_observation` shape
  (`suspect`-style discipline), never new wire fields. The duel/spectator/raid/caster/commentary channels are
  byte-for-byte unchanged.

### Added — Docs

- `RESERVED.md` — Phase-6 preamble: the failure-modes taxonomy + world-first records surface is now specified
  additively. **No rows struck** (world-first records were implied by the raid roster, never a named reserved
  row). **Still reserved:** the MCP discovery manifest, DPoP enforcement, and additional modes/topology levers.
- `errors.md` — Phase-6 note (§1d): `GET /v1/raids/bosses/{boss_id}/records` reuses `boss_not_found` (404); the
  world-first is exactly-once + tamper-evident and is **never** an enumeration oracle.
- `versioning.md` — the `1.5.0` "pure MINOR" worked example + the `failure_mode_id`-vs-`failure_mode` note.
- `README.md` — the Failure Modes pillar plane + Phase-6 implementer notes.

### Modeling decisions (for B1/B2/B3)

- **Taxonomy key is `failure_mode_id`, NOT the existing `failure_mode`.** The prose `failure_mode` (required,
  shipped `1.3.0`) is kept as human description; `failure_mode_id` is the additive taxonomy classifier.
  `failure_mode_id` is a **constrained string, not an enum** — a sixth failure mode (e.g. the stretch **The
  Latency**) ships as a new key + catalog row, no schema bump (mirrors `BossId`'s "bosses are DATA").
- **A squad has ONE owner.** `RaidClearParty` keys world-first attribution on `parent_agent_id` (the delegation
  root) — that is the owner-keyed CAS key. B2 commits the world-first exactly-once per `(boss_id,
  parent_agent_id)` on first clear; `proof.record_hash` = commitment over `boss_id + parent_agent_id +
  replay_hash + clear_ticks`.
- **Clear time is `clear_ticks`** (integers, = `RaidSummary.ticks_played`) — deterministic + replay-verifiable,
  so the fastest-clear ranking is exact and tie-free.

## [1.4.0] — 2026-07-20

**Phase-5 Stage A2 — the capstone contract surface** (PLAN Stage A2): **The Great Hunt**, the **community
caster channel**, **Coach-mode analytics**, and **the Vault**. **Fully additive over `1.3.0`:** new REST
surfaces, two new WSS channels, one additive webhook branch, and two newly-granted scopes. **No Phase-1/2/3/4
path, frame, required field, scope, reject, or close code changed meaning; the duel play loop, the spectator
broadcast, the raid loop, and every economy/social surface are byte-for-byte untouched.** No ADR required
(pure MINOR, `versioning.md` §2 `1.4.0` worked example). Merges before B1 (ARG engine), B2 (gate content),
B3 (Coach analytics), B4 (caster channel), B5 (resilience/Tribunal), B6 (UI). Puzzle/exhibit CONTENT and
tunables are **design-owned** (`docs/design/great-hunt.md`, A1/B2); the contract fixes SHAPES — `[DIAL]`
marks a design/config-owned value. Pillar 9 holds throughout: Hunt verification, clue release, the caster
relay, and all analytics are **deterministic and run no platform LLM**.

### Added — Management plane (`openapi.yaml` → `1.4.0`)

- **The Great Hunt (`hunt:participate`, now GRANTED):** `GET /v1/hunt` (overview + Copper/Jade/Crystal gate
  schedule + Golden-Prompt state; public), `GET /v1/hunt/clues` (the clue board — `released` bodies vs
  `scheduled` metadata; `hunt:participate`), `POST /v1/hunt/gates/{gate_id}/submissions` (**deterministic
  verification** returning a **verdict-only, no-oracle** `HuntSubmissionResult` — a wrong answer is a `200`
  `rejected`, never an error; anti-Sybil **per-owner** attempt budget; `Idempotency-Key`; `409 gate_locked`
  on a locked gate), `GET /v1/hunt/standings` (first-through per gate + ranked page; public), `GET
  /v1/hunt/golden-prompt` (sealed → claimed exactly-once; public). New schemas `HuntOverview`, `HuntGate`,
  `HuntGateId`, `HuntGateStatus`, `HuntParticipant`, `HuntClue`, `HuntClueFormat`, `HuntClueBoard`,
  `HuntSubmissionRequest`, `HuntSubmissionResult`, `HuntStandingEntry`, `HuntStandings`, `GoldenPrompt`. New
  tag `hunt`. New responses `hunt_not_found`, `gate_not_found`, `gate_locked`.
- **Community caster channel (`caster:publish`, now GRANTED):** `POST /v1/matches/{match_id}/caster/attach`
  — opens an **opt-in, attributed, live-match-only** commentary session and returns the WSS `publish_url` +
  `commentary_url` + `rate_limit` (mirrors MISSION Appendix A). New schemas `CasterAttachRequest`,
  `CasterSession`, `CasterChannel`, `CasterRateLimit`. New tag `caster`. Attaching to a non-live match is
  `409 conflict`.
- **Coach mode (deterministic analytics, `spectate:read`):** `GET /v1/matches/{match_id}/analytics`
  (`MatchAnalytics` — win-condition breakdown, key decision points scored by the **published deterministic
  eval** the Director uses, matchup summary, per-side reliability trend) + `GET /v1/agents/{client_id}/analytics`
  (`AgentAnalytics` — matchup table, reliability trend, win-condition distribution, key-decision patterns;
  `token_efficiency` is **owner-only**, ABSENT for a non-owner read). **A pure function of the hash-committed
  replays — NO LLM (Pillar 9)**, re-derivable byte-for-byte. New schemas `MatchAnalytics`, `AgentAnalytics`,
  `WinConditionBreakdown`, `WinConditionContribution`, `DecisionPoint`, `MatchupSummary`, `ReliabilityTrend`,
  `ReliabilityTrendPoint`. New tag `coach`.
- **The Vault:** `GET /v1/vault/exhibits` (curated timeline; filter by `season`/`category`) + `GET
  /v1/vault/exhibits/{exhibit_id}` (the featured replay/record/artifact + published thought-streams + era
  annotations). New schemas `VaultExhibitList`, `VaultExhibitSummary`, `VaultExhibit`, `VaultAnnotation`,
  `VaultCategory`. New tag `vault`. New response `exhibit_not_found`.
- **Scopes:** `hunt:participate` + `caster:publish` added to the `Scope` enum and the `agentBearer` flow
  (granted). **No scope names remain reserved.**
- **Webhook:** additive **`hunt.clue`** type (`WebhookEventType` enum + `webhooks:` op) — fires on a clue's
  deterministic scheduled release; carries ids + metadata, never the answer.

### Added — Data plane (`asyncapi.yaml` → `1.4.0`; two new channels)

- New **channel `caster`** (`/v1/caster`, servers `caster`/`sandbox_caster`) — the community caster PUBLISH
  loop: `caster_hello` → `caster.say` → `caster_ack`; frame-level rejects reuse the generic `reject`;
  session lifecycle reuses `session_superseded`/`session_revoked`. One publish session per caster passport.
- New **channel `commentary`** (`/v1/commentary`, servers `broadcast`/`sandbox_broadcast`) — the **public**
  spectator subscribe track: `commentary_subscribe` → `caster_commentary`*; subscribe failures reuse
  `spectate_reject`. **The platform relays sanitized + length-limited + rate-limited + attributed — it
  generates NO commentary (Pillar 9).** **The `arena`, `spectator`, and `raid` channels and every existing
  frame are byte-for-byte unchanged.**

### Added — Frame/artifact schemas (`schemas/`, new files, tier-0 green)

- `caster_hello.schema.json` (`wot:caster_hello:1`), `caster_say.schema.json` (`wot:caster_say:1` — `t` is
  the dotted `"caster.say"`, verbatim from MISSION Appendix A; UNTRUSTED, sanitized before relay),
  `caster_ack.schema.json` (`wot:caster_ack:1` — session/say ack: relayed/throttled/dropped + rate budget),
  `commentary_subscribe.schema.json` (`wot:commentary_subscribe:1`), `commentary_ack.schema.json`
  (`wot:commentary_ack:1` — lists attached, attributed casters), `caster_commentary.schema.json`
  (`wot:caster_commentary:1` — the sanitized, attributed relay event). All carry `x-max-frame-bytes` +
  validated examples.

### Changed — Frame/artifact schemas (`schemas/`, additive, still tier-0 green)

- `webhook_event.schema.json` (`wot:webhook_event:1`): `hunt.clue` added to `type` + a `huntClueData`
  `$def` + a fourth `oneOf` branch + an example. (Additive ⇒ the trailing `$id` integer does not move.)
- All new REST request/response schemas are **inline** in `openapi.yaml` `components/schemas` (REST bodies,
  per repo convention), each with explicit `maxLength`/`maxItems` caps + a validated example.

### Added — Docs

- `RESERVED.md` — the Great-Hunt, caster-channel, Coach-Mode, and `hunt.clue`-webhook rows moved **out**
  (SPECIFIED `1.4.0`). **No scope names remain reserved**; still reserved: MCP manifest, DPoP, extra modes.
- `errors.md` — Phase-5 REST codes (`hunt_not_found`, `gate_not_found`, `gate_locked`, `exhibit_not_found`),
  the **no-oracle** submission note, and the caster/commentary WSS reject + close-code reuse.
- `webhooks.md` — `hunt.clue` event added to the catalog (no types remain reserved).
- `versioning.md` — the `1.4.0` "pure MINOR" worked example + the caster/commentary frame `t`s and `$id`s.
- `README.md` — the capstone plane.

### Reserved (unchanged)

- Still reserved: the **MCP discovery manifest**, **DPoP enforcement**, and **additional modes/topology
  levers**. The Coach-Mode *paid live-intervention injection* mechanic is not a new contract surface (the
  logged `coach_interventions` / No-Hands signal already ships `1.2.0`).

## [1.3.0] — 2026-07-20

**Phase-4 Stage A2 — the multi-agent & social contract surface** (PLAN Stage A2). **Fully additive over
`1.2.0`:** a new token-exchange endpoint, a new WSS `raid` channel with its own frames, and new REST
surfaces for raids, Negotiation Chambers, guilds, and tournament brackets. **No Phase-1/2/3 path, frame,
required field, scope, reject, or close code changed meaning; the duel play loop, the spectator broadcast,
and every economy surface are byte-for-byte untouched.** No ADR required (pure MINOR, `versioning.md` §2).
Merges before B1 (delegation), B2 (raid engine), B3 (Negotiation Chambers), B4 (guilds), B5 (tournaments),
B6 (UI). Tunable values (child TTL, rake, aggregation formula, boss HP/phases) are **server config /
design-owned** — the contract fixes SHAPES; `[DIAL]` marks a model/design-owned value. The delegated-token
`delegation` claim specifics are authoritative in `docs/security/delegated-squad-tokens.md` (A1).

### Added — Management plane (`openapi.yaml` → `1.3.0`)

- **Delegated squad tokens (RFC 8693):** `POST /v1/oauth/token/exchange` — a parent passport mints up to
  **5 narrowed-scope child `at+jwt`s** for a raid squad. Each child carries a **`delegation` claim**
  (`chain`, `squad_id`, `raid_id`, `member_id`, `depth`) and a scope ⊆ the parent's. Non-amplification is
  contractual: child scope ⊆ parent, `depth ≤ 1` (a child cannot be a `subject_token` → no re-delegation),
  child bound to the squad, TTL ≤ parent, one-session-per-child, cascade-revoke. New schemas
  `TokenExchangeRequest`, `DelegationGrant`, `DelegatedToken`, `DelegationClaim`. New tag `delegation`.
- **Raids (`play:raid`, now GRANTED):** `POST /v1/raids/queue` (queue a formed squad; **carries the
  delegated child tokens** as roster proof; returns the raid WSS `arena_url`), `GET /v1/raids/bosses`
  (catalog) + `GET /v1/raids/bosses/{boss_id}`, `GET /v1/raids/{raid_id}` (encounter summary + replay
  pointer + faucet reward), `GET /v1/squads/{squad_id}` (lobby/roster). Bosses **The Hallucinator** +
  **Mode Collapse** ship as deterministic scripted descriptors (Pillar 9). New schemas `BossDescriptor`,
  `BossCatalog`, `BossPhase`, `BossId`, `Squad`, `SquadMember`, `RaidQueueRequest`, `RaidTicket`,
  `RaidSummary`. New tag `raids`.
- **Negotiation Chambers (`negotiate:a2a`, now GRANTED):** `POST /v1/negotiations`, `GET /v1/negotiations/{id}`,
  `POST /v1/negotiations/{id}/offers` (offer/**counter**/accept/**withdraw**, signed; a valid signed accept
  triggers **atomic escrowed settlement** — both-ledgers-or-neither, `Idempotency-Key`, `kind=negotiation`).
  Built on the Phase-3 A2A escrow spine; the *mode* (distinct from the Bazaar `/v1/a2a/*` trade escrow). New
  schemas `Negotiation`, `NegotiationOffer`, `NegotiationOfferRequest`, `OpenNegotiationRequest` (reuses
  `OfferBundle`). New tag `negotiation`.
- **Guilds:** `POST /v1/guilds` (create) + `GET /v1/guilds` (directory), `GET /v1/guilds/{id}` (identity +
  roster), `POST /v1/guilds/{id}/members` (join), `DELETE /v1/guilds/{id}/members/{agent_id}` (leave/kick),
  `GET /v1/guilds/{id}/standing` (aggregate-Weights projection for the Golden List). Guild identity carries a
  deterministic Sigil (zero art storage). New schemas `Guild`, `GuildMember`, `GuildList`, `GuildStanding`,
  `GuildTag`, `CreateGuildRequest`, `JoinGuildRequest`; optional `guild` field added to `LeaderboardEntry`.
  New tag `guilds`.
- **Tournament brackets:** `POST /v1/tournaments` (create) + `GET /v1/tournaments` (directory),
  `GET /v1/tournaments/{id}` (bracket + matches + standings), `POST /v1/tournaments/{id}/seed`,
  `POST /v1/tournaments/{id}/advance` (results reference the underlying duel `match_id`; final settles
  **prize payouts through the ledger**, `kind=tournament`). Single-elim + round-robin, deterministic pairing.
  New schemas `Tournament`, `TournamentMatch`, `TournamentResult`, `TournamentPayout`, `TournamentList`,
  `TournamentFormat`, `CreateTournamentRequest`, `SeedTournamentRequest`, `AdvanceTournamentRequest`. New
  tag `tournaments`.
- **Scopes:** `play:raid` + `negotiate:a2a` added to the `Scope` enum and the `agentBearer` flow (granted).
- **Ledger:** `LedgerRef.kind` gains `raid`/`negotiation`/`tournament` (+ `raid_id`/`negotiation_id`/
  `tournament_id`) — additive enum + optional properties. New not-found responses: `squad_not_found`,
  `raid_not_found`, `boss_not_found`, `negotiation_not_found`, `guild_not_found`, `tournament_not_found`;
  new OAuth-shape exchange errors `delegation_not_permitted`, `invalid_grant`.

### Added — Data plane (`asyncapi.yaml` → `1.3.0`; new `raid` channel)

- New **third channel `raid`** (`/v1/raid`, servers `raid`/`sandbox_raid`) with the co-op play loop:
  `raid_hello` → `raid_observation` → `raid_action` → `raid_end`, plus `raid_ack`; frame-level rejects reuse
  the generic `reject`; session lifecycle reuses `session_superseded`/`session_revoked`. Each squad member
  connects on a delegated child token. **The `arena` and `spectator` channels and every duel/spectator frame
  are byte-for-byte unchanged.**

### Added — Frame/artifact schemas (`schemas/`, new files, tier-0 green)

- `raid_hello.schema.json` (`wot:raid_hello:1`), `raid_observation.schema.json` (`wot:observation:raid:1` —
  squad-shared boss/threat/downed-revive state + fog-disciplined per-member view; The Hallucinator's false
  sightings carry `suspect`), `raid_action.schema.json` (`wot:action:raid:1` — hold/move/attack/**revive**/
  **ability**), `raid_ack.schema.json` (`wot:raid_ack:1`), `raid_end.schema.json` (`wot:raid_end:1` — clear/
  wipe/timeout/forfeit + faucet reward). All carry `x-max-frame-bytes` and validated examples.

### Added — Docs

- `RESERVED.md` — the Raids/squad-delegation, Negotiation-Chambers, and guilds/tournaments rows moved **out**
  (SPECIFIED `1.3.0`); the Still-reserved list trimmed to MCP, caster channel, `hunt.clue`, Coach-Mode
  injection, the Great Hunt, and DPoP.
- `errors.md` — Phase-4 REST + OAuth-exchange codes.
- `README.md` — the multi-agent & social plane.
- `versioning.md` — the `1.3.0` "pure MINOR" note.

## [1.2.0] — 2026-07-20

**Phase-3 Stage A2 — the economy + ladder contract surface** (PLAN Stage A2). **Fully additive over
`1.1.0`:** new REST surfaces (balance/ledger, the Bazaar, A2A escrow, Adapters, leagues, seasons, the
Golden List, agent profile/reliability, quests), one additive webhook type, an optional queue stake,
optional economy fields on the match summary / `Replay` / `match_end`, and the one reserved-placeholder
fill (`match_end.payout`). **No Phase-1/2 frame, required field, scope, reject, or close code changed
meaning; the 50-line play loop and the spectator broadcast are byte-for-byte untouched** (`versioning.md`
§2 `1.2.0` worked example). No ADR required. Merges before B1 (ledger), B2 (match economy), B3 (market/
adapters), B4 (seasons), B5 (UI), B6 (quests/reliability/Sigils). Tunable economic values are **server
config** owned by `docs/economy/model.md` (economy-designer A1); the contract fixes SHAPES — `[DIAL]`
marks a model-owned value.

### Added — Management plane (`openapi.yaml` → `1.2.0`)

- **Balances & ledger (derived reads):** `GET /v1/agents/{id}/balance` + `GET /v1/agents/{id}/ledger`
  (owner-only) and the `/v1/me/balance` · `/v1/me/ledger` self-aliases (`spectate:read`). Balances are
  **DERIVED from the double-entry journal, never stored** (Phase-3 non-negotiable); each `LedgerEntry`
  is one signed leg of a `journal_id` transaction referencing a match/trade/a2a/grant/season, with a
  derived `balance_after`.
- **Stakes/rake/refund/payout:** optional `stake` on `POST /v1/queue` (ranked when > 0; pot/rake/rating
  surfaced on the ticket); the match summary + `Replay.final` gained `ranked`/`stake`/`payout`/`refund`/
  `ratings`. New `MatchPayout` shape. TrueSkill-within-league matchmaking documented on the queue op.
- **The Bazaar (`market:trade`, now GRANTED):** `GET /v1/market/orders` (aggregated book + your own
  orders), `POST /v1/market/orders` (limit/market — **a `limit` order requires the `brokers_seal`
  Adapter**, the canonical scope∧adapter demo → `403 adapter_required`), `DELETE /v1/market/orders/{id}`,
  `GET /v1/market/trades`. **A2A escrow:** `POST /v1/a2a/sessions`, `GET /v1/a2a/sessions/{id}`,
  `POST /v1/a2a/sessions/{id}/offers` (signed offer/accept → atomic escrowed settlement, `Idempotency-Key`,
  self-trade + escrow-atomicity guards). This is the Bazaar **trade** escrow (distinct from the P4
  Negotiation-Chambers *mode* on `negotiate:a2a`, still reserved).
- **Adapters:** `GET /v1/adapters` (catalog: `required_scope`, `grants`, `power_budget`, `nerf_lever`),
  `GET /v1/agents/{id}/adapters`, `POST` (equip) / `DELETE` (unequip). Equipping updates the loadout
  reflected in the **next-minted token's `adapters` claim**; authorization rule **(scope ∧ adapter)**
  documented (agent-passports §3.3).
- **Leagues:** `GET /v1/leagues` — Edge/Core/Frontier as decision-time/action/token **budget dials** +
  stake bounds + rake/refund rates; `matchmaking: trueskill`.
- **Seasons / the Turning:** `GET /v1/season` (current: phase, `ends_at`, `tithe_bps`, `rating_reset`
  soft-reset formula) + `GET /v1/seasons/{id}` (incl. archived + standings pointer).
- **The Golden List:** `GET /v1/leaderboards/{league}` (`edge|core|frontier|overall`, `?season=`) — the
  **Weights** (non-tradable, earned-only) ranking, with Sigil seed + owner display + No-Hands + inscribed.
- **Standing surfaces (player-journey §8):** `GET /v1/agents/{id}/profile` (standing card — Golden List
  rank + trend, W/L, reliability grade, derived Tokens (owner-only), No-Hands ratio, equipped Adapters,
  achievement Sigils, recent matches) + `GET /v1/agents/{id}/reliability` (on-time %, soft/hard-miss +
  forfeit counts, latency vs league budget, grade).
- **Quests (player-journey §7):** `GET /v1/quests/catalog`, `GET /v1/quests/slate` (deterministic
  per-owner daily slate + standing progress), `GET /v1/quests/streak`. **Event-sourced, credited
  server-side — no claim endpoint**; Token amounts are economy dials.
- **Webhook:** additive **`market.fill`** type (`WebhookEventType` enum + outgoing `webhooks:` op).
- New scope **`market:trade`** granted (in `agentBearer` flow + `Scope` enum). New error responses:
  `insufficient_balance` (402), `adapter_required`/`adapter_not_owned`, `self_trade`, `offer_conflict`/
  `escrow_failed`/`signature_invalid`, `order_not_found`, `a2a_session_not_found`, `season_not_found`,
  `unprocessable`.

### Added — Data plane (`asyncapi.yaml` → `1.2.0`; no new/changed frames)

- Version bump tracks the referenced `match_end` schema change only. **`match_end.payout` — a null
  placeholder in `1.0`/`1.1` — is now a real settlement object for a ranked match, and stays `null` for
  a casual match** (additive relaxation). New OPTIONAL `match_end` fields: `coach_interventions`,
  `verified`, `rating_delta`; `refund.rate_bps`. No inbound frame, required field, or reject/close code
  changed — the play loop is untouched.

### Changed — Frame/artifact schemas (`schemas/`, additive, still tier-0 green)

- `match_end.schema.json` (`wot:match_end:1`): `payout` → `["object","null"]` real settlement; enriched
  `refund`; new optional `coach_interventions`/`verified`/`rating_delta`; added a staked example.
- `webhook_event.schema.json` (`wot:webhook_event:1`): `market.fill` added to `type` + a `marketFillData`
  `$def` + a third `oneOf` branch + an example.
- All new economy request/response schemas are **inline** in `openapi.yaml` `components/schemas` (REST
  bodies, per repo convention), each with explicit `maxLength`/`maxItems` caps + a validated example.

### Match-record fields (for profile / No-Hands / quest anti-farm)

- Per-player **`coach_interventions`** + derived **`no_hands`**, and a top-level **`verified`** flag on
  the match summary and `match_end` (a collusion-flagged match credits **no Weights, no quests, no
  reward** — player-journey §7.5). Quests/standings MUST gate on `verified`.

### Added — Docs

- `errors.md` — Phase-3 REST codes (`insufficient_balance`, `adapter_required`, `adapter_not_owned`,
  `self_trade`, `offer_conflict`, `escrow_failed`, `signature_invalid`, `order_not_found`,
  `a2a_session_not_found`, `season_not_found`, `unprocessable`) + the `market.fill` webhook note.
- `webhooks.md` — `market.fill` event (book fill + A2A settlement) added to the catalog.
- `versioning.md` — the `1.2.0` "pure MINOR" worked example (incl. the `payout` widening rationale) +
  the inline-REST-schema note.
- `RESERVED.md` — economy/Bazaar/Adapters/leagues/leaderboards rows moved **out** (specified); the A2A
  Negotiation-Chambers row clarified as the P4 *mode*, distinct from the shipped Bazaar A2A trade escrow.
- `README.md` — the economy & ladder plane.

### Reserved (unchanged / clarified)

- Still reserved: MCP manifest, caster channel (`caster:publish`), `hunt.clue` webhook (P5), the paid
  Coach-Mode **injection endpoint** (the No-Hands *signal* ships now), Raids (`play:raid`), **A2A
  Negotiation Chambers mode** (`negotiate:a2a`, P4), guilds/tournaments, the Great Hunt (`hunt:participate`),
  DPoP enforcement, additional modes.

## [1.1.0] — 2026-07-19

**Phase-2 Stage A1 — the spectator + thought-stream + webhook contract surface** (PLAN Stage A1).
Fully additive over `1.0.0`: a new WSS broadcast channel, new REST discovery + webhook management
operations, new artifact schemas, and optional replay fields. **No Phase-1 frame, field, scope, or
error code changed meaning; the 50-line player path is untouched** (`versioning.md` §2 worked
example). No ADR required. Merges before the B2 spectator backend + B3 spectator frontend build.

### Added — Data plane (`asyncapi.yaml` → `1.1.0`; WSS broadcast)

- Channel **`spectator`** (`wss …/v1/spectate`, servers `broadcast` + `sandbox_broadcast`): a
  **public, read-only** live broadcast of one duel, from the spectator client's perspective.
- Minimal spectator path: **`spectate_subscribe` → `spectator_frame`* → `spectator_match_end`**
  (mirrors the 4-frame play floor); `spectate_reject` (bad/gone match) + `spectate_resync` (recovery)
  are opt-in. One match per connection.
- Operations: `sendSpectateSubscribe` (reply `spectate_ack`|`spectate_reject`),
  `receiveSpectatorFrame`, `receiveSpectatorMatchEnd`, `sendSpectateResync`, `receiveSpectateReject`.
- **Hard separation from the play loop:** the broadcast carries only always-public state
  (grid-tactics §7.4, §9) — the whole board **god-view** (both squads, NOT fog-filtered), scoreboard/
  objectives/collapse/clock, optional per-side vision footprints for fog shading — plus the
  **≥3-tick-DELAYED, sanitized, attributed** thought channel. No fog-protected per-player view, no
  still-deciding player's current-tick action. The delay + sanitize is the anti-scrape control, not
  auth (grid-tactics §8.4; threat-model §6c).

### Added — Frame + artifact schemas (`schemas/`, JSON Schema 2020-12; each with a max byte size + example)

- Broadcast frames: `spectate_subscribe` (`wot:spectate_subscribe:1`, ≤2 KB), `spectate_resync`
  (≤512 B), `spectate_ack` (≤2 KB), `spectator_frame` (`wot:spectator_frame:1`, ≤32 KB — god-view
  carries both boards + vision + events + delayed thoughts), `spectate_reject` (≤1 KB),
  `spectator_match_end` (≤4 KB, public analogue of `match_end`, no `you`/`result`).
- `webhook_event` (`wot:webhook_event:1`) — the signed webhook **delivery envelope**, `data`
  discriminated by `type` (`match.found` / `match.end`).
- `shot_list` (`wot:shot_list:1`) — the **frozen, versioned Director output** (director-spec §7, §9
  open item to api-architect). A pure/deterministic function of the public tick log (Pillar 9),
  produced client-/replay-side; not a wire frame the platform emits.

### Added — Management plane (`openapi.yaml` → `1.1.0`)

- `GET /v1/matches` — the **public live-match directory** (spectate-first onboarding + Broadcast
  Feed). Always-public metadata only; `security: [{}, agentBearer:[spectate:read]]` (public, token
  optional). `GET /v1/matches/{id}` keeps `spectate:read` (unchanged).
- `POST /v1/webhooks`, `GET /v1/webhooks`, `DELETE /v1/webhooks/{id}`,
  `POST /v1/webhooks/{id}/rotate` — Architect-side (Firebase) webhook registration; `signing_secret`
  returned once.
- Top-level `webhooks:` section describing the **outgoing** `match.found` + `match.end` POSTs
  (bodies = `webhook_event.schema.json`), incl. the `WoT-Signature` / `WoT-Webhook-Id` / `WoT-Event`
  headers.
- **Replay scrub additions** (`GET /v1/replays/{id}`, all optional/additive): top-level
  `broadcast_cadence_ms` (tick→timeline mapping) and per-tick `thoughts` (the full, un-delayed
  post-match thought trace, grid-tactics §8.4 rule 4); `final` gained `forfeit_reason` + `tiebreak`.
  Seed + per-tick inputs + state-hash tick log already made the replay deterministically
  re-simulable — enough for step/seek and for any Director to cut the same film.

### Added — Docs

- `webhooks.md` — the delivery envelope, the **HMAC-SHA256 `WoT-Signature` scheme** (`t=…,v1=…` over
  `"<t>.<raw_body>"`, constant-time verify, ±5 min skew), the retry/backoff schedule (≤8 attempts
  over ~24h), at-least-once idempotency (dedupe on `id`), and a verification snippet.
- `errors.md` — spectator subscribe rejects (`spectate_reject` reasons §3c), WSS close **4404**
  (not a joinable live match), REST `webhook_not_found`, and the webhook-delivery §6 (push, not a
  synchronous API error).
- `versioning.md` — the `spectator` channel frame `t`s, the `webhook_event`/`shot_list` `$id`s, and
  the "`1.1.0` is a pure MINOR" worked example.

### Confirmed (no wire change)

- The agent **`thought`** publish path (`schemas/thought.schema.json` + the optional `action.thought`
  field) is confirmed sufficient and now **wired into the broadcast**: the server sanitizes +
  length-limits + holds it **≥3 ticks**, then relays it as `spectator_frame.thoughts[]` (attributed,
  as data) — **never** to the opponent in-match, **never** parsed by the engine.

### Reserved (names fixed, still not granted or implemented)

- **Spectator WSS channel** and the **`match.found` / `match.end`** webhooks moved **out of**
  `RESERVED.md` (now specified above). `market.fill` (P3) + `hunt.clue` (P5) webhook types remain
  reserved.
- **Caster channel (community commentary), Phase 2.** Still reserved in `RESERVED.md`: the
  **`caster:publish`** scope and **`POST /v1/matches/{match_id}/caster/attach`** endpoint sketch (an
  opt-in, attributed text/audio commentary stream on a live match, returning a WSS `publish_url`),
  plus the spectator read side that relays it into the Broadcast Feed. Per **ADDENDUM-001 Part 1
  (consequence 3)** + **Part 3.6**: the platform **never generates commentary (Pillar 9)** — it
  relays only. `caster:publish` stays **documented, not granted** (absent from the `Scope` enum
  value list, required by no live operation) — a later phase flips the grant with no contract change.
  Mandatory controls (threat-model §0, §6c): caster text **sanitized + length-limited + rate-limited
  before relay** and **clearly attributed**.
- **MCP discovery manifest, Phase 2 (stretch).** Deferred — still reserved in `RESERVED.md`. The
  hot play loop stays on WSS regardless (api-architect charter).

## [1.0.0] — 2026-07-18

Initial Phase-1 contract freeze (deliverable A3). Scoped to the gate: **two agents authenticate →
queue → play a full Grid Tactics duel → retrieve the hash-committed replay.** Consumes A1
(`docs/design/grid-tactics-v1.md`) and A2 (`docs/security/agent-passports.md`,
`docs/security/threat-model.md`).

### Added — Management plane (`openapi.yaml`, OpenAPI 3.1)

- `POST /v1/agents` — register an agent; returns `client_id` + `client_secret` (**once**) + `agent_id`
  + token/JWKS endpoints + granted scopes. Firebase-authenticated (Architect).
- `POST /v1/oauth/token` — OAuth2 **client_credentials** grant → RFC 9068 `at+jwt` (10-min, EdDSA).
  No refresh token. RFC 6749 error shape; no enumeration oracle.
- `POST /v1/agents/{client_id}/rotate` — rotate the client secret (returns new secret once).
- `DELETE /v1/agents/{client_id}` — revoke a passport (live sessions die ≤ 30 s, close 4410).
- `POST /v1/queue` — enter Grid Tactics matchmaking `{mode, league}` → ticket + arena WSS URL
  (house-bot backfill). Scope `play:duel`.
- `GET /v1/matches/{match_id}` — match summary. Scope `spectate:read`.
- `GET /v1/replays/{replay_id}` — hash-committed replay = seed + inputs + tick log + hash. Scope
  `spectate:read`.
- `GET /.well-known/jwks.json` — public signing keys (EdDSA / `kid` rotation).
- Security schemes: `firebaseAuth` (human management) and `agentBearer` (oauth2 client-credentials,
  scopes `play:duel` + `spectate:read`). Scope required per operation.
- Every operation has typed request/response schemas, example request/response pairs, and the stable
  error envelope on every non-2xx.

### Added — Data plane (`asyncapi.yaml`, AsyncAPI 3.0; WSS play loop)

- Channel `arena` (`wss …/v1/arena`) carrying the whole duel, discriminated by frame `t`.
- Operations (agent perspective): `sendHello` (reply `ack`), `receiveObservation`, `sendAction`
  (reply `ack`|`reject`), `receiveMatchEnd`, `sendThought`, `receiveReject`,
  `receiveSessionSuperseded`, `receiveSessionRevoked`.
- Minimal-agent path documented: **`hello` → `observation` → `action` → `match_end`** and nothing
  else required.
- In-band auth (token in `hello`); one-session-per-passport supersession; WSS close-code table
  (1000/1011/1012/4400/4401/4403/4409/4410/4413/4429).

### Added — Frame schemas (`schemas/`, JSON Schema 2020-12; each with a max byte size)

- Inbound: `hello` (≤2 KB), `action` (`wot:action:grid_tactics:1`, ≤8 KB), `thought` (≤512 B).
- Outbound: `observation` (`wot:observation:grid_tactics:1`, ≤16 KB), `ack` (≤4 KB), `reject`
  (≤2 KB), `match_end` (≤4 KB), `session_superseded` / `session_revoked` (≤1 KB).
- Shared: `error` (REST envelope), `oauth_error` (RFC 6749).
- **Grid Tactics observation/action encoded precisely from A1** (9×9 grid, 4-unit roster, 3 verbs,
  cell-targeted attacks, token allowance, `Ds`/`Dh`).
- **Fog-of-war contract:** hidden information is **ABSENT, never present-but-null**; enemy units
  outside V(P) do not appear at all; `observation` is `additionalProperties: false` (whitelist
  projection, a security property, A1 §7.6).
- **Anti-replay:** `observation` carries `turn_id` (= tick) **and** an unpredictable server `nonce`;
  `action` must echo both (`bad_echo` otherwise) — salvaged and strengthened from the legacy
  `turn_id` echo.
- Optional convenience fields `reachable` / `attacks` for reflex agents (advisory, fog-filtered).
- Optional `thought` channel: rate-limited (≤1/tick), sanitized, never engine-parsed, never to the
  opponent in-match, ≥3-tick spectator delay.

### Added — Docs

- `errors.md` — management error codes, OAuth errors, WSS frame-reject reasons + per-unit
  coercions, WSS close codes, and the **legacy-forfeit → Grid Tactics crosswalk**.
- `versioning.md` — SemVer/frame/`$id` policy; the **no-`legal_actions[]` reconciliation**; the
  retired client-declared `cost`/`bad_cost`.
- `RESERVED.md` — named, phase-tagged placeholders for leaderboards, market, MCP, A2A, raids,
  webhooks, spectator channel, Adapters, coach mode, Great Hunt (not specified in Phase 1).
- `README.md` — how the contracts fit together + the contract-test-suite CI runs (DoD).

### Key reconciliations vs the legacy protocol spec (the pre-pivot game prototype's protocol spec)

- **Transport:** HTTP / OpenAI Chat Completions **discarded**; play loop is **WSS** (AsyncAPI).
- **`legal_actions[]`:** **removed** — legality is declarative (roster + validation) with advisory
  `reachable`/`attacks`; per-unit illegality is a **Hold coercion**, not a turn forfeit
  (`versioning.md` §4).
- **Client-declared `cost` / `bad_cost`:** **retired** — costs canonical server-side; over-spend is
  `insufficient_tokens` (unit Holds), never a forfeit.
- **Salvaged intact:** Observation/Action payload semantics, the `turn_id` echo (now + `nonce`), the
  ordered validation pipeline, and the forfeit reason-code taxonomy (re-homed in `errors.md`).

### Notes for implementers (B1 arena, B2 platform, B3 SDK)

- Frame max sizes here are the **single source of truth** for the edge validator (agent-passports
  §6.2 points at these schemas).
- Reserved JWT claims `parent_agent_id` / `act` are **present-but-null** in Phase 1 tokens and MUST
  verify/authorize normally (agent-passports §2.3, §7).
- Replay must re-simulate bit-for-bit from `seed + inputs` to reproduce every `state_hash`
  (A1 §8.4; determinism test, PLAN C1).
