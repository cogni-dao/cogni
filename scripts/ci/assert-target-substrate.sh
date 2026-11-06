#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# assert-target-substrate.sh — fail-loud preflight for catalog target flights.
#
# App flights are digest promotions. They must not repair VM/Compose substrate by
# running deploy-infra.sh. This script verifies the substrate that provision-env /
# explicit infra levers own already exists, then exits without mutating the VM.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${TARGET:?TARGET is required}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-candidate-a}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
COGNI_CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR}/infra/catalog}"

fail() {
  echo "::error::assert-target-substrate: $*" >&2
  exit 1
}

command -v yq >/dev/null 2>&1 || fail "yq is required to read catalog targets"
catalog_file="${COGNI_CATALOG_ROOT}/${TARGET}.yaml"
[ -f "$catalog_file" ] || fail "missing catalog file: $catalog_file"
target_type="$(yq -N '.type // ""' "$catalog_file")"
reliability_controller="$(yq -N '.reliability.controller // false' "$catalog_file")"
case "$reliability_controller" in
  true|false) ;;
  *) fail "reliability.controller must be a boolean for '$TARGET'" ;;
esac
deployment_provider="${DEPLOYMENT_PROVIDER:-k3s}"
case "$deployment_provider" in
  k3s) ;;
  # ONE_WRITER_PER_NODE_LANE (story.5137, CD4): an external-compute (Akash) node lane is
  # deployed only by the node-deploy sequencer. This preflight asserts k3s lanes only.
  akash) fail "node_on_deploy_verb: '$TARGET' on akash is deployed only by the node-deploy sequencer; use POST /api/v1/deploy/workloads" ;;
  *) fail "unsupported DEPLOYMENT_PROVIDER '$deployment_provider' for '$TARGET'" ;;
esac

# shellcheck disable=SC1091 source=./scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"
# shellcheck disable=SC1091 source=./scripts/ci/lib/ssh-retry.sh
source "${SCRIPT_DIR}/lib/ssh-retry.sh"

assert_node_target_substrate() {
local node="$TARGET"
local vm_host="${VM_HOST:-}"
local domain="${DOMAIN:-}"
local ssh_bin="${ASSERT_TARGET_SUBSTRATE_SSH_BIN:-ssh}"
local ssh_opts_raw="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"
local check_dns="${CHECK_DNS:-true}"
local remote_root="${ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT:-}"
local app_wait_attempts="${ASSERT_TARGET_SUBSTRATE_APP_WAIT_ATTEMPTS:-12}"
local app_wait_sleep_seconds="${ASSERT_TARGET_SUBSTRATE_APP_WAIT_SLEEP_SECONDS:-5}"
[ -n "$vm_host" ] || fail "VM_HOST is required for type=node target '$node'"
[ -n "$domain" ] || fail "DOMAIN is required for type=node target '$node'"

contains_node=false
for catalog_node in "${NODE_TARGETS[@]}"; do
  if [ "$catalog_node" = "$node" ]; then
    contains_node=true
    break
  fi
done
"$contains_node" || fail "target '$node' is not a type=node catalog target"

overlay_dir="${APP_SOURCE_DIR}/infra/k8s/overlays/${DEPLOY_ENVIRONMENT}/${node}"
# THE definition, never rebuilt from the env (bug.5204): an akash node's non-production
# lane is reconciled by the PRODUCTION cluster, so its AppSet lives in appsets/production/.
# Asserting the env-only path here would fail a perfectly healthy lane.
# shellcheck source=scripts/ci/lib/appset-paths.sh
CATALOG_DIR="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR}/infra/catalog}" . "$(dirname "${BASH_SOURCE[0]}")/lib/appset-paths.sh"
# WHICH CATALOG. Bash does NOT keep an assignment that prefixes `.` outside POSIX mode, so
# appset-paths' own `: "${CATALOG_DIR:=infra/catalog}"` wins and every later control_env_for
# would silently read the REPO-RELATIVE catalog instead of APP_SOURCE_DIR's. Name it once and
# pass it to every catalog reader below.
local catalog_dir="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR}/infra/catalog}"
appset_file="${APP_SOURCE_DIR}/$(CATALOG_DIR="$catalog_dir" appset_rel_path "$DEPLOY_ENVIRONMENT" "$node")"

[ -d "$overlay_dir" ] || fail "missing overlay dir: $overlay_dir"
[ -f "$appset_file" ] || fail "missing per-target AppSet file: $appset_file"

# THE LANE IS PART OF THE QUESTION (bug.5299). This call passed NO lane, so for a
# foreign-custodied lane it named the LANELESS husk (`cogni_<node>`) and then asserted that
# husk against the VM this preflight happens to have SSH'd into. Both assertions below
# therefore passed for the wrong reason: they proved an unused database exists somewhere,
# never that THIS lane's database exists. `node_database_for_target <node> <lane>` is the one
# lane-aware derivation (`lane-db-two-derivations`) that reconcile-node-substrate.sh:230 —
# the writer — already calls, so this makes the reader agree with the writer.
#
# ZERO BEHAVIOUR CHANGE TODAY, BY CONSTRUCTION: every lane that reaches this function is a
# k3s lane (an akash lane is refused above: node-deploy owns it), and a k3s lane's
# control env IS its own env, so `lane_db_suffix` is empty and the name is byte-identical to
# the laneless one. What changes is that an akash row arriving here — e.g. a caller that
# forgot DEPLOYMENT_PROVIDER — can no longer be green on the husk.
node_db="$(CATALOG_DIR="$catalog_dir" node_database_for_target "$node" "$DEPLOY_ENVIRONMENT")" || exit 1
# WHOSE INSTANCE, not what name. A unique name on production's Postgres is still production's
# failure domain, which is the whole of bug.5299. Catalog-derived, no live DB; warns for the
# four ledgered violations and fails closed for anything new. The authoritative, always-run
# form of this gate is the static scripts/ci/tests/lane-db-residency.test.sh — this call is
# the per-flight echo of it.

# shellcheck source=scripts/ci/lib/lane-db-residency.sh
. "${SCRIPT_DIR}/lib/lane-db-residency.sh"
CATALOG_DIR="$catalog_dir" lane_db_residency_check "$node" "$DEPLOY_ENVIRONMENT" \
  || fail "lane database residency check failed for ${node}/${DEPLOY_ENVIRONMENT}"
node_host="$(host_for_node "$node" "$domain")"
node_port="$(node_port_for_target "$node")" || exit 1
edge_key="$(printf '%s' "$node" | tr '[:lower:]-' '[:upper:]_')"
if is_primary_host "$node"; then
  edge_key="${edge_key}_UPSTREAM"
else
  edge_key="${edge_key}_DOMAIN"
fi

if [ "$check_dns" = "true" ]; then
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required for node substrate DNS check}"
  : "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID required for node substrate DNS check}"
  : "${FORK_DOMAIN_ROOT:?FORK_DOMAIN_ROOT required for node substrate DNS check}"
  # shellcheck disable=SC1091 source=./scripts/ci/lib/cloudflare-dns.sh
  source "${SCRIPT_DIR}/lib/cloudflare-dns.sh"
  vm_ip="$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$domain")"
  [ -n "$vm_ip" ] || fail "apex A record '$domain' missing; provision the env before node-ref flight"
  node_ip="$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$node_host")"
  [ "$node_ip" = "$vm_ip" ] || fail "node DNS missing or drifted: ${node_host} resolves to '${node_ip:-none}', want ${vm_ip}"
fi

remote_script=$(mktemp)
trap 'rm -f "$remote_script"' EXIT
cat > "$remote_script" <<'REMOTE'
#!/usr/bin/env bash
set -uo pipefail

env_name="$1"
node="$2"
node_db="$3"
node_host="$4"
edge_key="$5"
node_port="$6"
app_wait_attempts="$7"
app_wait_sleep_seconds="$8"
reliability_controller="${9}"
remote_root="${10:-}"

namespace="cogni-${env_name}"
app_name="${env_name}-${node}"
appset_name="cogni-${env_name}-${node}"
workload_name="${node}-node-app"
expected_secret_name="${node}-env-secrets"
edge_env="${remote_root}/opt/cogni-template-edge/.env"
caddyfile="${remote_root}/opt/cogni-template-edge/configs/Caddyfile.tmpl"
runtime_env="${remote_root}/opt/cogni-template-runtime/.env"
edge_compose=(docker compose --project-name cogni-edge --env-file "$edge_env" -f "${remote_root}/opt/cogni-template-edge/docker-compose.yml")
runtime_compose=(docker compose --project-name cogni-runtime --env-file "$runtime_env" -f "${remote_root}/opt/cogni-template-runtime/docker-compose.yml")
failed=0
failures=()

mark_fail() {
  failures+=("$*")
  echo "::error::assert-target-substrate: $*" >&2
  echo "[FAIL] $*" >&2
  failed=1
}

mark_ok() {
  echo "[OK] $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || mark_fail "missing command on VM: $1"
}

require_cmd kubectl
require_cmd docker

if kubectl get namespace "$namespace" >/dev/null 2>&1; then
  mark_ok "namespace exists: $namespace"
else
  mark_fail "namespace missing: $namespace"
fi

if [ "$reliability_controller" = true ]; then
  for secret_contract in \
    "database-reliability-actuator-env-secrets:DATABASE_RELIABILITY_ADMIN_URL,DATABASE_RELIABILITY_STATUS_TOKEN"; do
    secret_name="${secret_contract%%:*}"
    key_csv="${secret_contract#*:}"
    if ! kubectl -n "$namespace" get secret "$secret_name" >/dev/null 2>&1; then
      mark_fail "database reliability Secret missing: $secret_name"
      continue
    fi
    IFS=',' read -r -a required_control_keys <<<"$key_csv"
    for required_control_key in "${required_control_keys[@]}"; do
      if [ -n "$(kubectl -n "$namespace" get secret "$secret_name" -o jsonpath="{.data.${required_control_key}}" 2>/dev/null || true)" ]; then
        mark_ok "database reliability Secret $secret_name carries $required_control_key"
      else
        mark_fail "database reliability Secret $secret_name missing $required_control_key"
      fi
    done
  done

fi

if kubectl -n argocd get applicationset "$appset_name" >/dev/null 2>&1; then
  mark_ok "ApplicationSet exists: $appset_name"
else
  mark_fail "ApplicationSet missing: $appset_name"
fi

app_ready=false
for _ in $(seq 1 "$app_wait_attempts"); do
  if kubectl -n argocd get application "$app_name" >/dev/null 2>&1; then
    app_ready=true
    break
  fi
  sleep "$app_wait_sleep_seconds"
done
if $app_ready; then
  mark_ok "Argo Application exists: $app_name"
else
  mark_fail "Argo Application missing after AppSet reconcile: $app_name"
fi

if kubectl -n "$namespace" get deployment "$workload_name" >/dev/null 2>&1; then
  mark_ok "Deployment exists: $workload_name"
else
  mark_fail "Deployment missing: $workload_name"
fi

if kubectl -n "$namespace" get service "$workload_name" >/dev/null 2>&1; then
  service_node_port="$(kubectl -n "$namespace" get service "$workload_name" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)"
  if [ "$service_node_port" = "$node_port" ]; then
    mark_ok "Service NodePort matches catalog: $workload_name -> $node_port"
  else
    mark_fail "Service NodePort mismatch for $workload_name: got '${service_node_port:-none}', want $node_port"
  fi
else
  mark_fail "Service missing: $workload_name"
fi

runtime_secret_names="$(
  kubectl -n "$namespace" get deployment "$workload_name" \
    -o jsonpath='{.spec.template.spec.containers[*].envFrom[*].secretRef.name}{" "}{.spec.template.spec.containers[*].env[*].valueFrom.secretKeyRef.name}' \
  2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
)"
init_secret_names="$(
  kubectl -n "$namespace" get deployment "$workload_name" \
    -o jsonpath='{.spec.template.spec.initContainers[*].envFrom[*].secretRef.name}{" "}{.spec.template.spec.initContainers[*].env[*].valueFrom.secretKeyRef.name}' \
  2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
)"
migration_secret_name="${node}-migration-secrets"

if [ -z "$runtime_secret_names" ]; then
  mark_fail "Deployment app runtime has no consumed Secret refs: $workload_name"
else
  while IFS= read -r consumed_secret; do
    [ -n "$consumed_secret" ] || continue
    if [ "$consumed_secret" = "${node}-node-app-secrets" ]; then
      mark_fail "Deployment app runtime consumes legacy plain Secret ${consumed_secret}; expected ${expected_secret_name}"
    elif [ "$consumed_secret" != "$expected_secret_name" ]; then
      mark_fail "Deployment app runtime consumes unexpected Secret ${consumed_secret}; expected only ${expected_secret_name}"
    fi
  done <<< "$runtime_secret_names"
fi

if ! grep -Fxq "$migration_secret_name" <<< "$init_secret_names"; then
  mark_fail "Deployment migration initContainer does not consume ${migration_secret_name}"
fi
while IFS= read -r consumed_secret; do
  [ -n "$consumed_secret" ] || continue
  case "$consumed_secret" in
    "$expected_secret_name"|"$migration_secret_name") ;;
    "${node}-node-app-secrets")
      mark_fail "Deployment initContainer consumes legacy plain Secret ${consumed_secret}"
      ;;
    *)
      mark_fail "Deployment initContainer consumes unexpected Secret ${consumed_secret}; expected ${expected_secret_name} and ${migration_secret_name}"
      ;;
  esac
done <<< "$init_secret_names"

consumed_secret_names="$(printf '%s\n%s\n' "$runtime_secret_names" "$init_secret_names" | sed '/^$/d' | sort -u)"
while IFS= read -r consumed_secret; do
  [ -n "$consumed_secret" ] || continue

  # Argo can apply the Deployment and ExternalSecret in the same sync wave. Wait
  # for ESO's Ready condition before reading the owned Secret; a one-shot status
  # read races the controller and made a healthy cold-start flight fail.
  if kubectl -n "$namespace" wait --for=condition=Ready "externalsecret/${consumed_secret}" --timeout=120s >/dev/null 2>&1; then
    mark_ok "Deployment-consumed ExternalSecret Ready=True: $consumed_secret"
  elif kubectl -n "$namespace" get externalsecret "$consumed_secret" >/dev/null 2>&1; then
    mark_fail "Deployment-consumed ExternalSecret not Ready=True: $consumed_secret"
  else
    mark_fail "ExternalSecret missing for Deployment-consumed Secret: $consumed_secret"
  fi

  if kubectl -n "$namespace" get secret "$consumed_secret" >/dev/null 2>&1; then
    mark_ok "Deployment-consumed Secret exists: $consumed_secret"
  else
    mark_fail "ESO-synced Secret missing: $consumed_secret"
  fi
done <<< "$consumed_secret_names"

# DSN keys must be materialized into the node Secret (reconcile seeds all three
# today; secret-materialize owns them once per-node DB creds land). Fail loud if
# the ESO-synced Secret lacks any DSN so a missing/empty-DSN node can never ship
# green (DATABASE_SERVICE_URL → scheduler-worker, DOLTGRES_URL → knowledge).
if kubectl -n "$namespace" get secret "$expected_secret_name" >/dev/null 2>&1; then
  for dsn_key in DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_URL; do
    if [ -n "$(kubectl -n "$namespace" get secret "$expected_secret_name" -o jsonpath="{.data.${dsn_key}}" 2>/dev/null)" ]; then
      mark_ok "node Secret carries DSN key: ${dsn_key}"
    else
      mark_fail "node Secret ${expected_secret_name} missing DSN key ${dsn_key}; materialize/reconcile did not write it"
    fi
  done
fi
if kubectl -n "$namespace" get secret "$migration_secret_name" >/dev/null 2>&1; then
  if [ -n "$(kubectl -n "$namespace" get secret "$migration_secret_name" -o jsonpath='{.data.DATABASE_MIGRATION_URL}' 2>/dev/null)" ]; then
    mark_ok "migration Secret carries DATABASE_MIGRATION_URL"
  else
    mark_fail "migration Secret ${migration_secret_name} missing DATABASE_MIGRATION_URL"
  fi
fi

if [ -f "$edge_env" ]; then
  if grep -Eq "^${edge_key}=" "$edge_env"; then
    mark_ok "edge env carries $edge_key for $node_host"
  else
    mark_fail "edge env missing $edge_key in $edge_env"
  fi
else
  mark_fail "edge env file missing: $edge_env"
fi

if [ -f "$caddyfile" ]; then
  # Candidate substrate writes the fully materialized runtime file before atomically
  # loading it into Caddy. Assert that durable file, not the retired env-placeholder
  # template shape; the live-config check below independently proves Caddy loaded it.
  caddy_route_ok=true
  grep -Fq "${node_host} {" "$caddyfile" || caddy_route_ok=false
  grep -Fq "host.docker.internal:${node_port}" "$caddyfile" || caddy_route_ok=false
  if "$caddy_route_ok"; then
    mark_ok "Caddyfile declares route for $node_host (edge_key=$edge_key)"
  else
    mark_fail "Caddyfile missing route for ${node_host} / node_port ${node_port}"
  fi
else
  mark_fail "Caddyfile missing: $caddyfile"
fi

if "${edge_compose[@]}" ps -q caddy >/dev/null 2>&1; then
  mark_ok "Caddy compose service exists"
  live_config="$("${edge_compose[@]}" exec -T caddy wget -qO- http://127.0.0.1:2019/config/ </dev/null 2>/dev/null || true)"
  if printf '%s' "$live_config" | grep -Fq "$node_host" && printf '%s' "$live_config" | grep -Fq "host.docker.internal:${node_port}"; then
    mark_ok "live Caddy config carries $node_host -> host.docker.internal:${node_port}"
  else
    mark_fail "live Caddy config missing ${node_host} / host.docker.internal:${node_port}"
  fi
else
  mark_fail "Caddy compose service not present"
fi

if [ -f "$runtime_env" ]; then
  set -a
  # shellcheck disable=SC1090
  if source "$runtime_env"; then
    set +a
    # WHICH NAME DOES THIS COMPARE AGAINST (bug.5299, deliberate decision)?
    # THE LANE-AWARE ONE — i.e. the same $node_db as the pg_database probe below, not a
    # second laneless re-derivation and not a check scoped away to control==lane lanes.
    #
    # WHY, in writer terms. COGNI_NODE_DBS has two writers and only one of them is per-lane:
    #   deploy-infra.sh:484  `COGNI_NODE_DBS="$(node_database_csv)"` — laneless, env-blind,
    #     writes the initial fleet roster of `cogni_<node>` names at env provision time.
    #   reconcile-node-substrate.sh:230+578 — `node_database_for_target <node> <lane>`,
    #     already lane-aware, and APPENDS that exact name to this file for the (node, lane)
    #     it reconciled, on the control env's VM.
    # The reconciler is the writer that runs per lane, so the lane-aware name is precisely
    # what this inventory is guaranteed to contain after the lane has been reconciled.
    # Comparing against the laneless name would assert something no per-lane writer promises.
    #
    # WHY IT CANNOT REGRESS ANYTHING: this function only ever runs for a k3s lane, whose
    # control env is its own env, so lane_db_suffix is empty and the lane-aware name is
    # byte-identical to the laneless one. Splitting the assertion or scoping it to
    # control==lane lanes would therefore add a branch that no input can distinguish today,
    # while hiding the one case that matters — a foreign lane whose database was never
    # reconciled onto this host at all.
    case ",${COGNI_NODE_DBS:-}," in
      *",${node_db},"*) mark_ok "runtime env includes DB inventory: $node_db" ;;
      *) mark_fail "runtime env COGNI_NODE_DBS missing $node_db" ;;
    esac
  else
    set +a
    mark_fail "runtime env file is not sourceable: $runtime_env"
  fi
else
  mark_fail "runtime env file missing: $runtime_env"
fi

if "${runtime_compose[@]}" ps -q postgres >/dev/null 2>&1; then
  if "${runtime_compose[@]}" exec -T postgres psql -U "${POSTGRES_ROOT_USER:-postgres}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${node_db}'" </dev/null 2>/dev/null | tr -d '[:space:]' | grep -qx 1; then
    mark_ok "Postgres database exists: $node_db"
  else
    mark_fail "Postgres database missing: $node_db"
  fi
else
  mark_fail "Postgres compose service not present"
fi

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "Node substrate is not ready for ${node} in ${env_name}: ${#failures[@]} failure(s)."
  printf '  - %s\n' "${failures[@]}"
  echo "Remediation: run the env provisioning lane or candidate-flight-infra.yml; app candidate-flight will not run deploy-infra implicitly."
  exit 1
fi

echo "Node substrate ready for ${node} in ${env_name}: all checks passed."
REMOTE

local ssh_opts=()
read -r -a ssh_opts <<< "$ssh_opts_raw"
probe_log=$(mktemp)
# OpenSSH reconstructs shell text, not argv. Quote every word and keep the
# optional root last so required controller identity never shifts.
local remote_command
printf -v remote_command '%q ' bash -s -- \
  "$DEPLOY_ENVIRONMENT" "$node" "$node_db" "$node_host" "$edge_key" "$node_port" \
  "$app_wait_attempts" "$app_wait_sleep_seconds" \
  "$reliability_controller" "$remote_root"
set +e
"$ssh_bin" "${ssh_opts[@]}" "root@${vm_host}" "$remote_command" \
  < "$remote_script" 2>&1 | tee "$probe_log"
ssh_rc=${PIPESTATUS[0]}
set -e
if grep -Eq '(^|\r)(\[FAIL\]|::error::assert-target-substrate:)' "$probe_log"; then
  failure_count="$(grep -Ec '(^|\r)\[FAIL\]' "$probe_log" || true)"
  echo "::error::assert-target-substrate: remote substrate probe emitted ${failure_count} failure(s); see [FAIL] lines above" >&2
  rm -f "$probe_log"
  return 1
fi
rm -f "$probe_log"
return "$ssh_rc"
}

case "$target_type" in
  node)
    assert_node_target_substrate
    ;;
  service)
    fail "type=service substrate assertion is not implemented yet for target '$TARGET'; declare the service k8s/Argo/Secret/ExternalSecret/ConfigMap contract before enabling app-flight substrate assertions for services"
    ;;
  infra)
    fail "type=infra target '$TARGET' is deployed/asserted by candidate-flight-infra/deploy-infra today; app candidate-flight will not pretend Argo owns this substrate"
    ;;
  "")
    fail "catalog target '$TARGET' is missing .type"
    ;;
  *)
    fail "unsupported catalog target type '$target_type' for '$TARGET'"
    ;;
esac
