#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-node-substrate.sh — day-2 substrate readiness for one catalog node.
#
# This is the narrow lane for a node added after an environment already exists.
# secret-materialize (the SOLE OpenBao writer) runs BEFORE this and owns every
# per-node value, including the per-node DB creds + DSNs at cogni/<env>/<node>.
# This phase is READ-ONLY on OpenBao: it holds an <env>-db-reader token, reads the
# node's per-node DB passwords, applies the node-domain ExternalSecret leaf, updates
# edge/DB inventory, and runs the idempotent per-node DB provisioner (one node per
# invocation). It performs zero OpenBao writes (no bao kv put/patch), does not
# promote images, and does not run the broad deploy-infra compose reconcile.
# See docs/guides/vm-secrets-repair.md.

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
  append_row "${CURRENT_ROW:-init}" failed "$*" "${CURRENT_ROW:-init}"
  exit 1
}

log() {
  printf '[reconcile-node-substrate] %s\n' "$*"
}

log_info() {
  log "$*"
}

# ── Structured reconcile summary (redacted) → Loki via candidate-flight ──────
# Emitted only when SUBSTRATE_RECONCILE_SUMMARY_FILE is set. Schema mirrors
# scripts/ci/assert-target-substrate.sh / the target_substrate_reconcile_summary
# contract: per-row state + error_code, aggregate failed_rows. Key names and
# states only — never secret values.
SUMMARY_FILE="${SUBSTRATE_RECONCILE_SUMMARY_FILE:-}"
ROWS_FILE=""
SUMMARY_WRITTEN=false
CURRENT_ROW="init"

init_summary() {
  [ -n "$SUMMARY_FILE" ] || return 0
  command -v python3 >/dev/null 2>&1 || { SUMMARY_FILE=""; return 0; }
  ROWS_FILE="$(mktemp -t substrate-reconcile-rows.XXXXXX)"
}

append_row() {
  [ -n "${ROWS_FILE:-}" ] || return 0
  ROW_NAME="$1" ROW_STATE="$2" ROW_MESSAGE="${3:-}" ROW_ERROR_CODE="${4:-}" \
    python3 - >>"$ROWS_FILE" <<'PY'
import json, os
payload = {"row": os.environ["ROW_NAME"], "state": os.environ["ROW_STATE"]}
message = os.environ.get("ROW_MESSAGE", "")
error_code = os.environ.get("ROW_ERROR_CODE", "")
if message:
    payload["message"] = message
if error_code:
    payload["error_code"] = error_code
print(json.dumps(payload, separators=(",", ":")))
PY
}

# mark_row <name> <state> [message] — record a converged row and advance the
# phase pointer fail() attributes errors to.
mark_row() {
  CURRENT_ROW="$1"
  append_row "$1" "$2" "${3:-}"
}

write_summary() {
  [ -n "$SUMMARY_FILE" ] || return 0
  local status="$1"
  SUBSTRATE_STATUS="$status" \
    SUBSTRATE_TARGET="$TARGET_NODE" \
    SUBSTRATE_TARGET_TYPE="node" \
    SUBSTRATE_DEPLOY_ENV="$DEPLOY_ENVIRONMENT" \
    SUBSTRATE_NODE_SOURCE_SHA="${NODE_SOURCE_SHA:-}" \
    SUBSTRATE_HEAD_SHA="${HEAD_SHA:-${GITHUB_SHA:-}}" \
    SUBSTRATE_RUN_ID="${GITHUB_RUN_ID:-}" \
    SUBSTRATE_STATUS_URL="${STATUS_URL:-}" \
    SUBSTRATE_WORKFLOW="${GITHUB_WORKFLOW:-}" \
    SUBSTRATE_JOB="${GITHUB_JOB:-}" \
    SUBSTRATE_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}" \
    SUBSTRATE_REF="${GITHUB_REF_NAME:-}" \
    python3 - "${ROWS_FILE:-}" <<'PY' >"${SUMMARY_FILE}.tmp"
import collections, datetime, json, os, sys
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
  rm -f "${caddy_tmp:-}"
  if [ -n "$SUMMARY_FILE" ] && [ "$SUMMARY_WRITTEN" != "true" ]; then
    if [ "$rc" -eq 0 ]; then
      write_summary success
    else
      write_summary failure
    fi
  fi
  rm -f "${ROWS_FILE:-}"
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

# task.5017 — deploy ⊆ provisioned. Refuse to provision substrate for a node whose
# per-env node-set (`envs:`) doesn't include this env; otherwise an env would carry
# substrate (DB/ES) for a node it never deploys. Fail loud, not silent.
node_catalog_file="${COGNI_CATALOG_ROOT}/${TARGET_NODE}.yaml"
[[ -f "$node_catalog_file" ]] || fail "missing catalog file: $node_catalog_file"
if [[ "$(yq -r 'has("envs")' "$node_catalog_file")" != "true" ]]; then
  fail "'$TARGET_NODE' has no 'envs' node-set in the catalog (CATALOG_IS_SSOT)"
fi
# here-string, not `yq | grep -q`: under pipefail a grep-match SIGPIPEs yq and the
# 141 would surface as failure, wrongly rejecting a node that lists the env.
node_envs="$(yq -r '.envs[]' "$node_catalog_file")"
grep -qxF "$DEPLOY_ENVIRONMENT" <<<"$node_envs" \
  || fail "'$TARGET_NODE' is not in the '$DEPLOY_ENVIRONMENT' node-set (envs: $(yq -r '.envs | join(",")' "$node_catalog_file")) — add the env to infra/catalog/${TARGET_NODE}.yaml to deploy it here"

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

init_summary
trap cleanup EXIT

# READ-ONLY: mint the <env>-db-reader token (bound to the db-provisioner SA), never
# the writer. secret-materialize is the sole OpenBao writer; this phase performs
# zero bao kv put/patch (Invariant 16 token boundary).
CURRENT_ROW="reader_token"
BAO_TOKEN="$(
  remote "set -euo pipefail
    jwt=\$(kubectl create token db-provisioner -n default)
    kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
      bao write -field=token auth/kubernetes/login role='${DEPLOY_ENVIRONMENT}-db-reader' jwt=\"\$jwt\""
)"
[[ -n "$BAO_TOKEN" ]] || fail "could not mint ${DEPLOY_ENVIRONMENT}-db-reader token"
mark_row reader_token refreshed "minted ${DEPLOY_ENVIRONMENT}-db-reader token (read-only)"

export REPO_ROOT APP_SOURCE_DIR COGNI_CATALOG_ROOT DOMAIN

# Per-node DB role passwords come from OpenBao (cogni/<env>/<node>), read below via
# the db-reader token — NEVER from VM .env. The superuser (POSTGRES_ROOT) stays in
# the VM .env the compose db-provision service already reads. APP_DB_USER is no
# longer threaded: provision.sh computes app_<node>/service_<node> from the node.
bao_get_field() {
  local svc="$1" k="$2"
  remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 \
    bao kv get -format=json 'cogni/${DEPLOY_ENVIRONMENT}/${svc}'" \
    2>/dev/null | jq -r --arg k "$k" '.data.data[$k] // empty' 2>/dev/null || true
}

# Read THIS node's app + service DB passwords from OpenBao (materialize wrote them
# as source:agent). Fail loud if absent — materialize runs before this phase
# (Invariant 16). Key names only in logs; values never echoed.
CURRENT_ROW="db_creds"
app_db_password="$(bao_get_field "$TARGET_NODE" APP_DB_PASSWORD)"
app_db_service_password="$(bao_get_field "$TARGET_NODE" APP_DB_SERVICE_PASSWORD)"
[[ -n "$app_db_password" && -n "$app_db_service_password" ]] \
  || fail "per-node DB creds absent at cogni/${DEPLOY_ENVIRONMENT}/${TARGET_NODE} — run secret-materialize first (it owns per-node APP_DB_PASSWORD/APP_DB_SERVICE_PASSWORD)"
mark_row db_creds read "read per-node DB creds from OpenBao (key names only)"

# DSN seeding removed: secret-materialize composes + writes the per-node DSNs
# (DATABASE_URL/DATABASE_SERVICE_URL/DOLTGRES_URL) to cogni/<env>/<node>. This phase
# holds a read-only db-reader token and performs zero OpenBao writes — it consumes
# the per-node creds above and hands them to db-provision below.

CURRENT_ROW="externalsecret"
external_secret_file="${APP_SOURCE_DIR}/nodes/${TARGET_NODE}/k8s/external-secrets/${DEPLOY_ENVIRONMENT}/external-secret.yaml"
if [[ -f "$external_secret_file" ]]; then
  remote "kubectl create namespace 'cogni-${DEPLOY_ENVIRONMENT}' --dry-run=client -o yaml | kubectl apply -f - >/dev/null"
  copy_to_remote "$external_secret_file" "/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml"
  remote "kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' apply -f '/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml' >/dev/null && rm -f '/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml'"
  log "applied ExternalSecret ${TARGET_NODE}-env-secrets"
  mark_row externalsecret updated "applied ExternalSecret ${TARGET_NODE}-env-secrets"
else
  fail "missing node ExternalSecret leaf: $external_secret_file"
fi

CURRENT_ROW="caddyfile"
caddy_tmp="$(mktemp)"
COGNI_CATALOG_ROOT="$COGNI_CATALOG_ROOT" bash "$REPO_ROOT/scripts/ci/render-caddyfile.sh" > "$caddy_tmp"
# The primary node (operator) renders as the bare {$DOMAIN} block with a
# {$<SLUG>_UPSTREAM:app:3000} default — the host.docker.internal:<port> value is
# the per-env edge .env override, NOT the template default. Only non-primary
# nodes bake host.docker.internal:<port> into the rendered template, so assert it
# only for them. (The edge_key block presence covers the primary.)
caddy_route_ok=true
grep -Fq "{\$${edge_key}:" "$caddy_tmp" || caddy_route_ok=false
if ! is_primary_host "$TARGET_NODE"; then
  grep -Fq "host.docker.internal:${node_port}" "$caddy_tmp" || caddy_route_ok=false
fi
if ! "$caddy_route_ok"; then
  fail "rendered Caddyfile missing route for ${node_host} (edge_key=${edge_key})"
fi
copy_to_remote "$caddy_tmp" "/tmp/Caddyfile.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}.tmpl"
mark_row caddyfile updated "rendered + staged Caddyfile route for ${node_host}"

CURRENT_ROW="remote_reconcile"
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
  # Single-node db-provision: override COGNI_NODE_DBS to THIS node and inject its
  # per-node OpenBao passwords (read above) via -e, so provision.sh reconciles the
  # per-node app/service roles to the OpenBao value. The passwords transit this SSH
  # command + the docker run env (VM-local, not echoed to CI logs); the declarative
  # endgame (vm-secrets-repair.md) removes this bash transport.
  \"\${runtime_compose[@]}\" --profile bootstrap run --rm \
    -e COGNI_NODE_DBS='${node_db}' \
    -e APP_DB_PASSWORD='${app_db_password}' \
    -e APP_DB_SERVICE_PASSWORD='${app_db_service_password}' \
    db-provision >/dev/null
  if \"\${runtime_compose[@]}\" config --services 2>/dev/null | grep -q '^doltgres$'; then
    \"\${runtime_compose[@]}\" up -d doltgres >/dev/null
    \"\${runtime_compose[@]}\" --profile bootstrap run --rm doltgres-provision >/dev/null
  fi"

mark_row remote_reconcile updated "edge route, DB inventory, and DB provisioners reconciled on VM"
log "substrate ready inputs reconciled for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT})"
write_summary success
