#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t reconcile-target-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

FAKEBIN="$TMPROOT/bin"
REMOTE_ROOT="$TMPROOT/remote"
STATE_DIR="$TMPROOT/state"
mkdir -p \
  "$FAKEBIN" \
  "$STATE_DIR" \
  "$REMOTE_ROOT/tmp" \
  "$REMOTE_ROOT/opt/cogni-template-edge/configs" \
  "$REMOTE_ROOT/opt/cogni-template-runtime"

cat >"$REMOTE_ROOT/opt/cogni-template-edge/.env" <<'EOF'
DOMAIN=test.cognidao.org
EOF
cat >"$REMOTE_ROOT/opt/cogni-template-edge/configs/Caddyfile.tmpl" <<'EOF'
{$DOMAIN} {
  reverse_proxy app:3000
}
EOF
cat >"$REMOTE_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
COGNI_NODE_DBS=cogni_operator
POSTGRES_ROOT_USER=postgres
POSTGRES_ROOT_PASSWORD=rootpw
APP_DB_USER=app_user
APP_DB_SERVICE_USER=app_service
APP_DB_READONLY_USER=app_readonly
EOF
touch "$REMOTE_ROOT/opt/cogni-template-edge/docker-compose.yml"
touch "$REMOTE_ROOT/opt/cogni-template-runtime/docker-compose.yml"

cat >"$FAKEBIN/ssh" <<'EOF'
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

cat >"$FAKEBIN/scp" <<'EOF'
#!/usr/bin/env bash
args=()
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) args+=("$arg") ;;
  esac
done
src="${args[-2]}"
dest="${args[-1]}"
dest_path="${dest#*:}"
mkdir -p "${FAKE_REMOTE_ROOT}$(dirname "$dest_path")"
cp "$src" "${FAKE_REMOTE_ROOT}${dest_path}"
EOF
chmod +x "$FAKEBIN/scp"

cat >"$FAKEBIN/kubectl" <<'EOF'
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
if [ "${1:-}" = "exec" ] && [ "${2:-}" = "-n" ]; then
  ns="$3"
fi

if [ "${1:-}" = "get" ]; then
  kind="${2:-}"
  name="${3:-}"
  case "${ns}:${kind}:${name}" in
    ":namespace:cogni-candidate-a")
      [ -f "$FAKE_STATE_DIR/namespace" ] && exit 0
      exit 1
      ;;
    "argocd:applicationset:cogni-candidate-a-canary")
      [ -f "$FAKE_STATE_DIR/appset" ] && exit 0
      exit 1
      ;;
    "cogni-candidate-a:externalsecret:canary-env-secrets")
      [ -f "$FAKE_STATE_DIR/externalsecret" ] || exit 1
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        echo True
      fi
      exit 0
      ;;
    "cogni-candidate-a:secret:canary-env-secrets")
      [ -f "$FAKE_STATE_DIR/externalsecret" ] && exit 0
      exit 1
      ;;
    "argocd:application:candidate-a-canary")
      [ -f "$FAKE_STATE_DIR/appset" ] && exit 0
      exit 1
      ;;
    "cogni-candidate-a:deployment:canary-node-app")
      if printf '%s\n' "$*" | grep -Fq 'jsonpath='; then
        if [ "${FAKE_LEGACY_SECRET_CONSUMER:-}" = "1" ]; then
          echo "canary-node-app-secrets"
        else
          echo "canary-env-secrets"
        fi
      fi
      exit 0
      ;;
    "cogni-candidate-a:service:canary-node-app")
      exit 0
      ;;
    ":sa:db-provisioner"|"default:sa:db-provisioner"|"default:serviceaccount:db-provisioner")
      [ "${FAKE_MISSING_DB_READER:-}" = "1" ] && exit 1
      exit 0
      ;;
  esac
fi

if [ "${1:-}" = "create" ] && [ "${2:-}" = "namespace" ]; then
  touch "$FAKE_STATE_DIR/namespace"
  exit 0
fi
if [ "${1:-}" = "create" ] && [ "${2:-}" = "token" ]; then
  [ "${FAKE_MISSING_DB_READER:-}" = "1" ] && exit 1
  echo jwt-token
  exit 0
fi
if [ "${1:-}" = "delete" ] && [ "${2:-}" = "applicationset" ]; then
  exit 0
fi
if [ "${1:-}" = "apply" ]; then
  file="${*: -1}"
  if grep -q 'kind: ApplicationSet' "$file" 2>/dev/null; then
    touch "$FAKE_STATE_DIR/appset"
  else
    touch "$FAKE_STATE_DIR/externalsecret"
  fi
  exit 0
fi
if [ "${1:-}" = "annotate" ]; then
  exit 0
fi
if [ "${1:-}" = "exec" ] && [ "${ns:-}" = "openbao" ]; then
  command_text="$*"
  if printf '%s' "$command_text" | grep -q 'auth/kubernetes/login'; then
    [ "${FAKE_MISSING_DB_READER:-}" = "1" ] && exit 1
    echo bao-token
    exit 0
  fi
  if printf '%s' "$command_text" | grep -q 'bao kv get'; then
    [ "${FAKE_MISSING_BAO_VALUE:-}" = "1" ] && exit 1
    case "$command_text" in
      *APP_DB_PASSWORD*) echo app-pass ;;
      *APP_DB_SERVICE_PASSWORD*) echo svc-pass ;;
      *APP_DB_READONLY_PASSWORD*) echo readonly-pass ;;
      *DOLTGRES_PASSWORD*) echo dolt-pass ;;
      *DOLTGRES_READER_PASSWORD*) echo dolt-reader-pass ;;
      *DOLTGRES_WRITER_PASSWORD*) echo dolt-writer-pass ;;
      *) exit 1 ;;
    esac
    exit 0
  fi
fi

echo "fake kubectl: unexpected ns=${ns} args=$*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/kubectl"

cat >"$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
command_text="$*"

if printf '%s\n' "$command_text" | grep -q ' ps -q caddy'; then
  echo caddy123
  exit 0
fi
if printf '%s\n' "$command_text" | grep -q ' up -d --force-recreate caddy'; then
  touch "$FAKE_STATE_DIR/caddy_recreated"
  exit 0
fi
if printf '%s\n' "$command_text" | grep -q ' exec -T caddy wget '; then
  if [ -f "$FAKE_STATE_DIR/caddy_recreated" ]; then
    echo '{"host":"canary-test.cognidao.org","upstream":"host.docker.internal:30400"}'
  else
    echo '{"apps":{"http":{"servers":{}}}}'
  fi
  exit 0
fi
if printf '%s\n' "$command_text" | grep -q ' ps -q postgres'; then
  echo postgres123
  exit 0
fi
if printf '%s\n' "$command_text" | grep -q ' ps -q doltgres'; then
  echo doltgres123
  exit 0
fi
if printf '%s\n' "$command_text" | grep -q ' exec -T postgres '; then
  case "$command_text" in
    *"FROM pg_roles WHERE rolname='app_user'"*) [ -f "$FAKE_STATE_DIR/role_app_user" ] && echo 1; exit 0 ;;
    *"FROM pg_roles WHERE rolname='app_service'"*) [ -f "$FAKE_STATE_DIR/role_app_service" ] && echo 1; exit 0 ;;
    *"FROM pg_roles WHERE rolname='app_readonly'"*) [ -f "$FAKE_STATE_DIR/role_app_readonly" ] && echo 1; exit 0 ;;
    *'CREATE ROLE "app_user"'*) [ "${FAKE_POSTGRES_ROLE_CREATE_FAIL:-}" = "1" ] && exit 1; touch "$FAKE_STATE_DIR/role_app_user"; exit 0 ;;
    *'CREATE ROLE "app_service"'*) [ "${FAKE_POSTGRES_ROLE_CREATE_FAIL:-}" = "1" ] && exit 1; touch "$FAKE_STATE_DIR/role_app_service"; exit 0 ;;
    *'CREATE ROLE "app_readonly"'*) [ "${FAKE_POSTGRES_ROLE_CREATE_FAIL:-}" = "1" ] && exit 1; touch "$FAKE_STATE_DIR/role_app_readonly"; exit 0 ;;
    *"FROM pg_database WHERE datname='cogni_canary'"*) [ -f "$FAKE_STATE_DIR/pg_cogni_canary" ] && echo 1; exit 0 ;;
    *'CREATE DATABASE "cogni_canary"'*) touch "$FAKE_STATE_DIR/pg_cogni_canary"; exit 0 ;;
    *'GRANT CONNECT, CREATE, TEMP ON DATABASE "cogni_canary"'*) exit 0 ;;
  esac
fi
if printf '%s\n' "$command_text" | grep -q ' exec -T doltgres '; then
  case "$command_text" in
    *"FROM pg_roles WHERE rolname='knowledge_reader'"*) [ -f "$FAKE_STATE_DIR/dg_role_reader" ] && echo 1; exit 0 ;;
    *"FROM pg_roles WHERE rolname='knowledge_writer'"*) [ -f "$FAKE_STATE_DIR/dg_role_writer" ] && echo 1; exit 0 ;;
    *'CREATE ROLE "knowledge_reader"'*) [ "${FAKE_DOLTGRES_ROLE_CREATE_FAIL:-}" = "1" ] && exit 1; touch "$FAKE_STATE_DIR/dg_role_reader"; exit 0 ;;
    *'CREATE ROLE "knowledge_writer"'*) [ "${FAKE_DOLTGRES_ROLE_CREATE_FAIL:-}" = "1" ] && exit 1; touch "$FAKE_STATE_DIR/dg_role_writer"; exit 0 ;;
    *"FROM pg_database WHERE datname='knowledge_canary'"*) [ -f "$FAKE_STATE_DIR/dg_knowledge_canary" ] && echo 1; exit 0 ;;
    *'CREATE DATABASE "knowledge_canary"'*) touch "$FAKE_STATE_DIR/dg_knowledge_canary"; exit 0 ;;
    *"dolt_commit"*) exit 0 ;;
  esac
fi

echo "fake docker: unexpected args $*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/docker"

BASE_ENV=(
  TARGET=canary
  DEPLOY_ENVIRONMENT=candidate-a
  VM_HOST=192.0.2.10
  DOMAIN=test.cognidao.org
  APP_SOURCE_DIR=.
  COGNI_CATALOG_ROOT=infra/catalog
  SSH_OPTS="-i fake-key"
  SUBSTRATE_RECONCILE_SSH_BIN="$FAKEBIN/ssh"
  SUBSTRATE_RECONCILE_SCP_BIN="$FAKEBIN/scp"
  SUBSTRATE_RECONCILE_REMOTE_ROOT="$REMOTE_ROOT"
  SUBSTRATE_RECONCILE_WAIT_ATTEMPTS=1
  SUBSTRATE_RECONCILE_WAIT_SLEEP_SECONDS=0
  FAKE_REMOTE_PATH="$FAKEBIN"
  FAKE_REMOTE_ROOT="$REMOTE_ROOT"
  FAKE_STATE_DIR="$STATE_DIR"
)

env "${BASE_ENV[@]}" SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/summary.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/reconcile.out"

grep -q "CANARY_DOMAIN=canary-test.cognidao.org" "$REMOTE_ROOT/opt/cogni-template-edge/.env"
grep -q "COGNI_NODE_DBS=cogni_operator,cogni_canary" "$REMOTE_ROOT/opt/cogni-template-runtime/.env"
[ -f "$STATE_DIR/pg_cogni_canary" ]
[ -f "$STATE_DIR/dg_knowledge_canary" ]
python3 - "$TMPROOT/summary.json" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["type"] == "target_substrate_reconcile_summary"
assert payload["status"] == "success"
rows = {row["row"]: row["state"] for row in payload["rows"]}
assert rows["edge_env"] == "updated"
assert rows["postgres_db"] == "created"
assert rows["doltgres_db"] == "created"
text = json.dumps(payload)
assert "app-pass" not in text
assert "svc-pass" not in text
assert "dolt-pass" not in text
PY

env "${BASE_ENV[@]}" SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/summary-second.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/reconcile-second.out"
python3 - "$TMPROOT/summary-second.json" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "success"
rows = {row["row"]: row["state"] for row in payload["rows"]}
assert rows["edge_env"] == "unchanged"
assert rows["runtime_db_inventory"] == "unchanged"
assert rows["postgres_db"] == "unchanged"
assert rows["doltgres_db"] == "unchanged"
PY

if env "${BASE_ENV[@]}" FAKE_LEGACY_SECRET_CONSUMER=1 \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/legacy-summary.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/legacy.out" 2>&1; then
  echo "expected legacy secret consumer to fail" >&2
  exit 1
fi
grep -q "legacy plain Secret canary-node-app-secrets" "$TMPROOT/legacy.out"

rm -f "$STATE_DIR/pg_cogni_canary" "$STATE_DIR/dg_knowledge_canary"
if env "${BASE_ENV[@]}" FAKE_MISSING_BAO_VALUE=1 \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/missing-bao-summary.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/missing-bao.out" 2>&1; then
  echo "expected missing OpenBao value to fail" >&2
  exit 1
fi
grep -q "missing OpenBao key APP_DB_PASSWORD" "$TMPROOT/missing-bao.out"

rm -f "$STATE_DIR/role_app_user" "$STATE_DIR/role_app_service" "$STATE_DIR/role_app_readonly" "$STATE_DIR/pg_cogni_canary"
if env "${BASE_ENV[@]}" FAKE_POSTGRES_ROLE_CREATE_FAIL=1 \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/pg-role-fail-summary.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/pg-role-fail.out" 2>&1; then
  echo "expected Postgres role create failure to fail" >&2
  exit 1
fi
grep -q "could not create Postgres role app_user" "$TMPROOT/pg-role-fail.out"

rm -f "$STATE_DIR/dg_role_reader" "$STATE_DIR/dg_role_writer" "$STATE_DIR/dg_knowledge_canary"
if env "${BASE_ENV[@]}" FAKE_DOLTGRES_ROLE_CREATE_FAIL=1 \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/dg-role-fail-summary.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/dg-role-fail.out" 2>&1; then
  echo "expected Doltgres role create failure to fail" >&2
  exit 1
fi
grep -q "could not create Doltgres role knowledge_reader" "$TMPROOT/dg-role-fail.out"

if env TARGET=scheduler-worker DEPLOY_ENVIRONMENT=candidate-a APP_SOURCE_DIR=. COGNI_CATALOG_ROOT=infra/catalog \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/service-summary.json" \
  bash scripts/ci/reconcile-target-substrate.sh >"$TMPROOT/service.out" 2>&1; then
  echo "expected service target to exit unsupported" >&2
  exit 1
else
  rc=$?
  [ "$rc" -eq 2 ]
fi

echo "PASS: reconcile-target-substrate.test.sh"
