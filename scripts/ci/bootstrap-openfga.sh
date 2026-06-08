#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Idempotently bootstrap the Cogni RBAC OpenFGA store and authorization model.
# Emits shell-safe OPENFGA_STORE_ID / OPENFGA_AUTHORIZATION_MODEL_ID / hash lines.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

OPENFGA_API_URL="${OPENFGA_API_URL:-http://127.0.0.1:8080}"
OPENFGA_STORE_NAME="${OPENFGA_STORE_NAME:-cogni-${DEPLOY_ENVIRONMENT:-local}-rbac}"
OPENFGA_MODEL_FILE="${OPENFGA_MODEL_FILE:-$REPO_ROOT/infra/openfga/rbac-model.json}"
OPENFGA_BOOTSTRAP_TIMEOUT_SECONDS="${OPENFGA_BOOTSTRAP_TIMEOUT_SECONDS:-60}"
OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID="${OPENFGA_AUTHORIZATION_MODEL_ID:-}"
OPENFGA_EXISTING_AUTHORIZATION_MODEL_HASH="${OPENFGA_AUTHORIZATION_MODEL_HASH:-}"

log() {
  printf '[openfga-bootstrap] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -f "$OPENFGA_MODEL_FILE" ]] || die "model file not found: $OPENFGA_MODEL_FILE"

auth_args=()
if [[ -n "${OPENFGA_API_TOKEN:-}" ]]; then
  auth_args=(-H "Authorization: Bearer ${OPENFGA_API_TOKEN}")
fi

api_url="${OPENFGA_API_URL%/}"

curl_json() {
  local method="$1" path="$2"
  shift 2
  curl -fsS -X "$method" "${api_url}${path}" \
    "${auth_args[@]}" \
    -H "content-type: application/json" \
    "$@"
}

wait_for_openfga() {
  local deadline=$((SECONDS + OPENFGA_BOOTSTRAP_TIMEOUT_SECONDS))
  until curl -fsS "${api_url}/healthz" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      die "OpenFGA did not become healthy at ${api_url}/healthz within ${OPENFGA_BOOTSTRAP_TIMEOUT_SECONDS}s"
    fi
    sleep 2
  done
}

store_id_for_name() {
  curl_json GET "/stores?page_size=100" |
    jq -r --arg name "$OPENFGA_STORE_NAME" \
      'first(.stores[]? | select(.name == $name and (.deleted_at == null or .deleted_at == "")) | .id) // empty'
}

model_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    jq -S '.' | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    jq -S '.' | shasum -a 256 | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

canonical_model_json() {
  jq -S '
    def normalize_keys:
      walk(
        if type == "object" then
          with_entries(
            .key |= (
              if . == "computed_userset" then "computedUserset"
              elif . == "tuple_to_userset" then "tupleToUserset"
              else .
              end
            )
          )
        else .
        end
      );
    def strip_nulls:
      walk(
        if type == "object" then
          with_entries(select(.value != null))
        else .
        end
      );

    if has("authorization_model") then .authorization_model else . end
    | {schema_version, type_definitions, conditions}
    | strip_nulls
    | normalize_keys
  '
}

authorization_model_id_for_hash() {
  local store_id="$1" expected_hash="$2"
  local models_json model_id model_json hash
  models_json="$(curl_json GET "/stores/${store_id}/authorization-models?page_size=100")"

  while IFS= read -r model_id; do
    [[ -n "$model_id" ]] || continue
    model_json="$(curl_json GET "/stores/${store_id}/authorization-models/${model_id}")"
    hash="$(printf '%s' "$model_json" | canonical_model_json | model_hash)"
    if [[ "$hash" == "$expected_hash" ]]; then
      printf '%s\n' "$model_id"
      return 0
    fi
  done < <(printf '%s' "$models_json" | jq -r '.authorization_models[]?.id')
}

authorization_model_hash_for_id() {
  local store_id="$1" model_id="$2"
  local model_json
  [[ -n "$model_id" ]] || return 1
  model_json="$(curl_json GET "/stores/${store_id}/authorization-models/${model_id}")" || return 1
  printf '%s' "$model_json" | canonical_model_json | model_hash
}

wait_for_openfga

store_id="$(store_id_for_name)"
if [[ -z "$store_id" ]]; then
  log "creating store '${OPENFGA_STORE_NAME}'"
  store_id="$(curl_json POST "/stores" -d "$(jq -n --arg name "$OPENFGA_STORE_NAME" '{name: $name}')" | jq -r '.id')"
else
  log "using existing store '${OPENFGA_STORE_NAME}'"
fi
[[ -n "$store_id" && "$store_id" != "null" ]] || die "could not resolve store id"

canonical="$(canonical_model_json < "$OPENFGA_MODEL_FILE")"
expected_hash="$(printf '%s' "$canonical" | model_hash)"
authorization_model_id="$(authorization_model_id_for_hash "$store_id" "$expected_hash")"
if [[ -z "$authorization_model_id" ]]; then
  if [[ -n "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID" ]]; then
    configured_hash="$(authorization_model_hash_for_id "$store_id" "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID" || true)"
    if [[ "$configured_hash" == "$expected_hash" ]]; then
      log "using existing configured authorization model"
      authorization_model_id="$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID"
    elif [[ -n "$configured_hash" ]]; then
      log "configured authorization model hash differs from git model; writing new model"
    fi
  fi

  if [[ -z "$authorization_model_id" ]]; then
    if [[ -n "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_HASH" && "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_HASH" != "$expected_hash" ]]; then
      log "stored authorization model hash differs from git model; writing new model"
    fi
    log "writing RBAC authorization model"
    authorization_model_id="$(curl_json POST "/stores/${store_id}/authorization-models" -d "$canonical" | jq -r '.authorization_model_id')"
  fi
else
  log "using existing matching authorization model"
fi
[[ -n "$authorization_model_id" && "$authorization_model_id" != "null" ]] || die "could not resolve authorization model id"

printf 'OPENFGA_STORE_ID=%s\n' "$store_id"
printf 'OPENFGA_AUTHORIZATION_MODEL_ID=%s\n' "$authorization_model_id"
printf 'OPENFGA_AUTHORIZATION_MODEL_HASH=%s\n' "$expected_hash"
