#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Render one raw stdin ring into a digest-only lane verifier and, for k3s, one raw workload scalar.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OPERATION="${1:-}"
LANE="${2:-}"
TARGET_NODE="${3:-}"
PROVIDER="${4:-}"
CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-$REPO_ROOT}/infra/catalog}"
SSH_BIN="${AUTHORIZATION_FACADE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"
fail() { echo "::error::authorization-facade projection failed: $*" >&2; exit 1; }
[[ "$OPERATION" =~ ^(materialize|prepare|activate|finish|cancel)$ ]] || fail "invalid operation"
[[ "$LANE" =~ ^(candidate-a|preview|production)$ ]] || fail "invalid lane"
[[ "$PROVIDER" =~ ^(k3s|akash)$ ]] || fail "invalid provider"
[[ "$TARGET_NODE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "invalid node"
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"
[[ "$VM_HOST" =~ ^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$ ]] || fail "invalid VM_HOST"
[[ "${AUTHORIZATION_FACADE_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
  || fail "AUTHORIZATION_FACADE_URL must be an HTTPS origin"

catalog_file="$CATALOG_ROOT/$TARGET_NODE.yaml"
[[ -f "$catalog_file" ]] || fail "unknown catalog node"
COGNI_CATALOG_ROOT="$CATALOG_ROOT"
# shellcheck source=lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"
NODE_ID="$(node_id_for_target "$TARGET_NODE")" || fail "node identity missing"
[[ "$NODE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "invalid node UUID"
credential_re="^cogni_naz_sk_v2_${LANE}_${NODE_ID}_[0-9a-f]{64}$"
RING="$(cat)"
[[ ${#RING} -le 600 ]] || fail "ring exceeds bound"
jq -e --arg re "$credential_re" 'type=="object" and (keys|sort)==["active","previous"] and (.active|test($re)) and (.previous==null or (.previous|test($re))) and (.previous==null or .previous!=.active)' >/dev/null <<<"$RING" || fail "invalid ring"
ACTIVE="$(jq -r '.active' <<<"$RING")"
PREVIOUS="$(jq -r '.previous // empty' <<<"$RING")"

case "$OPERATION" in
  materialize) VERIFY_ACTIVE="$ACTIVE"; VERIFY_PREVIOUS=""; WORKLOAD="$ACTIVE" ;;
  prepare) [[ -n "$PREVIOUS" ]] || fail "prepare ring lacks predecessor"; VERIFY_ACTIVE="$ACTIVE"; VERIFY_PREVIOUS="$PREVIOUS"; WORKLOAD="$PREVIOUS" ;;
  activate) [[ -n "$PREVIOUS" ]] || fail "activate ring lacks predecessor"; VERIFY_ACTIVE="$ACTIVE"; VERIFY_PREVIOUS="$PREVIOUS"; WORKLOAD="$ACTIVE" ;;
  finish) [[ -n "$PREVIOUS" ]] || fail "finish ring lacks predecessor"; VERIFY_ACTIVE="$ACTIVE"; VERIFY_PREVIOUS=""; WORKLOAD="$ACTIVE" ;;
  cancel) [[ -n "$PREVIOUS" ]] || fail "cancel ring lacks predecessor"; VERIFY_ACTIVE="$PREVIOUS"; VERIFY_PREVIOUS=""; WORKLOAD="$PREVIOUS" ;;
esac
ACTIVE_DIGEST="$(printf '%s' "$VERIFY_ACTIVE" | sha256sum | awk '{print $1}')"
if [[ -n "$VERIFY_PREVIOUS" ]]; then PREVIOUS_DIGEST="$(printf '%s' "$VERIFY_PREVIOUS" | sha256sum | awk '{print $1}')"; else PREVIOUS_DIGEST=null; fi
VERIFY_RING="$(jq -cn --arg active "$ACTIVE_DIGEST" --arg previous "$PREVIOUS_DIGEST" '{activeSha256:$active,previousSha256:(if $previous=="null" then null else $previous end)}')"
MAP_KEY="${LANE}/${NODE_ID}"

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
SSH_OPTS_ARR+=(-o ControlMaster=auto -o "ControlPath=${TMPDIR:-/tmp}/cogni-authz-project-%r@%h-%p" -o ControlPersist=180)
# shellcheck source=lib/ssh-retry.sh
. "$SCRIPT_DIR/lib/ssh-retry.sh"
remote() { cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"; }
BAO_TOKEN="$(cogni_openbao_kubernetes_login_retry remote "set -euo pipefail
  jwt=\$(kubectl create token openbao-operator -n default)
  kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \\
    bao write -field=token auth/kubernetes/login role='${LANE}-writer' jwt=\"\$jwt\"")"
[[ -n "$BAO_TOKEN" ]] || fail "lane writer login failed"
bao_exec() {
  local mode="$1" command="$2"
  if [[ "$mode" == payload ]]; then
    { printf '%s\n' "$BAO_TOKEN"; cat; } | remote "kubectl exec -i -n openbao openbao-0 -- sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; export BAO_ADDR=http://127.0.0.1:8200; exec bao ${command}'"
  else
    printf '%s\n' "$BAO_TOKEN" | remote "kubectl exec -i -n openbao openbao-0 -- sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; export BAO_ADDR=http://127.0.0.1:8200; exec bao ${command}'"
  fi
}
read_path() {
  local raw rc
  set +e; raw="$(bao_exec token "kv get -format=json '$1'" 2>&1)"; rc=$?; set -e
  if [[ $rc -ne 0 ]]; then [[ "$raw" == *"No value found"* ]] || fail "lane KV read failed"; PATH_EXISTS=false; PATH_VERSION=0; PATH_DATA='{}'; return; fi
  PATH_EXISTS=true; PATH_VERSION="$(jq -er '.data.metadata.version|numbers' <<<"$raw")" || fail "lane KV version missing"; PATH_DATA="$(jq -ce '.data.data|objects' <<<"$raw")" || fail "lane KV invalid"
}
write_field() {
  local path="$1" key="$2" value="$3" attempt payload current rc
  for attempt in 1 2 3 4 5; do
    read_path "$path"; current="$(jq -r --arg key "$key" '.[$key] // empty' <<<"$PATH_DATA")"; [[ "$current" == "$value" ]] && return
    payload="$(printf '%s' "$value" | jq -Rsc --arg key "$key" '{($key):.}')"
    set +e
    if [[ "$PATH_EXISTS" == true ]]; then printf '%s' "$payload" | bao_exec payload "kv patch -cas=${PATH_VERSION} '$path' -" >/dev/null 2>&1; else printf '%s' "$payload" | bao_exec payload "kv put -cas=0 '$path' -" >/dev/null 2>&1; fi
    rc=$?; set -e; [[ $rc -eq 0 ]] && return
  done
  fail "lane KV CAS did not converge"
}

OPERATOR_PATH="cogni/${LANE}/operator"
MAP_FIELD=AUTHORIZATION_FACADE_VERIFIER_RINGS_JSON
for attempt in 1 2 3 4 5; do
  read_path "$OPERATOR_PATH"
  MAP="$(jq -r --arg key "$MAP_FIELD" '.[$key] // "{}"' <<<"$PATH_DATA")"
  jq -e 'type=="object" and all(to_entries[]; (.key|test("^(candidate-a|preview|production)/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and (.value|type=="object" and (keys|sort)==["activeSha256","previousSha256"] and (.activeSha256|test("^[0-9a-f]{64}$")) and (.previousSha256==null or (.previousSha256|test("^[0-9a-f]{64}$")))))' >/dev/null <<<"$MAP" || fail "existing verifier map invalid"
  DESIRED_MAP="$({ printf '%s\0' "$MAP"; printf '%s' "$VERIFY_RING"; } | jq -Rsc --arg key "$MAP_KEY" 'split("\u0000") as $p|($p[0]|fromjson)|.[$key]=($p[1]|fromjson)')"
  [[ "$MAP" == "$DESIRED_MAP" ]] && break
  payload="$(printf '%s' "$DESIRED_MAP" | jq -Rsc --arg key "$MAP_FIELD" '{($key):.}')"
  set +e
  if [[ "$PATH_EXISTS" == true ]]; then printf '%s' "$payload" | bao_exec payload "kv patch -cas=${PATH_VERSION} '$OPERATOR_PATH' -" >/dev/null 2>&1; else printf '%s' "$payload" | bao_exec payload "kv put -cas=0 '$OPERATOR_PATH' -" >/dev/null 2>&1; fi
  rc=$?; set -e; [[ $rc -eq 0 ]] && break
  [[ $attempt -lt 5 ]] || fail "verifier-map CAS did not converge"
done

if [[ "$PROVIDER" == k3s ]]; then
  TARGET_PATH="cogni/${LANE}/${TARGET_NODE}"
  read_path "$TARGET_PATH"
  current="$(jq -r '.AUTHORIZATION_FACADE_TOKEN // empty' <<<"$PATH_DATA")"
  if [[ "$OPERATION" == cancel && "$current" != "$PREVIOUS" ]]; then fail "cancel refused after activation"; fi
  if [[ "$OPERATION" == finish && "$current" != "$ACTIVE" ]]; then fail "finish refused before activation"; fi
  write_field "$TARGET_PATH" AUTHORIZATION_FACADE_TOKEN "$WORKLOAD"
fi

remote "set -euo pipefail
  ns='cogni-${LANE}'
  for es in operator-env-secrets ${TARGET_NODE}-env-secrets; do
    if kubectl -n \"\$ns\" get externalsecret \"\$es\" >/dev/null 2>&1; then
      kubectl -n \"\$ns\" annotate externalsecret \"\$es\" force-sync=\"\$(date +%s)\" --overwrite >/dev/null
      kubectl -n \"\$ns\" wait --for=condition=Ready \"externalsecret/\$es\" --timeout=120s >/dev/null
    fi
  done
  if kubectl -n \"\$ns\" get deployment operator-node-app >/dev/null 2>&1; then kubectl -n \"\$ns\" rollout status deployment/operator-node-app --timeout=180s >/dev/null; fi
  if [[ '${PROVIDER}' == k3s ]] && kubectl -n \"\$ns\" get deployment '${TARGET_NODE}-node-app' >/dev/null 2>&1; then kubectl -n \"\$ns\" rollout status 'deployment/${TARGET_NODE}-node-app' --timeout=180s >/dev/null; fi"

probe() {
  local candidate="$1"
  { printf 'header = "Authorization: Bearer %s"\n' "$candidate"; } | curl --silent --show-error --output /dev/null --write-out '%{http_code}' --config - --request POST "${AUTHORIZATION_FACADE_URL:?}/api/internal/authorization-facade-credential-probe"
}
if [[ "$OPERATION" == finish ]]; then
  [[ "$(probe "$ACTIVE")" == 204 ]] || fail "active credential proof failed"
  [[ "$(probe "$PREVIOUS")" == 401 ]] || fail "predecessor rejection proof failed"
fi
echo "[authorization-facade-project] ${OPERATION} converged for ${LANE}/${TARGET_NODE}; values redacted"
