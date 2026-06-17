#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-edge-caddy.remote.sh — VM-side edge-Caddy reconcile (one place).
#
# Runs ON THE VM. Both deploy-infra.sh (env-wide infra deploy) and
# reconcile-node-substrate.sh (per-node candidate-flight) scp this here and
# invoke it, so the start-if-down / hash-gated force-recreate logic lives once.
#
# Behavior (idempotent):
#   - caddy not running  → `<compose> up -d` (start the whole edge stack).
#   - caddy running       → hash-gate the Caddyfile + edge .env against the
#     stored sha256s in HASH_DIR; recreate caddy ONLY when one changed, then
#     persist the new hash(es). No change → no-op (no per-flight bounce).
#
# `docker compose up -d` (not `caddy reload`) is required for the recreate: a
# new node always adds a new <SLUG>_DOMAIN to the edge .env, and a graceful
# reload resolves {$<SLUG>_DOMAIN} to empty because Caddy's env is frozen at
# container start — silently dropping the new server block + its cert
# (task.5078). --force-recreate guarantees the bounce even when compose's delta
# detector doesn't classify env_file content as a change.
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

log_info "Ensuring edge stack (Caddy) is running..."
if ! "${EDGE_COMPOSE[@]}" ps -q caddy 2>/dev/null | grep -q .; then
  log_info "Starting edge stack..."
  "${EDGE_COMPOSE[@]}" up -d
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
    log_info "Edge stack config changed (caddyfile=${caddyfile_changed} env=${edge_env_changed}), recreating Caddy..."
    "${EDGE_COMPOSE[@]}" up -d --force-recreate caddy
    log_info "Caddy recreated; new env_file values + Caddyfile loaded"

    # Re-sync the on-disk Caddyfile into the running config, THEN verify, THEN
    # persist the hash. The force-recreate above loads the frozen env (the new
    # $<SLUG>_DOMAIN), but it snapshots the Caddyfile at recreate time; a new
    # node's site block can land in the Caddyfile AFTER that snapshot because the
    # per-node (reconcile-node-substrate.sh) and env-wide (deploy-infra.sh)
    # reconciles write the SAME shared Caddyfile with no lock. The reload re-reads
    # the latest on-disk file into the running config (safe: the recreate already
    # loaded the env, so {$<SLUG>_DOMAIN} resolves).
    #
    # ORDERING IS LOAD-BEARING: persist the hashes ONLY after the reload AND a
    # live-config probe both succeed. The prior bug stored the hash right after
    # the recreate, so a reload/config miss left the new site on disk but absent
    # from the running config — and every later reconcile then saw "no change",
    # never retried, and served external 000 behind a GREEN deploy forever. We now
    # fail loud (exit 1, hash NOT persisted) so the next reconcile retries and the
    # flight surfaces the failure instead of silently half-deploying.
    # (task.5078 edge-routing; healed by hand on candidate-a 2026-06-16 — a reload
    # took beacon-test from external 000 → 200 with no other change.)
    # `caddy reload` validates + atomically swaps the running config; rc 0 means
    # the new on-disk Caddyfile (incl. the new node's site block) is now live. It
    # is the reliable gate — persist the hash ONLY on its success. (A per-node
    # admin-API verify-and-heal — reusing assert-target-substrate.sh's :2019 probe
    # — is the stronger follow-up; left out here to keep this a minimal bug-fix and
    # avoid a hard dependency on a probe tool inside the caddy image.)
    if ! "${EDGE_COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
      log_warn "caddy reload FAILED — config hash NOT persisted; next reconcile will retry"
      exit 1
    fi
    log_info "Caddy reloaded; running config re-synced to on-disk Caddyfile; persisting config hash(es)"
    # Use `if` blocks, NOT `[[ cond ]] && echo`: under `set -e`, a trailing
    # `[[ false ]] && …` leaves the script's exit status at 1, which the caller's
    # `set -e` heredoc reads as a hard failure. That broke EVERY re-flight of an
    # existing node — its <SLUG>_DOMAIN is already in the edge .env so
    # edge_env_changed=false (the final command), while the shared Caddyfile
    # differs so caddyfile_changed=true and the recreate+reload path runs. The
    # reload itself succeeded; this idiom turned a successful reconcile into a
    # red flight (bug.5037).
    if [[ "$caddyfile_changed" == "true" ]]; then echo "$NEW_CADDY_HASH" > "$CADDY_HASH_FILE"; fi
    if [[ "$edge_env_changed" == "true" ]]; then echo "$NEW_EDGE_ENV_HASH" > "$EDGE_ENV_HASH_FILE"; fi
  fi
fi
