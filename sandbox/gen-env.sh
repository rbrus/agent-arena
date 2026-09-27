#!/usr/bin/env bash
# Create sandbox/.env from .env.example with a fresh pepper and a fresh Ed25519
# signing key. Idempotent: an existing .env is left alone unless --force.
#
#   ./gen-env.sh            # create .env if missing
#   ./gen-env.sh --force    # regenerate (invalidates passports minted before)
#
# Needs Node >= 22 on the host, or Docker (runs the pinned build base image
# with --network none). The secrets are written only to .env (mode 600) and
# never echoed.
set -euo pipefail
cd "$(dirname "$0")"

# The contracts/ build context, relative to sandbox/ (docker-compose.yml
# additional_contexts). In-repo first, as wot-contracts contractsDir() does.
if [[ -d ../contracts/schemas ]]; then
  contracts_ctx=../contracts        # public layout: <repo>/contracts
elif [[ -d ../../contracts/schemas ]]; then
  contracts_ctx=../../contracts     # private layout: <private-root>/contracts
else
  echo "gen-env: contracts/schemas not found at ../contracts or ../../contracts" >&2
  exit 2
fi

if [[ -f .env && "${1:-}" != "--force" ]]; then
  # Older .env files predate ARENA_CONTRACTS_CONTEXT: add it (not a secret).
  if ! grep -q '^ARENA_CONTRACTS_CONTEXT=.' .env; then
    tmp=$(mktemp .env.XXXXXX)
    trap 'rm -f "$tmp"' EXIT
    grep -v '^ARENA_CONTRACTS_CONTEXT=' .env > "$tmp" || true
    printf 'ARENA_CONTRACTS_CONTEXT=%s\n' "$contracts_ctx" >> "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" .env
    trap - EXIT
    echo "gen-env: .env exists; kept it and set ARENA_CONTRACTS_CONTEXT=$contracts_ctx."
  else
    echo "gen-env: .env exists; keeping it (use --force to regenerate)."
  fi
  exit 0
fi

JS='
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
jwk.kid = "key_sandbox_" + randomBytes(4).toString("hex");
jwk.alg = "EdDSA";
process.stdout.write(randomBytes(32).toString("base64url") + "\n" + JSON.stringify(jwk) + "\n");
'

if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  out=$(node -e "$JS")
elif command -v docker >/dev/null 2>&1; then
  base=$(sed -n 's/^ARG BUILD_IMAGE=//p' Dockerfile)
  out=$(docker run --rm --network none "$base" node -e "$JS")
else
  echo "gen-env: needs node (>= 18) or docker on PATH" >&2
  exit 2
fi
pepper=$(printf '%s\n' "$out" | sed -n 1p)
jwk=$(printf '%s\n' "$out" | sed -n 2p)
[[ -n "$pepper" && "$jwk" == \{* ]] || { echo "gen-env: key generation failed" >&2; exit 2; }

umask 077
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    WOT_SECRET_PEPPER=*) printf 'WOT_SECRET_PEPPER=%s\n' "$pepper" ;;
    WOT_JWT_PRIVATE_JWK=*) printf "WOT_JWT_PRIVATE_JWK='%s'\n" "$jwk" ;;
    ARENA_CONTRACTS_CONTEXT=*) printf 'ARENA_CONTRACTS_CONTEXT=%s\n' "$contracts_ctx" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > "$tmp"
mv "$tmp" .env
trap - EXIT
chmod 600 .env
echo "gen-env: wrote $(pwd)/.env (mode 600; pepper + Ed25519 key generated, not shown)."
