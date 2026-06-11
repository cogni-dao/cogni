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

# Hard drift gate: a submodule node's catalog `node_id` is a projection of its
# minted repo-spec (the parent can't read across the gitlink at render time). This
# proves the projection has not drifted from the identity SSOT — initialise each
# submodule and assert catalog.node_id == repo-spec.node_id. REPO_SPEC_IS_IDENTITY_SSOT.
verify_projection() {
  local f name pp rs cat_nid spec_nid fail=0
  for f in "$REPO_ROOT"/infra/catalog/*.yaml; do
    [ "$(yq -N '.type // ""' "$f")" = "node" ] || continue
    cat_nid="$(yq -N '.node_id // ""' "$f")"
    [ -n "$cat_nid" ] || continue   # in-repo nodes carry no projection; read from repo-spec
    name="$(yq -N '.name' "$f")"; pp="$(yq -N '.path_prefix // ""' "$f")"
    rs="$REPO_ROOT/${pp}.cogni/repo-spec.yaml"
    if [ ! -f "$rs" ]; then
      git -C "$REPO_ROOT" submodule update --init --depth 1 "${pp%/}" >/dev/null 2>&1 || true
    fi
    if [ ! -f "$rs" ]; then
      echo "[ERROR] node_id projection for '$name' cannot be verified: repo-spec unreadable ($rs). Init the submodule in CI." >&2
      fail=1; continue
    fi
    spec_nid="$(yq -N '.node_id // ""' "$rs")"
    if [ "$cat_nid" != "$spec_nid" ]; then
      echo "[ERROR] node_id projection drift for '$name': catalog=$cat_nid repo-spec=$spec_nid (repo-spec wins)." >&2
      fail=1
    fi
  done
  [ "$fail" -eq 0 ] || exit 1
}

check() {
  local expected actual override_hits first_envfrom second_envfrom
  verify_projection
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
