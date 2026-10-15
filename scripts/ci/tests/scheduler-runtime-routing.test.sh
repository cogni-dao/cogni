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
# shellcheck source=scripts/ci/lib/appset-paths.sh
source "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok - $*"; }

echo "[1/5] committed base + per-env overlay endpoint maps are catalog-derived"
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
# bug.5330 (4th site) — MUST mirror the generator's precedence exactly, or this test
# computes expectations from a different root than the artifact it is validating.
# render-scheduler-worker-endpoints.sh:51 uses "${DOMAIN:-${FORK_DOMAIN_ROOT:-cognidao.org}}";
# reading only FORK_DOMAIN_ROOT here was correct while the two never diverged, and became a
# false failure the moment an isolated fleet set DOMAIN (the test parent: DOMAIN=cogni-testing.org
# as the workload zone, FORK_DOMAIN_ROOT=cognidao.org as the substrate root). The committed
# overlays then hold *-test.cogni-testing.org while this test demanded *-test.cognidao.org —
# which is what kept cogni-test-org/cogni-monorepo#70 permanently red, rotting the mirror and
# pinning candidate-a (bug.5331).
FORK_ROOT="${DOMAIN:-${FORK_DOMAIN_ROOT:-cognidao.org}}"
# shellcheck source=scripts/setup/lib/fork-identity.sh
source "$REPO_ROOT/scripts/setup/lib/fork-identity.sh"
# shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
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
    if ! target_in_env "$node" "$env"; then
      case ",$env_endpoints," in
        *",$node="*|*",$node_id="*) fail "$env routing includes out-of-environment node $node" ;;
        *) pass "$env excludes $node outside its declared membership" ;;
      esac
      continue
    fi
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

# Foreign-custody routes are a strict catalog-derived subset. A control worker
# must never poll a foreign namespace with its whole primary endpoint map.
for control_env in "${DEPLOY_ENVS[@]}"; do
  patch_file="infra/k8s/overlays/$control_env/scheduler-worker/node-endpoints.patch.yaml"
  custody_json="$(yq -r '.data.TEMPORAL_CUSTODIED_NODE_ENDPOINTS // "{}"' "$patch_file")"
  for lane in "${DEPLOY_ENVS[@]}"; do
    lane_csv="$(jq -r --arg namespace "cogni-$lane" '.[$namespace] // ""' <<<"$custody_json")"
    domain="$(domain_for_env "$lane" "$FORK_ROOT")" || fail "no domain for env $lane"
    for node in "${NODE_TARGETS[@]}"; do
      node_id="$(node_id_for_target "$node")"
      should_route=false
      if [ "$lane" != "$control_env" ] && target_in_env "$node" "$lane" \
        && [ "$(control_env_for "$lane" "$node")" = "$control_env" ]; then
        should_route=true
      fi
      if [ "$should_route" = true ]; then
        want="$(node_app_url_for_target "$node" "$lane" "$domain")"
        case ",$lane_csv," in
          *",$node=$want,"*) : ;;
          *) fail "$control_env custody route missing $lane/$node slug at $want: $lane_csv" ;;
        esac
        case ",$lane_csv," in
          *",$node_id=$want,"*) pass "$control_env custodies $lane/$node only at lane URL" ;;
          *) fail "$control_env custody route missing $lane/$node UUID at $want: $lane_csv" ;;
        esac
      else
        case ",$lane_csv," in
          *",$node="*|*",$node_id="*) fail "$control_env custody route unexpectedly includes $lane/$node: $lane_csv" ;;
          *) : ;;
        esac
      fi
    done
  done
done

echo "[2/5] submodule catalog nodes route via the node_id projection; a missing projection fails loud"
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

echo "[3/5] placement decides the address: k3s -> in-cluster Service, akash -> public URL (bug.5094)"
# Synthetic two-node catalog so this bites regardless of which real nodes are on
# akash today. `zk` is k3s everywhere (no deployment_provider block at all);
# `za` is akash in candidate-a + production but k3s in preview — proving the
# decision is per (row, env) and that an omitted env preserves the k3s default.
PLACEMENT_CATALOG="$TMP_TREE/placement/infra/catalog"
mkdir -p "$PLACEMENT_CATALOG"
ZK_ID="11111111-2222-3333-4444-555555555555"
ZA_ID="66666666-7777-8888-9999-aaaaaaaaaaaa"
yq ".name = \"zk\" | .envs = [\"candidate-a\", \"preview\", \"production\"] | .path_prefix = \"nodes/zk/\" | .node_port = 30401 | .image_tag_suffix = \"-zk\" | .migrator_tag_suffix = \"-zk-migrate\" | .source_repo = \"https://github.com/cogni-test-org/zk.git\" | .image_repository = \"ghcr.io/cogni-test-org/zk\" | .node_id = \"$ZK_ID\" | del(.deployment_provider) | del(.is_primary_host)" \
  infra/catalog/node-template.yaml > "$PLACEMENT_CATALOG/zk.yaml"
yq ".name = \"za\" | .envs = [\"candidate-a\", \"preview\", \"production\"] | .path_prefix = \"nodes/za/\" | .node_port = 30402 | .image_tag_suffix = \"-za\" | .migrator_tag_suffix = \"-za-migrate\" | .source_repo = \"https://github.com/cogni-test-org/za.git\" | .image_repository = \"ghcr.io/cogni-test-org/za\" | .node_id = \"$ZA_ID\" | del(.is_primary_host) | .deployment_provider = {\"candidate-a\": \"akash\", \"production\": \"akash\"}" \
  infra/catalog/node-template.yaml > "$PLACEMENT_CATALOG/za.yaml"

assert_endpoint() {
  local env="$1" want_zk="$2" want_za="$3" csv
  # DOMAIN cleared so FORK_DOMAIN_ROOT=example.test is the fallback path under test
  # (ci.yaml exports an ambient DOMAIN that would otherwise take precedence — bug.5330).
  csv="$(COGNI_CATALOG_ROOT="$PLACEMENT_CATALOG" DOMAIN='' FORK_DOMAIN_ROOT=example.test \
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

yq -i '.envs = ["production"]' "$PLACEMENT_CATALOG/zk.yaml"
scoped_endpoints="$(COGNI_CATALOG_ROOT="$PLACEMENT_CATALOG" DOMAIN='' FORK_DOMAIN_ROOT=example.test \
  bash scripts/ci/render-scheduler-worker-endpoints.sh --env candidate-a)"
case ",$scoped_endpoints," in
  *",zk="*|*",$ZK_ID="*) fail "an excluded node still allocates a per-node Worker" ;;
  *) pass "env filtering removes both slug and UUID while retaining the placed sibling" ;;
esac
case ",$scoped_endpoints," in
  *",$ZA_ID=https://za-test.example.test,"*) : ;;
  *) fail "env filtering removed the active placed sibling" ;;
esac

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

echo "[4/5] scheduler off-cluster Services use env VM aliases"
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

SUBSTRATE_SLUG="$(cogni_deployment_slug)"
for env in "${DEPLOY_ENVS[@]}"; do
  check_scheduler_vm_alias "$env" "$(cogni_vm_host_for_env "$env" "$FORK_ROOT" "$SUBSTRATE_SLUG")"
done

echo "[5/5] the Crossplane materializer's substrate host IS that same env VM alias"
# story.5016 step 8. `spec.runtime.substrateHost` is the one value the Crossplane authority
# cannot recover the way the bespoke controller did — that read `new URL(DATABASE_URL).hostname`
# out of a SECRET VALUE. The composite action re-derives it from non-secret config with
# vm_host_for_env(), the SAME primitive scripts/setup/bootstrap.sh used to publish the VM's
# unproxied A record. This asserts the derivation lands on the host the cluster already dials,
# because the failure it prevents is silent: a plausible-but-wrong hostname renders, syncs, and
# buys a lease before anything notices the node has no Temporal.
ACTION_YML=".github/actions/materialize-compute-workload/action.yml"
grep -q -- '--substrate-host' "$ACTION_YML" \
  || fail "$ACTION_YML stopped passing --substrate-host; a Crossplane-born node would get no Temporal/Redis/LiteLLM env"
grep -q -- 'cogni_deployment_slug' "$ACTION_YML" \
  || fail "$ACTION_YML derives operator substrate identity from the parent repo name instead of the provisioned deployment"
for env in "${DEPLOY_ENVS[@]}"; do
  file="infra/k8s/overlays/$env/scheduler-worker/kustomization.yaml"
  [ -f "$file" ] || { echo "  skip - $env scheduler-worker overlay missing"; continue; }
  expected="$(cogni_vm_host_for_env "$env" "$FORK_ROOT" "$SUBSTRATE_SLUG")"
  apex="$(domain_for_env "$env" "$FORK_ROOT" || true)"
  [ "$expected" != "$apex" ] \
    || fail "$env substrate host resolved to the Cloudflare-proxied public apex '$apex', which drops 7233/6379/4000"
  mapfile -t external_names < <(grep -oE 'externalName: [^ ]+' "$file" | awk '{print $2}' | sort -u)
  [ "${#external_names[@]}" -gt 0 ] || fail "$file has no ExternalName entries"
  for name in "${external_names[@]}"; do
    [ "$name" = "$expected" ] \
      || fail "cogni_vm_host_for_env($env) = $expected but $file dials $name — a Crossplane node would be wired to a different substrate than the cluster uses"
  done
  pass "$env materializer substrate host -> $expected"
done

echo "[6/6] scheduler repair paths select only the worker and no tenant substrate"
scope_paths=(
  scripts/ci/render-scheduler-worker-endpoints.sh
  scripts/ci/reconcile-scheduler-worker-routing.sh
  scripts/ci/tests/scheduler-runtime-routing.test.sh
  scripts/ci/tests/reconcile-scheduler-worker-routing.test.sh
  infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml
  infra/k8s/overlays/candidate-a/scheduler-worker/serial-rollout.patch.yaml
  infra/k8s/overlays/candidate-a/scheduler-worker/node-endpoints.patch.yaml
  infra/k8s/overlays/preview/scheduler-worker/node-endpoints.patch.yaml
  infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml
)
for path in "${scope_paths[@]}"; do
  printf '%s\n' "$path" > "$TMP_TREE/changed-paths.txt"
  : > "$TMP_TREE/target-outputs"
  CHANGED_PATHS_FILE="$TMP_TREE/changed-paths.txt" GITHUB_OUTPUT="$TMP_TREE/target-outputs" \
    bash scripts/ci/detect-affected.sh > /dev/null
  python3 - "$TMP_TREE/target-outputs" "$path" <<'PY' || fail "scheduler-only detector contract changed"
import json, sys
values = dict(line.rstrip("\n").split("=", 1) for line in open(sys.argv[1]) if "=" in line)
expected = ["scheduler-worker"] if sys.argv[2].startswith("infra/k8s/") else []
assert json.loads(values["targets_json"]) == expected, (sys.argv[2], values)
assert json.loads(values["flight_targets_json"]) == expected, (sys.argv[2], values)
PY
done
printf '%s\n' "${scope_paths[@]}" > "$TMP_TREE/changed-paths.txt"
: > "$TMP_TREE/target-outputs"
CHANGED_PATHS_FILE="$TMP_TREE/changed-paths.txt" GITHUB_OUTPUT="$TMP_TREE/target-outputs" \
  bash scripts/ci/detect-affected.sh > /dev/null
grep -Fq 'flight_targets_json=["scheduler-worker"]' "$TMP_TREE/target-outputs" || fail "combined scheduler diff selects another workload"

CATALOG_JSON="$(yq -o=json -I=0 '.' infra/catalog/scheduler-worker.yaml)" \
  pnpm --dir nodes/operator/app exec tsx -e '
    import assert from "node:assert/strict";
    import { resolveDeploymentTargets } from "./src/features/compute/node-deployment-targets.ts";
    assert.deepEqual(resolveDeploymentTargets({catalogRows:[JSON.parse(process.env.CATALOG_JSON!)],environment:"candidate-a",flightTargets:["scheduler-worker"]}), {
      deployment:[],substrate:[],offCluster:[],providers:{"scheduler-worker":"k3s"},
      k3s:["scheduler-worker"],k3sNodes:[],sourceRepositories:{},sourceShas:{}
    });
  ' || fail "scheduler-only flight touches a node/database substrate"
[ "$(yq -N '.spec.replicas' infra/k8s/overlays/production/scheduler-worker/replicas.patch.yaml)" = 1 ] || fail "production worker count changed"
[ "$(yq -N '.spec.strategy.rollingUpdate.maxSurge' infra/k8s/base/node-app/deployment.yaml)" = 1 ] || fail "operator surge policy changed"
[ "$(yq -N '.spec.strategy.rollingUpdate.maxUnavailable' infra/k8s/base/node-app/deployment.yaml)" = 0 ] || fail "operator zero-downtime policy changed"
pass "every repair path selects at most scheduler-worker, with empty node/database partitions"

echo "[7/7] candidate startup samples actual available memory before the heavy worker"
SERIAL_PATCH=infra/k8s/overlays/candidate-a/scheduler-worker/serial-rollout.patch.yaml
RENDERED="$(kubectl kustomize infra/k8s/overlays/candidate-a/scheduler-worker)"
RENDERED_JSON="$(yq -o=json -I=0 'select(.kind == "Deployment")' <<< "$RENDERED")"
EVICTION_FLOOR="$(sed -n '/variable "eviction_hard_memory" {/,/^}/p' infra/provision/cherry/base/variables.tf | sed -n 's/.*default *= *"\([^"]*\)".*/\1/p')"
EVICTION_FLOOR="$EVICTION_FLOOR" RENDERED_JSON="$RENDERED_JSON" python3 - <<'PY' || fail "candidate init contract drifted"
import json, os
deployment = json.loads(os.environ["RENDERED_JSON"])
spec = deployment["spec"]["template"]["spec"]
main = next(c for c in spec["containers"] if c["name"] == "scheduler-worker")
guard = next(c for c in spec["initContainers"] if c["name"] == "startup-memory-budget")
assert guard["image"] == main["image"], (guard["image"], main["image"])
assert guard["command"][:2] == ["/bin/sh", "-ec"]
assert os.environ["EVICTION_FLOOR"] == "200Mi", "candidate reserve profile needs requalification"
reserve_line = next(line.strip() for line in guard["command"][2].splitlines() if line.strip().startswith("candidate_reserve_bytes="))
assert int(reserve_line.split("=", 1)[1]) == (int(os.environ["EVICTION_FLOOR"][:-2]) + 56) * 1024 * 1024
assert guard["env"] == [{"name":"MAIN_MEMORY_LIMIT_BYTES", "valueFrom":{"resourceFieldRef":{"containerName":"scheduler-worker", "resource":"limits.memory", "divisor":"1"}}}]
assert deployment["spec"]["paused"] is False
assert deployment["spec"]["replicas"] == 2
assert spec.get("terminationGracePeriodSeconds", 30) == 30
assert main["resources"]["limits"]["memory"] == "1Gi"
assert guard["resources"]["limits"]["memory"] == "32Mi"
assert guard["resources"]["requests"]["memory"] == "8Mi"
assert deployment["metadata"]["annotations"]["secret.reloader.stakater.com/auto"] == "true"
assert deployment["metadata"]["annotations"]["reloader.stakater.com/auto"] == "false"
PY
[ "$(yq -N 'select(.kind == "ConfigMap") | .metadata.annotations."reloader.stakater.com/ignore"' <<< "$RENDERED")" = true ] \
  || fail "candidate ConfigMap can independently trigger a Reloader rollout"
for env in preview production; do
  other="$(kubectl kustomize "infra/k8s/overlays/$env/scheduler-worker")"
  [ "$(yq -N 'select(.kind == "Deployment") | (.spec.template.spec.initContainers // []) | length' <<< "$other")" = 0 ] \
    || fail "$env unexpectedly gained candidate startup policy"
  [ "$(yq -N 'select(.kind == "Deployment") | .metadata.annotations."reloader.stakater.com/auto"' <<< "$other")" = true ] \
    || fail "$env Reloader transport changed"
done

GUARD_DIR="$TMP_TREE/startup-guard"
mkdir -p "$GUARD_DIR/bin"
yq -N '.spec.template.spec.initContainers[] | select(.name == "startup-memory-budget") | .command[2]' "$SERIAL_PATCH" > "$GUARD_DIR/guard.sh"
cat > "$GUARD_DIR/bin/awk" <<'PY'
#!/usr/bin/env python3
# Test-only proc read fixtures. Production has no path override or bypass knob.
import json, os, pathlib, subprocess, sys
root = pathlib.Path(os.environ["GUARD_FIXTURE"])
state = json.loads((root / "state.json").read_text())
args = sys.argv[1:]
if "/proc/uptime" in args:
    samples = state["samples"]
    sample = samples[min(state["index"], len(samples) - 1)]
    (root / "uptime").write_text(sample["uptime"])
    memory = root / "meminfo"
    if sample["meminfo"] is None:
        memory.unlink(missing_ok=True)
    else:
        memory.write_text(sample["meminfo"])
    args = [str(root / "uptime") if arg == "/proc/uptime" else str(memory) if arg == "/proc/meminfo" else arg for arg in args]
sys.exit(subprocess.call([os.environ["GUARD_REAL_AWK"], *args]))
PY
cat > "$GUARD_DIR/bin/sleep" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["GUARD_FIXTURE"])
state = json.loads((root / "state.json").read_text())
state["index"] += 1
if sys.argv[1:] != ["2"] or state["index"] > 4:
    raise SystemExit("fixture detected unexpected or unbounded polling")
(root / "state.json").write_text(json.dumps(state))
PY
chmod +x "$GUARD_DIR/bin/awk" "$GUARD_DIR/bin/sleep"
GUARD_REAL_AWK="$(command -v awk)" GUARD_DIR="$GUARD_DIR" python3 - <<'PY' || fail "actual inline memory guard failed its finite-state fixtures"
import json, os, pathlib, subprocess
root = pathlib.Path(os.environ["GUARD_DIR"])
def sample(seconds, kib):
    return {"uptime": f"{seconds} 0.00\n", "meminfo": f"MemTotal: 6062904 kB\nMemAvailable: {kib} kB\n"}
def run(name, samples, success, reason, budget="1073741824", expected_sleeps=None):
    (root / "state.json").write_text(json.dumps({"index":0,"samples":samples}))
    env = {**os.environ, "PATH":str(root / "bin") + os.pathsep + os.environ["PATH"], "GUARD_FIXTURE":str(root), "MAIN_MEMORY_LIMIT_BYTES":budget}
    result = subprocess.run(["/bin/sh", "-ec", (root / "guard.sh").read_text()], env=env, text=True, capture_output=True, timeout=5)
    assert (result.returncode == 0) == success, (name, result.returncode, result.stdout, result.stderr)
    assert reason in result.stdout + result.stderr, (name, result.stdout, result.stderr)
    if expected_sleeps is not None:
        assert json.loads((root / "state.json").read_text())["index"] == expected_sleeps, name
    print("  ok - inline guard " + name)
# The observed failed sample was below the old 1Gi+384Mi profile.
assert 1393980 < (1024 + 384) * 1024
run("observed 1393980KiB now eligible", [sample(0, 1393980)], True, "requiredKiB=1310720", expected_sleeps=0)
run("one KiB below calibrated budget times out", [sample(0, 1310719), sample(180, 1310719)], False, "timed out", expected_sleeps=1)
run("below-budget then actual release", [sample("10.25", 800000), sample("12.25", 1310720)], True, "requiredKiB=1310720", expected_sleeps=1)
run("already sufficient", [sample(0, 1310720)], True, "eligible", expected_sleeps=0)
run("timeout wins even newly sufficient at boundary", [sample(0, 800000), sample(180, 1310720)], False, "timed out", expected_sleeps=1)
run("below budget timeout", [sample(0, 800000), sample(181, 800000)], False, "timed out")
run("larger main limit refuses old calibrated threshold", [sample(0, 1310720), sample(180, 1310720)], False, "timed out", budget="1610612736", expected_sleeps=1)
run("actual main limit change affects threshold", [sample(0, 1835008)], True, "requiredKiB=1835008", budget="1610612736")
for budget in ("", "0", "-1", "1.5", "unknown", "99999999999999999999999"):
    run("invalid main budget " + repr(budget), [sample(0, 9999999)], False, "invalid main limit", budget=budget, expected_sleeps=0)
for meminfo in (None, "", "MemAvailable: nope kB\n", "MemAvailable: 9999999 MB\n", "MemAvailable: 9999999 kB\nMemAvailable: 9999999 kB\n"):
    run("missing/malformed memory " + repr(meminfo), [{"uptime":"0.00 0.00\n", "meminfo":meminfo}], False, "invalid proc sample", expected_sleeps=0)
run("malformed monotonic clock", [{"uptime":"bad 0.00\n", "meminfo":"MemAvailable: 9999999 kB\n"}], False, "invalid proc sample")
run("clock rollback", [sample(10, 800000), sample(9, 9999999)], False, "clock regressed", expected_sleeps=1)
PY
pass "same-image bounded init uses actual main budget/proc samples; production and Secret rotation remain unchanged"

echo "PASS: scheduler-runtime-routing.test.sh"
