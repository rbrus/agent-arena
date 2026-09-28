# Sandbox

`docker compose up` starts **one reference target agent**, and `verify.sh`
runs the **CLI from a second container** against it. Both run from **one
image**, and the Phase 9 hosted runner runs that same image, unchanged and
pinned by digest.

## Two commands

```bash
git clone https://github.com/rbrus/agent-arena && cd agent-arena/sandbox
docker compose up --build     # reference target on 127.0.0.1:8081
```

Then, in a second terminal, prove the whole path end to end:

```bash
./verify.sh                   # build, start, CLI run from a second container, hash check
```

You need Docker Engine with Compose v2.24 or later and BuildKit (the default).
No `.env`, no secret and no API key are needed.

## What runs

| Service | Command (same image) | Host port | Role |
|---|---|---|---|
| `target` | `agent-arena serve-reference --policy coordinated --port 8081 --host 0.0.0.0 --allow-non-loopback` | `127.0.0.1:8081` | One reference target agent over REST: the coordinated (CLEAR) reference squad. Set `ARENA_TARGET_POLICY=naive` for the WIPE half. |
| `run` (profile `run`, one-shot) | `agent-arena run --scenario byzantine --seat squad --tier core --seeds 20260720,1,2,3,5 --episodes 5 --target http://127.0.0.1:8081 --transport rest --i-own-this-target --out /tmp/out` | none | Used by `verify.sh`. It writes `report.json` and `report.sarif` to `./out`. |

`run` joins the **target's network namespace** (`network_mode: service:target`),
so the literal loopback URL `http://127.0.0.1:8081` reaches the target from a
second container. That exercises the CLI-in-container path the hosted runner
uses. A compose hostname such as `http://target:8081` resolves to a private
address, and the CLI's network guard blocks that on purpose. A literal
loopback address is the CLI's explicit, logged opt-in.

`docker compose up` never evaluates anything by itself. To run an evaluation
against the sandbox target from the host:

```bash
npx @sixi4ai/agent-arena run --scenario byzantine --seat squad --target http://127.0.0.1:8081 --transport rest --i-own-this-target --out ./out
```

The image carries the CLI only. The arena does not accept inbound agent
connections: the CLI dials out to your agent over REST, WebSocket, MCP or A2A
(see [packages/arena-cli/README.md](../packages/arena-cli/README.md)).

## `verify.sh`

1. Works out where `contracts/` is (`ARENA_CONTRACTS_CONTEXT`: `../contracts` in this repository's layout, `../../contracts` in the nested source layout). With host deps installed it also checks that `anchors.json` matches `anchors.ts`.
2. Builds `agent-arena:local`. The build runs `npm ci --ignore-scripts`, `typecheck`, the `anchors.json` drift check, the five-seed anchor self-test and the CLI bundle.
3. Prints `IMAGE_ID`, `IMAGE_DIGEST` and the image's Node version, then checks (`check-image-env.mjs`, inside the image) that the image's default environment sets none of the hosted runner's must-be-absent variables (`contracts/fixtures/hosted_env.json`, for example `WOT_CONTRACTS_DIR`), that every guarded-family variable is one the hosted runner accepts (`SSL_CERT_FILE` only as the distroless CA bundle, contracts 2.15.0), and that the image config `Env` holds only `PATH`, `HOME`, `NODE_VERSION` and the names `hosted_env.json` allows, which is the Sixi promotion's rule (SX-9).
4. Runs `docker compose up --wait` and waits until `target` reports `/healthz` healthy.
5. Runs the gate-1 evaluation from the one-shot `run` container.
6. Checks `report.json` against the frozen anchors in `sandbox/anchors.json`, taken from the checkout, not the image. It runs `check-anchors.mjs` with the image's Node and `--network none`. `anchors.json` is the data copy of `SELF_TESTS` in `packages/arena-scenarios/src/anchors.ts`. The image cannot import `anchors.ts` itself, because that file pulls in `wot-engine` and the runtime image carries no sources. `anchors-json.ts --check` fails the image build if the copy drifts, and `anchors-json.ts --write` regenerates it after a re-freeze. Each episode's `replay_hash`, `outcome` and `terminal_tick` must equal the anchor for its scenario, tier, seating, seed and reference policy. All five gate seeds must be present.
7. Prints the wall-clock against the 300 s budget (gate 1: under 5 minutes from a clean clone) and writes `out/verify.env`.

Exit codes: `0` means everything matched. `1` means an anchor mismatch. `2`
means a build, start or run error. `3` means over the time budget, and is only
returned with `--strict-time`. `--keep` leaves the stack running. In GitHub
Actions it also appends `image_id`, `image_digest`, `anchors_ok` and
`wall_clock_s` to `$GITHUB_OUTPUT`.

**Measured** (linux/arm64, 2026-09-28, base images already pulled, npm cache
warm): a full `verify.sh` run, image build included, took **26 s**, and **5/5**
replay hashes matched the anchors. Pulling the two base images on a fresh
machine adds network time on top.

## Same image as hosted (the sim is the spec)

- **One Dockerfile** (`sandbox/Dockerfile`) and **one image** serve both
  compose services. They differ only by command. The hosted runner (Phase 9 B1,
  Sixi Arena) runs this image with the default entrypoint, the CLI, in one
  short-lived container per run. It must not rebuild it, patch it or layer on
  top of it. A hosted build that differs from this Dockerfile is a **release
  blocker**.
- **Pin by digest.** `release.yml` pushes `ghcr.io/rbrus/agent-arena:<version>`
  and records the registry digest as a step output. The hosted runner deploys
  `ghcr.io/rbrus/agent-arena@sha256:...`, never a tag.
- **Cross-check (Phase 9 gate 1).** Run
  `ARENA_IMAGE=ghcr.io/rbrus/agent-arena@sha256:<digest> ./verify.sh`. It pulls
  the pinned image instead of building, runs the same seeds, and proves the
  hashes equal the frozen anchors. The hosted job must produce the same
  hashes for the same seeds with the same digest. `IMAGE_DIGEST` in
  `out/verify.env` (or the `image_digest` step output) is the value to pin.
  A local build's `IMAGE_DIGEST` is only the local
  store's digest: with the containerd image store it equals `IMAGE_ID`, and
  with the classic store it is empty. Only the registry digest from
  `release.yml` is a valid hosted pin.
- The Node runtime is part of the determinism contract. Both base images are
  pinned by multi-arch index digest and are bumped together, on purpose.
  `verify.sh` prints `IMAGE_NODE`.

## What the image contains

Build stage (`node:22-slim`, pinned). Nothing from this stage ships:
`npm ci --ignore-scripts`, `npm run typecheck`, the `anchors.json` drift
check, the five-seed anchor self-test with `verify`, and `npm run build:cli`
(the CLI bundle). The full test suite runs in CI, not in the image build.

Runtime stage (`gcr.io/distroless/nodejs22-debian12:nonroot`, pinned):

| Path | What |
|---|---|
| `/app/agent-arena.cjs` | The CLI bundle. This is the entrypoint: `run`, `verify`, `serve-reference`, `--version`. |
| `/app/healthcheck.mjs` | The `HEALTHCHECK` probe for `GET 127.0.0.1:<port>/healthz`. The image has no shell and no curl. |
| `/app/contracts/schemas/`, `/app/contracts/CHANGELOG.md` | The JSON Schemas and the contracts changelog. The CLI uses its embedded copy. The image does **not** set `WOT_CONTRACTS_DIR`: the hosted contract requires it to be absent. |
| `/app/LICENSE`, `/app/NOTICE`, `/app/THIRD_PARTY_LICENSES.txt` | Licences, including every npm package bundled into the CLI. |

It contains no `node_modules`, no sources, no shell, no package manager and
**no secrets or dev switches**. It runs as uid `65532`. Compose runs every
container `read_only` with `cap_drop: [ALL]`, `no-new-privileges` and a 64 MB
`noexec` tmpfs on `/tmp`.

The build context is the directory holding `package.json` and `packages/`.
`contracts/` always goes in as the named context `contracts`
(`additional_contexts`, `ARENA_CONTRACTS_CONTEXT`, relative to `sandbox/`).
In this repository it is `../contracts`, which is the compose default.
`verify.sh` computes it on every run. The named context is needed because
`.dockerignore` drops `**/*.md` from the main context and the contract tests
read `contracts/*.md`. `.dockerignore` keeps `.git`, `node_modules`, `dist`,
`.env*`, `.dev-keys`, keys and service-account JSON out of every layer.

## Compose knobs

| Var | Default | Purpose |
|---|---|---|
| `ARENA_IMAGE` | `agent-arena:local` | Use a published image (by digest) instead of building. |
| `ARENA_TARGET_POLICY` | `coordinated` | Reference policy for `target`. `naive` gives the WIPE half. |
| `ARENA_CONTRACTS_CONTEXT` | `../contracts` | Where `contracts/` is, relative to `sandbox/`. |
| `ARENA_OUT_DIR` | `./out` | Report output for the `run` service. |
| `ARENA_UID`, `ARENA_GID` | `65532` | User for `run`. `verify.sh` sets your own uid so `./out` is yours. |
| `ARENA_VERSION`, `ARENA_REVISION` | `0.0.0-dev`, `unknown` | OCI labels. |

## Troubleshooting and failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `bind: address already in use` on 8081 | Another process (often `npm run target:reference`) holds the port. | Stop it, or edit the host side of `ports:` (for example `127.0.0.1:18081:8081`). Keep `127.0.0.1`. |
| `target` never becomes healthy | The process crashed at startup. Read `docker compose logs target`. | `--wait-timeout` is 90 s in `verify.sh`. |
| The `run` container cannot reach the target, or the CLI says the address is blocked | `--target` was a hostname (`http://target:8081`). | Use `http://127.0.0.1:8081`. `run` shares the target's netns. |
| `EACCES` writing `./out` | `run` ran as uid 65532 into a directory you own. | Use `verify.sh` (it passes your uid), or `ARENA_UID=$(id -u) ARENA_GID=$(id -g)`. |
| `npm ci` fails in the build: lockfile out of sync | `package.json` and `package-lock.json` disagree. | Run `npm install` at the repository root and commit the lockfile. The image never uses `npm install`. |
| `EROFS` in logs | Something tried to write outside `/tmp`. The FS is read-only by design. | File a bug. Nothing in the image may write elsewhere. |
| Anchor `MISMATCH` | The engine, a scenario or the Node runtime changed a replay. | Treat it as a determinism regression, not a flaky test. A re-freeze is a documented, versioned rule change (`anchors.ts` header). |
| `anchors-json: DRIFT` (build step or `verify.sh`) | `anchors.ts` was re-frozen, but `sandbox/anchors.json` was not regenerated. | `npx tsx sandbox/anchors-json.ts --write`, then review the diff: every changed hash is a re-freeze. |
| `failed to solve: ... contracts: not found`, or `contracts/ build context not found` | `ARENA_CONTRACTS_CONTEXT` points at the wrong place, for example from a copied command line. | Unset the variable and use `verify.sh`. |
| `IMAGE ENV FAIL: ... WOT_CONTRACTS_DIR` (or another name) | An `ENV` line in `sandbox/Dockerfile` sets a variable the hosted runner must not see, so `run --hosted` would refuse with `(environment)`. | Remove it from the runtime stage. |
| `IMAGE ENV FAIL: ... (image Env: outside the hosted_env.json allow-list ...)` | An `ENV` line sets a name the Sixi promotion refuses (SX-9), for example a runtime default such as the pre-0.2.3 `WOT_PORT`. | Move the default into the CLI or the compose/run script; never widen the allow-list for it. |
| `check-anchors: cannot read anchors` | `sandbox/anchors.json` is missing. | Restore it from git, or run `anchors-json.ts --write`. |

Never paste the output of `docker compose config` or `docker inspect` into an
issue or CI log: both expand any local `.env`. `verify.sh` never calls them.

## Files

| File | Role |
|---|---|
| `Dockerfile` | Multi-stage build to distroless runtime. The one image. |
| `docker-compose.yml` | `target`, and the `run` profile. |
| `verify.sh`, `check-anchors.mjs` | End-to-end check and anchor comparison (plain Node, no imports beyond `node:fs`). |
| `check-image-env.mjs` | Asserts the image's default env and config `Env` against `hosted_env.json` (must-be-absent list, guarded families, the SX-9 image-Env rule). |
| `anchors.json`, `anchors-json.ts` | Data copy of the frozen anchors, and its generator and drift check (`--write` / `--check`). |
| `healthcheck.mjs` | The shell-less `HEALTHCHECK` probe. |
