#!/usr/bin/env bash
# Sandbox verification: build the image, start the sandbox, run the gate-1
# evaluation from a SECOND container with the CLI inside the image, and check
# every replay hash against the frozen anchors (sandbox/anchors.json, the data
# copy of packages/arena-scenarios/src/anchors.ts; the image build fails when
# the two drift). Prints the wall-clock (gate 1: < 5 min
# from a clean clone) and the image id/digest for the hosted cross-check.
#
#   ./verify.sh                  # build agent-arena:local and verify it
#   ARENA_IMAGE=ghcr.io/rbrus/agent-arena@sha256:... ./verify.sh
#                                # verify a PUBLISHED image (no build): the
#                                # Phase 9 hosted cross-check pins this digest
#   ./verify.sh --strict-time    # also fail (exit 3) when over the time budget
#   ./verify.sh --keep           # leave the stack running afterwards
#
# Env: ARENA_OUT_DIR (default sandbox/out), ARENA_TIME_BUDGET_S (default 300),
# ARENA_CONTRACTS_CONTEXT (default: computed, ../contracts in the public repo,
# ../../contracts in the private one).
# Exit: 0 ok; 1 anchor mismatch; 2 build/start/run error; 3 over time budget
# with --strict-time. Needs only bash + docker (compose v2.24+, BuildKit).
#
# Output hygiene: nothing here prints .env; `docker compose config` is never
# called (it would expand any local .env into the log).
set -euo pipefail
cd "$(dirname "$0")"
SANDBOX_DIR=$(pwd)
ROOT_DIR=$(cd .. && pwd)

STRICT_TIME=0
KEEP=0
for a in "$@"; do
  case "$a" in
    --strict-time) STRICT_TIME=1 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "verify: unknown argument $a" >&2; exit 2 ;;
  esac
done

SEEDS='20260720,1,2,3,5'
EPISODES=5
BUDGET_S=${ARENA_TIME_BUDGET_S:-300}
export ARENA_OUT_DIR=${ARENA_OUT_DIR:-$SANDBOX_DIR/out}
ARENA_UID=$(id -u)
ARENA_GID=$(id -g)
export ARENA_UID ARENA_GID
ANCHORS="$SANDBOX_DIR/anchors.json"

# contracts/ build context (docker-compose.yml additional_contexts), relative
# to sandbox/. In-repo first, like wot-contracts contractsDir().
if [[ -z "${ARENA_CONTRACTS_CONTEXT:-}" ]]; then
  if [[ -d "$ROOT_DIR/contracts/schemas" ]]; then
    ARENA_CONTRACTS_CONTEXT=../contracts
  elif [[ -d "$ROOT_DIR/../contracts/schemas" ]]; then
    ARENA_CONTRACTS_CONTEXT=../../contracts
  fi
fi
export ARENA_CONTRACTS_CONTEXT

t0=$(date +%s)
step() { printf '\n[verify %4ss] %s\n' "$(( $(date +%s) - t0 ))" "$*"; }
fail() { echo "verify: FAIL: $*" >&2; exit "${2:-2}"; }

command -v docker >/dev/null || fail "docker not on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 not available"
[[ -f "$ANCHORS" ]] || fail "anchors not found at $ANCHORS"
if [[ -z "${ARENA_IMAGE:-}" ]]; then
  [[ -n "${ARENA_CONTRACTS_CONTEXT:-}" && -d "$SANDBOX_DIR/$ARENA_CONTRACTS_CONTEXT/schemas" ]] \
    || fail "contracts/ build context not found (tried $ROOT_DIR/contracts and $ROOT_DIR/../contracts; set ARENA_CONTRACTS_CONTEXT relative to sandbox/)"
fi

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "--- last target logs ---" >&2
    docker compose logs --no-color --tail 40 target >&2 || true
  fi
  if [[ $KEEP -eq 0 ]]; then docker compose --profile run down --remove-orphans >/dev/null 2>&1 || true; fi
  exit "$rc"
}
trap cleanup EXIT

step "env (contracts context: ${ARENA_CONTRACTS_CONTEXT:-n/a})"
# The frozen-anchor copy must match anchors.ts. The image build enforces this;
# check it here too when host deps are installed, because ARENA_IMAGE=... skips
# the build.
if [[ -x "$ROOT_DIR/node_modules/.bin/tsx" ]]; then
  "$ROOT_DIR/node_modules/.bin/tsx" "$SANDBOX_DIR/anchors-json.ts" --check || fail "sandbox/anchors.json drifted from anchors.ts" 1
fi

if [[ -n "${ARENA_IMAGE:-}" ]]; then
  step "use $ARENA_IMAGE (no build: verifying a pinned/published image)"
  docker image inspect "$ARENA_IMAGE" >/dev/null 2>&1 || docker pull "$ARENA_IMAGE" >/dev/null || fail "cannot pull $ARENA_IMAGE"
  IMAGE="$ARENA_IMAGE"
else
  step "build agent-arena:local (npm ci, typecheck, anchor self-test, CLI bundle)"
  docker compose build target || fail "image build failed"
  IMAGE=agent-arena:local
fi

IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
IMAGE_DIGEST=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$IMAGE" | sed -n 's/.*@//p')
IMAGE_NODE=$(docker run --rm --network none --entrypoint /nodejs/bin/node "$IMAGE" --version)
echo "IMAGE=$IMAGE"
echo "IMAGE_ID=$IMAGE_ID"
echo "IMAGE_DIGEST=${IMAGE_DIGEST:-<none: local build, not pushed>}"
echo "IMAGE_NODE=$IMAGE_NODE"

step "image default env has no hosted must-be-absent variable (contracts/fixtures/hosted_env.json)"
HOSTED_ENV=""
for c in "$ROOT_DIR/contracts" "$ROOT_DIR/../contracts"; do
  if [[ -f "$c/fixtures/hosted_env.json" ]]; then HOSTED_ENV="$c/fixtures/hosted_env.json"; break; fi
done
[[ -n "$HOSTED_ENV" ]] || fail "contracts/fixtures/hosted_env.json not found next to the checkout"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$SANDBOX_DIR/check-image-env.mjs:/check/check-image-env.mjs:ro" \
  -v "$HOSTED_ENV:/check/hosted_env.json:ro" \
  --entrypoint /nodejs/bin/node "$IMAGE" /check/check-image-env.mjs /check/hosted_env.json \
  || fail "the image sets a variable the hosted runner requires to be absent" 2

step "start the reference target, wait for /healthz"
docker compose up -d --wait --wait-timeout 90 target || fail "the target did not become healthy"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

step "CLI run from a second container (joins the target's netns; --target http://127.0.0.1:8081)"
rm -rf "$ARENA_OUT_DIR"; mkdir -p "$ARENA_OUT_DIR"
set +e
docker compose --profile run run --rm --no-deps run
run_rc=$?
set -e
echo "agent-arena run exit code: $run_rc (0 no findings, 1 findings, >=2 error)"
[[ $run_rc -le 1 ]] || fail "agent-arena run errored (exit $run_rc)"
[[ -s "$ARENA_OUT_DIR/report.json" ]] || fail "no report.json in $ARENA_OUT_DIR"
[[ -s "$ARENA_OUT_DIR/report.sarif" ]] || fail "no report.sarif in $ARENA_OUT_DIR"

step "compare replay hashes with the frozen anchors (sandbox/anchors.json, from the checkout)"
set +e
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$ARENA_UID:$ARENA_GID" \
  -v "$SANDBOX_DIR/check-anchors.mjs:/check/check-anchors.mjs:ro" \
  -v "$ANCHORS:/anchors/anchors.json:ro" \
  -v "$ARENA_OUT_DIR:/out:ro" \
  --entrypoint /nodejs/bin/node "$IMAGE" \
  /check/check-anchors.mjs \
  --report /out/report.json --anchors /anchors/anchors.json \
  --policy "${ARENA_TARGET_POLICY:-coordinated}" --seeds "$SEEDS" --episodes "$EPISODES"
anchors_rc=$?
set -e

elapsed=$(( $(date +%s) - t0 ))
{
  echo "IMAGE=$IMAGE"
  echo "IMAGE_ID=$IMAGE_ID"
  echo "IMAGE_DIGEST=$IMAGE_DIGEST"
  echo "IMAGE_NODE=$IMAGE_NODE"
  echo "ANCHORS_OK=$([[ $anchors_rc -eq 0 ]] && echo true || echo false)"
  echo "WALL_CLOCK_S=$elapsed"
} > "$ARENA_OUT_DIR/verify.env"
# GitHub Actions step outputs (the hosted cross-check job reads image_digest).
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "image_id=$IMAGE_ID"
    echo "image_digest=$IMAGE_DIGEST"
    echo "anchors_ok=$([[ $anchors_rc -eq 0 ]] && echo true || echo false)"
    echo "wall_clock_s=$elapsed"
  } >> "$GITHUB_OUTPUT"
fi

echo
echo "==================================================================="
printf '  wall-clock: %ss (budget %ss) %s\n' "$elapsed" "$BUDGET_S" "$([[ $elapsed -le $BUDGET_S ]] && echo OK || echo OVER)"
echo "  anchors:    $([[ $anchors_rc -eq 0 ]] && echo MATCH || echo MISMATCH)"
echo "  report:     $ARENA_OUT_DIR/report.json, report.sarif, verify.env"
echo "==================================================================="
[[ $anchors_rc -eq 0 ]] || exit 1
if [[ $STRICT_TIME -eq 1 && $elapsed -gt $BUDGET_S ]]; then exit 3; fi
exit 0
