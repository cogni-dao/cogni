#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Materialize one control-authoritative ring into a k3s target vault. The ring
# arrives on stdin from fetch-flight-probe-ring.mjs and never enters argv, a
# workflow output, an artifact, or logs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LANE="${1:-}"
TARGET_NODE="${2:-}"
OPERATION="${3:-materialize}"
CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-$REPO_ROOT}/infra/catalog}"
SSH_BIN="${FLIGHT_PROBE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

fail() { echo "::error::flight-probe projection failed: $*" >&2; exit 1; }
valid_host() {
  local host="$1" label
  [[ -n "$host" && ${#host} -le 253 ]] || return 1
  [[ "$host" != .* && "$host" != *. && "$host" != *..* ]] || return 1
  IFS='.' read -r -a host_labels <<< "$host"
  [[ ${#host_labels[@]} -gt 0 ]] || return 1
  for label in "${host_labels[@]}"; do
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] \
      || return 1
  done
}
[[ "$LANE" =~ ^(candidate-a|preview|production)$ ]] || fail "invalid lane"
[[ "$OPERATION" =~ ^(materialize|prepare|activate|finish|revoke)$ ]] || fail "invalid operation"
[[ "$TARGET_NODE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "invalid node slug"
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"
valid_host "$VM_HOST" || fail "invalid VM_HOST"

catalog_file="$CATALOG_ROOT/$TARGET_NODE.yaml"
[[ -f "$catalog_file" ]] || fail "unknown catalog node"
COGNI_CATALOG_ROOT="$CATALOG_ROOT"
# shellcheck source=lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"
NODE_ID="$(node_id_for_target "$TARGET_NODE")" \
  || fail "node identity is missing"
[[ "$NODE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "node_id is invalid"
provider="$(LANE="$LANE" yq -N '.deployment_provider[strenv(LANE)] // "k3s"' "$catalog_file")"
[[ "$provider" == k3s ]] || fail "projection target is not k3s"

valid_ring() {
  jq -e '
    type == "object" and
    (keys | sort) == ["active", "previous"] and
    (.active | type == "string" and length >= 32 and length <= 256) and
    (.previous == null or
      (.previous | type == "string" and length >= 32 and length <= 256)) and
    (.previous == null or .previous != .active)
  ' >/dev/null 2>&1 <<<"$1"
}

RING="$(cat)"
[[ ${#RING} -le 600 ]] || fail "ring exceeds bound"
valid_ring "$RING" || fail "invalid bounded ring"

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
SSH_OPTS_ARR+=(-o ControlMaster=auto -o "ControlPath=${TMPDIR:-/tmp}/cogni-flight-project-%r@%h-%p" -o ControlPersist=180)
# shellcheck source=lib/ssh-retry.sh
. "$SCRIPT_DIR/lib/ssh-retry.sh"
remote() { cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"; }

BAO_TOKEN="$(cogni_openbao_kubernetes_login_retry remote "set -euo pipefail
  jwt=\$(kubectl create token openbao-operator -n default)
  kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \\
    bao write -field=token auth/kubernetes/login role='${LANE}-writer' jwt=\"\$jwt\"")"
[[ -n "$BAO_TOKEN" ]] || fail "target writer login failed"

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

path="cogni/${LANE}/${TARGET_NODE}"
set +e
raw="$(bao_exec token-only "kv get -format=json '${path}'" 2>&1)"
read_rc=$?
set -e
exists=false; version=0; data='{}'
if [[ $read_rc -eq 0 ]]; then
  exists=true
  version="$(jq -er '.data.metadata.version|numbers' <<<"$raw")" || fail "target KV version missing"
  data="$(jq -ce '.data.data|objects' <<<"$raw")" || fail "target KV data invalid"
elif [[ "$raw" != *"No value found"* ]]; then
  fail "target KV read failed"
fi
old_ring="$(jq -r '.FLIGHT_PROBE_API_KEY // empty' <<<"$data")"
if [[ -n "$old_ring" && "$old_ring" != "$RING" ]]; then
  valid_ring "$old_ring" || fail "existing target ring invalid"
fi

# A retry may arrive after the CAS write but before the HTTP revocation proof.
# Recover the prior bearer from bounded KV-v2 history instead of minting state or
# declaring success without evidence. Values stay in memory/stdin and are never
# logged; at most five immediately preceding versions are inspected.
if [[ ( "$OPERATION" == finish || "$OPERATION" == revoke ) && "$old_ring" == "$RING" && "$version" -gt 1 ]]; then
  min_version=$((version > 5 ? version - 5 : 1))
  for ((candidate_version=version-1; candidate_version>=min_version; candidate_version--)); do
    set +e
    prior_raw="$(bao_exec token-only "kv get -version=${candidate_version} -format=json '${path}'" 2>&1)"
    prior_rc=$?
    set -e
    [[ $prior_rc -eq 0 ]] || continue
    candidate_ring="$(jq -r '.data.data.FLIGHT_PROBE_API_KEY // empty' <<<"$prior_raw")"
    if [[ -n "$candidate_ring" && "$candidate_ring" != "$RING" ]]; then
      valid_ring "$candidate_ring" || continue
      old_ring="$candidate_ring"
      break
    fi
  done
fi

if [[ "$old_ring" != "$RING" ]]; then
  payload="$(printf '%s' "$RING" | jq -Rsc '{FLIGHT_PROBE_API_KEY:.}')"
  if [[ "$exists" == true ]]; then verb=patch; else verb=put; fi
  printf '%s' "$payload" | bao_exec payload "kv ${verb} -cas=${version} '${path}' -" >/dev/null \
    || fail "target KV CAS write failed"
fi

# ESO/reloader is best-effort absent on first provisioning, mandatory once the
# ExternalSecret exists. Secret values never cross this remote command.
remote "set -euo pipefail
  ns='cogni-${LANE}'; es='${TARGET_NODE}-env-secrets'
  if kubectl -n \"\$ns\" get externalsecret \"\$es\" >/dev/null 2>&1; then
    kubectl -n \"\$ns\" annotate externalsecret \"\$es\" force-sync=\"\$(date +%s)\" --overwrite >/dev/null
    kubectl -n \"\$ns\" wait --for=condition=Ready \"externalsecret/\$es\" --timeout=120s >/dev/null
    kubectl -n \"\$ns\" rollout status 'deployment/${TARGET_NODE}-node-app' --timeout=180s >/dev/null
  fi"

if [[ "$OPERATION" == finish || "$OPERATION" == revoke ]]; then
  [[ -n "$old_ring" ]] || fail "revocation proof pending: prior target ring unavailable"
  active="$(jq -r '.active' <<<"$RING")"
  if [[ "$OPERATION" == finish ]]; then prior="$(jq -r '.previous // empty' <<<"$old_ring")"; else prior="$(jq -r '.active' <<<"$old_ring")"; fi
  [[ -n "$prior" && "$prior" != "$active" ]] || fail "revocation proof pending: prior key unavailable"
  # shellcheck source=lib/image-tags.sh
  CATALOG_DIR="$CATALOG_ROOT" . "$SCRIPT_DIR/lib/image-tags.sh"
  [[ -n "${DOMAIN:-}" ]] || fail "DOMAIN is required for revocation proof"
  valid_host "$DOMAIN" || fail "invalid DOMAIN"
  node_host="$(host_for_node "$TARGET_NODE" "$DOMAIN")"
  valid_host "$node_host" || fail "invalid node host"
  probe_status() {
    local credential="$1"
    { printf 'header = "Authorization: Bearer %s"\n' "$credential"; printf 'header = "content-type: application/json"\n'; } |
      curl --silent --show-error --output /dev/null --write-out '%{http_code}' --config - \
        --request POST --data '{"flightId":"credential-revocation-proof","operation":"run-carries-v1"}' \
        "https://${node_host}/api/internal/flight-probe"
  }
  [[ "$(probe_status "$active")" == 200 ]] || fail "active-key proof did not return 200"
  [[ "$(probe_status "$prior")" == 401 ]] || fail "revocation proof pending: prior key did not return 401"
fi

echo "[flight-probe-project] projected ${LANE}/${TARGET_NODE}; credential values redacted"
