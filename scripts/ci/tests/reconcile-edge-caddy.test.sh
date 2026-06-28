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

# Fake `docker compose …`: report caddy running by default, succeed on
# up/exec reload by default, and optionally fail readiness/reload for regression
# cases.
FAKE_COMPOSE="$TMPROOT/fake-compose.sh"
cat > "$FAKE_COMPOSE" <<'EOF'
#!/usr/bin/env bash
args="$*"
log_file="${FAKE_COMPOSE_LOG:?FAKE_COMPOSE_LOG required}"
case "$args" in
  *" ps "*|*" ps")
    if [[ "${FAKE_CADDY_RUNNING:-1}" == "0" ]]; then
      exit 0
    fi
    echo "fakecaddyid"
    exit 0
    ;;
  *" exec -T caddy wget "*)
    count_file="${FAKE_ADMIN_COUNT_FILE:?FAKE_ADMIN_COUNT_FILE required}"
    count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1))
    echo "$count" > "$count_file"
    echo "admin-probe:$count" >> "$log_file"
    if [[ "$count" -le "${FAKE_ADMIN_FAILS:-0}" ]]; then
      exit 1
    fi
    exit 0
    ;;
  *" exec -T caddy caddy reload "*)
    echo "reload" >> "$log_file"
    if [[ "${FAKE_RELOAD_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    exit 0
    ;;
  *" up -d --force-recreate caddy"*)
    echo "recreate" >> "$log_file"
    exit 0
    ;;
  *" up -d"*)
    echo "start" >> "$log_file"
    exit 0
    ;;
esac
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
FAKE_COMPOSE_LOG="$TMPROOT/fake-compose.log" \
FAKE_ADMIN_COUNT_FILE="$TMPROOT/admin-count" \
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

echo "stale-caddy-hash-2" > "$HASH_DIR/caddyfile.sha256"
rm -f "$TMPROOT/admin-count" "$TMPROOT/fake-compose-delayed.log"

set +e
FAKE_COMPOSE_LOG="$TMPROOT/fake-compose-delayed.log" \
FAKE_ADMIN_COUNT_FILE="$TMPROOT/admin-count" \
FAKE_ADMIN_FAILS=2 \
CADDY_ADMIN_WAIT_ATTEMPTS=5 \
CADDY_ADMIN_WAIT_SLEEP_SECONDS=0 \
EDGE_COMPOSE_BIN="$FAKE_COMPOSE compose --project-name cogni-edge" \
CADDYFILE="$CADDYFILE" \
EDGE_ENV_FILE="$EDGE_ENV" \
HASH_DIR="$HASH_DIR" \
  bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
rc=$?
set -e

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL: reconcile-edge-caddy exited $rc instead of retrying delayed Caddy admin readiness" >&2
  exit 1
fi

if [[ "$(cat "$TMPROOT/admin-count")" -ne 3 ]]; then
  echo "FAIL: expected delayed admin probe to retry until third attempt; got $(cat "$TMPROOT/admin-count") attempts" >&2
  exit 1
fi

if ! grep -q '^reload$' "$TMPROOT/fake-compose-delayed.log"; then
  echo "FAIL: caddy reload did not run after delayed admin readiness succeeded" >&2
  exit 1
fi

echo "stale-caddy-hash-timeout" > "$HASH_DIR/caddyfile.sha256"
rm -f "$TMPROOT/admin-count" "$TMPROOT/fake-compose-timeout.log"

set +e
FAKE_COMPOSE_LOG="$TMPROOT/fake-compose-timeout.log" \
FAKE_ADMIN_COUNT_FILE="$TMPROOT/admin-count" \
FAKE_ADMIN_FAILS=99 \
CADDY_ADMIN_WAIT_ATTEMPTS=3 \
CADDY_ADMIN_WAIT_SLEEP_SECONDS=0 \
EDGE_COMPOSE_BIN="$FAKE_COMPOSE compose --project-name cogni-edge" \
CADDYFILE="$CADDYFILE" \
EDGE_ENV_FILE="$EDGE_ENV" \
HASH_DIR="$HASH_DIR" \
  bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
rc=$?
set -e

if [[ "$rc" -eq 0 ]]; then
  echo "FAIL: reconcile-edge-caddy succeeded even though Caddy admin never became ready" >&2
  exit 1
fi

if [[ "$(cat "$TMPROOT/admin-count")" -ne 3 ]]; then
  echo "FAIL: expected admin readiness timeout after 3 attempts; got $(cat "$TMPROOT/admin-count") attempts" >&2
  exit 1
fi

if grep -q '^reload$' "$TMPROOT/fake-compose-timeout.log"; then
  echo "FAIL: caddy reload ran before admin readiness was proven" >&2
  exit 1
fi

if [[ "$(cat "$HASH_DIR/caddyfile.sha256")" != "stale-caddy-hash-timeout" ]]; then
  echo "FAIL: caddyfile hash was persisted despite admin readiness timeout" >&2
  exit 1
fi

echo "stale-caddy-hash-bad-config" > "$HASH_DIR/caddyfile.sha256"
rm -f "$TMPROOT/admin-count" "$TMPROOT/fake-compose-bad-config.log"

set +e
FAKE_COMPOSE_LOG="$TMPROOT/fake-compose-bad-config.log" \
FAKE_ADMIN_COUNT_FILE="$TMPROOT/admin-count" \
FAKE_RELOAD_FAIL=1 \
CADDY_ADMIN_WAIT_ATTEMPTS=3 \
CADDY_ADMIN_WAIT_SLEEP_SECONDS=0 \
EDGE_COMPOSE_BIN="$FAKE_COMPOSE compose --project-name cogni-edge" \
CADDYFILE="$CADDYFILE" \
EDGE_ENV_FILE="$EDGE_ENV" \
HASH_DIR="$HASH_DIR" \
  bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
rc=$?
set -e

if [[ "$rc" -eq 0 ]]; then
  echo "FAIL: reconcile-edge-caddy succeeded even though caddy reload rejected the config" >&2
  exit 1
fi

if ! grep -q '^reload$' "$TMPROOT/fake-compose-bad-config.log"; then
  echo "FAIL: caddy reload was not attempted after admin readiness succeeded" >&2
  exit 1
fi

if [[ "$(cat "$HASH_DIR/caddyfile.sha256")" != "stale-caddy-hash-bad-config" ]]; then
  echo "FAIL: caddyfile hash was persisted despite failed caddy reload" >&2
  exit 1
fi

rm -f "$TMPROOT/admin-count" "$TMPROOT/fake-compose-start.log"

set +e
FAKE_COMPOSE_LOG="$TMPROOT/fake-compose-start.log" \
FAKE_ADMIN_COUNT_FILE="$TMPROOT/admin-count" \
FAKE_CADDY_RUNNING=0 \
FAKE_ADMIN_FAILS=2 \
CADDY_ADMIN_WAIT_ATTEMPTS=5 \
CADDY_ADMIN_WAIT_SLEEP_SECONDS=0 \
EDGE_COMPOSE_BIN="$FAKE_COMPOSE compose --project-name cogni-edge" \
CADDYFILE="$CADDYFILE" \
EDGE_ENV_FILE="$EDGE_ENV" \
HASH_DIR="$HASH_DIR" \
  bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
rc=$?
set -e

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL: reconcile-edge-caddy exited $rc instead of retrying admin readiness after starting edge stack" >&2
  exit 1
fi

if ! grep -q '^start$' "$TMPROOT/fake-compose-start.log"; then
  echo "FAIL: edge stack was not started when caddy was absent" >&2
  exit 1
fi

if [[ "$(cat "$TMPROOT/admin-count")" -ne 3 ]]; then
  echo "FAIL: expected start path to retry admin readiness until third attempt; got $(cat "$TMPROOT/admin-count") attempts" >&2
  exit 1
fi

echo "PASS: reconcile-edge-caddy.test.sh"
