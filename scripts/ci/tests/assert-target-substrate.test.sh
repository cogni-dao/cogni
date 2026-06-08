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
CANARY_DOMAIN=canary-test.cognidao.org
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-edge/configs/Caddyfile.tmpl" <<'EOF'
{$CANARY_DOMAIN:canary.localhost} {
  reverse_proxy {$CANARY_UPSTREAM:host.docker.internal:30400}
}
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
COGNI_NODE_DBS=cogni_operator,cogni_canary
POSTGRES_ROOT_USER=postgres
EOF
touch "$REMOTE_ROOT/opt/cogni-template-edge/docker-compose.yml"
touch "$REMOTE_ROOT/opt/cogni-template-runtime/docker-compose.yml"

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [ "$1" != "bash" ]; do
  shift
done
[ "${1:-}" = "bash" ] || { echo "fake ssh: missing bash command" >&2; exit 2; }
shift
[ "${1:-}" = "-s" ] && shift
[ "${1:-}" = "--" ] && shift
PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -s -- "$@"
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
    "argocd:applicationset:cogni-candidate-a-canary")
      [ "${FAKE_MISSING_APPSET:-}" = "1" ] && exit 1
      exit 0
      ;;
    "argocd:application:candidate-a-canary")
      [ "${FAKE_MISSING_APPLICATION:-}" = "1" ] && exit 1
      exit 0
      ;;
    "cogni-candidate-a:deployment:canary-node-app")
      [ "${FAKE_MISSING_DEPLOYMENT:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        echo "canary-node-app-secrets"
      fi
      exit 0
      ;;
    "cogni-candidate-a:service:canary-node-app")
      [ "${FAKE_MISSING_SERVICE:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        if [ "${FAKE_SERVICE_NODEPORT_MISMATCH:-}" = "1" ]; then
          echo 39999
        else
          echo 30400
        fi
      fi
      exit 0
      ;;
    "cogni-candidate-a:secret:canary-node-app-secrets")
      [ "${FAKE_MISSING_SECRET:-}" = "1" ] && exit 1
      exit 0
      ;;
    "cogni-candidate-a:secret:canary-env-secrets") exit 1 ;;
    "cogni-candidate-a:externalsecret:canary-env-secrets") exit 1 ;;
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
    echo '{"host":"canary-test.cognidao.org","upstream":"host.docker.internal:30400"}'
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
  *"name=canary-test.cognidao.org&type=A"*)
    echo '{"result":[{"content":"84.32.9.111","proxied":false}]}'
    ;;
  *"name=resy-test.cognidao.org&type=A"*)
    echo '{"result":[]}'
    ;;
  *)
    echo '{"result":[]}'
    ;;
esac
EOF
chmod +x "$FAKEBIN/cf-curl"

BASE_ENV=(
  TARGET=canary
  DEPLOY_ENVIRONMENT=candidate-a
  VM_HOST=192.0.2.10
  DOMAIN=test.cognidao.org
  APP_SOURCE_DIR=.
  COGNI_CATALOG_ROOT=infra/catalog
  CHECK_DNS=false
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh"
  ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT="$REMOTE_ROOT"
  ASSERT_TARGET_SUBSTRATE_APP_WAIT_ATTEMPTS=1
  ASSERT_TARGET_SUBSTRATE_APP_WAIT_SLEEP_SECONDS=0
  FAKE_REMOTE_PATH="$FAKEBIN"
)

env "${BASE_ENV[@]}" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/success.out"
grep -q "Node substrate ready for canary" "$TMPROOT/success.out"

env "${BASE_ENV[@]}" CHECK_DNS=true \
  CLOUDFLARE_API_TOKEN=test-token CLOUDFLARE_ZONE_ID=zone123 FORK_DOMAIN_ROOT=cognidao.org \
  CF_CURL="$FAKEBIN/cf-curl" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/scoped-dns.out"
grep -q "Node substrate ready for canary" "$TMPROOT/scoped-dns.out"

if env TARGET=canary DEPLOY_ENVIRONMENT=candidate-a VM_HOST="" DOMAIN=test.cognidao.org \
  APP_SOURCE_DIR=. COGNI_CATALOG_ROOT=infra/catalog CHECK_DNS=false \
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
cp infra/catalog/canary.yaml "$TMPROOT/no-overlay/infra/catalog/canary.yaml"
if env "${BASE_ENV[@]}" APP_SOURCE_DIR="$TMPROOT/no-overlay" COGNI_CATALOG_ROOT="$TMPROOT/no-overlay/infra/catalog" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-overlay.out" 2>&1; then
  echo "expected missing overlay to fail" >&2
  exit 1
fi
grep -q "missing overlay dir" "$TMPROOT/missing-overlay.out"

mkdir -p "$TMPROOT/no-appset/infra/catalog" "$TMPROOT/no-appset/infra/k8s/overlays/candidate-a/canary"
cp infra/catalog/canary.yaml "$TMPROOT/no-appset/infra/catalog/canary.yaml"
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

if env "${BASE_ENV[@]}" FAKE_MISSING_SECRET=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-secret.out" 2>&1; then
  echo "expected missing secret to fail" >&2
  exit 1
fi
grep -q "Deployment-consumed Secret missing" "$TMPROOT/missing-secret.out"

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
grep -q "runtime env COGNI_NODE_DBS missing cogni_canary" "$TMPROOT/missing-db-inventory.out"
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

if env TARGET=canary DEPLOY_ENVIRONMENT=candidate-a VM_HOST=192.0.2.10 DOMAIN=test.cognidao.org \
  APP_SOURCE_DIR=. COGNI_CATALOG_ROOT=infra/catalog CHECK_DNS=true \
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" ASSERT_TARGET_SUBSTRATE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/missing-dns.out" 2>&1; then
  echo "expected missing DNS inputs to fail" >&2
  exit 1
fi
grep -q "CLOUDFLARE_API_TOKEN required" "$TMPROOT/missing-dns.out"

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
