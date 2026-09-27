# Signing — canonical form, signed objects, verification

**Since:** contracts `2.2.0` (HOSTED-PROFILE.md §0.1 K1, K4, K9; §2.7, §3). **Governing:**
`docs/security/threat-model-hosted.md` §2.1, §2.5, §5; `docs/security/threat-model-arena.md` §3.3.
**Test vectors:** `fixtures/signing_vectors.json` (regenerate with `node contracts/tools/signing-vectors.mjs`);
`tools/contract-check.mjs` §6 verifies them on every run. **Since 2.4.0** also the passport signatures on
negotiation moves: §7 (Diplomacy press, vectors in `fixtures/press_signing_vectors.json`, checked by
`tools/contract-check.mjs` §8) and §8 (Negotiation Chambers). **Since 2.5.0** deletion receipts (§9). **Since 2.6.0** the
run tokens a reference target verifies (§10, vectors in `fixtures/signing_vectors.json` `run_token_vectors`), the
scenario-pack envelope and layout (§11, fixture pack `fixtures/packs/sx-agentic-core/`, vector `pack_vectors`), the hosted
bundle layout (§5.1), and the hosted runner's environment contract (§3.1, machine-readable in `fixtures/hosted_env.json`).

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
| Scenario pack manifest (2.6.0) | `pack_manifest.schema.json`, as the payload of `pack.dsse.json` (§11) | `application/vnd.sixi.arena-pack+json` | a key of the pinned control-plane (manifest) key set | pack store, at publication |

Run tokens (§10) are compact JWS, not DSSE. They are signed with the run-token key, which has its own kid namespace.

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

1. The runner refuses a manifest whose signature does not verify against the pinned control-plane key,
   whose `run_spec_digest` differs from the RunSpec it received, or whose `verified_origin.origin` differs
   from the RunSpec target origin (`hosted_context_invalid`, errors.md §1d).
2. The seal step signs a report only if its `signing.run_manifest_digest` is a digest the control plane
   issued and has not been sealed before (single use), the report's `run.hosted` equals the manifest's
   fields, and (2.6.0, made precise) `agent-arena verify --hosted-seal <out dir>` on the unsealed bundle, run with the
   image the run used, exited **0** (§5.1). Any other exit is `seal_failed`, and nothing is signed.
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
  `production` only, `NODE_VERSION`, `YARN_VERSION`.

A variable in the tables of §3.1.1 is refused with its own `detail.field`. Every other refusal here is
`hosted_context_invalid` with `detail.field: environment`, before any I/O, naming the variables and never their values.
Examples: `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`, `NODE_COMPILE_CACHE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
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
| M3 | The manifest is signed with a key of the control-plane key set the release pins, named by `kid`, and that key id differs from the report key id (§2). | `hosted_context_invalid` (`/signing`, `/signing/signing_key_id`, `/signing/signature`) |
| M4 | `image_digest` names an image **promoted** by the release process, and the latest cross-check record for that image and its `engine_build_hash` has `job_verdict: pass` (CROSSCHECK.md). Otherwise the control plane holds new runs (`crosscheck_hold`). The job pulls that image by its index digest and sets `ARENA_IMAGE_DIGEST` to the index and platform-manifest digests actually run (§3.1). | `hosted_context_invalid` (`/image_digest`, `/image_digest/index`, `/image_digest/platform_manifest`, `/image_digest/platform`, `/engine_build_hash`) |
| M5 | The job template sets exactly the variables of §3.1: `ARENA_HOSTED=1`, `ARENA_IMAGE_DIGEST`, `ARENA_PACKS_DIR` when `packs` is not empty, `NODE_OPTIONS=""`, and the per-run secret references. Nothing of §3.1.1 and no other variable of the §3.1.3 families. | `hosted_context_invalid` (`environment`, `manifest_source`, `episode_secret_commitments`) |
| M6 | The job runs `agent-arena run --hosted --manifest <file> --run-spec <file> --out /out`, optionally with `--json`, and with `--manifest-key` only while the release pins no manifest key set (a release that pins one refuses the flag). No other flag. The manifest and RunSpec files are regular files on the run's read-only prefix, within their caps (§3.1). | `hosted_context_invalid` (`manifest_source`, `--manifest`, `--run-spec`); any other flag is refused by name, exit 3 |
| M7 | A Diplomacy-family run commits to exactly one episode secret per episode, and the job delivers exactly those secrets as `ARENA_DIP_SECRET_<n>`. Any other scenario commits to none and receives none (§3.1.2, §4). | `hosted_context_invalid` (`episode_secret_commitments`) |
| M8 | Every listed pack is entitled, mounted under `ARENA_PACKS_DIR`, and signed as in §11. | `pack_not_entitled` at admission; `scenario_pack_unavailable` or `pack_engine_mismatch` at the runner |
| M9 | (2.9.0) `region` is one of the twelve regions of the `hosted_context.region` enum: `europe-central2`, `europe-north1`, `europe-north2`, `europe-southwest1`, `europe-west1`, `europe-west10`, `europe-west12`, `europe-west3`, `europe-west4`, `europe-west6`, `europe-west8`, `europe-west9` (the regions in EU member states, plus `europe-west6`, Zürich). `europe-west2` (London) and every region outside the EU and Switzerland are refused. The list is explicit because a `europe-` prefix is not a residency boundary. The control plane refuses to start with a region outside the list, so it never signs one. The report, the evidence report and the deletion receipt carry the same enum, so a sealed document cannot name another region either. Adding a region is a contract MINOR that changes every copy at once. | `hosted_context_invalid` (`/region`) |
| M10 | (2.10.0, OQ-18) A run of a Diplomacy-family scenario (`diplomacy_standard`, or an `sx_` scenario whose base is `diplomacy_standard`) has `episodes` ≤ 50, and `episode_secret_commitments.count` equals `episodes` (the schema caps `count` at 50). Hosted only: the open CLI keeps the RunSpec limit of 1000. The cap comes from the per-episode secret delivery of §3.1.2: every episode adds one version to the run's secret, and the secret store's version-add rate per secret is the binding limit, taken with 2x headroom. At admission the control plane refuses with `plan_limit_exceeded`, `detail` `{limit: "diplomacy_episodes_per_run", value: <episodes>, plan: <plan>}`, with a maximum of 50 whatever the plan. It composes with A6: an `extended` run plays 1 episode, a Diplomacy-family run at another tier at most 50. | `hosted_context_invalid` (`episode_secret_commitments`) |

**The seal step (§3 rule 2).** It runs `agent-arena verify --hosted-seal /out` with the pinned manifest key and
`--expect-manifest-digest <the digest the control plane issued>`, and signs only after exit 0.

The table order is not the order in which the runner checks. Every runner refusal names fields, never values, and never the target origin (G-45).

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

These two files carry no signing block. Their DSSE envelopes sign the **exact file bytes** as written
(HOSTED-PROFILE §3.1): `report.sarif` is byte-compared with a re-render of the verified report, and
`bundle-manifest.json` (`bundle_manifest.schema.json`) lists the sha256 and size of every other bundle
file, including `run-manifest.json` and the evidence report, so one signature covers them all.

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
| `evidence.json`, `evidence.html` | seal step, optional | yes, when present | the bundle manifest |
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
   `run.hosted.run_manifest.signing_key_id`. Its signature verifies when a manifest key is given (`--manifest-key`).
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

**Sealed (`report.json` has `signing`; the report key is required, `--key`).** All the pre-seal rules, with the kid
comparisons made against `signing.signing_key_id`, plus:

7. `signing.signing_key_id` = `run.hosted.signing_key_id` = the SARIF `signing_key_id` = the `keyid` of every
   envelope, and `signing.run_manifest_digest` = `run.hosted.run_manifest.digest`.
8. Each of the three envelopes is a DSSE envelope with **exactly one** signature, the payload type of §2, a payload
   byte-equal to what it signs, and an Ed25519 signature that verifies over `PAE(payloadType, payload)` with the report
   key. An envelope file is at most twice its payload plus 65536 bytes.
9. `bundle-manifest.json` is at most 1048576 bytes and is schema-valid. Its `run_id` and `signing_key_id` equal the
   report's, and its `files` are unique and sorted by path in byte order. It lists `report.json`, `report.sarif`,
   `run-manifest.json`, and both episode files of every episode the report references. Every listed file exists
   inside the bundle (no symbolic link, no path outside it) and matches its `sha256` and `bytes`.

**Exit codes.** `0` verified; `1` mismatch (the SARIF re-render differs, a Diplomacy commitment does not match, or the
re-simulation disagrees); `2` a seal, invariant or signature problem (`signature_invalid`: the evidence cannot be
trusted as sealed); `3` misuse (a sealed bundle without `--key`, `--hosted-seal` together with `--hosted`, or an `sx_`
report, which this CLI cannot re-simulate, or a report naming an engine build this CLI does not have).

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

Must-reject schema cases (a signature inside the signed payload, a signature under `run.hosted`, a
sealed report without `not_assessed`, a seal on a local report) are in the negative suite.

---

## 7. Press signatures (Diplomacy, since 2.4.0)

**Governing:** threat-model-arena G-11 and decision S5; `docs/design/diplomacy-scenario.md` §1.5.
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
  key. The key belongs to the **pinned control-plane key set**, the same JWKS the runner pins for run manifests (§3).
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
