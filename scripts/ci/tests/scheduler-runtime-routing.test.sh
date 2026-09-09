#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Runtime routing guardrails for scheduler-worker:
#   1. COGNI_NODE_ENDPOINTS stays catalog-derived with slug + UUID aliases, and the
#      ADDRESS follows the row's `deployment_provider.<env>` placement (bug.5094):
#      k3s -> in-cluster Service, akash -> the node's public canonical URL.
#   2. Submodule (remote-source) rows route via the drift-gated catalog node_id projection;
#      a missing projection fails loud (NO_SILENT_DROP).
#   3. Scheduler-worker's off-cluster Temporal/Postgres/App Services point at
#      the expected VM alias for each env, so workers can actually poll Temporal.
#
# Every assertion derives its expectation from the catalog row, so adding a node
# (or moving one to akash) needs NO edit here beyond the catalog row itself.
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

echo "[1/4] committed base + per-env overlay endpoint maps are catalog-derived"
bash scripts/ci/render-scheduler-worker-endpoints.sh --check >/dev/null \
  || fail "render-scheduler-worker-endpoints.sh --check failed"

endpoints="$(yq -r '.data.COGNI_NODE_ENDPOINTS // ""' infra/k8s/base/scheduler-worker/configmap.yaml)"
# Every catalog type:node is routed — submodule (remote-source) nodes resolve node_id
# from the drift-gated catalog projection, in-repo nodes from their repo-spec. The
# routing CSV no longer filters on is_built_by_this_repo (a build-target concern).
# The BASE map is the placement-default (all-k3s) baseline every overlay replaces.
for node in "${NODE_TARGETS[@]}"; do
  node_id="$(node_id_for_target "$node")"
  case ",$endpoints," in
    *",$node=http://$node-node-app:3000,"*) pass "$node slug endpoint (base default)" ;;
    *) fail "base COGNI_NODE_ENDPOINTS missing slug alias for $node" ;;
  esac
  case ",$endpoints," in
    *",$node_id=http://$node-node-app:3000,"*) pass "$node UUID endpoint (base default)" ;;
    *) fail "base COGNI_NODE_ENDPOINTS missing UUID alias $node_id for $node" ;;
  esac
done

# bug.5094 — the value that actually reaches a cluster is the per-env overlay map,
# and each node's address must follow its OWN catalog placement for THAT env.
FORK_ROOT="${FORK_DOMAIN_ROOT:-cognidao.org}"
# shellcheck source=scripts/setup/lib/fork-identity.sh
source "$REPO_ROOT/scripts/setup/lib/fork-identity.sh"
# Deploy envs come from `deployment_provider`'s own key set in the catalog schema —
# the same derivation the renderer uses, so no env list is maintained here either.
mapfile -t DEPLOY_ENVS < <(yq -N -p json -o yaml '.properties.deployment_provider.properties | keys | .[]' infra/catalog/_schema.json)
[ "${#DEPLOY_ENVS[@]}" -gt 0 ] || fail "catalog schema declares no deployment_provider envs"
for env in "${DEPLOY_ENVS[@]}"; do
  overlay="infra/k8s/overlays/$env/scheduler-worker/kustomization.yaml"
  [ -f "$overlay" ] || fail "$env has no scheduler-worker overlay"
  patch_file="infra/k8s/overlays/$env/scheduler-worker/node-endpoints.patch.yaml"
  [ -f "$patch_file" ] || fail "$env overlay has no generated node-endpoints.patch.yaml"
  grep -q 'node-endpoints.patch.yaml' "$overlay" \
    || fail "$overlay does not apply node-endpoints.patch.yaml (env would fall back to the k3s base default)"
  env_endpoints="$(yq -r '.data.COGNI_NODE_ENDPOINTS // ""' "$patch_file")"
  domain="$(domain_for_env "$env" "$FORK_ROOT")" || fail "no domain for env $env"
  for node in "${NODE_TARGETS[@]}"; do
    node_id="$(node_id_for_target "$node")"
    provider="$(deployment_provider_for_target "$node" "$env")" \
      || fail "unresolvable deployment_provider for $node in $env"
    if [ "$provider" = "akash" ]; then
      want="https://$(host_for_node "$node" "$domain")"
    else
      want="http://$node-node-app:3000"
    fi
    case ",$env_endpoints," in
      *",$node=$want,"*) pass "$env/$node ($provider) -> $want" ;;
      *) fail "$env COGNI_NODE_ENDPOINTS: $node ($provider) should route to $want" ;;
    esac
    case ",$env_endpoints," in
      *",$node_id=$want,"*) pass "$env/$node UUID alias ($provider)" ;;
      *) fail "$env COGNI_NODE_ENDPOINTS: UUID $node_id ($node, $provider) should route to $want" ;;
    esac
  done
done

echo "[2/4] submodule catalog nodes route via the node_id projection; a missing projection fails loud"
TMP_TREE="$(mktemp -d)"
trap 'rm -rf "$TMP_TREE"' EXIT
TMP_CATALOG="$TMP_TREE/infra/catalog"
mkdir -p "$TMP_CATALOG" "$TMP_TREE/nodes/operator/.cogni"
cp infra/catalog/operator.yaml "$TMP_CATALOG/operator.yaml"
cp nodes/operator/.cogni/repo-spec.yaml "$TMP_TREE/nodes/operator/.cogni/repo-spec.yaml"
AY_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
# (a) projection present → routed (slug + projected UUID), no parent-readable repo-spec needed
yq ".name = \"ay\" | .path_prefix = \"nodes/ay/\" | .node_port = 30400 | .image_tag_suffix = \"-ay\" | .migrator_tag_suffix = \"-ay-migrate\" | .source_repo = \"https://github.com/cogni-test-org/ay.git\" | .image_repository = \"ghcr.io/cogni-test-org/ay\" | .node_id = \"$AY_ID\"" \
  infra/catalog/node-template.yaml > "$TMP_CATALOG/ay.yaml"

fixture_endpoints="$(COGNI_CATALOG_ROOT="$TMP_CATALOG" bash scripts/ci/render-scheduler-worker-endpoints.sh)" \
  || fail "render failed for a submodule catalog node carrying a node_id projection"
case ",$fixture_endpoints," in
  *",ay=http://ay-node-app:3000,"*) pass "submodule slug ay routed via projection" ;;
  *) fail "fixture endpoints missing submodule slug ay: $fixture_endpoints" ;;
esac
case ",$fixture_endpoints," in
  *",$AY_ID=http://ay-node-app:3000,"*) pass "submodule projected UUID alias routed" ;;
  *) fail "fixture endpoints missing projected UUID $AY_ID for ay: $fixture_endpoints" ;;
esac
case "$fixture_endpoints" in
  *"4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000"*) pass "inline operator UUID alias preserved" ;;
  *) fail "fixture endpoints lost inline operator UUID alias: $fixture_endpoints" ;;
esac

fixture_billing_endpoints="$(COGNI_CATALOG_ROOT="$TMP_CATALOG" bash -c 'source scripts/ci/lib/image-tags.sh && node_billing_endpoint_csv host.docker.internal')" \
  || fail "billing endpoint render failed for a submodule catalog node carrying a node_id projection"
case ",$fixture_billing_endpoints," in
  *",ay=http://host.docker.internal:30400,"*) pass "submodule slug ay billing-routed via projection" ;;
  *) fail "billing endpoints missing submodule slug ay: $fixture_billing_endpoints" ;;
esac
case "$fixture_billing_endpoints" in
  *"4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://host.docker.internal:30000"*) pass "inline operator billing UUID alias preserved" ;;
  *) fail "fixture billing endpoints lost inline operator UUID alias: $fixture_billing_endpoints" ;;
esac

# (b) projection ABSENT on a submodule node → render must fail loud (NO_SILENT_DROP)
yq 'del(.node_id)' "$TMP_CATALOG/ay.yaml" > "$TMP_CATALOG/ay.tmp" && mv "$TMP_CATALOG/ay.tmp" "$TMP_CATALOG/ay.yaml"
if COGNI_CATALOG_ROOT="$TMP_CATALOG" bash scripts/ci/render-scheduler-worker-endpoints.sh >/dev/null 2>&1; then
  fail "render must fail loud for a submodule node missing its node_id projection (NO_SILENT_DROP)"
else
  pass "submodule node without node_id projection fails loud"
fi

echo "[3/4] placement decides the address: k3s -> in-cluster Service, akash -> public URL (bug.5094)"
# Synthetic two-node catalog so this bites regardless of which real nodes are on
# akash today. `zk` is k3s everywhere (no deployment_provider block at all);
# `za` is akash in candidate-a + production but k3s in preview — proving the
# decision is per (row, env) and that an omitted env preserves the k3s default.
PLACEMENT_CATALOG="$TMP_TREE/placement/infra/catalog"
mkdir -p "$PLACEMENT_CATALOG"
ZK_ID="11111111-2222-3333-4444-555555555555"
ZA_ID="66666666-7777-8888-9999-aaaaaaaaaaaa"
yq ".name = \"zk\" | .path_prefix = \"nodes/zk/\" | .node_port = 30401 | .image_tag_suffix = \"-zk\" | .migrator_tag_suffix = \"-zk-migrate\" | .source_repo = \"https://github.com/cogni-test-org/zk.git\" | .image_repository = \"ghcr.io/cogni-test-org/zk\" | .node_id = \"$ZK_ID\" | del(.deployment_provider) | del(.is_primary_host)" \
  infra/catalog/node-template.yaml > "$PLACEMENT_CATALOG/zk.yaml"
yq ".name = \"za\" | .path_prefix = \"nodes/za/\" | .node_port = 30402 | .image_tag_suffix = \"-za\" | .migrator_tag_suffix = \"-za-migrate\" | .source_repo = \"https://github.com/cogni-test-org/za.git\" | .image_repository = \"ghcr.io/cogni-test-org/za\" | .node_id = \"$ZA_ID\" | del(.is_primary_host) | .deployment_provider = {\"candidate-a\": \"akash\", \"production\": \"akash\"}" \
  infra/catalog/node-template.yaml > "$PLACEMENT_CATALOG/za.yaml"

assert_endpoint() {
  local env="$1" want_zk="$2" want_za="$3" csv
  csv="$(COGNI_CATALOG_ROOT="$PLACEMENT_CATALOG" FORK_DOMAIN_ROOT=example.test \
    bash scripts/ci/render-scheduler-worker-endpoints.sh --env "$env")" \
    || fail "placement render failed for env $env"
  case ",$csv," in
    *",zk=$want_zk,"*) pass "$env zk (k3s default) -> $want_zk" ;;
    *) fail "$env zk should route to $want_zk, got: $csv" ;;
  esac
  case ",$csv," in
    *",$ZK_ID=$want_zk,"*) pass "$env zk UUID alias -> $want_zk" ;;
    *) fail "$env zk UUID alias should route to $want_zk, got: $csv" ;;
  esac
  case ",$csv," in
    *",za=$want_za,"*) pass "$env za -> $want_za" ;;
    *) fail "$env za should route to $want_za, got: $csv" ;;
  esac
  case ",$csv," in
    *",$ZA_ID=$want_za,"*) pass "$env za UUID alias -> $want_za" ;;
    *) fail "$env za UUID alias should route to $want_za, got: $csv" ;;
  esac
}

# candidate-a: za on akash -> public host at the env's `test.` domain.
assert_endpoint candidate-a "http://zk-node-app:3000" "https://za-test.example.test"
# preview: za has NO preview override -> k3s default preserved (K3S_IS_DEFAULT).
assert_endpoint preview "http://zk-node-app:3000" "http://za-node-app:3000"
# production: za on akash -> bare public host.
assert_endpoint production "http://zk-node-app:3000" "https://za.example.test"

# LiteLLM (Compose-on-VM) is a Cherry-resident consumer too: k3s -> VM NodePort,
# akash -> the same public URL (no NodePort exists for an off-cluster workload).
placement_billing="$(COGNI_CATALOG_ROOT="$PLACEMENT_CATALOG" bash -c 'source scripts/ci/lib/image-tags.sh && node_billing_endpoint_csv candidate-a.vm.example.test candidate-a test.example.test')" \
  || fail "placement billing render failed"
case ",$placement_billing," in
  *",zk=http://candidate-a.vm.example.test:30401,"*) pass "billing zk (k3s) -> VM NodePort" ;;
  *) fail "billing zk should use the VM NodePort: $placement_billing" ;;
esac
case ",$placement_billing," in
  *",za=https://za-test.example.test,"*) pass "billing za (akash) -> public URL" ;;
  *) fail "billing za should use the public URL: $placement_billing" ;;
esac

# An unsupported placement value must fail loud, never silently fall back to k3s.
yq '.deployment_provider = {"candidate-a": "fly"}' "$PLACEMENT_CATALOG/za.yaml" > "$PLACEMENT_CATALOG/za.tmp" \
  && mv "$PLACEMENT_CATALOG/za.tmp" "$PLACEMENT_CATALOG/za.yaml"
if COGNI_CATALOG_ROOT="$PLACEMENT_CATALOG" FORK_DOMAIN_ROOT=example.test \
  bash scripts/ci/render-scheduler-worker-endpoints.sh --env candidate-a >/dev/null 2>&1; then
  fail "an unsupported deployment_provider must fail loud, not default to k3s"
else
  pass "unsupported deployment_provider fails loud"
fi

echo "[4/4] scheduler off-cluster Services use env VM aliases"
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
