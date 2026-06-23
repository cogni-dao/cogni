#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-alloy-config.remote.sh — VM-side Alloy runtime-config reconcile (one place).
#
# Runs ON THE VM. Sibling to reconcile-edge-caddy.remote.sh: the same start-if-
# down / hash-gated force-recreate shape, scoped to the Alloy runtime config that
# carries the `nodeId` → `node` Loki stream-label promotion (task.5028). Both
# deploy-infra.sh (env-wide infra deploy) and reconcile-node-substrate.sh (the
# substrate-readiness lane that runs on EVERY candidate-flight + promote) invoke
# this, so the config lands current even on an app-only promote (skip_infra:true).
#
# Why this exists as its own lane: deploy-infra.sh already rsyncs the runtime
# bundle + hash-gate-restarts alloy (Step 6.6d, ~line 1428), but the promote
# pipeline SKIPS deploy-infra by default — so an app-only promote never re-pushed
# the config and a VM provisioned before task.5028 stayed stale (prod = bug.5041,
# the proxy's forced {node="<id>"} selector returned nothing). Folding the same
# rsync + checksum-restart primitive into the substrate-readiness lane (Axiom 22)
# makes the node-label config born-current on the normal flow, with no new
# workflow and no bespoke observability script.
#
# Behavior (idempotent): hash-gate the staged config against the stored sha256;
# `docker compose restart alloy` ONLY when it changed, then persist the new hash.
# No change → no-op (no per-promote bounce). The caller stages the fresh config at
# $ALLOY_CONFIG before invoking (same as deploy-infra's rsync of the runtime
# bundle); this is the restart-on-change half of that primitive.
#
# Inputs (env vars):
#   RUNTIME_COMPOSE_BIN  Full compose invocation as a string, e.g.
#                        "docker compose --project-name cogni-runtime --env-file /opt/.../.env -f /opt/.../docker-compose.yml".
#   ALLOY_CONFIG         Path to the staged alloy config to hash-gate
#                        (default /opt/cogni-template-runtime/configs/alloy-config.metrics.alloy).
#   HASH_DIR             Where the sha256 stamp lives (default /var/lib/cogni).

set -euo pipefail

: "${RUNTIME_COMPOSE_BIN:?RUNTIME_COMPOSE_BIN required (full compose invocation string)}"
ALLOY_CONFIG="${ALLOY_CONFIG:-/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy}"
HASH_DIR="${HASH_DIR:-/var/lib/cogni}"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; }

# Portable hash function (sha256sum on Linux, shasum on macOS). Mirrors
# reconcile-edge-caddy.remote.sh + deploy-infra.sh's hash_file.
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
read -r -a RUNTIME_COMPOSE <<<"$RUNTIME_COMPOSE_BIN"

if [[ ! -f "$ALLOY_CONFIG" ]]; then
  log_warn "Alloy config missing at $ALLOY_CONFIG — runtime stack may not be provisioned yet; nothing to reconcile"
  exit 0
fi

ALLOY_HASH_FILE="$HASH_DIR/alloy-config.sha256"
mkdir -p "$HASH_DIR"

NEW_ALLOY_HASH=$(hash_file "$ALLOY_CONFIG")
OLD_ALLOY_HASH=$(cat "$ALLOY_HASH_FILE" 2>/dev/null || echo "none")

if [[ "$NEW_ALLOY_HASH" != "$OLD_ALLOY_HASH" && "$NEW_ALLOY_HASH" != "no-hash-tool" ]]; then
  log_info "Alloy config changed (hash: ${NEW_ALLOY_HASH:0:12}...), restarting alloy..."
  # restart (not up -d) matches deploy-infra.sh Step 6.6d: alloy re-reads its
  # mounted config on restart. A no-op if alloy isn't up (stack down) — the
  # config is staged on disk and loads on next start.
  "${RUNTIME_COMPOSE[@]}" restart alloy
  echo "$NEW_ALLOY_HASH" > "$ALLOY_HASH_FILE"
  log_info "Alloy restarted with the current node-label config"
else
  log_info "Alloy config unchanged (hash: ${NEW_ALLOY_HASH:0:12}...), no restart needed"
fi
