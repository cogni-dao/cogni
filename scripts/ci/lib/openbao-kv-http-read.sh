#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# GET-only transport adapted from2831's identity-validated infra reader.
# Runner supplies remote(), CACHE_DIR, and the existing writer token. No mint/write.
# The deploy-infra inline reader remains owned by the independent writer repair2834.

cogni_openbao_read_address() {
  local cache="${CACHE_DIR}/.bao-service-address" raw="${CACHE_DIR}/.bao-service.json" ip rc
  if [[ -s "$cache" ]]; then cat "$cache"; return 0; fi
  if remote 'timeout 15 kubectl -n openbao get service openbao -o json' > "$raw" 2>/dev/null; then :; else
    rc=$?; printf '[openbao-http-read] phase=service_discovery native_rc=%s reason=unavailable\n' "$rc" >&2; return 75
  fi
  jq -e '.metadata.name == "openbao" and .metadata.namespace == "openbao" and .spec.type == "ClusterIP"
    and .spec.selector == {"app.kubernetes.io/name":"openbao","app.kubernetes.io/instance":"openbao","component":"server"}
    and ([.spec.ports[] | select(.port == 8200 and (.protocol // "TCP") == "TCP" and .targetPort == 8200)] | length) == 1' "$raw" >/dev/null 2>&1 \
    || { printf '[openbao-http-read] phase=service_discovery reason=identity_unproven\n' >&2; return 65; }
  ip="$(jq -r '.spec.clusterIP // empty' "$raw")"
  ip="$(printf '%s' "$ip" | python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.stdin.read()); print("["+str(a)+"]" if a.version==6 else str(a))' 2>/dev/null)" \
    || { printf '[openbao-http-read] phase=service_discovery reason=address_unproven\n' >&2; return 65; }
  (umask 077; printf 'http://%s:8200' "$ip" > "$cache")
  cat "$cache"
}

# This function is shipped as code on SSH stdin, never by sourcing a remote file.
# Token and response stay in a private temporary directory; stderr is value-free.
cogni_openbao_native_get() (
  umask 077
  local address="$1" path="$2" limit="$3" token dir status=000 rc=0
  IFS= read -r token || return 65
  [[ "$token" =~ ^[a-zA-Z0-9._-]+$ ]] || return 65
  dir="$(umask 077; mktemp -d -t cogni-bao-get.XXXXXX)" || return 1
  chmod 700 "$dir"
  trap 'rm -rf "$dir"' EXIT
  (umask 077; printf 'header = "X-Vault-Token: %s"\n' "$token" > "$dir/request.conf")
  if status="$(timeout "$limit" curl --disable --silent --show-error --noproxy '*' --proto '=http' --max-redirs 0 \
    --connect-timeout "$limit" --max-time "$limit" --request GET --config "$dir/request.conf" \
    --output "$dir/response" --write-out '%{http_code}' "${address}/v1/${path}" 2>"$dir/http.stderr")"; then :; else rc=$?; fi
  rm -f "$dir/request.conf"
  # KVv2 success carries data.data and no errors (absent or an empty array).
  # Known missing-path404 carries errors:[] and no data (absent/null). A
  # contradictory envelope is unavailable, never permission to mint a replacement.
  if [[ "$rc" == 0 && "$status" == 200 ]] && jq -se 'length == 1 and (.[0] | type == "object" and (.data.data | type == "object") and ((has("errors") | not) or .errors == []))' "$dir/response" >/dev/null 2>&1; then
    cat "$dir/response"; return 0
  fi
  if [[ "$rc" == 0 && "$status" == 404 ]] && jq -se 'length == 1 and (.[0] | type == "object" and .errors == [] and .data == null)' "$dir/response" >/dev/null 2>&1; then
    printf '{"data":{"data":{}}}\n'; return 0
  fi
  printf '[openbao-http-read] phase=kv_read native_rc=%s http_status=%s reason=unavailable\n' "$rc" "$status" >&2
  case "$rc:$status" in
    124:*|28:*|7:*|52:*|56:*|0:429|0:5??) return 75 ;;
    0:401|0:403) return 77 ;;
    *) return 65 ;;
  esac
)

cogni_openbao_read_path() {
  local env="$1" svc="$2" address rc started=$SECONDS remaining
  [[ "$env" == "$DEPLOY_ENVIRONMENT" || "$env" == "$SECRETS_CONTROL_ENV" ]] \
    && [[ "$env" =~ ^(candidate-a|preview|production)$ && "$svc" =~ ^[a-zA-Z0-9_-]+$ ]] \
    || { printf '[openbao-http-read] phase=scope reason=denied\n' >&2; return 77; }
  [[ "$BAO_TOKEN" =~ ^[a-zA-Z0-9._-]+$ ]] || return 65
  if address="$(cogni_openbao_read_address)"; then :; else rc=$?; return "$rc"; fi
  remaining=$((30 - (SECONDS - started)))
  [[ "$remaining" -gt 0 ]] || return 75
  # All arguments are validated non-secret values; token is a literal stdin heredoc.
  # Only native transport failure may be retried by the existing SSH wrapper.
  {
    printf 'set -euo pipefail\n'
    declare -f cogni_openbao_native_get
    # shellcheck disable=SC2016 # Positional parameters belong to the remote bash.
    printf 'cogni_openbao_native_get "$1" "$2" "$3" <<\x27COGNI_BAO_TOKEN\x27\n%s\nCOGNI_BAO_TOKEN\n' "$BAO_TOKEN"
  } | remote "bash -s -- '${address}' 'cogni/data/${env}/${svc}' '${remaining}'"
}
