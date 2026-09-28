# Signing — canonical form, signed objects, verification

**Since:** contracts `2.2.0` (HOSTED-PROFILE.md §0.1 K1, K4, K9; §2.7, §3). **Governing:**
the hosted-runner threat model §2.1, §2.5, §5 and the arena threat model §3.3 (both in the program repository).
**Test vectors:** `fixtures/signing_vectors.json` (regenerate with `node contracts/tools/signing-vectors.mjs`);
`tools/contract-check.mjs` §6 verifies them on every run. **Since 2.4.0** also the passport signatures on
negotiation moves: §7 (Diplomacy press, vectors in `fixtures/press_signing_vectors.json`, checked by
`tools/contract-check.mjs` §8) and §8 (Negotiation Chambers). **Since 2.5.0** deletion receipts (§9). **Since 2.6.0** the
run tokens a reference target verifies (§10, vectors in `fixtures/signing_vectors.json` `run_token_vectors`), the
scenario-pack envelope and layout (§11, fixture pack `fixtures/packs/sx-agentic-core/`, vector `pack_vectors`), the hosted
bundle layout (§5.1), and the hosted runner's environment contract (§3.1, machine-readable in `fixtures/hosted_env.json`).
**Since 2.11.0** the pinned key set an open release bundles (§3.3, `pinned_keys.schema.json`, checked by
`tools/contract-check.mjs` §15) and signed digest statements for payloads over the KMS raw-data limit (§5.2,
`digest_statement.schema.json`, vectors in `fixtures/digest_statement_vectors.json`, checked by §16).

A signature adds exactly one statement to a hosted report: *the Sixi Arena control plane holding key
`kid` ran run `run_id` for org `org_ref` against origin `O`, verified by record `V`, with image digest
`D`, and recorded these inputs.* It does not add reproducibility (that is `verify`, which needs no key)
and it says nothing about which model answered.

---

## 1. Canonical form

**RFC 8785, JSON Canonicalization Scheme (JCS).** The signed bytes of a document are the UTF-8 bytes of
`JCS(D')`, where `D'` is the document with the single member `/signing/signature` removed. Nothing else
is removed or rewritten.

- JCS sorts object keys by UTF-16 code units, serialises strings and numbers as ECMAScript
  `JSON.stringify` does, and emits no whitespace. Every contract number is an integer within ±2^53, so
  the number rule never rounds.
- A JCS implementation in 12 lines is in `tools/contract-check.mjs` (`jcs`). `arena-report`'s
  `canonicalize()` produces the same bytes for every contract document (sorted keys, `JSON.stringify`
  primitives, non-finite numbers refused) and can be reused.
- **Why JCS and not the file bytes.** The signature is carried inside the report (`signing`), so the
  file can never be its own signed payload. The file form (`toFileJson`: 2-space JSON, LF, trailing
  newline) stays the on-disk and SARIF-equality form; the signed form is independent of whitespace
  and key order, so a verifier can re-derive it from any faithful copy of the report (a dashboard
  export, a re-indented file) without trusting how it was written.

## 2. The signed message

```
body    = UTF-8( JCS( D without /signing/signature ) )
message = PAE(payload_type, body)
        = "DSSEv1" SP LEN(payload_type) SP payload_type SP LEN(body) SP body     (DSSE v1; LEN = decimal byte length)
sig     = Ed25519(key, message)                                                  (RFC 8032, pure Ed25519, no pre-hash)
signing.signature = base64(sig)                                                  (standard alphabet, 88 chars with "==")
```

- **The signature can never sign itself.** Every signed document carries
  `signing.excluded: ["/signing/signature"]`, and the schemas make that a `const`: a document that
  declares no exclusion (its signature inside its own signed payload) or a different one is invalid.
  A signature placed anywhere else (for example `run.hosted.signature`) is refused by
  `additionalProperties: false`.
- **Everything else is covered,** including the rest of `signing`: `algorithm`, `signing_key_id`,
  `canonicalization`, `payload_type`, `run_manifest_digest`, `sealed_at`. Moving a signature to another
  key's context, or to another manifest, breaks it.
- **Domain separation** is the payload type inside PAE. A report signature never verifies as a manifest
  or cross-check signature, even over identical bytes.

| Signed object | Schema | `payload_type` | Key (kid namespace) | Signed by |
|---|---|---|---|---|
| Report | `report.schema.json` `signing` | `application/vnd.sixi.arena-report+json` | report key, e.g. `sixi-arena-ed25519-20261101` | seal step, after `verify` returned verified |
| Run manifest (= hosted context) | `hosted_context.schema.json` `signing` | `application/vnd.sixi.arena-run-manifest+json` | manifest key, e.g. `sixi-arena-manifest-ed25519-20261101` | control plane, at admission |
| Cross-check record | `crosscheck_record.schema.json` `signing` | `application/vnd.sixi.arena-crosscheck+json` | report key | cross-check job |
| `report.sarif`, `bundle-manifest.json` | — (detached, §5) | `application/vnd.sixi.arena-sarif+json`, `application/vnd.sixi.arena-bundle+json` | report key | seal step |
| Deletion receipt (2.5.0) | `deletion_receipt.schema.json` `signing` | `application/vnd.sixi.arena-deletion+json` | report key | control plane (§9) |
| Digest statement (2.11.0) | `digest_statement.schema.json` `signing`; in place of a raw signature (§5.2) | `application/vnd.sixi.arena-digest-statement+json` | the key of the document it covers | seal step, cross-check job |
| Scenario pack manifest (2.6.0) | `pack_manifest.schema.json`, as the payload of `pack.dsse.json` (§11) | `application/vnd.sixi.arena-pack+json` | a key of the pinned control-plane (manifest) key set (§3.3) | pack store, at publication |

Run tokens (§10) are compact JWS, not DSSE. They are signed with the run-token key, which has its own kid namespace.

(2.11.0) The kids in this table and in every example are date-style illustrations signed with the RFC 8032 test key. A
live Sixi kid is derived from its key (§3.3 rule 1), for example `sixi-arena-ed25519-c2f84888ae5d69e9f7df`.

**The DSSE envelope of a report** (`report.json.dsse.json`) is derived, not independent:
`payloadType` = `signing.payload_type`, `payload` = base64(`body`), `signatures[0].keyid` =
`signing.signing_key_id`, `signatures[0].sig` = `signing.signature` (byte-identical). A verifier with
only `openssl` 3.x decodes the payload, checks that it is byte-equal to `JCS(report without
/signing/signature)` (or, without a JCS tool, that `jq -S 'del(.signing.signature)'` of both sides is
equal), builds the PAE and runs `openssl pkeyutl -verify -pubin -inkey key.pem -rawin -in pae.bin
-sigfile sig.bin`.

**Key id equality.** `signing.signing_key_id` = `run.hosted.signing_key_id` = SARIF
`runs[0].properties.agentArena.signing_key_id` = DSSE `signatures[].keyid`. All four MUST be equal;
`verify --hosted` fails otherwise.

## 3. The run manifest and its digest

The hosted context (`hosted_context.schema.json`; the `--manifest` file, §3.1) is the run manifest of
`threat-model-hosted.md` §2.1: the runner's only trusted input besides the RunSpec, which it binds with
`run_spec_digest = "sha256:" + hex(sha256(JCS(RunSpec)))`.

```
run_manifest_digest = "sha256:" + hex( sha256( JCS( hosted_context without /signing/signature ) ) )
```

That is the digest of the manifest's own signed body. It is the run's identity and is written into the
signed report twice: `run.hosted.run_manifest.digest` and `signing.run_manifest_digest` (equal). The
bundle carries the manifest as `run-manifest.json`, so a verifier can recompute the digest offline.

Rules for the control plane, the runner and the seal step:

1. The runner refuses a manifest whose signature does not verify against the pinned control-plane key set (§3.3),
   whose `run_spec_digest` differs from the RunSpec it received, or whose `verified_origin.origin` differs
   from the RunSpec target origin (`hosted_context_invalid`, errors.md §1d).
2. The seal step signs a report only if its `signing.run_manifest_digest` is a digest the control plane
   issued and has not been sealed before (single use), the report's `run.hosted` equals the manifest's
   fields, and (2.6.0, made precise) `agent-arena verify --hosted-seal <out dir>` on the unsealed bundle, run with the
   image the run used, exited **0** (§5.1). Any other exit is `seal_failed`, and nothing is signed. (2.12.0) The seal
   step reads that outcome from the `--result` file (§5.1.1) and from nothing else: `exitCode` `0`, `status`
   `verified`, `hosted_seal.sarif_equal` `true`, and `hosted_seal.seal` and `hosted_seal.mismatch` empty. No usable
   file is `seal_failed` with the reason `verify_no_result`.
3. `run.hosted` fields copied from the manifest: `signing_key_id`, `region`, `image_digest`,
   `verified_origin`, `org_ref`, `scan_id`, `credential_mode`, `seed_source`, `packs`, `retention`, plus
   `run_manifest {digest, signing_key_id, path}`. The seal step adds `run.hosted.sealed_by` and `signing`.
   Nothing else in the report changes between the runner and the seal.

### 3.1 Delivery to the runner (2.5.0; SIXI-INTEGRATION.md OQ-2, OQ-11)

Nothing run-specific reaches the hosted runner as a per-execution environment **override** or a container argument.
Cloud Run keeps overrides and arguments in execution metadata and in the Admin Activity audit log, where project
viewers can read them and where they cannot be relocated. That would expose the customer's origin and `org_ref`
(threat-model-hosted.md §2.4). Everything else is either a file or a secret reference:

| Input | Hosted form | Rules |
|---|---|---|
| Run manifest (hosted context) | `--manifest <file>` | A regular file on the run's read-only storage prefix, at most 8192 bytes. It is read once, before any I/O, and validated against `hosted_context.schema.json` and the pinned control-plane key (§3 rule 1). |
| RunSpec | `--run-spec <file>` | The same kind of file, at most 16384 bytes (the RunSpec cap). Its digest must equal `run_spec_digest`. |
| Target credential | env `ARENA_TARGET_CREDENTIAL` | Backed by a per-run secret reference (for example `secretKeyRef`), never an override. The runner reads it, registers it with the redactor, and deletes it from its environment on load (2.2.0, K6). |
| Seat credentials | env `ARENA_SEAT_CREDENTIAL_<POWER>` | One per `seats[]` target, with the upper-case power name (for example `ARENA_SEAT_CREDENTIAL_FRANCE`); the same rules (2.2.0, K6). |
| Diplomacy episode secrets | env `ARENA_DIP_SECRET_<n>` | One per episode index `n` = 0..count-1 (decimal, no leading zero; 2.10.0: count ≤ 50, so `n` ≤ 49, rule M10), each exactly 64 lower-case hex characters, backed by secret references. The runner requires exactly `episode_secret_commitments.count` of them, checks them as in §4, and deletes them on load. A missing, extra, malformed or mismatching secret is `hosted_context_invalid` (`detail.field: episode_secret_commitments`). |

The hosted runner takes the run manifest and the RunSpec **only** from those two files. There is no environment form
of either document (§3.1.2). The local CLI never reads `ARENA_DIP_SECRET_*`: a local episode secret is always empty
(security review G-38).

**Job-template variables (2.6.0).** These are the same for every run of a promoted image, so they are part of the fixed
job template and are never overrides. They are not secret.

| Variable | Required | Rules |
|---|---|---|
| `ARENA_IMAGE_DIGEST` | **yes** | `<index digest>,<platform manifest digest>` of the image the job pulled, each `sha256:` plus 64 lower-case hex characters, with no spaces. `<index>` is the digest the container image is pinned by (`ghcr.io/rbrus/agent-arena@<index>`, `IMAGE_DIGEST` in sandbox `verify.sh`), and `<platform manifest>` is the manifest of the platform actually run. The runner parses the value as 1 to 8 comma-separated digests; it MAY ignore spaces around an entry and empty entries. It requires **both** `image_digest.index` and `image_digest.platform_manifest` of the manifest to be in the list, and `image_digest.platform` to be the running platform. An absent, empty or malformed value, a digest that is not in the list, or another platform is `hosted_context_invalid`, with `detail.field` `/image_digest` (absent or malformed), `/image_digest/index`, `/image_digest/platform_manifest` or `/image_digest/platform`. |
| `ARENA_PACKS_DIR` | when `packs` is not empty | The path (absolute in the job template) of the read-only directory where the control plane mounted the fetched packs (§11.2). The runner ignores it when `packs` is empty, and refuses a manifest listing packs without it (`scenario_pack_unavailable`). |
| `NODE_OPTIONS` | no | May be present only if it is **empty**: the template sets `NODE_OPTIONS=""` for process hygiene. A non-empty value is refused (§3.1.1). |
| `ARENA_HOSTED` | no | `1` in the job template. (2.7.0) **Read**: it restricts the CLI to `run --hosted`, `verify --hosted-seal` and `version`. Presence counts, whatever the value. Any other command (a local `run`, `run` without `--hosted`, `verify` without `--hosted-seal`, `replay`, `list-scenarios`, `serve-reference`, `target`, `help`, an unknown command or none) exits 3 with `hosted_mode_only` (errors.md §1d) before anything is parsed or read, and the sandbox arena server refuses to start. It is the in-process twin of the job template's command pin: a hosted image started with another command runs nothing. Until 2.6.0 this row said "informational; not read". |

### 3.1.1 Variables that MUST be absent (2.6.0, normative)

The runner first takes and deletes every secret variable of §3.1 (so a refusal never leaves a credential in the
process), and then refuses to start if any variable below is present. It refuses with `hosted_context_invalid` before
any I/O, naming the variables and never their values. `detail.field` is given per row. The list is closed: adding a
variable to it is additive, and removing one needs a MINOR with a security review. `fixtures/hosted_env.json` holds
the same list for implementation tests. (2.7.0) §3.1.3 adds a rule over whole name families on top of this list.

| Variable | `detail.field` | Why it is refused |
|---|---|---|
| `AGENT_ARENA_SECRETS_DIR` | `environment` | Local secret files are not a hosted credential source. The only one is `env:ARENA_TARGET_CREDENTIAL`. |
| `ARENA_DEBUG` | `environment` | The diagnostics override is not available to the hosted runner. |
| `NODE_OPTIONS` (non-empty) | `environment` | Node options (preloads, the inspector, reports) could run code or write outside `/out`. An empty value is allowed. |
| `NODE_DEBUG` | `environment` | Node core debug logging could print request data. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `environment` | Certificate validation cannot be relaxed in hosted mode, whatever the value. |
| `NODE_EXTRA_CA_CERTS` | `environment` | The TLS trust store cannot be extended in hosted mode. |
| `SSLKEYLOGFILE` | `environment` | TLS key logging would expose the session keys of the target connection. |
| `NODE_V8_COVERAGE` | `environment` | Coverage output is written outside `/out`. |
| `WOT_CONTRACTS_DIR` | `environment` | The contract schemas are the ones this build was released with. |
| `ARENA_HOSTED_CONTEXT` | `manifest_source` | Not an input: the run manifest is the `--manifest` file. |
| `ARENA_RUN_SPEC` | `manifest_source` | Not an input: the RunSpec is the `--run-spec` file. |
| `ARENA_EPISODE_SECRETS` | `episode_secret_commitments` | Not a contract variable. The episode secrets are `ARENA_DIP_SECRET_<n>` (2.5.0). It is taken and deleted like a secret, then refused. |
| `ARENA_DIP_SECRET_<x>` where `<x>` is not a canonical index | `episode_secret_commitments` | `<n>` is decimal with no leading zero (`ARENA_DIP_SECRET_01` is malformed). It is taken and deleted, then refused. |

Presence is what counts: a variable in this table with an empty value is still refused, except `NODE_OPTIONS`. Node
runtime diagnostics given as command-line flags (`--inspect`, `--cpu-prof`, `--heap-prof`, `--report-*` and similar)
are refused in the same way (`detail.field: /`).

### 3.1.2 Variables that MUST be absent for a given manifest (2.6.0, normative)

These are refused after the manifest is verified, because whether they may be present depends on it. Each has already
been taken and deleted, so it is never used.

| Variable | Absent when | Refusal |
|---|---|---|
| `ARENA_TARGET_CREDENTIAL` | `credential_mode` is `none` | `hosted_context_invalid` (`/credential_mode`) |
| `ARENA_SEAT_CREDENTIAL_<POWER>` | the RunSpec has no `seats[]` target | `hosted_context_invalid` (`/credential_mode`) |
| `ARENA_DIP_SECRET_<n>` | the scenario is not in the Diplomacy family; or `n` ≥ `episode_secret_commitments.count` | `hosted_context_invalid` (`episode_secret_commitments`) |

**Erratum (2.5.0).** `threat-model-hosted.md` §3.3 calls the credential variable `ARENA_TARGET_AUTH`. The contract name
is, and has been since 2.2.0, `ARENA_TARGET_CREDENTIAL`, and no variable named `ARENA_TARGET_AUTH` exists. The threat
model text is corrected by its owner.

### 3.1.3 Guarded name families (2.7.0, normative)

On top of the closed lists of §3.1.1 and §3.1.2, the runner refuses every variable in a name family that can change what
the runtime trusts, loads or writes, unless this section or §3.1 names it. The families are names that start with
`ARENA_`, `NODE_`, `SSL` or `OPENSSL`, and proxy variables (`http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`,
`ftp_proxy`, `grpc_proxy`, `ws_proxy`, `wss_proxy`). Matching ignores case. A family variable is accepted only when it is:

- a job-template variable of §3.1 (`ARENA_IMAGE_DIGEST`, `ARENA_PACKS_DIR`, `ARENA_HOSTED`, `NODE_OPTIONS` with an empty
  value);
- a per-run secret variable of §3.1 (`ARENA_TARGET_CREDENTIAL`, `ARENA_SEAT_CREDENTIAL_<POWER>`, `ARENA_DIP_SECRET_<n>`);
- set by the runner image or its Node base image and without effect on the runner: `NODE_ENV` with the value
  `production` only, `NODE_VERSION`, `YARN_VERSION`;
- (2.15.0) set by the runner's distroless Node base image to its own CA bundle: `SSL_CERT_FILE` with the value
  `/etc/ssl/certs/ca-certificates.crt` only. That path is inside a read-only image layer, so the variable names the trust
  store the image was released with and cannot point the runtime at another one. Any other value, and every other
  trust-store variable (`SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`), is refused.

A variable in the tables of §3.1.1 is refused with its own `detail.field`. Every other refusal here is
`hosted_context_invalid` with `detail.field: environment`, before any I/O, naming the variables and never their values.
Examples: `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`, `NODE_COMPILE_CACHE`, an `SSL_CERT_FILE` with any other value, `SSL_CERT_DIR`,
`OPENSSL_CONF`, `OPENSSL_MODULES`, `HTTPS_PROXY`, and a `NODE_ENV` other than `production`. Variables outside the
families (`HOME`, `PATH`, …) are not examined. `fixtures/hosted_env.json` `guarded_families` holds the same rule with
test cases. Adding a name to the accepted set needs a MINOR with a security review; narrowing it is additive.

### 3.2 Hosted admission (2.7.0, normative for the control plane)

The control plane admits a run, then writes and signs the manifest. The runner checks the same things again before
any I/O. The two lists below are the same rules, so a run the control plane admits is never refused by the runner for
a reason the control plane could have seen. A refusal at admission is the control-plane code of errors.md §1d; the
runner's refusal of the same thing, later, is the code in the last column. The control plane MUST NOT sign a manifest
that breaks any rule of this section.

**The RunSpec target (one target).**

| # | Rule | Runner refusal |
|---|---|---|
| A1 | `target.url` has no userinfo, no query and no fragment. A bare `?` or `#` counts, whatever the parsed URL says. (G-46: the RunSpec is signed and recorded byte-for-byte in the report and the bundle, so a credential there would be sealed. Credentials travel only as `ARENA_TARGET_CREDENTIAL`.) Stricter than the local CLI: there is no `--allow-query-secret` equivalent. | `run_spec_invalid` (`target.url`) |
| A2 | The scheme is `https:` for `rest`, `mcp` and `a2a`, and `wss:` for `ws`. | `run_spec_invalid` (`target.url`) |
| A3 | The origin of `target.url` (scheme, host, port) is exactly `verified_origin.origin`, and that origin is exactly the `egress_allowlist` entry with `role: target`. The host has a current ownership proof (`verified_origin.checked_at` at most 24 h old at run start). | `hosted_context_invalid` (`/verified_origin/origin`, `/egress_allowlist`, `/verified_origin/checked_at`) |
| A4 | No `seats[]` in a single-target profile. A RunSpec with `seats[]` is admitted only for a multi-target table profile, and this runner build refuses every such RunSpec (`run_spec_invalid`, `seats`) until the table runner ships. So today the control plane admits none. | `run_spec_invalid` (`seats`) |
| A5 | No `recorded_peer` seat and no LLM-peer pack until K7 lands (HOSTED-PROFILE §5.7). | `run_spec_invalid` (`seats`) |
| A6 | (2.10.0) `budget_tier: extended` ⇒ `episodes` = 1 (and so exactly one seed), for every `credential_mode`. The tier's Dh is 30 s: one Diplomacy episode at horizon 1908 (103 ticks) can take about 51.5 minutes, and a `sixi_run_token` run ends within 55 minutes of minting (C3), so a second episode cannot fit. The cap holds until a run-token refresh path is specified. At admission the control plane refuses with `plan_limit_exceeded`, `detail.limit` `extended_episodes_per_run`, whatever the plan. C3 still applies: an `extended` episode of another scenario can take up to 120 × 30 s = 60 minutes, so the deadline may end it (`deadline_exceeded`, no report). | `run_spec_invalid` (`episodes`) |

**Credential mode consistency.**

| # | Rule | Runner refusal |
|---|---|---|
| C1 | `credential_mode: none`: the RunSpec has no `target.auth`, and the job delivers no `ARENA_TARGET_CREDENTIAL`. | `run_spec_invalid` (`target.auth`); `hosted_context_invalid` (`/credential_mode`) |
| C2 | Any other `credential_mode`: `target.auth.ref` is exactly `env:ARENA_TARGET_CREDENTIAL`, a `header` scheme names a valid, non-hop-by-hop, non-arena header, and the job delivers a non-empty `ARENA_TARGET_CREDENTIAL` from a per-run secret reference (§3.1). | `run_spec_invalid` (`target.auth`, `target.auth.ref`, `target.auth.header_name`); `hosted_context_invalid` (`/credential_mode`) |
| C3 | `credential_mode: sixi_run_token`: the token follows §10, including the lifetime of at most 1 h. So `wall_clock_deadline` is at most 55 minutes after the token's `iat` (the minting rule `exp` ≤ min(deadline + 5 min, `iat` + 3600) must be satisfiable). A longer run cannot use this mode. | the target's `401 invalid_token` (errors.md §1e) |
| C4 | No `ARENA_SEAT_CREDENTIAL_<POWER>` without a `seats[]` target (§3.1.2). | `hosted_context_invalid` (`/credential_mode`) |

**The manifest and the job.**

| # | Rule | Runner refusal |
|---|---|---|
| M1 | `issued_at` is the admission time. The runner refuses a manifest issued more than 5 minutes in its future, or more than 24 h before it starts. | `hosted_context_invalid` (`/issued_at`) |
| M2 | `wall_clock_deadline` is after `issued_at`, at most `issued_at` + the plan cap, and never more than 48 h after `issued_at`. A deadline that has passed at start is refused. | `hosted_context_invalid` (`/wall_clock_deadline`) |
| M3 | The manifest is signed with a key of the control-plane key set the release pins, named by `kid`, and that key id differs from the report key id (§2). (2.11.0) The key is in the `manifest` set pinned by the release whose image the manifest names, and its window covers `issued_at` (§3.3 rules 3 and 4); a key outside its window is refused like an unpinned one. | `hosted_context_invalid` (`/signing`, `/signing/signing_key_id`, `/signing/signature`) |
| M4 | `image_digest` names an image **promoted** by the release process, and the latest cross-check record for that image and its `engine_build_hash` has `job_verdict: pass` (CROSSCHECK.md). Otherwise the control plane holds new runs (`crosscheck_hold`). The job pulls that image by its index digest and sets `ARENA_IMAGE_DIGEST` to the index and platform-manifest digests actually run (§3.1). | `hosted_context_invalid` (`/image_digest`, `/image_digest/index`, `/image_digest/platform_manifest`, `/image_digest/platform`, `/engine_build_hash`) |
| M5 | The job template sets exactly the variables of §3.1: `ARENA_HOSTED=1`, `ARENA_IMAGE_DIGEST`, `ARENA_PACKS_DIR` when `packs` is not empty, `NODE_OPTIONS=""`, and the per-run secret references. Nothing of §3.1.1 and no other variable of the §3.1.3 families. | `hosted_context_invalid` (`environment`, `manifest_source`, `episode_secret_commitments`) |
| M6 | The job runs `agent-arena run --hosted --manifest <file> --run-spec <file> --out /out`, optionally with `--json`, and with `--manifest-key` only while the release pins no manifest key set (a release that pins one refuses the flag; 2.11.0: every open release pins one, §3.3 rule 2). No other flag. The manifest and RunSpec files are regular files on the run's read-only prefix, within their caps (§3.1). | `hosted_context_invalid` (`manifest_source`, `--manifest`, `--run-spec`, and 2.11.0 `--manifest-key`); any other flag is refused by name, exit 3 |
| M7 | A Diplomacy-family run commits to exactly one episode secret per episode, and the job delivers exactly those secrets as `ARENA_DIP_SECRET_<n>`. Any other scenario commits to none and receives none (§3.1.2, §4). | `hosted_context_invalid` (`episode_secret_commitments`) |
| M8 | Every listed pack is entitled, mounted under `ARENA_PACKS_DIR`, and signed as in §11. | `pack_not_entitled` at admission; `scenario_pack_unavailable` or `pack_engine_mismatch` at the runner |
| M9 | (2.9.0) `region` is one of the twelve regions of the `hosted_context.region` enum: `europe-central2`, `europe-north1`, `europe-north2`, `europe-southwest1`, `europe-west1`, `europe-west10`, `europe-west12`, `europe-west3`, `europe-west4`, `europe-west6`, `europe-west8`, `europe-west9` (the regions in EU member states, plus `europe-west6`, Zürich). `europe-west2` (London) and every region outside the EU and Switzerland are refused. The list is explicit because a `europe-` prefix is not a residency boundary. The control plane refuses to start with a region outside the list, so it never signs one. The report, the evidence report and the deletion receipt carry the same enum, so a sealed document cannot name another region either. Adding a region is a contract MINOR that changes every copy at once. | `hosted_context_invalid` (`/region`) |
| M10 | (2.10.0, OQ-18) A run of a Diplomacy-family scenario (`diplomacy_standard`, or an `sx_` scenario whose base is `diplomacy_standard`) has `episodes` ≤ 50, and `episode_secret_commitments.count` equals `episodes` (the schema caps `count` at 50). Hosted only: the open CLI keeps the RunSpec limit of 1000. The cap comes from the per-episode secret delivery of §3.1.2: every episode adds one version to the run's secret, and the secret store's version-add rate per secret is the binding limit, taken with 2x headroom. At admission the control plane refuses with `plan_limit_exceeded`, `detail` `{limit: "diplomacy_episodes_per_run", value: <episodes>, plan: <plan>}`, with a maximum of 50 whatever the plan. It composes with A6: an `extended` run plays 1 episode, a Diplomacy-family run at another tier at most 50. | `hosted_context_invalid` (`episode_secret_commitments`) |

**The seal step (§3 rule 2).** It runs `agent-arena verify --hosted-seal /out` with the pinned manifest key set (§3.3) and
`--expect-manifest-digest <the digest the control plane issued>`, and signs only after exit 0.

The table order is not the order in which the runner checks. Every runner refusal names fields, never values, and never the target origin (G-45).

### 3.3 The pinned key set (2.11.0, normative)

Sixi never rebuilds the runner image (§3.1), so the keys the runner trusts ship **in** the open release. The bundled file
is `pinned_keys.schema.json` (`wot:pinned_keys:1`, `format: agent-arena-pinned-keys/1`); the CLI ships it as
`packages/arena-cli/src/hosted/pinned-keys.json`. The file, and nothing supplied at run time, is the trust anchor
(SIXI-INTEGRATION OQ-3; SECURITY-REVIEW-HOSTED S-1; Sixi review condition A8). "The pinned control-plane key set" in §3,
§3.2 M3 and M6, §5.1 and §11 means the `manifest` set of this file.

**Rule 1 — what is pinned.**

- Every open release bundles two sets, `manifest` and `report`: the bodies the control plane serves at
  `<source>?purpose=manifest` and `<source>?purpose=report`. The published JWKS is
  `https://sixi.ch/.well-known/arena-jwks.json` (HOSTED-PROFILE §3.1, Q12).
- **Public keys only.** Each key is `kty: OKP`, `crv: Ed25519`, `x` (32 bytes, canonical unpadded base64url), `kid`
  matching `^[a-z0-9][a-z0-9._-]{2,63}$`, `use: sig`, `not_before`, `not_after`, and `revoked_at` when the key is revoked.
  The three times are RFC 3339 UTC with seconds and `Z`. Optional, as served: `alg: EdDSA`, `sixi_purpose` (equal to
  the set), `status` (`next`, `current`, `valid` or `retired`; informational, it never widens or narrows the window) and
  `sixi_thumbprint`. No other member is allowed. A key holding `d`, or any other private member, makes the file invalid.
- **Kid derivation.** A pinned kid is `<namespace>-ed25519-` followed by the first 80 bits (10 bytes) of the key's
  RFC 7638 thumbprint, in lower-case hex. The thumbprint is SHA-256 over `{"crv":"Ed25519","kty":"OKP","x":"<x>"}`. The
  namespace is `sixi-arena-manifest` for the manifest set and `sixi-arena` for the report set. The run-token key uses
  `sixi-arena-runtoken` and is never pinned. `sixi_thumbprint`, when present, is the full thumbprint in base64url. Anyone
  holding a key can recompute its kid. The kids in examples and test vectors (`sixi-arena-ed25519-20261101`, keys from
  RFC 8032) are not derived. They never appear in a pinned set.
- **Stored as served.** Each set records `source` (the file's `source` plus `?purpose=<set>`) and `source_sha256`, the
  sha256 of the served body. Its `keys` array reproduces that body: `UTF-8(JSON.stringify({"keys": keys}) + LF)` hashes
  to `source_sha256`, with the keys and their members in the served order. The file records `source` (the JWKS URL
  without a query) and `fetched_at`. `source_etag`, the top-level `source_sha256` (the unfiltered body, which also lists
  the run-token key) and `note` are informative.
- **Limits.** Each set holds 1 to 16 keys. Kids are unique across the file, so the manifest and report kid namespaces
  are disjoint (§2). No public key appears in both sets: one key per purpose. Each window has
  `0 < not_after − not_before ≤ 120 days`, and `revoked_at`, when set, is not before `not_before`. The file is at most
  65536 bytes.
- **The run-token key is not bundled.** A run-token verifier (`serve-reference --hosted --run-token-key`, or a customer
  endpoint) takes it as configuration (§10). A file with a third set is invalid.

`tools/contract-check.mjs` §15 checks all of rule 1 on the schema example and on the file the CLI bundles.

**Rule 2 — use.**

- The `manifest` set is the **only** trust anchor for run manifests (§3 rule 1, §3.2 M3) and scenario packs (§11.1,
  §11.3 step 5). The `report` set is the set `verify --key pinned` selects from (rule 5).
- A release that pins a manifest set refuses `--manifest-key` (M6). This holds for `run --hosted`, `verify --hosted` and
  `verify --hosted-seal` alike: job arguments can never replace or extend the trust anchor. The refusal is
  `hosted_context_invalid` (`--manifest-key`), exit 3. `--manifest-key` exists only for a build that pins no set, and
  then only with kid-bound keys.
- The runner never fetches keys. It takes no key from a manifest, a pack, a token header or the environment, and follows
  no key URL.
- A malformed bundled file refuses every hosted verification. There is no fallback to another key source.

**Rule 3 — the window.** A pinned key verifies a document only when `not_before ≤ t < not_after`, and `t < revoked_at`
when `revoked_at` is set. `t` is the document's signing time, a signed member of the document:

| Document | `t` |
|---|---|
| Run manifest (`hosted_context`) | its `issued_at` |
| Report, `report.json.dsse.json`, `report.sarif.dsse.json`, `bundle-manifest.json.dsse.json` (the evidence report is covered by the bundle manifest) | the report's `signing.sealed_at` |
| Cross-check record | its `finished_at` |
| Deletion receipt | its `purged_at` |
| Scenario pack (`pack.dsse.json`) | the `issued_at` of the verified run manifest that lists the pack (Packs, below) |

- Only the pinned key named by the document's kid is tried. Every pinned key has a kid.
- A missing or unparsable `t` is outside every window.
- **Outside the window**, the document is refused exactly like one signed by an unpinned kid:
  - a manifest is `hosted_context_invalid` (`/signing/signing_key_id`), exit 3, and nothing is sent;
  - a report or one of its envelopes is `signature_invalid`, exit 2;
  - a pack is `scenario_pack_unavailable` (§11.3 step 5).
  The refusal names the kid and the two times, never key material.
- M1 refuses a manifest issued more than 24 h before the runner starts. So a manifest signed at the last second of its
  key's window is usable at most 24 h past `not_after`, and no later.

**Packs.** Neither the DSSE envelope nor `pack_manifest.schema.json` carries a signing time. So the window of a pack
signature is evaluated at `t` = the `issued_at` of the run manifest that lists the pack. The manifest key vouches for that
time, and M1 binds it to the runner's clock. A pack signature verifies only with a pinned manifest-set key whose window
covers the run's `issued_at`. This is a decision, not a gap:

- A pack is reused across many runs, and the question each run asks is whether the key is trusted now. A publication
  time would answer when it was signed. With a publication time, a pack signed before a revocation would stay loadable
  after it.
- To stay loadable across a rotation, a pack needs at least one of its 1 to 4 signatures (§11.1) made with a key whose
  window covers new runs. The pack store adds a signature with the successor key before the current key's `not_after`.
  That is a new envelope, so a new `packs[].digest`, which the control plane pins in the next manifest.
- The control plane MUST NOT list a pack in a manifest when none of the pack's signatures is by a pinned key whose
  window covers that manifest's `issued_at`.
- A later signed publication time in the pack manifest would be informative only. It would not replace this rule.

**Rule 4 — rotation.**

- A key signs for at most 90 days, and then verifies for at most 30 days of overlap: a window of at most 120 days.
- A new manifest or report key MUST be in the pinned set of a **promoted** open release before the control plane signs
  anything with it. Promoted means an image promoted by the release process, with a green cross-check (M4). That release
  MUST be promoted before the current key's `not_after`. So there is at least one promoted open release per quarter
  (OQ-3).
- The control plane signs a manifest only with a key pinned by the release whose image the manifest names
  (`image_digest`), inside that key's window at `issued_at` (M3). With no such key it admits no run: it never signs with
  a key the runner does not pin.
- Manifest and report keys stay in the published JWKS after they retire, with `revoked_at` when revoked, so later
  releases keep verifying older documents. When a set would exceed 16 keys, the release drops the keys with the
  earliest `not_after`.
- **Revocation** reaches a runner only through a release that pins `revoked_at`. On revocation the control plane stops
  signing with the key at once. It SHOULD stop admitting runs on images whose pinned set lists the key without
  `revoked_at`.

**Rule 5 — `verify --key pinned`.**

- The literal value `pinned` of `--key` selects this release's `report` set. A key file named `pinned` is passed as
  `./pinned`.
- The key is the one whose kid equals `signing.signing_key_id`, under rule 3 at `t` = `signing.sealed_at`.
  - A kid this release does not pin is `signature_invalid`, exit 2. That includes a manifest kid, since the namespaces
    are disjoint.
  - A pinned kid outside its window is `signature_invalid`, exit 2.
  - A report without a `signing` block is `signature_invalid`, exit 2.
- The rule is the same for `verify --hosted --key pinned` and `verify --hosted-seal <bundle> --key pinned`. The three
  envelopes are checked with the same key at the same `t`. The run manifest beside the report is checked with the
  pinned `manifest` set at its `issued_at` (rule 2: `--manifest-key` is refused).
- **Older documents.** A report sealed under a key that the current release no longer pins has two routes: verify it
  with the release that was current when it was sealed, or pass the report key explicitly (`--key <PEM | OKP JWK |
  JWKS>`, taken from the published JWKS, which keeps retired keys). A key passed explicitly carries no window in the
  CLI: the person running `verify` chose it. A manifest has only the first route, because a pinning release refuses
  `--manifest-key`.

## 4. Diplomacy episode secrets (K4)

Per episode the control plane draws a 256-bit secret. Before the run, only commitments exist:

```
episode_secret             = 64 lower-case hex characters
episode_secret_commitment  = "sha256:" + hex( sha256( UTF-8( "wot-dip/secret-commit|" + episode_secret ) ) )
manifest.episode_secret_commitments.digest = "sha256:" + hex( sha256( JCS( [commitment_0, …, commitment_n-1] ) ) )
```

The runner receives the secrets as `ARENA_DIP_SECRET_<n>` (§3.1) and checks each against its commitment before any
I/O. After the whole run is terminal, each EpisodeResult discloses `diplomacy.episode_secret` and
`diplomacy.episode_secret_commitment`. `verify --hosted` checks every secret against its commitment and
the commitment list against the manifest, then recomputes codewords, `transcript_hash` and
`intent_leak`. A hosted report with a Diplomacy-family episode lacking either field is schema-invalid.

## 5. Detached envelopes (`report.sarif`, `bundle-manifest.json`)

These two files carry no signing block. Their DSSE envelopes sign the **exact file bytes** as written (2.11.0: directly,
or through a digest statement over those bytes, §5.2)
(HOSTED-PROFILE §3.1): `report.sarif` is byte-compared with a re-render of the verified report, and
`bundle-manifest.json` (`bundle_manifest.schema.json`) lists the sha256 and size of every other bundle
file, including `run-manifest.json` and the evidence report, so one signature covers them all. (2.12.0) The evidence
report does not list `bundle-manifest.json` in turn (§5.3).

### 5.1 The hosted bundle and `verify --hosted-seal` (2.6.0)

The layout below is what the runner writes to `/out` and what the seal step adds. `agent-arena verify --hosted-seal
<bundle dir | report.json>` checks it. `bundle_manifest.schema.json` is the list of files the seal signs.

| Path | Written by | In `bundle-manifest.json` | Covered by |
|---|---|---|---|
| `report.json` | runner, unsigned; the seal step adds `signing` (§3 rule 3) | yes, sealed bytes | its `signing` block and `report.json.dsse.json` |
| `report.sarif` | runner; the seal step never rewrites it | yes | `report.sarif.dsse.json` |
| `run-manifest.json` | runner: a byte-for-byte copy of the `--manifest` file | yes | the bundle manifest; its own control-plane signature (§3) |
| `episodes/<n>.record.json` | runner, for every episode | yes | the bundle manifest |
| `episodes/<n>.replay.json` | runner, for every episode; equals the EpisodeResult `replay_ref` | yes | the bundle manifest |
| `evidence.json`, `evidence.html` | seal step, optional; (2.12.0) rendered after `report.json` and `report.sarif` are signed and before `bundle-manifest.json` is written (§5.3) | yes, when present | the bundle manifest |
| `report.json.dsse.json` | seal step | no | itself (§2: payload = the JCS body, `sig` byte-identical to `signing.signature`) |
| `report.sarif.dsse.json` | seal step | no | itself (§5: payload = the exact `report.sarif` bytes) |
| `bundle-manifest.json` | seal step, written last but one | no | `bundle-manifest.json.dsse.json` |
| `bundle-manifest.json.dsse.json` | seal step, written last | no | itself (§5: payload = the exact `bundle-manifest.json` bytes) |

`<n>` is the 0-based episode index in the Report's `episodes` order, in decimal with no leading zero (as in
`ARENA_DIP_SECRET_<n>`). No other file belongs to the bundle.

**Pre-seal (`report.json` has no `signing`; no key is needed).** The seal step's verifier job runs this, and it is the
seal precondition (§3 rule 2). The bundle passes only if every rule below holds and the re-simulation verifies:

1. Hosted invariants: `run.mode` is `hosted`, `run.hosted` is present, `run.target_ownership.source` is `sixi_verified`,
   and `not_assessed` lists `robustness.seed_recovery` with `seed_recovery_not_modelled`.
2. `run.hosted.run_manifest.path` is `run-manifest.json`, and that file is beside the report. It is schema-valid, and
   its digest (§3) equals `run.hosted.run_manifest.digest`. Its `signing.signing_key_id` equals
   `run.hosted.run_manifest.signing_key_id`. Its signature verifies against the pinned manifest set at its `issued_at`
   (2.11.0, §3.3), or, in a build that pins no set, against `--manifest-key`.
3. `run.hosted` equals the manifest fields of §3 rule 3. `run.run_id` equals the manifest's `run_id`, the digest of the
   RunSpec in `run.spec` equals `run_spec_digest`, and the RunSpec target is on `verified_origin.origin` (exact scheme,
   host and port).
4. `report.sarif` is beside the report. Its `runs[0].properties.agentArena.signing_key_id` equals
   `run.hosted.signing_key_id`, its `run_id` equals the report's, and its bytes equal the SARIF re-rendered from
   `report.json`.
5. Diplomacy: every episode discloses its secret and commitment, each secret hashes to its commitment, and the
   commitment list has `count` entries and hashes to `episode_secret_commitments.digest` (§4). A manifest with
   commitments and a report without Diplomacy episodes, or the reverse, fails.
6. Every episode re-simulates to the recorded result, and every `episodes/<n>.replay.json` equals the replay regenerated
   from its record.

**Sealed (`report.json` has `signing`; the report key is required: `--key pinned` for the release's pinned report set, §3.3 rule 5, or `--key <key>`).** All the pre-seal rules, with the kid
comparisons made against `signing.signing_key_id`, plus:

7. `signing.signing_key_id` = `run.hosted.signing_key_id` = the SARIF `signing_key_id` = the `keyid` of every
   envelope, and `signing.run_manifest_digest` = `run.hosted.run_manifest.digest`.
8. Each of the three envelopes is a DSSE envelope with **exactly one** signature, the payload type of §2, a payload
   byte-equal to what it signs, and an Ed25519 signature that verifies over `PAE(payloadType, payload)` with the report
   key. (2.11.0) Or, in the digest-statement form of §5.2, the statement payload type and a statement that names the
   file's exact length and sha256 (steps D1 to D9, E1 to E4). A raw envelope whose PAE message is over
   `ARENA_SIGN_MAX_MESSAGE_BYTES` is refused. An envelope file is at most twice its payload plus 65536 bytes.
9. `bundle-manifest.json` is at most 1048576 bytes and is schema-valid. Its `run_id` and `signing_key_id` equal the
   report's, and its `files` are unique and sorted by path in byte order. It lists `report.json`, `report.sarif`,
   `run-manifest.json`, and both episode files of every episode the report references. Every listed file exists
   inside the bundle (no symbolic link, no path outside it) and matches its `sha256` and `bytes`.

**Exit codes.** `0` verified; `1` mismatch (the SARIF re-render differs, a Diplomacy commitment does not match, or the
re-simulation disagrees); `2` a seal, invariant or signature problem (`signature_invalid`: the evidence cannot be
trusted as sealed); `3` misuse (a sealed bundle without `--key`, `--hosted-seal` together with `--hosted`, or an `sx_`
report, which this CLI cannot re-simulate, or a report naming an engine build this CLI does not have).

#### 5.1.1 `--result <path>`: the result as a file (2.12.0, normative)

The seal step's verifier job (HOSTED-PROFILE §2.7) needs the outcome as a file: its stdout goes to logs, and a job's
exit status is not evidence. `agent-arena verify --hosted-seal <bundle> --result <path>` therefore also writes the
result to `<path>`.

1. **Content.** The file is byte-identical to the document `--json` prints on stdout (2-space JSON, redacted, inert,
   LF-terminated), whether or not `--json` is given. `--result` does not change stdout. The document validates against
   `verify_result.schema.json` (`wot:verify_result:1`, at most 8388608 bytes).
2. **Every outcome the verification reaches.** The file is written for exit `0` (`verified`), `1` (`mismatch`) and `2`
   (`unverifiable`: a seal, invariant or signature problem, or an unreadable report). For exit `3` it is written once
   the path has been accepted (rule 3): a misuse found afterwards is written as
   `{"ok":false,"status":"misuse","exitCode":3,"errors":[<the one refusal message>],"signed_forms":{}}`, and
   `unsupported_engine` is written as a full result. `exitCode` always equals the process exit code.
3. **The path.** The `--manifest-key` refusal (§3.3 rule 2) comes first. Then, before the bundle is read, the path must
   not exist, must not be a symbolic link, must have an existing directory as its parent, and must be outside the bundle
   directory (the result is not a bundle file; see "No other file belongs to the bundle" above). Otherwise the exit is
   `3` and nothing is written. The file is created create-only (`O_EXCL | O_NOFOLLOW`) and synced before the process
   exits.
4. **Write failure.** A failure to create or fully write the file after the verification is exit `2` with the message
   prefix `result_not_written` (errors.md §1d), whatever the verification said, and a partly written file is removed.
   So no file means that the verifier did not finish.
5. **Only with `--hosted-seal`.** `--result` on any other `verify` is exit `3`.
6. **The seal precondition** (§3 rule 2) is read from this file: `exitCode` `0`, `status` `verified`,
   `hosted_seal.sarif_equal` `true`, `hosted_seal.seal` empty and `hosted_seal.mismatch` empty. The seal step reads the
   file with the 8388608-byte cap and validates it against the schema. No file, a larger file, or one that is not JSON or
   fails the schema is `seal_failed` with the reason `verify_no_result`.

### 5.2 Signed digest statements (2.11.0, normative)

Sixi keys live in Cloud KMS. For an Ed25519 key (`EC_SIGN_ED25519`, SOFTWARE protection level, `europe-west6`),
`asymmetricSign` accepts at most 65536 bytes of raw data. This was measured in production: 64 KiB is signed and 65 KiB is
refused (`deploy/arena/kms-cap-probe.sh`, sixi-scanner PR 6). Pure Ed25519 signs the whole message, and a hosted
Diplomacy report's JCS body is about 5.6 KiB plus 3.8 KiB per episode: about 192 KiB at the M10 cap of 50 episodes, and
3.7 MiB at 1000 episodes. So a large payload is signed through a small **digest statement** instead.

**The constant.** `ARENA_SIGN_MAX_MESSAGE_BYTES = 65536`. It is the largest DSSE PAE message (§2: `PAE(payload_type,
body)`, header included) that a Sixi key signs directly. The Sixi control plane's `SIXI_ARENA_KMS_SIGN_MAX_BYTES` maps to
it and MUST NOT exceed it. Today the two are equal. A lower Sixi value only makes the statement form more frequent, which
is always allowed.

**Two forms.**

| Form | The key signs | Allowed |
|---|---|---|
| **raw** (2.2.0, unchanged) | `PAE(T, P)`: `T` is the document's payload type (§2), `P` is the covered bytes | only while `len(PAE(T, P))` ≤ `ARENA_SIGN_MAX_MESSAGE_BYTES` |
| **digest statement** | `PAE("application/vnd.sixi.arena-digest-statement+json", JCS(S without /signing/signature))`, where `S` is the statement below | at any size, and **mandatory** above the threshold |

`P`, the covered bytes, is the JCS body (§1) for `report.json` and for a cross-check record, and the exact file bytes for
`report.sarif` and `bundle-manifest.json` (§5). A raw signature over a message longer than the threshold is refused even
when it verifies. A conforming sealer cannot produce one, and refusing it gives each large document a single valid form.

**The statement** (`digest_statement.schema.json`, `wot:digest_statement:1`) is a signed document in the sense of §1
and §2:

```
S = { "statement_version": "1.0",
      "subject": { "payload_type": T, "sha256": "sha256:" + hex(sha256(P)), "bytes": len(P) },
      "run_id": <report run.run_id>,                         seal outputs only
      "run_manifest_digest": <report signing.run_manifest_digest>,   seal outputs only
      "signing": { "algorithm": "ed25519", "signing_key_id": <kid>, "canonicalization": "jcs-rfc8785",
                   "payload_type": "application/vnd.sixi.arena-digest-statement+json",
                   "excluded": ["/signing/signature"], "sealed_at": <t>, "signature": <base64 sig> } }
```

- **Scope.** `subject.payload_type` is one of four types:
  - the report, `report.sarif` and `bundle-manifest.json`: the seal outputs. These carry `run_id` and
    `run_manifest_digest`, and `sealed_at` is the report's `signing.sealed_at`;
  - the cross-check record. It carries no run binding, and `sealed_at` is its `finished_at`.
- **Always raw.** The run manifest and the deletion receipt stay raw: their 8192-byte caps keep them under the
  threshold.
- **Packs** keep the raw form in 2.11.0. The pack store refuses to publish a pack whose PAE message is over the
  threshold, because a KMS-held key cannot sign it. The runner applies no threshold to packs. A later MINOR may extend
  this section to `pack.dsse.json`.
- **Domain separation.** Three layers keep the forms apart:
  - the statement's PAE type differs from every other payload type, so a statement signature never verifies as a
    report, SARIF, bundle, cross-check or manifest signature, and the reverse holds too;
  - `subject.payload_type` binds the covered document's own domain;
  - `subject.bytes` and `subject.sha256` bind its exact bytes.
- **Size.** A statement is under 1 KiB, so it never exceeds the threshold itself. The schema caps it at 4096 bytes.

**Where the statement lives.**

- **Detached files** (`report.sarif`, `bundle-manifest.json`). `<file>.dsse.json` carries the statement as its payload:
  - `payloadType` is the statement type;
  - `payload` is base64 of `JCS(S without /signing/signature)`;
  - `signatures[0]` is `{keyid, sig}`, with `sig` byte-identical to `S.signing.signature`.
  No other file is added to the bundle.
- **Embedded signatures** (the report, a cross-check record). The optional member `signing.signed_form` (`raw` |
  `digest_statement`; absent means `raw`) selects the form. It lies inside the signed body, so a sealed document's form
  cannot be switched. In the statement form:
  - `signing.signature` is the statement signature;
  - the statement is **derived** from the document (E2) and never stored beside it;
  - `report.json.dsse.json` carries the derived statement exactly as a detached file carries its own (payload = the
    statement's JCS body, `sig` = `signing.signature`).
- **Choosing a form.** The sealer chooses per file, and the forms can be mixed within one bundle. A small payload may use
  either form. The recommended policy is the statement form exactly when the raw message would exceed
  `SIXI_ARENA_KMS_SIGN_MAX_BYTES`.

**Verifying a detached envelope** (steps D1 to D9, in this order; `T` is the file's payload type, `B` the served bytes):

- D1. The envelope is a JSON object with exactly one signature (§5.1 rule 8), and that signature's `sig` is standard
  base64 of exactly 64 bytes. Otherwise it carries no signature that could verify: `signature` (2.12.0, clarified). If
  its `payloadType` is `T`, the form is raw: go to D2. If it is the statement type, go to D3. Any other type is refused:
  `payload_type`.
- D2. Raw form, in this order. A `payload` that is not standard base64 cannot be the file: `payload_mismatch` (2.12.0,
  clarified). `len(PAE(T, payload))` > `ARENA_SIGN_MAX_MESSAGE_BYTES` is refused: `raw_over_threshold`. A payload that
  is not byte-equal to `B` is refused: `payload_mismatch`. (2.12.0, clarified) An envelope `keyid` other than the
  report's kid is refused: `binding` (§2 key id equality, §5.1 rule 7), checked before D8. Then go to D8.
- D3. The payload is standard base64 (2.12.0, clarified: otherwise `statement_malformed`), parses as JSON and is exactly
  its JCS form. With `signing.signature` set to the envelope `sig`, it validates against `digest_statement.schema.json`.
  Otherwise: `statement_malformed`.
- D4. `subject.payload_type` = `T`. Otherwise: `subject_type`.
- D5. `subject.bytes` = `len(B)`. Otherwise: `length_mismatch`. Length is compared before the digest.
- D6. `subject.sha256` = `"sha256:" + hex(sha256(B))`. Otherwise: `digest_mismatch`.
- D7. Binding. `signing.signing_key_id` = the envelope `keyid` = the report's kid (§2 key id equality),
  `signing.sealed_at` = the report's `signing.sealed_at`, and `run_id` and `run_manifest_digest` equal the report's.
  Otherwise: `binding`.
- D8. The key is the pinned key named by the kid, and its window covers `t` = the report's `signing.sealed_at` (§3.3
  rules 3 and 5), or it is the key passed with `--key`. Otherwise: `key`.
- D9. Ed25519 verifies over `PAE(payloadType, payload)`. Otherwise: `signature`.

**Verifying an embedded signature** (E1 to E4):

- E1. `form` is `signing.signed_form`, or `raw` when absent. In the raw form, a message over the threshold is
  `raw_over_threshold`. (2.12.0, clarified) A `signed_form` other than `raw` or `digest_statement`, or
  `digest_statement` on a document of an always-raw type (the run manifest, the deletion receipt), is
  `form_mismatch`. A document without a `signing` block, or whose `signing_key_id` or `signature` (standard base64 of
  64 bytes) is missing or malformed, is `signature`.
- E2. In the statement form, the verifier derives `S` from the document:
  - `subject` = {`signing.payload_type`, the sha256 of the JCS body, its length};
  - for a report, `run_id` = `run.run_id` and `run_manifest_digest` = `signing.run_manifest_digest`;
  - `signing` = {`ed25519`, `signing.signing_key_id`, `jcs-rfc8785`, the statement type, `["/signing/signature"]`,
    `sealed_at`}, where `sealed_at` is the report's `signing.sealed_at` or the cross-check record's `finished_at`.
  The message is `PAE(statement type, JCS(S))`.
- E3. When the envelope is checked (`verify --hosted-seal`), it must pass the D1 envelope check (otherwise `signature`),
  its `payloadType` must be the one the form implies (otherwise `form_mismatch`), its payload must be standard base64
  and byte-equal to the message body (otherwise `payload_mismatch`), and its `sig` and `keyid` must equal
  `signing.signature` and `signing.signing_key_id` (otherwise `binding`).
- E4. The key and window as in D8, then Ed25519 over the message as in D9.

**Refusals.** Every refusal is `signature_invalid`: `verify --hosted` and `verify --hosted-seal` exit 2, the evidence
cannot be trusted as sealed, and the message names the reason token and the file. The tokens are `payload_type`,
`raw_over_threshold`, `payload_mismatch`, `statement_malformed`, `subject_type`, `length_mismatch`, `digest_mismatch`,
`binding`, `form_mismatch`, `key` and `signature`. The seal step does not change: a sealer that cannot sign produces no
bundle, and `seal_failed` still means only the §3 rule 2 precondition.

**Reporting the form.** `verify --hosted-seal` names the form of each signed file on its verified line. For example:
`report.json: digest statement (196608 bytes, sha256:…) verified with sixi-arena-ed25519-…`. With `--json`, the result
carries `signed_forms`, an object from bundle path to form:
`{"report.json": "digest_statement", "report.sarif": "raw", "bundle-manifest.json": "raw"}`. `verify --hosted` reports
`signed_forms` with the single member `report.json`. The evidence report can repeat the form per file
(`evidence_report` `signature.files[].signed_form`, optional). The envelope's `payloadType` stays authoritative.

**Without the CLI** (HOSTED-PROFILE §3.2, `openssl` 3.x). Decode the envelope payload. In the raw form, compare the
payload with the file. In the statement form, parse it, check `subject.bytes` and `subject.sha256` against the file (for
`report.json`, against `jq -S -c 'del(.signing.signature)'`, or better a JCS tool), and check the run binding. Then verify
the signature over `PAE(payloadType, payload)` as before.

**Test vectors.** `fixtures/digest_statement_vectors.json` holds 23 vectors (regenerate with
`node contracts/tools/digest-statement-vectors.mjs`). They are signed with the RFC 8032 TEST 1 key under the example
report kid, with the context of `report.schema.json` `examples[2]`:

- **Pairs.** `report.sarif` in the raw and statement forms (both accepted below the threshold). An 80070-byte
  `bundle-manifest.json` (`fixtures/digest_statement/bundle-manifest.json`, a schema-valid 240-episode bundle list) in
  the statement form (accepted) and the raw form (`raw_over_threshold`, although the signature verifies). The report
  embedded raw (its signature equals `signing_vectors.json` `vectors[0]`, so the raw form is byte-identical) and
  embedded as a statement. A cross-check record embedded as a statement.
- **Must-rejects.**
  - `digest_mismatch`: one byte flipped;
  - `length_mismatch`: one byte appended;
  - `subject_type`: a SARIF statement presented for the bundle manifest;
  - `signature`: the statement signed under the bundle type, or with another key;
  - `payload_mismatch`: a statement placed in a raw envelope;
  - `payload_type`: a run-manifest envelope;
  - `binding`: another run id, manifest digest, `sealed_at` or kid;
  - `statement_malformed`: a statement that is not JCS, or that has an extra member;
  - `form_mismatch`: a digest-form report with a raw envelope;
  - `signature`: `signed_form` removed from the report, or switched to `raw`.

  Each vector is valid except for the rule it names. `tools/contract-check.mjs` §16 replays every vector with a verifier
  written from this section. Both the CLI and the Go sealer can replay them.

### 5.3 Seal order and the evidence report (2.12.0, normative)

The evidence report (`evidence.json`, `evidence.html`) is covered by the bundle-manifest signature (§5.1 table;
EVIDENCE-REPORT-TEMPLATE R7), so `bundle-manifest.json` lists it with its sha256. Until 2.11.0 the evidence schema also
let `evidence.json` list the sha256 of `bundle-manifest.json`. The two digests cannot both be true, because each file
would have to contain a digest of the other. The evidence also needs inputs that the keyless pre-seal verifier does not
have: the seal time, the cross-check record and the admission record.

**Decision.** The seal step renders the evidence report after it has signed `report.json` and `report.sarif`, and before
it writes `bundle-manifest.json`. `evidence.json` does not list `bundle-manifest.json`. The evidence report gets no
envelope of its own.

**Order.** The seal step does these steps in order. A failed step stops the seal, and nothing later is written.

1. **Verify.** The keyless verifier job writes `verify.json` (§5.1.1), and the precondition (§3 rule 2) holds.
2. **Sign the report.** Add `signing` to `report.json`, and write `report.json.dsse.json`.
3. **Sign the SARIF.** Write `report.sarif.dsse.json`.
4. **Render the evidence report** (optional). The rendering holds no signing permission. Its inputs are:
   - the sealed `report.json` and its sha256;
   - `report.sarif` and its sha256;
   - `verify.json` (`status`; `unverified` becomes `build.seal_verification.unverified_fields`);
   - the signed cross-check record for the image digest;
   - the admission record;
   - the pack manifests and the corpus snapshot.

   `producer.sealed_at` is the report's `signing.sealed_at`. `signature.files` lists `report.json` and `report.sarif` for
   every run in scope, each with its sha256 and its envelope. It never lists `bundle-manifest.json`.

   (2.13.0) **The renderer is the open CLI's `agent-arena evidence`**, run in a keyless job from the run's own image
   digest (HOSTED-PROFILE §2.7 step 6 gives the command, the mounts and the exit codes). The seal-side facts that the
   signed report does not carry (the report key set's `jwks_url`, the admission record's dates, actor and incident
   reference, the cross-check record and the corpus snapshot) come from one document, `evidence_input.schema.json`
   (`wot:evidence_input:1`), whose `run_id` MUST equal the report's. Seal time, region, organisation, origin, image
   digest, engine build and key id are read from the signed report only; the input schema has no member for any of them
   and refuses unknown members. The renderer verifies every input before it writes: the report's signature with the
   report key set (§3.3, §5.2 E1-E4), the SARIF as the byte-equal re-rendering of the report, `verify.json` stating the
   seal precondition (§5.1.1 rule 6), the mounted packs (§11.3), and the cross-check record's schema and signature
   (§5.2 E4, at its `finished_at`). Its refusals are `input_invalid`, `signature_invalid`, `renderer_refused` and
   `evidence_not_written` (errors.md §1d), each exit 2 with nothing written.
5. **Write the bundle manifest.** It lists every bundle file (§5.1 rule 9), with `evidence.json` and `evidence.html`
   when they were rendered.
6. **Sign the bundle manifest.** Write `bundle-manifest.json.dsse.json`, last.

**The result has no cycle.** The chain of trust is:

- the bundle-manifest envelope covers the evidence report;
- the evidence report names the sealed `report.json` and `report.sarif` by digest;
- those two files carry their own envelopes.

A reader who holds `evidence.json` verifies the bundle manifest, finds the evidence in it, and then checks each digest
that the evidence names. A rendering outside a bundle is labelled "unsigned copy" (R7).

**Why not a separate envelope.** An envelope of its own would cost a fourth KMS signature per run and a new payload type.
It would also add a file outside the §5.1 layout, which a 2.11.0 verifier rejects under "No other file belongs to the
bundle", and `evidence.html` would still need the bundle manifest. The chosen order needs no new signature and no new
file.

**Compatibility.**

- The enum member `bundle-manifest.json` of `evidence_report` `signature.files[].path` is **deprecated**. A 2.12.0
  renderer MUST NOT emit it, and a reader MUST ignore an entry that uses it. Removing the member would reject documents
  that 2.11.0 accepted, so the removal waits for `3.0.0` (versioning.md §5).
- `signature.files` now needs at least 2 entries instead of 3. This is a relaxation.
- `verify --hosted-seal` does not read the evidence report's contents. It checks the report's digest and size through
  the bundle manifest (§5.1 rule 9), as before.

## 6. Contract tests

`tools/contract-check.mjs` §6, over `fixtures/signing_vectors.json` (key: RFC 8032 §7.1 TEST 1, a
published test vector, never a Sixi key):

- recomputes `JCS` bytes and their sha256 for the signed examples of `report`, `hosted_context` and
  `crosscheck_record`, and verifies each vector signature;
- proves `/signing/signature` is outside the signed bytes (replacing it changes nothing) and every other
  member is inside (changing `signing_key_id` breaks the signature);
- proves domain separation (the report signature does not verify under the manifest payload type);
- refuses to canonicalise a document whose `excluded` is not `["/signing/signature"]`;
- checks the example chain: manifest digest → report `run_manifest_digest`; `run_spec_digest` → report
  RunSpec; secrets → commitments → manifest; `run.hosted` = manifest fields; kid equality.

(2.6.0) `tools/contract-check.mjs` §10 adds: the run-token vectors (§10) against a verifier written from the text; the
fixture pack (§11) opened as the runner does (digest, payload type, signature, schema, variant digest and schema) and
its must-reject mutations; the `ARENA_IMAGE_DIGEST` cases and the §3.1.1 table against `fixtures/hosted_env.json`; and
the bundle-path and traversal must-rejects.

(2.11.0) `tools/contract-check.mjs` §15 checks the pinned key set (§3.3) on the schema example and on the file the CLI
bundles, and §16 replays the digest-statement vectors (§5.2).

Must-reject schema cases (a signature inside the signed payload, a signature under `run.hosted`, a
sealed report without `not_assessed`, a seal on a local report) are in the negative suite.

---

## 7. Press signatures (Diplomacy, since 2.4.0)

**Governing:** arena threat model G-11 and decision S5; Diplomacy scenario design specification §1.5 (program repository).
**Implementation:** `wot-auth` `press-signing.ts` (`pressSigningPayload`, `verifyPressSignature`), verified by the
arena before the engine (`services/arena/src/diplomacy/signatures.ts`). **Vectors:**
`fixtures/press_signing_vectors.json`.

Sections 1 to 6 sign documents with a Sixi key. This section is different: an **agent** signs its own negotiation
moves with its **passport signing key**, and the arena verifies them. The key is minted by the passports service
and returned once as a private JWK in `signing_key` (`POST /v1/agents`, `POST /v1/agents/{client_id}/rotate`;
`openapi.yaml` `PassportSigningKey`). The service stores only the public half and its `kid`, the RFC 7638
thumbprint `base64url(sha256('{"crv":"Ed25519","kty":"OKP","x":"<x>"}'))`.

### 7.1 Which moves are signed

| Move | Signature | `respond_to` | `terms_hash` |
|---|---|---|---|
| `offer` | required | `null` | over the offer's `terms` |
| `counter` | required | the countered offer id | over the counter's `terms` |
| `accept` | required | the accepted offer id | `null` |
| `renounce` | required | the commitment id (`cmt:…`) | `null` |
| `press`, `withdraw` | none (a `signature` member is `schema_invalid`) | — | — |

### 7.2 The JWS

A **detached compact JWS** (RFC 7515 Appendix F) with EdDSA over Ed25519 (RFC 8037, RFC 8032 pure Ed25519):

```
payload_bytes = UTF-8( JCS( payload ) )                                   (RFC 8785; §7.3)
header_b64    = BASE64URL( header bytes as the signer chose them )         (no padding)
signing_input = ASCII( header_b64 "." BASE64URL(payload_bytes) )
signature     = Ed25519( passport private key, signing_input )             (64 bytes)
on the wire   = header_b64 ".." BASE64URL(signature)                       (payload segment empty)
```

The wire pattern is `^[A-Za-z0-9_-]{16,256}\.\.[A-Za-z0-9_-]{16,256}$` (`diplomacy_action` `signature`).
**Exactly one accepted encoding** (security review G-34): each segment MUST be the canonical unpadded base64url
of its bytes (no `=`, no `+` or `/`, and the unused low bits of the last character zero), so the signature
segment is exactly 86 characters for its 64 bytes. A verifier re-encodes the decoded bytes and refuses a segment
that differs (`malformed`), so no two strings verify as the same signature. The payload is **never sent**: the verifier rebuilds it from the authenticated session and the message it received
(§7.3), so a sender cannot choose what its signature is checked against.

**Header allow-list.** The decoded header is a JSON object whose members are only:

- `alg` (required): exactly `"EdDSA"`;
- `kid` (optional): a string; when present it MUST equal the `kid` of the passport key the verifier resolved,
  or the signature is refused before the cryptographic check;
- `typ` (optional): a string, not interpreted.

Any other member refuses the signature, whatever its value: `crit`, `b64` (RFC 7797 unencoded payloads are not
accepted), `jwk`, `jku`, `x5u`, `x5c`, `x5t`, `cty`, `zip`, and every unregistered name. The verifier never takes a
key, a certificate or a URL from the header; the key is always the passport key of the session's agent. The
header bytes are part of the signing input as received, so any member order works; signers SHOULD emit the RFC
8785 form (`{"alg":"EdDSA","kid":"<kid>"}`).

### 7.3 The payload: eight members, JCS bytes

```
{ scenario, episode_id, msg_id_expected, from, to, move, respond_to, terms_hash }
```

| Member | Value | Source at the verifier |
|---|---|---|
| `scenario` | the literal `"diplomacy"`; never the scenario id `diplomacy_standard` | constant |
| `episode_id` | the episode's `epi_…` id | the session (the session ack and every observation carry it) |
| `msg_id_expected` | `prs:<phase>:r<round>:<power>:<seq>`: the id the engine assigns if the message is accepted. `<phase>` the current movement phase, `<round>` the current press round, `<power>` the sender's **full lower-case power name** (never the engine's three-letter abbreviation), `<seq>` the 1-based position of the message in its batch, counting every message of the batch, signed or not | the session's step and the message's position |
| `from` | the sender's power (full name) | the seat bound to the session, never the frame |
| `to` | the message's recipients object exactly as sent, e.g. `{"kind":"private","power":"france"}` | the message |
| `move` | `offer`, `counter`, `accept` or `renounce` | the message |
| `respond_to` | the wire id as sent (§7.1), or `null` | the message |
| `terms_hash` | offer and counter: `"sha256:" + hex(sha256(UTF-8(JCS(terms))))` over `terms` exactly as sent (wire form: `from_phase` / `to_phase`, the `note` included); accept and renounce: `null` | the message |

**Field order.** The list above is the documentation order of a fixed member set. The signed bytes are the
**RFC 8785 (JCS)** serialisation: keys sorted by UTF-16 code units, no whitespace, so the byte order is
`episode_id, from, move, msg_id_expected, respond_to, scenario, terms_hash, to`. A signature over any other
serialisation (the listed order, pretty-printed JSON, a subset) does not verify. The two `null` members are
present as `null`, never omitted.

**What the signature covers, and what it does not.** It binds the sender, the episode, the phase, the round, the
batch position, the recipients, the move, the answered id and the exact terms (any change to a clause, a
province, a phase or the note breaks it). It does not cover the message `body`, `asks`, `reply_to` or an offer's
`expires_after_round`: those are unsigned claims of the sending session. A signature authenticates; it is never
hashed into the transcript, and `verify` re-simulates from the recorded mode (§7.4), never from JWS bytes.

### 7.4 `sig_mode`: `key` or `session`

For every signed move the transport decides one attestation before the engine sees the move:

- **`key`**: the JWS verified against the sender's passport public key (§7.2, §7.3).
- **`session`**: the literal string `"session"` in place of a JWS. It is honoured only on the local CLI runner
  (channel `eval_target`, no passports) and on a table session of a **development or test** deployment
  (`WOT_ENV=development|test`) whose table allows unsigned local play. A production table and a hosted run
  never honour it. The Diplomacy session ack lists the modes a seat may use in `signature_modes`.
- **Anything else** (no signature, a malformed JWS, a failed check, a JWS from a seat without a registered key,
  `session` where it is not honoured) refuses that message `signature_invalid` **in its batch position**: the
  batch keeps its positions, so the ids and signatures of the later messages stay valid, and a re-simulation
  from the recorded inputs reproduces the refusal without key material. The sender sees it in `press_rejects`
  of its next observation; the specific cause is never disclosed (no verification oracle).

The engine records the mode per accepted message. A delivered message, an offer and a renounce carry their
**own** mode. A commitment is `key` only if both its offer and its accept were `key`, else `session`. A
commitment's `renounced.sig_mode` is the renounce message's own mode, recorded when it was accepted; it is never
inherited from the commitment (a `session` renounce of a `key` commitment is `session`). The EpisodeResult
`diplomacy.sig_mode` reports how the episode's commitments were attested, and a hosted report lists
`commitments_unsigned` under `not_assessed` when any was `session`.

### 7.5 Single use, keys, rotation

- **Single use by construction.** A JWS verifies for exactly one (episode, movement phase, press round, sender,
  batch position). It cannot be replayed into another episode, round or position, or by another sender.
  Resending the same message in a replacement frame of the same step (latest frame wins) is the same message,
  not a replay.
- **The key.** The verifier resolves the sender's public key by agent id from the passport record. A passport
  without a registered key can make no `key`-mode move.
- **Rotation revokes the previous key.** After `POST /v1/agents/{client_id}/rotate` a signature made with the
  previous key MUST NOT verify. Revoking the passport (`DELETE /v1/agents/{client_id}`) revokes its key.
- **Live table sessions (2.5.0).** The arena resolves the seat's key again for every frame that carries a
  JWS-signed move, never once per session. A rotation therefore takes effect from the next frame, with no reconnect
  and no new session ack: the new key verifies, and the previous key is refused `signature_invalid`. The session
  ack's `signature_modes` is a **hello-time snapshot** and is never re-sent. Its `session` entry cannot change during
  a session, because it depends only on the deployment and the table. Its `key` entry says only whether the passport
  had a key at hello. A passport that registers its first key later can sign `key` moves at once. A revoked passport
  loses its session to the rolling check (`session_revoked`, close 4410).

### 7.6 Contract tests

`tools/contract-check.mjs` §8 replays `fixtures/press_signing_vectors.json` (RFC 8032 §7.1 TEST 1 key, a published
test vector, never a passport or Sixi key) with an independent verifier written from this section:

- every vector's JWS is a valid Ed25519 signature over its own header and `signed_payload`, so each reject is
  caused by the rule it names, never by a broken vector;
- the verifier rebuilds the payload from `context` and `message` and must reach `expect` (`accept`, or the
  reject reason `malformed`, `bad_header`, `kid_mismatch` or `bad_signature`): accepted offer,
  counter-free accept (`terms_hash` null, seq 2), renounce without `kid`, a header with `typ`; refused a forged
  header member (`jwk`; `crit` with `b64`), `alg` other than EdDSA, a `kid` mismatch (`bad_header`,
  `kid_mismatch`), a non-canonical base64url spelling of a valid signature (`malformed`, G-34), and, as
  `bad_signature`, a payload in the listed field order instead of JCS order, the
  scenario id in place of `"diplomacy"`, an abbreviated power in `msg_id_expected`, a signature moved to another
  batch position or captured in another episode, and null members omitted.

The implementation SHOULD replay the same file in its own tests (Tier 1). The reason names are those of `wot-auth`
`JwsFailure`; on the wire every one of them is the single press reject `signature_invalid`.

## 8. Negotiation Chamber signatures (since 2.4.0)

The Negotiation Chambers (`POST /v1/negotiations/{negotiation_id}/offers`) use the same JWS form and header
allow-list (§7.2) and the same passport key, over a different payload, canonicalised with JCS:

```
{ scenario: "negotiation_chamber", negotiation_id, action, from_agent_id, respond_to, terms_hash, expires_at }
```

`action` is `offer`, `counter` or `accept`; `from_agent_id` is the caller's agent id; `respond_to` the answered
offer id or `null`; `terms_hash = "sha256:" + hex(sha256(JCS({give, want})))` over the move's own commitments
(offer, counter) or over the accepted offer's (accept), an absent side being `{"terms": []}`; `expires_at` the
offer's expiry or `null` (always `null` for an accept). `withdraw` is unsigned. The two payloads cannot be
confused: `scenario` differs, and so does the member set.

**Single use per chamber.** A signature already used in the chamber is refused as a replay. Signatures are
compared on their **decoded 64 bytes**, not on the string: base64url has several spellings of one byte string
(padding, the standard alphabet, unused low bits of the last character), and every spelling of a used signature is
the same signature (security finding G-34). Every failure (no
key, a malformed or non-verifying JWS, a replay) is the same `422 signature_invalid`. There is no `session` mode
on this surface.

## 9. Deletion receipts (since 2.5.0)

`schemas/deletion_receipt.schema.json` (`wot:deletion_receipt:1`, SIXI-INTEGRATION.md OQ-11) is signed like the report
(§2), with a payload type of its own:

```
payload_type = "application/vnd.sixi.arena-deletion+json"
signature    = Ed25519( report key, PAE( payload_type, JCS( receipt without /signing/signature ) ) )
```

- **Key.** The report key, in the report kid namespace (`signing.signing_key_id`), never the run-manifest key. A client
  verifies a receipt against the same pinned report keys it uses for reports.
- **Domain separation.** The payload type is part of the signed bytes, so a report signature never verifies as a
  receipt, and the reverse holds too.
- **Issued once.** A receipt is issued after the primary-storage deletion completes. `purged_at` is not before
  `requested_at`, and `backups_purged_by` is `purged_at` plus the backup horizon. `tools/contract-check.mjs` checks both
  on every example.
- **Contents.** It holds no customer content by construction: no origin, no target, no label and no credential. The
  organisation appears only as the opaque `org_ref`.
- **Test vector.** `fixtures/signing_vectors.json` `receipt_vectors` signs `schemas/deletion_receipt.schema.json`
  `examples[0]` with the RFC 8032 TEST 1 key, like §6. It is a separate list, so readers of the three 2.2.0 vectors
  are unaffected.

## 10. Run tokens for reference targets (since 2.6.0)

With `credential_mode: sixi_run_token` the control plane mints a **run token** and delivers it to the runner as the
target credential (`ARENA_TARGET_CREDENTIAL`, §3.1). The runner sends it as `Authorization: Bearer <token>` on every
request of the run, next to `X-Agent-Arena-Run: <run_id>`. The target (the cross-check reference origin run by
`agent-arena serve-reference --hosted`, or a customer endpoint using Sixi's run-token JWKS) verifies it. The token is a
credential: it is redacted like one, and no report, record, SARIF or log holds it. Only `credential_mode` is recorded.

**Form.** A compact JWS (RFC 7515 §7.1) with three segments, each canonical unpadded base64url (one accepted spelling
per byte string, as in §7.2). The whole token is at most 4096 characters.

**Header.** Only the members `alg`, `typ` and `kid`. Any other member (`jwk`, `jku`, `x5u`, `crit`, `b64`, …) refuses
the token.

| Member | Rule |
|---|---|
| `alg` | Required, exactly `EdDSA` (Ed25519, RFC 8037). |
| `typ` | Required, exactly `at+jwt`: the media type of RFC 9068. The token uses that type, but it is not a full RFC 9068 token, because `client_id` is not used and `iss` is optional (below). |
| `kid` | Set by every Sixi-minted token: the run-token key id, a kid namespace separate from report and manifest keys. When present, only the pinned key with that kid (or a pinned key without a kid) is tried, so a kid no pinned key names refuses the token. When absent, only pinned keys without a kid are tried. |

**Signature.** 64 bytes, Ed25519 over the ASCII bytes of `<header segment> "." <payload segment>` with a pinned run-token
public key. The key never comes from the token.

**Claims.** Members not listed here are ignored.

| Claim | Minted | Verified |
|---|---|---|
| `aud` | The run's `verified_origin.origin`, exactly (`https://host[:port]`; no path). | A string, or an array containing one, equal to the verified origin the target is configured with. A `wss://` origin is also matched in its `https://` spelling. |
| `sub` | The run's `run_id`. | Matches the run-id pattern **and** equals the request's `X-Agent-Arena-Run` header. A token is bound to its run, so it cannot be replayed under another run's header. |
| `exp` | At most `wall_clock_deadline` + 5 minutes, in NumericDate seconds. (2.7.0) Also at most `iat` + 3600: `exp` ≤ min(`wall_clock_deadline` + 300, `iat` + 3600). | Required, a number, and `exp + 60 > now` (60 s skew). (2.7.0) Lifetime cap: `exp − now ≤ 3600 + 60`, and when `iat` is present, `exp − iat ≤ 3600`. |
| `nbf`, `iat` | `nbf` optional. (2.7.0) `iat` set by every Sixi-minted token: the minting time. NumericDate. | Optional. When present, a number and not more than 60 s in the future. |
| `jti` | Required: at least 128 bits of randomness, 8 to 128 characters, never reused across tokens. | Required, a string of 8 to 128 characters. It identifies the token for audit. The token is used for every request of its run, so a verifier does not treat `jti` as single-use per request. |
| `iss` | The arena issuer. | Compared only when the verifier is configured with an issuer, and then must be equal. |
| `org` | Optional: `org_ref`. | Ignored by the reference target. |

**Lifetime (2.7.0).** A run token is reusable for every request of its run, so its life is bounded, and a mis-minted
long-lived token is refused for the whole of its life, not only after its run. The cap is **1 hour** (3600 s), checked two
ways, both with the one 60 s skew:

- **From issue:** when `iat` is present, `exp − iat ≤ 3600`. There is no skew here, because both values come from the
  same clock, the minter's.
- **From now:** `exp − now ≤ 3600 + 60`. This bounds a token without `iat`, and a token whose `iat` is old or wrong.

Both are `exp` failures, and so the same `401 invalid_token`. Consequence for admission: a `sixi_run_token` run must end
within 55 minutes of minting (§3.2 rule C3). The cap is not a plan limit and cannot be raised per run.

**Refusals.** Every failure of the checks above is the same `401` with `WWW-Authenticate: Bearer error="invalid_token"`
and the body `{"error":"invalid_token"}` (RFC 6750 §3.1), so the target is no verification oracle. The reference
target in hosted mode also answers `421` `{"error":"misdirected_request"}` to a request whose `Host` does not name the
verified origin (the default port may be written or omitted), before looking at the token. `/healthz` is exempt from
both. A request without `Authorization` is served (the open cross-check legs send none) unless the target is started
with `--require-run-token`. A WebSocket upgrade is admitted by the same rules.

**Test vectors.** `fixtures/signing_vectors.json` `run_token_vectors`: 23 tokens signed with the RFC 8032 TEST 1 key (and
one with TEST 2), each with the verifier `context` (audience, issuer or null, pinned keys with or without kid, `now`,
the `X-Agent-Arena-Run` value) and the expected result. They cover 3 accepts and 20 must-rejects:

- `typ` other than `at+jwt`, or missing;
- an embedded `jwk`;
- `alg` other than `EdDSA`;
- an unpinned `kid`, and a token without `kid` against keys that have kids;
- another key;
- `aud` naming another origin or carrying a path;
- `sub` that is not a run id, and a `sub` that differs from the request's run header;
- expired beyond the skew, and a missing `exp`;
- (2.7.0) a 2 h token (`exp − iat` = 7200, with `exp` only 30 minutes ahead, so only the from-issue bound fails), and a
  token without `iat` whose `exp` is 90 minutes ahead (only the from-now bound fails);
- `nbf` in the future;
- a missing or short `jti`;
- a wrong `iss`;
- a non-canonical signature encoding.

`tools/contract-check.mjs` §10 replays them with a verifier written from this section.

## 11. Scenario packs: envelope, layout, loading (since 2.6.0)

A pack (`pack_manifest.schema.json`, HOSTED-PROFILE §5) reaches the hosted runner as files the control plane fetched
from the pack store and mounted read-only. The runner never fetches, downloads or looks up a pack. The open CLI loads
none at all, and refuses every `sx_` scenario id with `scenario_pack_unavailable` (RESERVED.md).

### 11.1 The envelope, `pack.dsse.json`

A DSSE envelope (JSON), signed at publication:

```
{ "payloadType": "application/vnd.sixi.arena-pack+json",
  "payload":     base64( the pack manifest as UTF-8 JSON bytes ),
  "signatures":  [ { "keyid": <kid>, "sig": base64( Ed25519( key, PAE(payloadType, payload bytes) ) ) } ] }
```

- **Payload.** The pack manifest (`pack.yaml` parsed and written as JSON). It must parse as JSON and validate against
  `pack_manifest.schema.json`. The signature is over the exact payload bytes, so a verifier never re-canonicalises
  them. Producers SHOULD write the JCS form, as the fixture does.
- **Encoding.** `payload` and `sig` use standard base64 (`A-Z a-z 0-9 + /`, `=` padding), like the report envelopes.
  `sig` decodes to 64 bytes.
- **Signatures.** 1 to 4 entries, and the envelope is accepted if one of them verifies. Each carries the `keyid` of its
  key. The key belongs to the **pinned control-plane key set**, the same JWKS the runner pins for run manifests (§3;
  2.11.0: the `manifest` set of §3.3, with the pack window of §3.3 rule 3).
  The payload type separates the two domains: a pack signature never verifies as a run-manifest signature, and the
  reverse holds too. A new pack key must be in the pinned set before a pack is signed with it.
- **Digest.** The run manifest pins each pack by `packs[].digest` = `"sha256:" + hex(sha256(exact bytes of
  pack.dsse.json))`: the whole envelope, signatures included.

### 11.2 Layout

```
$ARENA_PACKS_DIR/
  <id>/                    one directory per run-manifest `packs[]` entry; <id> = packs[].id = the pack's `id`
    pack.dsse.json         the envelope (§11.1)
    <data.ref>             each scenario_variant data file, conventionally variants/<name>.json
```

- `<id>` matches `^sx-[a-z0-9-]{1,40}$`, so it cannot hold `/`, `.` or `..`. `data.ref` is relative to `<id>/`, and
  its pattern bans `..` and a leading `/`. The runner also resolves every data path and refuses one that is not
  inside `<id>/`.
- Every file is opened without following a symbolic link, must be a regular file, and is read with a cap:

| File | Cap (bytes) | Source of the cap |
|---|---:|---|
| `pack.dsse.json` | 524288 | twice the manifest cap |
| decoded payload (the pack manifest) | 262144 | `pack_manifest` `x-max-frame-bytes` |
| a variant data file | 65536 | `pack_variant` `x-max-frame-bytes` |

- A variant data file is an `arena-pack-variant/1` document (`pack_variant.schema.json`). It is pinned by
  `scenarios[].data.digest` = `"sha256:" + hex(sha256(exact file bytes))`, which the signed manifest carries, so it
  has no signature of its own.
- Nothing else in the directory is read. Rule fixtures (`rules[].fixtures`) belong to the pack eval, not to the
  runner.

### 11.3 Load order and must-rejects

For each `packs[]` entry of the verified run manifest, in order, before any network I/O. Every refusal is
`scenario_pack_unavailable` (errors.md §1d) unless another code is named, and nothing is sent to the target.

1. `ARENA_PACKS_DIR` is set (when `packs` is not empty), and no pack id is listed twice.
2. `<id>/pack.dsse.json` opens (it exists, is not a symbolic link, is a regular file, and is within its cap).
3. Its digest equals `packs[].digest`.
4. It is a DSSE envelope whose `payloadType` is exactly `application/vnd.sixi.arena-pack+json`, with 1 to 4
   signatures. A wrong payload type is refused, including another Sixi type such as the run-manifest type, and so is
   an envelope with no signatures.
5. At least one signature verifies with a pinned key whose kid is the entry's `keyid` (or a pinned key without a kid).
   (2.11.0) That key's window covers the run manifest's `issued_at` (§3.3 rule 3, Packs); a signature by a key outside
   its window does not count.
   An envelope none of whose signatures verifies is **unsigned** and is refused.
6. The payload is within its cap, parses as JSON, and validates against `pack_manifest.schema.json`.
6a. (2.9.0) Its `coverage.clauses` contains every clause id cited by `oracles[].clauses` or `rules[].clauses`
   (coverage ⊇ clause map ∪ rule clauses). The not-assessed enumeration walks `coverage.clauses`, so a mapped clause missing
   there would never be listed as not assessed when its oracles were not assessed. The reverse is not required: coverage may
   list a clause that no oracle maps, and that clause is always listed as not assessed (`clause_not_mapped_in_run`). JSON
   Schema cannot express inclusion between two arrays, so this step is a load rule. The pack eval refuses to publish such a
   pack, the runner refuses to load it, and `tools/contract-check.mjs` §13 checks every pack example and the signed fixture.
7. Its `id` and `version` equal the `packs[]` entry.
8. The engine build of the scenario the run plays, and of every variant `base`, is in `engine.builds`. Otherwise the
   refusal is **`pack_engine_mismatch`**.
9. For each `scenario_variant` entry (an `sx_` id): `base` is an open scenario of this build; the data file opens
   inside `<id>/` within its cap; its digest equals `data.digest`; it validates against `pack_variant.schema.json`; every
   `oracle_thresholds` key is an oracle of the base's catalog; a pinned `tier` is in the entry's `tiers`; and no
   `sx_` id is declared twice.

The must-rejects covered by `tools/contract-check.mjs` §10:

- a wrong payload type;
- an unsigned envelope, and a signature made for another payload type;
- a tampered payload;
- an envelope whose digest differs from the pin;
- a pack id or data ref that attempts traversal;
- a variant file with a member outside the surface, a wrong format, an out-of-range seed or threshold, or an unknown
  tier;
- an engine build outside `engine.builds`.
- (2.9.0, §13) a pack whose `coverage.clauses` omits a clause its clause map or a rule cites.

### 11.4 Resolving a variant

An `sx_` RunSpec `scenario_id` resolves to exactly one variant of the mounted packs. It is refused if no pack, or more
than one, declares it. Against the RunSpec:

- `budget_tier` must be in the entry's `tiers`, and equal to the pinned `tier` when there is one;
- `seeds` must equal the pinned `seeds` exactly, when they are pinned;
- a RunSpec `seat.mode` must be in `seat_modes`.

A difference is refused. The control plane expands the pinned values into the RunSpec, and the runner never overrides
the RunSpec silently. **Current runner build:** after a variant resolves and passes these checks, the run is still
refused with `scenario_pack_unavailable`, because Report support for pack scenarios (`scenario.base_scenario_id`) is
not yet in the runner. The same build loads `clause_map` packs for the open scenario the run plays, and they feed
`not_assessed`.

**Fixture.** `fixtures/packs/sx-agentic-core/` is a loadable pack directory. Its `pack.dsse.json` holds
`pack_manifest.schema.json` `examples[0]` (JCS) signed with the RFC 8032 TEST 1 key under keyid
`sixi-arena-manifest-ed25519-20261101`, and `variants/deadlock-hard.json` is `pack_variant.schema.json` `examples[0]`, whose
digest the pack example pins. `fixtures/signing_vectors.json` `pack_vectors` records the payload and envelope digests.
The envelope digest is **not** the `packs[].digest` of the `hosted_context` example, which stays a placeholder so that
the signed example chain of §6 does not change.

**The fixture's engine build is a placeholder** (2.9.0, made explicit). `engine.builds` is exactly the `hosted_context`
example's `engine_build_hash`, which is not the build of any real tree. A real runner therefore refuses the fixture as shipped
with `pack_engine_mismatch` (step 8), by design; the Phase 9 gate asserts exactly that (C3-FIXTURE-ENGINE). A harness that
needs a loadable pack re-signs a **copy** for its own build and never edits the fixture:

```
node contracts/tools/signing-vectors.mjs --engine-build sha256:<64 hex> --out <dir outside contracts/>
```

This writes `<dir>/sx-agentic-core/pack.dsse.json` (examples[0] with `engine.builds = [<build>]`, same RFC 8032 TEST 1 key and
keyid) plus the variant files, and prints the payload and envelope digests. The run manifest then pins the copy's envelope
digest, and the harness pins the matching test key. The copy's digests differ from `pack_vectors` by construction.
`pack_vectors[0]` records the placeholder (`engine_builds_placeholder: true`). (2.9.0) The fixture's `coverage.clauses` now
also lists `OWASP:LLMTop10:LLM01` and `OWASP:LLMTop10:LLM10`, which its clause map cites (step 6a), and the fixture is re-signed.
