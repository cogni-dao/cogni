#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Execute the real lookup functions against divergent hermetic lane/owner banks.
# No script entrypoint, SSH, credential loading or native database is invoked.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMPROOT=$(mktemp -d -t target-owner-bank.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

load_function() {
  local definition
  definition=$(sed -n "/^${2}() {$/,/^}$/p" "$REPO_ROOT/$1")
  [[ -n "$definition" ]] || { echo "missing lookup function: $2" >&2; exit 1; }
  eval "$definition"
}
fail() { echo 'fixture lookup refused' >&2; exit 1; }
sleep() { :; } # Error-path retries are finite; do not spend wall time in a fixture.

(
  load_function scripts/ci/reconcile-node-substrate.sh _bao_env_for_svc
  load_function scripts/ci/reconcile-node-substrate.sh bao_get_field
  BAO_TOKEN=fixture-only
  SUBSTRATE_CONTROL_ENV=production
  TARGET_NODE=operator
  mkdir -p "$TMPROOT/banks/cogni/production/operator"
  for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
    printf '%s' "production-$key" > "$TMPROOT/banks/cogni/production/operator/$key"
  done
  printf '%s' shared-engine > "$TMPROOT/banks/cogni/production/operator/DOLTGRES_PASSWORD"
  remote() {
    local bank
    [[ "$*" =~ \'(cogni/[a-z-]+/[a-z_-]+)\' ]] || exit 9
    bank=${BASH_REMATCH[1]}
    printf '%s\n' "$bank" >> "$TMPROOT/reads"
    if [[ "${READ_FAILURE_PATH:-}" == "$bank" ]]; then
      echo 'permission denied' >&2
      return 1
    fi
    [[ -d "$TMPROOT/banks/$bank" ]] || { echo 'No value found' >&2; return 2; }
    local json='{}' entry
    for entry in "$TMPROOT/banks/$bank/"*; do
      [[ -f "$entry" ]] || continue
      json=$(jq --arg key "${entry##*/}" --arg value "$(cat "$entry")" '. + {($key): $value}' <<< "$json")
    done
    jq -n --argjson bank "$json" '{data:{data:$bank}}'
  }
  for DEPLOY_ENVIRONMENT in candidate-a preview production; do
    [[ "$(_bao_env_for_svc operator)" == "$DEPLOY_ENVIRONMENT" ]]
    mkdir -p "$TMPROOT/banks/cogni/$DEPLOY_ENVIRONMENT/operator"
    for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
      printf '%s' "$DEPLOY_ENVIRONMENT-$key" > "$TMPROOT/banks/cogni/$DEPLOY_ENVIRONMENT/operator/$key"
      : > "$TMPROOT/reads"
      [[ "$(bao_get_field operator "$key")" == "$DEPLOY_ENVIRONMENT-$key" ]]
      [[ "$(cat "$TMPROOT/reads")" == "cogni/$DEPLOY_ENVIRONMENT/operator" ]]
    done
    [[ "$(bao_get_field operator DOLTGRES_PASSWORD owner)" == shared-engine ]]
    [[ "$(_bao_env_for_svc _shared owner)" == production ]]
    [[ "$(_bao_env_for_svc operator-database-migration)" == "$DEPLOY_ENVIRONMENT" ]]
  done
  DEPLOY_ENVIRONMENT=candidate-a
  rm -rf "$TMPROOT/banks/cogni/candidate-a/operator"
  : > "$TMPROOT/reads"
  [[ -z "$(bao_get_field operator APP_DB_PASSWORD)" ]]
  [[ "$(cat "$TMPROOT/reads")" == cogni/candidate-a/operator ]]
  # A denied target bank remains an error, never absence or a production fallback.
  READ_FAILURE_PATH=cogni/candidate-a/operator
  if (bao_get_field operator APP_DB_PASSWORD) > "$TMPROOT/denied.out" 2>&1; then
    echo 'denied candidate target bank was accepted' >&2; exit 1
  fi
  unset READ_FAILURE_PATH
  TARGET_NODE=poly
  [[ "$(_bao_env_for_svc operator owner)" == production ]]
  [[ "$(_bao_env_for_svc poly)" == candidate-a ]]
  # Do not redirect explicit shared operator authority for foreign-custodied lanes.
  TARGET_NODE=operator
  [[ "$(_bao_env_for_svc operator owner)" == production ]]
)

(
  load_function scripts/ci/secret-materialize.sh bao_get_field
  load_function scripts/ci/secret-materialize.sh prefetch_path
  CACHE_DIR="$TMPROOT/cache"
  TARGET_NODE=operator
  DEPLOY_ENVIRONMENT=candidate-a
  SECRETS_CONTROL_ENV=production
  mkdir -p "$CACHE_DIR/operator" "$CACHE_DIR/__owner__/operator"
  for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
    printf '%s' "production-$key" > "$CACHE_DIR/__owner__/operator/$key"
  done
  printf '%s' shared-engine > "$CACHE_DIR/__owner__/operator/DOLTGRES_PASSWORD"
  printf '%s' shared-master > "$CACHE_DIR/__owner__/operator/LITELLM_MASTER_KEY"
  for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
    [[ -z "$(bao_get_field operator "$key")" ]]
    printf '%s' "candidate-$key" > "$CACHE_DIR/operator/$key"
    [[ "$(bao_get_field operator "$key")" == "candidate-$key" ]]
  done
  [[ "$(bao_get_field operator DOLTGRES_PASSWORD owner)" == shared-engine ]]
  [[ "$(bao_get_field operator LITELLM_MASTER_KEY owner)" == shared-master ]]
  TARGET_NODE=poly
  [[ "$(bao_get_field operator APP_DB_PASSWORD)" == candidate-APP_DB_PASSWORD ]]
  rm "$CACHE_DIR/operator/APP_DB_PASSWORD"
  [[ -z "$(bao_get_field operator APP_DB_PASSWORD)" ]]
  [[ "$(bao_get_field operator APP_DB_PASSWORD owner)" == production-APP_DB_PASSWORD ]]
  TARGET_NODE=operator
  load_function scripts/ci/secret-materialize.sh inherit_shared_value
  _cat_field() { printf '%s' operator; }
  unset LITELLM_MASTER_KEY
  inherit_shared_value LITELLM_MASTER_KEY
  [[ "$LITELLM_MASTER_KEY" == shared-master ]]
  cogni_openbao_read_path() { echo 'transient' >&2; return 75; }
  if (prefetch_path operator) > "$TMPROOT/transport.out" 2>&1; then
    echo 'unknown target bank transport was accepted' >&2; exit 1
  fi
  cogni_openbao_read_path() { printf '%s' '{"data":{"data":{}}}'; }
  prefetch_path operator
  [[ -z "$(bao_get_field operator APP_DB_PASSWORD)" ]]
)

# Execute the actual baseline loop, rather than a copied inheritance algorithm.
# A distinct ordinary target and operator-as-target must obey the same authority.
(
  load_function scripts/ci/secret-materialize.sh bao_get_field
  CACHE_DIR="$TMPROOT/inheritance-cache"
  DEPLOY_ENVIRONMENT=candidate-a
  SECRETS_CONTROL_ENV=production
  NODE_BASELINE_KEYS=(POSTHOG_API_KEY POSTHOG_HOST TAVILY_API_KEY)
  DSN_DEFER_KEYS=' '
  COMPOSED_DSN_KEYS=' '
  _cat_field() {
    yq -N "(.secrets[] | select(.name == \"$1\") | $2) // \"\"" "$REPO_ROOT/infra/secrets-catalog.yaml"
  }
  _node_gets_key() { return 0; }
  log() { :; }
  seed_kv() { printf '%s' "$3" > "$CACHE_DIR/$1/$2"; }
  # These keys must resolve through their declaration, never generation/env input.
  key_is_agent_generated() { echo 'unexpected generation path' >&2; exit 1; }
  inherit_shared_value() { echo 'unexpected legacy path' >&2; exit 1; }
  _resolve_node_value() { echo 'unexpected target fallback' >&2; exit 1; }
  baseline_loop=$(sed -n '/^for k in "${NODE_BASELINE_KEYS\[@\]}"; do$/,/^done$/p' "$REPO_ROOT/scripts/ci/secret-materialize.sh")
  [[ -n "$baseline_loop" ]]
  mkdir -p "$CACHE_DIR/__owner__/operator"
  printf '%s' owner-posthog > "$CACHE_DIR/__owner__/operator/POSTHOG_API_KEY"
  printf '%s' https://owner-posthog.example > "$CACHE_DIR/__owner__/operator/POSTHOG_HOST"
  for TARGET_NODE in ordinary-target operator; do
    mkdir -p "$CACHE_DIR/$TARGET_NODE"
    printf '%s' stale-target > "$CACHE_DIR/$TARGET_NODE/POSTHOG_API_KEY"
    created=0 unchanged=0
    eval "$baseline_loop"
    [[ "$(bao_get_field "$TARGET_NODE" POSTHOG_API_KEY)" == owner-posthog ]]
    [[ "$(bao_get_field "$TARGET_NODE" POSTHOG_HOST)" == https://owner-posthog.example ]]
    [[ ! -f "$CACHE_DIR/$TARGET_NODE/TAVILY_API_KEY" ]] # Optional and unconfigured.
    printf '%s' owner-tavily > "$CACHE_DIR/__owner__/operator/TAVILY_API_KEY"
    eval "$baseline_loop"
    [[ "$(bao_get_field "$TARGET_NODE" TAVILY_API_KEY)" == owner-tavily ]]
    rm "$CACHE_DIR/__owner__/operator/TAVILY_API_KEY"
    if (eval "$baseline_loop") > "$TMPROOT/optional-stale.out" 2>&1; then
      echo 'missing optional owner retained a stale target credential' >&2; exit 1
    fi
    rm "$CACHE_DIR/$TARGET_NODE/TAVILY_API_KEY"
    mv "$CACHE_DIR/__owner__/operator/POSTHOG_API_KEY" "$TMPROOT/owner-posthog"
    printf '%s' stale-target > "$CACHE_DIR/$TARGET_NODE/POSTHOG_API_KEY"
    if (eval "$baseline_loop") > "$TMPROOT/required-stale.out" 2>&1; then
      echo 'missing required owner retained a stale target credential' >&2; exit 1
    fi
    [[ "$(bao_get_field "$TARGET_NODE" POSTHOG_API_KEY)" == stale-target ]]
    mv "$TMPROOT/owner-posthog" "$CACHE_DIR/__owner__/operator/POSTHOG_API_KEY"
  done
)
echo 'target-owner-bank: lane precedence, missing/denied/unknown refusal and shared custody pass'
