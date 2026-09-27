# syntax=docker/dockerfile:1.7
#
# agent-arena image: ONE image, two commands ("the sim is the spec").
#
#   default entrypoint   node /app/agent-arena.cjs ...    the CLI (run, verify,
#                                                          serve-reference, ...)
#   arena server         node /app/arena-server.mjs       passports + gateway +
#                                                          arena WSS dial-in planes
#
# This image is what `docker compose up` runs locally AND what the Phase 9
# hosted runner (Sixi Arena) must run, unchanged, pinned by digest. A hosted
# build that differs from this Dockerfile is a release blocker (PLAN §5 rule,
# threat-model-arena §6.1). See sandbox/README.md "Same image as hosted".
#
# Build context = the directory that holds package.json and packages/, plus
# the contracts/ directory as the named context `contracts`:
#   private repo:  ascension/   --build-context contracts=../contracts
#   public repo:   repo root    --build-context contracts=./contracts
# Compose passes it as additional_contexts (ARENA_CONTRACTS_CONTEXT, computed
# by gen-env.sh and verify.sh). Pass it in the public layout too: the main
# context's .dockerignore drops **/*.md, and tests read contracts/*.md.
#
#   docker build -f sandbox/Dockerfile -t agent-arena:local \
#     --build-context contracts=../contracts .          # from ascension/
#
# The image carries NO secrets and NO dev switches (threat-model-arena G-1/G-4):
# with WOT_ENV unset the arena server runs as production and refuses to start
# without WOT_SECRET_PEPPER + WOT_JWT_PRIVATE_JWK, and refuses WOT_DEV_AUTH=1.
# The local opt-in lives only in sandbox/.env (from .env.example).

# Base images pinned by multi-arch index digest (amd64 + arm64). Bump both
# together, deliberately: the Node major is part of the determinism contract.
ARG BUILD_IMAGE=node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

# ---------------------------------------------------------------------------
# contracts: the contract files. Normally REPLACED by `--build-context
# contracts=...` (compose sets it via additional_contexts), so the COPY below
# runs only for a bare public-layout `docker build` without the flag; that
# copy lacks contracts/*.md (.dockerignore) and the contract tests fail.
# ---------------------------------------------------------------------------
FROM scratch AS contracts
COPY contracts/ /

# ---------------------------------------------------------------------------
# build: npm ci -> typecheck -> test -> bundles. Any failure fails the image.
# ---------------------------------------------------------------------------
FROM ${BUILD_IMAGE} AS build
WORKDIR /src
ENV CI=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
COPY --from=contracts / /src/contracts/
COPY . /src/
# --ignore-scripts: no install-time code execution (threat-model-arena §7.2).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts
RUN npm run typecheck
# sandbox/anchors.json (what verify.sh checks run hashes against) must equal
# the frozen table in packages/arena-scenarios/src/anchors.ts.
RUN npx --no-install tsx sandbox/anchors-json.ts --check
# The image proves the gate self-test (decision B13, 2026-09-27): the full suite runs in CI, not
# here, because it takes ~4 min and would exceed the sandbox budget on a cold runner. This step
# runs the five gate seeds in-process and checks them against the frozen anchors.
RUN npm run build:cli \
 && node packages/arena-cli/bin/agent-arena.cjs run --scenario byzantine --seat squad --tier core \
      --seeds 20260720,1,2,3,5 --episodes 5 --target ref:coordinated --out /tmp/gate-selftest --json > /tmp/gate-selftest.json \
 && node sandbox/check-anchors.mjs --report /tmp/gate-selftest/report.json --anchors sandbox/anchors.json \
 && node packages/arena-cli/bin/agent-arena.cjs verify /tmp/gate-selftest/report.json \
 && rm -rf /tmp/gate-selftest /tmp/gate-selftest.json
# The CLI bundle (packages/arena-cli, B1; script contract EXTRACTION §9) and
# the arena-server bundle (sandbox/build-server.mjs).
RUN npm run build:cli \
 && node sandbox/build-server.mjs --outdir /out
RUN set -eu; \
    cp packages/arena-cli/dist/agent-arena.cjs /out/agent-arena.cjs; \
    cp sandbox/healthcheck.mjs /out/healthcheck.mjs; \
    mkdir -p /out/contracts && cp -r /src/contracts/schemas /out/contracts/schemas; \
    # arena-report reads the contracts release from CHANGELOG.md next to
    # schemas/ at module load (evidence.ts); the arena server reads it from here.
    cp /src/contracts/CHANGELOG.md /out/contracts/CHANGELOG.md; \
    npm run --if-present licenses:third-party -- --out /out/THIRD_PARTY_LICENSES.txt; \
    for f in LICENSE NOTICE; do \
      if [ -f "$f" ]; then cp "$f" /out/; \
      elif [ -f ".github-public/$f" ]; then cp ".github-public/$f" /out/; fi; \
    done; \
    ls -la /out

# ---------------------------------------------------------------------------
# runtime: distroless Node 22, non-root, no shell, no package manager, no
# sources, no node_modules. Compose adds read_only, cap_drop ALL and
# no-new-privileges; nothing here needs to write outside /tmp.
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="agent-arena" \
      org.opencontainers.image.description="Agent Arena: CLI runner + arena server. The same image runs the local sandbox and the hosted runner." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=build --chown=0:0 /out/ /app/
ENV NODE_ENV=production \
    WOT_HOST=0.0.0.0 \
    WOT_PORT=8080 \
    WOT_DEV_KEYS_DIR=/tmp/wot-dev-keys
# NO WOT_CONTRACTS_DIR here: it is on the hosted runner's must-be-absent list
# (contracts/fixtures/hosted_env.json), and `run --hosted` refuses when it is
# set. Neither bundle needs it: the CLI serves contracts/ from its embedded
# snapshot, and the arena server finds /app/contracts by walking up from /app.
# verify.sh asserts the image's default env against that list.
# 65532 = distroless "nonroot"; stated explicitly so a base swap cannot
# silently make the image run as root.
USER 65532:65532
EXPOSE 8080 8081
# Probes 127.0.0.1:${ARENA_HEALTH_PORT:-$WOT_PORT}/healthz; compose passes the
# port per service. Cloud Run ignores HEALTHCHECK and uses its own probe.
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=6 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/nodejs/bin/node", "/app/agent-arena.cjs"]
CMD ["--help"]
