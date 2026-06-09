#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# secret-materialize.sh — the ONLY OpenBao writer in the node substrate lane.
#
# Runs before reconcile-substrate for one catalog node. It is the sole holder of
# the <env>-writer role. Per docs/spec/secrets-management.md Invariants 15/16 and
# docs/design/node-wizard-secret-setting.md:
#   - input is the secrets catalog ONLY; it never reads the VM runtime .env;
#   - source:agent keys are generated once and preserved on re-run (0 pod churn);
#   - source:derived keys (DB DSNs, DOLTGRES_*, APP_DB_READONLY) are computed from
#     OpenBao-owned inputs and written back to OpenBao;
#   - DB component inputs (POSTGRES_ROOT_PASSWORD, APP_DB_*) are read from OpenBao
#     and FAIL LOUD if absent — a missing env-bank value is an environment
#     precondition failure, never a VM .env fallback (the bug.5002 anti-fix);
#   - it logs key NAMES only, never values.
#
# It does NOT apply ExternalSecrets, touch edge/DB inventory, or run provisioners
# — those are reconcile-substrate's read-only responsibilities.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ENVIRONMENT="${1:-${DEPLOY_ENVIRONMENT:-}}"
TARGET_NODE="${2:-${TARGET:-}}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-$REPO_ROOT}"
SSH_BIN="${SECRET_MATERIALIZE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

# Env-bank service path holding per-environment DB component credentials. These
# are seeded once by env genesis (provision-env-vm.sh), not by node birth.
ENV_DB_BANK="${ENV_DB_BANK:-node-template}"

fail() {
  echo "::error::secret-materialize: $*" >&2
  exit 1
}

log() {
  printf '[secret-materialize] %s\n' "$*"
}

log_info() {
  log "$*"
}

usage() {
  cat >&2 <<'USAGE'
Usage: secret-materialize.sh <candidate-a|preview|production> <node>

Required env:
  VM_HOST

Optional env:
  APP_SOURCE_DIR, ENV_DB_BANK, SSH_OPTS
USAGE
}

[[ -n "$DEPLOY_ENVIRONMENT" && -n "$TARGET_NODE" ]] || { usage; exit 2; }
[[ "$DEPLOY_ENVIRONMENT" =~ ^(candidate-a|preview|production)$ ]] \
  || fail "unsupported env '$DEPLOY_ENVIRONMENT'"
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"

case "$APP_SOURCE_DIR" in
  /*) ;;
  *) APP_SOURCE_DIR="$(cd "$APP_SOURCE_DIR" 2>/dev/null && pwd)" || fail "missing app source dir: $APP_SOURCE_DIR" ;;
esac

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

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
remote() {
  "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"
}

# Mint the <env>-writer token via the sanctioned k8s-auth seam. This script is
# the only phase permitted to hold it (Invariant 16 token boundary).
BAO_TOKEN="$(
  remote "set -euo pipefail
    jwt=\$(kubectl create token openbao-operator -n default)
    kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
      bao write -field=token auth/kubernetes/login role='${DEPLOY_ENVIRONMENT}-writer' jwt=\"\$jwt\""
)"
[[ -n "$BAO_TOKEN" ]] || fail "could not mint ${DEPLOY_ENVIRONMENT}-writer token"

export REPO_ROOT APP_SOURCE_DIR
export DEPLOY_ENV="$DEPLOY_ENVIRONMENT"
export VM_IP="${VM_IP:-$(remote "hostname -I | awk '{print \$1}'" | tr -d '[:space:]')}"
export CATALOG_FILE="${APP_SOURCE_DIR}/infra/secrets-catalog.yaml"
export PAYMENT_NODES="${PAYMENT_NODES:-poly}"
export DOMAIN="${DOMAIN:-}"

# shellcheck source=../setup/lib/reconcile-secrets.sh
# Provides NODE_BASELINE_KEYS, derive_secret, _resolve_node_value (preserve-
# existing + per-node generate; no blind ancestor scan), and seed_node_app_secrets.
# Sourced FIRST so the token-bound bao_get_field/seed_kv below override the lib's
# ROOT_TOKEN/ssh variants.
source "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh"

# OpenBao read/write helpers bound to the env-writer token. seed_kv preserves an
# existing path (patch) and only creates it (put) when absent.
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

# DB component inputs come from OpenBao only. A missing value is an env-bank
# precondition failure, never a VM .env fallback (Invariant 15 anti-fix).
require_env_bank() {
  local k="$1" v
  v="$(bao_get_field "$ENV_DB_BANK" "$k")"
  [[ -n "$v" ]] || fail "env-bank value cogni/${DEPLOY_ENVIRONMENT}/${ENV_DB_BANK}:${k} absent; seed it via env genesis before node materialization (do NOT read VM .env)"
  printf '%s' "$v"
}

# Declare/assign separately: an inline `export X="$(require_env_bank …)"` would
# mask the subshell's `exit 1`, so set -e would not catch a missing env-bank
# value and fail-loud would silently become fail-empty.
POSTGRES_ROOT_PASSWORD="$(require_env_bank POSTGRES_ROOT_PASSWORD)"
APP_DB_USER="$(require_env_bank APP_DB_USER)"
APP_DB_PASSWORD="$(require_env_bank APP_DB_PASSWORD)"
APP_DB_SERVICE_USER="$(require_env_bank APP_DB_SERVICE_USER)"
APP_DB_SERVICE_PASSWORD="$(require_env_bank APP_DB_SERVICE_PASSWORD)"
export POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD

log "materializing OpenBao values for ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (key names only)"
seed_node_app_secrets "$TARGET_NODE"
log "materialize complete for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT})"
