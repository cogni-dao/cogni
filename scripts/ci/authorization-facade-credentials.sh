#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Fleet-control authority and foreign-custodied workload view for authorization-facade credentials.
# Raw values remain in OpenBao/stdin/process memory and never enter argv, logs, outputs, or artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PHASE="${1:-}"
OPERATION="${2:-}"
LANE="${3:-}"
TARGET_NODE="${4:-}"
PROVIDER="${5:-}"
CONTROL_ENV="${FLEET_CONTROL_ENV:-production}"
CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-$REPO_ROOT}/infra/catalog}"
SSH_BIN="${AUTHORIZATION_FACADE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

fail() { echo "::error::authorization-facade-credentials: $*" >&2; exit 1; }
log() { printf '[authorization-facade-credentials] %s\n' "$*"; }
[[ "$PHASE" =~ ^(authority|custody|finalize)$ ]] || fail "invalid phase"
[[ "$OPERATION" =~ ^(materialize|prepare|activate|finish|cancel)$ ]] || fail "invalid operation"
[[ "$LANE" =~ ^(candidate-a|preview|production)$ ]] || fail "invalid lane"
[[ "$CONTROL_ENV" =~ ^(candidate-a|preview|production)$ ]] || fail "invalid control env"
[[ "$PROVIDER" =~ ^(k3s|akash)$ ]] || fail "invalid provider"
[[ "$TARGET_NODE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "invalid node slug"
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"
[[ "$VM_HOST" =~ ^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$ ]] || fail "invalid VM_HOST"

catalog_file="$CATALOG_ROOT/$TARGET_NODE.yaml"
[[ -f "$catalog_file" ]] || fail "unknown catalog node"
COGNI_CATALOG_ROOT="$CATALOG_ROOT"
# shellcheck source=lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"
NODE_ID="$(node_id_for_target "$TARGET_NODE")" || fail "node identity missing"
[[ "$NODE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "invalid node UUID"

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
SSH_OPTS_ARR+=(-o ControlMaster=auto -o "ControlPath=${TMPDIR:-/tmp}/cogni-authz-%r@%h-%p" -o ControlPersist=180)
# shellcheck source=lib/ssh-retry.sh
. "$SCRIPT_DIR/lib/ssh-retry.sh"
remote() { cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"; }

BAO_TOKEN="$(cogni_openbao_kubernetes_login_retry remote "set -euo pipefail
  jwt=\$(kubectl create token openbao-operator -n default)
  kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \\
    bao write -field=token auth/kubernetes/login role='${CONTROL_ENV}-writer' jwt=\"\$jwt\"")"
[[ -n "$BAO_TOKEN" ]] || fail "control writer login failed"

bao_exec() {
  local mode="$1" command="$2"
  if [[ "$mode" == payload ]]; then
    { printf '%s\n' "$BAO_TOKEN"; cat; } | remote \
      "kubectl exec -i -n openbao openbao-0 -- sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; export BAO_ADDR=http://127.0.0.1:8200; exec bao ${command}'"
  else
    printf '%s\n' "$BAO_TOKEN" | remote \
      "kubectl exec -i -n openbao openbao-0 -- sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; export BAO_ADDR=http://127.0.0.1:8200; exec bao ${command}'"
  fi
}

read_path() {
  local raw rc
  set +e; raw="$(bao_exec token "kv get -format=json '$1'" 2>&1)"; rc=$?; set -e
  if [[ $rc -ne 0 ]]; then
    [[ "$raw" == *"No value found"* ]] || fail "OpenBao read failed (values redacted)"
    PATH_EXISTS=false; PATH_VERSION=0; PATH_DATA='{}'; return
  fi
  PATH_EXISTS=true
  PATH_VERSION="$(jq -er '.data.metadata.version|numbers' <<<"$raw")" || fail "KV version missing"
  PATH_DATA="$(jq -ce '.data.data|objects' <<<"$raw")" || fail "KV data invalid"
}

write_field_cas() {
  local path="$1" key="$2" value="$3" exists="$4" version="$5" payload rc out
  payload="$(printf '%s' "$value" | jq -Rsc --arg key "$key" '{($key):.}')"
  set +e
  if [[ "$exists" == true ]]; then
    out="$(printf '%s' "$payload" | bao_exec payload "kv patch -cas=${version} '$path' -" 2>&1)"; rc=$?
  else
    out="$(printf '%s' "$payload" | bao_exec payload "kv put -cas=0 '$path' -" 2>&1)"; rc=$?
  fi
  set -e
  [[ $rc -eq 0 ]] && return 0
  [[ "$out" == *"check-and-set"* || "$out" == *"did not match"* || "$out" == *"Code: 400"* ]] && return 75
  fail "OpenBao CAS write failed (values redacted)"
}

credential_re="^cogni_naz_sk_v2_${LANE}_${NODE_ID}_[0-9a-f]{64}$"
valid_ring() {
  jq -e --arg re "$credential_re" '
    type=="object" and (keys|sort)==["active","previous"] and
    (.active|type=="string" and test($re)) and
    (.previous==null or (.previous|type=="string" and test($re))) and
    (.previous==null or .previous!=.active)
  ' >/dev/null 2>&1 <<<"$1"
}

AUTHORITY_PATH="cogni/${LANE}/authorization-facade"
RING_KEY="$NODE_ID"
TARGET_PATH="cogni/${LANE}/${TARGET_NODE}"
TARGET_KEY=AUTHORIZATION_FACADE_TOKEN

load_ring() {
  read_path "$AUTHORITY_PATH"
  RING="$(jq -r --arg key "$RING_KEY" '.[$key] // empty' <<<"$PATH_DATA")"
  [[ -n "$RING" ]] || return 1
  valid_ring "$RING" || fail "authority ring invalid"
  ACTIVE="$(jq -r '.active' <<<"$RING")"
  PREVIOUS="$(jq -r '.previous // empty' <<<"$RING")"
}

store_ring() {
  local desired="$1" attempt
  valid_ring "$desired" || fail "refusing invalid authority ring"
  for attempt in 1 2 3 4 5; do
    read_path "$AUTHORITY_PATH"
    if write_field_cas "$AUTHORITY_PATH" "$RING_KEY" "$desired" "$PATH_EXISTS" "$PATH_VERSION"; then
      RING="$desired"; ACTIVE="$(jq -r '.active' <<<"$desired")"; PREVIOUS="$(jq -r '.previous // empty' <<<"$desired")"; return
    fi
  done
  fail "concurrent authority CAS writes did not converge"
}

mint() { printf 'cogni_naz_sk_v2_%s_%s_%s' "$LANE" "$NODE_ID" "$(openssl rand -hex 32)"; }

load_target_scalar() {
  read_path "$TARGET_PATH"
  TARGET_SCALAR="$(jq -r --arg key "$TARGET_KEY" '.[$key] // empty' <<<"$PATH_DATA")"
}

store_target_scalar() {
  local desired="$1" attempt
  [[ "$desired" =~ $credential_re ]] || fail "invalid desired workload credential"
  for attempt in 1 2 3 4 5; do
    read_path "$TARGET_PATH"
    [[ "$(jq -r --arg key "$TARGET_KEY" '.[$key] // empty' <<<"$PATH_DATA")" == "$desired" ]] && return
    write_field_cas "$TARGET_PATH" "$TARGET_KEY" "$desired" "$PATH_EXISTS" "$PATH_VERSION" && return
  done
  fail "concurrent workload-view CAS writes did not converge"
}

if [[ "$PHASE" == authority ]]; then
  case "$OPERATION" in
    materialize)
      load_ring || store_ring "$(mint | jq -Rsc '{active:.,previous:null}')" ;;
    prepare)
      load_ring || fail "materialize before prepare"
      if [[ -z "$PREVIOUS" ]]; then
        next="$(mint)"
        store_ring "$({ printf '%s\0' "$next"; printf '%s' "$ACTIVE"; } | jq -Rsc 'split("\u0000")|{active:.[0],previous:.[1]}')"
      fi ;;
    activate) load_ring && [[ -n "$PREVIOUS" ]] || fail "prepare before activate" ;;
    finish)
      load_ring && [[ -n "$PREVIOUS" ]] || fail "prepare before finish"
      if [[ "$PROVIDER" == akash ]]; then load_target_scalar; [[ "$TARGET_SCALAR" == "$ACTIVE" ]] || fail "workload view is not active"; fi ;;
    cancel)
      load_ring && [[ -n "$PREVIOUS" ]] || fail "prepare before cancel"
      if [[ "$PROVIDER" == akash ]]; then load_target_scalar; [[ "$TARGET_SCALAR" == "$PREVIOUS" ]] || fail "cancel refused after activation"; fi ;;
  esac
  log "authority phase ${OPERATION} ready for ${LANE}/${TARGET_NODE}; values redacted"
  exit 0
fi

load_ring || fail "authority ring absent"
if [[ "$PHASE" == custody ]]; then
  [[ "$PROVIDER" == akash ]] || fail "control custody phase is Akash-only"
  case "$OPERATION" in
    materialize|activate|finish) desired="$ACTIVE" ;;
    prepare|cancel) [[ -n "$PREVIOUS" ]] || fail "overlap absent"; desired="$PREVIOUS" ;;
  esac
  store_target_scalar "$desired"
  remote "set -euo pipefail
    ns='cogni-${LANE}'; es='${TARGET_NODE}-compute-env-secrets'
    if kubectl -n \"\$ns\" get externalsecret \"\$es\" >/dev/null 2>&1; then
      kubectl -n \"\$ns\" annotate externalsecret \"\$es\" force-sync=\"\$(date +%s)\" --overwrite >/dev/null
      kubectl -n \"\$ns\" wait --for=condition=Ready \"externalsecret/\$es\" --timeout=120s >/dev/null
      for kind in xcomputeworkload computeworkload; do
        if kubectl -n \"\$ns\" get \"\$kind/${NODE_ID}\" >/dev/null 2>&1; then
          kubectl -n \"\$ns\" annotate \"\$kind/${NODE_ID}\" cogni.io/authz-credential-refresh=\"\$(date +%s)\" --overwrite >/dev/null
        fi
      done
    fi"
  log "control-custodied workload view ${OPERATION} converged for ${LANE}/${TARGET_NODE}; values redacted"
  exit 0
fi

case "$OPERATION" in
  finish)
    [[ -n "$PREVIOUS" ]] || { log "finish already finalized"; exit 0; }
    store_ring "$(printf '%s' "$ACTIVE" | jq -Rsc '{active:.,previous:null}')" ;;
  cancel)
    [[ -n "$PREVIOUS" ]] || { log "cancel already finalized"; exit 0; }
    store_ring "$(printf '%s' "$PREVIOUS" | jq -Rsc '{active:.,previous:null}')" ;;
  *) : ;;
esac
log "finalize phase ${OPERATION} complete for ${LANE}/${TARGET_NODE}; values redacted"
