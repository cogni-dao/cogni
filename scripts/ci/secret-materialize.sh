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
#   - read-once → diff → write-missing-only: one prefetch of the node + ancestor
#     paths, a single batched write of just the absent keys, O(1) ssh per node.
#     A re-flight of a born node writes NOTHING (created=0; 0 pod churn);
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

# Batched, idempotent OpenBao I/O (read-once → diff → write-missing-only).
#
# OpenBao is ClusterIP with no Ingress (infra/k8s/argocd/openbao/values.yaml), so
# the only access from a CI runner is ssh→kubectl exec. The previous shape did
# ~6 of those round-trips PER KEY (ancestor scan + existing-read + metadata +
# write) and re-wrote every key every run. This collapses it to O(1) ssh per
# node: one prefetch of the node + ancestor paths into an on-disk cache, then a
# single batched write of ONLY the keys that are missing. A re-flight of a
# born node reads the cache, finds every key present, writes nothing, and exits.
# (North star: move this into an in-cluster Job that talks to OpenBao over
# ClusterIP and drop ssh entirely — docs/design/node-wizard-secret-setting.md.)
CACHE_DIR="$(mktemp -d -t materialize-cache.XXXXXX)"
BATCH_DIR="${CACHE_DIR}/.batch"
mkdir -p "$BATCH_DIR"
trap 'rm -rf "$CACHE_DIR"' EXIT
NODE_PATH_EXISTS=false

bao_exec() {
  remote "kubectl exec ${1} -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao ${2}"
}

# Prefetch one path's full key/value map into the cache (one ssh). Runner-side jq
# extracts; the remote only runs the proven `bao kv get -format=json` shape.
prefetch_path() {
  local svc="$1" json
  json="$(bao_exec "" "kv get -format=json 'cogni/${DEPLOY_ENVIRONMENT}/${svc}'" 2>/dev/null \
    | jq -c '.data.data // {}' 2>/dev/null || true)"
  [[ -z "$json" ]] && json='{}'
  mkdir -p "${CACHE_DIR}/${svc}"
  while IFS=$'\t' read -r key val; do
    [[ -z "$key" ]] && continue
    printf '%s' "$val" > "${CACHE_DIR}/${svc}/${key}"
  done < <(printf '%s' "$json" | jq -r 'to_entries[] | [.key, .value] | @tsv')
}

# Reads serve from the cache the single prefetch populated — no per-key ssh.
# Overrides the lib's ssh/ROOT_TOKEN variants (sourced above).
bao_get_field() {
  local f="${CACHE_DIR}/$1/$2"
  [[ -f "$f" ]] && cat "$f" || true
}

# Writes accumulate into BATCH_DIR; an already-present node key is a no-op
# (idempotent — preserve existing, 0 pod churn). flush_batch writes once.
seed_kv() {
  local k="$2" v="$3"
  [[ -z "$v" ]] && return 0
  [[ -f "${CACHE_DIR}/${TARGET_NODE}/${k}" ]] && return 0
  printf '%s' "$v" > "${BATCH_DIR}/${k}"
}

# One write for all missing keys. put when the node path is new, patch (merge —
# never clobbers sibling keys) when it exists. JSON is built locally via jq
# --rawfile so no secret value ever lands on a command line.
flush_batch() {
  local files=( "$BATCH_DIR"/* )
  [[ -e "${files[0]}" ]] || return 0
  local op="patch"; "$NODE_PATH_EXISTS" || op="put"
  local json='{}' f k
  for f in "${files[@]}"; do
    k="$(basename "$f")"
    json="$(jq --arg k "$k" --rawfile v "$f" '.[$k]=$v' <<<"$json")"
  done
  printf '%s' "$json" | bao_exec "-i" "kv ${op} 'cogni/${DEPLOY_ENVIRONMENT}/${TARGET_NODE}' -" >/dev/null
}

# Is this key minted fresh per-node (source:agent random)? Such keys are NEVER
# inherited — skip the ancestor scan for them (the wasted round-trips the old
# shape paid). Mirrors _resolve_node_value's agent branch.
key_is_agent_generated() {
  local k="$1"
  [[ "$(_cat_field "$k" '.source')" == "agent" \
    && "$(_cat_field "$k" '.service')" != "_shared" \
    && "$(_cat_field "$k" '.shared')" != "true" \
    && "$(_cat_field "$k" '.generate.kind')" =~ ^(base64|hex|sk-cogni)$ ]]
}

# Node-owned secrets only (node-baas-architecture.md: each node owns its own DB
# + secrets). DSNs are deferred to reconcile until per-node DB creds land at
# cogni/<env>/<node> (vm-secrets-repair.md, #1584); _shared persists for other
# shared values until catalog inheritFrom.
DSN_DEFER_KEYS=" DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_URL "

# Transitional shared/human inheritance — the blind ancestor scan the north star
# replaces with explicit catalog `inheritFrom` (catalog-custody lane). Now serves
# from the prefetched cache, and only runs for non-agent keys.
inherit_shared_value() {
  local k="$1" v=""
  [[ -n "${!k:-}" ]] && return 0
  for svc in node-template operator _shared; do
    v="$(bao_get_field "$svc" "$k")"
    if [[ -n "$v" ]]; then export "${k}=${v}"; return 0; fi
  done
  return 0
}

# One prefetch: node-path existence + node/ancestor key maps (O(1) ssh).
if bao_exec "" "kv metadata get 'cogni/${DEPLOY_ENVIRONMENT}/${TARGET_NODE}'" >/dev/null 2>&1; then
  NODE_PATH_EXISTS=true
fi
for svc in "$TARGET_NODE" node-template operator _shared; do
  prefetch_path "$svc"
done

log "materializing node-owned OpenBao values for ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (key names only)"
created=0
unchanged=0
for k in "${NODE_BASELINE_KEYS[@]}"; do
  case "$DSN_DEFER_KEYS" in *" $k "*) continue ;; esac
  _node_gets_key "$TARGET_NODE" "$k" || continue
  if [[ -f "${CACHE_DIR}/${TARGET_NODE}/${k}" ]]; then
    unchanged=$((unchanged + 1))
    continue
  fi
  key_is_agent_generated "$k" || inherit_shared_value "$k"
  v="$(_resolve_node_value "$TARGET_NODE" "$k")"
  [[ -z "$v" ]] && continue
  seed_kv "$TARGET_NODE" "$k" "$v"
  log "  created ${k}"
  created=$((created + 1))
done
flush_batch
log "materialize complete for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT}): created=${created} unchanged=${unchanged}"
