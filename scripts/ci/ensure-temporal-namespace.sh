#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/ci/ensure-temporal-namespace.sh
# Purpose: Idempotent Temporal namespace bootstrap. Creates the namespace if
#          missing, no-ops if it already exists. Waits for Temporal health first.
#
# Usage (local — SSH to VM first):
#   TEMPORAL_NAMESPACE=cogni-preview TEMPORAL_CONTAINER=cogni-runtime-temporal-1 \
#     bash scripts/ci/ensure-temporal-namespace.sh
#
# Usage (from deploy-infra.sh or provision-test-vm.sh — already on VM):
#   TEMPORAL_NAMESPACE=cogni-preview ensure_temporal_namespace
#
# Env:
#   TEMPORAL_NAMESPACE   — required, e.g. "cogni-canary", "cogni-preview", "cogni-production"
#   TEMPORAL_CONTAINER   — optional, defaults to "cogni-runtime-temporal-1"
#   TEMPORAL_TIMEOUT     — optional, seconds to wait for health (default: 60)

set -euo pipefail

NAMESPACE="${TEMPORAL_NAMESPACE:?TEMPORAL_NAMESPACE is required (e.g. cogni-preview)}"
CONTAINER="${TEMPORAL_CONTAINER:-cogni-runtime-temporal-1}"
TIMEOUT="${TEMPORAL_TIMEOUT:-60}"

log_info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }
log_warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $1"; }

# ── Step 1: Wait for Temporal to be healthy ─────────────────────────────────
log_info "Waiting for Temporal container ($CONTAINER) to be healthy (timeout: ${TIMEOUT}s)..."
elapsed=0
while true; do
  health=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "not-found")
  if [[ "$health" == "healthy" ]]; then
    log_info "Temporal is healthy"
    break
  fi
  if [[ $elapsed -ge $TIMEOUT ]]; then
    log_error "Temporal did not become healthy after ${TIMEOUT}s (status: $health)"
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# ── Step 2: Check if namespace already exists ───────────────────────────────
if docker exec "$CONTAINER" tctl --ns "$NAMESPACE" namespace describe >/dev/null 2>&1; then
  log_info "Temporal namespace '$NAMESPACE' already exists — no-op"
  exit 0
fi

# ── Step 3: Create namespace ────────────────────────────────────────────────
# Registration can return a transient DeadlineExceeded while the healthy server
# is briefly unable to commit the namespace. Re-check after every failed call to
# cover the create race, then retry the same idempotent operation before failing.
for attempt in 1 2 3; do
  log_info "Creating Temporal namespace '$NAMESPACE' (attempt ${attempt}/3)..."
  if docker exec "$CONTAINER" tctl --ns "$NAMESPACE" namespace register 2>&1; then
    log_info "Temporal namespace '$NAMESPACE' created successfully"
    exit 0
  fi

  if docker exec "$CONTAINER" tctl --ns "$NAMESPACE" namespace describe >/dev/null 2>&1; then
    log_warn "Namespace '$NAMESPACE' was created by another process — OK"
    exit 0
  fi

  if [ "$attempt" -lt 3 ]; then
    log_warn "Namespace '$NAMESPACE' registration failed transiently; retrying in 5s"
    sleep 5
  fi
done

log_error "Failed to create Temporal namespace '$NAMESPACE' after 3 attempts"
exit 1
