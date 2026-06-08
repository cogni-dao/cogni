#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# assert-node-substrate.sh — fail-loud preflight for node-ref candidate flights.
#
# Node-ref flights are app digest promotions. They must not repair VM/Compose
# substrate by running deploy-infra.sh. This script verifies the substrate that
# provision-env / the explicit infra lever owns already exists, then exits
# without mutating the VM.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"

NODE="${NODE:?NODE is required}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-candidate-a}"
VM_HOST="${VM_HOST:?VM_HOST is required}"
DOMAIN="${DOMAIN:?DOMAIN is required}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
SSH_BIN="${ASSERT_NODE_SUBSTRATE_SSH_BIN:-ssh}"
SSH_OPTS="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"
CHECK_DNS="${CHECK_DNS:-true}"
REMOTE_ROOT="${ASSERT_NODE_SUBSTRATE_REMOTE_ROOT:-}"
APP_WAIT_ATTEMPTS="${ASSERT_NODE_SUBSTRATE_APP_WAIT_ATTEMPTS:-12}"
APP_WAIT_SLEEP_SECONDS="${ASSERT_NODE_SUBSTRATE_APP_WAIT_SLEEP_SECONDS:-5}"

fail() {
  echo "::error::assert-node-substrate: $*" >&2
  exit 1
}

contains_node=false
for catalog_node in "${NODE_TARGETS[@]}"; do
  if [ "$catalog_node" = "$NODE" ]; then
    contains_node=true
    break
  fi
done
"$contains_node" || fail "node '$NODE' is not a type:node catalog target"

catalog_file="${APP_SOURCE_DIR}/infra/catalog/${NODE}.yaml"
overlay_dir="${APP_SOURCE_DIR}/infra/k8s/overlays/${DEPLOY_ENVIRONMENT}/${NODE}"
appset_file="${APP_SOURCE_DIR}/infra/k8s/argocd/${DEPLOY_ENVIRONMENT}-${NODE}-applicationset.yaml"

[ -f "$catalog_file" ] || fail "missing catalog file: $catalog_file"
[ -d "$overlay_dir" ] || fail "missing overlay dir: $overlay_dir"
[ -f "$appset_file" ] || fail "missing per-node AppSet file: $appset_file"

node_db="$(node_database_for_target "$NODE")" || exit 1
node_host="$(host_for_node "$NODE" "$DOMAIN")"
node_port="$(node_port_for_target "$NODE")" || exit 1
edge_key="$(printf '%s' "$NODE" | tr '[:lower:]-' '[:upper:]_')"
if is_primary_host "$NODE"; then
  edge_key="${edge_key}_UPSTREAM"
else
  edge_key="${edge_key}_DOMAIN"
fi

if [ "$CHECK_DNS" = "true" ]; then
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required for node substrate DNS check}"
  : "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID required for node substrate DNS check}"
  : "${FORK_DOMAIN_ROOT:?FORK_DOMAIN_ROOT required for node substrate DNS check}"
  # shellcheck source=scripts/ci/lib/cloudflare-dns.sh
  source "${SCRIPT_DIR}/lib/cloudflare-dns.sh"
  vm_ip="$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$DOMAIN")"
  [ -n "$vm_ip" ] || fail "apex A record '$DOMAIN' missing; provision the env before node-ref flight"
  node_ip="$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$node_host")"
  [ "$node_ip" = "$vm_ip" ] || fail "node DNS missing or drifted: ${node_host} resolves to '${node_ip:-none}', want ${vm_ip}"
fi

remote_script=$(mktemp)
trap 'rm -f "$remote_script"' EXIT
cat > "$remote_script" <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail

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
legacy_secret="${node}-node-app-secrets"
eso_secret="${node}-env-secrets"
edge_env="${remote_root}/opt/cogni-template-edge/.env"
caddyfile="${remote_root}/opt/cogni-template-edge/configs/Caddyfile.tmpl"
runtime_env="${remote_root}/opt/cogni-template-runtime/.env"
edge_compose=(docker compose --project-name cogni-edge --env-file "$edge_env" -f "${remote_root}/opt/cogni-template-edge/docker-compose.yml")
runtime_compose=(docker compose --project-name cogni-runtime --env-file "$runtime_env" -f "${remote_root}/opt/cogni-template-runtime/docker-compose.yml")
failed=0

mark_fail() {
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

if kubectl -n argocd get applicationset "$app_name" >/dev/null 2>&1; then
  mark_ok "ApplicationSet exists: $app_name"
else
  mark_fail "ApplicationSet missing: $app_name"
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

if kubectl -n "$namespace" get secret "$legacy_secret" >/dev/null 2>&1; then
  mark_ok "runtime Secret exists: $legacy_secret"
elif kubectl -n "$namespace" get secret "$eso_secret" >/dev/null 2>&1; then
  mark_ok "ESO runtime Secret exists: $eso_secret"
else
  mark_fail "runtime Secret missing: expected $legacy_secret or $eso_secret"
fi

if kubectl -n "$namespace" get externalsecret "$eso_secret" >/dev/null 2>&1; then
  ready_status="$(kubectl -n "$namespace" get externalsecret "$eso_secret" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  if [ "$ready_status" = "True" ]; then
    mark_ok "ExternalSecret Ready=True: $eso_secret"
  else
    mark_fail "ExternalSecret not Ready=True: $eso_secret"
  fi
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
  live_config="$("${edge_compose[@]}" exec -T caddy wget -qO- http://127.0.0.1:2019/config/ 2>/dev/null || true)"
  if printf '%s' "$live_config" | grep -Fq "$node_host" && printf '%s' "$live_config" | grep -Fq "host.docker.internal:${node_port}"; then
    mark_ok "live Caddy config carries $node_host -> host.docker.internal:${node_port}"
  else
    mark_fail "live Caddy config missing ${node_host} / host.docker.internal:${node_port}"
  fi
else
  mark_fail "Caddy compose service not present"
fi

if [ -f "$runtime_env" ]; then
  # shellcheck disable=SC1090
  set -a; source "$runtime_env"; set +a
  case ",${COGNI_NODE_DBS:-}," in
    *",${node_db},"*) mark_ok "runtime env includes DB inventory: $node_db" ;;
    *) mark_fail "runtime env COGNI_NODE_DBS missing $node_db" ;;
  esac
else
  mark_fail "runtime env file missing: $runtime_env"
fi

if "${runtime_compose[@]}" ps -q postgres >/dev/null 2>&1; then
  if "${runtime_compose[@]}" exec -T postgres psql -U "${POSTGRES_ROOT_USER:-postgres}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${node_db}'" 2>/dev/null | tr -d '[:space:]' | grep -qx 1; then
    mark_ok "Postgres database exists: $node_db"
  else
    mark_fail "Postgres database missing: $node_db"
  fi
else
  mark_fail "Postgres compose service not present"
fi

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "Node substrate is not ready for ${node} in ${env_name}."
  echo "Remediation: run the env provisioning lane or candidate-flight-infra.yml; app candidate-flight will not run deploy-infra implicitly."
  exit 1
fi

echo "Node substrate ready for ${node} in ${env_name}."
REMOTE

read -r -a ssh_opts <<< "$SSH_OPTS"
"$SSH_BIN" "${ssh_opts[@]}" "root@${VM_HOST}" bash -s -- \
  "$DEPLOY_ENVIRONMENT" "$NODE" "$node_db" "$node_host" "$edge_key" "$node_port" \
  "$APP_WAIT_ATTEMPTS" "$APP_WAIT_SLEEP_SECONDS" "$REMOTE_ROOT" < "$remote_script"
