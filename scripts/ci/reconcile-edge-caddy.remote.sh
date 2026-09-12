#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-edge-caddy.remote.sh — VM-side edge-Caddy reconcile (one place).
#
# Runs ON THE VM. Both deploy-infra.sh (env-wide infra deploy) and
# reconcile-node-substrate.sh (per-node candidate-flight) scp this here and
# invoke it, so the start-if-down / hash-gated atomic-reload logic lives once.
#
# Behavior (idempotent):
#   - caddy not running  → `<compose> up -d` (start the whole edge stack).
#   - caddy running       → hash-gate the Caddyfile + edge .env against the
#     stored sha256s in HASH_DIR; atomically reload caddy when one changed, then
#     persist the new hash(es). No change → no-op (no per-flight bounce).
#
# The callers materialize catalog routes with current per-environment values
# before invoking this helper. The running Caddy therefore needs no env update:
# its native reload reads the complete config from stdin and atomically swaps it.
# Never recreate the sole edge process for a config change (bug.5133).
#
# Inputs (env vars):
#   EDGE_COMPOSE_BIN  Full compose invocation as a string, e.g.
#                     "docker compose --project-name cogni-edge -f /opt/.../docker-compose.yml".
#                     Each caller owns its own --env-file/--project-name shape.
#   CADDYFILE         Path to the rendered Caddyfile to hash-gate.
#   EDGE_ENV_FILE     Path to the edge .env to hash-gate.
#   HASH_DIR          Where the sha256 stamps live (default /var/lib/cogni).

set -euo pipefail

: "${EDGE_COMPOSE_BIN:?EDGE_COMPOSE_BIN required (full compose invocation string)}"
: "${CADDYFILE:?CADDYFILE required}"
: "${EDGE_ENV_FILE:?EDGE_ENV_FILE required}"
HASH_DIR="${HASH_DIR:-/var/lib/cogni}"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; }

# Portable hash function (sha256sum on Linux, shasum on macOS).
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    log_warn "No sha256 tool available, skipping config hash check"
    echo "no-hash-tool"
  fi
}

# Split the compose invocation into an argv array so quoting is correct.
read -r -a EDGE_COMPOSE <<<"$EDGE_COMPOSE_BIN"

wait_for_caddy_admin() {
  local attempts="${CADDY_ADMIN_WAIT_ATTEMPTS:-30}"
  local sleep_seconds="${CADDY_ADMIN_WAIT_SLEEP_SECONDS:-2}"
  local attempt

  log_info "Waiting for Caddy admin API..."
  for attempt in $(seq 1 "$attempts"); do
    if "${EDGE_COMPOSE[@]}" exec -T caddy wget -qO- http://127.0.0.1:2019/config/ >/dev/null 2>&1; then
      log_info "Caddy admin API is ready"
      return 0
    fi
    if [[ "$attempt" -lt "$attempts" ]]; then
      sleep "$sleep_seconds"
    fi
  done

  log_warn "Caddy admin API did not become ready after ${attempts} attempts; config hash NOT persisted"
  return 1
}

log_info "Ensuring edge stack (Caddy) is running..."
if ! "${EDGE_COMPOSE[@]}" ps -q caddy 2>/dev/null | grep -q .; then
  log_info "Starting edge stack..."
  "${EDGE_COMPOSE[@]}" up -d
  wait_for_caddy_admin
else
  log_info "Edge stack already running"

  CADDY_HASH_FILE="$HASH_DIR/caddyfile.sha256"
  EDGE_ENV_HASH_FILE="$HASH_DIR/edge.env.sha256"

  mkdir -p "$HASH_DIR"
  caddyfile_changed=false
  edge_env_changed=false

  if [[ -f "$CADDYFILE" ]]; then
    NEW_CADDY_HASH=$(hash_file "$CADDYFILE")
    OLD_CADDY_HASH=$(cat "$CADDY_HASH_FILE" 2>/dev/null || echo "none")
    if [[ "$NEW_CADDY_HASH" != "$OLD_CADDY_HASH" && "$NEW_CADDY_HASH" != "no-hash-tool" ]]; then
      caddyfile_changed=true
    fi
  fi
  if [[ -f "$EDGE_ENV_FILE" ]]; then
    NEW_EDGE_ENV_HASH=$(hash_file "$EDGE_ENV_FILE")
    OLD_EDGE_ENV_HASH=$(cat "$EDGE_ENV_HASH_FILE" 2>/dev/null || echo "none")
    if [[ "$NEW_EDGE_ENV_HASH" != "$OLD_EDGE_ENV_HASH" && "$NEW_EDGE_ENV_HASH" != "no-hash-tool" ]]; then
      edge_env_changed=true
    fi
  fi

  if [[ "$caddyfile_changed" == "true" || "$edge_env_changed" == "true" ]]; then
    log_info "Edge stack config changed (caddyfile=${caddyfile_changed} env=${edge_env_changed}); atomically reloading Caddy..."
    wait_for_caddy_admin || exit 1

    # Refuse the template here: a running container's environment is stale, so
    # parsing any {$VAR} would silently omit a newly-added route. Both callers
    # must stage the current-value output of render-caddyfile.sh --domain.
    if grep -Fq '{$' "$CADDYFILE"; then
      log_warn "Caddyfile still contains env placeholders; config hash NOT persisted"
      exit 1
    fi

    # Feed the host file over stdin instead of reading the single-file bind mount:
    # rsync/mv may replace its inode while the running container still sees the
    # old mount. `caddy reload` validates and atomically swaps through /load.
    #
    # ORDERING IS LOAD-BEARING: persist hashes ONLY after the native reload
    # succeeds. Failure leaves the old config serving and the stale hash makes
    # the next reconcile retry instead of hiding a half-deploy (task.5078).
    if ! "${EDGE_COMPOSE[@]}" exec -T caddy caddy reload --config - --adapter caddyfile < "$CADDYFILE"; then
      log_warn "caddy reload FAILED — config hash NOT persisted; next reconcile will retry"
      exit 1
    fi
    log_info "Caddy atomically reloaded from materialized config; persisting config hash(es)"
    # Use `if` blocks, NOT `[[ cond ]] && echo`: under `set -e`, a trailing
    # `[[ false ]] && …` leaves the script's exit status at 1, which the caller's
    # `set -e` heredoc reads as a hard failure. That broke EVERY re-flight of an
    # existing node — its <SLUG>_DOMAIN is already in the edge .env so
    # edge_env_changed=false (the final command), while the shared Caddyfile
    # differs and the reload succeeds (bug.5037).
    if [[ "$caddyfile_changed" == "true" ]]; then echo "$NEW_CADDY_HASH" > "$CADDY_HASH_FILE"; fi
    if [[ "$edge_env_changed" == "true" ]]; then echo "$NEW_EDGE_ENV_HASH" > "$EDGE_ENV_HASH_FILE"; fi
  fi
fi
