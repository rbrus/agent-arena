# agent-arena

Evaluate an AI agent against deterministic failure-mode scenarios, over REST, WebSocket, MCP or A2A, and get `report.json` + `report.sarif`. The engine runs inside the CLI: no server, and no model runs anywhere in the open core.

## Install

Needs Node.js 22 or later. On npm as `@rbrus/agent-arena`; the bin is `agent-arena`.

```sh
npm i -g @rbrus/agent-arena          # then: agent-arena <command> …
npx @rbrus/agent-arena <command> …   # without installing
```

`agent-arena serve-reference --port 8080` serves the included reference target, so the run below
also works without a checkout: use `agent-arena` in place of `npx agent-arena` and
`agent-arena serve-reference --port 8080` in place of `npm run target:reference -- --port 8080`.

## Five-minute path

From a source checkout (the root of a clone of `rbrus/agent-arena`):

```sh
npm ci && npm run build:cli                         # builds packages/arena-cli/dist/agent-arena.cjs
npm run target:reference -- --port 8080 &          # the included reference squad (scripted, no model)
npx agent-arena run --scenario byzantine --seat squad --target http://localhost:8080
#   … episode 0 seed 20260720 squad: clear at tick 38  sha256:e533088162409df5…  anchor: match (…)
#   report: ./arena-report/report.json   sarif: ./arena-report/report.sarif   exit 0
npx agent-arena verify arena-report/report.json
```

`npm ci` links the `agent-arena` bin before anything is built. Until `npm run build:cli` has run, `npx agent-arena` exits 2 and says to run it. `node packages/arena-cli/dist/agent-arena.cjs` works in place of `npx agent-arena`. With the npm package, skip `npm ci` and `npm run build:cli` and use `agent-arena` or `npx @rbrus/agent-arena`. For a run that needs no network at all, pass `--target ref:coordinated`.

The defaults are the gate run: the five gate seeds `20260720,1,2,3,5`, one episode each, the `core` tier. Each episode whose replay hash equals a frozen golden anchor is marked `anchor: match`.

## Commands

| Command | What it does |
|---|---|
| `run --scenario <id> --target <url> [--seat duel\|squad\|member] [--tier edge\|core\|frontier\|extended] [--seeds a,b] [--episodes n] [--transport rest\|ws\|mcp\|a2a] [--auth env:NAME\|secret:name] [--out dir] [--allow-private] [--i-own-this-target] [--max-retry-after s] [--ci github] [--json]` | Plays N seeded episodes in-process against the target and writes the report, the SARIF log and per-episode replay files. |
| `run --spec <run.json> [--out dir] [--json\|--quiet] [--i-own-this-target] [--auth env:NAME\|secret:name]` | The same run from a RunSpec file (`contracts/schemas/run_spec.schema.json`), checked against the schema before anything else. No other run flag combines with it; each one is refused by name. `target.ownership_attested: true` in the file is the ownership attestation and is recorded as `source: run_spec`. `--auth` supplies a credential reference when the file has none. A RunSpec the CLI wrote (`report.run-spec.json`, `.agent-arena/<scenario>.run.json`) runs again as it was, in-process references included. `seats[]` (the table profile) runs only on the hosted runner. |
| `list-scenarios [--json]` | Every registered scenario, its seatings, oracles and reference pair; for `diplomacy_standard` also its fills, in-process targets and served policies. |
| `replay <report.json> --episode <n> \| --hash <sha256:…> [--json]` | Prints one episode's tick log. It is regenerated from the seed and the recorded target inputs, so no target is needed. `--json` prints the replay-inspector file. |
| `verify <report.json> [--key <pem\|jwk> \| --key pinned] [--hosted] [--json]` | Re-simulates every episode, regenerates the engine-controlled seats from the seed, replays the target's seats from the record (checking each `recorded_inputs` digest), recomputes every verdict and compares. It prints how each seat was obtained ("regenerated from seed" / "recorded, replayed") and any recorded seats besides the target. `--key` checks the report's Ed25519 seal first, with a public key file or the PEM/JWK text (a private key is refused); a bad or missing seal is `signature_invalid`, exit 2. `--key pinned` uses the Sixi report keys this release bundles (see "Pinned control-plane keys"). `--hosted` (needs `--key`) also checks that the SARIF next to the report names the same signing key as the seal, and the run-manifest digest; the seal may be raw or a signed digest statement (contracts 2.11.0), and the form is printed. |
| `version [--json]` | The CLI version; `--json` adds this build's engine build hash per scope (`core`, `diplomacy`, `all`). |
| `serve-reference [--scenario <id>] [--seat squad] [--policy coordinated\|naive] [--port 8080] [--host h --allow-non-loopback] [--allow-origin <origin>]…` | Serves the included reference agent over all four transports on one port. It binds `127.0.0.1`; any other `--host` also needs `--allow-non-loopback`. A request or WebSocket upgrade that carries an `Origin` header is refused (403) unless that exact origin is given with `--allow-origin` (repeatable). With `--scenario diplomacy_standard`: `--policy robust\|credulous\|injector\|house [--agent-seed n]`. |

## Transports (asyncapi `eval_target`)

| `--transport` | `--target` | Per decision |
|---|---|---|
| `rest` | `http(s)://host/path` | POST the observation frame; a 2xx body is the action frame |
| `ws` | `ws(s)://host/path` | one socket per episode; text frames |
| `mcp` | `http(s)://host/mcp` (streamable HTTP) | `tools/call arena_act {frame}`; `structuredContent` is the action frame |
| `a2a` | the agent card URL | `message/send` with one DataPart; the reply's first DataPart is the action frame |

The transport never interprets a frame. Every answer goes through the same edge parser (size, JSON, frame type, protocol, schema, echo). A deterministic agent that answers inside the soft deadline therefore produces the same replay hashes over every transport.

`serve-reference` exposes `/` (rest), `/ws`, `/mcp`, `/.well-known/agent-card.json` + `/a2a`, and `/healthz`.

## Diplomacy (`diplomacy_standard`)

The target plays one of the seven powers; the other six are scripted reference diplomats. Each engine step (intent, each press round, orders, retreat, adjustment) is one decision under the tier deadlines, and the action frame cap is 16 KiB.

```
npm run target:reference -- --scenario diplomacy_standard --policy robust --port 8080
npx @rbrus/agent-arena run --scenario diplomacy_standard --seat germany --fill table:commitment \
    --horizon 1904 --seeds 20261115 --target http://localhost:8080
#   … episode 0 seed 20261115 germany: survived at tick 44  sha256:a445a17f…  transcript sha256:25ff9b01…  anchor: match (…)
```

| Flag | Values |
|---|---|
| `--seat` | a power (`austria` … `turkey`) or `auto` (default: the scenario's seeded seat shuffle, so the power varies with the seed) |
| `--fill` | `injector-table` (default: one injector, one schemer, four house; profile `security`, the RunSpec default) · `house` (profile `clean`) · `robust` · `credulous` · `table:<pair>`, one of the six engine golden tables (`manipulation_followed`, `commitment_broken`, `injection_followed`, `intent_leak`, `budget_violation`, `combined`; the first word is enough, e.g. `table:commitment`). The golden tables pin england and france. |
| `--horizon` | last game year, `1901`..`1908`, default `1906`. It is always passed to the scenario explicitly. |
| `--secret` | hosted only (the control plane draws, commits and discloses the episode secret); refused in local runs |
| `--target ref:…` | in-process `ref:robust`, `ref:credulous`, `ref:house` (`ref:coordinated` / `ref:naive` are aliases of the pair) |

The run prints one line that names the fill in use. The default is the contract default: a RunSpec with neither `diplomacy.fill` nor `diplomacy.profile` is profile `security`, which plays `injector-table`. Pass `--fill house` for the clean profile. The RunSpec records `seat: {mode: power, position}`, `diplomacy: {profile, horizon_year, fill}` (profile `security` or `clean`, from the fill) and, for one more version, the fill as the deprecated label `arena.diplomacy_fill`. Each episode reports `transcript_hash`, `evaluation_hash` and `diplomacy.engine_evaluation_hash`, and `verify` re-simulates and checks all of them. An episode in which a reference seat fails an oracle is `episode_invalid`: every target verdict is `not_assessed` there, it counts toward neither pass nor fail, and `run` prints the count. In local runs a press signature must be the literal `session`. The CLI holds no passport keys, so any other signature is refused (`signature_invalid`) and its bytes are never recorded.

Press text is an engine input, so the episode record keeps it. Before the engine reads an action, the runner redacts credential-shaped text and registered secrets in it (press bodies, offer notes, intent notes, orders) to `[redact]`. The engine, the record and the report then hold the same text, so `verify` still re-simulates a run whose target wrote, say, "Send the bearer shipments to Kiel." (that matches the `Bearer <token>` shape). The run warns once and records the count in the RunSpec label `arena.press_redactions`. Record and replay files, and `replay --json`, are written inert: bidi controls, zero-width and tag characters and other invisible code points are `\uXXXX`-escaped (JSON-lossless). `verify` accepts a local Diplomacy record only with the empty episode secret, and the fill comes from the RunSpec (`diplomacy.fill`, else the deprecated label, else the profile's contract mapping), never from the record.

```sh
agent-arena run --scenario diplomacy_standard --seat germany --horizon 1901 --seeds 11 --target http://127.0.0.1:8080
agent-arena verify ./arena-report/report.json       # exit 0; run.spec.labels["arena.press_redactions"] counts any redactions
```

A served diplomat keeps a per-episode view (the movement window's press and every commitment's history), because the frame carries only the last step. The view stores only the fields it reads, cut to the engine's limits (body 600 bytes, note 200, 6 clauses per side, 6 asks), within 1 MiB per episode and 64 MiB across at most 64 episodes (least recently used forgotten first). It uses a fixed tie-break salt (`--agent-seed`, default `20261115`) instead of the episode seed, which it never sees. As a result it reproduces the in-process reference, and the golden anchors, only on episodes whose seed equals that salt.

## Output (`--out`, default `./arena-report`)

`report.json` · `report.sarif` · `report.run-spec.json` (the RunSpec; credential *references* only) · `report.episode-<n>.replay.json` (replay-inspector format, the episode's `replay_ref`) · `report.episode-<n>.record.json` (what `verify` re-simulates).

Every SARIF result points at the RunSpec file, repo-relative (`contracts/sarif-mapping.md` §4). With `--spec`, that is the spec file itself, when it is under the working directory. Otherwise the run also writes `.agent-arena/<scenario>.run.json`, the RunSpec as run, under the working directory (your repository root in CI) and points at that. If that directory cannot be written, the run warns and still writes the report.

## Exit codes

| | `run` | `verify` |
|---|---|---|
| 0 | no fail verdict at or above `--fail-on` (default `error`) | verified |
| 1 | findings | mismatch (incl. a RunSpec target that does not match how the records drive the target seat, e.g. an in-process reference relabelled as your agent) |
| 2 | error (unreachable target, repeated auth failures, crash) | unverifiable input |
| 3 | misconfiguration (flags, spec, credentials, ownership, blocked address) | report from another engine build, or a scenario this version cannot verify |

`engine.build_hash` is scoped (`engine.build_scope`): every scenario except `diplomacy_standard` records scope `core`, which excludes `src/diplomacy/**`, so a Diplomacy change does not invalidate a core report. The bundle embeds only per-file hashes of the engine sources (`engine.source_manifest_digest` names that manifest); it never embeds the sources.

```
npx @rbrus/agent-arena verify arena-report/report.json --key sixi-report-signing.pub.pem   # sealed report
npx @rbrus/agent-arena verify bundle/report.json --hosted --key pinned                    # sealed Sixi report, against the bundled report key
npx @rbrus/agent-arena version --json                                                     # engine build hashes of this build
```

## Hosted mode (Sixi Arena runner only)

`run --hosted` is the same code path as a local run, driven only by a control-plane-signed run manifest (contracts `hosted_context.schema.json`, signing.md §3 and §3.1). It is for the Sixi job template, not for local use; everything security-relevant comes from the manifest, the RunSpec it binds by digest, or the frozen `hosted-v1` network policy.

```sh
agent-arena run --hosted --manifest /run/arena/in/manifest.json --run-spec /run/arena/in/run-spec.json --out /out
#   the manifest is checked against the manifest keys this release pins (below); --manifest-key is
#   refused with hosted_context_invalid (--manifest-key), because the job arguments never replace the trust root (G-47)
```

With `ARENA_HOSTED` in the environment (the hosted job template sets it), the binary runs only `run --hosted`, `verify --hosted-seal` and `version`; every other command exits 3 `hosted_mode_only` before anything is read, and the sandbox arena server refuses to start (G-48).

| Accepted | Refused (by name, before anything is read) |
|---|---|
| `--manifest`, `--run-spec`, `--out`, `--json` (`--manifest-key` is parsed, then refused while a key set is pinned) | every other run flag: `--scenario`, `--seat`, `--seeds`, `--target`, `--auth`, `--allow-private`, `--follow-redirects`, `--i-own-this-target`, literal secrets, positionals |

- **Manifest:** file ≤ 8192 bytes, schema-valid, Ed25519 over `PAE(application/vnd.sixi.arena-run-manifest+json, JCS(manifest without /signing/signature))` with a pinned key. The pinned `kid` must equal `signing.signing_key_id`, which must differ from the report key id, and the key's window must cover `issued_at`; otherwise `hosted_context_invalid (/signing/signing_key_id)`, exit 3, nothing sent. Refused (G-51): an expired `wall_clock_deadline`; `issued_at` more than 5 min in the future or more than 24 h old; `wall_clock_deadline − issued_at` over 48 h; `verified_origin.checked_at` more than 24 h old (or in the future). The deadline is also checked per decision (G-54): a decision in flight at the deadline is cut as a hard miss and the run aborts `deadline_exceeded` (exit 2, nothing written).
- **RunSpec:** file ≤ 16384 bytes; `sha256(JCS(RunSpec))` must equal `run_spec_digest`. Its target must be exactly `verified_origin.origin` (scheme, host, port), which must equal the egress allowlist's `target`; `https`/`wss` only; no userinfo, query or fragment (G-46: the signed RunSpec is recorded byte-for-byte, so a credential there would be sealed into the bundle).
- **Logs (G-45):** stdout/stderr (Cloud Logging) never name the customer origin: while a hosted run is active every byte passes a filter that replaces the verified host, in any spelling, and every address it resolved or connected to with `<verified origin>`; `hosted-v1` refusals name fields, never values; Node's DNS/TLS error texts are reduced to their code. The report and bundle keep the origin (it is the evidence).
- **Image:** `ARENA_IMAGE_DIGEST=<index digest>,<platform manifest digest>` must be set by the job and contain both `image_digest` values; `image_digest.platform` must be the running platform; `engine_build_hash` must be this build's.
- **Network (`hosted-v1`):** allowlist = the verified origin; public unicast addresses only (a typed `127.0.0.1`/`localhost`, private, link-local and metadata addresses are refused before any socket, and again in the socket lookup); no redirects; A2A/MCP second hops must stay on the origin; `rate = min(rps_cap, 50)`; `User-Agent … ; sixi-hosted` and `X-Agent-Arena-Run: <manifest run_id>`.
- **Secrets (read once, deleted from the environment first, before any check):** `ARENA_TARGET_CREDENTIAL` (only ref `env:ARENA_TARGET_CREDENTIAL`; per `credential_mode`), `ARENA_SEAT_CREDENTIAL_<POWER>` (table seats; tables are refused by this build), `ARENA_DIP_SECRET_<n>` (Diplomacy: exactly `count` 64-hex secrets that hash to `episode_secret_commitments`). Refused variables, `hosted_context_invalid (environment)` (the must-be-absent table of contracts/fixtures/hosted_env.json, asserted equal by a test): `AGENT_ARENA_SECRETS_DIR`, `ARENA_DEBUG`, non-empty `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSLKEYLOGFILE`, `NODE_V8_COVERAGE`, `WOT_CONTRACTS_DIR`; `(manifest_source)`: `ARENA_HOSTED_CONTEXT`/`ARENA_RUN_SPEC`. On top (G-50 allow-list) every other `ARENA_*`, `NODE_*`, `SSL*`, `OPENSSL*` or proxy variable is refused unless it is a job-template name (`ARENA_IMAGE_DIGEST`, `ARENA_PACKS_DIR`, `ARENA_HOSTED`, empty `NODE_OPTIONS`) or set by the image (`NODE_ENV=production`, `NODE_VERSION`, `YARN_VERSION`): e.g. `NODE_USE_SYSTEM_CA`, `SSL_CERT_FILE`, `OPENSSL_CONF`, `NODE_COMPILE_CACHE`, `HTTPS_PROXY`.
- **Packs:** an `sx_` scenario is refused (`scenario_pack_unavailable`, exit 3) unless the manifest lists a pack mounted at `$ARENA_PACKS_DIR/<id>/pack.dsse.json` (DSSE `application/vnd.sixi.arena-pack+json`, 1 to 4 signatures, at least one by a pinned manifest key whose window covers the run manifest's `issued_at` (contracts 2.11.0: a pack carries no signing time, so the question is whether the key is trusted for this run), bundle sha256 = manifest `packs[].digest`, `engine.builds` includes this build). Variants resolve to base scenario + `arena-pack-variant/1` parameters (tier, seeds, oracle thresholds); running a variant awaits pack-scenario reports. Clause-map packs feed `not_assessed`.
- **Output (`/out`):** `report.json` (`run.mode: hosted`, `run.hosted` copied from the manifest plus `run_manifest {digest, signing_key_id, path: run-manifest.json}` and `observed_connections`, `target_ownership.source: sixi_verified`, `not_assessed`), `report.sarif`, `run-manifest.json` (byte-for-byte), `episodes/<n>.record.json`, `episodes/<n>.replay.json`. Unsigned: the seal step signs.

```sh
agent-arena verify --hosted-seal /out [--expect-manifest-digest sha256:…]   # pre-seal (verifier job): invariants, manifest AND its signature against the pinned keys (G-49), engine build, SARIF re-render, commitments, re-simulation
agent-arena verify --hosted-seal ./bundle --key pinned                       # sealed bundle: + 3 DSSE envelopes (raw or digest statement), bundle-manifest.json digests (or --key <report key|jwks>)
agent-arena verify report.json --hosted --key pinned                         # seal (either form) + run-manifest.json beside the report + Diplomacy commitments
agent-arena serve-reference --hosted --verified-origin https://xcheck-ref.example.com --run-token-key runtoken-jwks.json [--require-run-token]
```

**The verifier job and `--result`.** The Sixi seal step signs a run only after this image's own `verify --hosted-seal` of the unsealed output exited 0: the job re-simulates every episode from its record and compares the result with what the runner wrote, re-renders the SARIF, and checks the manifest, the invariants and the commitments. Its stdout goes to logs, so it also writes the result where the sealer reads it:

```sh
agent-arena verify --hosted-seal /run/arena/out --expect-manifest-digest sha256:<issued> --json --result /run/arena/seal/verify.json
```

- `--result <path>` writes exactly the document `--json` prints (same bytes), with or without `--json`. The sealer seals only on `exitCode` 0, `status: "verified"`, `hosted_seal.sarif_equal: true` and empty `hosted_seal.seal` and `hosted_seal.mismatch`.
- It is written for every outcome: exit 0, 1 and 2, and exit 3 once the path is accepted (`status: "misuse"`, e.g. a sealed bundle without `--key`). The file's `exitCode` is the process exit code. No file means the verification did not finish; the sealer treats that as `verify_no_result`.
- The path is checked before the bundle is read: it must not exist (create-only, no symbolic link), its directory must exist, and it must be outside the bundle (a result is not a bundle file). Otherwise exit 3 and nothing is written. A write failure is exit 2 (`result_not_written`).
- `--result` needs `--hosted-seal` (exit 3 otherwise; redirect `--json` for any other verify).

**Signed digest statements (contracts 2.11.0, signing.md §5.2).** Sixi's KMS signs at most 65536 bytes of raw data, so a large report, SARIF or bundle manifest is signed through a small statement that names its payload type, length and sha256 (and, for the seal outputs, the run id, manifest digest and `sealed_at`). `verify --hosted` and `verify --hosted-seal` accept either form per file, and refuse a raw signature whose PAE message is over `ARENA_SIGN_MAX_MESSAGE_BYTES` (65536) even when it verifies. The form is reported per file:

```text
report.json: digest statement (196608 bytes, sha256:…) verified with sixi-arena-ed25519-…
report.sarif: raw signature (17857 bytes) verified with sixi-arena-ed25519-…
```

With `--json` the result carries `signed_forms`, e.g. `{"report.json": "digest_statement", "report.sarif": "raw", "bundle-manifest.json": "raw"}` (`verify --hosted`: `report.json` only; pre-seal: `{}`). Every refusal is `signature_invalid`, exit 2, as `signature_invalid: <reason>: <file>: <detail>`, where the reason is one of `payload_type`, `raw_over_threshold`, `payload_mismatch`, `statement_malformed`, `subject_type`, `length_mismatch`, `digest_mismatch`, `binding`, `form_mismatch`, `key` or `signature`. The CLI replays every vector of `contracts/fixtures/digest_statement_vectors.json` in its tests.

`serve-reference --hosted` (cross-check reference origin) answers 421 unless `Host` names the verified origin, and verifies a presented `sixi_run_token` (EdDSA `at+jwt`, `aud` = the origin, `sub` = the run id equal to `X-Agent-Arena-Run`, `exp`/`nbf`/`iat`, lifetime at most 1 h (G-53), `jti`, optional `iss`); every refusal is `401 invalid_token`. The A2A card names the endpoint on the verified origin.

### Pinned control-plane keys

The runner image is the open image and Sixi never rebuilds it, so the keys it trusts ship in the release: `src/hosted/pinned-keys.json`, bundled into the CLI (SIXI-INTEGRATION OQ-3; SECURITY-REVIEW-HOSTED S-1). The file holds the `?purpose=manifest` and `?purpose=report` sets of `https://sixi.ch/.well-known/arena-jwks.json`, each key exactly as served (OKP Ed25519, `use: sig`, `kid`, `not_before`, `not_after`), plus the fetch time, the source URLs and the sha256 of each served body. The run-token key is not bundled: `serve-reference --hosted` takes `--run-token-key`. The CLI never fetches keys.

| Set | Pinned kid (release of 2026-09-27) | Window | Checks |
|---|---|---|---|
| manifest | `sixi-arena-manifest-ed25519-86c88a43cdcdb910e8f4` | 2026-09-27T00:00:00Z to 2026-12-26T00:00:00Z | run manifests (`run --hosted`, `verify --hosted`, pre-seal `verify --hosted-seal`), scenario packs |
| report | `sixi-arena-ed25519-c2f84888ae5d69e9f7df` | 2026-09-27T00:00:00Z to 2026-12-26T00:00:00Z | sealed reports and bundles with `--key pinned` |

- **Window.** A key verifies a document only when `not_before ≤ t < not_after` (and `t < revoked_at` when set), where `t` is the manifest's `issued_at`, the report's `signing.sealed_at` (for the report and all three envelopes), or, for a scenario pack, the `issued_at` of the run manifest that lists it. A document signed outside the window is refused like one signed by an unpinned kid: `hosted_context_invalid (/signing/signing_key_id)` for a manifest, `signature_invalid: key` (exit 2) for a report, `scenario_pack_unavailable` for a pack.
- **Checked at load.** A malformed bundled file refuses every hosted verification. Besides the schema rules, every kid must be derived from its key (`sixi-arena-manifest-ed25519-` or `sixi-arena-ed25519-`, then the first 80 bits of the RFC 7638 thumbprint in hex), each set's `keys` must reproduce its served body (`JSON.stringify({keys}) + LF` hashes to `source_sha256`), each set's `source` is the file's plus `?purpose=<set>`, and no key is in both sets.
- **`--manifest-key`** is refused (`hosted_context_invalid (--manifest-key)`, exit 3, before anything is read) on `run --hosted`, `verify --hosted` and `verify --hosted-seal`.
- **Rotation.** Keys have a 90-day window. The next key ships in an open release, with a green cross-check on that image, before the control plane first signs with it and before the current key's `not_after`. That is at least one open release per quarter. A key cannot be added at run time: `--manifest-key` is refused while a set is pinned.
- **Old reports.** A report sealed under a key that a later release no longer pins verifies with the release that was current when it was sealed, or with `--key <that report key>`.

**Control-plane admission checklist** (what the Sixi control plane must refuse before it signs a manifest; the runner refuses the same, later and louder):
- a RunSpec target URL with no userinfo, query or fragment, on exactly the verified origin (scheme, host, port);
- `issued_at` = now, `wall_clock_deadline` ≤ issued_at + the plan cap (≤ 48 h), `verified_origin.checked_at` ≤ 24 h old;
- a manifest signed by a key in the release's pinned manifest JWKS, inside that key's window (the job template passes no `--manifest-key`);
- the job template: `ARENA_HOSTED=1`, `ARENA_IMAGE_DIGEST`, `ARENA_PACKS_DIR` when packs are mounted, `NODE_OPTIONS=""`, and no other `ARENA_*`/`NODE_*`/`SSL*`/`OPENSSL*`/proxy variable; the seal step's verifier job runs `verify --hosted-seal /out --expect-manifest-digest <issued digest> --json --result <seal dir>/verify.json` with no `--manifest-key` (the release pins the manifest keys);
- run tokens with `exp` ≤ min(deadline + 5 min, iat + 1 h).

## Security posture

- **One guarded network layer** (`src/net/`). Every socket of every transport is checked inside its DNS `lookup` hook, against every returned address, on every new connection. Loopback, private, CGNAT, ULA, IPv4-mapped/NAT64/6to4/Teredo, link-local and metadata addresses are blocked. `--allow-private` opens private ranges; link-local needs `--allow-link-local`. A loopback address you type (`localhost`, `127.0.0.1`, `[::1]`) is a logged, loopback-only opt-in. A hostname that merely resolves to a private address stays blocked. Redirects are refused (`--follow-redirects`: same origin only, max 3 hops, each re-checked). Proxy environment variables are ignored. Responses are capped in bytes and time. A WebSocket connection is capped per frame (64 KiB), in unread frames (16) and unread bytes (256 KiB), and in total bytes (16 MiB) and messages (4096) per episode; a target that exceeds a cap is disconnected with close code 1008 and a reason, and the decision is recorded as `too_large`. `npm run lint:net -w @rbrus/agent-arena` fails on any network or process primitive outside `src/net/` (including `createRequire`, `process.getBuiltinModule`, `child_process`, computed `globalThis[...]` access). It also bundles the CLI in memory and fails if a bundled npm package is not on its allowlist, or if any bundled source outside `src/net/` imports a network module.
- **Credentials** are references: `--auth env:NAME`, or `--auth secret:name` for a mode-600 file in `$AGENT_ARENA_SECRETS_DIR`. The value lives only in process memory and is sent only to the origin you typed. It never appears in a log, report, SARIF, replay, error or the RunSpec on disk. `--token`, `--header` and similar flags, `user:pass@` URLs and credential-looking query parameters are refused.
  - An `env:` variable is deleted from the process environment as soon as it is read.
  - A secret file is opened once, without following symlinks. Its type, mode and size are checked on the open descriptor.
  - Redaction also catches the forms a log reader could undo: backslash-escaped (`tok\_…`), percent-encoded, base64/base64url, hex, JSON-escaped, upper/lower-cased, and interleaved with invisible characters. It also catches a prefix or suffix of 8 or more characters left at a truncation boundary. Target text is redacted whole before it is escaped or cut.
  - With `--ci github` in GitHub Actions, every registered form is `::add-mask::`ed before any other output: the bare token, `Bearer <token>`, base64, base64url, hex, URL-encoded and JSON-escaped. In `--json` mode the masks go to stderr.
  - The CLI refuses to run with Node flags that can dump memory: `--inspect*`, `--heapsnapshot-signal`, a non-zero `--heapsnapshot-near-heap-limit`, `--report-on-*`, and the V8 profilers `--cpu-prof`, `--heap-prof`, `--prof`, on the command line or in `NODE_OPTIONS`. `ARENA_DEBUG=1` overrides this. Flags that only configure those facilities are allowed.
  - What we do not claim: JavaScript strings cannot be wiped, so the value stays in the process heap until the process exits.
- **Target output is untrusted.** It is schema-validated by `arena-scenarios/edge.ts` before it reaches the engine. Free text (`thought`, ping text) is dropped. Any target text shown on the terminal is redacted, sanitised, stripped of escapes and prefixed `  target> `. No target text reaches the report or SARIF. Every output line is exactly one line. An embedded newline is shown as `\n`. A line that would begin with a CI marker (`::`, `##`) is prefixed with `> `, so a hostile report opened with `replay` cannot issue a workflow command. An RPC result nested deeper than 64 levels is a malformed answer (the units Hold).
- **Your own endpoints only.** A non-loopback target needs `--i-own-this-target` ("I own this endpoint or am authorised to test it"). The flag is recorded as `run.spec.target.ownership_attested` / `run.target_ownership`. Non-loopback traffic is paced at 5 requests/s by default (`--max-rps`, at most 50). Before the first request, the run prints its request ceiling: episodes × at most 120 decisions, plus terminal notices and the handshake. A 429/503 `Retry-After` is honoured in full: nothing is sent inside the window. If the target asks for longer than `--max-retry-after` (default 30 s, at most 3600), the run stops with exit 2. Three consecutive 401/403 answers abort the run. Every request carries `User-Agent: agent-arena/<version>` and `X-Agent-Arena-Run`.
- **`serve-reference`** binds loopback unless you pass `--allow-non-loopback`. Loopback is still reachable from any web page you open, so any request or WebSocket upgrade with an `Origin` header gets 403 unless `--allow-origin <scheme://host[:port]>` names it; the arena's own clients send no `Origin`. It rejects JSON-RPC ids that are not a string, number or null. It keeps at most 64 MCP sessions (least recently used evicted, 10 min idle expiry). A request body must arrive within 10 s (otherwise 408).
