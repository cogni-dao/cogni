#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Runtime routing guardrails for scheduler-worker:
#   1. COGNI_NODE_ENDPOINTS stays catalog-derived with slug + UUID aliases.
#   2. Scheduler-worker's off-cluster Temporal/Postgres/App Services point at
#      the expected VM alias for each env, so workers can actually poll Temporal.
#
# Run: bash scripts/ci/tests/scheduler-runtime-routing.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/ci/lib/image-tags.sh
source "$REPO_ROOT/scripts/ci/lib/image-tags.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok - $*"; }

echo "[1/2] scheduler endpoint map has slug + UUID aliases"
bash scripts/ci/render-scheduler-worker-endpoints.sh --check >/dev/null \
  || fail "render-scheduler-worker-endpoints.sh --check failed"

endpoints="$(yq -r '.data.COGNI_NODE_ENDPOINTS // ""' infra/k8s/base/scheduler-worker/configmap.yaml)"
for node in "${NODE_TARGETS[@]}"; do
  node_id="$(node_id_for_target "$node")"
  case ",$endpoints," in
    *",$node=http://$node-node-app:3000,"*) pass "$node slug endpoint" ;;
    *) fail "COGNI_NODE_ENDPOINTS missing slug alias for $node" ;;
  esac
  case ",$endpoints," in
    *",$node_id=http://$node-node-app:3000,"*) pass "$node UUID endpoint" ;;
    *) fail "COGNI_NODE_ENDPOINTS missing UUID alias $node_id for $node" ;;
  esac
done

echo "[2/2] scheduler off-cluster Services use env VM aliases"
check_scheduler_vm_alias() {
  local env="$1" expected="$2"
  local file="infra/k8s/overlays/$env/scheduler-worker/kustomization.yaml"
  [ -f "$file" ] || { echo "  skip - $env scheduler-worker overlay missing"; return; }

  mapfile -t external_names < <(grep -oE 'externalName: [^ ]+' "$file" | awk '{print $2}' | sort -u)
  [ "${#external_names[@]}" -gt 0 ] || fail "$file has no ExternalName entries"
  for name in "${external_names[@]}"; do
    [ "$name" = "$expected" ] || fail "$file has ExternalName $name; expected $expected"
  done
  pass "$env scheduler-worker ExternalNames -> $expected"
}

check_scheduler_vm_alias candidate-a cogni-candidate-a.vm.cognidao.org
check_scheduler_vm_alias preview preview.vm.cognidao.org
check_scheduler_vm_alias production production.vm.cognidao.org

echo "PASS: scheduler-runtime-routing.test.sh"
