#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# wait-for-in-cluster-services.sh — assert every k8s Deployment the flight
# just promoted has rolled to its new ReplicaSet AND the old pods have
# left the Service's endpoints. Complements the HTTPS /readyz probes in
# wait-for-candidate-ready.sh, which are served by any pod still in
# endpoints (old or new) and so do not verify a rollout actually completed.
# See docs/spec/ci-cd.md → "Minimum Authoritative Validation".
#
# Two gates per routed node-app service (bug.0331):
#   1. new-RS availability — updatedReplicas + availableReplicas reached desired
#   2. endpoint cutover    — Service's .subsets.addresses count matches
#                             deployment desired replicas (terminating-but-still-
#                             routable old pod has left EndpointSlice)
#
# Without gate 2 for node-apps, downstream HTTPS probes can land on a Terminating pod
# during the up-to-terminationGracePeriodSeconds window, causing
# verify-buildsha to read the previous deploy's /version.buildSha and fail
# the flight even though the deploy is correct.
#
# Worker-only services such as scheduler-worker still need gate 1, but do not
# need endpoint cutover: their ClusterIP service exposes health only, not user
# traffic, and old Temporal workers can take longer than 5m to drain cleanly.
#
# Env:
#   VM_HOST                  (required) SSH target for the candidate VM
#   DEPLOY_ENVIRONMENT       (required) candidate-a | preview | production
#   SSH_KEY                  (optional, default ~/.ssh/deploy_key) SSH identity
#   ROLLOUT_TIMEOUT          (optional, default 300) seconds per deployment
#                             for new-RS availability
#   ENDPOINT_CUTOVER_TIMEOUT (optional, default 60) seconds per service
#                             for the post-rollout endpoint cutover wait.
#                             60s comfortably covers the default 30s
#                             terminationGracePeriodSeconds.
#   PROMOTED_APPS            (required) CSV of node names whose Deployments
#                             this run promoted (e.g. "poly", "operator,resy").
#                             Per-node matrix cells pass their single
#                             matrix.node value. Empty/unset is rejected —
#                             callers with no promotions must skip the step,
#                             not silent-pass it (Axiom 11).
#
# Adds: extend the case statement below when a new in-cluster deployment
# needs gating. Promotion to a `k8s_deployment` field on infra/catalog/*.yaml
# (CATALOG_IS_SSOT, axiom 16) is the right home if/when a fifth node lands.

set -euo pipefail

VM_HOST="${VM_HOST:?VM_HOST required}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT required}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deploy_key}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300}"
ENDPOINT_CUTOVER_TIMEOUT="${ENDPOINT_CUTOVER_TIMEOUT:-60}"

SSH_OPTS=(
  -i "$SSH_KEY"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=30
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=6
)

IFS=',' read -ra _NODES <<< "${PROMOTED_APPS:?PROMOTED_APPS required (CSV of node names)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

is_node_target() {
  local candidate="$1" node
  for node in "${NODE_TARGETS[@]}"; do
    if [ "$candidate" = "$node" ]; then
      return 0
    fi
  done
  return 1
}

SERVICES=()
for node in "${_NODES[@]}"; do
  case "$node" in
    scheduler-worker) SERVICES+=("scheduler-worker") ;;
    *)
      if is_node_target "$node"; then
        SERVICES+=("${node}-node-app")
      else
        echo "::error::wait-for-in-cluster-services: unknown node '$node' in PROMOTED_APPS"
        exit 1
      fi
      ;;
  esac
done

if [ ${#SERVICES[@]} -eq 0 ]; then
  echo "::error::wait-for-in-cluster-services: PROMOTED_APPS resolved to zero services"
  exit 1
fi

NS="cogni-${DEPLOY_ENVIRONMENT}"

# Endpoint cutover wait: poll Service endpoints until the address count
# equals deployment desired replicas exactly. During a RollingUpdate with
# maxSurge=1, count goes desired → desired+1 (old+new both ready) → desired
# (old removed from EndpointSlice). Strict equality is required:
#   count > desired → cutover in progress (old pod still routable)
#   count == desired → cutover complete (success)
#   count < desired → service degraded (pods missing from endpoints) — NOT
#                     success; an upstream rollout-status that reported
#                     Ready followed by a service with fewer endpoints than
#                     desired indicates a real problem and should fail loud.
# The dot-counter (jsonpath emits one '.' per Ready address) is jq-free
# so it works on the candidate VM (jq is not installed there).
wait_for_endpoint_cutover() {
  local svc="$1"
  local desired
  desired=$(ssh "${SSH_OPTS[@]}" "root@${VM_HOST}" \
    "kubectl -n ${NS} get deploy ${svc} -o jsonpath='{.spec.replicas}'")
  if [ -z "$desired" ] || [ "$desired" -le 0 ]; then
    echo "  ⚠ ${svc}: desired replicas unset or zero — skipping endpoint cutover wait"
    return 0
  fi

  local deadline=$((SECONDS + ENDPOINT_CUTOVER_TIMEOUT))
  local count=-1
  while [ "$SECONDS" -lt "$deadline" ]; do
    count=$(ssh "${SSH_OPTS[@]}" "root@${VM_HOST}" \
      "kubectl -n ${NS} get endpoints ${svc} -o jsonpath='{range .subsets[*].addresses[*]}.{end}' 2>/dev/null | tr -cd '.' | wc -c | tr -d ' '" \
      || echo "-1")
    if [ "$count" -eq "$desired" ]; then
      echo "  ✓ ${svc}: endpoints=${count} == desired=${desired} (rollout cutover complete)"
      return 0
    fi
    sleep 2
  done

  if [ "$count" -lt 0 ]; then
    echo "  ✗ ${svc}: endpoint cutover gate failed — kubectl get endpoints unreachable via SSH after ${ENDPOINT_CUTOVER_TIMEOUT}s"
  elif [ "$count" -gt "$desired" ]; then
    echo "  ✗ ${svc}: endpoint cutover timed out after ${ENDPOINT_CUTOVER_TIMEOUT}s — endpoints=${count} > desired=${desired} (old pod still routable; check terminationGracePeriodSeconds or finalizers)"
  else
    echo "  ✗ ${svc}: endpoint cutover failed after ${ENDPOINT_CUTOVER_TIMEOUT}s — endpoints=${count} < desired=${desired} (service degraded; pods missing from EndpointSlice despite kubectl rollout status returning Ready)"
  fi
  return 1
}

wait_for_new_rs_available() {
  local svc="$1"
  local deadline=$((SECONDS + ROLLOUT_TIMEOUT))
  local observed generation desired updated available

  while [ "$SECONDS" -lt "$deadline" ]; do
    read -r observed generation desired updated available < <(
      ssh "${SSH_OPTS[@]}" "root@${VM_HOST}" \
        "kubectl -n ${NS} get deploy ${svc} -o jsonpath='{.status.observedGeneration} {.metadata.generation} {.spec.replicas} {.status.updatedReplicas} {.status.availableReplicas}'" \
        2>/dev/null || true
    )

    observed="${observed:-0}"
    generation="${generation:-0}"
    desired="${desired:-0}"
    updated="${updated:-0}"
    available="${available:-0}"

    if [ "$desired" -le 0 ]; then
      echo "  ⚠ ${svc}: desired replicas unset or zero — skipping new-RS availability wait"
      return 0
    fi

    if [ "$observed" -ge "$generation" ] && [ "$updated" -ge "$desired" ] && [ "$available" -ge "$desired" ]; then
      echo "  ✓ ${svc}: new ReplicaSet available (updated=${updated}, available=${available}, desired=${desired})"
      return 0
    fi

    sleep 2
  done

  echo "  ✗ ${svc}: new ReplicaSet availability timed out after ${ROLLOUT_TIMEOUT}s — observed=${observed:-?}, generation=${generation:-?}, updated=${updated:-?}, available=${available:-?}, desired=${desired:-?}"
  return 1
}

FAILED=0
for svc in "${SERVICES[@]}"; do
  echo "⏳ wait for deployment/${svc} new ReplicaSet availability -n ${NS} (timeout ${ROLLOUT_TIMEOUT}s)"
  if ! wait_for_new_rs_available "$svc"; then
    FAILED=1
    continue
  fi
  if [ "$svc" = "scheduler-worker" ]; then
    echo "  ✓ ${svc}: skipping endpoint cutover wait (health-only worker Service)"
    continue
  fi
  if ! wait_for_endpoint_cutover "$svc"; then
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "❌ one or more services failed endpoint cutover — old pod still routable"
  exit 1
fi

echo "✅ all in-cluster services Ready and endpoints cut over to new pods"
