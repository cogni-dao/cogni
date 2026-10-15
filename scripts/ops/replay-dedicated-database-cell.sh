#!/usr/bin/env bash
# Candidate-only direct DB replay. Emits JSONL evidence and fails on any neighbor miss.
set -euo pipefail

: "${ALLOW_CANDIDATE_DATABASE_REPLAY:?must equal 1}"
: "${TARGET_CELL_DSN:?candidate dedicated-cell read-role DSN required}"
: "${TARGET_CELL_ADMIN_DSN:?candidate dedicated-cell reliability-control DSN required}"
: "${TARGET_CELL_READMIT_DSN:?separate human readmission DSN required}"
: "${SHARED_DB_DSN:?candidate shared Postgres DSN required}"
: "${NEIGHBOR_READYZ_URLS:?comma-separated regional readyz URLs required}"
: "${SHARED_IO_PSI_QUERY_URL:?Prometheus instant-query URL required}"
: "${INCIDENT_REQUEST_RATE:?measured incident requests/second required}"
: "${CELL_BACKUP_RECEIPT_FILE:?completed state-cell backup receipt required}"
: "${CELL_RESTORE_RECEIPT_FILE:?completed state-cell restore receipt required}"
: "${EXPECTED_BUILD_SHA:?flighted source SHA required}"
: "${TARGET_VERSION_URL:?live target /version URL required}"
: "${TARGET_NODE_SLUG:?catalog target node slug required}"
: "${REPLAY_SQL_FILE:?reviewed workload SQL file required}"
: "${CATALOG_ROOT:?immutable catalog directory required}"

[[ "$ALLOW_CANDIDATE_DATABASE_REPLAY" == 1 ]] || { echo "candidate replay not authorized" >&2; exit 2; }
[[ "${DEPLOY_ENVIRONMENT:-}" == candidate-a ]] || { echo "candidate-a only" >&2; exit 2; }
command -v pgbench >/dev/null && command -v psql >/dev/null && command -v jq >/dev/null
command -v yq >/dev/null

node_slug=$TARGET_NODE_SLUG
[[ "$node_slug" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || { echo "invalid node slug" >&2; exit 2; }
target_catalog="${CATALOG_ROOT}/${node_slug}.yaml"
[[ -f "$target_catalog" ]] || { echo "target catalog row missing" >&2; exit 2; }
[[ "$(yq -er '.name' "$target_catalog")" == "$node_slug" ]] \
  || { echo "target slug does not match catalog identity" >&2; exit 2; }
[[ "$(yq -er '.envs | contains(["candidate-a"])' "$target_catalog")" == true ]] \
  || { echo "target is not a candidate-a member" >&2; exit 2; }
[[ "$(yq -er '.database."candidate-a".tier' "$target_catalog")" == dedicated ]] \
  || { echo "target is not a dedicated database cell" >&2; exit 2; }
[[ "$(yq -er '.reliability_validation."candidate-a".role' "$target_catalog")" == dedicated-neighbor ]] \
  || { echo "target lacks dedicated-neighbor validation role" >&2; exit 2; }
target_node_id="$(yq -er '.node_id' "$target_catalog")"

live_build_sha=$(curl -fsS --max-time 10 "$TARGET_VERSION_URL" | jq -er '.buildSha')
[[ "$live_build_sha" == "$EXPECTED_BUILD_SHA" ]] || {
  echo "live target buildSha does not match expected flight SHA" >&2
  exit 1
}

replay_sql=$REPLAY_SQL_FILE
[[ -f "$replay_sql" && -r "$replay_sql" ]] || { echo "replay SQL file is not readable" >&2; exit 2; }
duration=${REPLAY_DURATION_SECONDS:-1800}
clients=${REPLAY_CLIENTS:-8}
rate=${REPLAY_RATE:-$((INCIDENT_REQUEST_RATE * 2))}
evidence=${REPLAY_EVIDENCE_FILE:-dedicated-database-cell-replay.jsonl}
role_suffix=${node_slug//-/_}
app_role="app_${role_suffix}"
service_role="service_${role_suffix}"
[[ "$clients" -ge 8 && "$duration" -ge 1800 && "$rate" -ge $((INCIDENT_REQUEST_RATE * 2)) ]] || {
  echo "requires >=8 clients, >=1800s, and >=2x incident rate" >&2; exit 2;
}

cell_addr=$(psql "$TARGET_CELL_DSN" -XAtqc "select inet_server_addr()::text")
shared_addr=$(psql "$SHARED_DB_DSN" -XAtqc "select inet_server_addr()::text")
[[ -n "$cell_addr" && -n "$shared_addr" && "$cell_addr" != "$shared_addr" ]] || {
  echo "dedicated and shared databases are not separate hosts" >&2; exit 2;
}

sha=$EXPECTED_BUILD_SHA
replay_id="database-cell-${node_slug}-${sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
jq -cn --arg event start --arg replayId "$replay_id" --arg sha "$sha" \
  --arg cell "$cell_addr" --arg shared "$shared_addr" --argjson clients "$clients" \
  --argjson rate "$rate" --arg versionUrl "$TARGET_VERSION_URL" \
  '{event:$event,replayId:$replayId,sha:$sha,versionUrl:$versionUrl,cell:$cell,shared:$shared,clients:$clients,rate:$rate}' >"$evidence"

# Accepted provider requests are not restore evidence. Require the lifecycle
# command's terminal receipts to bind the same cell/node/restore point and to
# reproduce the exact schema/count/checksum observed at backup time.
jq -en --arg expectedNodeId "$target_node_id" --slurpfile backup "$CELL_BACKUP_RECEIPT_FILE" \
  --slurpfile restore "$CELL_RESTORE_RECEIPT_FILE" '
  ($backup | length == 1) and ($restore | length == 1) and
  ($backup[0].action == "backup") and ($restore[0].action == "restore") and
  ($backup[0].cellId == $restore[0].cellId) and
  ($backup[0].nodeId == $restore[0].nodeId) and
  ($backup[0].nodeId == $expectedNodeId) and
  ($backup[0].restorePointId == $restore[0].restorePointId) and
  ($backup[0].providerActionId | length > 0) and
  ($restore[0].providerActionId | length > 0) and
  ($backup[0].completedAt | length > 0) and
  ($restore[0].completedAt | length > 0) and
  ($backup[0].verification == $restore[0].verification)
' >/dev/null || { echo "backup/restore receipt comparison failed" >&2; exit 1; }
jq -cn --arg event restore_receipts_verified --arg replayId "$replay_id" \
  '{event:$event,replayId:$replayId,result:"pass"}' >>"$evidence"

roles_contained=0
cleanup() {
  [[ -n "${load_pid:-}" ]] && kill "$load_pid" 2>/dev/null || true
  if [[ "$roles_contained" == 1 ]]; then
    jq -cn --arg event manual_recovery_required --arg replayId "$replay_id" \
      '{event:$event,replayId:$replayId,result:"failed",rolesRemainContained:true}' >>"$evidence"
    echo "replay failed with target roles contained; audited manual recovery required" >&2
  fi
}
trap cleanup EXIT INT TERM

role_count=$(psql "$TARGET_CELL_ADMIN_DSN" -XAtv ON_ERROR_STOP=1 \
  -v app_role="$app_role" -v service_role="$service_role" \
  -f - <<'SQL'
SELECT count(*) FROM pg_roles WHERE rolname IN (:'app_role', :'service_role');
SQL
)
[[ "$role_count" == 2 ]] || { echo "expected roles $app_role and $service_role" >&2; exit 1; }
jq -cn --arg event role_assertion --arg replayId "$replay_id" --arg appRole "$app_role" \
  --arg serviceRole "$service_role" '{event:$event,replayId:$replayId,appRole:$appRole,serviceRole:$serviceRole,result:"pass"}' >>"$evidence"

# This diagnostic credential cycle does not replace audited incident recovery.
roles_contained=1
psql "$TARGET_CELL_ADMIN_DSN" -Xqv ON_ERROR_STOP=1 -v app_role="$app_role" -v service_role="$service_role" <<'SQL'
SELECT public.contain_database_role(:'app_role');
SELECT public.contain_database_role(:'service_role');
SQL
contained=$(psql "$TARGET_CELL_ADMIN_DSN" -XAtv ON_ERROR_STOP=1 \
  -v app_role="$app_role" -v service_role="$service_role" \
  -f - <<'SQL'
SELECT count(*) = 2 AND bool_and(NOT rolcanlogin) AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename IN (:'app_role', :'service_role')) FROM pg_roles WHERE rolname IN (:'app_role', :'service_role');
SQL
)
[[ "$contained" == t ]] || { echo "contain status failed" >&2; exit 1; }
# The credential mounted into the autonomous pod must be unable to bypass the
# app-layer actor check and re-enable login through direct SQL.
expect_permission_denied() {
  local dsn="$1" role="$2" sql="$3" error_file
  error_file="$(mktemp)"
  if psql "$dsn" -Xqv ON_ERROR_STOP=1 -v VERBOSITY=verbose -v app_role="$role" \
    -f - <<<"$sql" >/dev/null 2>"$error_file"; then
    rm -f "$error_file"
    echo "authorization negative control unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -Eq 'ERROR: *42501:' "$error_file"; then
    cat "$error_file" >&2
    rm -f "$error_file"
    echo "authorization negative control failed without permission SQLSTATE 42501" >&2
    exit 1
  fi
  rm -f "$error_file"
}
expect_permission_denied "$TARGET_CELL_ADMIN_DSN" "$app_role" "SELECT public.readmit_database_role(:'app_role');"
expect_permission_denied "$TARGET_CELL_READMIT_DSN" "$app_role" "SELECT public.contain_database_role(:'app_role');"
expect_permission_denied "$TARGET_CELL_READMIT_DSN" app_readonly "SELECT public.readmit_database_role(:'app_role');"
jq -cn --arg event autonomous_readmit_refused --arg replayId "$replay_id" \
  '{event:$event,replayId:$replayId,result:"pass"}' >>"$evidence"

psql "$TARGET_CELL_READMIT_DSN" -Xqv ON_ERROR_STOP=1 -v app_role="$app_role" -v service_role="$service_role" \
  -f - <<'SQL'
SELECT public.readmit_database_role(:'app_role');
SELECT public.readmit_database_role(:'service_role');
SQL
roles_contained=0
readmitted=$(psql "$TARGET_CELL_ADMIN_DSN" -XAtv ON_ERROR_STOP=1 \
  -v app_role="$app_role" -v service_role="$service_role" \
  -f - <<'SQL'
SELECT count(*) = 2 AND bool_and(rolcanlogin) FROM pg_roles WHERE rolname IN (:'app_role', :'service_role');
SQL
)
[[ "$readmitted" == t ]] || { echo "readmit status failed" >&2; exit 1; }
jq -cn --arg event containment_cycle --arg replayId "$replay_id" \
  '{event:$event,replayId:$replayId,containStatus:"contained",readmitStatus:"open",result:"pass"}' >>"$evidence"

pgbench "$TARGET_CELL_DSN" -n -f "$replay_sql" -c "$clients" -j "$clients" -R "$rate" -T "$duration" \
  >"${evidence%.jsonl}.pgbench.txt" 2>&1 &
load_pid=$!

IFS=',' read -r -a urls <<<"$NEIGHBOR_READYZ_URLS"
while kill -0 "$load_pid" 2>/dev/null; do
  sampled_at=$(date -u +%FT%TZ)
  connections=$(psql "$SHARED_DB_DSN" -XAtqc \
    "select count(*)::float / current_setting('max_connections')::int from pg_stat_activity")
  psi=$(curl -fsS --max-time 5 ${METRICS_AUTH_HEADER:+-H "$METRICS_AUTH_HEADER"} \
    "$SHARED_IO_PSI_QUERY_URL" | jq -er '.data.result[0].value[1] | tonumber')
  awk "BEGIN { exit !($connections < 0.60) }" || { echo "shared connections >=60%" >&2; exit 1; }
  awk "BEGIN { exit !($psi < 0.10) }" || { echo "shared I/O PSI >=10%" >&2; exit 1; }
  for url in "${urls[@]}"; do
    code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$url" || true)
    jq -cn --arg event sample --arg replayId "$replay_id" --arg at "$sampled_at" \
      --arg url "$url" --arg code "$code" --argjson sharedConnections "$connections" \
      --argjson sharedIoPsi "$psi" \
      '{event:$event,replayId:$replayId,at:$at,url:$url,httpCode:$code,sharedConnections:$sharedConnections,sharedIoPsi:$sharedIoPsi}' >>"$evidence"
    [[ "$code" == 200 ]] || { echo "neighbor SLO miss: $url HTTP $code" >&2; exit 1; }
  done
  sleep 5
done
wait "$load_pid"
load_pid=
jq -cn --arg event complete --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  '{event:$event,replayId:$replayId,at:$at,result:"pass"}' >>"$evidence"
echo "$evidence"
