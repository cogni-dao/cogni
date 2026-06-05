#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Static ESO adoption guard. App pods in active k8s envs must consume ESO-owned
# Secrets, and every overlay Secret ref must have a matching ExternalSecret leaf.
#
# Run: bash scripts/ci/tests/eso-adoption.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

ENVS=(candidate-a preview production)
fail=0

err() {
  printf 'FAIL %s\n' "$*" >&2
  fail=1
}

service_nodes() {
  for file in infra/catalog/*.yaml; do
    [ -f "$file" ] || continue
    if [ "$(yq -N '.type // ""' "$file")" = "node" ]; then
      yq -N '.name' "$file"
    fi
  done | sort -u
}

leaf_for() {
  local env="$1" service="$2"
  local infra_leaf="infra/k8s/secrets/external-secrets/$env/$service/external-secret.yaml"
  local node_leaf="nodes/$service/k8s/external-secrets/$env/external-secret.yaml"
  if [ -f "$infra_leaf" ]; then
    printf '%s\n' "$infra_leaf"
    return 0
  fi
  if [ -f "$node_leaf" ]; then
    printf '%s\n' "$node_leaf"
    return 0
  fi
  return 1
}

check_leaf() {
  local leaf="$1" env="$2" service="$3" target="$4"
  local namespace="cogni-$env"
  local key="$env/$service"
  [ "$(yq -N '.metadata.namespace // ""' "$leaf")" = "$namespace" ] \
    || err "$leaf metadata.namespace != $namespace"
  [ "$(yq -N '.spec.target.name // ""' "$leaf")" = "$target" ] \
    || err "$leaf spec.target.name != $target"
  [ "$(yq -N '.spec.dataFrom[0].extract.key // ""' "$leaf")" = "$key" ] \
    || err "$leaf dataFrom extract key != $key"
}

mapfile -t nodes < <(service_nodes)

for env in "${ENVS[@]}"; do
  for node in "${nodes[@]}"; do
    overlay="infra/k8s/overlays/$env/$node/kustomization.yaml"
    [ -f "$overlay" ] || continue
    legacy="${node}-node-app-secrets"
    target="${node}-env-secrets"
    if grep -q "$legacy" "$overlay"; then
      err "$overlay still references $legacy"
    fi
    if ! grep -q "$target" "$overlay"; then
      err "$overlay does not reference $target"
      continue
    fi
    if ! leaf="$(leaf_for "$env" "$node")"; then
      err "missing ExternalSecret leaf for $env/$node"
      continue
    fi
    check_leaf "$leaf" "$env" "$node" "$target"
  done

  sw_leaf="infra/k8s/secrets/external-secrets/$env/scheduler-worker/external-secret.yaml"
  [ -f "$sw_leaf" ] || { err "missing ExternalSecret leaf for $env/scheduler-worker"; continue; }
  check_leaf "$sw_leaf" "$env" "scheduler-worker" "scheduler-worker-secrets"
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: eso-adoption.test.sh"
