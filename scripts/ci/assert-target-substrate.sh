#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# assert-target-substrate.sh — fail-loud preflight for catalog target flights.
#
# App flights are digest promotions. They must not repair VM/Compose substrate by
# running deploy-infra.sh. This script verifies the substrate that provision-env /
# explicit infra levers own already exists, then exits without mutating the VM.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${TARGET:?TARGET is required}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-candidate-a}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
COGNI_CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR}/infra/catalog}"

fail() {
  echo "::error::assert-target-substrate: $*" >&2
  exit 1
}

command -v yq >/dev/null 2>&1 || fail "yq is required to read catalog targets"
catalog_file="${COGNI_CATALOG_ROOT}/${TARGET}.yaml"
[ -f "$catalog_file" ] || fail "missing catalog file: $catalog_file"
target_type="$(yq -N '.type // ""' "$catalog_file")"

# shellcheck disable=SC1091 source=./scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"

assert_node_target_substrate() {
local node="$TARGET"
local vm_host="${VM_HOST:-}"
local domain="${DOMAIN:-}"
local ssh_bin="${ASSERT_TARGET_SUBSTRATE_SSH_BIN:-ssh}"
local ssh_opts_raw="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"
local check_dns="${CHECK_DNS:-true}"
local remote_root="${ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT:-}"
local app_wait_attempts="${ASSERT_TARGET_SUBSTRATE_APP_WAIT_ATTEMPTS:-12}"
local app_wait_sleep_seconds="${ASSERT_TARGET_SUBSTRATE_APP_WAIT_SLEEP_SECONDS:-5}"

[ -n "$vm_host" ] || fail "VM_HOST is required for type=node target '$node'"
[ -n "$domain" ] || fail "DOMAIN is required for type=node target '$node'"

contains_node=false
for catalog_node in "${NODE_TARGETS[@]}"; do
  if [ "$catalog_node" = "$node" ]; then
    contains_node=true
    break
  fi
done
"$contains_node" || fail "target '$node' is not a type=node catalog target"

overlay_dir="${APP_SOURCE_DIR}/infra/k8s/overlays/${DEPLOY_ENVIRONMENT}/${node}"
appset_file="${APP_SOURCE_DIR}/infra/k8s/argocd/${DEPLOY_ENVIRONMENT}-${node}-applicationset.yaml"

[ -d "$overlay_dir" ] || fail "missing overlay dir: $overlay_dir"
[ -f "$appset_file" ] || fail "missing per-target AppSet file: $appset_file"

node_db="$(node_database_for_target "$node")" || exit 1
node_host="$(host_for_node "$node" "$domain")"
node_port="$(node_port_for_target "$node")" || exit 1
edge_key="$(printf '%s' "$node" | tr '[:lower:]-' '[:upper:]_')"
if is_primary_host "$node"; then
  edge_key="${edge_key}_UPSTREAM"
else
  edge_key="${edge_key}_DOMAIN"
fi

if [ "$check_dns" = "true" ]; then
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required for node substrate DNS check}"
  : "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID required for node substrate DNS check}"
  : "${FORK_DOMAIN_ROOT:?FORK_DOMAIN_ROOT required for node substrate DNS check}"
  # shellcheck disable=SC1091 source=./scripts/ci/lib/cloudflare-dns.sh
  source "${SCRIPT_DIR}/lib/cloudflare-dns.sh"
  vm_ip="$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$domain")"
  [ -n "$vm_ip" ] || fail "apex A record '$domain' missing; provision the env before node-ref flight"
  node_ip="$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$node_host")"
  [ "$node_ip" = "$vm_ip" ] || fail "node DNS missing or drifted: ${node_host} resolves to '${node_ip:-none}', want ${vm_ip}"
fi

remote_script=$(mktemp)
trap 'rm -f "$remote_script"' EXIT
cat > "$remote_script" <<'REMOTE'
#!/usr/bin/env bash
set -uo pipefail

env_name="$1"
node="$2"
node_db="$3"
node_host="$4"
edge_key="$5"
node_port="$6"
app_wait_attempts="$7"
app_wait_sleep_seconds="$8"
remote_root="${9:-}"

namespace="cogni-${env_name}"
app_name="${env_name}-${node}"
appset_name="cogni-${env_name}-${node}"
workload_name="${node}-node-app"
edge_env="${remote_root}/opt/cogni-template-edge/.env"
caddyfile="${remote_root}/opt/cogni-template-edge/configs/Caddyfile.tmpl"
runtime_env="${remote_root}/opt/cogni-template-runtime/.env"
edge_compose=(docker compose --project-name cogni-edge --env-file "$edge_env" -f "${remote_root}/opt/cogni-template-edge/docker-compose.yml")
runtime_compose=(docker compose --project-name cogni-runtime --env-file "$runtime_env" -f "${remote_root}/opt/cogni-template-runtime/docker-compose.yml")
failed=0
failures=()

mark_fail() {
  failures+=("$*")
  echo "::error::assert-target-substrate: $*" >&2
  echo "[FAIL] $*" >&2
  failed=1
}

mark_ok() {
  echo "[OK] $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || mark_fail "missing command on VM: $1"
}

require_cmd kubectl
require_cmd docker

if kubectl get namespace "$namespace" >/dev/null 2>&1; then
  mark_ok "namespace exists: $namespace"
else
  mark_fail "namespace missing: $namespace"
fi

if kubectl -n argocd get applicationset "$appset_name" >/dev/null 2>&1; then
  mark_ok "ApplicationSet exists: $appset_name"
else
  mark_fail "ApplicationSet missing: $appset_name"
fi

app_ready=false
for _ in $(seq 1 "$app_wait_attempts"); do
  if kubectl -n argocd get application "$app_name" >/dev/null 2>&1; then
    app_ready=true
    break
  fi
  sleep "$app_wait_sleep_seconds"
done
if $app_ready; then
  mark_ok "Argo Application exists: $app_name"
else
  mark_fail "Argo Application missing after AppSet reconcile: $app_name"
fi

if kubectl -n "$namespace" get deployment "$workload_name" >/dev/null 2>&1; then
  mark_ok "Deployment exists: $workload_name"
else
  mark_fail "Deployment missing: $workload_name"
fi

if kubectl -n "$namespace" get service "$workload_name" >/dev/null 2>&1; then
  service_node_port="$(kubectl -n "$namespace" get service "$workload_name" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)"
  if [ "$service_node_port" = "$node_port" ]; then
    mark_ok "Service NodePort matches catalog: $workload_name -> $node_port"
  else
    mark_fail "Service NodePort mismatch for $workload_name: got '${service_node_port:-none}', want $node_port"
  fi
else
  mark_fail "Service missing: $workload_name"
fi

consumed_secret_names="$(
  kubectl -n "$namespace" get deployment "$workload_name" \
    -o jsonpath='{.spec.template.spec.containers[*].envFrom[*].secretRef.name}{" "}{.spec.template.spec.initContainers[*].envFrom[*].secretRef.name}{" "}{.spec.template.spec.containers[*].env[*].valueFrom.secretKeyRef.name}{" "}{.spec.template.spec.initContainers[*].env[*].valueFrom.secretKeyRef.name}' \
    2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
)"
if [ -z "$consumed_secret_names" ]; then
  mark_fail "Deployment has no consumed Secret refs: $workload_name"
else
  while IFS= read -r consumed_secret; do
    [ -n "$consumed_secret" ] || continue
    if kubectl -n "$namespace" get secret "$consumed_secret" >/dev/null 2>&1; then
      mark_ok "Deployment-consumed Secret exists: $consumed_secret"
    else
      mark_fail "Deployment-consumed Secret missing: $consumed_secret"
    fi

    if kubectl -n "$namespace" get externalsecret "$consumed_secret" >/dev/null 2>&1; then
      ready_status="$(kubectl -n "$namespace" get externalsecret "$consumed_secret" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
      if [ "$ready_status" = "True" ]; then
        mark_ok "Deployment-consumed ExternalSecret Ready=True: $consumed_secret"
      else
        mark_fail "Deployment-consumed ExternalSecret not Ready=True: $consumed_secret"
      fi
    fi
  done <<< "$consumed_secret_names"
fi

if [ -f "$edge_env" ]; then
  if grep -Eq "^${edge_key}=" "$edge_env"; then
    mark_ok "edge env carries $edge_key for $node_host"
  else
    mark_fail "edge env missing $edge_key in $edge_env"
  fi
else
  mark_fail "edge env file missing: $edge_env"
fi

if [ -f "$caddyfile" ]; then
  if grep -Fq "{\$${edge_key}:" "$caddyfile" && grep -Fq "host.docker.internal:${node_port}" "$caddyfile"; then
    mark_ok "Caddyfile declares route for $node_host -> host.docker.internal:${node_port}"
  else
    mark_fail "Caddyfile missing route for ${node_host} / node_port ${node_port}"
  fi
else
  mark_fail "Caddyfile missing: $caddyfile"
fi

if "${edge_compose[@]}" ps -q caddy >/dev/null 2>&1; then
  mark_ok "Caddy compose service exists"
  live_config="$("${edge_compose[@]}" exec -T caddy wget -qO- http://127.0.0.1:2019/config/ </dev/null 2>/dev/null || true)"
  if printf '%s' "$live_config" | grep -Fq "$node_host" && printf '%s' "$live_config" | grep -Fq "host.docker.internal:${node_port}"; then
    mark_ok "live Caddy config carries $node_host -> host.docker.internal:${node_port}"
  else
    mark_fail "live Caddy config missing ${node_host} / host.docker.internal:${node_port}"
  fi
else
  mark_fail "Caddy compose service not present"
fi

if [ -f "$runtime_env" ]; then
  set -a
  # shellcheck disable=SC1090
  if source "$runtime_env"; then
    set +a
    case ",${COGNI_NODE_DBS:-}," in
      *",${node_db},"*) mark_ok "runtime env includes DB inventory: $node_db" ;;
      *) mark_fail "runtime env COGNI_NODE_DBS missing $node_db" ;;
    esac
  else
    set +a
    mark_fail "runtime env file is not sourceable: $runtime_env"
  fi
else
  mark_fail "runtime env file missing: $runtime_env"
fi

if "${runtime_compose[@]}" ps -q postgres >/dev/null 2>&1; then
  if "${runtime_compose[@]}" exec -T postgres psql -U "${POSTGRES_ROOT_USER:-postgres}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${node_db}'" </dev/null 2>/dev/null | tr -d '[:space:]' | grep -qx 1; then
    mark_ok "Postgres database exists: $node_db"
  else
    mark_fail "Postgres database missing: $node_db"
  fi
else
  mark_fail "Postgres compose service not present"
fi

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "Node substrate is not ready for ${node} in ${env_name}: ${#failures[@]} failure(s)."
  printf '  - %s\n' "${failures[@]}"
  echo "Remediation: run the env provisioning lane or candidate-flight-infra.yml; app candidate-flight will not run deploy-infra implicitly."
  exit 1
fi

echo "Node substrate ready for ${node} in ${env_name}: all checks passed."
REMOTE

local ssh_opts=()
read -r -a ssh_opts <<< "$ssh_opts_raw"
probe_log=$(mktemp)
set +e
"$ssh_bin" "${ssh_opts[@]}" "root@${vm_host}" bash -s -- \
  "$DEPLOY_ENVIRONMENT" "$node" "$node_db" "$node_host" "$edge_key" "$node_port" \
  "$app_wait_attempts" "$app_wait_sleep_seconds" "$remote_root" < "$remote_script" 2>&1 | tee "$probe_log"
ssh_rc=${PIPESTATUS[0]}
set -e
if grep -Eq '(^|\r)(\[FAIL\]|::error::assert-target-substrate:)' "$probe_log"; then
  failure_count="$(grep -Ec '(^|\r)\[FAIL\]' "$probe_log" || true)"
  echo "::error::assert-target-substrate: remote substrate probe emitted ${failure_count} failure(s); see [FAIL] lines above" >&2
  rm -f "$probe_log"
  return 1
fi
rm -f "$probe_log"
return "$ssh_rc"
}

case "$target_type" in
  node)
    assert_node_target_substrate
    ;;
  service)
    fail "type=service substrate assertion is not implemented yet for target '$TARGET'; declare the service k8s/Argo/Secret/ExternalSecret/ConfigMap contract before enabling app-flight substrate assertions for services"
    ;;
  infra)
    fail "type=infra target '$TARGET' is deployed/asserted by candidate-flight-infra/deploy-infra today; app candidate-flight will not pretend Argo owns this substrate"
    ;;
  "")
    fail "catalog target '$TARGET' is missing .type"
    ;;
  *)
    fail "unsupported catalog target type '$target_type' for '$TARGET'"
    ;;
esac
