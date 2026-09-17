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
{$NODE_TEMPLATE_DOMAIN:node-template.localhost} {
  reverse_proxy {$NODE_TEMPLATE_UPSTREAM:host.docker.internal:30200}
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
        if [ "${FAKE_LEGACY_SECRET_CONSUMER:-}" = "1" ]; then
          echo "node-template-node-app-secrets"
        elif [ "${FAKE_WRONG_SECRET_CONSUMER:-}" = "1" ]; then
          echo "other-secret"
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
    "cogni-candidate-a:externalsecret:node-template-env-secrets")
      [ "${FAKE_MISSING_EXTERNAL_SECRET:-}" = "1" ] && exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        [ "${FAKE_EXTERNAL_SECRET_NOT_READY:-}" = "1" ] || echo True
      fi
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
cp infra/k8s/overlays/candidate-a/node-template/*.yaml \
  "$HAPPY_TREE/infra/k8s/overlays/candidate-a/node-template/"
# Appset path derived through the lib — this fixture is a k3s pair (no deployment_provider
# cell for candidate-a), so control env == env; spelling the dir by hand is the env-keyed
# form the appset-path-consumers invariant forbids (bug.5204).
# shellcheck source=scripts/ci/lib/appset-paths.sh
CATALOG_DIR="$HAPPY_TREE/infra/catalog" . "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
bash scripts/ci/render-node-appset.sh candidate-a node-template \
  > "$HAPPY_TREE/$(CATALOG_DIR="$HAPPY_TREE/infra/catalog" appset_rel_path candidate-a node-template)"

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
grep -q "Deployment consumes legacy plain Secret node-template-node-app-secrets" "$TMPROOT/legacy-secret-consumer.out"

if env "${BASE_ENV[@]}" FAKE_WRONG_SECRET_CONSUMER=1 bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/wrong-secret-consumer.out" 2>&1; then
  echo "expected wrong Secret consumer to fail" >&2
  exit 1
fi
grep -q "Deployment consumes unexpected Secret other-secret" "$TMPROOT/wrong-secret-consumer.out"

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

# External compute uses the same entrypoint with the provider chosen upstream by
# the typed planner. It checks declared secret refs + controller/CRD/credentials
# + the installed egress boundary, without requiring or provisioning k3s app/DB state.
EXTERNAL_SRC="$TMPROOT/external-src"
EXTERNAL_BIN="$TMPROOT/external-bin"
mkdir -p "$EXTERNAL_SRC/infra/catalog" "$EXTERNAL_SRC/nodes/toks4/.cogni" "$EXTERNAL_BIN"
cat > "$EXTERNAL_SRC/infra/catalog/toks4.yaml" <<'YAML'
name: toks4
type: node
node_id: 72aa130b-f0ad-495a-a061-9ee1f9c9525d
path_prefix: nodes/toks4/
compute_egress_cidrs:
  - cidr: 80.200.246.35/32
    comment: test provider
YAML
cat > "$EXTERNAL_SRC/nodes/toks4/.cogni/repo-spec.yaml" <<'YAML'
deployment:
  services:
    - name: app
      secret_refs:
        - { key: AUTH_SECRET }
        - { key: DATABASE_URL }
        - { key: LITELLM_VIRTUAL_KEY }
    - name: echo
      secret_refs: []
YAML
cat > "$EXTERNAL_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "get crd computeworkloads.compute.cogni.io") exit 0 ;;
  *"get deployment operator-compute-workload-controller -o jsonpath="*) echo 1; exit 0 ;;
  *"exec deployment/operator-compute-workload-controller -c controller"*)
    [ "${FAKE_MISSING_AKASH_CREDENTIAL:-}" = 1 ] && exit 1
    exit 0
    ;;
  "create token db-provisioner -n default") echo test-jwt; exit 0 ;;
  *"bao write -field=token auth/kubernetes/login"*) echo test-token; exit 0 ;;
  *"bao kv get -format=json cogni/candidate-a/toks4"*)
    if [ "${FAKE_EMPTY_WORKLOAD_SECRET:-}" = 1 ]; then
      echo '{"data":{"data":{}}}'
    elif [ "${FAKE_MISSING_WORKLOAD_SECRET:-}" = 1 ]; then
      echo '{"data":{"data":{"AUTH_SECRET":"present","DATABASE_URL":"present"}}}'
    else
      echo '{"data":{"data":{"AUTH_SECRET":"present","DATABASE_URL":"present","LITELLM_VIRTUAL_KEY":"present"}}}'
    fi
    exit 0
    ;;
esac
echo "fake external kubectl: unexpected $*" >&2
exit 1
EOF
chmod +x "$EXTERNAL_BIN/kubectl"
EXTERNAL_ALLOWLIST="$TMPROOT/compute-egress-allowlist"
# Mirror render-compute-egress-allowlist.sh output exactly: "<cidr>:<ports>".
# The previous bare-CIDR fixture did not match the renderer, which is how a
# whole-line `grep -Fx` shipped and failed closed on every real host.
printf '%s\n' '80.200.246.35/32:5432,5435,6379,4000,7233' > "$EXTERNAL_ALLOWLIST"
EXTERNAL_ENV=(
  TARGET=toks4
  DEPLOYMENT_PROVIDER=akash
  DEPLOY_ENVIRONMENT=candidate-a
  VM_HOST=192.0.2.10
  DOMAIN=test.cognidao.org
  APP_SOURCE_DIR="$EXTERNAL_SRC"
  COGNI_CATALOG_ROOT="$EXTERNAL_SRC/infra/catalog"
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh"
  ASSERT_TARGET_SUBSTRATE_EGRESS_ALLOWLIST="$EXTERNAL_ALLOWLIST"
  FAKE_REMOTE_PATH="$EXTERNAL_BIN"
)
env "${EXTERNAL_ENV[@]}" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/external-success.out"
grep -q "External compute preconditions ready for toks4" "$TMPROOT/external-success.out"
if env "${EXTERNAL_ENV[@]}" FAKE_MISSING_WORKLOAD_SECRET=1 \
  bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/external-missing-secret.out" 2>&1; then
  echo "expected missing declared external workload secret to fail" >&2
  exit 1
fi
grep -q "missing declared key: LITELLM_VIRTUAL_KEY" "$TMPROOT/external-missing-secret.out"
if env "${EXTERNAL_ENV[@]}" FAKE_MISSING_AKASH_CREDENTIAL=1 \
  bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/external-missing-credential.out" 2>&1; then
  echo "expected missing Akash controller credential to fail" >&2
  exit 1
fi
grep -q "controller provider/DNS credentials" "$TMPROOT/external-missing-credential.out"

cat > "$EXTERNAL_SRC/nodes/toks4/.cogni/repo-spec.yaml" <<'YAML'
deployment:
  services:
    - name: echo
      secret_refs: []
YAML
env "${EXTERNAL_ENV[@]}" FAKE_EMPTY_WORKLOAD_SECRET=1 \
  bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/external-no-secret-refs.out"
grep -q "all declared workload secret refs are materialized" "$TMPROOT/external-no-secret-refs.out"

# ---------------------------------------------------------------------------
# task.5104 — compute_api selects WHICH authority the preflight asserts.
#
# The rows above carry no compute_api cell at all, so everything asserted so far
# already proves LEGACY_IS_DEFAULT: the fake kubectl below hard-fails on any
# crossplane object, and the legacy fake hard-fails on anything that is not the
# bespoke controller, so each branch's fixture is itself the "did not drift" proof.
# ---------------------------------------------------------------------------

# The legacy fixture must still take the controller path, and must never reach for
# the Crossplane control plane.
grep -q "compute_api=legacy" "$TMPROOT/external-success.out"
grep -q "compute workload controller is available" "$TMPROOT/external-success.out"
if grep -q "crossplane authority" "$TMPROOT/external-success.out"; then
  echo "expected the legacy branch to assert no crossplane objects" >&2
  exit 1
fi

# An EXPLICIT `compute_api.candidate-a: legacy` must be byte-identical to the absent
# cell: same asserts, same fake, same output.
LEGACY_SRC="$TMPROOT/legacy-src"
mkdir -p "$LEGACY_SRC/infra/catalog" "$LEGACY_SRC/nodes/toks4/.cogni"
cat > "$LEGACY_SRC/infra/catalog/toks4.yaml" <<'YAML'
name: toks4
type: node
node_id: 72aa130b-f0ad-495a-a061-9ee1f9c9525d
path_prefix: nodes/toks4/
compute_api:
  candidate-a: legacy
compute_egress_cidrs:
  - cidr: 80.200.246.35/32
    comment: test provider
YAML
cat > "$LEGACY_SRC/nodes/toks4/.cogni/repo-spec.yaml" <<'YAML'
deployment:
  services:
    - name: app
      secret_refs:
        - { key: AUTH_SECRET }
        - { key: DATABASE_URL }
        - { key: LITELLM_VIRTUAL_KEY }
YAML
env "${EXTERNAL_ENV[@]}" APP_SOURCE_DIR="$LEGACY_SRC" COGNI_CATALOG_ROOT="$LEGACY_SRC/infra/catalog" \
  bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/explicit-legacy.out"
grep -q "compute_api=legacy" "$TMPROOT/explicit-legacy.out"
grep -q "compute workload controller is available" "$TMPROOT/explicit-legacy.out"
grep -q "External compute preconditions ready for toks4" "$TMPROOT/explicit-legacy.out"
if grep -q "crossplane authority" "$TMPROOT/explicit-legacy.out"; then
  echo "expected explicit compute_api=legacy to be identical to the absent cell" >&2
  exit 1
fi

# A crossplane row asserts the Crossplane control plane + the private Akash tx
# actuator instead. Its fake kubectl refuses every legacy-controller call, which is
# exactly the defect this branch fixes: story.5016 step 9 deleted that Deployment
# from the candidate-a operator overlay, so asserting it killed every akash flight.
XCW_SRC="$TMPROOT/xcw-src"
XCW_BIN="$TMPROOT/xcw-bin"
mkdir -p "$XCW_SRC/infra/catalog" "$XCW_SRC/nodes/toks5/.cogni" "$XCW_BIN"
cat > "$XCW_SRC/infra/catalog/toks5.yaml" <<'YAML'
name: toks5
type: node
node_id: 4d2a5f3b-9c1e-4a77-bd62-1f0c7e8a4411
path_prefix: nodes/toks5/
compute_api:
  candidate-a: crossplane
compute_egress_cidrs:
  - cidr: 80.200.246.35/32
    comment: test provider
YAML
cat > "$XCW_SRC/nodes/toks5/.cogni/repo-spec.yaml" <<'YAML'
deployment:
  services:
    - name: app
      secret_refs:
        - { key: AUTH_SECRET }
        - { key: DATABASE_URL }
        - { key: LITELLM_VIRTUAL_KEY }
YAML
cat > "$XCW_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *compute-workload-controller*)
    echo "fake xcw kubectl: legacy controller must never be touched on a crossplane row: $*" >&2
    exit 1
    ;;
  *"get crd computeworkloads.compute.cogni.io"*)
    echo "fake xcw kubectl: legacy CRD must never be asserted on a crossplane row: $*" >&2
    exit 1
    ;;
  *"get crd xcomputeworkloads.compute.cogni.io"*)
    [ "${FAKE_MISSING_XRD:-}" = 1 ] && exit 1
    [ "${FAKE_XRD_NOT_ESTABLISHED:-}" = 1 ] && { echo False; exit 0; }
    echo True
    exit 0
    ;;
  *"get composition xcomputeworkload-akash"*)
    [ "${FAKE_MISSING_COMPOSITION:-}" = 1 ] && exit 1
    exit 0
    ;;
  *"get clusterproviderconfigs.http.m.crossplane.io cogni-http"*)
    [ "${FAKE_MISSING_PROVIDER_CONFIG:-}" = 1 ] && exit 1
    exit 0
    ;;
  *"get deployment operator-akash-tx-actuator"*status.availableReplicas*)
    [ "${FAKE_ACTUATOR_UNAVAILABLE:-}" = 1 ] && exit 0
    echo 1
    exit 0
    ;;
  *"get deployment operator-akash-tx-actuator"*AKASH_ALLOWED_PROVIDERS*)
    [ "${FAKE_EMPTY_ALLOWED_PROVIDERS:-}" = 1 ] && exit 0
    echo akash16yr3wxt97ae045a06kr3ycde9srcgpg8syjxxm
    exit 0
    ;;
  *"get secret akash-tx-actuator-auth"*.data.token*)
    [ "${FAKE_MISSING_AUTH_TOKEN_KEY:-}" = 1 ] && exit 0
    echo dG9rZW4=
    exit 0
    ;;
  *"get secret akash-tx-actuator-auth"*)
    [ "${FAKE_MISSING_AUTH_SECRET:-}" = 1 ] && exit 1
    exit 0
    ;;
  *"get secret akash-tx-actuator-env-secrets"*)
    [ "${FAKE_MISSING_ACTUATOR_ENV_SECRET:-}" = 1 ] && exit 1
    exit 0
    ;;
  "create token db-provisioner -n default") echo test-jwt; exit 0 ;;
  *"bao write -field=token auth/kubernetes/login"*) echo test-token; exit 0 ;;
  *"bao kv get -format=json cogni/candidate-a/toks5"*)
    echo '{"data":{"data":{"AUTH_SECRET":"present","DATABASE_URL":"present","LITELLM_VIRTUAL_KEY":"present"}}}'
    exit 0
    ;;
esac
echo "fake xcw kubectl: unexpected $*" >&2
exit 1
EOF
chmod +x "$XCW_BIN/kubectl"

XCW_ENV=(
  TARGET=toks5
  DEPLOYMENT_PROVIDER=akash
  DEPLOY_ENVIRONMENT=candidate-a
  VM_HOST=192.0.2.10
  DOMAIN=test.cognidao.org
  APP_SOURCE_DIR="$XCW_SRC"
  COGNI_CATALOG_ROOT="$XCW_SRC/infra/catalog"
  ASSERT_TARGET_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh"
  ASSERT_TARGET_SUBSTRATE_EGRESS_ALLOWLIST="$EXTERNAL_ALLOWLIST"
  FAKE_REMOTE_PATH="$XCW_BIN"
)

env "${XCW_ENV[@]}" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/xcw-success.out"
grep -q "compute_api=crossplane" "$TMPROOT/xcw-success.out"
grep -q "CRD xcomputeworkloads.compute.cogni.io is Established" "$TMPROOT/xcw-success.out"
grep -q "Composition xcomputeworkload-akash exists" "$TMPROOT/xcw-success.out"
grep -q "ClusterProviderConfig/cogni-http exists" "$TMPROOT/xcw-success.out"
grep -q "cogni-candidate-a/operator-akash-tx-actuator is available" "$TMPROOT/xcw-success.out"
grep -q "Secret cogni-candidate-a/akash-tx-actuator-auth carries key 'token'" "$TMPROOT/xcw-success.out"
grep -q "Secret cogni-candidate-a/akash-tx-actuator-env-secrets exists" "$TMPROOT/xcw-success.out"
grep -q "AKASH_ALLOWED_PROVIDERS is non-empty" "$TMPROOT/xcw-success.out"
# Authority-independent checks still run on the crossplane path.
grep -q "all declared workload secret refs are materialized" "$TMPROOT/xcw-success.out"
grep -q "catalog compute egress CIDRs are installed" "$TMPROOT/xcw-success.out"
grep -q "External compute preconditions ready for toks5" "$TMPROOT/xcw-success.out"
if grep -q "compute workload controller" "$TMPROOT/xcw-success.out"; then
  echo "expected the crossplane branch to assert no legacy controller" >&2
  exit 1
fi

xcw_expect_fail() {
  local label="$1" needle="$2"
  shift 2
  if env "${XCW_ENV[@]}" "$@" bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/xcw-${label}.out" 2>&1; then
    echo "expected ${label} to fail" >&2
    exit 1
  fi
  grep -q "$needle" "$TMPROOT/xcw-${label}.out" || {
    echo "expected ${label} failure to name '${needle}'" >&2
    cat "$TMPROOT/xcw-${label}.out" >&2
    exit 1
  }
  # Every crossplane failure must name the authority it expected, in the error line
  # itself — an ambiguous preflight failure is how B1/B2 stayed invisible.
  grep -q "::error::assert-target-substrate: compute_api=crossplane" "$TMPROOT/xcw-${label}.out" || {
    echo "expected ${label} error line to name the expected authority" >&2
    cat "$TMPROOT/xcw-${label}.out" >&2
    exit 1
  }
}

xcw_expect_fail missing-xrd "XRD-backed CRD xcomputeworkloads.compute.cogni.io is not Established (condition='absent')" FAKE_MISSING_XRD=1
xcw_expect_fail xrd-not-established "is not Established (condition='False')" FAKE_XRD_NOT_ESTABLISHED=1
xcw_expect_fail missing-composition "Composition xcomputeworkload-akash is missing" FAKE_MISSING_COMPOSITION=1
xcw_expect_fail missing-provider-config "ClusterProviderConfig/cogni-http (http.m.crossplane.io/v1alpha2) is missing" FAKE_MISSING_PROVIDER_CONFIG=1
xcw_expect_fail actuator-unavailable "akash transaction actuator is not available: cogni-candidate-a/operator-akash-tx-actuator" FAKE_ACTUATOR_UNAVAILABLE=1
xcw_expect_fail missing-auth-secret "Secret cogni-candidate-a/akash-tx-actuator-auth is missing" FAKE_MISSING_AUTH_SECRET=1
xcw_expect_fail missing-auth-token-key "carries no 'token' key" FAKE_MISSING_AUTH_TOKEN_KEY=1
xcw_expect_fail missing-actuator-env-secret "Secret cogni-candidate-a/akash-tx-actuator-env-secrets is missing" FAKE_MISSING_ACTUATOR_ENV_SECRET=1
xcw_expect_fail empty-allowed-providers "AKASH_ALLOWED_PROVIDERS is empty or unset on cogni-candidate-a/operator-akash-tx-actuator" FAKE_EMPTY_ALLOWED_PROVIDERS=1

# An unknown authority is a loud stop, never a silent fall-through to legacy.
BAD_SRC="$TMPROOT/bad-authority-src"
mkdir -p "$BAD_SRC/infra/catalog" "$BAD_SRC/nodes/toks5/.cogni"
sed 's/crossplane/terraform/' "$XCW_SRC/infra/catalog/toks5.yaml" > "$BAD_SRC/infra/catalog/toks5.yaml"
cp "$XCW_SRC/nodes/toks5/.cogni/repo-spec.yaml" "$BAD_SRC/nodes/toks5/.cogni/repo-spec.yaml"
if env "${XCW_ENV[@]}" APP_SOURCE_DIR="$BAD_SRC" COGNI_CATALOG_ROOT="$BAD_SRC/infra/catalog" \
  bash scripts/ci/assert-target-substrate.sh >"$TMPROOT/xcw-bad-authority.out" 2>&1; then
  echo "expected an unsupported compute_api to fail" >&2
  exit 1
fi
grep -q "unsupported compute_api 'terraform'" "$TMPROOT/xcw-bad-authority.out"

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
