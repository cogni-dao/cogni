#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Runtime routing guardrails for scheduler-worker:
#   1. COGNI_NODE_ENDPOINTS stays catalog-derived with slug + UUID aliases.
#   2. Remote-source artifact rows do not require repo-spec identity during parent rendering.
#   3. Scheduler-worker's off-cluster Temporal/Postgres/App Services point at
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

echo "[1/3] scheduler endpoint map has slug + UUID aliases"
bash scripts/ci/render-scheduler-worker-endpoints.sh --check >/dev/null \
  || fail "render-scheduler-worker-endpoints.sh --check failed"

endpoints="$(yq -r '.data.COGNI_NODE_ENDPOINTS // ""' infra/k8s/base/scheduler-worker/configmap.yaml)"
for node in "${NODE_TARGETS[@]}"; do
  if is_remote_source_artifact_target "$node"; then
    case ",$endpoints," in
      *",$node="*) fail "COGNI_NODE_ENDPOINTS includes remote-source artifact node $node before metadata projection exists" ;;
      *) pass "$node remote-source artifact endpoint skipped" ;;
    esac
    continue
  fi
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

echo "[2/3] remote-source artifact catalog nodes are skipped during parent endpoint rendering"
TMP_TREE="$(mktemp -d)"
trap 'rm -rf "$TMP_TREE"' EXIT
TMP_CATALOG="$TMP_TREE/infra/catalog"
mkdir -p "$TMP_CATALOG" "$TMP_TREE/nodes/operator/.cogni"
cp infra/catalog/operator.yaml "$TMP_CATALOG/operator.yaml"
cp nodes/operator/.cogni/repo-spec.yaml "$TMP_TREE/nodes/operator/.cogni/repo-spec.yaml"
yq '.name = "ay" | .path_prefix = "nodes/ay/" | .node_port = 30400 | .image_tag_suffix = "-ay" | .migrator_tag_suffix = "-ay-migrate" | .source_repo = "https://github.com/cogni-test-org/ay.git" | .image_repository = "ghcr.io/cogni-test-org/ay"' \
  infra/catalog/node-template.yaml > "$TMP_CATALOG/ay.yaml"

fixture_endpoints="$(COGNI_CATALOG_ROOT="$TMP_CATALOG" bash scripts/ci/render-scheduler-worker-endpoints.sh)" \
  || fail "render failed for a remote-source artifact catalog node without nodes/ay/.cogni/repo-spec.yaml"
case ",$fixture_endpoints," in
  *,ay=*) fail "fixture endpoints include remote-source artifact slug ay" ;;
  *) pass "remote-source artifact slug ay omitted" ;;
esac
case "$fixture_endpoints" in
  *"4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000"*) pass "inline operator UUID alias preserved" ;;
  *) fail "fixture endpoints lost inline operator UUID alias: $fixture_endpoints" ;;
esac

fixture_billing_endpoints="$(COGNI_CATALOG_ROOT="$TMP_CATALOG" bash -c 'source scripts/ci/lib/image-tags.sh && node_billing_endpoint_csv host.docker.internal')" \
  || fail "billing endpoint render failed for a remote-source artifact catalog node without nodes/ay/.cogni/repo-spec.yaml"
case ",$fixture_billing_endpoints," in
  *,ay=*) fail "billing endpoints include remote-source artifact slug ay before metadata projection exists" ;;
  *) pass "billing endpoint skips remote-source artifact slug ay" ;;
esac
case "$fixture_billing_endpoints" in
  *"4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://host.docker.internal:30000"*) pass "inline operator billing UUID alias preserved" ;;
  *) fail "fixture billing endpoints lost inline operator UUID alias: $fixture_billing_endpoints" ;;
esac

echo "[3/3] scheduler off-cluster Services use env VM aliases"
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
# preview + production use the canonical cogni_vm_host_for_env alias — the bare
# {preview,production}.vm.cognidao.org records point at DEAD VMs (84.32.110.92 /
# 84.32.110.202). PR #1486 migrated preview; this migrates production
# (cogni.vm.cognidao.org → 84.32.25.152, the live prod VM).
check_scheduler_vm_alias preview cogni-preview.vm.cognidao.org
check_scheduler_vm_alias production cogni.vm.cognidao.org

echo "PASS: scheduler-runtime-routing.test.sh"
