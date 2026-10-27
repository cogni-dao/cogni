#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Sole-writer cell placement phase. All routing derives from an applied receipt.

source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
CELL_PLACEMENT_JSON=''
load_database_cell_placement() {
  CELL_PLACEMENT_JSON=''
  local placement require_applied=false
  placement="$(yq -r ".database.\"${DEPLOY_ENVIRONMENT}\".placement // \"\"" "${CATALOG_DIR}/${TARGET_NODE}.yaml")"
  if [[ "$placement" == akash-cell ]]; then
    require_applied=true
    [[ "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || fail "declared cell placement requires its production custody owner"
  fi
  [[ "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || return 0
  local cell_bank="${TARGET_NODE}-database-cell" receipt kit encryption
  prefetch_path "$cell_bank"
  receipt="$(bao_get_field "$cell_bank" DATABASE_CELL_PLACEMENT_RECEIPT_JSON)"
  if [[ -z "$receipt" ]]; then
    [[ "$require_applied" == false ]] || fail "declared cell placement has no applied allocation receipt"
    return 0
  fi
  [[ "$(jq -r .binding.nodeSlug <<<"$receipt")" == "$TARGET_NODE" && "$(jq -r .binding.nodeId <<<"$receipt")" == "$(node_id_for_target "$TARGET_NODE")" && "$(jq -r .allocationEnvironment <<<"$receipt")" == "$SECRETS_CONTROL_ENV" && "$(jq -r .binding.environment <<<"$receipt")" == "$DEPLOY_ENVIRONMENT" ]] || fail "cell placement does not own this target lane"
  if [[ "$(jq -r '.registration.kind // ""' <<<"$receipt")" == audited-manual ]]; then
    kit="$(bao_get_field "$cell_bank" DATABASE_CELL_APPLIED_CUSTODY_JSON)"
    [[ -n "$kit" ]] || fail "audited manual cell current consumer custody missing"
    validate_applied_cell_consumer_custody "$TARGET_NODE" "$kit"
    local catalog_pools custody_pools
    catalog_pools="$(yq -o=json ".database.\"${DEPLOY_ENVIRONMENT}\".runtimePoolLimits // null" "${CATALOG_DIR}/${TARGET_NODE}.yaml" | jq -Sc .)" || fail "catalog runtime pool policy invalid"
    custody_pools="$(jq -Sc '.runtimePoolLimits // null' <<<"$kit")" || fail "applied runtime pool custody invalid"
    [[ "$catalog_pools" == "$custody_pools" ]] || fail "public runtime pool policy differs from audited applied custody"
    CELL_PLACEMENT_JSON="$(project_applied_database_cell "$TARGET_NODE" "$receipt" "$kit" "$require_applied")" || fail "audited manual consumer custody invalid"
    return 0
  fi
  kit="$(bao_get_field "$cell_bank" DATABASE_CELL_BOOTSTRAP_KIT_JSON)"
  prefetch_path "${TARGET_NODE}-database-backup"
  encryption="$(bao_get_field "${TARGET_NODE}-database-backup" DATABASE_CELL_BACKUP_ENCRYPTION_KEY)"
  CELL_PLACEMENT_JSON="$(jq -n --argjson receipt "$receipt" --argjson kit "$kit" --arg backupEncryptionKey "$encryption" --argjson requireApplied "$require_applied" '{receipt:$receipt,kit:$kit,backupEncryptionKey:$backupEncryptionKey,requireApplied:$requireApplied}' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts")" || fail "audited cell placement or scoped custody invalid"
}

# Private component DSNs travel through protected files/stdin, never worker kits
# or readonly observer custody. The original owned consumer values are unchanged.
project_applied_database_cell() {
  local node="$1" receipt="$2" custody="$3" required="${4:-false}" bundle='null' material='null'
  if [[ "$(jq -r '.binding.nativeControl != null' <<<"$receipt")" == true ]]; then
    local bank
    bank="${node}-database-cell-actuator"; prefetch_path "$bank"
    printf '%s' "$(bao_get_field "$bank" DATABASE_CELL_ACTUATOR_URL)" > "${CACHE_DIR}/cell-actuator-dsn"
    bank="${node}-database-cell-readmitter"; prefetch_path "$bank"
    printf '%s' "$(bao_get_field "$bank" DATABASE_CELL_READMIT_URL)" > "${CACHE_DIR}/cell-readmit-dsn"
    material="$(jq -n --rawfile actuatorDsn "${CACHE_DIR}/cell-actuator-dsn" --rawfile readmitDsn "${CACHE_DIR}/cell-readmit-dsn" '{actuatorDsn:$actuatorDsn,readmitDsn:$readmitDsn}')"
    bundle="$(bao_get_field "${node}-database-cell" DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON)"
    [[ -n "$bundle" ]] || fail "actual installed native control evidence bytes missing"
  fi
  printf '%s' "$receipt" > "${CACHE_DIR}/cell-projection-receipt"
  printf '%s' "$custody" > "${CACHE_DIR}/cell-projection-custody"
  printf '%s' "$material" > "${CACHE_DIR}/cell-projection-material"
  printf '%s' "$bundle" > "${CACHE_DIR}/cell-projection-evidence"
  jq -n --slurpfile receipt "${CACHE_DIR}/cell-projection-receipt" --slurpfile custody "${CACHE_DIR}/cell-projection-custody" --argjson requireApplied "$required" --slurpfile material "${CACHE_DIR}/cell-projection-material" --slurpfile bundle "${CACHE_DIR}/cell-projection-evidence" '{receipt:$receipt[0],custody:$custody[0],requireApplied:$requireApplied} + (if $material[0]==null then {} else {controlMaterial:$material[0],evidenceBundle:$bundle[0]} end)' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts"
}

cell_placement_composed_value() {
  local node="$1" key="$2"
  [[ "$node" == "$TARGET_NODE" && -n "$CELL_PLACEMENT_JSON" ]] || return 1
  # System trust deliberately owns an absent custom-CA value. Return success with
  # empty stdout so the shared substrate CA composer cannot supply another value.
  if [[ "$key" == DATABASE_SSL_CA_CERT ]]; then
    jq -r '.publicValues.DATABASE_SSL_CA_CERT // empty' <<<"$CELL_PLACEMENT_JSON"
    return 0
  fi
  if [[ "$key" == DATABASE_RECOVERY_PROBE_URL ]]; then
    jq -er '.logicalProbeDsn // empty' <<<"$CELL_PLACEMENT_JSON" 2>/dev/null
    return $?
  fi
  jq -er --arg key "$key" '.publicValues[$key] // empty' <<<"$CELL_PLACEMENT_JSON" 2>/dev/null
}

# Values must already exist in their real private consumer banks. This helper
# never creates credentials or converts request data into secret custody.
validate_applied_cell_consumer_custody() {
  validate_applied_cell_consumer_banks "$1" "$2" 'app service migration tls readOnlyProbe'
}
# The explicit probe-repair phase validates its canonical password and native proof separately.
validate_applied_cell_consumer_banks() {
  local node="$1" custody="$2" fields="$3" field service key value
  [[ "$(jq -r .nodeSlug <<<"$custody")" == "$node" && "$(jq -r .nodeId <<<"$custody")" == "$(node_id_for_target "$node")" && "$(jq -r .environment <<<"$custody")" == production ]] || fail "manual applied custody differs from owned target"
  for field in $fields; do
    service="$(jq -r --arg field "$field" '.[$field].custody.service // .[$field].custodyRef.service // empty' <<<"$custody")"
    [[ -n "$service" ]] || continue
    key="$(jq -r --arg field "$field" '.[$field].custody.key // .[$field].custodyRef.key' <<<"$custody")"
    case "$service/$key" in
      "$node/DATABASE_URL"|"$node/DATABASE_SERVICE_URL"|"$node/DATABASE_SSL_CA_CERT"|"${node}-database-migration/DATABASE_MIGRATION_URL"|"${node}-database-recovery-probe/DATABASE_RECOVERY_PROBE_URL") ;;
      *) fail "manual applied custody reference leaves owned consumer banks" ;;
    esac
    prefetch_path "$service"
    value="$(jq -r --arg field "$field" '.[$field].dsn // .[$field].caCertificate' <<<"$custody")"
    [[ "$(bao_get_field "$service" "$key")" == "$value" ]] || fail "manual applied consumer value differs from current secret custody"
  done
  if [[ "$(jq -r '.nativeControl != null' <<<"$custody")" == true ]]; then
    local role expected actual
    for role in probe actuator readmitter; do
      service="$(jq -r --arg role "$role" '.nativeControl.provenance.custody[$role].service' <<<"$custody")"
      key="$(jq -r --arg role "$role" '.nativeControl.provenance.custody[$role].key' <<<"$custody")"
      case "$role/$service/$key" in
        "probe/${node}-database-recovery-probe/DATABASE_CELL_CONTROL_PROBE_URL"|"actuator/${node}-database-cell-actuator/DATABASE_CELL_ACTUATOR_URL"|"readmitter/${node}-database-cell-readmitter/DATABASE_CELL_READMIT_URL") ;;
        *) fail "native control reference leaves scoped canonical banks" ;;
      esac
      prefetch_path "$service"
      expected="$(jq -r --arg role "$role" '.nativeControl.provenance.custody[$role].dsnSha256' <<<"$custody")"
      actual="$(printf '%s' "$(bao_get_field "$service" "$key")" | openssl dgst -sha256 | awk '{print $NF}')"
      [[ "$actual" == "$expected" ]] || fail "native control reference differs from current canonical custody"
      if [[ "$role" == probe ]]; then
        [[ "$(bao_get_field "$service" "$key")" == "$(jq -r .nativeControl.probe.dsn <<<"$custody")" ]] || fail "readonly control probe differs from canonical custody"
      fi
    done
  fi
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
    # Imported admitted cells are never resealed, rekeyed or provider-updated by
    # the factory phase. Their target loader validates the applied consumer path.
    if [[ "$(bao_get_field "$cell_bank" DATABASE_CELL_PLACEMENT_RECEIPT_JSON | jq -r '.registration.kind // ""' 2>/dev/null)" == audited-manual ]]; then continue; fi
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
  local retire legacy=''
  retire="$(jq -c '.retireSourceBinding // null' <<<"$projection")"
  if [[ "$retire" != null ]]; then
    [[ "$(jq -r .nodeId <<<"$retire")" == "$(node_id_for_target "$node")" && "$(jq -r .environment <<<"$retire")" == production && "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || fail "source binding retirement leaves exact owned production scope"
    prefetch_path database-reliability-actuator
    prior="$(bao_get_field database-reliability-actuator DATABASE_RECOVERY_PROBE_URLS_JSON)"
    legacy="$(jq -nc --argjson prior "${prior:-[]}" --argjson retire "$retire" '
      if ($prior|type)!="array" then error("legacy bindings are not an array")
      elif ([$prior[] | select(.nodeId==$retire.nodeId and .environment==$retire.environment)] | length)>1 then error("ambiguous owned source bindings") else
      $prior | map(if .nodeId==$retire.nodeId and .environment==$retire.environment then
        if .systemIdentifier==$retire.systemIdentifier then empty else error("unexpected owned source binding identity") end
      else . end) end')" || fail "legacy source binding identity differs from authenticated manual packet"
  fi
  while IFS=$'\t' read -r service key field; do
    prefetch_path "$service"
    prior="$(bao_get_field "$service" "$key")"
    entry="$(jq -c --arg field "$field" '.[$field]' <<<"$projection")"
    [[ "$entry" != null ]] || continue
    merged="$(jq -nc --argjson prior "${prior:-[]}" --argjson entry "$entry" '$prior|map(select(.nodeId!=$entry.nodeId or .environment!=$entry.environment))+[$entry]|sort_by(.nodeId,.environment)')"
    cell_seed_exact "$service" "$key" "$merged"
  done <<'PROJECTIONS'
database-reliability-actuator	DATABASE_RECOVERY_CELL_PROBE_URLS_JSON	probe
database-reliability-actuator	DATABASE_RELIABILITY_CELL_ADMIN_URLS_JSON	admin
database-reliability-readmitter	DATABASE_RELIABILITY_CELL_READMIT_URLS_JSON	readmit
PROJECTIONS
  if [[ "$retire" != null && -n "$legacy" ]]; then
    cell_seed_exact database-reliability-actuator DATABASE_RECOVERY_PROBE_URLS_JSON "$legacy"
  fi
  flush_batch database-reliability-actuator
  flush_batch database-reliability-readmitter
  if [[ "$(jq -r '.backup != null' <<<"$projection")" == true ]]; then
    cell_seed_exact "${node}-database-backup" DATABASE_CELL_BACKUP_KITS_JSON "$(jq -c '[.backup]' <<<"$projection")"
    flush_batch "${node}-database-backup"
  fi
  # Approved receipt is the durable publication point. Each consumer bank resumes
  # from that same bundle after a crash; no phase recomposes a dedicated DSN shared.
  if [[ "$(jq -r '.publicValues != null' <<<"$projection")" == true ]]; then
    prefetch_path "$node"
    for key in DATABASE_URL DATABASE_SERVICE_URL DATABASE_SSL_CA_CERT; do
      jq -e --arg key "$key" '.publicValues | has($key)' <<<"$projection" >/dev/null || continue
      cell_seed_exact "$node" "$key" "$(jq -r --arg key "$key" '.publicValues[$key]' <<<"$projection")"
    done
    prefetch_path "${node}-database-migration"
    for key in DATABASE_MIGRATION_URL DATABASE_SSL_CA_CERT; do
      jq -e --arg key "$key" '.publicValues | has($key)' <<<"$projection" >/dev/null || continue
      cell_seed_exact "${node}-database-migration" "$key" "$(jq -r --arg key "$key" '.publicValues[$key]' <<<"$projection")"
    done
    flush_batch "${node}-database-migration"
    flush_batch "$node"
  fi
}

# Explicit canonical writer phase. Produces private components only; never installs
# roles/DDL, republishes consumers, or activates a catalog marker.
materialize_database_cell_control_components() {
  [[ "$TARGET_NODE" == "$RELIABILITY_CONTROLLER" && "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || fail "cell control components require the local production owner"
  [[ "${DATABASE_CELL_CONTROL_NODE_ID:-}" =~ ^[0-9a-f-]{36}$ ]] || fail "one explicit cell control node identity required"
  local node selected='' receipt custody bank password plan service key value
  for node in "${NODE_TARGETS[@]}"; do
    [[ "$(node_id_for_target "$node")" == "$DATABASE_CELL_CONTROL_NODE_ID" ]] || continue
    [[ -z "$selected" ]] || fail "ambiguous cell control node identity"
    selected="$node"
  done
  [[ -n "$selected" ]] || fail "cell control node is not catalog-owned"
  node="$selected" bank="${selected}-database-cell"
  prefetch_path "$bank"
  receipt="$(bao_get_field "$bank" DATABASE_CELL_PLACEMENT_RECEIPT_JSON)"
  custody="$(bao_get_field "$bank" DATABASE_CELL_APPLIED_CUSTODY_JSON)"
  [[ -n "$receipt" && -n "$custody" ]] || fail "audited applied cell receipt and current custody required"
  validate_applied_cell_consumer_custody "$node" "$custody"
  local actuator_password readmit_password
  for service in actuator readmitter; do
    bank="${node}-database-cell-${service}"
    prefetch_path "$bank"
    key=DATABASE_CELL_ACTUATOR_PASSWORD
    [[ "$service" != readmitter ]] || key=DATABASE_CELL_READMIT_PASSWORD
    password="$(bao_get_field "$bank" "$key")"
    if [[ -z "$password" ]]; then
      key_is_agent_generated "$key" && [[ "$(_cat_field "$key" '.generate.kind')" == hex && "$(_cat_field "$key" '.generate.bytes')" == 32 ]] || fail "scoped control catalog generator differs from reviewed contract"
      password="$(randHex 32)"
    fi
    [[ "$password" =~ ^[0-9a-f]{64}$ ]] || fail "scoped control password generation invalid"
    if [[ "$service" == actuator ]]; then actuator_password="$password"; else readmit_password="$password"; fi
  done
  printf '%s' "$actuator_password" > "${CACHE_DIR}/cell-actuator-password"
  printf '%s' "$readmit_password" > "${CACHE_DIR}/cell-readmit-password"
  printf '%s' "$receipt" > "${CACHE_DIR}/cell-component-receipt"
  printf '%s' "$custody" > "${CACHE_DIR}/cell-component-custody"
  plan="$(jq -n --slurpfile receipt "${CACHE_DIR}/cell-component-receipt" --slurpfile custody "${CACHE_DIR}/cell-component-custody" --rawfile actuatorPassword "${CACHE_DIR}/cell-actuator-password" --rawfile readmitPassword "${CACHE_DIR}/cell-readmit-password" '{receipt:$receipt[0],custody:$custody[0],actuatorPassword:$actuatorPassword,readmitPassword:$readmitPassword}' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts" --control-components)" || fail "scoped control component plan refused"
  while IFS= read -r value; do
    service="$(jq -r .service <<<"$value")" key="$(jq -r .key <<<"$value")"
    prefetch_path "$service"
    # Existing material must match, including URL byte identity. A partial retry
    # may fill absent fields, never replace an installed private capability.
    password="$(bao_get_field "$service" "$key")"
    [[ -z "$password" || "$password" == "$(jq -r .value <<<"$value")" ]] || fail "existing scoped control component differs"
  done < <(jq -c '.components[]' <<<"$plan")
  while IFS= read -r value; do
    service="$(jq -r .service <<<"$value")" key="$(jq -r .key <<<"$value")"
    cell_seed_exact "$service" "$key" "$(jq -r .value <<<"$value")"
  done < <(jq -c '.components[]' <<<"$plan")
  flush_batch "${node}-database-recovery-probe"
  flush_batch "${node}-database-cell-actuator"
  flush_batch "${node}-database-cell-readmitter"
}

# Reference-only audited import through the existing private binder. The actor
# authenticates mounted immutable bytes and current native/provider observations.
materialize_database_cell_applied_registration() {
  [[ "$TARGET_NODE" == "$RELIABILITY_CONTROLLER" && "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || fail "manual registration requires the local production owner"
  [[ "${DATABASE_CELL_CONTROL_NODE_ID:-}" =~ ^[0-9a-f-]{36}$ && "${DATABASE_CELL_REGISTER_PACKET_SHA256:-}" =~ ^[0-9a-f]{64}$ && ( "${DATABASE_CELL_REGISTER_READMISSION_SHA256:-}" =~ ^[0-9a-f]{64}$ || ( "${DATABASE_CELL_REGISTER_KIND:-}" == legacy-physical && -z "${DATABASE_CELL_REGISTER_READMISSION_SHA256:-}" ) ) && -n "${DATABASE_CELL_REGISTER_COGNI_KEY:-}" ]] || fail "audited manual registration requires explicit owned references"
  local node selected='' bank custody response receipt projection request
  for node in "${NODE_TARGETS[@]}"; do
    [[ "$(node_id_for_target "$node")" == "$DATABASE_CELL_CONTROL_NODE_ID" ]] || continue
    [[ -z "$selected" ]] || fail "ambiguous manual registration node"
    selected="$node"
  done
  [[ -n "$selected" ]] || fail "manual registration node is not catalog-owned"
  node="$selected" bank="${selected}-database-cell"
  prefetch_path "$bank"
  prefetch_path akash-tx-actuator
  custody="$(bao_get_field "$bank" DATABASE_CELL_APPLIED_CUSTODY_JSON)"
  [[ -n "$custody" ]] || fail "actual applied consumer custody absent"
  validate_applied_cell_consumer_custody "$node" "$custody"
  materialize_database_cell_applied_custodies "$node"
  request="$(jq -nc --arg cogniKey "$DATABASE_CELL_REGISTER_COGNI_KEY" --arg nodeId "$DATABASE_CELL_CONTROL_NODE_ID" --arg packet "$DATABASE_CELL_REGISTER_PACKET_SHA256" --arg readmission "${DATABASE_CELL_REGISTER_READMISSION_SHA256:-}" '{cogniKey:$cogniKey,nodeId:$nodeId,allocationEnvironment:"production",manualCutoverPacketSha256:$packet} + (if $readmission=="" then {registrationKind:"legacy-physical"} else {readmissionReceiptId:$readmission} end)')"
  response="$(cell_actor_http /v1/akash/database-cell-binding/register-applied "$request")"
  receipt="$(jq -ec '.receipts[] | select(.binding.environment=="production" and .registration.kind=="audited-manual")' <<<"$response")" || fail "actual applied registration receipt absent"
  # Validate every private target and real qualification before any publication.
  projection="$(project_applied_database_cell "$node" "$receipt" "$custody" false)" || fail "actual registered private projection refused"
  [[ "$(jq -r .binding.nodeId <<<"$receipt")" == "$DATABASE_CELL_CONTROL_NODE_ID" && "$(jq -r .binding.cogniKey <<<"$receipt")" == "$DATABASE_CELL_REGISTER_COGNI_KEY" ]] || fail "registered binding left the owned reference"
  cell_seed_exact "$bank" DATABASE_CELL_PLACEMENT_RECEIPT_JSON "$receipt"
  flush_batch "$bank"
  publish_database_cell_projection "$node" "$projection"
}

# Initial target probe alignment / post-rotation URL repair. This phase never rotates
# a password, saves a binding, installs control, or retires any source aggregate.
materialize_database_cell_probe_custody() {
  [[ "$TARGET_NODE" == "$RELIABILITY_CONTROLLER" && "$DEPLOY_ENVIRONMENT" == production && "$SECRETS_CONTROL_ENV" == production ]] || fail "probe custody requires local production owner"
  [[ "${DATABASE_CELL_CONTROL_NODE_ID:-}" =~ ^[0-9a-f-]{36}$ && "${DATABASE_CELL_REGISTER_PACKET_SHA256:-}" =~ ^[0-9a-f]{64}$ && ( "${DATABASE_CELL_REGISTER_READMISSION_SHA256:-}" =~ ^[0-9a-f]{64}$ || ( "${DATABASE_CELL_REGISTER_KIND:-}" == legacy-physical && -z "${DATABASE_CELL_REGISTER_READMISSION_SHA256:-}" ) ) && -n "${DATABASE_CELL_REGISTER_COGNI_KEY:-}" ]] || fail "probe custody requires exact immutable owned references"
  local node selected='' bank custody bundle raw version old_url password request response qualification current current_version next
  for node in "${NODE_TARGETS[@]}"; do
    [[ "$(node_id_for_target "$node")" == "$DATABASE_CELL_CONTROL_NODE_ID" ]] || continue
    [[ -z "$selected" ]] || fail "ambiguous probe custody node"
    selected="$node"
  done
  [[ -n "$selected" ]] || fail "probe custody node not owned"
  node="$selected" bank="${selected}-database-recovery-probe"
  prefetch_path "${node}-database-cell"
  custody="$(bao_get_field "${node}-database-cell" DATABASE_CELL_APPLIED_CUSTODY_JSON)"
  bundle="$(bao_get_field "${node}-database-cell" DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON)"
  [[ -n "$custody" && -n "$bundle" ]] || fail "actual target probe custody and evidence missing"
  raw="$(bao_exec "" "kv get -format=json 'cogni/production/${bank}'")" || fail "current canonical probe component unavailable"
  version="$(jq -er '.data.metadata.version | select(type=="number" and .>0)' <<<"$raw")" || fail "current probe KV version absent"
  password="$(jq -er '.data.data.DATABASE_RECOVERY_PROBE_PASSWORD | select(type=="string" and length>0)' <<<"$raw")" || fail "canonical probe password absent"
  old_url="$(jq -r '.data.data.DATABASE_RECOVERY_PROBE_URL // ""' <<<"$raw")"
  printf '%s' "$custody" > "${CACHE_DIR}/probe-repair-custody"
  printf '%s' "$password" > "${CACHE_DIR}/probe-repair-password"
  custody="$(jq -n --slurpfile custody "${CACHE_DIR}/probe-repair-custody" --rawfile password "${CACHE_DIR}/probe-repair-password" '{custody:$custody[0],password:$password}' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts" --validate-probe-custody)" || fail "target probe canonical password mismatch"
  validate_applied_cell_consumer_banks "$node" "$custody" 'app service migration tls'
  # Only this owned phase tolerates the old logical probe URL, before readonly qualification.
  materialize_database_cell_applied_custodies "$node" probe-repair
  request="$(jq -nc --arg cogniKey "$DATABASE_CELL_REGISTER_COGNI_KEY" --arg nodeId "$DATABASE_CELL_CONTROL_NODE_ID" --arg packet "$DATABASE_CELL_REGISTER_PACKET_SHA256" --arg readmission "${DATABASE_CELL_REGISTER_READMISSION_SHA256:-}" '{cogniKey:$cogniKey,nodeId:$nodeId,allocationEnvironment:"production",manualCutoverPacketSha256:$packet} + (if $readmission=="" then {registrationKind:"legacy-physical"} else {readmissionReceiptId:$readmission} end)')"
  response="$(cell_actor_http /v1/akash/database-cell-binding/qualify-applied-probe "$request")" || fail "actual target probe qualification unavailable"
  printf '%s' "$bundle" > "${CACHE_DIR}/probe-repair-evidence"
  printf '%s' "$response" > "${CACHE_DIR}/probe-repair-response"
  printf '%s' "$request" > "${CACHE_DIR}/probe-repair-reference"
  qualification="$(jq -n --slurpfile custody "${CACHE_DIR}/probe-repair-custody" --slurpfile bundle "${CACHE_DIR}/probe-repair-evidence" --slurpfile response "${CACHE_DIR}/probe-repair-response" --slurpfile reference "${CACHE_DIR}/probe-repair-reference" '{custody:$custody[0],bundle:$bundle[0],qualification:$response[0].qualification,reference:($reference[0]|del(.allocationEnvironment))}' | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts" --validate-probe-qualification)" || fail "target probe proof differs from immutable owned references"
  # Reread, compare, then CAS the exact bank version; a concurrent rotation must win.
  current="$(bao_exec "" "kv get -format=json 'cogni/production/${bank}'")" || fail "probe component recheck unavailable"
  current_version="$(jq -er '.data.metadata.version' <<<"$current")" || fail "probe KV recheck invalid"
  [[ "$current_version" == "$version" && "$(jq -r .data.data.DATABASE_RECOVERY_PROBE_PASSWORD <<<"$current")" == "$password" && "$(jq -r '.data.data.DATABASE_RECOVERY_PROBE_URL // ""' <<<"$current")" == "$old_url" ]] || fail "probe component changed during qualification"
  next="$(jq -r .readOnlyProbe.dsn <<<"$custody")"
  if [[ "$next" != "$old_url" ]]; then
    printf '%s' "$next" > "${CACHE_DIR}/probe-repair-url"
    jq -n --rawfile url "${CACHE_DIR}/probe-repair-url" '{DATABASE_RECOVERY_PROBE_URL:$url}' | bao_exec -i "kv patch -method=patch -cas=${version} 'cogni/production/${bank}' -" >/dev/null || fail "probe URL CAS refused raced component"
  fi
  # Only credential-free evidence is logged; no body, password or DSN is emitted.
  log "owned probe custody qualified sha=$(jq -r .qualificationSha256 <<<"$qualification") native=$(jq -r .systemIdentifier <<<"$qualification")"
}
