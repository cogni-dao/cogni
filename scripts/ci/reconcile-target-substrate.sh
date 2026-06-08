#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-target-substrate.sh - narrow per-target substrate reconciler for
# app candidate flights. It mutates only catalog-derived substrate for one
# target; broad VM bootstrap, OpenBao value writes, and legacy plain Secrets are
# deliberately outside this lane.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${TARGET:?TARGET is required}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-candidate-a}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
COGNI_CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR}/infra/catalog}"
SUMMARY_FILE="${SUBSTRATE_RECONCILE_SUMMARY_FILE:-}"
ROWS_FILE=""
SUMMARY_WRITTEN=false
REMOTE_SCRIPT_FILE=""

fail() {
  echo "::error::reconcile-target-substrate: $*" >&2
  exit 1
}

command -v yq >/dev/null 2>&1 || fail "yq is required to read catalog targets"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to write summary JSON"

catalog_file="${COGNI_CATALOG_ROOT}/${TARGET}.yaml"
[ -f "$catalog_file" ] || fail "missing catalog file: $catalog_file"
target_type="$(yq -N '.type // ""' "$catalog_file")"

# shellcheck disable=SC1091 source=./scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"

init_summary() {
  [ -n "$SUMMARY_FILE" ] || return 0
  ROWS_FILE="$(mktemp -t substrate-reconcile-rows.XXXXXX)"
}

append_row() {
  [ -n "$ROWS_FILE" ] || return 0
  local row="$1" state="$2" message="${3:-}"
  local error_code="${4:-}"
  ROW_NAME="$row" ROW_STATE="$state" ROW_MESSAGE="$message" ROW_ERROR_CODE="$error_code" python3 - <<'PY' >>"$ROWS_FILE"
import json
import os

payload = {
    "row": os.environ["ROW_NAME"],
    "state": os.environ["ROW_STATE"],
}
message = os.environ.get("ROW_MESSAGE", "")
if message:
    payload["message"] = message
error_code = os.environ.get("ROW_ERROR_CODE", "")
if error_code:
    payload["error_code"] = error_code
print(json.dumps(payload, separators=(",", ":")))
PY
}

write_summary() {
  [ -n "$SUMMARY_FILE" ] || return 0
  local status="$1"
  SUBSTRATE_STATUS="$status" \
    SUBSTRATE_TARGET="$TARGET" \
    SUBSTRATE_TARGET_TYPE="$target_type" \
    SUBSTRATE_DEPLOY_ENV="$DEPLOY_ENVIRONMENT" \
    SUBSTRATE_NODE_SOURCE_SHA="${NODE_SOURCE_SHA:-}" \
    SUBSTRATE_HEAD_SHA="${HEAD_SHA:-${GITHUB_SHA:-}}" \
    SUBSTRATE_RUN_ID="${GITHUB_RUN_ID:-}" \
    SUBSTRATE_STATUS_URL="${STATUS_URL:-}" \
    SUBSTRATE_WORKFLOW="${GITHUB_WORKFLOW:-}" \
    SUBSTRATE_JOB="${GITHUB_JOB:-}" \
    SUBSTRATE_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}" \
    SUBSTRATE_REF="${GITHUB_REF_NAME:-}" \
    python3 - "$ROWS_FILE" <<'PY' >"${SUMMARY_FILE}.tmp"
import collections
import datetime
import json
import os
import sys

rows = []
path = sys.argv[1] if len(sys.argv) > 1 else ""
if path:
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

states = collections.Counter(row.get("state", "unknown") for row in rows)
failed_rows = sorted({row.get("row", "unknown") for row in rows if row.get("state") == "failed"})
payload = {
    "schema_version": 1,
    "type": "target_substrate_reconcile_summary",
    "status": os.environ["SUBSTRATE_STATUS"],
    "target": os.environ["SUBSTRATE_TARGET"],
    "target_type": os.environ["SUBSTRATE_TARGET_TYPE"],
    "deploy_env": os.environ["SUBSTRATE_DEPLOY_ENV"],
    "node_source_sha": os.environ["SUBSTRATE_NODE_SOURCE_SHA"],
    "head_sha": os.environ["SUBSTRATE_HEAD_SHA"],
    "run_id": os.environ["SUBSTRATE_RUN_ID"],
    "status_url": os.environ["SUBSTRATE_STATUS_URL"],
    "workflow": os.environ["SUBSTRATE_WORKFLOW"],
    "job": os.environ["SUBSTRATE_JOB"],
    "attempt": os.environ["SUBSTRATE_ATTEMPT"],
    "ref": os.environ["SUBSTRATE_REF"],
    "states": dict(sorted(states.items())),
    "row_count": len(rows),
    "failed_row_count": len(failed_rows),
    "failed_rows": failed_rows,
    "rows": rows,
    "emitted_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
print(json.dumps(payload, separators=(",", ":")))
PY
  mv "${SUMMARY_FILE}.tmp" "$SUMMARY_FILE"
  SUMMARY_WRITTEN=true
}

cleanup() {
  local rc=$?
  rm -f "${REMOTE_SCRIPT_FILE:-}"
  if [ -n "$SUMMARY_FILE" ] && [ "$SUMMARY_WRITTEN" != "true" ]; then
    case "$rc" in
      0) write_summary success ;;
      2) write_summary unsupported ;;
      *) write_summary failure ;;
    esac
  fi
  rm -f "${ROWS_FILE:-}"
}

init_summary
trap cleanup EXIT

case "$target_type" in
  node) ;;
  service|infra)
    append_row target_type unsupported "type=${target_type} target substrate reconciliation is not implemented"
    echo "::error::reconcile-target-substrate: type=${target_type} is unsupported for target '$TARGET'" >&2
    exit 2
    ;;
  "")
    fail "catalog target '$TARGET' is missing .type"
    ;;
  *)
    append_row target_type unsupported "unsupported target type"
    echo "::error::reconcile-target-substrate: unsupported catalog target type '$target_type' for '$TARGET'" >&2
    exit 2
    ;;
esac

vm_host="${VM_HOST:-}"
domain="${DOMAIN:-}"
ssh_bin="${SUBSTRATE_RECONCILE_SSH_BIN:-ssh}"
scp_bin="${SUBSTRATE_RECONCILE_SCP_BIN:-scp}"
ssh_opts_raw="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"
remote_root="${SUBSTRATE_RECONCILE_REMOTE_ROOT:-}"
wait_attempts="${SUBSTRATE_RECONCILE_WAIT_ATTEMPTS:-12}"
wait_sleep_seconds="${SUBSTRATE_RECONCILE_WAIT_SLEEP_SECONDS:-5}"

[ -n "$vm_host" ] || fail "VM_HOST is required for type=node target '$TARGET'"
[ -n "$domain" ] || fail "DOMAIN is required for type=node target '$TARGET'"

contains_node=false
for catalog_node in "${NODE_TARGETS[@]}"; do
  if [ "$catalog_node" = "$TARGET" ]; then
    contains_node=true
    break
  fi
done
"$contains_node" || fail "target '$TARGET' is not a type=node catalog target"

node_db="$(node_database_for_target "$TARGET")" || exit 1
knowledge_db="knowledge_${node_db#cogni_}"
node_host="$(host_for_node "$TARGET" "$domain")"
node_port="$(node_port_for_target "$TARGET")" || exit 1
edge_key="$(printf '%s' "$TARGET" | tr '[:lower:]-' '[:upper:]_')"
if is_primary_host "$TARGET"; then
  edge_key="${edge_key}_UPSTREAM"
  edge_value="host.docker.internal:${node_port}"
else
  edge_key="${edge_key}_DOMAIN"
  edge_value="$node_host"
fi

appset_file="${APP_SOURCE_DIR}/infra/k8s/argocd/${DEPLOY_ENVIRONMENT}-${TARGET}-applicationset.yaml"
caddyfile="${APP_SOURCE_DIR}/infra/compose/edge/configs/Caddyfile.tmpl"
external_secret_file="${APP_SOURCE_DIR}/nodes/${TARGET}/k8s/external-secrets/${DEPLOY_ENVIRONMENT}/external-secret.yaml"
if [ ! -f "$external_secret_file" ]; then
  external_secret_file="${APP_SOURCE_DIR}/infra/k8s/secrets/external-secrets/${DEPLOY_ENVIRONMENT}/${TARGET}/external-secret.yaml"
fi

[ -f "$appset_file" ] || fail "missing per-target AppSet file: $appset_file"
[ -f "$caddyfile" ] || fail "missing Caddyfile template: $caddyfile"
[ -f "$external_secret_file" ] || fail "missing ExternalSecret manifest for ${TARGET}/${DEPLOY_ENVIRONMENT}"

remote_stamp="${GITHUB_RUN_ID:-local}-$$-${RANDOM}"
remote_appset="/tmp/substrate-${remote_stamp}-appset.yaml"
remote_caddy="/tmp/substrate-${remote_stamp}-Caddyfile.tmpl"
remote_external_secret="/tmp/substrate-${remote_stamp}-external-secret.yaml"

read -r -a ssh_opts <<< "$ssh_opts_raw"

# shellcheck disable=SC1091 source=./scripts/ci/lib/ssh-retry.sh
source "${SCRIPT_DIR}/lib/ssh-retry.sh"
ci_ssh_retry "$scp_bin" "${ssh_opts[@]}" "$appset_file" "root@${vm_host}:${remote_appset}"
ci_ssh_retry "$scp_bin" "${ssh_opts[@]}" "$caddyfile" "root@${vm_host}:${remote_caddy}"
ci_ssh_retry "$scp_bin" "${ssh_opts[@]}" "$external_secret_file" "root@${vm_host}:${remote_external_secret}"

REMOTE_SCRIPT_FILE="$(mktemp)"
cat >"$REMOTE_SCRIPT_FILE" <<'REMOTE'
#!/usr/bin/env bash
set -uo pipefail

env_name="$1"
node="$2"
node_db="$3"
knowledge_db="$4"
node_host="$5"
edge_key="$6"
edge_value="$7"
node_port="$8"
appset_src="$9"
caddy_src="${10}"
external_secret_src="${11}"
wait_attempts="${12}"
wait_sleep_seconds="${13}"
remote_root="${14:-}"

namespace="cogni-${env_name}"
app_name="${env_name}-${node}"
appset_name="cogni-${env_name}-${node}"
workload_name="${node}-node-app"
expected_secret="${node}-env-secrets"
legacy_secret="${node}-node-app-secrets"
edge_env="${remote_root}/opt/cogni-template-edge/.env"
caddyfile="${remote_root}/opt/cogni-template-edge/configs/Caddyfile.tmpl"
runtime_env="${remote_root}/opt/cogni-template-runtime/.env"
edge_compose=(docker compose --project-name cogni-edge --env-file "$edge_env" -f "${remote_root}/opt/cogni-template-edge/docker-compose.yml")
runtime_compose=(docker compose --project-name cogni-runtime --env-file "$runtime_env" -f "${remote_root}/opt/cogni-template-runtime/docker-compose.yml")
failed=0
bao_token=""

remote_path() {
  case "$1" in
    /tmp/*|/opt/*) printf '%s%s' "$remote_root" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

appset_src="$(remote_path "$appset_src")"
caddy_src="$(remote_path "$caddy_src")"
external_secret_src="$(remote_path "$external_secret_src")"

emit_row() {
  printf 'SUBSTRATE_ROW\x1f%s\x1f%s\x1f%s\x1f%s\n' "$1" "$2" "${3:-}" "${4:-}" >&2
}

mark_failed() {
  failed=1
  emit_row "$1" failed "$2" "${3:-$1}"
  echo "::error::reconcile-target-substrate: $2" >&2
}

wait_for_k8s_object() {
  local row="$1" namespace_arg="$2" kind="$3" name="$4" label="$5"
  local ready=false
  local kubectl_args=()
  if [ -n "$namespace_arg" ]; then
    kubectl_args=(-n "$namespace_arg")
  fi
  for _ in $(seq 1 "$wait_attempts"); do
    if kubectl "${kubectl_args[@]}" get "$kind" "$name" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep "$wait_sleep_seconds"
  done
  if $ready; then
    emit_row "$row" unchanged "$label exists"
    return 0
  fi
  mark_failed "$row" "$label missing after reconcile wait"
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || mark_failed prerequisites "missing command on VM: $1"
}

validate_ident() {
  [[ "$1" =~ ^[a-zA-Z0-9_]+$ ]]
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    cksum "$1" | awk '{print $1}'
  fi
}

sql_literal() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

ensure_env_line() {
  local file="$1" key="$2" value="$3"
  if [ ! -f "$file" ]; then
    return 2
  fi
  if grep -Eq "^${key}=" "$file"; then
    if grep -Fxq "${key}=${value}" "$file"; then
      return 1
    fi
    tmp="${file}.tmp.$$"
    awk -v key="$key" -v value="$value" 'BEGIN { line = key "=" value } $0 ~ "^" key "=" { print line; next } { print }' "$file" >"$tmp" && mv "$tmp" "$file"
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >>"$file"
  return 0
}

ensure_db_inventory() {
  local file="$1" db="$2"
  if [ ! -f "$file" ]; then
    return 2
  fi
  current="$(grep -E '^COGNI_NODE_DBS=' "$file" | tail -1 | cut -d= -f2- || true)"
  case ",${current}," in
    *",${db},"*) return 1 ;;
  esac
  if [ -z "$current" ]; then
    next="$db"
  else
    next="${current},${db}"
  fi
  if grep -Eq '^COGNI_NODE_DBS=' "$file"; then
    tmp="${file}.tmp.$$"
    awk -v value="$next" 'BEGIN { done = 0 } /^COGNI_NODE_DBS=/ && done == 0 { print "COGNI_NODE_DBS=" value; done = 1; next } /^COGNI_NODE_DBS=/ { next } { print } END { if (done == 0) print "COGNI_NODE_DBS=" value }' "$file" >"$tmp" && mv "$tmp" "$file"
  else
    printf 'COGNI_NODE_DBS=%s\n' "$next" >>"$file"
  fi
  return 0
}

require_openbao_token() {
  [ -n "$bao_token" ] && return 0
  if ! kubectl get sa db-provisioner -n default >/dev/null 2>&1; then
    mark_failed openbao_db_reader "db-provisioner service account missing; run provision-env to install ${env_name}-db-reader"
    return 1
  fi
  jwt="$(kubectl create token db-provisioner -n default 2>/dev/null)" || {
    mark_failed openbao_db_reader "could not mint db-provisioner token"
    return 1
  }
  bao_token="$(kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 bao write -field=token auth/kubernetes/login "role=${env_name}-db-reader" "jwt=${jwt}" 2>/dev/null)" || {
    mark_failed openbao_db_reader "${env_name}-db-reader login failed; OpenBao may be sealed or the role is absent"
    return 1
  }
  emit_row openbao_db_reader refreshed "read-only OpenBao db-reader token minted"
}

read_openbao_key() {
  local key="$1" value
  require_openbao_token || return 1
  value="$(kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN="$bao_token" bao kv get -field="$key" "cogni/${env_name}/${node}" 2>/dev/null)" || {
    mark_failed openbao_values "missing OpenBao key ${key} at cogni/${env_name}/${node}; use the secrets lane to seed it"
    return 1
  }
  if [ -z "$value" ]; then
    mark_failed openbao_values "empty OpenBao key ${key} at cogni/${env_name}/${node}; use the secrets lane to seed it"
    return 1
  fi
  printf '%s' "$value"
}

postgres_sql() {
  local db="$1" sql="$2"
  "${runtime_compose[@]}" exec -T postgres env PGPASSWORD="${POSTGRES_ROOT_PASSWORD}" \
    psql -U "${POSTGRES_ROOT_USER:-postgres}" -d "$db" -v ON_ERROR_STOP=1 -tAc "$sql"
}

doltgres_sql() {
  local db="$1" sql="$2"
  "${runtime_compose[@]}" exec -T doltgres env PGPASSWORD="${DOLTGRES_PASSWORD}" \
    psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -tAc "$sql"
}

ensure_postgres_role() {
  local role="$1" pass="$2" attrs="${3:-}"
  validate_ident "$role" || { mark_failed postgres_db "invalid Postgres role identifier: $role"; return 1; }
  exists="$(postgres_sql postgres "SELECT 1 FROM pg_roles WHERE rolname='${role}'" 2>/dev/null | tr -d '[:space:]')" || {
    mark_failed postgres_db "could not inspect Postgres role $role"
    return 2
  }
  if [ "$exists" = "1" ]; then
    return 1
  fi
  postgres_sql postgres "CREATE ROLE \"${role}\" WITH LOGIN PASSWORD $(sql_literal "$pass") ${attrs};" >/dev/null || {
    mark_failed postgres_db "could not create Postgres role $role"
    return 2
  }
  return 0
}

ensure_doltgres_role() {
  local role="$1" pass="$2"
  validate_ident "$role" || { mark_failed doltgres_db "invalid Doltgres role identifier: $role"; return 1; }
  exists="$(doltgres_sql postgres "SELECT 1 FROM pg_roles WHERE rolname='${role}'" 2>/dev/null | tr -d '[:space:]')" || {
    mark_failed doltgres_db "could not inspect Doltgres role $role"
    return 2
  }
  if [ "$exists" = "1" ]; then
    return 1
  fi
  doltgres_sql postgres "CREATE ROLE \"${role}\" WITH LOGIN PASSWORD $(sql_literal "$pass")" >/dev/null || {
    mark_failed doltgres_db "could not create Doltgres role $role"
    return 2
  }
  return 0
}

ensure_postgres_db() {
  validate_ident "$node_db" || { mark_failed postgres_db "invalid database identifier: $node_db"; return 1; }
  exists="$(postgres_sql postgres "SELECT 1 FROM pg_database WHERE datname='${node_db}'" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$exists" != "1" ]; then
    postgres_sql postgres "CREATE DATABASE \"${node_db}\" OWNER \"${APP_DB_USER}\";" >/dev/null || return 1
    return 0
  fi
  postgres_sql postgres "GRANT CONNECT, CREATE, TEMP ON DATABASE \"${node_db}\" TO \"${APP_DB_USER}\";" >/dev/null || return 1
  return 1
}

ensure_doltgres_db() {
  validate_ident "$knowledge_db" || { mark_failed doltgres_db "invalid Doltgres database identifier: $knowledge_db"; return 1; }
  exists="$(doltgres_sql postgres "SELECT 1 FROM pg_database WHERE datname='${knowledge_db}'" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$exists" != "1" ]; then
    doltgres_sql postgres "CREATE DATABASE \"${knowledge_db}\";" >/dev/null || return 1
    doltgres_sql "$knowledge_db" "SELECT dolt_commit('-Am', 'provision: database + roles')" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

require_cmd kubectl
require_cmd docker
[ "$failed" -eq 0 ] || exit 1

if kubectl get namespace "$namespace" >/dev/null 2>&1; then
  emit_row namespace unchanged "$namespace exists"
else
  if kubectl create namespace "$namespace" >/dev/null 2>&1; then
    emit_row namespace created "$namespace created"
  else
    mark_failed namespace "could not create namespace $namespace"
  fi
fi

if [ -f "$appset_src" ]; then
  appset_state=updated
  kubectl -n argocd get applicationset "$appset_name" >/dev/null 2>&1 || appset_state=created
  if kubectl delete applicationset cogni-"${env_name}" -n argocd --cascade=orphan --ignore-not-found >/dev/null 2>&1 \
      && kubectl apply -f "$appset_src" -n argocd >/dev/null 2>&1; then
    emit_row appset "$appset_state" "$appset_name applied"
  else
    mark_failed appset "could not apply $appset_name"
  fi
else
  mark_failed appset "staged AppSet file missing"
fi

wait_for_k8s_object argo_application argocd application "$app_name" "Argo Application $app_name"

if [ -f "$external_secret_src" ]; then
  secret_state=updated
  kubectl -n "$namespace" get externalsecret "$expected_secret" >/dev/null 2>&1 || secret_state=created
  if kubectl apply -f "$external_secret_src" >/dev/null 2>&1; then
    kubectl -n "$namespace" annotate externalsecret "$expected_secret" "force-sync=$(date +%s)" --overwrite >/dev/null 2>&1 || true
    ready=false
    for _ in $(seq 1 "$wait_attempts"); do
      ready_status="$(kubectl -n "$namespace" get externalsecret "$expected_secret" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
      if [ "$ready_status" = "True" ] && kubectl -n "$namespace" get secret "$expected_secret" >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep "$wait_sleep_seconds"
    done
    if $ready; then
      emit_row externalsecret "$secret_state" "$expected_secret Ready=True"
    else
      mark_failed externalsecret "$expected_secret did not become Ready=True with synced Secret"
    fi
  else
    mark_failed externalsecret "could not apply ExternalSecret for $expected_secret"
  fi
else
  mark_failed externalsecret "staged ExternalSecret file missing"
fi

wait_for_k8s_object deployment "$namespace" deployment "$workload_name" "Deployment $workload_name"
wait_for_k8s_object service "$namespace" service "$workload_name" "Service $workload_name"

if kubectl -n "$namespace" get deployment "$workload_name" >/dev/null 2>&1; then
  consumed_secret_names="$(
    kubectl -n "$namespace" get deployment "$workload_name" \
      -o jsonpath='{.spec.template.spec.containers[*].envFrom[*].secretRef.name}{" "}{.spec.template.spec.initContainers[*].envFrom[*].secretRef.name}{" "}{.spec.template.spec.containers[*].env[*].valueFrom.secretKeyRef.name}{" "}{.spec.template.spec.initContainers[*].env[*].valueFrom.secretKeyRef.name}' \
      2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
  )"
  if printf '%s\n' "$consumed_secret_names" | grep -Fxq "$legacy_secret"; then
    mark_failed secret_contract "Deployment still consumes legacy plain Secret $legacy_secret; cut target to $expected_secret"
  elif printf '%s\n' "$consumed_secret_names" | grep -Fxq "$expected_secret"; then
    emit_row secret_contract unchanged "Deployment consumes ESO Secret $expected_secret"
  else
    mark_failed secret_contract "Deployment does not consume expected ESO Secret $expected_secret"
  fi
else
  mark_failed secret_contract "Deployment missing: $workload_name"
fi

caddy_changed=false
if ensure_env_line "$edge_env" "$edge_key" "$edge_value"; then
  emit_row edge_env updated "$edge_key reconciled"
  caddy_changed=true
else
  rc=$?
  if [ "$rc" -eq 1 ]; then
    emit_row edge_env unchanged "$edge_key already correct"
  else
    mark_failed edge_env "edge env file missing: $edge_env"
  fi
fi

if [ -f "$caddy_src" ]; then
  mkdir -p "$(dirname "$caddyfile")"
  old_hash="$(hash_file "$caddyfile" 2>/dev/null || echo missing)"
  new_hash="$(hash_file "$caddy_src")"
  if [ "$old_hash" = "$new_hash" ]; then
    emit_row caddyfile unchanged "Caddyfile already current"
  else
    cp "$caddy_src" "$caddyfile"
    emit_row caddyfile updated "Caddyfile updated from app source"
    caddy_changed=true
  fi
else
  mark_failed caddyfile "staged Caddyfile missing"
fi

if "${edge_compose[@]}" ps -q caddy >/dev/null 2>&1; then
  if $caddy_changed; then
    if "${edge_compose[@]}" up -d --force-recreate caddy >/dev/null 2>&1; then
      emit_row caddy_live refreshed "Caddy recreated after config change"
    else
      mark_failed caddy_live "could not recreate Caddy"
    fi
  else
    emit_row caddy_live unchanged "Caddy config unchanged"
  fi
  live_config="$("${edge_compose[@]}" exec -T caddy wget -qO- http://127.0.0.1:2019/config/ </dev/null 2>/dev/null || true)"
  if printf '%s' "$live_config" | grep -Fq "$node_host" && printf '%s' "$live_config" | grep -Fq "host.docker.internal:${node_port}"; then
    :
  else
    mark_failed caddy_live "live Caddy config missing ${node_host} / host.docker.internal:${node_port}"
  fi
else
  mark_failed caddy_live "Caddy compose service not present"
fi

if ensure_db_inventory "$runtime_env" "$node_db"; then
  emit_row runtime_db_inventory updated "$node_db added to COGNI_NODE_DBS"
else
  rc=$?
  if [ "$rc" -eq 1 ]; then
    emit_row runtime_db_inventory unchanged "$node_db already in COGNI_NODE_DBS"
  else
    mark_failed runtime_db_inventory "runtime env file missing: $runtime_env"
  fi
fi

if [ -f "$runtime_env" ]; then
  set -a
  # shellcheck disable=SC1090
  if source "$runtime_env"; then
    set +a
  else
    set +a
    mark_failed runtime_db_inventory "runtime env is not sourceable"
  fi
fi

if "${runtime_compose[@]}" ps -q postgres >/dev/null 2>&1; then
  : "${POSTGRES_ROOT_PASSWORD:-}"
  : "${APP_DB_USER:-}"
  : "${APP_DB_SERVICE_USER:-}"
  APP_DB_READONLY_USER="${APP_DB_READONLY_USER:-app_readonly}"
  if [ -z "${POSTGRES_ROOT_PASSWORD:-}" ] || [ -z "${APP_DB_USER:-}" ] || [ -z "${APP_DB_SERVICE_USER:-}" ]; then
    mark_failed postgres_db "runtime env lacks required Postgres root/user names"
  else
    app_pass="$(read_openbao_key APP_DB_PASSWORD)" || { failed=1; app_pass=""; }
    svc_pass="$(read_openbao_key APP_DB_SERVICE_PASSWORD)" || { failed=1; svc_pass=""; }
    readonly_pass="$(read_openbao_key APP_DB_READONLY_PASSWORD)" || { failed=1; readonly_pass=""; }
    if [ -n "$app_pass" ] && [ -n "$svc_pass" ] && [ -n "$readonly_pass" ]; then
      pg_state=unchanged
      role_rc=0
      ensure_postgres_role "$APP_DB_USER" "$app_pass" "" || role_rc=$?
      [ "$role_rc" -eq 0 ] && pg_state=created
      role_rc=0
      ensure_postgres_role "$APP_DB_SERVICE_USER" "$svc_pass" "BYPASSRLS" || role_rc=$?
      [ "$role_rc" -eq 0 ] && pg_state=created
      role_rc=0
      ensure_postgres_role "$APP_DB_READONLY_USER" "$readonly_pass" "BYPASSRLS" || role_rc=$?
      [ "$role_rc" -eq 0 ] && pg_state=created
      if ensure_postgres_db; then
        pg_state=created
      fi
      if postgres_sql postgres "SELECT 1 FROM pg_database WHERE datname='${node_db}'" 2>/dev/null | tr -d '[:space:]' | grep -qx 1; then
        emit_row postgres_db "$pg_state" "$node_db exists"
      else
        mark_failed postgres_db "$node_db was not created"
      fi
    fi
  fi
else
  mark_failed postgres_db "Postgres compose service not present"
fi

if "${runtime_compose[@]}" ps -q doltgres >/dev/null 2>&1; then
  DOLTGRES_PASSWORD="$(read_openbao_key DOLTGRES_PASSWORD)" || { failed=1; DOLTGRES_PASSWORD=""; }
  DOLTGRES_READER_PASSWORD="$(read_openbao_key DOLTGRES_READER_PASSWORD)" || { failed=1; DOLTGRES_READER_PASSWORD=""; }
  DOLTGRES_WRITER_PASSWORD="$(read_openbao_key DOLTGRES_WRITER_PASSWORD)" || { failed=1; DOLTGRES_WRITER_PASSWORD=""; }
  if [ -n "$DOLTGRES_PASSWORD" ] && [ -n "$DOLTGRES_READER_PASSWORD" ] && [ -n "$DOLTGRES_WRITER_PASSWORD" ]; then
    dg_state=unchanged
    role_rc=0
    ensure_doltgres_role knowledge_reader "$DOLTGRES_READER_PASSWORD" || role_rc=$?
    [ "$role_rc" -eq 0 ] && dg_state=created
    role_rc=0
    ensure_doltgres_role knowledge_writer "$DOLTGRES_WRITER_PASSWORD" || role_rc=$?
    [ "$role_rc" -eq 0 ] && dg_state=created
    if ensure_doltgres_db; then
      dg_state=created
    fi
    if doltgres_sql postgres "SELECT 1 FROM pg_database WHERE datname='${knowledge_db}'" 2>/dev/null | tr -d '[:space:]' | grep -qx 1; then
      emit_row doltgres_db "$dg_state" "$knowledge_db exists"
    else
      mark_failed doltgres_db "$knowledge_db was not created"
    fi
  fi
else
  mark_failed doltgres_db "Doltgres compose service not present"
fi

rm -f "$appset_src" "$caddy_src" "$external_secret_src" 2>/dev/null || true

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "Target substrate reconciled for ${node} in ${env_name}."
REMOTE

remote_log=$(mktemp)
set +e
ci_ssh_retry "$ssh_bin" "${ssh_opts[@]}" "root@${vm_host}" bash -s -- \
  "$DEPLOY_ENVIRONMENT" "$TARGET" "$node_db" "$knowledge_db" "$node_host" "$edge_key" "$edge_value" "$node_port" \
  "$remote_appset" "$remote_caddy" "$remote_external_secret" "$wait_attempts" "$wait_sleep_seconds" "$remote_root" \
  <"$REMOTE_SCRIPT_FILE" 2>&1 | tee "$remote_log"
ssh_rc=${PIPESTATUS[0]}
set -e

if [ -n "$ROWS_FILE" ]; then
  while IFS=$'\037' read -r marker row state message error_code; do
    [ "$marker" = "SUBSTRATE_ROW" ] || continue
    append_row "$row" "$state" "$message" "$error_code"
  done <"$remote_log"
fi
rm -f "$remote_log"

if [ "$ssh_rc" -ne 0 ]; then
  write_summary failure
  exit "$ssh_rc"
fi

write_summary success
