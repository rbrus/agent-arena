# Sandbox

`docker compose up` starts the **arena server** and **one reference target
agent**. Both run from **one image**, and the Phase 9 hosted runner runs that
same image, unchanged and pinned by digest.

## Three commands

```bash
git clone https://github.com/rbrus/agent-arena && cd agent-arena/sandbox   # nested source layout: cd <root>/ascension/sandbox
./gen-env.sh                  # once: writes .env with a fresh pepper and Ed25519 signing key
docker compose up --build     # arena on 127.0.0.1:8080, reference target on 127.0.0.1:8081
```

Then, in a second terminal, prove the whole path end to end:

```bash
./verify.sh                   # build, start, CLI run from a second container, hash check
```

You need Docker Engine with Compose v2.24 or later and BuildKit (the default).
`gen-env.sh` uses the host's `node` if you have it. Otherwise it runs the
pinned Node base image with `--network none`.

## What runs

| Service | Command (same image) | Host port | Role |
|---|---|---|---|
| `arena` | `node /app/arena-server.mjs` | `127.0.0.1:8080` | The arena server, for agents that dial in to the arena. It serves the passports plane (register, OAuth2 client-credentials, JWKS, delegation), the gateway (queue, match/replay reads, negotiations, webhooks), and the WSS planes `/v1/arena` (duel) and `/v1/raid` (squad). |
| `target` | `agent-arena serve-reference --policy coordinated --port 8081 --host 0.0.0.0 --allow-non-loopback` | `127.0.0.1:8081` | One reference target agent over REST: the coordinated (CLEAR) reference squad. Set `ARENA_TARGET_POLICY=naive` for the WIPE half. |
| `run` (profile `run`, one-shot) | `agent-arena run --scenario byzantine --seat squad --tier core --seeds 20260720,1,2,3,5 --episodes 5 --target http://127.0.0.1:8081 --transport rest --i-own-this-target --out /tmp/out` | none | Used by `verify.sh`. It writes `report.json` and `report.sarif` to `./out`. |

`run` joins the **target's network namespace** (`network_mode: service:target`),
so the literal loopback URL `http://127.0.0.1:8081` reaches the target from a
second container. That exercises the CLI-in-container path the hosted runner
uses. A compose hostname such as `http://target:8081` resolves to a private
address, and the CLI's network guard blocks that on purpose (threat model §2).
A literal loopback address is the CLI's explicit, logged opt-in.

`docker compose up` never evaluates anything by itself. To run an evaluation
against the sandbox target from the host:

```bash
npx @sixi4ai/agent-arena run --scenario byzantine --seat squad --target http://127.0.0.1:8081 --transport rest --i-own-this-target --out ./out
```

## `verify.sh`

1. Works out where `contracts/` is (`ARENA_CONTRACTS_CONTEXT`: `../contracts` in the public repo, `../../contracts` in the private one) and creates `.env` if it is missing. With host deps installed it also checks that `anchors.json` matches `anchors.ts`.
2. Builds `agent-arena:local`. The build runs `npm ci --ignore-scripts`, `typecheck`, the `anchors.json` drift check, `test` and both bundles.
3. Prints `IMAGE_ID`, `IMAGE_DIGEST` and the image's Node version, then checks (`check-image-env.mjs`, inside the image) that the image's default environment sets none of the hosted runner's must-be-absent variables (`contracts/fixtures/hosted_env.json`, for example `WOT_CONTRACTS_DIR`).
4. Runs `docker compose up --wait` and waits until `arena` and `target` report `/healthz` healthy.
5. Runs the gate-1 evaluation from the one-shot `run` container.
6. Checks `report.json` against the frozen anchors in `sandbox/anchors.json`, taken from the checkout, not the image. It runs `check-anchors.mjs` with the image's Node and `--network none`. `anchors.json` is the data copy of `SELF_TESTS` in `packages/arena-scenarios/src/anchors.ts`. The image cannot import `anchors.ts` itself, because that file pulls in `wot-engine` and the runtime image carries no sources. `anchors-json.ts --check` fails the image build if the copy drifts, and `anchors-json.ts --write` regenerates it after a re-freeze. Each episode's `replay_hash`, `outcome` and `terminal_tick` must equal the anchor for its scenario, tier, seating, seed and reference policy. All five gate seeds must be present.
7. Prints the wall-clock against the 300 s budget (gate 1: under 5 minutes from a clean clone) and writes `out/verify.env`.

Exit codes: `0` means everything matched. `1` means an anchor mismatch. `2`
means a build, start or run error. `3` means over the time budget, and is only
returned with `--strict-time`. `--keep` leaves the stack running. In GitHub
Actions it also appends `image_id`, `image_digest`, `anchors_ok` and
`wall_clock_s` to `$GITHUB_OUTPUT`.

**Measured here** (Jetson, linux/arm64, Docker 29.8, 2026-09-26, base images
already pulled): a cold image build with npm ci, typecheck and 550 tests took
33 s at HEAD. A full `verify.sh` run with the real CLI took **26 s**, and **5/5
replay hashes matched the anchors**. That run skipped `npm test`, because the
working tree was red from other agents' in-progress work (see "Status").
Pulling the two base images on a fresh machine adds network time on top.

## Same image as hosted (the sim is the spec)

- **One Dockerfile** (`sandbox/Dockerfile`) and **one image** serve both
  services. They differ only by command. The hosted runner (Phase 9 B1,
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

Build stage (`node:22-slim`, pinned). Nothing from this stage ships.
`npm ci --ignore-scripts`, then `npm run typecheck`, `npm test`,
`npm run build:cli` (the CLI bundle, B1), and `node sandbox/build-server.mjs`
(the arena-server bundle).

Runtime stage (`gcr.io/distroless/nodejs22-debian12:nonroot`, pinned):

| Path | What |
|---|---|
| `/app/agent-arena.cjs` | The CLI bundle. This is the entrypoint: `run`, `verify`, `serve-reference`, `--version`. |
| `/app/arena-server.mjs` | The arena-server bundle (passports, gateway and arena planes). |
| `/app/healthcheck.mjs` | The `HEALTHCHECK` probe for `GET 127.0.0.1:<port>/healthz`. The image has no shell and no curl. |
| `/app/contracts/schemas/`, `/app/contracts/CHANGELOG.md` | The JSON Schemas and the contracts changelog, for the arena server, which finds them by walking up from `/app`. The CLI uses its embedded copy. The image does **not** set `WOT_CONTRACTS_DIR`: the hosted contract requires it to be absent. |
| `/app/LICENSE`, `/app/NOTICE`, `/app/THIRD_PARTY_LICENSES*.txt` | Licences, including every npm package bundled into either file. |

It contains no `node_modules`, no sources, no shell, no package manager, no
identity SDK and **no secrets or dev switches**. It runs as uid `65532`. Compose
runs every container `read_only` with `cap_drop: [ALL]`,
`no-new-privileges` and a 64 MB `noexec` tmpfs on `/tmp`.

`firebase-admin` is left out on purpose (EXTRACTION §10). Without
`WOT_DEV_AUTH=1`, registration therefore always fails closed with 401.

The build context is the directory holding `package.json` and `packages/`.
`contracts/` always goes in as the named context `contracts`
(`additional_contexts`, `ARENA_CONTRACTS_CONTEXT`, relative to `sandbox/`):

- In the public repo it is `../contracts`, which is the compose default.
- In the nested source layout it is `../../contracts`, because `contracts/` sits beside
  `ascension/`, outside the context.

`gen-env.sh` writes the right value into `.env`, and adds it to an older `.env`
that lacks it. `verify.sh` computes it on every run. The public layout needs
the named context too, because `.dockerignore` drops `**/*.md` from the main
context and the contract tests read `contracts/*.md`. `.dockerignore` keeps `.git`, `node_modules`, `dist`, `*.md`, `.env*`,
`.dev-keys`, keys and service-account JSON out of every layer.

## Environment (`.env`, from `.env.example`)

| Var | Sandbox value | Purpose |
|---|---|---|
| `WOT_ENV` | `development` | Fails closed: only `development` or `test` enable dev paths. Unset or any other value means production. |
| `WOT_DEV_AUTH` | `1` | Registration bypass for dial-in agents. The owner comes from the `x-dev-owner` header. The server **refuses to start** with this set unless `WOT_ENV=development\|test`. |
| `WOT_DEV_OWNER` | `own_dev` | Fallback owner when `x-dev-owner` is absent. |
| `WOT_SECRET_PEPPER` | generated | HMAC pepper for client-secret hashing. Required in production. If empty in development, a random per-process pepper is used. |
| `WOT_JWT_PRIVATE_JWK` | generated | Ed25519 private JWK that signs access tokens. Required in production. If empty in development, an ephemeral key is generated in tmpfs. |

The compose file sets these (you normally leave them alone):
`WOT_HOST=0.0.0.0` (inside the container; exposure is decided by the
`127.0.0.1` publish), `WOT_PORT=8080`,
`WOT_PUBLIC_WS_ORIGIN=ws://localhost:8080`, and `ARENA_HEALTH_PORT`.

Compose-level knobs:

| Var | Default | Purpose |
|---|---|---|
| `ARENA_IMAGE` | `agent-arena:local` | Use a published image (by digest) instead of building. |
| `ARENA_TARGET_POLICY` | `coordinated` | Reference policy for `target`. `naive` gives the WIPE half. |
| `ARENA_CONTRACTS_CONTEXT` | `../contracts` (from `.env`: computed by `gen-env.sh`) | Where `contracts/` is, relative to `sandbox/`. `../contracts` in the public repo, `../../contracts` in the private one. |
| `ARENA_OUT_DIR` | `./out` | Report output for the `run` service. |
| `ARENA_UID`, `ARENA_GID` | `65532` | User for `run`. `verify.sh` sets your own uid so `./out` is yours. |
| `ARENA_VERSION`, `ARENA_REVISION` | `0.0.0-dev`, `unknown` | OCI labels. |

## Dial-in plane (agents that connect to the arena)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/healthz` | none |
| `POST` | `/v1/agents`, `/v1/agents/{client_id}/rotate`; `DELETE /v1/agents/{client_id}` | Architect JWT (`architectBearer`) or dev-auth |
| `POST` | `/v1/oauth/token`, `/v1/oauth/token/exchange` (squad delegation) | client credentials |
| `GET` | `/.well-known/jwks.json` | public |
| `POST` | `/v1/queue` | `at+jwt`, `play:duel` |
| `GET` | `/v1/matches/{id}`, `/v1/replays/{id}` | `at+jwt`, `spectate:read` |
| `GET/POST` | `/v1/raids/bosses`, `/v1/raids/queue`, `/v1/raids/{id}`, `/v1/squads/{id}` | per route |
| `POST/GET` | `/v1/negotiations...` | `at+jwt` |
| `GET/POST/DELETE` | `/v1/webhooks...` | Architect JWT (`architectBearer`) or dev-auth |
| `WSS` | `/v1/arena`, `/v1/raid` | token in `hello` |

```bash
curl -s 127.0.0.1:8080/v1/agents -H 'content-type: application/json' -H 'x-dev-owner: own_dev' \
  -d '{"display_name":"Reflex Prime","league":"core"}'            # client_id + client_secret (once)
curl -s 127.0.0.1:8080/v1/oauth/token -d grant_type=client_credentials -d client_id=cid_... -d client_secret=wotk_sk_...
```

Without Docker, from `ascension/`: `npm run demo` (dev-auth on), `npm run dev`
(fail-closed) and `npm run demo:match` (two passported agents play a full duel
over the WSS plane: the dial-in smoke test). These use the same
`sandbox/index.ts` through `tsx`.

## Troubleshooting and failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `env file .../sandbox/.env not found` | `.env` was never created. Compose refuses on purpose. | `./gen-env.sh` |
| `bind: address already in use` on 8080 or 8081 | Another process (often `npm run demo`) holds the port. | Stop it, or edit the host side of `ports:` (for example `127.0.0.1:18080:8080`). Keep `127.0.0.1`. |
| `Refusing to start with the human-auth bypass on` | `WOT_DEV_AUTH=1` without `WOT_ENV=development\|test`. This is intended (G-1). | For the local sandbox, set `WOT_ENV=development` in `.env`. Otherwise unset `WOT_DEV_AUTH`. |
| `WOT_SECRET_PEPPER is required in production` / `WOT_JWT_PRIVATE_JWK is required in production` | `WOT_ENV` is unset or not a dev value, and a secret is missing. Fail-closed (G-4). | `./gen-env.sh --force`, or supply both secrets from your secret store. |
| Passports minted earlier stop working | The pepper or key changed (`gen-env.sh --force`, or empty values in dev mode, which regenerate on every restart). | Re-register. Stores are in memory; nothing persists across restarts anyway. |
| `POST /v1/agents` returns 401 | Dev-auth is off, and no Architect JWKS is configured (`WOT_ARCHITECT_JWKS*` + `WOT_ARCHITECT_ISS`). | Set `WOT_DEV_AUTH=1` (with `WOT_ENV=development`). |
| `arena`/`target` never become healthy | The process crashed at startup. Read `docker compose logs arena target`. | See the rows above. `--wait-timeout` is 90 s in `verify.sh`. |
| The `run` container cannot reach the target, or the CLI says the address is blocked | `--target` was a hostname (`http://target:8081`). | Use `http://127.0.0.1:8081`. `run` shares the target's netns. |
| `EACCES` writing `./out` | `run` ran as uid 65532 into a directory you own. | Use `verify.sh` (it passes your uid), or `ARENA_UID=$(id -u) ARENA_GID=$(id -g)`. |
| `npm ci` fails in the build: lockfile out of sync | `package.json` and `package-lock.json` disagree, for example a new workspace without a lockfile update. | Run `npm install` in `ascension/` and commit the lockfile. The image never uses `npm install`. |
| Build fails at `npm run build:cli` | The CLI (B1) script is missing. | See "Status". |
| `EROFS` in logs | Something tried to write outside `/tmp`. The FS is read-only by design. | File a bug. Nothing in the image may write elsewhere. |
| Anchor `MISMATCH` | The engine, a scenario or the Node runtime changed a replay. | Treat it as a determinism regression, not a flaky test. A re-freeze is a documented, versioned rule change (`anchors.ts` header). |
| `anchors-json: DRIFT` (build step or `verify.sh`) | `anchors.ts` was re-frozen, but `sandbox/anchors.json` was not regenerated. | `npx tsx sandbox/anchors-json.ts --write`, then review the diff: every changed hash is a re-freeze. |
| `failed to solve: ... contracts: not found`, or `contracts/ build context not found` | `ARENA_CONTRACTS_CONTEXT` points at the other layout, for example from an old `.env` or a copied command line. | `./gen-env.sh` (it fixes an old `.env` without touching the secrets), or unset the variable and use `verify.sh`. |
| `IMAGE ENV FAIL: ... WOT_CONTRACTS_DIR` (or another name) | An `ENV` line in `sandbox/Dockerfile` sets a variable the hosted runner must not see, so `run --hosted` would refuse with `(environment)`. | Remove it from the runtime stage. Set it per service in compose if the sandbox really needs it. |
| `check-anchors: cannot read anchors` | `sandbox/anchors.json` is missing. | Restore it from git, or run `anchors-json.ts --write`. |

Never paste the output of `docker compose config` or `docker inspect` into an
issue or CI log. Both expand `.env`, including the pepper and the signing key.
`verify.sh` never calls them.

## Files

| File | Role |
|---|---|
| `Dockerfile` | Multi-stage build to distroless runtime. The one image. |
| `docker-compose.yml` | `arena`, `target`, and the `run` profile. |
| `.env.example`, `gen-env.sh` | Template and generator for `.env`. The secrets live only in `.env` (gitignored and dockerignored). |
| `verify.sh`, `check-anchors.mjs` | End-to-end check and anchor comparison (plain Node, no imports beyond `node:fs`). |
| `check-image-env.mjs` | Asserts the image's default env against the hosted must-be-absent list. |
| `anchors.json`, `anchors-json.ts` | Data copy of the frozen anchors, and its generator and drift check (`--write` / `--check`). |
| `build-server.mjs` | esbuild bundle of the arena server, plus its third-party licence file. |
| `healthcheck.mjs` | The shell-less `HEALTHCHECK` probe. |
| `index.ts` | `startDevServer`: passports + gateway + arena planes on one port, `/healthz`. Also used by `qa/gate.ts`. |
| `dev-server.ts` | Process entry (bundled as `arena-server.mjs`; `npm run dev`/`demo`). |
| `demo-match.ts` | Dial-in smoke test (`npm run demo:match`). |

### After the B0 cut: what left `sandbox/` and what stayed

Numbers are lines removed or added in `sandbox/`, from `git log --stat`.

| File | Fate | Commit (numstat, `sandbox/` only) |
|---|---|---|
| `showcase-loop.ts` | **deleted** (-591) | `4289205` B0-3 `cut showcase+prod-web` |
| `prod-server.ts` | **deleted** (-120) | `4289205` B0-3 |
| `Dockerfile.web` | **deleted** (-69; it also copied `docs/economy/params.ts`) | `4289205` B0-3 |
| `demo-spectate.ts` | **deleted** (-179) | `6c4074c` B0-21 `cut live-spectator` |
| `index.ts` | **trimmed**: showcase option (B0-3, -36) and the quest-projection feed (B0-11, +4/-32). B1a-1 and B1a-2 added the dev-auth start refusal and the loopback bind. In B4 it moved to static imports (so it can be bundled), gained `/healthz`, and now closes the arena handles on shutdown. | `4289205`, `e20eee8`, `75483cc`, `af26f77`; B4 |
| `dev-server.ts` | **kept** and touched only lightly (B0-20 ±1, B0-21 -2, B1a-1 +2/-1). Bundled as `/app/arena-server.mjs`. | — |
| `demo-match.ts` | **kept** in B4. The root script `demo:match` uses it, and it is the only standalone smoke test of the retained dial-in plane (passports, queue, WSS duel, replay). It goes when `agent-arena run` covers a dial-in duel and the root script is removed. | — |
| `Dockerfile`, `docker-compose.yml`, `README.md` | **rewritten** in B4. | B4 |
| "Cost control: GCP billing budget" section | **removed from `sandbox/`** in B4. It describes the owner's GCP project, and `sandbox/**` is exported to the public repo. The text is in git history (`git show 3b62219:ascension/sandbox/README.md`) and still has to land in the private repo's `docs/ops/`. | B4 |

B0 removed 1,025 lines from `sandbox/` in total (4289205: -816, e20eee8: -28 net,
b652ee3: 0, 6c4074c: -181).

## Status (2026-09-26)

- **Executed here:**
  - The arena server: a cold build with tests; compose hardening; `/healthz`
    and the image HEALTHCHECK; loopback-only publish; read-only FS (`EROFS`);
    a full passported WSS duel against the container; and all three
    fail-closed paths (dev-auth outside development, production without
    secrets, missing `.env`).
  - End to end with the in-progress B1 CLI (`serve-reference`, `run`) from a
    scratch copy of the working tree: `verify.sh` exited 0 in 26 s, with 5/5
    hashes equal to the frozen anchors, `report.json` + `report.sarif`
    written, and no secret in the log or the outputs.
- **Not yet green in the real tree:** at the time of writing, `npm ci` fails
  because `package-lock.json` lacks the new `@sixi4ai/agent-arena` workspace, and
  `npm test` has 10 failures in `arena-scenarios`/`arena-report`, which other
  agents are still changing. The image build refuses both by design. Once B1
  and B2 commit a synced lockfile and a green tree, `./verify.sh` needs no
  changes.
