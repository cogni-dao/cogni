#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Materializer HTTP transport: validated Service, Kubernetes login, strict KV GET.
# Runner supplies remote(), CACHE_DIR, and control/lane identity. No KV mutations.
# The deploy-infra inline reader remains owned by the independent writer repair2834.

cogni_openbao_service_address() {
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

# Shared native transport. POST is restricted to the existing Kubernetes login;
# no KV mutation can enter this helper. Private files belong to the calling scope.
cogni_openbao_native_request() {
  local method="$1" address="$2" path="$3" limit="$4" dir="$5"
  local -a body=()
  case "$method:$path" in
    GET:cogni/data/*) ;;
    POST:auth/kubernetes/login) body=(--data-binary "@${dir}/body.json") ;;
    *) return 65 ;;
  esac
  timeout "$limit" curl --disable --silent --show-error --noproxy '*' --proto '=http' --max-redirs 0 \
    --connect-timeout "$limit" --max-time "$limit" --request "$method" --config "$dir/request.conf" \
    "${body[@]}" --output "$dir/response" --write-out '%{http_code}' "${address}/v1/${path}" 2>"$dir/http.stderr"
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
  if status="$(cogni_openbao_native_request GET "$address" "$path" "$limit" "$dir")"; then :; else rc=$?; fi
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
  if address="$(cogni_openbao_service_address)"; then :; else rc=$?; return "$rc"; fi
  remaining=$((30 - (SECONDS - started)))
  [[ "$remaining" -gt 0 ]] || return 75
  # All arguments are validated non-secret values; token is a literal stdin heredoc.
  # Only native transport failure may be retried by the existing SSH wrapper.
  {
    printf 'set -euo pipefail\n'
    declare -f cogni_openbao_native_request
    declare -f cogni_openbao_native_get
    # shellcheck disable=SC2016 # Positional parameters belong to the remote bash.
    printf 'cogni_openbao_native_get "$1" "$2" "$3" <<\x27COGNI_BAO_TOKEN\x27\n%s\nCOGNI_BAO_TOKEN\n' "$BAO_TOKEN"
  } | remote "bash -s -- '${address}' 'cogni/data/${env}/${svc}' '${remaining}'"
}

# Same named SA and writer role as the former exec-based login. JWT and response
# are native private files; no credential is present in a command argument.
cogni_openbao_native_login() (
  umask 077
  local address="$1" control="$2" attempt="$3" dir phase=token_request rc=0 status=000 reason=permanent started=$SECONDS token
  dir="$(mktemp -d -t cogni-bao-login.XXXXXX)" || return 65
  chmod 700 "$dir"
  trap 'rm -rf "$dir"' EXIT
  if timeout 10 kubectl create token openbao-operator -n default >"$dir/jwt" 2>"$dir/token.stderr"; then
    if jq -Rse --arg role "${control}-writer" 'rtrimstr("\n") | select(test("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")) | {role:$role,jwt:.}' "$dir/jwt" >"$dir/body.json" 2>/dev/null; then
      printf '[openbao-materializer-login] phase=%s control_env=%s role=%s-writer sa=openbao-operator namespace=default attempt=%s elapsed_s=%s native_rc=0 http_status=000 reason=complete\n' "$phase" "$control" "$control" "$attempt" "$((SECONDS-started))" >&2
      phase=writer_login; started=$SECONDS
      printf 'header = "Content-Type: application/json"\n' >"$dir/request.conf"
      if status="$(cogni_openbao_native_request POST "$address" auth/kubernetes/login 10 "$dir")"; then
        if [[ "$status" == 200 ]] && jq -se 'length == 1 and (.[0] | type == "object" and ((has("errors") | not) or .errors == []) and (.auth | type == "object") and (.auth.client_token | type == "string" and test("^[A-Za-z0-9._-]+$")))' "$dir/response" >/dev/null 2>&1; then
          token="$(jq -r '.auth.client_token' "$dir/response")"
          printf '[openbao-materializer-login] phase=%s control_env=%s role=%s-writer sa=openbao-operator namespace=default attempt=%s elapsed_s=%s native_rc=0 http_status=200 reason=complete\n' "$phase" "$control" "$control" "$attempt" "$((SECONDS-started))" >&2
          printf '%s\n' "$token"; return 0
        fi
        case "$status" in 403) reason=permission_denied_recheck ;; 429|5??) reason=server_transient ;; esac
      else
        rc=$?
        case "$rc" in 124|28|7|52|56) reason=server_transient ;; esac
      fi
    fi
  else
    rc=$?
    if [[ "$rc" == 124 ]] || grep -qiE 'context deadline exceeded|Internal error occurred: Timeout occurred|i/o timeout|TLS handshake timeout|connection (refused|reset)|unable to connect to the server|the server is currently unable to handle the request|Code: (429|500|502|503|504)' "$dir/token.stderr"; then
      reason=server_transient
    elif grep -qiE 'Code: 403|permission denied|Forbidden' "$dir/token.stderr"; then
      reason=permission_denied_recheck
    fi
  fi
  printf '[openbao-materializer-login] phase=%s control_env=%s role=%s-writer sa=openbao-operator namespace=default attempt=%s elapsed_s=%s native_rc=%s http_status=%s reason=%s\n' "$phase" "$control" "$control" "$attempt" "$((SECONDS-started))" "$rc" "$status" "$reason" >&2
  case "$reason" in server_transient) return 75 ;; permission_denied_recheck) return 77 ;; *) return 65 ;; esac
)

cogni_openbao_materializer_login() {
  local address attempt rc max_attempts=0 token started
  [[ "$SECRETS_CONTROL_ENV" =~ ^(candidate-a|preview|production)$ ]] || return 77
  for attempt in 1 2 3; do
    rc=0; started=$SECONDS
    if address="$(cogni_openbao_service_address)"; then
      if token="$({
        printf 'set -euo pipefail\n'
        declare -f cogni_openbao_native_request cogni_openbao_native_login
        # shellcheck disable=SC2016 # Remote positional parameters, all non-secret.
        printf 'cogni_openbao_native_login "$1" "$2" "$3"\n'
      } | remote "bash -s -- '${address}' '${SECRETS_CONTROL_ENV}' '${attempt}'")"; then
        printf '%s\n' "$token"; return 0
      else rc=$?; fi
    else
      rc=$?
      printf '[openbao-materializer-login] phase=service_discovery control_env=%s role=%s-writer sa=openbao-operator namespace=default attempt=%s elapsed_s=%s native_rc=%s http_status=000 reason=unavailable\n' "$SECRETS_CONTROL_ENV" "$SECRETS_CONTROL_ENV" "$attempt" "$((SECONDS-started))" "$rc" >&2
    fi
    # Match the existing first-failure policy: a denial permits ONE fresh JWT
    # recheck; a transient permits at most three. Later errors never widen it.
    case "$rc" in
      75) [[ "$max_attempts" != 0 ]] || max_attempts=3 ;;
      77) [[ "$max_attempts" != 0 ]] || max_attempts=2 ;;
      *) return "$rc" ;;
    esac
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      printf '[openbao-materializer-login] control_env=%s role=%s-writer sa=openbao-operator namespace=default attempt=%s max_attempts=%s native_rc=%s reason=exhausted\n' "$SECRETS_CONTROL_ENV" "$SECRETS_CONTROL_ENV" "$attempt" "$max_attempts" "$rc" >&2
      return "$rc"
    fi
    sleep $((attempt * 5 + RANDOM % 5))
  done
}
