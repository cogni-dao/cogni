#!/usr/bin/env bash
# Candidate-only automatic shared-tier containment + human readmission replay.
set -euo pipefail

: "${ALLOW_CANDIDATE_DATABASE_REPLAY:?must equal 1}"
: "${PLATFORM_BUILD_SHA:?exact deployed controller/actuator SHA required}"
: "${CANDIDATE_DOMAIN:?candidate bare domain required}"

[[ "$ALLOW_CANDIDATE_DATABASE_REPLAY" == 1 && "${DEPLOY_ENVIRONMENT:-}" == candidate-a ]] || {
  echo "candidate-a replay not authorized" >&2; exit 2;
}
[[ "$PLATFORM_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "platform SHA must be 40 lowercase hex" >&2; exit 2; }
[[ "$CANDIDATE_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || {
  echo "candidate domain must be a bare lowercase DNS name" >&2; exit 2;
}
command -v git >/dev/null && command -v jq >/dev/null && command -v yq >/dev/null

root_dir=$(git rev-parse --show-toplevel)
git -C "$root_dir" cat-file -e "${PLATFORM_BUILD_SHA}^{commit}" 2>/dev/null || {
  echo "platform SHA is not an immutable commit in this repository" >&2; exit 2;
}
snapshot_root=$(mktemp -d)
git -C "$root_dir" archive "$PLATFORM_BUILD_SHA" -- \
  infra/catalog \
  packages/node-contracts/src/reliability-policy.v1.json \
  scripts/ci/lib/image-tags.sh | tar -x -C "$snapshot_root"
policy_file="$snapshot_root/packages/node-contracts/src/reliability-policy.v1.json"
catalog_root="$snapshot_root/infra/catalog"

cleanup() {
  [[ -n "${load_pid:-}" ]] && kill "$load_pid" 2>/dev/null || true
  [[ -n "${replay_sql:-}" && -z "${REPLAY_SQL_FILE:-}" ]] && rm -f "$replay_sql"
  [[ -n "${snapshot_root:-}" ]] && rm -rf "$snapshot_root"
  unset PGDATABASE
}
trap cleanup EXIT INT TERM

for forbidden_override in \
  TARGET_NODE_SLUG TARGET_NODE_ID TARGET_NODE_BUILD_SHA \
  CONTROL_NODE_SLUG CONTROL_NODE_ID CONTROL_NODE_BUILD_SHA \
  DEDICATED_NEIGHBOR_SLUG DEDICATED_NEIGHBOR_ID DEDICATED_NEIGHBOR_BUILD_SHA \
  CONTROLLER_NODE_SLUG CONTROLLER_NODE_ID CONTROLLER_NODE_BUILD_SHA \
  RELIABILITY_STATUS_URL RELIABILITY_STATUS_AUTH_HEADER \
  ACTUATOR_STATUS_BASE_URL ACTUATOR_VERSION_URL RELIABILITY_READMIT_URL; do
  if declare -p "$forbidden_override" &>/dev/null; then
    echo "$forbidden_override is immutable and must not be caller supplied" >&2
    exit 2
  fi
done

catalog_for_role() {
  local wanted_role=$1 matches=() file declared_role
  for file in "$catalog_root"/*.yaml; do
    declared_role=$(yq -N ".reliability_validation.\"${DEPLOY_ENVIRONMENT}\".role // \"\"" "$file")
    if [[ "$declared_role" == "$wanted_role" ]]; then
      yq -e ".type == \"node\" and (.envs | contains([\"${DEPLOY_ENVIRONMENT}\"]))" "$file" >/dev/null \
        || { echo "${wanted_role} is not a deployed node in ${DEPLOY_ENVIRONMENT}: $file" >&2; return 2; }
      matches+=("$file")
    fi
  done
  [[ "${#matches[@]}" == 1 ]] || {
    echo "catalog must declare exactly one ${wanted_role} for ${DEPLOY_ENVIRONMENT}" >&2
    return 2
  }
  printf '%s' "${matches[0]}"
}

catalog_for_controller() {
  local matches=() file declared_controller
  for file in "$catalog_root"/*.yaml; do
    declared_controller=$(yq -N '.reliability.controller // false' "$file")
    if [[ "$declared_controller" == true ]]; then
      yq -e ".type == \"node\" and (.envs | contains([\"${DEPLOY_ENVIRONMENT}\"])) and (.source_repo == null)" "$file" >/dev/null \
        || { echo "reliability controller must be an in-repository deployed node: $file" >&2; return 2; }
      matches+=("$file")
    fi
  done
  [[ "${#matches[@]}" == 1 ]] || {
    echo "catalog must declare exactly one reliability controller for ${DEPLOY_ENVIRONMENT}" >&2
    return 2
  }
  printf '%s' "${matches[0]}"
}

catalog_node_id() {
  local file=$1 node_id path_prefix spec_path
  node_id=$(yq -N '.node_id // ""' "$file")
  if [[ -z "$node_id" ]]; then
    path_prefix=$(yq -er '.path_prefix' "$file")
    spec_path="${path_prefix}.cogni/repo-spec.yaml"
    node_id=$(git -C "$root_dir" show "${PLATFORM_BUILD_SHA}:${spec_path}" 2>/dev/null | yq -er '.node_id') || {
      echo "catalog identity projection and immutable repo-spec are both absent: $file" >&2; return 2;
    }
  fi
  printf '%s' "$node_id"
}

catalog_build_sha() {
  local file=$1 source_sha source_repo
  source_sha=$(yq -N '.source_sha // ""' "$file")
  source_repo=$(yq -N '.source_repo // ""' "$file")
  if [[ -n "$source_sha" ]]; then
    printf '%s' "$source_sha"
  elif [[ -z "$source_repo" ]]; then
    printf '%s' "$PLATFORM_BUILD_SHA"
  else
    echo "remote-source validation role has no immutable source_sha: $file" >&2
    return 2
  fi
}

target_catalog=$(catalog_for_role shared-target)
control_catalog=$(catalog_for_role shared-control)
dedicated_neighbor_catalog=$(catalog_for_role dedicated-neighbor)
controller_catalog=$(catalog_for_controller)
TARGET_NODE_SLUG=$(yq -er '.name' "$target_catalog")
CONTROL_NODE_SLUG=$(yq -er '.name' "$control_catalog")
DEDICATED_NEIGHBOR_SLUG=$(yq -er '.name' "$dedicated_neighbor_catalog")
CONTROLLER_NODE_SLUG=$(yq -er '.name' "$controller_catalog")
TARGET_NODE_ID=$(catalog_node_id "$target_catalog")
CONTROL_NODE_ID=$(catalog_node_id "$control_catalog")
DEDICATED_NEIGHBOR_ID=$(catalog_node_id "$dedicated_neighbor_catalog")
CONTROLLER_NODE_ID=$(catalog_node_id "$controller_catalog")
TARGET_NODE_BUILD_SHA=$(catalog_build_sha "$target_catalog")
CONTROL_NODE_BUILD_SHA=$(catalog_build_sha "$control_catalog")
DEDICATED_NEIGHBOR_BUILD_SHA=$(catalog_build_sha "$dedicated_neighbor_catalog")
CONTROLLER_NODE_BUILD_SHA=$(catalog_build_sha "$controller_catalog")
target_tier=$(yq -er '.database."candidate-a".tier' "$target_catalog")
control_tier=$(yq -er '.database."candidate-a".tier' "$control_catalog")
dedicated_neighbor_tier=$(yq -er '.database."candidate-a".tier' "$dedicated_neighbor_catalog")
mapfile -t expected_regions < <(jq -er '.expectedRegions[]' "$policy_file")
noisy_neighbor_share=$(jq -er '.noisyNeighborSharePercent' "$policy_file")
[[ "$target_tier" == shared && "$control_tier" == shared && "$dedicated_neighbor_tier" == dedicated ]] || {
  echo "catalog validation roles differ from the required shared/shared/dedicated topology" >&2; exit 2;
}
[[ "$TARGET_NODE_ID" =~ ^[0-9a-f-]{36}$ && "$CONTROL_NODE_ID" =~ ^[0-9a-f-]{36}$ && "$DEDICATED_NEIGHBOR_ID" =~ ^[0-9a-f-]{36}$ ]] || {
  echo "immutable validation identities are invalid" >&2; exit 2;
}
[[ "$TARGET_NODE_ID" != "$CONTROL_NODE_ID" && "$TARGET_NODE_ID" != "$DEDICATED_NEIGHBOR_ID" && "$CONTROL_NODE_ID" != "$DEDICATED_NEIGHBOR_ID" ]] || { echo "immutable validation identities collide" >&2; exit 2; }
[[ "$TARGET_NODE_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "catalog target SHA must be 40 lowercase hex" >&2; exit 2; }
[[ "$CONTROL_NODE_BUILD_SHA" =~ ^[0-9a-f]{40}$ && "$DEDICATED_NEIGHBOR_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "catalog neighbor SHAs must be 40 lowercase hex" >&2; exit 2; }
[[ "$CONTROLLER_NODE_ID" =~ ^[0-9a-f-]{36}$ && "$CONTROLLER_NODE_BUILD_SHA" == "$PLATFORM_BUILD_SHA" ]] || {
  echo "reliability controller identity must resolve to the exact platform SHA" >&2; exit 2;
}
[[ "${#expected_regions[@]}" == 2 && "${expected_regions[0]}" != "${expected_regions[1]}" ]] || {
  echo "policy must declare exactly two distinct reliability regions" >&2; exit 2;
}

status_path() {
  local slug=$1 node_id=$2
  printf '/v1/internal/status?environment=%s&node_slug=%s&node_id=%s' \
    "$DEPLOY_ENVIRONMENT" "$slug" "$node_id"
}
target_containment_status_path=$(status_path "$TARGET_NODE_SLUG" "$TARGET_NODE_ID")
control_containment_status_path=$(status_path "$CONTROL_NODE_SLUG" "$CONTROL_NODE_ID")
# shellcheck source=scripts/ci/lib/image-tags.sh
# shellcheck disable=SC1091
COGNI_CATALOG_ROOT="$catalog_root" source "$snapshot_root/scripts/ci/lib/image-tags.sh"
target_base="https://$(host_for_node "$TARGET_NODE_SLUG" "$CANDIDATE_DOMAIN")"
control_base="https://$(host_for_node "$CONTROL_NODE_SLUG" "$CANDIDATE_DOMAIN")"
dedicated_neighbor_base="https://$(host_for_node "$DEDICATED_NEIGHBOR_SLUG" "$CANDIDATE_DOMAIN")"
controller_base="https://$(host_for_node "$CONTROLLER_NODE_SLUG" "$CANDIDATE_DOMAIN")"
controller_namespace="cogni-${DEPLOY_ENVIRONMENT}"
controller_app_deployment="${CONTROLLER_NODE_SLUG}-node-app"
actuator_origin="http://${CONTROLLER_NODE_SLUG}-database-reliability-actuator:8080"
readmitter_origin="http://${CONTROLLER_NODE_SLUG}-database-reliability-readmitter:8081"
controller_version_url="${controller_base}/version"
actuator_version_url="${actuator_origin}/version"
reliability_status_url="${controller_base}/api/v1/nodes/${TARGET_NODE_ID}/observability/health?env=${DEPLOY_ENVIRONMENT}"
reliability_readmit_url="${controller_base}/api/v1/nodes/${TARGET_NODE_ID}/observability/health"
openbao_target_path="cogni/${DEPLOY_ENVIRONMENT}/${TARGET_NODE_SLUG}"
readiness_query=$(printf 'min_over_time(probe_success{environment="%s",node_slug="%s",proof_class="serve"}[1m])' "$DEPLOY_ENVIRONMENT" "$TARGET_NODE_SLUG")
neighbor_names=("$CONTROL_NODE_SLUG" "$DEDICATED_NEIGHBOR_SLUG")
neighbor_bases=("$control_base" "$dedicated_neighbor_base")
neighbor_shas=("$CONTROL_NODE_BUILD_SHA" "$DEDICATED_NEIGHBOR_BUILD_SHA")

plan=$(jq -cn \
  --arg platformBuildSha "$PLATFORM_BUILD_SHA" \
  --arg controllerSlug "$CONTROLLER_NODE_SLUG" --arg controllerNodeId "$CONTROLLER_NODE_ID" \
  --arg controllerBuildSha "$CONTROLLER_NODE_BUILD_SHA" --arg controllerBase "$controller_base" \
  --arg controllerVersionUrl "$controller_version_url" --arg actuatorOrigin "$actuator_origin" \
  --arg actuatorStatusPath "$target_containment_status_path" --arg actuatorVersionUrl "$actuator_version_url" \
  --arg readmitterOrigin "$readmitter_origin" --arg publicStatusUrl "$reliability_status_url" \
  --arg publicReadmitUrl "$reliability_readmit_url" \
  --arg targetSlug "$TARGET_NODE_SLUG" --arg targetNodeId "$TARGET_NODE_ID" --arg targetBase "$target_base" \
  --arg controlSlug "$CONTROL_NODE_SLUG" --arg controlNodeId "$CONTROL_NODE_ID" --arg controlBase "$control_base" \
  --arg dedicatedSlug "$DEDICATED_NEIGHBOR_SLUG" --arg dedicatedNodeId "$DEDICATED_NEIGHBOR_ID" --arg dedicatedBase "$dedicated_neighbor_base" \
  --arg openbaoPath "$openbao_target_path" --arg readinessQuery "$readiness_query" \
  '{platformBuildSha:$platformBuildSha,controller:{slug:$controllerSlug,nodeId:$controllerNodeId,buildSha:$controllerBuildSha,publicBase:$controllerBase,versionUrl:$controllerVersionUrl,actuator:{origin:$actuatorOrigin,statusPath:$actuatorStatusPath,versionUrl:$actuatorVersionUrl},readmitter:{origin:$readmitterOrigin}},validation:{sharedTarget:{slug:$targetSlug,nodeId:$targetNodeId,baseUrl:$targetBase},sharedControl:{slug:$controlSlug,nodeId:$controlNodeId,baseUrl:$controlBase},dedicatedNeighbor:{slug:$dedicatedSlug,nodeId:$dedicatedNodeId,baseUrl:$dedicatedBase}},public:{statusUrl:$publicStatusUrl,readmitUrl:$publicReadmitUrl},openbaoPath:$openbaoPath,readinessQuery:$readinessQuery,containmentTarget:$targetNodeId,readmissionTarget:$targetNodeId}')
if [[ "${REPLAY_PLAN_ONLY:-0}" == 1 ]]; then
  printf '%s\n' "$plan"
  exit 0
fi

: "${RELIABILITY_READMIT_COOKIE_HEADER:?captured human-session Cookie header required}"
: "${MIMIR_QUERY_URL:?Prometheus-compatible query_range endpoint required}"
: "${METRICS_AUTH_HEADER:?Mimir Authorization header required}"
: "${LOKI_QUERY_URL:?Loki query_range endpoint required}"
: "${LOKI_AUTH_HEADER:?Loki Authorization header required}"
: "${INCIDENT_REQUEST_RATE:?measured incident requests/second required}"
command -v pgbench >/dev/null && command -v psql >/dev/null && command -v curl >/dev/null && command -v kubectl >/dev/null

actuator_get() {
  local path=$1
  # shellcheck disable=SC2016
  kubectl -n "$controller_namespace" exec deployment/"$controller_app_deployment" -c app -- \
    node --input-type=module -e '
      const [expectedOrigin, path] = process.argv.slice(1);
      const configuredOrigin = process.env.DATABASE_RELIABILITY_ACTUATOR_URL;
      const token = process.env.DATABASE_RELIABILITY_STATUS_TOKEN;
      if (configuredOrigin !== expectedOrigin || !token) process.exit(20);
      const response = await fetch(new URL(path, expectedOrigin), {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await response.text();
      process.stdout.write(body);
      if (!response.ok) process.exit(21);
    ' "$actuator_origin" "$path"
}

# The only database credential boundary authorized for this replay is the existing
# candidate-a db-reader Kubernetes role. PGDATABASE may hold a libpq URI, keeping
# the target DSN out of argv, logs, and proof artifacts.
kubectl get serviceaccount db-provisioner -n default >/dev/null
reader_jwt=$(kubectl create token db-provisioner -n default)
reader_token=$(kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
  bao write -field=token auth/kubernetes/login role=candidate-a-db-reader jwt="$reader_jwt")
[[ -n "$reader_token" ]] || { echo "candidate-a-db-reader login failed" >&2; exit 2; }
target_secret=$(kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN="$reader_token" \
  bao kv get -format=json "$openbao_target_path")
PGDATABASE=$(jq -er '.data.data.DATABASE_URL | select(type == "string" and length > 0)' <<<"$target_secret")
export PGDATABASE
unset target_secret reader_token reader_jwt
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
[[ "$clients" -ge 8 && "$duration" -ge 1800 && "$rate" -ge $((INCIDENT_REQUEST_RATE * 2)) ]] || {
  echo "requires >=8 clients, >=1800s, and >=2x incident rate" >&2; exit 2;
}
replay_id="shared-contain-${PLATFORM_BUILD_SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
replay_started_epoch=$(date +%s)
jq -cn --arg event start --arg replayId "$replay_id" --arg node "$TARGET_NODE_SLUG" \
  --arg platformSha "$PLATFORM_BUILD_SHA" --arg targetSha "$TARGET_NODE_BUILD_SHA" \
  --argjson clients "$clients" --argjson rate "$rate" --argjson plan "$plan" \
  '{event:$event,replayId:$replayId,node:$node,platformBuildSha:$platformSha,targetNodeBuildSha:$targetSha,clients:$clients,rate:$rate,plan:$plan}' >"$evidence"

actuator_sha=$(actuator_get /version | jq -er '.buildSha')
[[ "$actuator_sha" == "$PLATFORM_BUILD_SHA" ]] || {
  echo "actuator image SHA does not match replay target" >&2; exit 1;
}
platform_sha=$(curl -fsS --max-time 5 "$controller_version_url" | jq -er '.buildSha')
[[ "$platform_sha" == "$PLATFORM_BUILD_SHA" ]] || {
  echo "controller app image SHA does not match replay target" >&2; exit 1;
}
jq -cn --arg event control_plane_versions --arg replayId "$replay_id" \
  --arg sha "$PLATFORM_BUILD_SHA" --arg actuatorUrl "$actuator_version_url" \
  --arg appUrl "$controller_version_url" \
  '{event:$event,replayId:$replayId,buildSha:$sha,actuatorUrl:$actuatorUrl,appUrl:$appUrl}' >>"$evidence"
target_ready_code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$target_base/readyz" || true)
target_observed_sha=$(curl -fsS --max-time 5 "$target_base/version" | jq -er '.buildSha')
[[ "$target_ready_code" == 200 && "$target_observed_sha" == "$TARGET_NODE_BUILD_SHA" ]] || {
  echo "shared target exact-SHA readiness failed" >&2; exit 1;
}

target_before=$(actuator_get "$target_containment_status_path")
control_before=$(actuator_get "$control_containment_status_path")
jq -e '.phase == "open"' <<<"$target_before" >/dev/null || { echo "target must be open before load" >&2; exit 1; }
jq -e '.phase == "open"' <<<"$control_before" >/dev/null || { echo "control node must be open before load" >&2; exit 1; }

psql -Xv ON_ERROR_STOP=1 <<'SQL'
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

pgbench -n -f "$replay_sql" -c "$clients" -j "$clients" -R "$rate" -T "$duration" \
  >"${evidence%.jsonl}.pgbench.txt" 2>&1 &
load_pid=$!
deadline=$((SECONDS + contain_timeout))
contained=0
incident_id=""

while (( SECONDS < deadline )); do
  sampled_at=$(date -u +%FT%TZ)
  for index in "${!neighbor_bases[@]}"; do
    url=${neighbor_bases[$index]}
    expected_sha=${neighbor_shas[$index]}
    code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$url/readyz" || true)
    observed_sha=$(curl -fsS --max-time 5 "$url/version" | jq -er '.buildSha')
    jq -cn --arg event neighbor_sample --arg replayId "$replay_id" --arg at "$sampled_at" \
      --arg node "${neighbor_names[$index]}" --arg url "$url" --arg code "$code" \
      --arg expectedSha "$expected_sha" --arg observedSha "$observed_sha" \
      '{event:$event,replayId:$replayId,at:$at,node:$node,url:$url,httpCode:$code,expectedBuildSha:$expectedSha,observedBuildSha:$observedSha}' >>"$evidence"
    [[ "$code" == 200 && "$observed_sha" == "$expected_sha" ]] || {
      echo "neighbor exact-SHA SLO miss before containment: $url" >&2; exit 1;
    }
  done

  status=$(curl -fsS --max-time 10 -H "Cookie: $RELIABILITY_READMIT_COOKIE_HEADER" "$reliability_status_url")
  state=$(jq -er '.state' <<<"$status")
  if [[ "$state" == contained ]]; then
    jq -e --argjson share "$noisy_neighbor_share" '
      .utilization.evidenceScope == "node" and
      (if (.incidentReason | contains("I/O pressure critical")) then
         ((.utilization.databaseShare5m.physicalReadsPct // -1) >= $share or
          (.utilization.databaseShare5m.tempBytesPct // -1) >= $share)
       elif (.incidentReason | contains("database connections critical")) then
         (.utilization.databaseShare5m.backendsPct // -1) >= $share
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

target_after=$(actuator_get "$target_containment_status_path")
control_after=$(actuator_get "$control_containment_status_path")
jq -e '.phase == "contained"' <<<"$target_after" >/dev/null || { echo "target containment status not terminal" >&2; exit 1; }
jq -e '.phase == "open"' <<<"$control_after" >/dev/null || { echo "unrelated control node was mutated" >&2; exit 1; }
incident_id=$(jq -er '.incidentId' <<<"$target_after")

wait "$load_pid" && { echo "hostile load unexpectedly survived containment" >&2; exit 1; } || true
load_pid=

now_ns=$(( $(date +%s) * 1000000000 ))
start_ns=$(( replay_started_epoch * 1000000000 ))
log_query="{env=\"candidate-a\",service=\"database-reliability-actuator\"} | json | event=\"feature.node_reliability.transition\" | action=\"contained\" | nodeId=\"$TARGET_NODE_ID\" | environment=\"candidate-a\" | incidentId=\"$incident_id\" | buildSha=\"$PLATFORM_BUILD_SHA\""
audit=$(curl -fsS --get --max-time 10 -H "Authorization: $LOKI_AUTH_HEADER" \
  --data-urlencode "query=$log_query" --data-urlencode "start=$start_ns" \
  --data-urlencode "end=$now_ns" --data-urlencode 'limit=20' "$LOKI_QUERY_URL")
jq -e --arg incidentId "$incident_id" --arg sha "$PLATFORM_BUILD_SHA" --arg nodeId "$TARGET_NODE_ID" '
  [.data.result[].values[]?[1] | fromjson |
    select(.action == "contained" and .incidentId == $incidentId and
      .nodeId == $nodeId and .environment == "candidate-a" and
      .buildSha == $sha)] | length == 1
' <<<"$audit" >/dev/null || { echo "exact terminal containment audit missing or ambiguous" >&2; exit 1; }
jq -cn --arg event automatic_containment --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  --arg incidentId "$incident_id" '{event:$event,replayId:$replayId,at:$at,incidentId:$incidentId,result:"pass"}' >>"$evidence"

verify_readmission_window() {
  local end start query response
  end=$(date +%s)
  start=$((end - 240))
  query=$readiness_query
  response=$(curl -fsS --get --max-time 15 -H "Authorization: $METRICS_AUTH_HEADER" \
    --data-urlencode "query=$query" --data-urlencode "start=$start" \
    --data-urlencode "end=$end" --data-urlencode 'step=60s' "$MIMIR_QUERY_URL")
  jq -e --arg first "${expected_regions[0]}" --arg second "${expected_regions[1]}" --argjson end "$end" '
    .status == "success" and
    (.data.result | length == 2) and
    (([.data.result[].metric.probe] | sort) == ([$first, $second] | sort)) and
    all(.data.result[];
      (.values | length == 5) and
      (all(.values[]; ((.[0] | type) == "number") and (.[0] <= $end + 15) and ((.[1] | tonumber) >= 1))) and
      ((.values[-1][0] - .values[-2][0]) == 60) and
      ((.values[-2][0] - .values[-3][0]) == 60) and
      ((.values[-3][0] - .values[-4][0]) == 60) and
      ((.values[-4][0] - .values[-5][0]) == 60) and
      (($end - .values[-1][0]) >= -15) and
      (($end - .values[-1][0]) <= 90)
    )
  ' <<<"$response" >/dev/null || {
    echo "Frankfurt+Ohio five-sample Mimir readmission evidence failed" >&2; exit 1;
  }
  jq -cn --arg event readmission_evidence --arg replayId "$replay_id" \
    --arg queryRef reliability-status-v1.readiness-1m --arg unit boolean \
    --argjson start "$start" --argjson end "$end" --argjson series "$(jq -c '.data.result' <<<"$response")" \
    '{event:$event,replayId:$replayId,queryRef:$queryRef,unit:$unit,evaluationInterval:{start:$start,end:$end,stepSeconds:60},series:$series}' >>"$evidence"
}

verify_readmission_window

readmit=$(curl -fsS --max-time 30 -X POST -H "Cookie: $RELIABILITY_READMIT_COOKIE_HEADER" \
  -H 'content-type: application/json' --data "{\"env\":\"${DEPLOY_ENVIRONMENT}\"}" "$reliability_readmit_url")
jq -e --arg incidentId "$incident_id" '.phase == "open" and .incidentId == $incidentId' <<<"$readmit" >/dev/null || {
  echo "human readmission failed or changed incident identity" >&2; exit 1;
}
now_ns=$(( $(date +%s) * 1000000000 ))
readmit_log_query="{env=\"candidate-a\",service=\"database-reliability-readmitter\"} | json | event=\"feature.node_reliability.transition\" | action=\"readmitted\" | nodeId=\"$TARGET_NODE_ID\" | environment=\"candidate-a\" | incidentId=\"$incident_id\" | buildSha=\"$PLATFORM_BUILD_SHA\""
readmit_audit=$(curl -fsS --get --max-time 10 -H "Authorization: $LOKI_AUTH_HEADER" \
  --data-urlencode "query=$readmit_log_query" --data-urlencode "start=$start_ns" \
  --data-urlencode "end=$now_ns" --data-urlencode 'limit=20' "$LOKI_QUERY_URL")
jq -e --arg incidentId "$incident_id" --arg sha "$PLATFORM_BUILD_SHA" --arg nodeId "$TARGET_NODE_ID" '
  [.data.result[].values[]?[1] | fromjson |
    select(.action == "readmitted" and .incidentId == $incidentId and
      .nodeId == $nodeId and .environment == "candidate-a" and
      .buildSha == $sha)] | length == 1
' <<<"$readmit_audit" >/dev/null || { echo "exact terminal readmission audit missing or ambiguous" >&2; exit 1; }
control_final=$(actuator_get "$control_containment_status_path")
jq -e '.phase == "open"' <<<"$control_final" >/dev/null || { echo "shared control changed during readmission" >&2; exit 1; }
psql -Xv ON_ERROR_STOP=1 \
  -c 'DROP TABLE IF EXISTS public.reliability_noisy_neighbor_fixture'
jq -cn --arg event complete --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  '{event:$event,replayId:$replayId,at:$at,result:"pass"}' >>"$evidence"
echo "$evidence"
