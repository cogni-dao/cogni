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
#   SCHEDULER_EXPECTED_SHA    required when scheduler-worker is promoted in a
#                             candidate flight; exact 40-char image build SHA.
#   SCHEDULER_EXPECTED_DIGEST required with SCHEDULER_EXPECTED_SHA; sha256:...
#                             from the promoted overlay/payload.
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
  local observed generation desired updated available revision new_available

  while [ "$SECONDS" -lt "$deadline" ]; do
    read -r observed generation desired updated available revision < <(
      ssh "${SSH_OPTS[@]}" "root@${VM_HOST}" \
        "kubectl -n ${NS} get deploy ${svc} -o jsonpath='{.status.observedGeneration} {.metadata.generation} {.spec.replicas} {.status.updatedReplicas} {.status.availableReplicas} {.metadata.annotations.deployment\\.kubernetes\\.io/revision}'" \
        2>/dev/null || true
    )
    new_available="$(
      ssh "${SSH_OPTS[@]}" "root@${VM_HOST}" \
        "kubectl -n ${NS} get rs -o json | jq -r --arg deployment '${svc}' --arg revision '${revision:-}' '[.items[] | select(any(.metadata.ownerReferences[]?; .kind == \"Deployment\" and .name == \$deployment)) | select(.metadata.annotations[\"deployment.kubernetes.io/revision\"] == \$revision) | (.status.availableReplicas // 0)] | max // 0'" \
        2>/dev/null || printf '0'
    )"

    observed="${observed:-0}"
    generation="${generation:-0}"
    desired="${desired:-0}"
    updated="${updated:-0}"
    available="${available:-0}"
    new_available="${new_available:-0}"

    if [ "$desired" -le 0 ]; then
      echo "  ⚠ ${svc}: desired replicas unset or zero — skipping new-RS availability wait"
      return 0
    fi

    if [ "$observed" -ge "$generation" ] && [ "$updated" -ge "$desired" ] && [ "$new_available" -ge "$desired" ]; then
      echo "  ✓ ${svc}: new ReplicaSet available (updated=${updated}, newRsAvailable=${new_available}, desired=${desired}, revision=${revision:-?})"
      return 0
    fi

    sleep 2
  done

  echo "  ✗ ${svc}: new ReplicaSet availability timed out after ${ROLLOUT_TIMEOUT}s — observed=${observed:-?}, generation=${generation:-?}, updated=${updated:-?}, deploymentAvailable=${available:-?}, newRsAvailable=${new_available:-?}, desired=${desired:-?}, revision=${revision:-?}"
  return 1
}

verify_scheduler_identity() {
  local expected_sha="${SCHEDULER_EXPECTED_SHA:-}"
  local expected_digest="${SCHEDULER_EXPECTED_DIGEST:-}"
  if [ -z "$expected_sha" ] && [ -z "$expected_digest" ]; then
    echo "  ℹ scheduler-worker: exact /version identity not requested by this caller"
    return 0
  fi
  if ! [[ "$expected_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "  ✗ scheduler-worker: SCHEDULER_EXPECTED_SHA must be 40 hex characters"
    return 1
  fi
  if ! [[ "$expected_digest" =~ ^sha256:[0-9a-fA-F]{64}$ ]]; then
    echo "  ✗ scheduler-worker: SCHEDULER_EXPECTED_DIGEST must be sha256:<64 hex>"
    return 1
  fi

  local deadline=$((SECONDS + ROLLOUT_TIMEOUT))
  local attempts=0 identities="" actual_sha="" actual_digest="" pod_ip="" body=""
  local ready_count=0 mismatches=0
  expected_sha="$(printf '%s' "$expected_sha" | tr '[:upper:]' '[:lower:]')"
  expected_digest="$(printf '%s' "$expected_digest" | tr '[:upper:]' '[:lower:]')"
  while :; do
    attempts=$((attempts + 1))
    # Probe every scheduler-worker pod with an assigned IP directly. A NodePort
    # request can randomly hit one new replica while an old worker is still
    # polling Temporal; that is not an exact fleet identity proof.
    identities="$(ssh "${SSH_OPTS[@]}" "root@${VM_HOST}" \
      "for ip in \$(kubectl -n ${NS} get pods -l app.kubernetes.io/name=scheduler-worker -o jsonpath='{range .items[*]}{.status.podIP}{\"\\n\"}{end}'); do printf '%s\\t' \"\$ip\"; curl -fsS --max-time 5 \"http://\$ip:9000/version\" || printf '{}'; printf '\\n'; done" \
      2>/dev/null || true)"
    ready_count=0
    mismatches=0
    while IFS=$'\t' read -r pod_ip body; do
      [ -n "$pod_ip" ] || continue
      ready_count=$((ready_count + 1))
      read -r actual_sha actual_digest < <(
        printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(str(d.get("sha", "")).lower(), str(d.get("imageDigest", "")).lower())
except Exception:
    print("", "")'
      )
      if [ "$actual_sha" != "$expected_sha" ] || [ "$actual_digest" != "$expected_digest" ]; then
        mismatches=$((mismatches + 1))
      fi
    done <<<"$identities"
    if [ "$ready_count" -gt 0 ] && [ "$mismatches" -eq 0 ]; then
      echo "  ✓ scheduler-worker: all ${ready_count} pod(s) /version sha=${expected_sha:0:12} digest=${expected_digest:0:19} match promoted artifact (attempt ${attempts})"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "  ✗ scheduler-worker: /version fleet identity mismatch after ${ROLLOUT_TIMEOUT}s — pods=${ready_count}, mismatches=${mismatches}; expected sha=${expected_sha} digest=${expected_digest}"
      printf '%s\n' "$identities" | sed 's/^/    /'
      return 1
    fi
    sleep 2
  done
}

FAILED=0
for svc in "${SERVICES[@]}"; do
  echo "⏳ wait for deployment/${svc} new ReplicaSet availability -n ${NS} (timeout ${ROLLOUT_TIMEOUT}s)"
  if ! wait_for_new_rs_available "$svc"; then
    FAILED=1
    continue
  fi
  if [ "$svc" = "scheduler-worker" ]; then
    if ! verify_scheduler_identity; then
      FAILED=1
      continue
    fi
    echo "  ✓ ${svc}: skipping endpoint cutover wait (health-only worker Service; exact identity verified)"
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
