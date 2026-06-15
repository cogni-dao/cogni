#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# render-scheduler-worker-endpoints.sh — emit scheduler-worker node routing
# from infra/catalog/*.yaml. The worker must poll one Temporal queue per
# repo-spec UUID; adding a type:node catalog entry must therefore add both the
# slug and UUID aliases with no hand-edited endpoint string.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=scripts/ci/lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

CONFIGMAP_PATH="$REPO_ROOT/infra/k8s/base/scheduler-worker/configmap.yaml"
DEPLOYMENT_PATH="$REPO_ROOT/infra/k8s/base/scheduler-worker/deployment.yaml"
OVERLAY_ROOT="$REPO_ROOT/infra/k8s/overlays"

render() {
  node_internal_service_endpoint_csv
}

# Node routing renders from catalog metadata only. A remote-source node's catalog
# `node_id` is written at formation from the fetched repo-spec, and `node_id` is
# immutable — so catalog == repo-spec by construction. The secret-free gate never
# reads node source to "re-verify" it (spec.node-submodule-retirement,
# SECRET_FREE_CI_IS_METADATA_ONLY).
check() {
  local expected actual override_hits first_envfrom second_envfrom
  expected="$(render)"
  actual="$(yq -N '.data.COGNI_NODE_ENDPOINTS // ""' "$CONFIGMAP_PATH")"
  if [ "$actual" != "$expected" ]; then
    echo "[ERROR] $CONFIGMAP_PATH has stale COGNI_NODE_ENDPOINTS." >&2
    echo "Expected:" >&2
    echo "  $expected" >&2
    echo "Actual:" >&2
    echo "  $actual" >&2
    exit 1
  fi

  override_hits="$(grep -RInE '/data/COGNI_NODE_ENDPOINTS|COGNI_NODE_ENDPOINTS' "$OVERLAY_ROOT"/*/scheduler-worker/kustomization.yaml || true)"
  if [ -n "$override_hits" ]; then
    echo "[ERROR] scheduler-worker overlays must not override COGNI_NODE_ENDPOINTS; base config is catalog-rendered and env-invariant." >&2
    echo "$override_hits" >&2
    exit 1
  fi

  first_envfrom="$(yq -N '.spec.template.spec.containers[] | select(.name == "scheduler-worker") | .envFrom[0] | keys | .[0]' "$DEPLOYMENT_PATH")"
  second_envfrom="$(yq -N '.spec.template.spec.containers[] | select(.name == "scheduler-worker") | .envFrom[1] | keys | .[0]' "$DEPLOYMENT_PATH")"
  if [ "$first_envfrom" != "secretRef" ] || [ "$second_envfrom" != "configMapRef" ]; then
    echo "[ERROR] scheduler-worker envFrom order must be secretRef then configMapRef." >&2
    echo "ConfigMap must be applied last so catalog-rendered COGNI_NODE_ENDPOINTS cannot be shadowed by stale Secret keys." >&2
    echo "Actual first=$first_envfrom second=$second_envfrom" >&2
    exit 1
  fi
}

case "${1:-}" in
  --check)
    check
    echo "scheduler-worker endpoints are in sync with the catalog."
    ;;
  "")
    render
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac
