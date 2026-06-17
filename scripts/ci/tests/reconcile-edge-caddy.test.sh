#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-edge-caddy.test.sh — regression guard for bug.5037.
#
# The hash-persist step used `[[ cond ]] && echo …` as the script's FINAL
# commands. Under `set -e`, a trailing `[[ false ]] && …` leaves the script's
# exit status at 1. On a re-flight of an existing node, edge_env_changed=false
# (its <SLUG>_DOMAIN is already in the edge .env) while caddyfile_changed=true
# (shared Caddyfile re-rendered) — so the reload path runs, succeeds, and then
# the trailing false test failed the whole reconcile. This asserts the script
# exits 0 in that scenario (and that the changed hash is persisted).
#
# Run: bash scripts/ci/tests/reconcile-edge-caddy.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$(cd "$SCRIPT_DIR/.." && pwd)/reconcile-edge-caddy.remote.sh"

TMPROOT=$(mktemp -d -t reconcile-edge-caddy.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Fake `docker compose …`: report caddy running, succeed on up/exec reload.
FAKE_COMPOSE="$TMPROOT/fake-compose.sh"
cat > "$FAKE_COMPOSE" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    ps) echo "fakecaddyid"; exit 0 ;;
  esac
done
exit 0
EOF
chmod +x "$FAKE_COMPOSE"

CADDYFILE="$TMPROOT/Caddyfile.tmpl"
EDGE_ENV="$TMPROOT/edge.env"
HASH_DIR="$TMPROOT/hashes"
mkdir -p "$HASH_DIR"
printf '{$OPERATOR_DOMAIN} { reverse_proxy host.docker.internal:30080 }\n' > "$CADDYFILE"
printf 'DOMAIN=test.cognidao.org\nOPERATOR_DOMAIN=test.cognidao.org\n' > "$EDGE_ENV"

# caddyfile_changed=true: stored hash differs from the rendered file.
echo "stale-caddy-hash" > "$HASH_DIR/caddyfile.sha256"
# edge_env_changed=false: stored hash MATCHES the current edge .env (re-flight
# of an existing node — its <SLUG>_DOMAIN is already present, nothing to add).
hash_file "$EDGE_ENV" > "$HASH_DIR/edge.env.sha256"

set +e
EDGE_COMPOSE_BIN="$FAKE_COMPOSE compose --project-name cogni-edge" \
CADDYFILE="$CADDYFILE" \
EDGE_ENV_FILE="$EDGE_ENV" \
HASH_DIR="$HASH_DIR" \
  bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
rc=$?
set -e

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL: reconcile-edge-caddy exited $rc when caddyfile changed but edge .env unchanged (bug.5037 regression)" >&2
  exit 1
fi

# The changed caddyfile hash must have been persisted on the successful path.
if [[ "$(cat "$HASH_DIR/caddyfile.sha256")" == "stale-caddy-hash" ]]; then
  echo "FAIL: caddyfile hash was not persisted after a successful reload" >&2
  exit 1
fi

echo "PASS: reconcile-edge-caddy.test.sh"
