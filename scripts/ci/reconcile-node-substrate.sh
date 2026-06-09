#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-node-substrate.sh — day-2 substrate readiness for one catalog node.
#
# This is the narrow lane for a node added after an environment already exists.
# secret-materialize (the sole OpenBao writer) runs BEFORE this and owns all
# source:agent app keys + shared/human inheritance. This phase: seeds the node's
# DB DSNs (transitional, until cogni/<env>/_shared lands — see
# docs/guides/vm-secrets-repair.md), applies the node-domain ExternalSecret leaf,
# updates edge/DB inventory, and runs idempotent DB provisioners. It does not
# promote images and does not run the broad deploy-infra compose reconcile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ENVIRONMENT="${1:-${DEPLOY_ENVIRONMENT:-}}"
TARGET_NODE="${2:-${TARGET:-}}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-$REPO_ROOT}"
COGNI_CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR}/infra/catalog}"
SSH_BIN="${RECONCILE_NODE_SUBSTRATE_SSH_BIN:-ssh}"
SCP_BIN="${RECONCILE_NODE_SUBSTRATE_SCP_BIN:-scp}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

fail() {
  echo "::error::reconcile-node-substrate: $*" >&2
  exit 1
}

log() {
  printf '[reconcile-node-substrate] %s\n' "$*"
}

log_info() {
  log "$*"
}

usage() {
  cat >&2 <<'USAGE'
Usage: reconcile-node-substrate.sh <candidate-a|preview|production> <node>

Required env:
  VM_HOST, DOMAIN

Optional env:
  APP_SOURCE_DIR, COGNI_CATALOG_ROOT, SSH_OPTS
USAGE
}

[[ -n "$DEPLOY_ENVIRONMENT" && -n "$TARGET_NODE" ]] || { usage; exit 2; }
[[ "$DEPLOY_ENVIRONMENT" =~ ^(candidate-a|preview|production)$ ]] \
  || fail "unsupported env '$DEPLOY_ENVIRONMENT'"
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"
[[ -n "${DOMAIN:-}" ]] || fail "DOMAIN is required"

case "$APP_SOURCE_DIR" in
  /*) ;;
  *) APP_SOURCE_DIR="$(cd "$APP_SOURCE_DIR" 2>/dev/null && pwd)" || fail "missing app source dir: $APP_SOURCE_DIR" ;;
esac
case "$COGNI_CATALOG_ROOT" in
  /*) ;;
  *)
    if [[ -d "$COGNI_CATALOG_ROOT" ]]; then
      COGNI_CATALOG_ROOT="$(cd "$COGNI_CATALOG_ROOT" && pwd)"
    elif [[ -d "${APP_SOURCE_DIR}/${COGNI_CATALOG_ROOT}" ]]; then
      COGNI_CATALOG_ROOT="$(cd "${APP_SOURCE_DIR}/${COGNI_CATALOG_ROOT}" && pwd)"
    else
      COGNI_CATALOG_ROOT="${APP_SOURCE_DIR}/${COGNI_CATALOG_ROOT}"
    fi
    ;;
esac
[[ -d "$COGNI_CATALOG_ROOT" ]] || fail "missing catalog root: $COGNI_CATALOG_ROOT"

# shellcheck source=lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

node_known=false
for node in "${NODE_TARGETS[@]}"; do
  if [[ "$node" == "$TARGET_NODE" ]]; then
    node_known=true
    break
  fi
done
"$node_known" || fail "target '$TARGET_NODE' is not a type=node catalog target"

node_db="$(node_database_for_target "$TARGET_NODE")"
node_host="$(host_for_node "$TARGET_NODE" "$DOMAIN")"
node_port="$(node_port_for_target "$TARGET_NODE")"
edge_slug="$(printf '%s' "$TARGET_NODE" | tr '[:lower:]-' '[:upper:]_')"
if is_primary_host "$TARGET_NODE"; then
  edge_key="${edge_slug}_UPSTREAM"
  edge_value="host.docker.internal:${node_port}"
else
  edge_key="${edge_slug}_DOMAIN"
  edge_value="$node_host"
fi

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
remote() {
  "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"
}
copy_to_remote() {
  "$SCP_BIN" "${SSH_OPTS_ARR[@]}" "$1" "root@${VM_HOST}:$2"
}

remote_env_value() {
  local key="$1"
  remote "awk -F= -v key='${key}' 'index(\$0, key \"=\") == 1 { value = substr(\$0, length(key) + 2) } END { print value }' /opt/cogni-template-runtime/.env 2>/dev/null" \
    || true
}

BAO_TOKEN="$(
  remote "set -euo pipefail
    jwt=\$(kubectl create token openbao-operator -n default)
    kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
      bao write -field=token auth/kubernetes/login role='${DEPLOY_ENVIRONMENT}-writer' jwt=\"\$jwt\""
)"
[[ -n "$BAO_TOKEN" ]] || fail "could not mint ${DEPLOY_ENVIRONMENT}-writer token"

export REPO_ROOT APP_SOURCE_DIR COGNI_CATALOG_ROOT
export DEPLOY_ENV="$DEPLOY_ENVIRONMENT"
export DOMAIN
export VM_IP="${VM_IP:-$(remote "hostname -I | awk '{print \$1}'" | tr -d '[:space:]')}"
export CATALOG_FILE="${APP_SOURCE_DIR}/infra/secrets-catalog.yaml"
export PAYMENT_NODES="${PAYMENT_NODES:-poly}"

export POSTGRES_ROOT_PASSWORD="${POSTGRES_ROOT_PASSWORD:-$(remote_env_value POSTGRES_ROOT_PASSWORD)}"
export APP_DB_USER="${APP_DB_USER:-$(remote_env_value APP_DB_USER)}"
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(remote_env_value APP_DB_PASSWORD)}"
export APP_DB_SERVICE_USER="${APP_DB_SERVICE_USER:-$(remote_env_value APP_DB_SERVICE_USER)}"
export APP_DB_SERVICE_PASSWORD="${APP_DB_SERVICE_PASSWORD:-$(remote_env_value APP_DB_SERVICE_PASSWORD)}"
export DOLTGRES_PASSWORD="${DOLTGRES_PASSWORD:-$(remote_env_value DOLTGRES_PASSWORD)}"

[[ -n "$APP_DB_USER" && -n "$APP_DB_PASSWORD" ]] \
  || fail "runtime env missing APP_DB_USER/APP_DB_PASSWORD; run env provisioning"
[[ -n "$APP_DB_SERVICE_USER" && -n "$APP_DB_SERVICE_PASSWORD" ]] \
  || fail "runtime env missing APP_DB_SERVICE_USER/APP_DB_SERVICE_PASSWORD; run env provisioning"

# shellcheck source=../setup/lib/reconcile-secrets.sh
source "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh"

bao_get_field() {
  local svc="$1" k="$2"
  remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 \
    bao kv get -format=json 'cogni/${DEPLOY_ENVIRONMENT}/${svc}'" \
    2>/dev/null | jq -r --arg k "$k" '.data.data[$k] // empty' 2>/dev/null || true
}

seed_kv() {
  local svc="$1" k="$2" v="$3"
  [[ -z "$v" ]] && return 0
  local path="cogni/${DEPLOY_ENVIRONMENT}/${svc}"
  local op="patch"
  if ! remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 \
    bao kv metadata get '${path}'" >/dev/null 2>&1; then
    op="put"
  fi
  printf '%s' "$v" | remote "kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 \
    bao kv ${op} '${path}' '${k}=-'" >/dev/null
}

# Transitional DSN seed. secret-materialize now owns all source:agent app keys
# and shared/human inheritance; the former double-write of those keys here is
# removed (along with the blind preload scan). Reconcile keeps ONLY the DB DSN
# write until cogni/<env>/_shared exists (docs/guides/vm-secrets-repair.md),
# after which DSN custody moves into materialize and this phase becomes fully
# read-only. DSNs are built from the VM .env DB components read above — the last
# remaining .env dependency, retired by the env-repair lane.
log "seeding node DB DSNs for ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (transitional; materialize owns app keys)"
for k in DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_URL; do
  v="$(_resolve_node_value "$TARGET_NODE" "$k")"
  [[ -z "$v" ]] && continue
  seed_kv "$TARGET_NODE" "$k" "$v"
done

external_secret_file="${APP_SOURCE_DIR}/nodes/${TARGET_NODE}/k8s/external-secrets/${DEPLOY_ENVIRONMENT}/external-secret.yaml"
if [[ -f "$external_secret_file" ]]; then
  remote "kubectl create namespace 'cogni-${DEPLOY_ENVIRONMENT}' --dry-run=client -o yaml | kubectl apply -f - >/dev/null"
  copy_to_remote "$external_secret_file" "/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml"
  remote "kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' apply -f '/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml' >/dev/null && rm -f '/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml'"
  log "applied ExternalSecret ${TARGET_NODE}-env-secrets"
else
  fail "missing node ExternalSecret leaf: $external_secret_file"
fi

caddy_tmp="$(mktemp)"
trap 'rm -f "$caddy_tmp"' EXIT
COGNI_CATALOG_ROOT="$COGNI_CATALOG_ROOT" bash "$REPO_ROOT/scripts/ci/render-caddyfile.sh" > "$caddy_tmp"
if ! grep -Fq "{\$${edge_key}:" "$caddy_tmp" || ! grep -Fq "host.docker.internal:${node_port}" "$caddy_tmp"; then
  fail "rendered Caddyfile missing route for ${node_host} / host.docker.internal:${node_port}"
fi
copy_to_remote "$caddy_tmp" "/tmp/Caddyfile.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}.tmpl"

remote "set -euo pipefail
  edge_env=/opt/cogni-template-edge/.env
  runtime_env=/opt/cogni-template-runtime/.env
  caddyfile=/opt/cogni-template-edge/configs/Caddyfile.tmpl
  edge_compose=(docker compose --project-name cogni-edge --env-file \"\$edge_env\" -f /opt/cogni-template-edge/docker-compose.yml)
  runtime_compose=(docker compose --project-name cogni-runtime --env-file \"\$runtime_env\" -f /opt/cogni-template-runtime/docker-compose.yml)

  mkdir -p /opt/cogni-template-edge/configs
  mv '/tmp/Caddyfile.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}.tmpl' \"\$caddyfile\"

  touch \"\$edge_env\"
  if grep -qE '^${edge_key}=' \"\$edge_env\"; then
    sed -i.bak 's|^${edge_key}=.*$|${edge_key}=${edge_value}|' \"\$edge_env\"
  else
    printf '%s=%s\n' '${edge_key}' '${edge_value}' >> \"\$edge_env\"
  fi
  rm -f \"\$edge_env.bak\"

  touch \"\$runtime_env\"
  current=\$(awk -F= '/^COGNI_NODE_DBS=/ {print substr(\$0, length(\"COGNI_NODE_DBS=\") + 1)}' \"\$runtime_env\" | tail -1)
  if [[ -z \"\$current\" ]]; then
    next='${node_db}'
  elif [[ \",\$current,\" == *\",${node_db},\"* ]]; then
    next=\"\$current\"
  else
    next=\"\$current,${node_db}\"
  fi
  if grep -qE '^COGNI_NODE_DBS=' \"\$runtime_env\"; then
    sed -i.bak \"s|^COGNI_NODE_DBS=.*\$|COGNI_NODE_DBS=\$next|\" \"\$runtime_env\"
  else
    printf '%s=%s\n' COGNI_NODE_DBS \"\$next\" >> \"\$runtime_env\"
  fi
  rm -f \"\$runtime_env.bak\"

  if \"\${edge_compose[@]}\" ps -q caddy >/dev/null 2>&1; then
    \"\${edge_compose[@]}\" up -d --force-recreate caddy >/dev/null
  fi
  \"\${runtime_compose[@]}\" up -d postgres >/dev/null
  \"\${runtime_compose[@]}\" --profile bootstrap run --rm db-provision >/dev/null
  if \"\${runtime_compose[@]}\" config --services 2>/dev/null | grep -q '^doltgres$'; then
    \"\${runtime_compose[@]}\" up -d doltgres >/dev/null
    \"\${runtime_compose[@]}\" --profile bootstrap run --rm doltgres-provision >/dev/null
  fi"

log "substrate ready inputs reconciled for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT})"
