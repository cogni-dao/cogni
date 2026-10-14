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
# DB inventory, and runs the idempotent per-node DB provisioner (one node per
# invocation) regardless of app placement. Only k3s placement updates the shared
# Caddy/NodePort edge; external placement leaves that edge untouched. It performs
# zero OpenBao writes (no bao kv put/patch), does not promote images, and does not
# run the broad deploy-infra compose reconcile.
# See docs/guides/vm-secrets-repair.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ENVIRONMENT="${1:-${DEPLOY_ENVIRONMENT:-}}"
TARGET_NODE="${2:-${TARGET:-}}"
DEPLOYMENT_PROVIDER="${DEPLOYMENT_PROVIDER:-k3s}"
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
  rm -f "${caddy_tmp:-}" "${database_reliability_es_tmp:-}" "${migration_es_tmp:-}"
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
case "$DEPLOYMENT_PROVIDER" in
  k3s|akash) ;;
  *) fail "unsupported DEPLOYMENT_PROVIDER '$DEPLOYMENT_PROVIDER'" ;;
esac
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

# shellcheck source=lib/appset-paths.sh
CATALOG_DIR="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-.}/infra/catalog}" \
  source "$SCRIPT_DIR/lib/appset-paths.sh"
# shellcheck source=lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

# WHICH CLUSTER AM I RECONCILING AGAINST (bug.5206)? For every row that exists today this is
# the env itself. For an akash node's non-production lane the PAYING cluster reconciles it, so
# this script runs against THAT cluster's VM — its vault, its roles, its Postgres. The lane
# still names the secret path and the database; only the IDENTITY follows the cluster.
SUBSTRATE_CONTROL_ENV="$(CATALOG_DIR="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-.}/infra/catalog}" \
  control_env_for "$DEPLOY_ENVIRONMENT" "$TARGET_NODE" 2>/dev/null || printf '%s' "$DEPLOY_ENVIRONMENT")"

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

node_db="$(node_database_for_target "$TARGET_NODE" "$DEPLOY_ENVIRONMENT")"
node_role_suffix="${node_db#cogni_}"
migration_role="migration_${node_role_suffix}"
app_role="app_${node_role_suffix}"
node_id="$(node_id_for_target "$TARGET_NODE")" \
  || fail "node_id missing for '$TARGET_NODE' (REPO_SPEC_IS_IDENTITY_SSOT)"
node_temporal_namespace="cogni-${DEPLOY_ENVIRONMENT}-${node_id}"
reliability_controller="$(yq -r '.reliability.controller // false' "$node_catalog_file")"
[[ "$reliability_controller" == true || "$reliability_controller" == false ]] \
  || fail "invalid reliability controller capability for '$TARGET_NODE'"

# Catalog-selected Postgres budget. The declaration becomes enforcement only
# when this immutable checkout resolves the named profile and passes the exact
# values to the one-node provisioner. Never silently fall back to a default.
budget_profile="$(yq -er ".database.\"${DEPLOY_ENVIRONMENT}\".budget_profile" "$node_catalog_file")" \
  || fail "database budget_profile missing for ${TARGET_NODE}/${DEPLOY_ENVIRONMENT}"
budget_profiles_file="${APP_SOURCE_DIR}/infra/database-budget-profiles.yaml"
[[ -f "$budget_profiles_file" ]] || fail "missing database budget profiles: $budget_profiles_file"
budget_value() {
  yq -er ".\"${budget_profile}\".$1" "$budget_profiles_file" \
    || fail "budget profile '${budget_profile}' missing required field '$1'"
}
db_app_connection_limit="$(budget_value roles.app.connection_limit)"
db_app_statement_timeout_ms="$(budget_value roles.app.statement_timeout_ms)"
db_service_connection_limit="$(budget_value roles.service.connection_limit)"
db_service_statement_timeout_ms="$(budget_value roles.service.statement_timeout_ms)"
db_lock_timeout_ms="$(budget_value common.lock_timeout_ms)"
db_idle_in_transaction_timeout_ms="$(budget_value common.idle_in_transaction_session_timeout_ms)"
db_temp_file_limit_mib="$(budget_value common.temp_file_limit_mib)"
db_work_mem_mib="$(budget_value common.work_mem_mib)"
for budget_number in \
  "$db_app_connection_limit" "$db_app_statement_timeout_ms" \
  "$db_service_connection_limit" "$db_service_statement_timeout_ms" \
  "$db_lock_timeout_ms" "$db_idle_in_transaction_timeout_ms" \
  "$db_temp_file_limit_mib" "$db_work_mem_mib"; do
  [[ "$budget_number" =~ ^[1-9][0-9]*$ ]] \
    || fail "budget profile '${budget_profile}' contains a non-positive integer"
done

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
# bug.5159 — multiplex every remote call over ONE ssh connection. Each remote() used to
# open a fresh handshake (~20-40 per run); sshd/edge admission control drops bursts of
# new connections at kex (MaxStartups-class), which killed 8 promotes. One master
# connection removes the burst entirely; ControlPersist outlives the run harmlessly on
# an ephemeral runner.
SSH_OPTS_ARR+=(-o ControlMaster=auto -o "ControlPath=${TMPDIR:-/tmp}/cogni-ssh-%r@%h-%p" -o ControlPersist=180)
# shellcheck source=lib/ssh-retry.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/ssh-retry.sh"
remote() {
  cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"
}
copy_to_remote() {
  cogni_ssh_transport_retry "$SCP_BIN" "${SSH_OPTS_ARR[@]}" "$1" "root@${VM_HOST}:$2"
}

# Every executable, manifest, config, and compose definition used by this lane
# must come from the exact reviewed source tree. A plain scp is not provenance:
# fixed /tmp names can be overwritten by another reconcile and a stale VM
# compose file can redirect a verified provisioner mount. Give each artifact an
# invocation-unique path, verify its source hash on the VM immediately, and only
# then expose that path to the apply/execute/install step.
STAGE_NONCE="${GITHUB_RUN_ID:-local}.${GITHUB_RUN_ATTEMPT:-0}.$$.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}"
STAGED_EXACT_PATH=""
STAGED_EXACT_SHA256=""
stage_exact() {
  local source="$1" label="$2" safe_label
  [[ -f "$source" ]] || fail "exact-source artifact missing: $source"
  [[ "$label" =~ ^[a-z0-9-]+$ ]] || fail "invalid exact-source label: $label"
  safe_label="${label}.${STAGE_NONCE}"
  STAGED_EXACT_SHA256="$(shasum -a 256 "$source" | awk '{print $1}')"
  STAGED_EXACT_PATH="/tmp/cogni-reconcile.${safe_label}.${STAGED_EXACT_SHA256}"
  copy_to_remote "$source" "$STAGED_EXACT_PATH"
  remote "set -euo pipefail
    [ \"\$(sha256sum '${STAGED_EXACT_PATH}' | awk '{print \$1}')\" = '${STAGED_EXACT_SHA256}' ] || {
      rm -f '${STAGED_EXACT_PATH}'
      echo '::error::exact-source hash mismatch for ${label}' >&2
      exit 1
    }
    chmod 0400 '${STAGED_EXACT_PATH}'"
}

init_summary
trap cleanup EXIT

# READ-ONLY: mint the <env>-db-reader token (bound to the db-provisioner SA), never
# the writer. secret-materialize is the sole OpenBao writer; this phase performs
# zero bao kv put/patch (Invariant 16 token boundary).
CURRENT_ROW="reader_token"
BAO_TOKEN="$(
  cogni_openbao_kubernetes_login_retry remote "set -euo pipefail
    jwt=\$(kubectl create token db-provisioner -n default)
    kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
      bao write -field=token auth/kubernetes/login role='${SUBSTRATE_CONTROL_ENV}-db-reader' jwt=\"\$jwt\""
)"
[[ -n "$BAO_TOKEN" ]] || fail "could not mint ${SUBSTRATE_CONTROL_ENV}-db-reader token (reconciling the '${DEPLOY_ENVIRONMENT}' lane)"
mark_row reader_token refreshed "minted ${SUBSTRATE_CONTROL_ENV}-db-reader token (read-only) for the ${DEPLOY_ENVIRONMENT} lane"

export REPO_ROOT APP_SOURCE_DIR COGNI_CATALOG_ROOT DOMAIN

# Per-node DB role passwords come from OpenBao (cogni/<env>/<node>), read below via
# the db-reader token — NEVER from VM .env. The superuser (POSTGRES_ROOT) stays in
# the VM .env the compose db-provision service already reads. APP_DB_USER is no
# longer threaded: provision.sh computes app_<node>/service_<node> from the node.
# bug.5159 — a transport failure (ssh drop, exec hiccup, OpenBao down) must never read
# as "key absent": the swallowed-error shape produced lying "per-node DB creds absent"
# failures on paths that demonstrably held 35 keys. Only "No value found" (an unborn
# path) is a legitimate empty; anything else retries and then fails naming the transport.
# SHARED-SUBSTRATE OWNERS LIVE WHERE THE SUBSTRATE DOES (bug.5206). A node-scoped read is
# the LANE's (`cogni/<lane>/<node>`), but `operator` and `_shared` describe the SERVER this
# run is mutating — the Doltgres superuser, the DoltHub mirror creds — and that server is the
# CONTROL env's. `cogni/<lane>/operator` does not exist in the paying cluster's vault and
# never should. secret-materialize.sh already resolves this via its `__owner__` cache; this
# file is its twin and never got the fix, so the production-side lane reconcile died on
# "doltgres superuser SSOT absent at cogni/candidate-a/operator/DOLTGRES_PASSWORD".
_bao_env_for_svc() {
  case "$1" in
    operator|_shared|node-template) printf '%s' "$SUBSTRATE_CONTROL_ENV" ;;
    *)                              printf '%s' "$DEPLOY_ENVIRONMENT" ;;
  esac
}

bao_get_field() {
  local svc="$1" k="$2" raw attempt bao_env
  bao_env="$(_bao_env_for_svc "$svc")"
  for attempt in 1 2 3; do
    if raw="$(remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 \
      bao kv get -format=json 'cogni/${bao_env}/${svc}'" 2>&1)"; then
      printf '%s' "$raw" | jq -r --arg k "$k" '.data.data[$k] // empty' 2>/dev/null || true
      return 0
    fi
    case "$raw" in *"No value found"*) return 0 ;; esac
    echo "[reconcile-node-substrate] OpenBao read cogni/${DEPLOY_ENVIRONMENT}/${svc} attempt ${attempt}/3 failed: $(printf '%s' "$raw" | tail -1)" >&2
    sleep $((attempt * 5))
  done
  fail "OpenBao TRANSPORT failure reading cogni/${DEPLOY_ENVIRONMENT}/${svc} after 3 attempts — not an absent key (bug.5159)"
}

bao_get_version() {
  local svc="$1" raw attempt bao_env
  bao_env="$(_bao_env_for_svc "$svc")"
  for attempt in 1 2 3; do
    if raw="$(remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 \
      bao kv get -format=json 'cogni/${bao_env}/${svc}'" 2>&1)"; then
      printf '%s' "$raw" | jq -r '.data.metadata.version // empty' 2>/dev/null || true
      return 0
    fi
    case "$raw" in *"No value found"*) return 0 ;; esac
    sleep $((attempt * 5))
  done
  fail "OpenBao TRANSPORT failure reading version for cogni/${bao_env}/${svc}"
}

# Read THIS node's app + service DB passwords from OpenBao (materialize wrote them
# as source:agent). Fail loud if absent — materialize runs before this phase
# (Invariant 16). Key names only in logs; values never echoed.
CURRENT_ROW="db_creds"
app_db_password="$(bao_get_field "$TARGET_NODE" APP_DB_PASSWORD)"
app_db_service_password="$(bao_get_field "$TARGET_NODE" APP_DB_SERVICE_PASSWORD)"
app_db_migration_password="$(bao_get_field "${TARGET_NODE}-database-migration" APP_DB_MIGRATION_PASSWORD)"
migration_dsn="$(bao_get_field "${TARGET_NODE}-database-migration" DATABASE_MIGRATION_URL)"
migration_secret_version="$(bao_get_version "${TARGET_NODE}-database-migration")"
[[ -n "$app_db_password" && -n "$app_db_service_password" && -n "$app_db_migration_password" && -n "$migration_dsn" && -n "$migration_secret_version" ]] \
  || fail "per-node DB creds absent at node/runtime or isolated migration OpenBao paths — run secret-materialize first"
migration_dsn_sha256="$(printf '%s' "$migration_dsn" | shasum -a 256 | awk '{print $1}')"
mark_row db_creds read "read per-node DB creds from OpenBao (key names only)"

# Private containment actuator credential. secret-materialize mints this into a
# dedicated platform-service bucket; the reader passes only the component
# password to the one-shot provisioner and never exposes the root DSN.
database_reliability_password=""
database_reliability_readmit_password=""
if [[ "$reliability_controller" == true ]]; then
  database_reliability_password="$(bao_get_field database-reliability-actuator DATABASE_RELIABILITY_PASSWORD)"
  database_reliability_readmit_password="$(bao_get_field database-reliability-readmitter DATABASE_RELIABILITY_READMIT_PASSWORD)"
  [[ -n "$database_reliability_password" && -n "$database_reliability_readmit_password" ]] \
    || fail "database reliability credentials absent from platform-service buckets — controller materialization must precede provisioning"
  mark_row database_reliability_creds read "read dedicated reliability role password from OpenBao (key name only)"
fi

# Doltgres superuser password — the OpenBao-custodied SSOT at the canonical operator
# path (cogni/<env>/operator/DOLTGRES_PASSWORD). The superuser is shared env-wide
# (one server, every node's knowledge_<node> DB), so operator holds the single
# authoritative value and all consumers read it there — mirrors the #1613
# OPENFGA_DB_PASSWORD pattern. It is immutable post-init (Doltgres 0.56.3 cannot
# ALTER it — databases.md §5.2); a restored/rotated volume is reconciled to the live
# value via `pnpm secrets:set <env> operator DOLTGRES_PASSWORD` (secrets-rotate.md),
# never re-derived. Passed to doltgres-provision so it connects as the live superuser.
# Fail-loud if the SSOT is empty — never silently fall back to a poisoned VM .env.
doltgres_superuser_password="$(bao_get_field operator DOLTGRES_PASSWORD)"
[[ -n "$doltgres_superuser_password" ]] \
  || fail "doltgres superuser SSOT absent at cogni/${DEPLOY_ENVIRONMENT}/operator/DOLTGRES_PASSWORD — run secret-materialize, or seed/reconcile it via 'pnpm secrets:set ${DEPLOY_ENVIRONMENT} operator DOLTGRES_PASSWORD' (never fall back to a derived/.env value)"
dg_pw_env="-e DOLTGRES_PASSWORD='${doltgres_superuser_password}'"

# DoltHub knowledge-mirror creds — env-global (one doltgres server + one DoltHub
# identity per env), so read from the operator-canonical bank (cogni/<env>/operator),
# the same SSOT idiom as DOLTGRES_PASSWORD just above (#1613 pattern). secret-materialize
# already materializes these _shared/source:human keys into every node bank (they are in
# NODE_BASELINE_KEYS), so the db-reader token resolves them here with zero new writes.
#
# WHY HERE (Option B — substrate lane, not deploy-infra): the doltgres Compose service
# reads DOLT_CREDS_JWK/KEYID from the VM runtime .env via install-creds.sh at container
# start. Only deploy-infra wrote them there, but an app-only promote runs skip_infra and
# skips deploy-infra — so a fresh env that pasted DOLT_CREDS via THE PATH + a normal
# promote got the app code but a credless doltgres, and dolt_push failed silently. This
# folds the SAME render-.env + recreate-doltgres primitive deploy-infra runs into the
# always-on substrate-readiness lane (Axiom 22), so the mirror comes up on EVERY flight/
# promote with no separate infra run — the exact shape bug.5041 used for the Alloy config.
#
# FAIL-CLOSED: absent JWK/KEYID ⇒ mirror stays disabled (install-creds.sh is a no-op when
# unset). NEVER a hardcoded fallback. Key names only in logs; values never echoed.
# PROD-ONLY blast-radius guard (bug.5003): the DoltHub push identity (JWK/KEYID) +
# repo-create PAT are ONE shared, PROD-CAPABLE credential (push rights to cogni-dao).
# A non-prod env must NEVER hold it in the doltgres — not even a value left over from a
# pre-guard materialize or a prior flight's render. So ONLY production reads + delivers
# the mirror creds; every other env actively STRIPS them from the VM runtime .env +
# recreates doltgres (fail-closed = actively disabled, not merely not-rendered). This
# is the VM-side complement to the reconcile-secrets.sh _node_gets_key prod-only guard
# (which stops future bank writes but cannot remove an already-delivered VM cred).
dolt_mirror_enabled=false
dolt_mirror_purge=false
# THE VM DECIDES, NOT THE LANE (bug.5206). bug.5003's rule is that a NON-PRODUCTION VM must
# not hold prod-capable DoltHub creds — that is a property of the HOST being mutated, and for
# a foreign-custodied lane the host is the CONTROL env's VM. Keyed on the lane, a candidate-a
# lane reconcile running against PRODUCTION's VM took the purge branch: it would strip
# DOLT_CREDS_*/DOLTHUB_* out of production's runtime .env and force-recreate production's
# doltgres, taking the production knowledge mirror dark on every lane promote. This is why it
# lands in the SAME commit as the owner-read fix above — that fix is what lets this line be
# reached at all.
if [[ "$SUBSTRATE_CONTROL_ENV" == "production" ]]; then
  dolt_creds_jwk="$(bao_get_field operator DOLT_CREDS_JWK)"
  dolt_creds_keyid="$(bao_get_field operator DOLT_CREDS_KEYID)"
  dolthub_owner="$(bao_get_field operator DOLTHUB_OWNER)"
  dolthub_api_token="$(bao_get_field operator DOLTHUB_API_TOKEN)"
  if [[ -n "$dolt_creds_jwk" && -n "$dolt_creds_keyid" ]]; then
    dolt_mirror_enabled=true
    mark_row dolt_mirror_creds read "read DoltHub mirror creds from OpenBao (key names only)"
    log "DoltHub mirror creds present — will render to VM runtime .env + recreate doltgres"
  else
    mark_row dolt_mirror_creds skipped "DoltHub mirror creds absent — mirror stays disabled (no fallback)"
    log "DoltHub mirror creds absent at cogni/${DEPLOY_ENVIRONMENT}/operator — mirror disabled (fail-closed, no fallback)"
  fi
else
  dolt_mirror_purge=true
  mark_row dolt_mirror_creds purged "non-prod: DoltHub mirror is prod-only — creds withheld + stripped from VM .env (bug.5003)"
  log "non-prod (${DEPLOY_ENVIRONMENT}): DoltHub mirror is prod-only — stripping any mirror creds from VM runtime .env + recreating doltgres if present"
fi

# DSN seeding removed: secret-materialize composes + writes the per-node DSNs
# (DATABASE_URL/DATABASE_SERVICE_URL/DOLTGRES_URL) to cogni/<env>/<node>. This phase
# holds a read-only db-reader token and performs zero OpenBao writes — it consumes
# the per-node creds above and hands them to db-provision below.

CURRENT_ROW="externalsecret"
external_secret_file="${APP_SOURCE_DIR}/nodes/${TARGET_NODE}/k8s/external-secrets/${DEPLOY_ENVIRONMENT}/external-secret.yaml"
if [[ -f "$external_secret_file" ]]; then
  expected_secret_name="${TARGET_NODE}-env-secrets"
  legacy_target="$(remote "kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' get externalsecret env-secrets -o jsonpath='{.spec.target.name}' 2>/dev/null || true")"
  if [[ "$legacy_target" == "$expected_secret_name" ]]; then
    remote "kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' delete externalsecret env-secrets --wait=true >/dev/null"
    log "deleted legacy ExternalSecret env-secrets targeting ${expected_secret_name}"
    mark_row externalsecret_legacy pruned "deleted legacy ExternalSecret env-secrets targeting ${expected_secret_name}"
  elif [[ -n "$legacy_target" ]]; then
    log "leaving legacy ExternalSecret env-secrets in place; target is ${legacy_target}, expected ${expected_secret_name}"
  fi
  remote "kubectl create namespace 'cogni-${DEPLOY_ENVIRONMENT}' --dry-run=client -o yaml | kubectl apply -f - >/dev/null"
  stage_exact "$external_secret_file" node-external-secret
  node_external_secret_stage="$STAGED_EXACT_PATH"
  remote "kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' apply -f '${node_external_secret_stage}' >/dev/null && rm -f '${node_external_secret_stage}'"
  log "applied ExternalSecret ${TARGET_NODE}-env-secrets"
  mark_row externalsecret updated "applied ExternalSecret ${TARGET_NODE}-env-secrets"
  remote "set -euo pipefail
    ns='cogni-${DEPLOY_ENVIRONMENT}'
    es='${expected_secret_name}'
    marker=\$(date +%s)
    kubectl -n \"\$ns\" annotate externalsecret \"\$es\" force-sync=\"\$marker\" --overwrite >/dev/null
    kubectl -n \"\$ns\" wait --for=condition=Ready \"externalsecret/\$es\" --timeout=120s >/dev/null
    kubectl -n \"\$ns\" get secret \"\$es\" >/dev/null
    sleep 5"
  log "force-refreshed ExternalSecret ${TARGET_NODE}-env-secrets"
  mark_row externalsecret_refresh refreshed "force-refreshed ExternalSecret ${TARGET_NODE}-env-secrets"
else
  fail "missing node ExternalSecret leaf: $external_secret_file"
fi

# Migration is a separate capability, never a key in the node app's extracted
# runtime Secret. The base initContainer names this prefixed Secret; off-cluster
# Jobs use the parallel compute-migration ExternalSecret rendered by the platform.
migration_es_tmp="$(mktemp)"
cat > "$migration_es_tmp" <<YAML
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${TARGET_NODE}-migration-secrets
  namespace: cogni-${DEPLOY_ENVIRONMENT}
  labels:
    app.kubernetes.io/part-of: cogni-secrets-substrate
    app.kubernetes.io/component: database-migration
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-backend
    kind: ClusterSecretStore
  target:
    name: ${TARGET_NODE}-migration-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
  data:
    - secretKey: DATABASE_MIGRATION_URL
      remoteRef:
        key: ${DEPLOY_ENVIRONMENT}/${TARGET_NODE}-database-migration
        property: DATABASE_MIGRATION_URL
YAML
stage_exact "$migration_es_tmp" migration-external-secret
migration_external_secret_stage="$STAGED_EXACT_PATH"
remote "set -euo pipefail
  ns='cogni-${DEPLOY_ENVIRONMENT}'
  es='${TARGET_NODE}-migration-secrets'
  kubectl -n \"\$ns\" apply -f '${migration_external_secret_stage}' >/dev/null
  rm -f '${migration_external_secret_stage}'
  marker=\$(date +%s)
  kubectl -n \"\$ns\" annotate externalsecret \"\$es\" force-sync=\"\$marker\" --overwrite >/dev/null
  kubectl -n \"\$ns\" wait --for=condition=Ready \"externalsecret/\$es\" --timeout=120s >/dev/null
  kubectl -n \"\$ns\" get secret \"\$es\" -o jsonpath='{.data.DATABASE_MIGRATION_URL}' | grep -q ."
mark_row migration_externalsecret ready "migration-only DSN projected outside node runtime Secret"

# The catalog-declared reliability controller is a stacked deploy surface (task.5247),
# but its credential substrate is owned here. When that capability is present in
# the exact app source, install and wait its three control-plane ExternalSecrets
# now—after materialization and before candidate assert can observe the app.
# Rendering only these leaves avoids applying workloads from a privileged
# substrate lane; names derive from the controller row and its overlay prefix.
database_reliability_es_file="${APP_SOURCE_DIR}/infra/k8s/overlays/${DEPLOY_ENVIRONMENT}/${TARGET_NODE}/database-reliability-actuator-external-secret.yaml"
controller_es_file="${APP_SOURCE_DIR}/infra/k8s/overlays/${DEPLOY_ENVIRONMENT}/${TARGET_NODE}/external-secret.yaml"
if [[ "$reliability_controller" == true && -f "$database_reliability_es_file" ]]; then
  [[ -f "$controller_es_file" ]] || fail "missing controller ExternalSecret leaf: $controller_es_file"
  database_reliability_es_tmp="$(mktemp)"
  RELIABILITY_NAMESPACE="cogni-${DEPLOY_ENVIRONMENT}" RELIABILITY_CONTROLLER="$TARGET_NODE" \
    yq 'select(.kind == "ExternalSecret" and .metadata.name == "env-secrets") | .metadata.name = strenv(RELIABILITY_CONTROLLER) + "-env-secrets" | .metadata.namespace = strenv(RELIABILITY_NAMESPACE)' \
      "$controller_es_file" > "$database_reliability_es_tmp"
  printf '\n---\n' >> "$database_reliability_es_tmp"
  RELIABILITY_NAMESPACE="cogni-${DEPLOY_ENVIRONMENT}" RELIABILITY_CONTROLLER="$TARGET_NODE" \
    yq 'select(.kind == "ExternalSecret" and (.metadata.name == "database-reliability-actuator-env-secrets" or .metadata.name == "database-reliability-readmitter-env-secrets")) | .metadata.name = strenv(RELIABILITY_CONTROLLER) + "-" + .metadata.name | .metadata.namespace = strenv(RELIABILITY_NAMESPACE)' \
      "$database_reliability_es_file" >> "$database_reliability_es_tmp"
  [[ "$(yq ea '.kind' "$database_reliability_es_tmp" | grep -cx ExternalSecret)" == 3 ]] \
    || fail "database reliability substrate must render exactly three ExternalSecrets"
  stage_exact "$database_reliability_es_tmp" database-reliability-external-secrets
  database_reliability_external_secrets_stage="$STAGED_EXACT_PATH"
  remote "set -euo pipefail
    ns='cogni-${DEPLOY_ENVIRONMENT}'
    manifest='${database_reliability_external_secrets_stage}'
    kubectl apply -f \"\$manifest\" >/dev/null
    rm -f \"\$manifest\"
    marker=\$(date +%s)
    for es in ${TARGET_NODE}-env-secrets ${TARGET_NODE}-database-reliability-actuator-env-secrets ${TARGET_NODE}-database-reliability-readmitter-env-secrets; do
      before_refresh=\$(kubectl -n \"\$ns\" get externalsecret \"\$es\" -o jsonpath='{.status.refreshTime}' 2>/dev/null || true)
      kubectl -n \"\$ns\" annotate externalsecret \"\$es\" force-sync=\"\$marker\" --overwrite >/dev/null
      kubectl -n \"\$ns\" wait --for=condition=Ready \"externalsecret/\$es\" --timeout=120s >/dev/null
      refreshed=false
      for _ in \$(seq 1 60); do
        after_refresh=\$(kubectl -n \"\$ns\" get externalsecret \"\$es\" -o jsonpath='{.status.refreshTime}' 2>/dev/null || true)
        if [[ -n \"\$after_refresh\" && \"\$after_refresh\" != \"\$before_refresh\" ]]; then refreshed=true; break; fi
        sleep 2
      done
      \$refreshed || { echo 'ExternalSecret refresh did not advance:' \"\$es\" >&2; exit 1; }
    done
    for key in DATABASE_RELIABILITY_STATUS_TOKEN DATABASE_RELIABILITY_READMIT_TOKEN; do
      kubectl -n \"\$ns\" get secret ${TARGET_NODE}-env-secrets -o \"jsonpath={.data.\$key}\" | grep -q .
    done
    for key in DATABASE_RELIABILITY_ADMIN_URL DATABASE_RELIABILITY_STATUS_TOKEN PROMETHEUS_READ_USERNAME PROMETHEUS_READ_PASSWORD GRAFANA_SERVICE_ACCOUNT_TOKEN; do
      kubectl -n \"\$ns\" get secret database-reliability-actuator-env-secrets -o \"jsonpath={.data.\$key}\" | grep -q .
    done
    for key in DATABASE_RELIABILITY_READMIT_URL DATABASE_RELIABILITY_READMIT_TOKEN DATABASE_RELIABILITY_STATUS_TOKEN PROMETHEUS_READ_USERNAME PROMETHEUS_READ_PASSWORD; do
      kubectl -n \"\$ns\" get secret database-reliability-readmitter-env-secrets -o \"jsonpath={.data.\$key}\" | grep -q .
    done"
  mark_row database_reliability_externalsecrets ready "freshly reconciled controller, actuator, and readmitter ExternalSecrets"
elif [[ "$reliability_controller" == true ]]; then
  mark_row database_reliability_externalsecrets skipped "reliability workload is absent from the exact source tree"
fi

edge_reconcile_snippet=""
if [[ "$DEPLOYMENT_PROVIDER" == "k3s" ]]; then
  CURRENT_ROW="caddyfile"
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

  caddy_tmp="$(mktemp)"
  COGNI_CATALOG_ROOT="$COGNI_CATALOG_ROOT" bash "$REPO_ROOT/scripts/ci/render-caddyfile.sh" --domain "$DOMAIN" > "$caddy_tmp"
  caddy_route_ok=true
  grep -Fq "${node_host} {" "$caddy_tmp" || caddy_route_ok=false
  grep -Fq "reverse_proxy host.docker.internal:${node_port}" "$caddy_tmp" || caddy_route_ok=false
  if ! "$caddy_route_ok"; then
    fail "rendered Caddyfile missing route for ${node_host} (edge_key=${edge_key})"
  fi
  stage_exact "$caddy_tmp" caddyfile
  caddyfile_stage="$STAGED_EXACT_PATH"
  mark_row caddyfile updated "rendered + staged Caddyfile route for ${node_host}"

  # Shared VM-side edge-Caddy reconcile helper (same logic deploy-infra runs):
  # start-if-down + hash-gated atomic reload. Staged here, invoked below.
  stage_exact "$REPO_ROOT/scripts/ci/reconcile-edge-caddy.remote.sh" edge-caddy-helper
  edge_caddy_helper_stage="$STAGED_EXACT_PATH"
  stage_exact "$REPO_ROOT/infra/compose/edge/docker-compose.yml" edge-compose
  edge_compose_stage="$STAGED_EXACT_PATH"
  edge_compose_sha256="$STAGED_EXACT_SHA256"
  edge_reconcile_snippet="
  edge_env=/opt/cogni-template-edge/.env
  caddyfile=/opt/cogni-template-edge/configs/Caddyfile.tmpl
  mkdir -p /opt/cogni-template-edge/configs
 install_exact '${caddyfile_stage}' \"\$caddyfile\" '$(shasum -a 256 "$caddy_tmp" | awk '{print $1}')' 0444 caddyfile
 install_exact '${edge_compose_stage}' /opt/cogni-template-edge/docker-compose.yml '${edge_compose_sha256}' 0444 edge-compose
  edge_config_json=\$(docker compose --project-name cogni-edge --env-file \"\$edge_env\" -f /opt/cogni-template-edge/docker-compose.yml config --format json)
  printf '%s' \"\$edge_config_json\" | jq -e '
    any(.services.caddy.volumes[];
      .source == \"/opt/cogni-template-edge/configs/Caddyfile.tmpl\" and
      .target == \"/etc/caddy/Caddyfile\" and .read_only == true)
  ' >/dev/null || {
    echo '::error::exact edge compose mount provenance check failed' >&2
    exit 1
  }

  touch \"\$edge_env\"
  if grep -qE '^DOMAIN=' \"\$edge_env\"; then
    sed -i.bak 's|^DOMAIN=.*$|DOMAIN=${DOMAIN}|' \"\$edge_env\"
  else
    printf '%s=%s\\n' 'DOMAIN' '${DOMAIN}' >> \"\$edge_env\"
  fi
  if grep -qE '^${edge_key}=' \"\$edge_env\"; then
    sed -i.bak 's|^${edge_key}=.*$|${edge_key}=${edge_value}|' \"\$edge_env\"
  else
    printf '%s=%s\\n' '${edge_key}' '${edge_value}' >> \"\$edge_env\"
  fi
  rm -f \"\$edge_env.bak\"

  EDGE_COMPOSE_BIN=\"docker compose --project-name cogni-edge --env-file \$edge_env -f /opt/cogni-template-edge/docker-compose.yml\" \\
  CADDYFILE=\"\$caddyfile\" \\
  EDGE_ENV_FILE=\"\$edge_env\" \\
  HASH_DIR=/var/lib/cogni \\
    bash '${edge_caddy_helper_stage}' >/dev/null
"
else
  mark_row caddyfile skipped "external placement: Caddy/NodePort edge mutation not applicable"
fi

# Born-observable: re-push the Alloy runtime config (the nodeId→`node` Loki
# stream-label promotion, task.5028) + the shared hash-gated restart helper, so
# the node-log proxy's forced {node="<id>"} selector resolves on EVERY env. The
# promote pipeline runs deploy-infra (which already does this) only when
# skip_infra=false, so an app-only promote never re-pushed it; folding the same
# rsync + checksum-restart primitive into this always-on substrate-readiness lane
# (Axiom 22) closes that gap with no new workflow / bespoke script (bug.5041).
# Idempotent: the hash-gate makes an unchanged config a no-op, and N per-node
# invocations of one env-global config collapse to one push + restart.
stage_exact "$REPO_ROOT/infra/compose/runtime/configs/alloy-config.metrics.alloy" alloy-config
alloy_config_stage="$STAGED_EXACT_PATH"
alloy_config_sha256="$STAGED_EXACT_SHA256"
stage_exact "$REPO_ROOT/scripts/ci/reconcile-alloy-config.remote.sh" alloy-helper
alloy_helper_stage="$STAGED_EXACT_PATH"

# Compose definitions decide which host files containers execute, so stage the
# definition and every mounted executable from the same reviewed tree. Verifying
# provision.sh alone is insufficient when a stale compose file can redirect it.
stage_exact "$REPO_ROOT/infra/compose/runtime/docker-compose.yml" runtime-compose
runtime_compose_stage="$STAGED_EXACT_PATH"
runtime_compose_sha256="$STAGED_EXACT_SHA256"
stage_exact "$REPO_ROOT/infra/compose/runtime/postgres-init/provision.sh" postgres-provisioner
postgres_provisioner_stage="$STAGED_EXACT_PATH"
postgres_provisioner_sha256="$STAGED_EXACT_SHA256"
stage_exact "$REPO_ROOT/infra/compose/runtime/doltgres-init/install-creds.sh" doltgres-install-creds
doltgres_install_creds_stage="$STAGED_EXACT_PATH"
doltgres_install_creds_sha256="$STAGED_EXACT_SHA256"
stage_exact "$REPO_ROOT/infra/compose/runtime/doltgres-init/provision.sh" doltgres-provisioner
doltgres_provisioner_stage="$STAGED_EXACT_PATH"
doltgres_provisioner_sha256="$STAGED_EXACT_SHA256"

# DoltHub mirror creds → VM runtime .env + hash-gated doltgres recreate (Option B).
# Staged only when the creds are present in OpenBao; absent ⇒ mirror stays disabled.
# dolt_mirror_reconcile_snippet is spliced into the remote heredoc's doltgres block
# below (empty string when disabled → the heredoc is byte-identical to before).
dolt_mirror_reconcile_snippet=""
if "$dolt_mirror_purge"; then
  # Non-prod: strip any DoltHub mirror creds from the VM runtime .env + hash-gated
  # recreate so a prod-capable cred can never linger on a test VM (bug.5003). No
  # values transit — MODE=purge only removes keys. Byte-identical no-op when the
  # .env already lacks them.
  stage_exact "$REPO_ROOT/scripts/ci/reconcile-dolt-mirror-creds.remote.sh" dolt-mirror-helper
  dolt_mirror_helper_stage="$STAGED_EXACT_PATH"
  dolt_mirror_reconcile_snippet="    RUNTIME_ENV=\"\$runtime_env\" \\
    RUNTIME_COMPOSE_BIN=\"docker compose --project-name cogni-runtime --env-file \$runtime_env -f /opt/cogni-template-runtime/docker-compose.yml\" \\
    HASH_DIR=/var/lib/cogni \\
    MODE=purge \\
      bash '${dolt_mirror_helper_stage}'
"
elif "$dolt_mirror_enabled"; then
  stage_exact "$REPO_ROOT/scripts/ci/reconcile-dolt-mirror-creds.remote.sh" dolt-mirror-helper
  dolt_mirror_helper_stage="$STAGED_EXACT_PATH"
  # base64 the values CI-side so the single-line-JSON JWK never touches a sed/shell
  # interpolation path (no injection; never echoed). Decoded VM-side by the helper.
  dolt_creds_jwk_b64="$(printf '%s' "$dolt_creds_jwk" | base64 | tr -d '\n')"
  dolt_creds_keyid_b64="$(printf '%s' "$dolt_creds_keyid" | base64 | tr -d '\n')"
  dolthub_owner_b64="$(printf '%s' "$dolthub_owner" | base64 | tr -d '\n')"
  dolthub_api_token_b64="$(printf '%s' "$dolthub_api_token" | base64 | tr -d '\n')"
  # Runs after doltgres is up: render the creds into the runtime .env then hash-gated
  # force-recreate so install-creds.sh re-runs. base64 values transit the SSH command
  # (VM-local, not echoed to CI logs). Leading newline keeps the heredoc line-clean.
  dolt_mirror_reconcile_snippet="    RUNTIME_ENV=\"\$runtime_env\" \\
    RUNTIME_COMPOSE_BIN=\"docker compose --project-name cogni-runtime --env-file \$runtime_env -f /opt/cogni-template-runtime/docker-compose.yml\" \\
    HASH_DIR=/var/lib/cogni \\
    DOLT_CREDS_JWK_B64='${dolt_creds_jwk_b64}' \\
    DOLT_CREDS_KEYID_B64='${dolt_creds_keyid_b64}' \\
    DOLTHUB_OWNER_B64='${dolthub_owner_b64}' \\
    DOLTHUB_API_TOKEN_B64='${dolthub_api_token_b64}' \\
      bash '${dolt_mirror_helper_stage}'
"
fi

# THE LANE'S TEMPORAL NAMESPACE MUST EXIST ON THE SERVER THE LANE DIALS (task.5132).
# The composite sets TEMPORAL_ADDRESS to the CONTROL env's VM (the substrate is the paying
# cluster's) and TEMPORAL_NAMESPACE to `cogni-<lane>` — correctly, since one server must hold
# both lanes without collision, exactly like `cogni_<node>_<lane>` for Postgres.
#
# But NOTHING registers it. Registration lives only in deploy-infra.sh step 6.7, and an app
# promote sets skip_infra=true, so a foreign-custodied lane reaches a Temporal server that has
# never heard of its namespace. The app's first call gets NamespaceNotFound, /readyz never
# passes, and bootPolicy closes the lease after bootDeadlineSeconds — a paid lease spent on a
# namespace nobody created.
#
# The same idempotent primitive deploy-infra and provision-test-vm already share; a re-run is
# a no-op. This is the Temporal half of "provision the lane's substrate on the control
# cluster", which #2319 did for Postgres and Doltgres.
CURRENT_ROW="temporal_namespace"
stage_exact "$REPO_ROOT/scripts/ci/ensure-temporal-namespace.sh" temporal-namespace-helper
temporal_namespace_helper_stage="$STAGED_EXACT_PATH"
remote "TEMPORAL_NAMESPACE='cogni-${DEPLOY_ENVIRONMENT}' \
  TEMPORAL_CONTAINER=cogni-runtime-temporal-1 \
  TEMPORAL_TIMEOUT=60 \
  bash '${temporal_namespace_helper_stage}'" \
  || fail "temporal namespace ensure failed (rc=$?) for cogni-${DEPLOY_ENVIRONMENT} on ${SUBSTRATE_CONTROL_ENV}'s Temporal"
mark_row temporal_namespace ensured "cogni-${DEPLOY_ENVIRONMENT} registered on ${SUBSTRATE_CONTROL_ENV}'s Temporal (idempotent)"

# NODE-SOVEREIGN WORKFLOW NAMESPACE. Provision it from the catalog lifecycle even before a node
# opts into the private Worker profile, so enabling `cogni-workflow-worker-v1` is a pure app
# release and never races a paid workload boot against namespace registration. The UUID comes
# from node_id_for_target (repo-spec SSOT with the drift-gated catalog projection fallback), not
# from the human slug. Existing centralized schedules remain in cogni-<lane>; creating this
# namespace alone moves no traffic and starts no Worker.
CURRENT_ROW="node_temporal_namespace"
remote "TEMPORAL_NAMESPACE='${node_temporal_namespace}' \
  TEMPORAL_CONTAINER=cogni-runtime-temporal-1 \
  TEMPORAL_TIMEOUT=60 \
  bash '${temporal_namespace_helper_stage}'" \
  || fail "node Temporal namespace ensure failed (rc=$?) for ${node_temporal_namespace} on ${SUBSTRATE_CONTROL_ENV}'s Temporal"
mark_row node_temporal_namespace ensured "${node_temporal_namespace} registered on ${SUBSTRATE_CONTROL_ENV}'s Temporal (idempotent)"

CURRENT_ROW="remote_reconcile"
# Breadcrumbs ([remote] … ok) after every sub-step, stdout so they stream live:
# bug.5278's silent exit 1 was only locatable by mtime forensics on the VM. With
# these, the last printed crumb names the step the next such death died in.
remote "set -euo pipefail
  runtime_env=/opt/cogni-template-runtime/.env
  runtime_compose=(docker compose --project-name cogni-runtime --env-file \"\$runtime_env\" -f /opt/cogni-template-runtime/docker-compose.yml)
  echo '[remote] reconcile begin (${DEPLOY_ENVIRONMENT}/${TARGET_NODE})'

  install_exact() {
    local source=\"\$1\" destination=\"\$2\" expected_sha=\"\$3\" mode=\"\$4\" label=\"\$5\" staged
    staged=\"\${destination}.reconcile.\$\$\"
    mkdir -p \"\$(dirname \"\$destination\")\"
    install -o root -g root -m \"\$mode\" \"\$source\" \"\$staged\"
    [ \"\$(sha256sum \"\$staged\" | awk '{print \$1}')\" = \"\$expected_sha\" ] || {
      rm -f \"\$staged\"
      echo \"::error::installed \$label differs from exact reviewed source\" >&2
      exit 1
    }
    mv -f \"\$staged\" \"\$destination\"
    rm -f \"\$source\"
    [ \"\$(sha256sum \"\$destination\" | awk '{print \$1}')\" = \"\$expected_sha\" ] || {
      echo \"::error::published \$label differs from exact reviewed source\" >&2
      exit 1
    }
  }

  install_exact '${runtime_compose_stage}' /opt/cogni-template-runtime/docker-compose.yml '${runtime_compose_sha256}' 0444 runtime-compose
  install_exact '${postgres_provisioner_stage}' /opt/cogni-template-runtime/postgres-init/provision.sh '${postgres_provisioner_sha256}' 0444 postgres-provisioner
  install_exact '${doltgres_install_creds_stage}' /opt/cogni-template-runtime/doltgres-init/install-creds.sh '${doltgres_install_creds_sha256}' 0555 doltgres-install-creds
  install_exact '${doltgres_provisioner_stage}' /opt/cogni-template-runtime/doltgres-init/provision.sh '${doltgres_provisioner_sha256}' 0444 doltgres-provisioner
  echo '[remote] exact runtime compose and provisioners installed ok'

${edge_reconcile_snippet}

  touch \"\$runtime_env\"
  current=\$(awk -F= '/^COGNI_NODE_DBS=/ {print substr(\$0, length(\"COGNI_NODE_DBS=\") + 1)}' \"\$runtime_env\" | tail -1)
  if [[ -z \"\$current\" ]]; then
    next='${node_db}'
  elif [[ \",\$current,\" == *\",${node_db},\"* ]]; then
    next=\"\$current\"
  else
    next=\"\$current,${node_db}\"
  fi
  # ATOMIC-OR-REFUSE. This file is the SHARED runtime env every compose service reads.
  # An in-place sed or append mutates it live, so a reader in that window sees a truncated or
  # half-appended file — which is how a mid-run failure here bounced production agent auth
  # for ~5 minutes on 2026-09-17. Render to a temp, VERIFY it, then publish with mv, which is
  # atomic on one filesystem: a reader sees either the old file or the new one, never a
  # partial one. A failed render is discarded and the run fails loudly with the file intact.
  env_tmp=\"\${runtime_env}.reconcile.\$\$\"
  if grep -qE '^COGNI_NODE_DBS=' \"\$runtime_env\"; then
    sed \"s|^COGNI_NODE_DBS=.*\$|COGNI_NODE_DBS=\$next|\" \"\$runtime_env\" > \"\$env_tmp\"
  else
    { cat \"\$runtime_env\"; printf '%s=%s\n' COGNI_NODE_DBS \"\$next\"; } > \"\$env_tmp\"
  fi
  dbs_n=\$(grep -cE '^COGNI_NODE_DBS=' \"\$env_tmp\" || true)
  new_n=\$(wc -l < \"\$env_tmp\")
  old_n=\$(wc -l < \"\$runtime_env\")
  env_guard_fail() {
    rm -f \"\$env_tmp\"
    echo \"::error::reconcile-node-substrate[remote]: \$1 (dbs_n=\$dbs_n new_n=\$new_n old_n=\$old_n) — refusing to publish a malformed runtime env; original left intact\" >&2
    exit 1
  }
  [ -s \"\$env_tmp\" ] || env_guard_fail 'rendered runtime env is EMPTY'
  [ \"\$dbs_n\" = 1 ] || env_guard_fail \"rendered runtime env must hold exactly one COGNI_NODE_DBS line, found \$dbs_n\"
  [ \"\$new_n\" -ge \"\$old_n\" ] || env_guard_fail 'rendered runtime env LOST lines vs the live file'
  mv -f \"\$env_tmp\" \"\$runtime_env\"
  rm -f \"\$runtime_env.bak\"
  echo '[remote] runtime env published (COGNI_NODE_DBS reconciled) ok'

  # Alloy node-label reconcile — stage the fresh config (rsync's restart-on-change
  # half) then the SAME hash-gated restart deploy-infra runs. Born-observable on
  # the normal flow even when deploy-infra is skipped (bug.5041). Idempotent.
  mkdir -p /opt/cogni-template-runtime/configs
  install_exact '${alloy_config_stage}' /opt/cogni-template-runtime/configs/alloy-config.metrics.alloy '${alloy_config_sha256}' 0444 alloy-config
  RUNTIME_COMPOSE_BIN=\"docker compose --project-name cogni-runtime --env-file \$runtime_env -f /opt/cogni-template-runtime/docker-compose.yml\" \\
  ALLOY_CONFIG=/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy \\
  HASH_DIR=/var/lib/cogni \\
    bash '${alloy_helper_stage}' >/dev/null
  echo '[remote] alloy config reconciled ok'

  runtime_config_json=\$(\"\${runtime_compose[@]}\" config --format json)
  printf '%s' \"\$runtime_config_json\" | jq -e '
    any(.services[\"db-provision\"].volumes[];
      .source == \"/opt/cogni-template-runtime/postgres-init/provision.sh\" and
      .target == \"/app/provision.sh\" and .read_only == true) and
    any(.services.doltgres.volumes[];
      .source == \"/opt/cogni-template-runtime/doltgres-init/install-creds.sh\" and
      .target == \"/usr/local/bin/install-creds.sh\" and .read_only == true) and
    any(.services[\"doltgres-provision\"].volumes[];
      .source == \"/opt/cogni-template-runtime/doltgres-init/provision.sh\" and
      .target == \"/app/provision.sh\" and .read_only == true) and
    any(.services.alloy.volumes[];
      .source == \"/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy\" and
      .target == \"/etc/alloy/config.alloy\" and .read_only == true)
  ' >/dev/null || {
    echo '::error::exact runtime compose mount provenance check failed' >&2
    exit 1
  }
  echo '[remote] exact runtime compose mounts verified ok'

  \"\${runtime_compose[@]}\" up -d postgres >/dev/null
  echo '[remote] postgres up ok'
  # Single-node db-provision: override COGNI_NODE_DBS to THIS node and inject its
  # per-node OpenBao passwords (read above) via -e, so provision.sh reconciles the
  # per-node app/service roles to the OpenBao value. The passwords transit this SSH
  # command + the docker run env (VM-local, not echoed to CI logs); the declarative
  # endgame (vm-secrets-repair.md) removes this bash transport.
  \"\${runtime_compose[@]}\" --profile bootstrap run --rm \
    -e COGNI_NODE_DBS='${node_db}' \
    -e APP_DB_PASSWORD='${app_db_password}' \
    -e APP_DB_SERVICE_PASSWORD='${app_db_service_password}' \
    -e APP_DB_MIGRATION_PASSWORD='${app_db_migration_password}' \
    -e DATABASE_RELIABILITY_PASSWORD='${database_reliability_password}' \
    -e DATABASE_RELIABILITY_READMIT_PASSWORD='${database_reliability_readmit_password}' \
    -e DB_BUDGET_PROFILE='${budget_profile}' \
    -e DB_APP_CONNECTION_LIMIT='${db_app_connection_limit}' \
    -e DB_APP_STATEMENT_TIMEOUT_MS='${db_app_statement_timeout_ms}' \
    -e DB_SERVICE_CONNECTION_LIMIT='${db_service_connection_limit}' \
    -e DB_SERVICE_STATEMENT_TIMEOUT_MS='${db_service_statement_timeout_ms}' \
    -e DB_LOCK_TIMEOUT_MS='${db_lock_timeout_ms}' \
    -e DB_IDLE_IN_TRANSACTION_TIMEOUT_MS='${db_idle_in_transaction_timeout_ms}' \
    -e DB_TEMP_FILE_LIMIT_MIB='${db_temp_file_limit_mib}' \
    -e DB_WORK_MEM_MIB='${db_work_mem_mib}' \
    db-provision >/dev/null
  echo '[remote] db-provision ok'

  projected_migration_dsn=\$(kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' get secret '${TARGET_NODE}-migration-secrets' -o jsonpath='{.data.DATABASE_MIGRATION_URL}' | base64 --decode)
  [ \"\$(printf '%s' \"\$projected_migration_dsn\" | sha256sum | awk '{print \$1}')\" = '${migration_dsn_sha256}' ] || {
    echo '::error::OpenBao and projected migration DSN digests differ' >&2
    exit 1
  }
  docker run --rm --network host -e DATABASE_MIGRATION_URL=\"\$projected_migration_dsn\" postgres:15 sh -ceu '
    result=\$(psql \"\$DATABASE_MIGRATION_URL\" -XAtv ON_ERROR_STOP=1 -c \"
      SELECT session_user = \047${migration_role}\047
         AND current_user = \047${app_role}\047
         AND current_database() = \047${node_db}\047
         AND NOT role_state.rolsuper
         AND NOT role_state.rolcreaterole
         AND NOT role_state.rolcreatedb
         AND NOT role_state.rolreplication
         AND NOT role_state.rolbypassrls
         AND role_state.rolconnlimit = 1
         AND current_setting(\047statement_timeout\047) IN (\04715min\047, \047900s\047)
         AND current_setting(\047temp_file_limit\047) = \047${db_temp_file_limit_mib}MB\047
         AND (SELECT count(*) FROM pg_auth_members membership
                JOIN pg_roles parent ON parent.oid = membership.roleid
               WHERE membership.member = role_state.oid
                 AND parent.rolname ~ \047^(app|service|migration)_\047) = 1
         AND pg_has_role(session_user, \047${app_role}\047, \047MEMBER\047)
        FROM pg_roles role_state
       WHERE role_state.rolname = session_user\")
    [ \"\$result\" = t ]
  '
  echo '[remote] projected migration DSN digest and live identity verified ok'
  if \"\${runtime_compose[@]}\" config --services 2>/dev/null | grep -q '^doltgres$'; then
    \"\${runtime_compose[@]}\" up -d doltgres >/dev/null
    echo '[remote] doltgres up ok'
    # bug.5033: node-scope doltgres-provision with -e COGNI_NODE_DBS='${node_db}',
    # symmetric with db-provision above. Otherwise doltgres-provision relied on the
    # env-file COGNI_NODE_DBS (whole fleet) and the surrounding grep gate silently
    # skips on any compose hiccup → knowledge_<node> uncreated → node-app
    # Init:CrashLoopBackOff. Scoping to THIS node is deterministic + idempotent.
    \"\${runtime_compose[@]}\" --profile bootstrap run --rm \
      -e COGNI_NODE_DBS='${node_db}' \
      ${dg_pw_env} doltgres-provision >/dev/null
    echo '[remote] doltgres-provision ok'
${dolt_mirror_reconcile_snippet}  fi" \
  || fail "remote reconcile block failed (rc=$?) — the last '[remote] … ok' breadcrumb above names the last completed step"

migration_secret_version_after="$(bao_get_version "${TARGET_NODE}-database-migration")"
[[ "$migration_secret_version_after" == "$migration_secret_version" ]] \
  || fail "migration OpenBao version changed during ESO/DB proof — refusing a mixed-version receipt"
mark_row migration_dsn_proven ready "stable OpenBao version, projected digest, and live migration identity verified"
mark_row remote_reconcile updated "${DEPLOYMENT_PROVIDER} placement steps, DB inventory, and DB provisioners reconciled on VM"
log "substrate ready inputs reconciled for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT})"
write_summary success
