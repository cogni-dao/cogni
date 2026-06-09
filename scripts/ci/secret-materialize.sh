#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# secret-materialize.sh — writer of node-owned source:agent app secrets.
#
# Runs before reconcile-substrate for one catalog node. Per
# docs/spec/secrets-management.md Invariants 15/16 and
# docs/design/node-wizard-secret-setting.md, AS BUILT today:
#   - input is the secrets catalog ONLY; it never reads the VM runtime .env;
#   - source:agent app keys are generated once and preserved on re-run (0 pod churn);
#   - shared/human values are inherited transitionally (see inherit_shared_value);
#   - it logs key NAMES only, never values.
#
# TRANSITIONAL (not yet the target): the DB DSNs (DATABASE_URL, DATABASE_SERVICE_URL,
# DOLTGRES_URL) are still seeded by reconcile-substrate (which mints <env>-writer
# for that one write) until the env-repair lane lands cogni/<env>/<node> DB creds
# (docs/guides/vm-secrets-repair.md, #1584). Only after that does this become the
# SOLE OpenBao writer and reconcile go fully read-only. Until then the falsifying
# gate cannot pass and this PR must not claim deploy_verified via that gate.
#
# It does NOT apply ExternalSecrets, touch edge/DB inventory, or run provisioners
# — those are reconcile-substrate's responsibilities.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ENVIRONMENT="${1:-${DEPLOY_ENVIRONMENT:-}}"
TARGET_NODE="${2:-${TARGET:-}}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-$REPO_ROOT}"
SSH_BIN="${SECRET_MATERIALIZE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

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
  APP_SOURCE_DIR, SSH_OPTS
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

# Mint the <env>-writer token via the sanctioned k8s-auth seam. Target: this is
# the only phase permitted to hold it (Invariant 16 token boundary). Transitional:
# reconcile-substrate also mints it to seed DSNs until the env-repair lane lands.
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
# DOMAIN is required: derive-env keys (APP_BASE_URL, NEXTAUTH_URL) build the
# node FQDN from it. Empty DOMAIN would silently materialize broken https://<host>
# values, so fail loud (mirrors reconcile-node-substrate.sh).
[[ -n "${DOMAIN:-}" ]] || fail "DOMAIN is required (derive-env keys build the node FQDN)"
export DOMAIN

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

# Node-owned secrets only (node-baas-architecture.md: each node owns its own DB
# + secrets). This phase does NOT read the shared Postgres superuser or any
# env-level DB credential — that substrate belongs to env genesis/repair, not
# node birth. It generates this node's source:agent app keys, preserving any
# existing value (0 pod churn on re-run). The per-node DB role password + DSNs
# are seeded by reconcile transitionally and move here once DB creds land
# per-node at cogni/<env>/<node> (vm-secrets-repair.md, #1584 — DB creds are
# per-node, never _shared; _shared may persist for other shared values until
# inheritFrom). The superuser that creates the role is env-repair's, read-only.
DSN_DEFER_KEYS=" DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_URL "

# Transitional shared/human inheritance. The blind ancestor scan is the
# anti-pattern the north star replaces with an explicit catalog `inheritFrom`
# (catalog-custody lane; not built yet). Until it lands, shared/human values a
# node legitimately consumes (OPENROUTER_API_KEY, OAuth, etc.) are inherited
# here. source:agent keys are regenerated per-node by _resolve_node_value
# regardless, so they are NOT inherited in practice — only genuinely shared
# values flow through this.
inherit_shared_value() {
  local k="$1" v=""
  [[ -n "${!k:-}" ]] && return 0
  for svc in node-template operator _shared; do
    v="$(bao_get_field "$svc" "$k")"
    if [[ -n "$v" ]]; then export "${k}=${v}"; return 0; fi
  done
  return 0
}

log "materializing node-owned OpenBao values for ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (key names only)"
materialized=0
for k in "${NODE_BASELINE_KEYS[@]}"; do
  case "$DSN_DEFER_KEYS" in *" $k "*) continue ;; esac
  _node_gets_key "$TARGET_NODE" "$k" || continue
  # TODO(inheritFrom): blind ancestor scan + copy-inheritance — anti-pattern the
  # north star deletes. Each node freezes its own copy, so rotating a shared key
  # never propagates. Replace with explicit catalog inheritFrom + read grants
  # (secrets-classification.md owner-scoped paths; catalog-custody lane).
  inherit_shared_value "$k"
  v="$(_resolve_node_value "$TARGET_NODE" "$k")"
  [[ -z "$v" ]] && continue
  seed_kv "$TARGET_NODE" "$k" "$v"
  log "  materialized ${k}"
  materialized=$((materialized + 1))
done
log "materialize complete for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT}): ${materialized} key(s)"
