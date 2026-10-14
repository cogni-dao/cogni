#!/usr/bin/env bash
# Candidate-only automatic shared-tier containment + human readmission replay.
set -euo pipefail

: "${ALLOW_CANDIDATE_DATABASE_REPLAY:?must equal 1}"
: "${TARGET_DATABASE_DSN:?shared target application-role DSN required}"
: "${TARGET_NODE_SLUG:?shared target node slug required}"
: "${TARGET_NODE_ID:?shared target node id required}"
: "${OPERATOR_BUILD_SHA:?exact deployed operator/actuator SHA required}"
: "${TARGET_NODE_BUILD_SHA:?exact deployed target-node SHA required}"
: "${REGIONAL_BASE_URLS:?exactly two regional base URLs required}"
: "${NEIGHBOR_READYZ_URLS:?exactly two neighbor readyz URLs required}"
: "${RELIABILITY_STATUS_URL:?authenticated reliability status URL required}"
: "${RELIABILITY_STATUS_AUTH_HEADER:?status Authorization header required}"
: "${TARGET_CONTAINMENT_STATUS_URL:?target internal containment status URL required}"
: "${CONTROL_CONTAINMENT_STATUS_URL:?unrelated control internal status URL required}"
: "${ACTUATOR_VERSION_URL:?private actuator version URL required}"
: "${OPERATOR_VERSION_URL:?deployed operator version URL required}"
: "${RELIABILITY_READMIT_URL:?session-authenticated human readmit URL required}"
: "${RELIABILITY_READMIT_AUTH_HEADER:?human-session Authorization header required}"
: "${LOKI_QUERY_URL:?Loki query_range endpoint required}"
: "${LOKI_AUTH_HEADER:?Loki Authorization header required}"
: "${INCIDENT_REQUEST_RATE:?measured incident requests/second required}"

[[ "$ALLOW_CANDIDATE_DATABASE_REPLAY" == 1 && "${DEPLOY_ENVIRONMENT:-}" == candidate-a ]] || {
  echo "candidate-a replay not authorized" >&2; exit 2;
}
[[ "$OPERATOR_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "operator SHA must be 40 lowercase hex" >&2; exit 2; }
[[ "$TARGET_NODE_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "target-node SHA must be 40 lowercase hex" >&2; exit 2; }
command -v pgbench >/dev/null && command -v psql >/dev/null && command -v jq >/dev/null && command -v curl >/dev/null

IFS=',' read -r -a regions <<<"$REGIONAL_BASE_URLS"
IFS=',' read -r -a neighbors <<<"$NEIGHBOR_READYZ_URLS"
[[ "${#regions[@]}" == 2 && "${#neighbors[@]}" == 2 ]] || { echo "exactly two regional identities required" >&2; exit 2; }
[[ "${regions[0]}" != "${regions[1]}" && "${neighbors[0]}" != "${neighbors[1]}" ]] || { echo "regional identities must be distinct" >&2; exit 2; }

root_dir=$(git rev-parse --show-toplevel)
catalog_file="$root_dir/infra/catalog/$TARGET_NODE_SLUG.yaml"
[[ -f "$catalog_file" ]] || { echo "target catalog entry missing" >&2; exit 2; }
[[ "$(yq -er '.database."candidate-a".tier' "$catalog_file")" == shared ]] || {
  echo "automatic containment replay requires a catalog-declared shared target" >&2; exit 2;
}
catalog_target_sha=$(yq -er '.source_sha' "$catalog_file")
[[ "$catalog_target_sha" == "$TARGET_NODE_BUILD_SHA" ]] || {
  echo "target-node SHA differs from immutable catalog source_sha" >&2; exit 2;
}
replay_sql=${REPLAY_SQL_FILE:-$(mktemp)}
if [[ -z "${REPLAY_SQL_FILE:-}" ]]; then
  cat >"$replay_sql" <<'SQL'
SELECT count(*)
FROM (
  SELECT payload
  FROM public.reliability_noisy_neighbor_fixture
  ORDER BY payload || random()::text
) AS spill;
SQL
fi
duration=${REPLAY_DURATION_SECONDS:-1800}
clients=${REPLAY_CLIENTS:-8}
rate=${REPLAY_RATE:-$((INCIDENT_REQUEST_RATE * 2))}
contain_timeout=${CONTAIN_TIMEOUT_SECONDS:-300}
evidence=${REPLAY_EVIDENCE_FILE:-shared-database-containment-replay.jsonl}
replay_id="shared-contain-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
replay_started_epoch=$(date +%s)
jq -cn --arg event start --arg replayId "$replay_id" --arg node "$TARGET_NODE_SLUG" \
  --arg operatorSha "$OPERATOR_BUILD_SHA" --arg targetSha "$TARGET_NODE_BUILD_SHA" \
  --argjson clients "$clients" --argjson rate "$rate" \
  '{event:$event,replayId:$replayId,node:$node,operatorBuildSha:$operatorSha,targetNodeBuildSha:$targetSha,clients:$clients,rate:$rate}' >"$evidence"

actuator_sha=$(curl -fsS --max-time 5 "$ACTUATOR_VERSION_URL" | jq -er '.buildSha')
[[ "$actuator_sha" == "$OPERATOR_BUILD_SHA" ]] || {
  echo "actuator image SHA does not match replay target" >&2; exit 1;
}
operator_sha=$(curl -fsS --max-time 5 "$OPERATOR_VERSION_URL" | jq -er '.buildSha')
[[ "$operator_sha" == "$OPERATOR_BUILD_SHA" ]] || {
  echo "operator image SHA does not match replay target" >&2; exit 1;
}
jq -cn --arg event control_plane_versions --arg replayId "$replay_id" \
  --arg sha "$OPERATOR_BUILD_SHA" --arg actuatorUrl "$ACTUATOR_VERSION_URL" \
  --arg operatorUrl "$OPERATOR_VERSION_URL" \
  '{event:$event,replayId:$replayId,buildSha:$sha,actuatorUrl:$actuatorUrl,operatorUrl:$operatorUrl}' >>"$evidence"

cleanup() {
  [[ -n "${load_pid:-}" ]] && kill "$load_pid" 2>/dev/null || true
  [[ -z "${REPLAY_SQL_FILE:-}" ]] && rm -f "$replay_sql"
}
trap cleanup EXIT INT TERM

target_before=$(curl -fsS --max-time 10 -H "Authorization: $RELIABILITY_STATUS_AUTH_HEADER" "$TARGET_CONTAINMENT_STATUS_URL")
control_before=$(curl -fsS --max-time 10 -H "Authorization: $RELIABILITY_STATUS_AUTH_HEADER" "$CONTROL_CONTAINMENT_STATUS_URL")
jq -e '.phase == "open"' <<<"$target_before" >/dev/null || { echo "target must be open before load" >&2; exit 1; }
jq -e '.phase == "open"' <<<"$control_before" >/dev/null || { echo "control node must be open before load" >&2; exit 1; }

psql "$TARGET_DATABASE_DSN" -Xv ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.reliability_noisy_neighbor_fixture (
  id bigint PRIMARY KEY,
  payload text NOT NULL
);
TRUNCATE public.reliability_noisy_neighbor_fixture;
INSERT INTO public.reliability_noisy_neighbor_fixture (id, payload)
SELECT value, repeat(md5(value::text), 16)
FROM generate_series(1, 200000) AS value;
ANALYZE public.reliability_noisy_neighbor_fixture;
SQL

pgbench "$TARGET_DATABASE_DSN" -n -f "$replay_sql" -c "$clients" -j "$clients" -R "$rate" -T "$duration" \
  >"${evidence%.jsonl}.pgbench.txt" 2>&1 &
load_pid=$!
deadline=$((SECONDS + contain_timeout))
contained=0
incident_id=""

while (( SECONDS < deadline )); do
  sampled_at=$(date -u +%FT%TZ)
  for url in "${neighbors[@]}"; do
    code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$url" || true)
    jq -cn --arg event neighbor_sample --arg replayId "$replay_id" --arg at "$sampled_at" \
      --arg url "$url" --arg code "$code" '{event:$event,replayId:$replayId,at:$at,url:$url,httpCode:$code}' >>"$evidence"
    [[ "$code" == 200 ]] || { echo "neighbor missed SLO before containment: $url" >&2; exit 1; }
  done

  status=$(curl -fsS --max-time 10 -H "Authorization: $RELIABILITY_STATUS_AUTH_HEADER" "$RELIABILITY_STATUS_URL")
  state=$(jq -er '.state' <<<"$status")
  if [[ "$state" == contained ]]; then
    jq -e '
      .utilization.evidenceScope == "node" and
      (if (.incidentReason | contains("I/O pressure critical")) then
         ((.utilization.databaseShare5m.physicalReadsPct // -1) >= 40 or
          (.utilization.databaseShare5m.tempBytesPct // -1) >= 40)
       elif (.incidentReason | contains("database connections critical")) then
         (.utilization.databaseShare5m.backendsPct // -1) >= 40
       else false end)
    ' <<<"$status" >/dev/null || {
      echo "contained response lacks matching node-attributed constrained share" >&2; exit 1;
    }
    contained=1
    break
  fi
  kill -0 "$load_pid" 2>/dev/null || { echo "load exited before automatic containment" >&2; exit 1; }
  sleep 5
done
[[ "$contained" == 1 ]] || { echo "automatic containment timed out" >&2; exit 1; }

target_after=$(curl -fsS --max-time 10 -H "Authorization: $RELIABILITY_STATUS_AUTH_HEADER" "$TARGET_CONTAINMENT_STATUS_URL")
control_after=$(curl -fsS --max-time 10 -H "Authorization: $RELIABILITY_STATUS_AUTH_HEADER" "$CONTROL_CONTAINMENT_STATUS_URL")
jq -e '.phase == "contained"' <<<"$target_after" >/dev/null || { echo "target containment status not terminal" >&2; exit 1; }
jq -e '.phase == "open"' <<<"$control_after" >/dev/null || { echo "unrelated control node was mutated" >&2; exit 1; }
incident_id=$(jq -er '.incidentId' <<<"$target_after")

wait "$load_pid" && { echo "hostile load unexpectedly survived containment" >&2; exit 1; } || true
load_pid=

now_ns=$(( $(date +%s) * 1000000000 ))
start_ns=$(( replay_started_epoch * 1000000000 ))
log_query="{env=\"candidate-a\",service=\"database-reliability-actuator\"} | json | event=\"feature.node_reliability.transition\" | action=\"contained\" | nodeId=\"$TARGET_NODE_ID\" | environment=\"candidate-a\" | incidentId=\"$incident_id\" | buildSha=\"$OPERATOR_BUILD_SHA\""
audit=$(curl -fsS --get --max-time 10 -H "Authorization: $LOKI_AUTH_HEADER" \
  --data-urlencode "query=$log_query" --data-urlencode "start=$start_ns" \
  --data-urlencode "end=$now_ns" --data-urlencode 'limit=20' "$LOKI_QUERY_URL")
jq -e --arg incidentId "$incident_id" --arg sha "$OPERATOR_BUILD_SHA" --arg nodeId "$TARGET_NODE_ID" '
  [.data.result[].values[]?[1] | fromjson |
    select(.action == "contained" and .incidentId == $incidentId and
      .nodeId == $nodeId and .environment == "candidate-a" and
      .buildSha == $sha)] | length == 1
' <<<"$audit" >/dev/null || { echo "exact terminal containment audit missing or ambiguous" >&2; exit 1; }
jq -cn --arg event automatic_containment --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  --arg incidentId "$incident_id" '{event:$event,replayId:$replayId,at:$at,incidentId:$incidentId,result:"pass"}' >>"$evidence"

for sample in 1 2 3 4 5; do
  sampled_at=$(date -u +%FT%TZ)
  for base_url in "${regions[@]}"; do
    base_url=${base_url%/}
    code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$base_url/readyz" || true)
    observed_sha=$(curl -fsS --max-time 5 "$base_url/version" | jq -er '.buildSha')
    [[ "$code" == 200 && "$observed_sha" == "$TARGET_NODE_BUILD_SHA" ]] || { echo "readmission evidence failed: $base_url" >&2; exit 1; }
    jq -cn --arg event readmission_sample --arg replayId "$replay_id" --arg at "$sampled_at" \
      --arg region "$base_url" --arg sha "$observed_sha" --argjson sample "$sample" \
      '{event:$event,replayId:$replayId,at:$at,region:$region,buildSha:$sha,sample:$sample,healthy:true}' >>"$evidence"
  done
  [[ "$sample" == 5 ]] || sleep 60
done

readmit=$(curl -fsS --max-time 30 -X POST -H "Authorization: $RELIABILITY_READMIT_AUTH_HEADER" \
  -H 'content-type: application/json' --data '{"env":"candidate-a"}' "$RELIABILITY_READMIT_URL")
jq -e '.phase == "open"' <<<"$readmit" >/dev/null || { echo "human readmission failed" >&2; exit 1; }
psql "$TARGET_DATABASE_DSN" -Xv ON_ERROR_STOP=1 \
  -c 'DROP TABLE IF EXISTS public.reliability_noisy_neighbor_fixture'
jq -cn --arg event complete --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  '{event:$event,replayId:$replayId,at:$at,result:"pass"}' >>"$evidence"
echo "$evidence"
