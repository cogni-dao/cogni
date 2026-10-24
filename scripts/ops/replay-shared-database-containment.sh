#!/usr/bin/env bash
# Candidate-only first shared-tier automatic containment proof; leaves NOLOGIN in place.
set -euo pipefail

: "${ALLOW_CANDIDATE_DATABASE_REPLAY:?must equal 1}"
: "${PLATFORM_BUILD_SHA:?exact deployed controller/actuator SHA required}"
: "${CANDIDATE_DOMAIN:?candidate bare domain required}"
: "${FORK_DOMAIN_ROOT:?explicit fleet domain root required}"

[[ "$ALLOW_CANDIDATE_DATABASE_REPLAY" == 1 && "${DEPLOY_ENVIRONMENT:-}" == candidate-a ]] || {
  echo "candidate-a replay not authorized" >&2; exit 2;
}
[[ "$PLATFORM_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "platform SHA must be 40 lowercase hex" >&2; exit 2; }
[[ "$CANDIDATE_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || {
  echo "candidate domain must be a bare lowercase DNS name" >&2; exit 2;
}
command -v git >/dev/null && command -v jq >/dev/null && command -v yq >/dev/null && command -v node >/dev/null

root_dir=$(git rev-parse --show-toplevel)
git -C "$root_dir" cat-file -e "${PLATFORM_BUILD_SHA}^{commit}" 2>/dev/null || {
  echo "platform SHA is not an immutable commit in this repository" >&2; exit 2;
}
snapshot_root=$(mktemp -d)
git -C "$root_dir" archive "$PLATFORM_BUILD_SHA" -- \
  infra/catalog \
  infra/database-budget-profiles.yaml \
  packages/node-contracts/src/reliability-policy.v1.json \
  scripts/ci/lib/image-tags.sh \
  scripts/ci/lib/appset-paths.sh \
  scripts/ci/lib/lane-db-residency.sh \
  scripts/setup/lib/cogni-deployment-identity.sh | tar -x -C "$snapshot_root"
replay_phase=${REPLAY_PHASE:-automatic-containment}
[[ "$replay_phase" == automatic-containment ]] || {
  echo "combined recovery proof unavailable until the independent deadline owner is proven" >&2; exit 2;
}
policy_file="$snapshot_root/packages/node-contracts/src/reliability-policy.v1.json"
budget_profiles_file="$snapshot_root/infra/database-budget-profiles.yaml"
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
dedicated_neighbor_catalog=""
# Parked dedicated slots are evidence exclusions, never prerequisites for this phase.
for file in "$catalog_root"/*.yaml; do
  if [[ "$(yq -N ".reliability_validation.\"${DEPLOY_ENVIRONMENT}\".role // \"\"" "$file")" == dedicated-neighbor ]]; then
    [[ -z "$dedicated_neighbor_catalog" ]] || { echo "dedicated exclusion identity is ambiguous" >&2; exit 2; }
    dedicated_neighbor_catalog=$file
  fi
done
controller_catalog=$(catalog_for_controller)
TARGET_NODE_SLUG=$(yq -er '.name' "$target_catalog")
CONTROL_NODE_SLUG=$(yq -er '.name' "$control_catalog")
DEDICATED_NEIGHBOR_SLUG=""
[[ -z "$dedicated_neighbor_catalog" ]] || DEDICATED_NEIGHBOR_SLUG=$(yq -er '.name' "$dedicated_neighbor_catalog")
CONTROLLER_NODE_SLUG=$(yq -er '.name' "$controller_catalog")
TARGET_NODE_ID=$(catalog_node_id "$target_catalog")
CONTROL_NODE_ID=$(catalog_node_id "$control_catalog")
DEDICATED_NEIGHBOR_ID=""
[[ -z "$dedicated_neighbor_catalog" ]] || DEDICATED_NEIGHBOR_ID=$(catalog_node_id "$dedicated_neighbor_catalog")
CONTROLLER_NODE_ID=$(catalog_node_id "$controller_catalog")
TARGET_NODE_BUILD_SHA=$(catalog_build_sha "$target_catalog")
CONTROL_NODE_BUILD_SHA=$(catalog_build_sha "$control_catalog")
DEDICATED_NEIGHBOR_BUILD_SHA=""
[[ -z "$dedicated_neighbor_catalog" ]] || DEDICATED_NEIGHBOR_BUILD_SHA=$(catalog_build_sha "$dedicated_neighbor_catalog")
CONTROLLER_NODE_BUILD_SHA=$(catalog_build_sha "$controller_catalog")
export CATALOG_DIR="$catalog_root"
# The environment label never authorizes load on a foreign physical instance.
# Use the exact same immutable resolver as authoritative DSN composition.
# shellcheck disable=SC1091
source "$snapshot_root/scripts/ci/lib/appset-paths.sh"
# shellcheck disable=SC1091
source "$snapshot_root/scripts/ci/lib/lane-db-residency.sh"
target_database_environment=$(lane_db_vm_env "$TARGET_NODE_SLUG" "$DEPLOY_ENVIRONMENT")
[[ "$target_database_environment" == candidate-a ]] || {
  echo "shared replay refuses database residency outside candidate-a" >&2; exit 2;
}
target_tier=$(yq -er '.database."candidate-a".tier' "$target_catalog")
target_budget_profile=$(yq -er '.database."candidate-a".budget_profile' "$target_catalog")
[[ "$target_budget_profile" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || {
  echo "catalog target budget profile is invalid" >&2; exit 2;
}
app_connection_limit=$(yq -er ".\"${target_budget_profile}\".roles.app.connection_limit" "$budget_profiles_file")
[[ "$app_connection_limit" =~ ^[0-9]+$ && "$app_connection_limit" -ge 2 ]] || {
  echo "shared app budget must leave a runtime connection alongside replay" >&2; exit 2;
}
# Replay exercises the real app role. Reserve one connection for web requests;
# the dedicated replay owns the separate >=8-client structural saturation gate.
replay_client_limit=$((app_connection_limit - 1))
clients=${REPLAY_CLIENTS:-$replay_client_limit}
[[ "$clients" =~ ^[0-9]+$ && "$clients" -ge 1 && "$clients" -le "$replay_client_limit" ]] || {
  echo "shared replay clients exceed immutable app budget (one runtime connection reserved)" >&2; exit 2;
}
control_tier=$(yq -er '.database."candidate-a".tier' "$control_catalog")
mapfile -t expected_regions < <(jq -er '.expectedRegions[]' "$policy_file")
noisy_neighbor_share=$(jq -er '.noisyNeighborSharePercent' "$policy_file")
serve_window=$(jq -er --arg env "$DEPLOY_ENVIRONMENT" '.serveProbes[$env].evidenceWindow' "$policy_file")
[[ "$target_tier" == shared && "$control_tier" == shared ]] || {
  echo "catalog validation roles differ from the required shared/shared topology" >&2; exit 2;
}
[[ "$TARGET_NODE_ID" =~ ^[0-9a-f-]{36}$ && "$CONTROL_NODE_ID" =~ ^[0-9a-f-]{36}$ ]] || {
  echo "immutable validation identities are invalid" >&2; exit 2;
}
[[ "$TARGET_NODE_ID" != "$CONTROL_NODE_ID" && "$TARGET_NODE_ID" != "$DEDICATED_NEIGHBOR_ID" && "$CONTROL_NODE_ID" != "$DEDICATED_NEIGHBOR_ID" ]] || { echo "immutable validation identities collide" >&2; exit 2; }
[[ "$TARGET_NODE_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "catalog target SHA must be 40 lowercase hex" >&2; exit 2; }
[[ "$CONTROL_NODE_BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "catalog neighbor SHAs must be 40 lowercase hex" >&2; exit 2; }
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
dedicated_neighbor_base=""
[[ -z "$DEDICATED_NEIGHBOR_SLUG" ]] || dedicated_neighbor_base="https://$(host_for_node "$DEDICATED_NEIGHBOR_SLUG" "$CANDIDATE_DOMAIN")"
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
readiness_query=$(printf 'min_over_time(probe_success{environment="%s",node_slug="%s",proof_class="serve"}[%s])' "$DEPLOY_ENVIRONMENT" "$TARGET_NODE_SLUG" "$serve_window")
neighbor_names=("$CONTROL_NODE_SLUG")
neighbor_bases=("$control_base")
neighbor_shas=("$CONTROL_NODE_BUILD_SHA")

plan=$(jq -cn \
  --arg phase "$replay_phase" --arg excludedDedicated "$DEDICATED_NEIGHBOR_SLUG" \
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
  --arg budgetProfile "$target_budget_profile" --argjson appConnectionLimit "$app_connection_limit" --argjson clients "$clients" \
  --arg databaseEnvironment "$target_database_environment" \
  '{phase:$phase,excluded:(if $excludedDedicated == "" then [] else [{node:$excludedDedicated,reason:"preexisting blocked dedicated slot; not part of first shared proof"}] end),platformBuildSha:$platformBuildSha,controller:{slug:$controllerSlug,nodeId:$controllerNodeId,buildSha:$controllerBuildSha,publicBase:$controllerBase,versionUrl:$controllerVersionUrl,actuator:{origin:$actuatorOrigin,statusPath:$actuatorStatusPath,versionUrl:$actuatorVersionUrl},readmitter:{origin:$readmitterOrigin}},validation:{sharedTarget:{slug:$targetSlug,nodeId:$targetNodeId,baseUrl:$targetBase},sharedControl:{slug:$controlSlug,nodeId:$controlNodeId,baseUrl:$controlBase},dedicatedNeighbor:{slug:$dedicatedSlug,nodeId:$dedicatedNodeId,baseUrl:$dedicatedBase}},load:{budgetProfile:$budgetProfile,appConnectionLimit:$appConnectionLimit,clients:$clients,databaseEnvironment:$databaseEnvironment},public:{statusUrl:$publicStatusUrl,readmitUrl:$publicReadmitUrl},openbaoPath:$openbaoPath,readinessQuery:$readinessQuery,containmentTarget:$targetNodeId,readmissionTarget:$targetNodeId}')
if [[ "${REPLAY_PLAN_ONLY:-0}" == 1 ]]; then
  printf '%s\n' "$plan"
  exit 0
fi

: "${RELIABILITY_STATUS_COOKIE_HEADER:?captured human-session Cookie header required for status proof}"
: "${MIMIR_QUERY_URL:?Prometheus-compatible query_range endpoint required for causal timing proof}"
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

actuator_concurrent_control_sample() {
  local expected_phase=$1 receipt
  receipt=$(kubectl -n "$controller_namespace" exec deployment/"$controller_app_deployment" -c app -- \
    node --input-type=module -e '
      const [origin, statusPath, substratePath] = process.argv.slice(1);
      if (process.env.DATABASE_RELIABILITY_ACTUATOR_URL !== origin || !process.env.DATABASE_RELIABILITY_STATUS_TOKEN) process.exit(25);
      const fetchJson = async (path) => {
        const response = await fetch(new URL(path, origin), {
          headers: { authorization: `Bearer ${process.env.DATABASE_RELIABILITY_STATUS_TOKEN}` }, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("private concurrent control read failed");
        return response.json();
      };
      const [status, substrate] = await Promise.all([fetchJson(statusPath), fetchJson(substratePath)]);
      process.stdout.write(JSON.stringify({ status, substrate }));
    ' "$actuator_origin" "$target_containment_status_path" \
    "/v1/internal/substrate?environment=${DEPLOY_ENVIRONMENT}&node_slug=${TARGET_NODE_SLUG}&node_id=${TARGET_NODE_ID}")
  jq -e --arg phase "$expected_phase" --arg nodeId "$TARGET_NODE_ID" --argjson target "$target_database_identity" '
    .status.nodeId == $nodeId and .status.phase == $phase and .status.rolesPresent == true and
    .substrate.serverAddress == $target.address and .substrate.serverPort == $target.port
  ' <<<"$receipt" >/dev/null || { echo "concurrent control/probe read failed" >&2; return 1; }
  jq -cn --arg event concurrent_control_read --arg replayId "$replay_id" --argjson receipt "$receipt" \
    '{event:$event,replayId:$replayId,receipt:$receipt}' >>"$evidence"
}

# Read-only deep probes use independent identities so fencing the target cannot
# make the control evidence disappear. Credentials stay inside their owning pod.
core_neighbor_sample() {
  local database_sample scheduler_sample
  database_sample=$(actuator_get "/v1/internal/substrate?environment=${DEPLOY_ENVIRONMENT}&node_slug=${TARGET_NODE_SLUG}&node_id=${TARGET_NODE_ID}")
  jq -e --argjson target "$target_database_identity" '
    .serverAddress == $target.address and .serverPort == $target.port and
    .latencyMs < 5000 and (.substrateHost | test("^[0-9a-f]{32}$"))
  ' <<<"$database_sample" >/dev/null || { echo "candidate core database deep SLO failed" >&2; return 1; }
  scheduler_sample=$(kubectl -n "$controller_namespace" exec deployment/scheduler-worker -c scheduler-worker -- \
    node --input-type=module -e '
      import { Connection } from "@temporalio/client";
      const started = performance.now();
      const health = await fetch("http://127.0.0.1:9000/readyz", { signal: AbortSignal.timeout(5000) });
      if (!health.ok) process.exit(34);
      const version = await fetch("http://127.0.0.1:9000/version", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
      if (!/^[0-9a-f]{40}$/.test(version.sha)) process.exit(35);
      const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS, connectTimeout: "5s" });
      try {
        const namespace = process.env.TEMPORAL_NAMESPACE;
        const taskQueue = `${process.env.TEMPORAL_TASK_QUEUE}-${process.argv[1]}`;
        const result = await connection.withDeadline(Date.now() + 5000, async () => {
          await connection.workflowService.describeNamespace({ namespace });
          return connection.workflowService.describeTaskQueue({ namespace, taskQueue: { name: taskQueue }, taskQueueType: 1 });
        });
        const recent = (result.pollers ?? []).filter((poller) => {
          const timestamp = Number(poller.lastAccessTime?.seconds ?? 0) * 1000;
          return Date.now() - timestamp >= -15000 && Date.now() - timestamp <= 120000;
        });
        if (recent.length === 0) process.exit(36);
        process.stdout.write(JSON.stringify({ buildSha: version.sha, namespace, taskQueue,
          recentPollers: recent.length, latencyMs: performance.now() - started }));
      } finally { await connection.close(); }
    ' "$CONTROL_NODE_ID")
  jq -e '.latencyMs < 5000 and .recentPollers > 0' <<<"$scheduler_sample" >/dev/null || {
    echo "candidate Scheduler/Temporal deep SLO failed" >&2; return 1;
  }
  jq -cn --arg event core_neighbor_sample --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
    --argjson database "$database_sample" --argjson scheduler "$scheduler_sample" \
    '{event:$event,replayId:$replayId,at:$at,database:$database,schedulerTemporal:$scheduler}' >>"$evidence"
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
# libpq otherwise inherits service/hostaddr/identity settings not visible in
# the URI. The replay accepts its one sealed DSN and no ambient PG routing.
sealed_target_dsn=$PGDATABASE
for inherited_pg_variable in ${!PG@}; do unset "$inherited_pg_variable"; done
PGDATABASE=$sealed_target_dsn
unset sealed_target_dsn
# No fixture, load, or role mutation may precede the actual endpoint boundary.
lane_db_assert_agreement "$TARGET_NODE_SLUG" "$DEPLOY_ENVIRONMENT" "$PGDATABASE" >&2
target_host=$(PGDATABASE="$PGDATABASE" node --input-type=module -e '
  const uri = new URL(process.env.PGDATABASE);
  const slug = process.argv[1];
  const forbidden = new Set(["host", "hostaddr", "port", "dbname", "user", "service", "servicefile"]);
  if (!["postgres:", "postgresql:"].includes(uri.protocol) ||
      decodeURIComponent(uri.username) !== `app_${slug.replaceAll("-", "_")}` ||
      uri.pathname !== `/cogni_${slug.replaceAll("-", "_")}` ||
      uri.port !== "5432" ||
      [...uri.searchParams.keys()].some((key) => forbidden.has(key))) process.exit(22);
  process.stdout.write(uri.hostname);
' "$TARGET_NODE_SLUG")
export PGDATABASE
unset target_secret reader_token reader_jwt
controller_database_identity=$(kubectl -n "$controller_namespace" exec deployment/"$controller_app_deployment" -c app -- \
  node --input-type=module -e '
    import postgres from "postgres";
    const uri = new URL(process.env.DATABASE_SERVICE_URL);
    const forbidden = new Set(["host", "hostaddr", "port", "dbname", "user", "service", "servicefile"]);
    const slug = process.argv[2].replaceAll("-", "_");
    if (!["postgres:", "postgresql:"].includes(uri.protocol) ||
        uri.hostname !== process.argv[1] || uri.port !== "5432" ||
        decodeURIComponent(uri.username) !== `service_${slug}` ||
        uri.pathname !== `/cogni_${slug}` ||
        [...uri.searchParams.keys()].some((key) => forbidden.has(key))) process.exit(23);
    const sql = postgres(uri.toString(), { max: 1, prepare: false, connect_timeout: 5 });
    try {
      await sql.unsafe("SET statement_timeout = 5000");
      const [identity] = await sql.unsafe("SELECT inet_server_addr()::text AS address, inet_server_port() AS port");
      process.stdout.write(JSON.stringify(identity));
    } finally { await sql.end({ timeout: 5 }); }
  ' "$target_host" "$CONTROLLER_NODE_SLUG")
target_database_identity=$(psql -XAtv ON_ERROR_STOP=1 \
  -c "SELECT json_build_object('role',session_user,'database',current_database(),'address',inet_server_addr()::text,'port',inet_server_port())")
jq -en --arg slug "$TARGET_NODE_SLUG" --argjson target "$target_database_identity" \
  --argjson controller "$controller_database_identity" '
  $target.role == ("app_" + ($slug | gsub("-"; "_"))) and
  $target.database == ("cogni_" + ($slug | gsub("-"; "_"))) and
  ($target.address | type == "string" and length > 0) and
  $target.address == $controller.address and $target.port == $controller.port
' >/dev/null || { echo "shared replay database physical identity differs from candidate controller" >&2; exit 2; }
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
rate=${REPLAY_RATE:-$((INCIDENT_REQUEST_RATE * 2))}
contain_timeout=${CONTAIN_TIMEOUT_SECONDS:-300}
evidence=${REPLAY_EVIDENCE_FILE:-shared-database-containment-replay.jsonl}
[[ "$duration" -ge 1800 && "$rate" -ge $((INCIDENT_REQUEST_RATE * 2)) ]] || {
  echo "requires >=1800s and >=2x incident rate within the immutable app budget" >&2; exit 2;
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
# The control's catalog birth pin is not its deployed image. Freeze the actual
# read-only full-SHA baseline now, before fixture mutation, then require it unchanged.
control_baseline_sha=$(curl -fsS --max-time 5 "$control_base/version" | jq -er '.buildSha | select(test("^[0-9a-f]{40}$"))')
control_baseline_ready=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$control_base/readyz?deep=1" || true)
[[ "$control_baseline_ready" == 200 ]] || { echo "shared control deep baseline failed" >&2; exit 1; }
neighbor_shas=("$control_baseline_sha")
jq -cn --arg event control_baseline --arg replayId "$replay_id" --arg node "$CONTROL_NODE_SLUG" \
  --arg nodeId "$CONTROL_NODE_ID" --arg baseUrl "$control_base" --arg actualDeployedBuildSha "$control_baseline_sha" \
  --arg catalogSourceSha "$CONTROL_NODE_BUILD_SHA" \
  '{event:$event,replayId:$replayId,node:$node,nodeId:$nodeId,baseUrl:$baseUrl,actualDeployedBuildSha:$actualDeployedBuildSha,catalogSourceSha:$catalogSourceSha}' >>"$evidence"
target_ready_code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$target_base/readyz?deep=1" || true)
target_observed_sha=$(curl -fsS --max-time 5 "$target_base/version" | jq -er '.buildSha')
[[ "$target_ready_code" == 200 && "$target_observed_sha" == "$TARGET_NODE_BUILD_SHA" ]] || {
  echo "shared target exact-SHA readiness failed" >&2; exit 1;
}

core_neighbor_sample
actuator_concurrent_control_sample open
target_before=$(actuator_get "$target_containment_status_path")
jq -e '.phase == "open"' <<<"$target_before" >/dev/null || { echo "target must be open before load" >&2; exit 1; }

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
  core_neighbor_sample
  sampled_at=$(date -u +%FT%TZ)
  for index in "${!neighbor_bases[@]}"; do
    url=${neighbor_bases[$index]}
    expected_sha=${neighbor_shas[$index]}
    code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$url/readyz?deep=1" || true)
    observed_sha=$(curl -fsS --max-time 5 "$url/version" | jq -er '.buildSha')
    jq -cn --arg event neighbor_sample --arg replayId "$replay_id" --arg at "$sampled_at" \
      --arg node "${neighbor_names[$index]}" --arg url "$url" --arg code "$code" \
      --arg expectedSha "$expected_sha" --arg observedSha "$observed_sha" \
      '{event:$event,replayId:$replayId,at:$at,node:$node,url:$url,httpCode:$code,expectedBuildSha:$expectedSha,observedBuildSha:$observedSha}' >>"$evidence"
    [[ "$code" == 200 && "$observed_sha" == "$expected_sha" ]] || {
      echo "neighbor exact-SHA SLO miss before containment: $url" >&2; exit 1;
    }
  done

  status=$(curl -fsS --max-time 10 -H "Cookie: $RELIABILITY_STATUS_COOKIE_HEADER" "$reliability_status_url")
  state=$(jq -er '.state' <<<"$status")
  if [[ "$state" == contained ]]; then
    jq -e --argjson share "$noisy_neighbor_share" '
      .utilization.evidenceScope == "node" and
      (if (.incidentReason == "critical_io_pressure" or (.incidentReason | contains("I/O pressure critical"))) then
         ((.utilization.databaseShare5m.physicalReadsPct // -1) >= $share or
          (.utilization.databaseShare5m.tempBytesPct // -1) >= $share)
       elif (.incidentReason == "critical_connections" or (.incidentReason | contains("database connections critical"))) then
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
jq -e '.phase == "contained"' <<<"$target_after" >/dev/null || { echo "target containment status not terminal" >&2; exit 1; }
incident_id=$(jq -er '.incidentId' <<<"$target_after")
actuator_concurrent_control_sample contained
core_neighbor_sample

wait "$load_pid" && { echo "hostile load unexpectedly survived containment" >&2; exit 1; } || true
load_pid=

now_ns=$(( $(date +%s) * 1000000000 ))
start_ns=$(( replay_started_epoch * 1000000000 ))
log_query="{env=\"candidate-a\",service=\"database-reliability-actuator\"} | json | event=\"feature.node_reliability.transition\" | nodeId=\"$TARGET_NODE_ID\" | environment=\"candidate-a\" | incidentId=\"$incident_id\" | buildSha=\"$PLATFORM_BUILD_SHA\""
audit=$(curl -fsS --get --max-time 10 -H "Authorization: $LOKI_AUTH_HEADER" \
  --data-urlencode "query=$log_query" --data-urlencode "start=$start_ns" \
  --data-urlencode "end=$now_ns" --data-urlencode 'limit=100' "$LOKI_QUERY_URL")
audit_rows=$(jq -ce --arg incidentId "$incident_id" --arg sha "$PLATFORM_BUILD_SHA" --arg nodeId "$TARGET_NODE_ID" '
  [.data.result[].values[]?[1] | fromjson |
    select(.incidentId == $incidentId and .nodeId == $nodeId and
      .environment == "candidate-a" and .buildSha == $sha)] |
  select(length == 2 and
    (map(.action) | sort) == ["contained", "containment_requested"] and
    all(.[]; .transitionApplied == true) and
    any(.[]; .action == "contained" and .activeSessions == 0 and .reason == "critical_io_pressure"))
' <<<"$audit") || { echo "exact intent+terminal containment audit missing or ambiguous" >&2; exit 1; }
substrate_host=$(actuator_get "/v1/internal/substrate?environment=${DEPLOY_ENVIRONMENT}&node_slug=${TARGET_NODE_SLUG}&node_id=${TARGET_NODE_ID}" | jq -er '.substrateHost | select(test("^[0-9a-f]{32}$"))')
identity="environment=\"candidate-a\",node_slug=\"${TARGET_NODE_SLUG}\",database_tier=\"shared\",budget_profile=\"${target_budget_profile}\",policy_version=\"reliability-status-v1\",substrate_host=\"${substrate_host}\""
io_metric="cogni_reliability_v1_io_pressure_percent{${identity}}"
read_metric="cogni_reliability_v1_database_physical_reads_share_percent{${identity}}"
temp_metric="cogni_reliability_v1_database_temp_bytes_share_percent{${identity}}"
critical_io=$(jq -er '.signals.ioPressurePercent.critical' "$policy_file")
max_skew_seconds=$(jq -er '.maxSignalAttributionSkewMs / 1000' "$policy_file")
ttl_seconds=$(jq -er '.evidenceTtlMs / 1000' "$policy_file")
qualifying_query="timestamp(${io_metric}) and (${io_metric} >= ${critical_io}) and (((${read_metric} >= ${noisy_neighbor_share}) and (abs(timestamp(${io_metric}) - timestamp(${read_metric})) <= ${max_skew_seconds})) or ((${temp_metric} >= ${noisy_neighbor_share}) and (abs(timestamp(${io_metric}) - timestamp(${temp_metric})) <= ${max_skew_seconds}))) and (time() - timestamp(${io_metric}) <= ${ttl_seconds})"
qualifying=$(curl -fsS --get --max-time 15 -H "Authorization: $METRICS_AUTH_HEADER" \
  --data-urlencode "query=$qualifying_query" --data-urlencode "start=$replay_started_epoch" \
  --data-urlencode "end=$(date +%s)" --data-urlencode 'step=15s' "$MIMIR_QUERY_URL")
first_critical_epoch=$(jq -er --arg host "$substrate_host" --arg node "$TARGET_NODE_SLUG" --argjson start "$replay_started_epoch" '
  select(.status == "success" and (.data.result | length == 1)) |
  .data.result[0] | select(.metric.substrate_host == $host and .metric.node_slug == $node) |
  [.values[][1] | tonumber | select(. >= $start)] | select(length > 0) | min
' <<<"$qualifying") || { echo "actual PSI Full critical+causal recorded window not proven" >&2; exit 1; }
raw_query="{__name__=~\"cogni_reliability_v1_(io_pressure_percent|connections_percent|memory_headroom_percent|disk_headroom_percent|database_backends_share_percent|database_physical_reads_share_percent|database_temp_bytes_share_percent)\",${identity}}"
raw_series=$(curl -fsS --get --max-time 15 -H "Authorization: $METRICS_AUTH_HEADER" \
  --data-urlencode "query=$raw_query" --data-urlencode "start=$replay_started_epoch" \
  --data-urlencode "end=$(date +%s)" --data-urlencode 'step=15s' "$MIMIR_QUERY_URL")
AUDIT_ROWS_JSON="$audit_rows" FIRST_CRITICAL_EPOCH="$first_critical_epoch" node --input-type=module -e '
  const row = JSON.parse(process.env.AUDIT_ROWS_JSON).find((event) => event.action === "contained");
  const signalAt = Number(process.env.FIRST_CRITICAL_EPOCH) * 1000;
  for (const value of [row.containedAt, row.databaseObservedAt]) {
    const latency = Date.parse(value) - signalAt;
    if (!Number.isFinite(latency) || latency < -15000 || latency > 60000) process.exit(40);
  }
' || { echo "actual qualifying window to native containment/session drain exceeds60s" >&2; exit 1; }
jq -cn --arg event decisive_causal_timing --arg replayId "$replay_id" \
  --argjson firstCriticalEpoch "$first_critical_epoch" --arg query "$qualifying_query" \
  --argjson qualifying "$qualifying" --argjson rawSeries "$raw_series" --argjson audit "$audit_rows" \
  '{event:$event,replayId:$replayId,firstQualifyingRecordedAtEpoch:$firstCriticalEpoch,maximumContainmentSeconds:60,query:$query,qualifying:$qualifying,rawRecordedSeries:$rawSeries,audit:$audit}' >>"$evidence"
jq -cn --arg event automatic_containment --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  --arg incidentId "$incident_id" '{event:$event,replayId:$replayId,at:$at,incidentId:$incidentId,result:"pass"}' >>"$evidence"

# This phase proves automatic fencing only. Keep the exact incident NOLOGIN;
# no cleanup through the fenced app principal and no readmission claim follows.
jq -cn --arg event complete --arg replayId "$replay_id" --arg incidentId "$incident_id" \
  --arg at "$(date -u +%FT%TZ)" --argjson plan "$plan" \
  '{event:$event,replayId:$replayId,at:$at,incidentId:$incidentId,phase:"automatic-containment",runtimeState:"NOLOGIN",result:"pass",plan:$plan}' >>"$evidence"
echo "$evidence"
