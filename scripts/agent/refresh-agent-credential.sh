#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Crash-safe refresh for the shared node-agent credential. The old key remains
# installed until the pending key has been confirmed by its issuing node.
set -u

ENV_FILE="${1:-.env.cogni}"
API_BASE="${2:-https://cognidao.org/api/v1}"
ROTATE_BEFORE_SECONDS="${COGNI_AGENT_ROTATE_BEFORE_SECONDS:-604800}"
HTTP_TIMEOUT="${COGNI_AGENT_REFRESH_TIMEOUT:-8}"

read_value() {
  awk -F= -v key="$1" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE" 2>/dev/null
}

resolve_env_file() {
  if [ -L "$ENV_FILE" ]; then
    target="$(readlink "$ENV_FILE")"
    case "$target" in
      /*) ENV_FILE="$target" ;;
      *) ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && cd "$(dirname "$target")" && pwd)/$(basename "$target")" ;;
    esac
  fi
}

flush_path() {
  sync -f "$1" >/dev/null 2>&1 || sync >/dev/null 2>&1 || true
}

# replace_keys <active> <pending>; empty pending removes the pending slot.
replace_keys() {
  active="$1"
  pending="$2"
  dir="$(dirname "$ENV_FILE")"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "$dir/.env.cogni.credential.XXXXXX")" || return 1
  chmod 600 "$tmp"
  if [ -f "$ENV_FILE" ]; then
    awk '$0 !~ /^COGNI_NODE_API_KEY(_PENDING)?=/' "$ENV_FILE" >"$tmp" || {
      rm -f "$tmp"
      return 1
    }
  fi
  printf 'COGNI_NODE_API_KEY=%s\n' "$active" >>"$tmp"
  if [ -n "$pending" ]; then
    printf 'COGNI_NODE_API_KEY_PENDING=%s\n' "$pending" >>"$tmp"
  fi
  flush_path "$tmp"
  mv -f "$tmp" "$ENV_FILE" || {
    rm -f "$tmp"
    return 1
  }
  flush_path "$dir"
}

# request <method> <path> <bearer> [json]; sets RESPONSE_FILE and HTTP_STATUS.
request() {
  method="$1"
  path="$2"
  bearer="$3"
  body="${4:-}"
  [ -z "$RESPONSE_FILE" ] || rm -f "$RESPONSE_FILE"
  RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/cogni-agent-refresh.XXXXXX")" || return 1
  if [ -n "$body" ]; then
    HTTP_STATUS="$(curl -sS --max-time "$HTTP_TIMEOUT" -o "$RESPONSE_FILE" -w '%{http_code}' \
      -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $bearer" -H 'content-type: application/json' \
      -d "$body" 2>/dev/null)" || HTTP_STATUS="000"
  else
    HTTP_STATUS="$(curl -sS --max-time "$HTTP_TIMEOUT" -o "$RESPONSE_FILE" -w '%{http_code}' \
      -X "$method" "$API_BASE$path" \
      -H "Authorization: Bearer $bearer" 2>/dev/null)" || HTTP_STATUS="000"
  fi
}

resolve_env_file
[ -f "$ENV_FILE" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

lock_dir="${ENV_FILE}.credential-refresh.lock"
waited=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  owner="$(sed -n '1p' "$lock_dir/owner" 2>/dev/null)"
  case "$owner" in
    '' | *[!0-9]*) owner_alive=0 ;;
    *)
      if kill -0 "$owner" 2>/dev/null; then
        owner_alive=1
      else
        owner_alive=0
      fi
      ;;
  esac
  if [ "$owner_alive" -eq 0 ]; then
    stale_lock="${lock_dir}.stale.$$"
    if mv "$lock_dir" "$stale_lock" 2>/dev/null; then
      rm -f "$stale_lock/owner"
      rmdir "$stale_lock" 2>/dev/null || true
      continue
    fi
  fi
  [ "$waited" -lt 20 ] || exit 0
  sleep 1
  waited=$((waited + 1))
done
printf '%s\n' "$$" >"$lock_dir/owner" 2>/dev/null || {
  rmdir "$lock_dir" 2>/dev/null || true
  exit 0
}
RESPONSE_FILE=""
cleanup() {
  [ -z "$RESPONSE_FILE" ] || rm -f "$RESPONSE_FILE"
  rm -f "$lock_dir/owner"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

active="$(read_value COGNI_NODE_API_KEY)"
pending="$(read_value COGNI_NODE_API_KEY_PENDING)"
[ -n "$active" ] || exit 0

# Resume an interrupted two-phase install before considering another rotation.
if [ -n "$pending" ]; then
  request POST /agent/credentials/confirm "$pending" || exit 0
  if [ "$HTTP_STATUS" -ge 200 ] 2>/dev/null && [ "$HTTP_STATUS" -lt 300 ] 2>/dev/null; then
    replace_keys "$pending" ""
  fi
  exit 0
fi

case "$active" in
  cogni_ag_sk_v1_*)
    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(printf '%s' "$active" | sha256sum | cut -c1-24)"
    else
      digest="$(printf '%s' "$active" | shasum -a 256 | cut -c1-24)"
    fi
    idempotency="legacy-auto-$digest"
    if [ "$idempotency" = "legacy-auto-" ]; then
      idempotency="legacy-auto-upgrade"
    fi
    request POST /agent/upgrade "$active" "$(jq -cn --arg key "$idempotency" '{idempotencyKey:$key}')" || exit 0
    if [ "$HTTP_STATUS" -ge 200 ] 2>/dev/null && [ "$HTTP_STATUS" -lt 300 ] 2>/dev/null; then
      upgraded="$(jq -r '.apiKey // empty' "$RESPONSE_FILE" 2>/dev/null)"
      [ -z "$upgraded" ] || replace_keys "$upgraded" ""
    fi
    # A rejected legacy key is never replaced by anonymous re-registration.
    exit 0
    ;;
  cogni_ag_sk_v2_*) ;;
  *) exit 0 ;;
esac

request GET /agent/credentials/status "$active" || exit 0
# Invalid/revoked credentials fail closed. In particular, never call register.
[ "$HTTP_STATUS" = "200" ] || exit 0
credential_id="$(jq -r '.credentialId // empty' "$RESPONSE_FILE" 2>/dev/null)"
authenticate_until="$(jq -r '.authenticateUntil // empty | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' "$RESPONSE_FILE" 2>/dev/null)"
case "$credential_id:$authenticate_until" in
  :* | *:) exit 0 ;;
esac
seconds_left=$((authenticate_until - $(date +%s)))
[ "$seconds_left" -le "$ROTATE_BEFORE_SECONDS" ] || exit 0

idempotency="auto-rotation-$credential_id"
request POST /agent/credentials/rotate "$active" "$(jq -cn --arg key "$idempotency" '{idempotencyKey:$key}')" || exit 0
if [ "$HTTP_STATUS" -lt 200 ] 2>/dev/null || [ "$HTTP_STATUS" -ge 300 ] 2>/dev/null; then
  exit 0
fi
pending="$(jq -r '.apiKey // empty' "$RESPONSE_FILE" 2>/dev/null)"
[ -n "$pending" ] || exit 0

# Durable pending slot is the crash boundary: predecessor remains usable.
replace_keys "$active" "$pending" || exit 0
request POST /agent/credentials/confirm "$pending" || exit 0
if [ "$HTTP_STATUS" -ge 200 ] 2>/dev/null && [ "$HTTP_STATUS" -lt 300 ] 2>/dev/null; then
  replace_keys "$pending" ""
fi
