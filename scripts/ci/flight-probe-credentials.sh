#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Fleet-control OpenBao authority for `service:{node_id}/flight-prober`.
#
# The control vault owns one bounded acceptance ring per {lane,node}. The target
# receives that ring as a rendered view; the control operator receives only the
# active scalar in FLIGHT_PROBE_CREDENTIALS_JSON. Values travel only over stdin
# to OpenBao and are never printed, passed in argv, or persisted as artifacts.
#
# Rotation is deliberately staged so a caller can force-sync/redeploy and verify
# after each durable phase:
#   prepare  -> target ring accepts new(active)+old(previous); operator still sends old
#   activate -> exact operator map entry switches to new; target still accepts both
#   finish   -> previous is removed; old is revoked
# A retry resumes the persisted phase and never mints a third key.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OPERATION="${1:-}"
LANE="${2:-}"
TARGET_NODE="${3:-}"
CONTROL_ENV="${FLEET_CONTROL_ENV:-production}"
SECRETS_CONTROL_ENV="${SECRETS_CONTROL_ENV:-$CONTROL_ENV}"
CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-$REPO_ROOT}/infra/catalog}"
SSH_BIN="${FLIGHT_PROBE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

fail() { echo "::error::flight-probe-credentials: $*" >&2; exit 1; }
log() { printf '[flight-probe-credentials] %s\n' "$*"; }
usage() {
  cat >&2 <<'USAGE'
Usage: flight-probe-credentials.sh <materialize|prepare|activate|finish|revoke> <candidate-a|preview|production> <node>

Required env: VM_HOST
Control env: FLEET_CONTROL_ENV (default production)

prepare/activate/finish are intentionally separate. Between phases, force-sync
or redeploy the named consumer and verify it before advancing.
USAGE
}

[[ "$OPERATION" =~ ^(materialize|prepare|activate|finish|revoke)$ ]] || { usage; exit 2; }
[[ "$LANE" =~ ^(candidate-a|preview|production)$ ]] || fail "unsupported lane '$LANE'"
[[ "$CONTROL_ENV" =~ ^(candidate-a|preview|production)$ ]] || fail "unsupported FLEET_CONTROL_ENV '$CONTROL_ENV'"
[[ "$SECRETS_CONTROL_ENV" == "$CONTROL_ENV" ]] \
  || fail "control-vault-only: SECRETS_CONTROL_ENV '$SECRETS_CONTROL_ENV' must equal FLEET_CONTROL_ENV '$CONTROL_ENV'"
[[ -n "$TARGET_NODE" ]] || { usage; exit 2; }
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"

catalog_file="$CATALOG_ROOT/$TARGET_NODE.yaml"
[[ -f "$catalog_file" ]] || fail "unknown node '$TARGET_NODE' (missing $catalog_file)"
NODE_ID="$(yq -N '.node_id // ""' "$catalog_file")"
[[ "$NODE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "catalog node_id for '$TARGET_NODE' is not a UUID"

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
SSH_OPTS_ARR+=(-o ControlMaster=auto -o "ControlPath=${TMPDIR:-/tmp}/cogni-flight-probe-%r@%h-%p" -o ControlPersist=180)
# shellcheck source=lib/ssh-retry.sh
. "$SCRIPT_DIR/lib/ssh-retry.sh"
remote() { cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"; }

BAO_TOKEN="$(
  cogni_openbao_kubernetes_login_retry remote "set -euo pipefail
    jwt=\$(kubectl create token openbao-operator -n default)
    kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \\
      bao write -field=token auth/kubernetes/login role='${CONTROL_ENV}-writer' jwt=\"\$jwt\""
)"
[[ -n "$BAO_TOKEN" ]] || fail "could not mint ${CONTROL_ENV}-writer token"

bao_exec() {
  remote "kubectl exec ${1} -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao ${2}"
}

# Globals populated by read_path: PATH_EXISTS, PATH_VERSION, PATH_DATA.
read_path() {
  local path="$1" raw rc
  set +e
  raw="$(bao_exec "" "kv get -format=json '${path}'" 2>&1)"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    if [[ "$raw" == *"No value found"* ]]; then
      PATH_EXISTS=false; PATH_VERSION=0; PATH_DATA='{}'; return 0
    fi
    fail "OpenBao read failed for $path (values redacted)"
  fi
  PATH_EXISTS=true
  PATH_VERSION="$(jq -er '.data.metadata.version | numbers' <<<"$raw")" \
    || fail "OpenBao returned no KV version for $path"
  PATH_DATA="$(jq -ce '.data.data | objects' <<<"$raw")" \
    || fail "OpenBao returned invalid KV data for $path"
}

write_field_cas() {
  local path="$1" key="$2" value="$3" exists="$4" version="$5"
  local payload out rc
  payload="$(jq -cn --arg key "$key" --arg value "$value" '{($key):$value}')"
  set +e
  if [[ "$exists" == true ]]; then
    out="$(printf '%s' "$payload" | bao_exec "-i" "kv patch -cas=${version} '${path}' -" 2>&1)"
  else
    out="$(printf '%s' "$payload" | bao_exec "-i" "kv put -cas=0 '${path}' -" 2>&1)"
  fi
  rc=$?
  set -e
  [[ $rc -eq 0 ]] && return 0
  [[ "$out" == *"check-and-set"* || "$out" == *"did not match"* || "$out" == *"Code: 400"* ]] && return 75
  fail "OpenBao CAS write failed for $path/$key (values redacted)"
}

valid_ring() {
  jq -e '
    type == "object" and
    (keys | sort) == ["active", "previous"] and
    (.active | type == "string" and length >= 32) and
    (.previous == null or (.previous | type == "string" and length >= 32)) and
    (.previous == null or .previous != .active)
  ' >/dev/null 2>&1 <<<"$1"
}

valid_map() {
  jq -e '
    type == "object" and
    all(to_entries[];
      (.key | test("^(candidate-a|preview|production)/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
      (.value | type == "string" and length >= 32)
    )
  ' >/dev/null 2>&1 <<<"$1"
}

TARGET_PATH="cogni/${LANE}/${TARGET_NODE}"
OPERATOR_PATH="cogni/${CONTROL_ENV}/operator"
MAP_KEY="${LANE}/${NODE_ID}"
RING_KEY=FLIGHT_PROBE_API_KEY
MAP_FIELD=FLIGHT_PROBE_CREDENTIALS_JSON

load_ring() {
  read_path "$TARGET_PATH"
  RING="$(jq -r --arg key "$RING_KEY" '.[$key] // empty' <<<"$PATH_DATA")"
  [[ -z "$RING" ]] && return 1
  valid_ring "$RING" || fail "invalid bounded ring at $TARGET_PATH/$RING_KEY"
  ACTIVE="$(jq -r '.active' <<<"$RING")"
  PREVIOUS="$(jq -r '.previous // empty' <<<"$RING")"
  return 0
}

store_ring() {
  local desired="$1" attempt
  valid_ring "$desired" || fail "refusing to store invalid ring"
  for attempt in 1 2 3 4 5; do
    read_path "$TARGET_PATH"
    if write_field_cas "$TARGET_PATH" "$RING_KEY" "$desired" "$PATH_EXISTS" "$PATH_VERSION"; then
      RING="$desired"; ACTIVE="$(jq -r '.active' <<<"$desired")"; PREVIOUS="$(jq -r '.previous // empty' <<<"$desired")"
      return 0
    fi
  done
  fail "concurrent writes prevented ring update after 5 CAS attempts"
}

load_map() {
  read_path "$OPERATOR_PATH"
  MAP="$(jq -r --arg key "$MAP_FIELD" '.[$key] // "{}"' <<<"$PATH_DATA")"
  valid_map "$MAP" || fail "invalid exact credential map at $OPERATOR_PATH/$MAP_FIELD"
  MAP_ACTIVE="$(jq -r --arg key "$MAP_KEY" '.[$key] // empty' <<<"$MAP")"
}

store_map_entry() {
  local action="$1" active="${2:-}" attempt desired
  for attempt in 1 2 3 4 5; do
    read_path "$OPERATOR_PATH"
    MAP="$(jq -r --arg key "$MAP_FIELD" '.[$key] // "{}"' <<<"$PATH_DATA")"
    valid_map "$MAP" || fail "invalid exact credential map at $OPERATOR_PATH/$MAP_FIELD"
    if [[ "$action" == set ]]; then
      desired="$(jq -ce --arg key "$MAP_KEY" --arg active "$active" '.[$key]=$active' <<<"$MAP")"
    else
      desired="$(jq -ce --arg key "$MAP_KEY" 'del(.[$key])' <<<"$MAP")"
    fi
    [[ "$desired" == "$MAP" ]] && return 0
    if write_field_cas "$OPERATOR_PATH" "$MAP_FIELD" "$desired" "$PATH_EXISTS" "$PATH_VERSION"; then
      return 0
    fi
  done
  fail "concurrent writes prevented exact map update after 5 CAS attempts"
}

mint_ring() {
  local secret
  secret="$(openssl rand -base64 32)"
  jq -cn --arg active "$secret" '{active:$active,previous:null}'
}

case "$OPERATION" in
  materialize)
    if ! load_ring; then
      store_ring "$(mint_ring)"
      log "created control-authoritative ring for ${LANE}/${TARGET_NODE}"
    fi
    store_map_entry set "$ACTIVE"
    log "materialized exact map entry ${MAP_KEY} in control env ${CONTROL_ENV}"
    ;;
  prepare)
    load_ring || fail "cannot rotate absent ring; run materialize first"
    load_map
    if [[ -n "$PREVIOUS" ]]; then
      log "rotation already prepared for ${MAP_KEY}; no third key minted"
      exit 0
    fi
    [[ "$MAP_ACTIVE" == "$ACTIVE" ]] || fail "operator map does not point at current active key; refusing to prepare"
    old="$ACTIVE"; next="$(openssl rand -base64 32)"
    store_ring "$(jq -cn --arg active "$next" --arg previous "$old" '{active:$active,previous:$previous}')"
    log "prepared rotation for ${MAP_KEY}; sync/redeploy target and verify both keys before activate"
    ;;
  activate)
    load_ring || fail "cannot activate absent ring"
    [[ -n "$PREVIOUS" ]] || fail "rotation is not prepared"
    load_map
    [[ "$MAP_ACTIVE" == "$PREVIOUS" || "$MAP_ACTIVE" == "$ACTIVE" ]] \
      || fail "operator map points at neither bounded ring key"
    store_map_entry set "$ACTIVE"
    log "activated new key for ${MAP_KEY}; sync/restart control operator and verify before finish"
    ;;
  finish)
    load_ring || fail "cannot finish absent ring"
    [[ -n "$PREVIOUS" ]] || { log "rotation already finished for ${MAP_KEY}"; exit 0; }
    load_map
    [[ "$MAP_ACTIVE" == "$ACTIVE" ]] || fail "operator map has not activated the new key"
    store_ring "$(jq -cn --arg active "$ACTIVE" '{active:$active,previous:null}')"
    log "removed predecessor for ${MAP_KEY}; sync/redeploy target and prove old-key rejection"
    ;;
  revoke)
    load_ring || { store_map_entry remove; log "credential already absent for ${MAP_KEY}"; exit 0; }
    load_map
    if [[ -n "$MAP_ACTIVE" ]]; then
      # Re-key target first: any crash is fail-closed because the still-present map
      # can only send a credential the target no longer accepts. A retry observes
      # the mismatch and removes the map without minting again.
      if [[ "$MAP_ACTIVE" == "$ACTIVE" || "$MAP_ACTIVE" == "$PREVIOUS" ]]; then
        store_ring "$(mint_ring)"
      fi
      store_map_entry remove
    fi
    log "revoked ${MAP_KEY}; sync/redeploy both consumers and prove prior-key rejection"
    ;;
esac
