#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t assert-target-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

FAKEBIN="$TMPROOT/bin"
REMOTE_ROOT="$TMPROOT/remote"
mkdir -p "$FAKEBIN" "$REMOTE_ROOT/opt/cogni-template-edge/configs" "$REMOTE_ROOT/opt/cogni-template-runtime"

cat > "$REMOTE_ROOT/opt/cogni-template-edge/.env" <<'EOF'
NODE_TEMPLATE_DOMAIN=node-template-test.cognidao.org
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-edge/configs/Caddyfile.tmpl" <<'EOF'
node-template-test.cognidao.org {
  reverse_proxy host.docker.internal:30200
}
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
COGNI_NODE_DBS=cogni_operator,cogni_node_template
POSTGRES_ROOT_USER=postgres
EOF
touch "$REMOTE_ROOT/opt/cogni-template-edge/docker-compose.yml"
touch "$REMOTE_ROOT/opt/cogni-template-runtime/docker-compose.yml"

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [[ "$1" != root@* ]]; do
  shift
done
[ "$#" -gt 0 ] || { echo "fake ssh: missing remote host" >&2; exit 2; }
shift
# OpenSSH joins command arguments; the remote login shell reparses that text.
# Direct argv execution hid the missing empty positional in the real flight.
if [ "${FAKE_SSH_ASSERT_POSITIONALS:-}" = 1 ]; then
  remote_header=$(sed '/^namespace=/,$d')
  {
    printf '%s\n' "$remote_header"
    printf '%s\n' 'printf "ARGV\t%s\t%s\t%s\n" "$#" "$remote_root" "$reliability_controller"'
    printf '%s\n' 'printf "WIRE\t%s\t%s\n" "${9}" "${10:-}"'
  } | PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$*"
elif [[ -n "${FAKE_EGRESS_TRANSPORT:-}" ]]; then
  remote_script="$(cat)"
  case "$FAKE_EGRESS_TRANSPORT" in
    corrupt) replacement='egress_rules_b64="%%%"' ;;
    empty) replacement='egress_rules_b64=""' ;;
    *) exit 2 ;;
  esac
  remote_script="${remote_script/'egress_rules_b64="$4"'/$replacement}"
  printf '%s\n' "$remote_script" | PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$*"
else
  PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$*"
fi
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
ns=""
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n) ns="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"
if [ "${1:-}" = "get" ]; then
  kind="${2:-}"
  name="${3:-}"
  case "${ns}:${kind}:${name}" in
    ":namespace:cogni-candidate-a")
      [ "${FAKE_MISSING_NAMESPACE:-}" = "1" ] && exit 1
      exit 0
      ;;
    "argocd:applicationset:cogni-candidate-a-node-template")
      [ "${FAKE_MISSING_APPSET:-}" = "1" ] && exit 1
      exit 0
      ;;
    "argocd:application:candidate-a-node-template")
      [ "${FAKE_MISSING_APPLICATION:-}" = "1" ] && exit 1
      exit 0
      ;;
    "cogni-candidate-a:deployment:node-template-node-app")
      [ "${FAKE_MISSING_DEPLOYMENT:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        if printf '%s\n' "$*" | grep -Fq 'initContainers'; then
          echo "node-template-env-secrets node-template-migration-secrets"
        elif [ "${FAKE_LEGACY_SECRET_CONSUMER:-}" = "1" ]; then
          echo "node-template-node-app-secrets"
        elif [ "${FAKE_WRONG_SECRET_CONSUMER:-}" = "1" ]; then
          echo "other-secret"
        elif [ "${FAKE_RUNTIME_MIGRATION_SECRET_CONSUMER:-}" = "1" ]; then
          echo "node-template-env-secrets node-template-migration-secrets"
        else
          echo "node-template-env-secrets"
        fi
      fi
      exit 0
      ;;
    "cogni-candidate-a:service:node-template-node-app")
      [ "${FAKE_MISSING_SERVICE:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        if [ "${FAKE_SERVICE_NODEPORT_MISMATCH:-}" = "1" ]; then
          echo 39999
        else
          echo 30200
        fi
      fi
      exit 0
      ;;
    "cogni-candidate-a:secret:node-template-env-secrets")
      [ "${FAKE_MISSING_SECRET:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        [ "${FAKE_MISSING_DSN:-}" = "1" ] || echo "cG9zdGdyZXM6Ly8="
      fi
      exit 0
      ;;
    "cogni-candidate-a:secret:node-template-migration-secrets")
      [ "${FAKE_MISSING_MIGRATION_SECRET:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        [ "${FAKE_MISSING_MIGRATION_DSN:-}" = "1" ] || echo "cG9zdGdyZXM6Ly8="
      fi
      exit 0
      ;;
    "cogni-candidate-a:externalsecret:node-template-env-secrets")
      [ "${FAKE_MISSING_EXTERNAL_SECRET:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        [ "${FAKE_EXTERNAL_SECRET_NOT_READY:-}" = "1" ] || echo True
      fi
      exit 0
      ;;
    "cogni-candidate-a:externalsecret:node-template-migration-secrets")
      [ "${FAKE_MISSING_MIGRATION_EXTERNAL_SECRET:-}" = "1" ] && exit 1
      exit 0
      ;;
  esac
fi
if [ "${1:-}" = "wait" ]; then
  resource="${*: -2:1}"
  case "${ns}:${resource}" in
    "cogni-candidate-a:externalsecret/node-template-env-secrets")
      [ "${FAKE_MISSING_EXTERNAL_SECRET:-}" = "1" ] && exit 1
      [ "${FAKE_EXTERNAL_SECRET_NOT_READY:-}" = "1" ] && exit 1
      exit 0
      ;;
    "cogni-candidate-a:externalsecret/node-template-migration-secrets")
      [ "${FAKE_MISSING_MIGRATION_EXTERNAL_SECRET:-}" = "1" ] && exit 1
      [ "${FAKE_MIGRATION_EXTERNAL_SECRET_NOT_READY:-}" = "1" ] && exit 1
      exit 0
      ;;
  esac
fi
echo "fake kubectl: unexpected args ns=${ns} args=$*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/kubectl"

cat > "$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$*" | grep -q ' ps -q caddy'; then
  echo caddy123
  exit 0
fi
if printf '%s\n' "$*" | grep -q ' exec -T caddy wget '; then
  if [ "${FAKE_MISSING_LIVE_CADDY_ROUTE:-}" = "1" ]; then
    echo '{"apps":{"http":{"servers":{}}}}'
  else
    echo '{"host":"node-template-test.cognidao.org","upstream":"host.docker.internal:30200"}'
  fi
  exit 0
fi
if printf '%s\n' "$*" | grep -q ' ps -q postgres'; then
  echo postgres123
  exit 0
fi
if printf '%s\n' "$*" | grep -q ' exec -T postgres psql '; then
  [ "${FAKE_MISSING_DB:-}" = "1" ] || echo 1
  exit 0
fi
echo "fake docker: unexpected args $*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/docker"

cat > "$FAKEBIN/cf-curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *"name=test.cognidao.org&type=A"*)
    echo '{"result":[{"content":"84.32.9.111","proxied":false}]}'
    ;;
  *"name=node-template-test.cognidao.org&type=A"*)
    echo '{"result":[{"content":"84.32.9.111","proxied":false}]}'
    ;;
  *)
    echo '{"result":[]}'
    ;;
esac
EOF
chmod +x "$FAKEBIN/cf-curl"

# HAPPY-PATH SOURCE TREE — built, not borrowed. This suite exercises the SCRIPT's
# preflight logic for one (env, target) pair; it is not a statement about which nodes the
# live catalog deploys where. Pointing APP_SOURCE_DIR at the repo made it both, so
# task.5130 (removing the last cogni-dao nodes from the candidate-a TEST-wallet env, which
# deleted appsets/candidate-a/candidate-a-node-template-applicationset.yaml) turned this
# unit test red for a reason that has nothing to do with the code under test. The tree
# below carries exactly the three artifacts the k3s branch reads — catalog row, overlay
# dir, per-target AppSet file — so the negative fixtures further down (each of which omits
# ONE of them) remain the only thing asserting those reads.
HAPPY_TREE="$TMPROOT/happy"
mkdir -p "$HAPPY_TREE/infra/catalog" \
  "$HAPPY_TREE/infra/k8s/overlays/candidate-a/node-template" \
  "$HAPPY_TREE/infra/k8s/argocd/appsets/candidate-a"
cp infra/catalog/node-template.yaml "$HAPPY_TREE/infra/catalog/node-template.yaml"
# The k3s branch reads only that the overlay dir exists.
touch "$HAPPY_TREE/infra/k8s/overlays/candidate-a/node-template/kustomization.yaml"
# Derive both the AppSet path and its directory from the copied catalog. Candidate
# compute custody may be production even while this fixture exercises k3s probes;
# spelling the directory by hand breaks when normal env membership is enabled.
# shellcheck source=scripts/ci/lib/appset-paths.sh
CATALOG_DIR="$HAPPY_TREE/infra/catalog" . "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
happy_appset="$HAPPY_TREE/$(CATALOG_DIR="$HAPPY_TREE/infra/catalog" appset_rel_path candidate-a node-template)"
mkdir -p "$(dirname "$happy_appset")"
bash scripts/ci/render-node-appset.sh candidate-a node-template > "$happy_appset"

BASE_ENV=(
  TARGET=node-template
  DEPLOY_ENVIRONMENT=candidate-a
  VM_HOST=192.0.2.10
  DOMAIN=test.cognidao.org
  APP_SOURCE_DIR="$HAPPY_TREE"
  COGNI_CATALOG_ROOT="$HAPPY_TREE/infra/catalog"
  CHECK_DNS=false
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh"
  ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT="$REMOTE_ROOT"
  ASSERT_TARGET_SUBSTRATE_APP_WAIT_ATTEMPTS=1
  ASSERT_TARGET_SUBSTRATE_APP_WAIT_SLEEP_SECONDS=0
  FAKE_REMOTE_PATH="$FAKEBIN"
)

env "${BASE_ENV[@]}" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/success.out"
grep -q "Node substrate ready for node-template" "$TMPROOT/success.out"
# bug.5299 — the preflight states WHOSE Postgres the lane's database is on, not just that
# some database exists. node-template/candidate-a is reconciled by its own env, so this is
# the resident verdict and the asserted name is unchanged (lane_db_suffix is empty).
grep -q "\[OK\] lane database residency: node-template/candidate-a uses its own environment" "$TMPROOT/success.out"
grep -q "runtime env includes DB inventory: cogni_node_template" "$TMPROOT/success.out"

# Run the real generated argument decoder through both shell layers, stopping
# before any remote probe. The controller flag precedes the optional root at10.
for probe_root in "" "$REMOTE_ROOT" "$TMPROOT/remote root' ; literal"; do
  if ! env "${BASE_ENV[@]}" TARGET=operator APP_SOURCE_DIR="$REPO_ROOT" \
    COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" \
    ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT="$probe_root" \
    FAKE_SSH_ASSERT_POSITIONALS=1 \
    bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/argv.out"; then
    cat "$TMPROOT/argv.out" >&2
    exit 1
  fi
  printf 'ARGV\t10\t%s\ttrue\n' "$probe_root" >"$TMPROOT/argv.expected"
  printf 'WIRE\ttrue\t%s\n' "$probe_root" >>"$TMPROOT/argv.expected"
  grep -E '^(ARGV|WIRE)' "$TMPROOT/argv.out" >"$TMPROOT/argv.actual"
  cmp "$TMPROOT/argv.expected" "$TMPROOT/argv.actual"
done

# bug.5299 — A MISRESIDENT LANE CANNOT BE GREEN ON THE LANELESS HUSK.
# Foreign COMPUTE custody is now valid with lane-local Postgres. Inject an explicit
# historical PG pin into a copied existing reader instead: the residency gate must
# reject that actual foreign PG placement before claiming a local database exists.
MISRESIDENT_TREE="$TMPROOT/misresident-src"
mkdir -p "$MISRESIDENT_TREE"
cp -R "$HAPPY_TREE/." "$MISRESIDENT_TREE/"
yq -i '.deployment_provider."candidate-a" = "akash"' "$MISRESIDENT_TREE/infra/catalog/node-template.yaml"
# Placement moves the control env, so it also moves the AppSet directory (bug.5204). Park a
# copy at the relocated path so the EARLIER appset-existence check cannot absorb this case —
# the residency gate is what must produce the verdict.
misresident_appset="$MISRESIDENT_TREE/$(CATALOG_DIR="$MISRESIDENT_TREE/infra/catalog" appset_rel_path candidate-a node-template)"
mkdir -p "$(dirname "$misresident_appset")"
cp "$HAPPY_TREE/$(CATALOG_DIR="$HAPPY_TREE/infra/catalog" appset_rel_path candidate-a node-template)" \
  "$misresident_appset"
MISRESIDENT_SCRIPT="$TMPROOT/misresident-reader"
mkdir -p "$MISRESIDENT_SCRIPT/lib"
cp scripts/ci/assert-target-substrate.sh "$MISRESIDENT_SCRIPT/"
cp scripts/ci/lib/*.sh "$MISRESIDENT_SCRIPT/lib/"
printf '\nLANE_DB_RESIDENCY_PINNED=("node-template/candidate-a")\n' \
  >> "$MISRESIDENT_SCRIPT/lib/lane-db-residency.sh"
if env "${BASE_ENV[@]}" APP_SOURCE_DIR="$MISRESIDENT_TREE" \
  COGNI_CATALOG_ROOT="$MISRESIDENT_TREE/infra/catalog" \
  bash "$MISRESIDENT_SCRIPT/assert-target-substrate.sh" >"$TMPROOT/misresident.out" 2>&1; then
  echo "expected an explicitly foreign PG lane to fail the substrate preflight" >&2
  exit 1
fi
grep -q "node-template/candidate-a must use its own environment's Postgres; foreign residency is forbidden" "$TMPROOT/misresident.out"
grep -q "lane database residency check failed for node-template/candidate-a" "$TMPROOT/misresident.out"
# It must fail on RESIDENCY, before claiming anything about the husk on this host.
if grep -q "Postgres database exists: cogni_node_template" "$TMPROOT/misresident.out"; then
  echo "expected no husk verdict once the lane is known to be misresident" >&2
  exit 1
fi

env "${BASE_ENV[@]}" CHECK_DNS=true \
  CLOUDFLARE_API_TOKEN=test-token CLOUDFLARE_ZONE_ID=zone123 FORK_DOMAIN_ROOT=cognidao.org \
  CF_CURL="$FAKEBIN/cf-curl" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/scoped-dns.out"
grep -q "Node substrate ready for node-template" "$TMPROOT/scoped-dns.out"

if env TARGET=node-template DEPLOY_ENVIRONMENT=candidate-a VM_HOST="" DOMAIN=test.cognidao.org \
  APP_SOURCE_DIR="$HAPPY_TREE" COGNI_CATALOG_ROOT="$HAPPY_TREE/infra/catalog" CHECK_DNS=false \
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-vm.out" 2>&1; then
  echo "expected missing VM_HOST to fail" >&2
  exit 1
fi
grep -q "VM_HOST is required" "$TMPROOT/missing-vm.out"

if env "${BASE_ENV[@]}" APP_SOURCE_DIR="$TMPROOT/no-catalog" COGNI_CATALOG_ROOT="$TMPROOT/no-catalog/infra/catalog" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-catalog.out" 2>&1; then
  echo "expected missing catalog to fail" >&2
  exit 1
fi
grep -q "missing catalog file" "$TMPROOT/missing-catalog.out"

mkdir -p "$TMPROOT/no-overlay/infra/catalog"
cp infra/catalog/node-template.yaml "$TMPROOT/no-overlay/infra/catalog/node-template.yaml"
if env "${BASE_ENV[@]}" APP_SOURCE_DIR="$TMPROOT/no-overlay" COGNI_CATALOG_ROOT="$TMPROOT/no-overlay/infra/catalog" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-overlay.out" 2>&1; then
  echo "expected missing overlay to fail" >&2
  exit 1
fi
grep -q "missing overlay dir" "$TMPROOT/missing-overlay.out"

mkdir -p "$TMPROOT/no-appset/infra/catalog" "$TMPROOT/no-appset/infra/k8s/overlays/candidate-a/node-template"
cp infra/catalog/node-template.yaml "$TMPROOT/no-appset/infra/catalog/node-template.yaml"
if env "${BASE_ENV[@]}" APP_SOURCE_DIR="$TMPROOT/no-appset" COGNI_CATALOG_ROOT="$TMPROOT/no-appset/infra/catalog" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-appset-file.out" 2>&1; then
  echo "expected missing appset file to fail" >&2
  exit 1
fi
grep -q "missing per-target AppSet file" "$TMPROOT/missing-appset-file.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_NAMESPACE=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-namespace.out" 2>&1; then
  echo "expected missing namespace to fail" >&2
  exit 1
fi
grep -q "namespace missing" "$TMPROOT/missing-namespace.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_APPSET=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-appset.out" 2>&1; then
  echo "expected missing remote AppSet to fail" >&2
  exit 1
fi
grep -q "ApplicationSet missing" "$TMPROOT/missing-appset.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_APPLICATION=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-application.out" 2>&1; then
  echo "expected missing remote Application to fail" >&2
  exit 1
fi
grep -q "Argo Application missing" "$TMPROOT/missing-application.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_DEPLOYMENT=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-deployment.out" 2>&1; then
  echo "expected missing deployment to fail" >&2
  exit 1
fi
grep -q "Deployment missing" "$TMPROOT/missing-deployment.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_SERVICE=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-service.out" 2>&1; then
  echo "expected missing service to fail" >&2
  exit 1
fi
grep -q "Service missing" "$TMPROOT/missing-service.out"

if env "${BASE_ENV[@]}" FAKE_SERVICE_NODEPORT_MISMATCH=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/service-nodeport-mismatch.out" 2>&1; then
  echo "expected Service NodePort mismatch to fail" >&2
  exit 1
fi
grep -q "Service NodePort mismatch" "$TMPROOT/service-nodeport-mismatch.out"

if env "${BASE_ENV[@]}" FAKE_LEGACY_SECRET_CONSUMER=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/legacy-secret-consumer.out" 2>&1; then
  echo "expected legacy Secret consumer to fail" >&2
  exit 1
fi
grep -q "Deployment app runtime consumes legacy plain Secret node-template-node-app-secrets" "$TMPROOT/legacy-secret-consumer.out"

if env "${BASE_ENV[@]}" FAKE_WRONG_SECRET_CONSUMER=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/wrong-secret-consumer.out" 2>&1; then
  echo "expected wrong Secret consumer to fail" >&2
  exit 1
fi
grep -q "Deployment app runtime consumes unexpected Secret other-secret" "$TMPROOT/wrong-secret-consumer.out"

if env "${BASE_ENV[@]}" FAKE_RUNTIME_MIGRATION_SECRET_CONSUMER=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/runtime-migration-secret-consumer.out" 2>&1; then
  echo "expected app runtime migration Secret consumer to fail" >&2
  exit 1
fi
grep -q "app runtime consumes unexpected Secret node-template-migration-secrets" "$TMPROOT/runtime-migration-secret-consumer.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_SECRET=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-secret.out" 2>&1; then
  echo "expected missing secret to fail" >&2
  exit 1
fi
grep -q "ESO-synced Secret missing" "$TMPROOT/missing-secret.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_EXTERNAL_SECRET=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-external-secret.out" 2>&1; then
  echo "expected missing ExternalSecret to fail" >&2
  exit 1
fi
grep -q "ExternalSecret missing" "$TMPROOT/missing-external-secret.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_MIGRATION_EXTERNAL_SECRET=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-migration-external-secret.out" 2>&1; then
  echo "expected missing migration ExternalSecret to fail" >&2
  exit 1
fi
grep -q "ExternalSecret missing for Deployment-consumed Secret: node-template-migration-secrets" "$TMPROOT/missing-migration-external-secret.out"

if env "${BASE_ENV[@]}" FAKE_EXTERNAL_SECRET_NOT_READY=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/external-secret-not-ready.out" 2>&1; then
  echo "expected not-Ready ExternalSecret to fail" >&2
  exit 1
fi
grep -q "Deployment-consumed ExternalSecret not Ready=True" "$TMPROOT/external-secret-not-ready.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_DSN=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-dsn.out" 2>&1; then
  echo "expected missing DSN key to fail" >&2
  exit 1
fi
grep -q "missing DSN key DATABASE_URL" "$TMPROOT/missing-dsn.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_MIGRATION_DSN=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-migration-dsn.out" 2>&1; then
  echo "expected missing migration DSN key to fail" >&2
  exit 1
fi
grep -q "migration Secret node-template-migration-secrets missing DATABASE_MIGRATION_URL" "$TMPROOT/missing-migration-dsn.out"

if env "${BASE_ENV[@]}" FAKE_MISSING_DB=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-db.out" 2>&1; then
  echo "expected missing DB to fail" >&2
  exit 1
fi
grep -q "Postgres database missing" "$TMPROOT/missing-db.out"

cp "$REMOTE_ROOT/opt/cogni-template-runtime/.env" "$REMOTE_ROOT/opt/cogni-template-runtime/.env.bak"
cat > "$REMOTE_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
COGNI_NODE_DBS=cogni_operator
POSTGRES_ROOT_USER=postgres
EOF
if env "${BASE_ENV[@]}" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-db-inventory.out" 2>&1; then
  echo "expected missing DB inventory to fail" >&2
  exit 1
fi
grep -q "runtime env COGNI_NODE_DBS missing cogni_node_template" "$TMPROOT/missing-db-inventory.out"
mv "$REMOTE_ROOT/opt/cogni-template-runtime/.env.bak" "$REMOTE_ROOT/opt/cogni-template-runtime/.env"

mv "$REMOTE_ROOT/opt/cogni-template-edge/.env" "$REMOTE_ROOT/opt/cogni-template-edge/.env.bak"
if env "${BASE_ENV[@]}" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-edge-env.out" 2>&1; then
  echo "expected missing edge env to fail" >&2
  exit 1
fi
grep -q "edge env file missing" "$TMPROOT/missing-edge-env.out"
mv "$REMOTE_ROOT/opt/cogni-template-edge/.env.bak" "$REMOTE_ROOT/opt/cogni-template-edge/.env"

if env "${BASE_ENV[@]}" FAKE_MISSING_LIVE_CADDY_ROUTE=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-live-caddy.out" 2>&1; then
  echo "expected missing live Caddy route to fail" >&2
  exit 1
fi
grep -q "live Caddy config missing" "$TMPROOT/missing-live-caddy.out"

if env TARGET=node-template DEPLOY_ENVIRONMENT=candidate-a VM_HOST=192.0.2.10 DOMAIN=test.cognidao.org \
  APP_SOURCE_DIR="$HAPPY_TREE" COGNI_CATALOG_ROOT="$HAPPY_TREE/infra/catalog" CHECK_DNS=true \
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-dns.out" 2>&1; then
  echo "expected missing DNS inputs to fail" >&2
  exit 1
fi
grep -q "CLOUDFLARE_API_TOKEN required" "$TMPROOT/missing-dns.out"

# ONE_WRITER_PER_NODE_LANE (story.5137, CD4): an Akash node lane is deployed only by the
# node-deploy sequencer, so the flight substrate preflight refuses it with the stable reason.
if env "${BASE_ENV[@]}" DEPLOYMENT_PROVIDER=akash bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/akash.out" 2>&1; then
  echo "expected an akash node lane to be refused" >&2
  exit 1
fi
grep -q "node_on_deploy_verb" "$TMPROOT/akash.out"
grep -q "POST /api/v1/deploy/workloads" "$TMPROOT/akash.out"

if env TARGET=scheduler-worker DEPLOY_ENVIRONMENT=candidate-a APP_SOURCE_DIR=. COGNI_CATALOG_ROOT=infra/catalog bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/service.out" 2>&1; then
  echo "expected service target to fail explicitly" >&2
  exit 1
fi
grep -q "type=service substrate assertion is not implemented yet" "$TMPROOT/service.out"

if env TARGET=litellm DEPLOY_ENVIRONMENT=candidate-a APP_SOURCE_DIR=. COGNI_CATALOG_ROOT=infra/catalog bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/infra.out" 2>&1; then
  echo "expected infra target to fail explicitly" >&2
  exit 1
fi
grep -q "type=infra target 'litellm' is deployed/asserted by candidate-flight-infra/deploy-infra today" "$TMPROOT/infra.out"

echo "PASS: assert-target-substrate.test.sh"
