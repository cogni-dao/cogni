#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Execute the real lookup functions against divergent hermetic lane/owner banks.
# No script entrypoint, SSH, credential loading or native database is invoked.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMPROOT=$(mktemp -d -t template-target-bank.XXXXXX)
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
  TARGET_NODE=node-template
  mkdir -p "$TMPROOT/banks/cogni/production/node-template" "$TMPROOT/banks/cogni/production/operator"
  for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
    printf '%s' "production-$key" > "$TMPROOT/banks/cogni/production/node-template/$key"
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
    [[ "$(_bao_env_for_svc node-template)" == "$DEPLOY_ENVIRONMENT" ]]
    mkdir -p "$TMPROOT/banks/cogni/$DEPLOY_ENVIRONMENT/node-template"
    for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
      printf '%s' "$DEPLOY_ENVIRONMENT-$key" > "$TMPROOT/banks/cogni/$DEPLOY_ENVIRONMENT/node-template/$key"
      : > "$TMPROOT/reads"
      [[ "$(bao_get_field node-template "$key")" == "$DEPLOY_ENVIRONMENT-$key" ]]
      [[ "$(cat "$TMPROOT/reads")" == "cogni/$DEPLOY_ENVIRONMENT/node-template" ]]
    done
    [[ "$(bao_get_field operator DOLTGRES_PASSWORD)" == shared-engine ]]
    [[ "$(_bao_env_for_svc _shared)" == production ]]
    [[ "$(_bao_env_for_svc node-template-database-migration)" == "$DEPLOY_ENVIRONMENT" ]]
  done
  DEPLOY_ENVIRONMENT=candidate-a
  rm -rf "$TMPROOT/banks/cogni/candidate-a/node-template"
  : > "$TMPROOT/reads"
  [[ -z "$(bao_get_field node-template APP_DB_PASSWORD)" ]]
  [[ "$(cat "$TMPROOT/reads")" == cogni/candidate-a/node-template ]]
  # A denied target bank remains an error, never absence or a production fallback.
  READ_FAILURE_PATH=cogni/candidate-a/node-template
  if (bao_get_field node-template APP_DB_PASSWORD) > "$TMPROOT/denied.out" 2>&1; then
    echo 'denied candidate target bank was accepted' >&2; exit 1
  fi
  unset READ_FAILURE_PATH
  TARGET_NODE=poly
  [[ "$(_bao_env_for_svc node-template)" == production ]]
  [[ "$(_bao_env_for_svc poly)" == candidate-a ]]
  # Do not redirect explicit shared operator authority for foreign-custodied lanes.
  TARGET_NODE=operator
  [[ "$(_bao_env_for_svc operator)" == production ]]
)

(
  load_function scripts/ci/secret-materialize.sh bao_get_field
  load_function scripts/ci/secret-materialize.sh prefetch_path
  CACHE_DIR="$TMPROOT/cache"
  TARGET_NODE=node-template
  DEPLOY_ENVIRONMENT=candidate-a
  mkdir -p "$CACHE_DIR/node-template" "$CACHE_DIR/__owner__/node-template" "$CACHE_DIR/__owner__/operator"
  for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
    printf '%s' "production-$key" > "$CACHE_DIR/__owner__/node-template/$key"
  done
  printf '%s' shared-engine > "$CACHE_DIR/__owner__/operator/DOLTGRES_PASSWORD"
  printf '%s' shared-master > "$CACHE_DIR/__owner__/operator/LITELLM_MASTER_KEY"
  for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DATABASE_URL DATABASE_SERVICE_URL; do
    [[ -z "$(bao_get_field node-template "$key")" ]]
    printf '%s' "candidate-$key" > "$CACHE_DIR/node-template/$key"
    [[ "$(bao_get_field node-template "$key")" == "candidate-$key" ]]
  done
  [[ "$(bao_get_field operator DOLTGRES_PASSWORD)" == shared-engine ]]
  [[ "$(bao_get_field operator LITELLM_MASTER_KEY)" == shared-master ]]
  TARGET_NODE=poly
  [[ "$(bao_get_field node-template APP_DB_PASSWORD)" == candidate-APP_DB_PASSWORD ]]
  rm "$CACHE_DIR/node-template/APP_DB_PASSWORD"
  [[ "$(bao_get_field node-template APP_DB_PASSWORD)" == production-APP_DB_PASSWORD ]]
  TARGET_NODE=node-template
  cogni_openbao_read_path() { echo 'transient' >&2; return 75; }
  if (prefetch_path node-template) > "$TMPROOT/transport.out" 2>&1; then
    echo 'unknown target bank transport was accepted' >&2; exit 1
  fi
  cogni_openbao_read_path() { printf '%s' '{"data":{"data":{}}}'; }
  prefetch_path node-template
  [[ -z "$(bao_get_field node-template APP_DB_PASSWORD)" ]]
)
echo 'template-target-bank: lane precedence, missing/denied/unknown refusal and shared custody pass'
