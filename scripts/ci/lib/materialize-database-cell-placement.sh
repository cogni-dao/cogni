#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Sole-writer cell placement phase. All routing derives from an applied receipt.

source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
CELL_PLACEMENT_JSON=''
load_database_cell_placement() {
  CELL_PLACEMENT_JSON=''
  [[ "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || return 0
  local cell_bank="${TARGET_NODE}-database-cell" receipt kit encryption
  prefetch_path "$cell_bank"
  receipt="$(bao_get_field "$cell_bank" DATABASE_CELL_PLACEMENT_RECEIPT_JSON)"
  [[ -n "$receipt" ]] || return 0
  [[ "$(jq -r .binding.nodeSlug <<<"$receipt")" == "$TARGET_NODE" && "$(jq -r .binding.nodeId <<<"$receipt")" == "$(node_id_for_target "$TARGET_NODE")" && "$(jq -r .allocationEnvironment <<<"$receipt")" == "$SECRETS_CONTROL_ENV" && "$(jq -r .binding.environment <<<"$receipt")" == "$DEPLOY_ENVIRONMENT" ]] || fail "cell placement does not own this target lane"
  kit="$(bao_get_field "$cell_bank" DATABASE_CELL_BOOTSTRAP_KIT_JSON)"
  prefetch_path "${TARGET_NODE}-database-backup"
  encryption="$(bao_get_field "${TARGET_NODE}-database-backup" DATABASE_CELL_BACKUP_ENCRYPTION_KEY)"
  CELL_PLACEMENT_JSON="$(jq -n --argjson receipt "$receipt" --argjson kit "$kit" --arg backupEncryptionKey "$encryption" '{receipt:$receipt,kit:$kit,backupEncryptionKey:$backupEncryptionKey}' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts")" || fail "audited cell placement or scoped custody invalid"
}

cell_placement_composed_value() {
  local node="$1" key="$2"
  [[ "$node" == "$TARGET_NODE" && -n "$CELL_PLACEMENT_JSON" ]] || return 1
  jq -er --arg key "$key" '.publicValues[$key] // empty' <<<"$CELL_PLACEMENT_JSON" 2>/dev/null
}

# Fixed private service and path. Token and request travel through stdin into a
# private curl config; neither secret values nor endpoints are caller argv.
cell_actor_http() {
  local path="$1" request="$2" token namespace response
  token="$(bao_get_field akash-tx-actuator AKASH_TX_ACTUATOR_TOKEN)"
  [[ -n "$token" && "$token" != *$'\n'* && "$token" != *'"'* ]] || fail "private actor authentication absent or invalid"
  namespace="$(cogni_deployment_slug)-${DEPLOY_ENVIRONMENT}"
  [[ "$namespace" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "catalog deployment namespace invalid"
  response="$(printf '%s\n%s\n%s\n%s\n' "$(printf '%s' "$token" | base64 | tr -d '\n')" "$(printf '%s' "$request" | base64 | tr -d '\n')" "$namespace" "$path" | remote 'set -eu
    umask 077
    work=$(mktemp -d)
    cleanup_cell_http() { rm -rf "$work"; }
    trap cleanup_cell_http EXIT
    IFS= read -r token_line
    IFS= read -r request_line
    IFS= read -r namespace
    IFS= read -r path
    printf "%s" "$token_line" | base64 -d > "$work/token"
    printf "%s" "$request_line" | base64 -d > "$work/body"
    printf "header = \"Authorization: Bearer %s\"\n" "$(cat "$work/token")" > "$work/curl"
    address=$(kubectl -n "$namespace" get service akash-tx-actuator -o jsonpath="{.spec.clusterIP}")
    [ -n "$address" ]
    curl -fsS --connect-timeout 5 --max-time 45 --config "$work/curl" -H "Content-Type: application/json" --data-binary @"$work/body" "http://$address:8080$path"')" || fail "private cell capability request failed"
  printf '%s' "$response"
}

materialize_database_cell_endpoint() {
  [[ "$TARGET_NODE" == "$RELIABILITY_CONTROLLER" && "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || fail "cell sealing is restricted to its local production owner"
  local node catalog cell_bank kit identity discovery host reference old_chain chain authority_ca authority_key server_key published update_response sealed receipt projection backup_encryption expected_certificate attempt
  prefetch_path akash-tx-actuator
  for node in "${NODE_TARGETS[@]}"; do
    catalog="${CATALOG_DIR}/${node}.yaml"
    [[ "$(yq -r '.database.production.tier // ""' "$catalog")" == dedicated ]] || continue
    [[ "$(lane_db_vm_env "$node" production)" == production ]] || continue
    cell_bank="${node}-database-cell"
    prefetch_path "$cell_bank"
    kit="$(bao_get_field "$cell_bank" DATABASE_CELL_BOOTSTRAP_KIT_JSON)"
    [[ -n "$kit" ]] || fail "canonical private bootstrap kit missing"
    if [[ "${SECRET_MATERIALIZE_PHASE}" == database-cell-cutover && "${DATABASE_CELL_CUTOVER_NODE_ID:-}" != "$(jq -r .nodeId <<<"$kit")" ]]; then continue; fi
    identity="$(jq '{nodeId,allocationEnvironment:.environment}' <<<"$kit")"
    discovery="$(cell_actor_http /v1/akash/database-cell-binding/discover "$identity")"
    reference="$(jq -c .reference <<<"$discovery")"
    # Endpoint selected from the current owned lease, never from an env or caller.
    host="$(jq -r '.endpoints[] | select(startswith("tcp://"))' <<<"$discovery" | pnpm --dir "$REPO_ROOT" exec tsx -e 'import {isIP} from "node:net"; import{readFileSync}from"node:fs"; const values=[...new Set(readFileSync(0,"utf8").trim().split("\n"))]; if(values.length!==1)process.exit(1); const u=new URL(values[0]); if(isIP(u.hostname)||! /^[a-z0-9][a-z0-9.-]+$/.test(u.hostname)||!u.port||u.username||u.password||u.search||u.hash)process.exit(1); process.stdout.write(u.hostname);')" || fail "cell requires exactly one actual measured DNS TCP endpoint"
    authority_ca="${CACHE_DIR}/cell-ca.pem" authority_key="${CACHE_DIR}/cell-ca-key.pem" server_key="${CACHE_DIR}/cell-server-key.pem" old_chain="${CACHE_DIR}/cell-old-chain.pem" chain="${CACHE_DIR}/cell-new-chain.pem"
    printf '%s' "$(bao_get_field "$cell_bank" DATABASE_CELL_TLS_CA_CERTIFICATE)" > "$authority_ca"
    printf '%s' "$(bao_get_field "$cell_bank" DATABASE_CELL_TLS_CA_PRIVATE_KEY)" > "$authority_key"
    jq -r .tlsPrivateKey <<<"$kit" > "$server_key"
    jq -r .tlsCertificate <<<"$kit" > "$old_chain"
    if openssl verify -purpose sslserver -verify_hostname "$host" -CAfile "$authority_ca" "$old_chain" >/dev/null 2>&1 && openssl x509 -in "$old_chain" -checkend 86400 -noout >/dev/null && [[ "$(openssl x509 -in "$old_chain" -pubkey -noout)" == "$(openssl pkey -in "$server_key" -pubout 2>/dev/null)" ]]; then
      cp "$old_chain" "$chain"
    else
      bash "$REPO_ROOT/scripts/ci/database-cell-tls-leaf.sh" "$authority_ca" "$authority_key" "$server_key" "$host" "$chain"
      kit="$(jq --rawfile certificate "$chain" '.tlsCertificate=$certificate' <<<"$kit")"
      cell_seed_exact "$cell_bank" DATABASE_CELL_BOOTSTRAP_KIT_JSON "$(jq -c . <<<"$kit")"
      flush_batch "$cell_bank"
      published="$(bao_get_field akash-tx-actuator AKASH_DATABASE_CELL_KITS_JSON)"
      published="$(jq --argjson kit "$kit" 'map(if .nodeId==$kit.nodeId and .environment==$kit.environment then $kit else . end)' <<<"$published")"
      cell_seed_exact akash-tx-actuator AKASH_DATABASE_CELL_KITS_JSON "$(jq -c . <<<"$published")"
      flush_batch akash-tx-actuator
    fi
    # Wait for the existing mounted hot factory to acknowledge these exact bytes.
    # ESO Ready alone can describe a previous version of this same Secret.
    expected_certificate="$(printf '%s' "$kit" | pnpm --dir "$REPO_ROOT" exec tsx -e 'import{createHash}from"node:crypto";import{readFileSync}from"node:fs";process.stdout.write(createHash("sha256").update(JSON.parse(readFileSync(0,"utf8")).tlsCertificate).digest("hex"));')"
    for attempt in {1..12}; do
      discovery="$(cell_actor_http /v1/akash/database-cell-binding/discover "$identity")"
      [[ "$(jq -r .kitCertificateSha256 <<<"$discovery")" != "$expected_certificate" ]] || break
      [[ "$attempt" != 12 ]] || fail "private hot kit did not converge to sealed TLS bytes"
      sleep 5
    done
    # Existing hot factory reads the private mounted kit on every same-lease UPDATE.
    update_response="$(cell_actor_http /v1/akash/update-database-cell "$(jq --argjson kit "$kit" '{cogniKey:.reference.cogniKey,externalName,identity,nodeSlug:$kit.nodeSlug,environment:$kit.environment,budgetProfile:($kit.logicalDatabases[]|select(.environment=="production")|.budgetProfile)}' <<<"$discovery")")"
    # Native boot/reprovision and a concurrent bounded private probe may lag the
    # same-lease UPDATE. Every failed observation denies publication.
    sealed=""
    for attempt in {1..12}; do
      if sealed="$(cell_actor_http /v1/akash/database-cell-binding/seal "$reference")"; then break; fi
      [[ "$attempt" != 12 ]] || fail "native cell sealing did not converge within its bound"
      sleep 5
    done
    if [[ "${SECRET_MATERIALIZE_PHASE}" == database-cell-cutover ]]; then
      [[ "${DATABASE_CELL_CUTOVER_NODE_ID:-}" == "$(jq -r .nodeId <<<"$kit")" ]] || fail "cutover packet target differs from selected catalog node"
      sealed="$(cell_actor_http /v1/akash/database-cell-binding/cutover "$(jq --arg packetSha256 "${DATABASE_CELL_CUTOVER_PACKET_SHA256:-}" --arg actorId "${DATABASE_CELL_CUTOVER_ACTOR_ID:-}" '.+{packetSha256:$packetSha256,actorId:$actorId}' <<<"$reference")")"
    fi
    receipt="$(jq -ec '.receipts[]|select(.binding.environment=="production")' <<<"$sealed")" || fail "production native cell receipt absent"
    cell_seed_exact "$cell_bank" DATABASE_CELL_PLACEMENT_RECEIPT_JSON "$receipt"
    flush_batch "$cell_bank"
    prefetch_path "${node}-database-backup"
    backup_encryption="$(bao_get_field "${node}-database-backup" DATABASE_CELL_BACKUP_ENCRYPTION_KEY)"
    projection="$(jq -n --argjson receipt "$receipt" --argjson kit "$kit" --arg backupEncryptionKey "$backup_encryption" '{receipt:$receipt,kit:$kit,backupEncryptionKey:$backupEncryptionKey}' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts")" || fail "sealed cell private projection invalid"
    publish_database_cell_projection "$node" "$projection"
  done
}

publish_database_cell_projection() {
  local node="$1" projection="$2" service key field prior entry merged
  while IFS=$'\t' read -r service key field; do
    prefetch_path "$service"
    prior="$(bao_get_field "$service" "$key")"
    entry="$(jq -c --arg field "$field" '.[$field]' <<<"$projection")"
    merged="$(jq -nc --argjson prior "${prior:-[]}" --argjson entry "$entry" '$prior|map(select(.nodeId!=$entry.nodeId or .environment!=$entry.environment))+[$entry]|sort_by(.nodeId,.environment)')"
    cell_seed_exact "$service" "$key" "$merged"
  done <<'PROJECTIONS'
database-reliability-actuator	DATABASE_RECOVERY_CELL_PROBE_URLS_JSON	probe
database-reliability-actuator	DATABASE_RELIABILITY_CELL_ADMIN_URLS_JSON	admin
database-reliability-readmitter	DATABASE_RELIABILITY_CELL_READMIT_URLS_JSON	readmit
PROJECTIONS
  flush_batch database-reliability-actuator
  flush_batch database-reliability-readmitter
  cell_seed_exact "${node}-database-backup" DATABASE_CELL_BACKUP_KITS_JSON "$(jq -c '[.backup]' <<<"$projection")"
  flush_batch "${node}-database-backup"
  # Approved receipt is the durable publication point. Each consumer bank resumes
  # from that same bundle after a crash; no phase recomposes a dedicated DSN shared.
  if [[ "$(jq -r '.publicValues != null' <<<"$projection")" == true ]]; then
    prefetch_path "$node"
    for key in DATABASE_URL DATABASE_SERVICE_URL DATABASE_SSL_CA_CERT; do
      cell_seed_exact "$node" "$key" "$(jq -r --arg key "$key" '.publicValues[$key]' <<<"$projection")"
    done
    prefetch_path "${node}-database-migration"
    for key in DATABASE_MIGRATION_URL DATABASE_SSL_CA_CERT; do
      cell_seed_exact "${node}-database-migration" "$key" "$(jq -r --arg key "$key" '.publicValues[$key]' <<<"$projection")"
    done
    flush_batch "${node}-database-migration"
    flush_batch "$node"
  fi
}
