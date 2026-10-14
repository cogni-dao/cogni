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

# Emits the response body on stdout; on any failure, emits OpenFGA's own answer
# (status + body) to stderr and returns 22.
#
# NOT `curl -fsS`. With -f, curl exits 22 and throws the response body away, so a
# rejected store/model write reached CI as a bare `exit 22` with no reason — and
# because every caller is a `$(...)` command substitution, a `die` in here would
# only exit the subshell. Three production infra deploys failed undiagnosably at
# the model write before this was fixed (bug.5417). Same swallowed-error shape as
# sync-app-webhook-secret.sh (bug.5404). 22 is preserved as the return code so
# callers that tolerate failure with `|| return 1` keep working.
curl_json() {
  local method="$1" path="$2"
  shift 2
  local raw status body
  if ! raw="$(curl -sS -w '\n%{http_code}' -X "$method" "${api_url}${path}" \
    "${auth_args[@]}" \
    -H "content-type: application/json" \
    "$@")"; then
    log "${method} ${path}: curl transport failure"
    return 22
  fi
  status="${raw##*$'\n'}"
  body="${raw%$'\n'*}"
  if [[ "$status" != 2* ]]; then
    log "${method} ${path} -> HTTP ${status}"
    log "${method} ${path} response: ${body:0:2000}"
    return 22
  fi
  printf '%s' "$body"
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
    # STRIP_PROTOBUF_DEFAULTS: OpenFGA serializes an authorization model with its
    # protobuf defaults populated, so reading back the very model you just wrote returns
    # extra keys that were never in git. Measured from candidate-a store
    # 01KZC94YDQBZ63Q0624FMRAGE0 against the model this script had just written:
    #   "module": ""       (on every type_definition and every metadata.relations entry)
    #   "condition": ""    (on every userset entry)
    #   "object": ""       (on computedUserset inside tupleToUserset)
    #   "relations": {}    (on type_definitions that declare no relations)
    #   "conditions": {}   (top level, where git has no conditions at all)
    # An absent scalar and an empty-string scalar are the SAME model to OpenFGA, so
    # dropping them is a normalization, not an edit — and the git model contains no
    # empty-string value anywhere, so the write body is untouched.
    #
    # Empty OBJECTS are only dropped for protobuf MAP fields, by name. `{}` is
    # load-bearing elsewhere in a model: `"this": {}` is the direct-relation marker
    # (16 occurrences here), and this projection is also the POST body, so a blanket
    # empty-object strip would rewrite the authorization model being written.
    def strip_protobuf_defaults:
      walk(
        if type == "object" then
          with_entries(
            .key as $k
            | .value as $v
            | select(
                $v != null
                and $v != ""
                and (
                  ($v | type) != "object"
                  or ($v | length) > 0
                  or (["relations", "conditions", "metadata"] | index($k) | not)
                )
              )
          )
        else .
        end
      );

    if has("authorization_model") then .authorization_model else . end
    | {schema_version, type_definitions, conditions}
    | strip_protobuf_defaults
    | normalize_keys
  '
}

authorization_model_id_for_hash() {
  local store_id="$1" expected_hash="$2"
  local models_json model_id model_json hash
  models_json="$(curl_json GET "/stores/${store_id}/authorization-models?page_size=100")"
  log "store ${store_id}: $(printf '%s' "$models_json" | jq -r '[.authorization_models[]?] | length') existing model(s); looking for hash ${expected_hash}"

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

# WHY_IT_DIFFERS_MUST_BE_IN_THE_LOG: `hash differs from git model` is unactionable on
# its own — it was emitted on every production deploy for a month while the model file
# was untouched, and it is what identified the five defaults above in a single run. Any
# future asymmetry (a field OpenFGA starts defaulting, a key this projection does not
# normalize) shows up here as the actual differing lines.
log_canonical_model_diff() {
  local store_id="$1" model_id="$2" expected_hash_label="$3"
  local deployed
  deployed="$(curl_json GET "/stores/${store_id}/authorization-models/${model_id}" | canonical_model_json)" || return 0
  log "canonical diff, deployed model ${model_id} (<) vs git ${expected_hash_label} (>):"
  diff <(printf '%s\n' "$deployed") <(printf '%s\n' "$expected_canonical") 2>/dev/null |
    head -40 |
    while IFS= read -r line; do log "  ${line}"; done || true
  return 0
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
expected_canonical="$canonical"
expected_hash="$(printf '%s' "$canonical" | model_hash)"
authorization_model_id="$(authorization_model_id_for_hash "$store_id" "$expected_hash")"
if [[ -z "$authorization_model_id" ]]; then
  if [[ -n "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID" ]]; then
    configured_hash="$(authorization_model_hash_for_id "$store_id" "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID" || true)"
    if [[ "$configured_hash" == "$expected_hash" ]]; then
      log "using existing configured authorization model"
      authorization_model_id="$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID"
    elif [[ -n "$configured_hash" ]]; then
      log "configured authorization model hash differs from git model; writing new model (configured ${OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID}=${configured_hash} vs git=${expected_hash})"
      log_canonical_model_diff "$store_id" "$OPENFGA_EXISTING_AUTHORIZATION_MODEL_ID" "$expected_hash"
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
