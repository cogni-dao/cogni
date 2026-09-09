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
if [[ "$DEPLOY_ENVIRONMENT" == "production" ]]; then
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
  copy_to_remote "$external_secret_file" "/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml"
  remote "kubectl -n 'cogni-${DEPLOY_ENVIRONMENT}' apply -f '/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml' >/dev/null && rm -f '/tmp/${DEPLOY_ENVIRONMENT}-${TARGET_NODE}-external-secret.yaml'"
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

  # Shared VM-side edge-Caddy reconcile helper (same logic deploy-infra runs):
  # start-if-down + hash-gated force-recreate. Staged here, invoked below.
  copy_to_remote "$REPO_ROOT/scripts/ci/reconcile-edge-caddy.remote.sh" "/tmp/reconcile-edge-caddy.remote.sh"
  edge_reconcile_snippet="
  edge_env=/opt/cogni-template-edge/.env
  caddyfile=/opt/cogni-template-edge/configs/Caddyfile.tmpl
  mkdir -p /opt/cogni-template-edge/configs
  mv '/tmp/Caddyfile.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}.tmpl' \"\$caddyfile\"

  touch \"\$edge_env\"
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
    bash /tmp/reconcile-edge-caddy.remote.sh >/dev/null
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
copy_to_remote "$REPO_ROOT/infra/compose/runtime/configs/alloy-config.metrics.alloy" "/tmp/alloy-config.metrics.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}.alloy"
copy_to_remote "$REPO_ROOT/scripts/ci/reconcile-alloy-config.remote.sh" "/tmp/reconcile-alloy-config.remote.sh"

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
  copy_to_remote "$REPO_ROOT/scripts/ci/reconcile-dolt-mirror-creds.remote.sh" "/tmp/reconcile-dolt-mirror-creds.remote.sh"
  dolt_mirror_reconcile_snippet="    RUNTIME_ENV=\"\$runtime_env\" \\
    RUNTIME_COMPOSE_BIN=\"docker compose --project-name cogni-runtime --env-file \$runtime_env -f /opt/cogni-template-runtime/docker-compose.yml\" \\
    HASH_DIR=/var/lib/cogni \\
    MODE=purge \\
      bash /tmp/reconcile-dolt-mirror-creds.remote.sh
"
elif "$dolt_mirror_enabled"; then
  copy_to_remote "$REPO_ROOT/scripts/ci/reconcile-dolt-mirror-creds.remote.sh" "/tmp/reconcile-dolt-mirror-creds.remote.sh"
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
      bash /tmp/reconcile-dolt-mirror-creds.remote.sh
"
fi

CURRENT_ROW="remote_reconcile"
remote "set -euo pipefail
  runtime_env=/opt/cogni-template-runtime/.env
  runtime_compose=(docker compose --project-name cogni-runtime --env-file \"\$runtime_env\" -f /opt/cogni-template-runtime/docker-compose.yml)

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
  if grep -qE '^COGNI_NODE_DBS=' \"\$runtime_env\"; then
    sed -i.bak \"s|^COGNI_NODE_DBS=.*\$|COGNI_NODE_DBS=\$next|\" \"\$runtime_env\"
  else
    printf '%s=%s\n' COGNI_NODE_DBS \"\$next\" >> \"\$runtime_env\"
  fi
  rm -f \"\$runtime_env.bak\"

  # Alloy node-label reconcile — stage the fresh config (rsync's restart-on-change
  # half) then the SAME hash-gated restart deploy-infra runs. Born-observable on
  # the normal flow even when deploy-infra is skipped (bug.5041). Idempotent.
  mkdir -p /opt/cogni-template-runtime/configs
  mv '/tmp/alloy-config.metrics.${DEPLOY_ENVIRONMENT}.${TARGET_NODE}.alloy' /opt/cogni-template-runtime/configs/alloy-config.metrics.alloy
  RUNTIME_COMPOSE_BIN=\"docker compose --project-name cogni-runtime --env-file \$runtime_env -f /opt/cogni-template-runtime/docker-compose.yml\" \\
  ALLOY_CONFIG=/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy \\
  HASH_DIR=/var/lib/cogni \\
    bash /tmp/reconcile-alloy-config.remote.sh >/dev/null

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
    # bug.5033: node-scope doltgres-provision with -e COGNI_NODE_DBS='${node_db}',
    # symmetric with db-provision above. Otherwise doltgres-provision relied on the
    # env-file COGNI_NODE_DBS (whole fleet) and the surrounding grep gate silently
    # skips on any compose hiccup → knowledge_<node> uncreated → node-app
    # Init:CrashLoopBackOff. Scoping to THIS node is deterministic + idempotent.
    \"\${runtime_compose[@]}\" --profile bootstrap run --rm \
      -e COGNI_NODE_DBS='${node_db}' \
      ${dg_pw_env} doltgres-provision >/dev/null
${dolt_mirror_reconcile_snippet}  fi"

mark_row remote_reconcile updated "${DEPLOYMENT_PROVIDER} placement steps, DB inventory, and DB provisioners reconciled on VM"
log "substrate ready inputs reconciled for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT})"
write_summary success
