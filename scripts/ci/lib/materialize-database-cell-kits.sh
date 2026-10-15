#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Private cell-kit phase of the existing sole materializer. No provider writes.

materialize_database_cell_kits() {
  [[ "$TARGET_NODE" == "$RELIABILITY_CONTROLLER" ]] || return 0
  local cell_node lane catalog physical node_uuid source_sha source_slot
  local source_ns cell_bank kit_json authority_json profile budget_json version_json source_host backup_bank backup_key backup_lane backup_component_bank
  local cell_domain_root="$DOMAIN"
  case "$DEPLOY_ENVIRONMENT" in preview) cell_domain_root="${cell_domain_root#preview.}" ;; candidate-a) cell_domain_root="${cell_domain_root#test.}" ;; esac
  source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
  local slots='[]' existing_kits='[]' existing_authorities='[]' operator_sha plans native_source output published_json
  operator_sha="$(git -C "$APP_SOURCE_DIR" rev-parse HEAD)"
  [[ "$operator_sha" =~ ^[0-9a-f]{40}$ ]] || fail "cell bootstrap artifact provenance missing"
  for cell_node in "${NODE_TARGETS[@]}"; do
    catalog="${CATALOG_DIR}/${cell_node}.yaml"
    while IFS= read -r lane; do
      [[ -n "$lane" ]] || continue
      physical="$(lane_db_vm_env "$cell_node" "$lane")" || fail "cell source residency unresolved"
      [[ "$physical" == "$DEPLOY_ENVIRONMENT" ]] || continue
      source_ns="__cell-source-${cell_node}-${lane}"
      prefetch_path "$cell_node" "$lane" "$source_ns"
      node_uuid="$(node_id_for_target "$cell_node")"
      # Canonical catalog+domain identity owns the URL. Serving version is an
      # observed pin; an absent slot uses its reviewed desired catalog pin only.
      source_host="$(host_for_node "$cell_node" "$(cogni_operator_domain_for_env "$lane" "$cell_domain_root")")"
      version_json="$(curl -fsS --connect-timeout 5 --max-time 10 "https://${source_host}/version" 2>/dev/null || true)"
      source_sha="$(jq -er '.buildSha | select(test("^[0-9a-f]{40}$"))' <<<"${version_json:-{}}" 2>/dev/null || true)"
      if [[ -z "$source_sha" ]]; then
        source_sha="$(yq -er .source_sha "$catalog")"
        log "cell source ${cell_node}/${lane}: reviewed desired pin; serving version unavailable"
      fi
      [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "actual deployed cell source pin unavailable for ${cell_node}/${lane}"
      profile="$(yq -er ".database.\"${lane}\".budget_profile" "$catalog")"
      budget_json="$(yq -o=json ".\"${profile}\"" "${APP_SOURCE_DIR}/infra/database-budget-profiles.yaml" | jq '{appConnectionLimit:.roles.app.connection_limit,appStatementTimeoutMs:.roles.app.statement_timeout_ms,serviceConnectionLimit:.roles.service.connection_limit,serviceStatementTimeoutMs:.roles.service.statement_timeout_ms,lockTimeoutMs:.common.lock_timeout_ms,idleInTransactionTimeoutMs:.common.idle_in_transaction_session_timeout_ms,tempFileLimitMiB:.common.temp_file_limit_mib,workMemMiB:.common.work_mem_mib}')"
      # Source URLs stay in private files/stdin, never helper argv or logs.
      printf '%s' "$(bao_get_field "$source_ns" DATABASE_URL)" > "${CACHE_DIR}/cell-source-app"
      printf '%s' "$(bao_get_field "$source_ns" DATABASE_SERVICE_URL)" > "${CACHE_DIR}/cell-source-service"
      source_slot="$(jq -n --arg nodeId "$node_uuid" --arg nodeSlug "$cell_node" --arg environment "$lane" --arg physicalEnvironment "$physical" --arg sourceSha "$source_sha" --arg budgetProfile "$profile" --argjson budget "$budget_json" --rawfile appDsn "${CACHE_DIR}/cell-source-app" --rawfile serviceDsn "${CACHE_DIR}/cell-source-service" '{nodeId:$nodeId,nodeSlug:$nodeSlug,environment:$environment,physicalEnvironment:$physicalEnvironment,sourceSha:$sourceSha,budgetProfile:$budgetProfile,budget:$budget,appDsn:$appDsn,serviceDsn:$serviceDsn}')"
      slots="$(jq --argjson slot "$source_slot" '.+[$slot]' <<<"$slots")"
    done < <(yq -r '(.database // {}) | to_entries[] | select(.value.tier == "dedicated") | .key' "$catalog")
  done
  [[ "$slots" != '[]' ]] || return 0
  # Read only native identity through the already-owned local Compose process.
  native_source="$(remote 'set -eu
    container_id=$(docker ps --filter label=com.docker.compose.project=cogni-runtime --filter label=com.docker.compose.service=postgres -q)
    [ "$(printf "%s\n" "$container_id" | wc -l)" -eq 1 ] && [ -n "$container_id" ]
    docker exec "$container_id" psql -U root -d postgres -XAtv ON_ERROR_STOP=1 -c "SELECT jsonb_build_object('\''systemIdentifier'\'', (SELECT system_identifier::text FROM pg_control_system()), '\''databases'\'', (SELECT jsonb_agg(datname) FROM pg_database), '\''roles'\'', (SELECT jsonb_agg(rolname) FROM pg_roles));"')"
  plans="$(jq -n --arg operatorSourceSha "$operator_sha" --arg environment "$DEPLOY_ENVIRONMENT" --arg expectedSourceHost "$VM_IP" --argjson nativeSource "$native_source" --argjson slots "$slots" '{operatorSourceSha:$operatorSourceSha,environment:$environment,expectedSourceHost:$expectedSourceHost,nativeSource:$nativeSource,slots:$slots}' | pnpm exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-kits.ts" --plan)" || fail "actual cell source identity did not validate"
  while IFS= read -r cell_node; do
    cell_bank="${cell_node}-database-cell"
    prefetch_path "$cell_bank"
    kit_json="$(bao_get_field "$cell_bank" DATABASE_CELL_BOOTSTRAP_KIT_JSON)"
    [[ -z "$kit_json" ]] || existing_kits="$(jq --argjson kit "$kit_json" '.+[$kit]' <<<"$existing_kits")"
    if [[ -n "$kit_json" ]]; then
      printf '%s' "$(bao_get_field "$cell_bank" DATABASE_CELL_TLS_CA_CERTIFICATE)" > "${CACHE_DIR}/cell-ca"
      printf '%s' "$(bao_get_field "$cell_bank" DATABASE_CELL_TLS_CA_PRIVATE_KEY)" > "${CACHE_DIR}/cell-ca-key"
      authority_json="$(jq -n --argjson kit "$kit_json" --rawfile tlsCaCertificate "${CACHE_DIR}/cell-ca" --rawfile tlsCaPrivateKey "${CACHE_DIR}/cell-ca-key" '{nodeId:$kit.nodeId,environment:$kit.environment,tlsCaCertificate:$tlsCaCertificate,tlsCaPrivateKey:$tlsCaPrivateKey}')"
      existing_authorities="$(jq --argjson authority "$authority_json" '.+[$authority]' <<<"$existing_authorities")"
    fi
  done < <(jq -r '.[].nodeSlug' <<<"$plans")
  prefetch_path akash-tx-actuator
  published_json="$(bao_get_field akash-tx-actuator AKASH_DATABASE_CELL_KITS_JSON)"
  output="$(jq -n --argjson plans "$plans" --argjson existingKits "$existing_kits" --argjson existingAuthorities "$existing_authorities" --argjson existingPublished "${published_json:-[]}" '{plans:$plans,existingKits:$existingKits,existingAuthorities:$existingAuthorities,existingPublished:$existingPublished}' | pnpm exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-kits.ts")" || fail "private cell kit generation failed"
  # Write components first. A restart resumes identical material; only then publish
  # the private actuator projection, so no bootstrap can observe missing authority.
  while IFS= read -r cell_node; do
    cell_bank="${cell_node}-database-cell"
    kit_json="$(jq -c --arg slug "$cell_node" '.nodeKits[]|select(.nodeSlug==$slug)' <<<"$output")"
    authority_json="$(jq -c --argjson kit "$kit_json" '.authorities[]|select(.nodeId==$kit.nodeId and .environment==$kit.environment)' <<<"$output")"
    cell_seed_exact "$cell_bank" DATABASE_CELL_BOOTSTRAP_KIT_JSON "$kit_json"
    cell_seed_exact "$cell_bank" DATABASE_CELL_TLS_CA_CERTIFICATE "$(jq -r .tlsCaCertificate <<<"$authority_json")"
    cell_seed_exact "$cell_bank" DATABASE_CELL_TLS_CA_PRIVATE_KEY "$(jq -r .tlsCaPrivateKey <<<"$authority_json")"
    flush_batch "$cell_bank"
    while IFS= read -r backup_lane; do
      backup_component_bank="${cell_node}-database-backup-$(jq -r .databaseName <<<"$backup_lane")"
      prefetch_path "$backup_component_bank"
      cell_seed_exact "$backup_component_bank" DATABASE_CELL_BACKUP_PASSWORD "$(jq -r .backupPassword <<<"$backup_lane")"
      flush_batch "$backup_component_bank"
    done < <(jq -c '.logicalDatabases[]' <<<"$kit_json")
    backup_bank="${cell_node}-database-backup"
    prefetch_path "$backup_bank"
    backup_key="$(bao_get_field "$backup_bank" DATABASE_CELL_BACKUP_ENCRYPTION_KEY)"
    if [[ -z "$backup_key" ]]; then
      backup_key="$(_resolve_node_value "$backup_bank" DATABASE_CELL_BACKUP_ENCRYPTION_KEY)"
      [[ "$backup_key" =~ ^[0-9a-f]{64}$ ]] || fail "cell backup encryption generation failed"
      cell_seed_exact "$backup_bank" DATABASE_CELL_BACKUP_ENCRYPTION_KEY "$backup_key"
      flush_batch "$backup_bank"
    fi
  done < <(jq -r '.nodeKits[].nodeSlug' <<<"$output")
  cell_seed_exact akash-tx-actuator AKASH_DATABASE_CELL_KITS_JSON "$(jq -c .published <<<"$output")"
  flush_batch akash-tx-actuator
}

cell_seed_exact() {
  local bank="$1" key="$2" value="$3"
  if [[ "$(bao_get_field "$bank" "$key")" == "$value" ]]; then unchanged=$((unchanged+1)); return 0; fi
  rm -f "${CACHE_DIR}/${bank}/${key}"
  seed_kv "$bank" "$key" "$value"
  created=$((created+1))
}
