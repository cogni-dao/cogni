#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail
export FLEET_CONTROL_ENV=production
export FORK_DOMAIN_ROOT=cognidao.org COGNI_DOMAIN_ROOT=cognidao.org COGNI_DEPLOYMENT_SLUG=cogni

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t reconcile-node-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

FAKEBIN="$TMPROOT/bin"
REMOTE_ROOT="$TMPROOT/remote"
DESTINATION_ROOT="$TMPROOT/destination"
export FAKE_DESTINATION_ROOT="$DESTINATION_ROOT"
BAO_ROOT="$REMOTE_ROOT/openbao"
mkdir -p \
  "$FAKEBIN" \
  "$REMOTE_ROOT/opt/cogni-template-edge/configs" \
  "$REMOTE_ROOT/opt/cogni-template-runtime" \
  "$REMOTE_ROOT/tmp" \
  "$DESTINATION_ROOT/opt/cogni-template-runtime" \
  "$DESTINATION_ROOT/tmp" \
  "$BAO_ROOT/cogni/candidate-a/node-template"

cat > "$REMOTE_ROOT/opt/cogni-template-edge/.env" <<'EOF'
DOMAIN=stale.example.invalid
OPERATOR_UPSTREAM=host.docker.internal:30080
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-edge/docker-compose.yml" <<'EOF'
services: {}
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
COGNI_NODE_DBS=cogni_operator
DEPLOY_ENVIRONMENT=candidate-a
POSTGRES_ROOT_USER=postgres
POSTGRES_ROOT_PASSWORD=postgres-root
APP_DB_USER=app_user
APP_DB_PASSWORD=app-pass
APP_DB_SERVICE_USER=app_service
APP_DB_SERVICE_PASSWORD=service-pass
DOLTGRES_PASSWORD=dolt-pass
DOLT_CREDS_JWK={"kty":"OKP","d":"stale-prod-cred-sentinel"}
DOLT_CREDS_KEYID=stale-keyid-sentinel
DOLTHUB_OWNER=cogni-dao
DOLTHUB_API_TOKEN=stale-pat-sentinel
EOF
cat > "$DESTINATION_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
DEPLOY_ENVIRONMENT=candidate-a
POSTGRES_ROOT_USER=postgres
POSTGRES_ROOT_PASSWORD=destination-only-root-sentinel
LITELLM_DB_NAME=litellm
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-runtime/docker-compose.yml" <<'EOF'
services: {}
EOF

put_secret() {
  local svc="$1" key="$2" value="$3"
  mkdir -p "$BAO_ROOT/cogni/candidate-a/${svc}"
  printf '%s' "$value" > "$BAO_ROOT/cogni/candidate-a/${svc}/${key}"
}

put_secret node-template LITELLM_MASTER_KEY sk-cogni-existing
put_secret node-template OPENROUTER_API_KEY sk-or-existing
put_secret node-template POSTHOG_API_KEY phc_existing
put_secret node-template POSTHOG_HOST https://us.i.posthog.com
put_secret node-template EVM_RPC_URL https://mainnet.base.org
put_secret node-template DOLTHUB_OWNER cogni-dao
put_secret node-template DOLT_CREDS_KEYID dolt-key
put_secret node-template DOLTHUB_API_TOKEN dolt-token
put_secret node-template GH_WEBHOOK_SECRET existing-webhook
put_secret node-template METRICS_TOKEN existing-metrics
put_secret node-template INTERNAL_OPS_TOKEN existing-ops
put_secret node-template SCHEDULER_API_TOKEN existing-scheduler
put_secret node-template BILLING_INGEST_TOKEN existing-billing

# Per-node DB creds: secret-materialize (the sole OpenBao writer) owns these at
# cogni/<env>/<node>. Read-only reconcile reads them via the db-reader token and
# hands them to db-provision. Distinct sentinels so the leak checks below are real.
# Target is operator (the only in-tree node — its nodes/operator/** ExternalSecret
# leaf is present in the submodule-less unit-job checkout; oss/node-template are
# gitlinks whose files are absent there).
put_secret operator APP_DB_PASSWORD pernode-app-pw-sentinel
put_secret operator APP_DB_SERVICE_PASSWORD pernode-svc-pw-sentinel
put_secret operator DATABASE_URL 'postgresql://app_operator:pernode-app-pw-sentinel@127.0.0.1:5432/cogni_operator'
put_secret operator DATABASE_SERVICE_URL 'postgresql://service_operator:pernode-svc-pw-sentinel@127.0.0.1:5432/cogni_operator'
put_secret operator-database-migration APP_DB_MIGRATION_PASSWORD pernode-migration-pw-sentinel
put_secret operator-database-migration DATABASE_MIGRATION_URL 'postgresql://migration_operator:pernode-migration-pw-sentinel@127.0.0.1:5432/cogni_operator'
put_secret database-reliability-actuator DATABASE_RELIABILITY_PASSWORD reliability-pw-sentinel
put_secret database-reliability-readmitter DATABASE_RELIABILITY_READMIT_PASSWORD readmit-pw-sentinel
# Doltgres superuser SSOT is operator-canonical (cogni/<env>/operator/DOLTGRES_PASSWORD),
# shared env-wide; reconcile reads it from operator and injects it into doltgres-provision.
put_secret operator DOLTGRES_PASSWORD doltgres-super-sentinel
# DoltHub knowledge-mirror creds — env-global, read from the operator-canonical bank
# (mirrors DOLTGRES_PASSWORD). secret-materialize already materializes these into every
# node bank. The reconcile lane renders them to the VM runtime .env + recreates doltgres
# so install-creds.sh re-runs — Option B (substrate lane, not deploy-infra). The JWK value
# carries JSON metachars ({,",}) on purpose so the base64 no-injection path is exercised.
put_secret operator DOLT_CREDS_JWK '{"kty":"OKP","d":"jwk-secret-sentinel"}'
put_secret operator DOLT_CREDS_KEYID dolt-mirror-keyid-sentinel

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'called\n' >> "${FAKE_REMOTE_ROOT}/ssh-calls.log"
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
  case "$1" in
    -i|-o) shift 2 ;;
    *) shift ;;
  esac
done
remote_host="$1"
shift
if [ "$remote_host" = root@cogni-candidate-a.vm.cognidao.org ]; then
  printf '%s\n' "$@" >> "${FAKE_REMOTE_ROOT}/destination-ssh-argv.log"
  export FAKE_REMOTE_ROOT="$FAKE_DESTINATION_ROOT"
fi
cmd="$*"
if [ "$cmd" = 'bash -s' ]; then cmd="$(cat)"; fi
# Rewrite remote scratch /tmp/ FIRST. FAKE_REMOTE_ROOT lives under /tmp/ on CI
# runners (mktemp), so doing this after the /opt passes would re-rewrite the
# /tmp/ they just injected and double the path. Locally (macOS /var/folders) the
# ordering is invisible — which is why this only ever failed in CI.
cmd="${cmd//\/tmp\//${FAKE_REMOTE_ROOT}\/tmp\/}"
cmd="${cmd//\/opt\/cogni-template-edge/${FAKE_REMOTE_ROOT}\/opt\/cogni-template-edge}"
cmd="${cmd//\/opt\/cogni-template-runtime/${FAKE_REMOTE_ROOT}\/opt\/cogni-template-runtime}"
cmd="${cmd//\/var\/lib\/cogni/${FAKE_REMOTE_ROOT}\/var\/lib\/cogni}"
PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$cmd"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/scp" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
  case "$1" in
    -i|-o) shift 2 ;;
    *) shift ;;
  esac
done
src="$1"
dest="$2"
remote_root="$FAKE_REMOTE_ROOT"
case "$dest" in root@cogni-candidate-a.vm.cognidao.org:*) remote_root="$FAKE_DESTINATION_ROOT" ;; esac
path="${dest#*:}"
path="${path/\/tmp\//${remote_root}\/tmp\/}"
printf '%s -> %s\n' "$src" "$path" >> "${FAKE_REMOTE_ROOT}/scp.log"
mkdir -p "$(dirname "$path")"
cp "$src" "$path"
EOF
chmod +x "$FAKEBIN/scp"

# Production SSH runs as root and install(1) stamps root ownership explicitly.
# The local fake remote runs as the developer, so preserve mode/copy semantics
# while ignoring only the impossible local chown flags.
cat > "$FAKEBIN/install" <<'EOF'
#!/usr/bin/env bash
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "${args[@]}"
EOF
chmod +x "$FAKEBIN/install"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "create" ] && [ "${2:-}" = "token" ]; then
  echo jwt-token
  exit 0
fi
if [ "${1:-}" = "create" ] && [ "${2:-}" = "namespace" ]; then
  echo "apiVersion: v1"
  echo "kind: Namespace"
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "get" ] && [ "${4:-}" = "externalsecret" ] && [ "${5:-}" = "env-secrets" ]; then
  if [ -n "${FAKE_LEGACY_EXTERNAL_SECRET_TARGET:-}" ]; then
    printf '%s' "$FAKE_LEGACY_EXTERNAL_SECRET_TARGET"
    exit 0
  fi
  exit 1
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "delete" ] && [ "${4:-}" = "externalsecret" ] && [ "${5:-}" = "env-secrets" ]; then
  printf '%s\n' "$*" >> "${FAKE_REMOTE_ROOT}/kubectl.log"
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "get" ] && [ "${4:-}" = "externalsecret" ] && printf '%s\n' "$*" | grep -q 'status.refreshTime'; then
  state="${FAKE_REMOTE_ROOT}/refresh-${5:-unknown}"
  if [ -f "$state" ]; then cat "$state"; else printf '%s' 'refresh-0'; fi
  exit 0
fi
if [ "${1:-}" = "apply" ]; then
  cat >/dev/null
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "apply" ]; then
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "annotate" ] && [ "${4:-}" = "externalsecret" ]; then
  printf '%s\n' "$*" >> "${FAKE_REMOTE_ROOT}/kubectl.log"
  state="${FAKE_REMOTE_ROOT}/refresh-${5:-unknown}"
  count=0
  [ ! -f "$state" ] || count="$(sed 's/^refresh-//' "$state")"
  printf 'refresh-%s' "$((count + 1))" > "$state"
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "wait" ]; then
  printf '%s\n' "$*" >> "${FAKE_REMOTE_ROOT}/kubectl.log"
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "get" ] && [ "${4:-}" = "secret" ]; then
  printf '%s\n' "$*" >> "${FAKE_REMOTE_ROOT}/kubectl.log"
  if printf '%s\n' "$*" | grep -q 'migration-secrets.*DATABASE_MIGRATION_URL'; then
    printf '%s' "${FAKE_MIGRATION_DSN:-postgresql://migration_operator:pernode-migration-pw-sentinel@127.0.0.1:5432/cogni_operator}" | base64
  elif printf '%s\n' "$*" | grep -q 'jsonpath='; then
    printf '%s' 'cHJlc2VudA=='
  fi
  exit 0
fi
if [ "${1:-}" = "exec" ]; then
  args=("$@")
  last_index=$((${#args[@]} - 1))
  path="${args[$last_index]}"
  if printf '%s\n' "$*" | grep -q 'auth/kubernetes/login'; then
    echo writer-token
    exit 0
  fi
  if printf '%s\n' "$*" | grep -q 'bao kv get -format=json'; then
    dir="${FAKE_BAO_ROOT}/${path}"
    if [ ! -d "$dir" ]; then exit 2; fi
    # Portable valid-JSON builder (matches secret-materialize.test.sh). The prior
    # `$k + ":" + ...` form emitted unquoted keys → invalid JSON.
    data="{}"
    for f in "$dir"/*; do
      [ -f "$f" ] || continue
      data="$(printf '%s' "$data" | jq --arg k "$(basename "$f")" --arg v "$(cat "$f")" '.[$k]=$v')"
    done
    printf '{"data":{"data":%s,"metadata":{"version":7}}}\n' "$data"
    exit 0
  fi
  if printf '%s\n' "$*" | grep -q 'bao kv metadata get'; then
    [ -d "${FAKE_BAO_ROOT}/${path}" ] && exit 0 || exit 2
  fi
  if printf '%s\n' "$*" | grep -Eq 'bao kv (put|patch)'; then
    path="${args[$((last_index - 1))]}"
    key_arg="${args[$last_index]}"
    key="${key_arg%%=*}"
    value="$(cat)"
    mkdir -p "${FAKE_BAO_ROOT}/${path}"
    printf '%s' "$value" > "${FAKE_BAO_ROOT}/${path}/${key}"
    exit 0
  fi
fi
echo "fake kubectl: unexpected $*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/kubectl"

# Execute the actual container shell and capture the exact bytes delivered to psql.
cat > "$FAKEBIN/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$DATABASE_MIGRATION_URL" = "${FAKE_MIGRATION_DSN:-postgresql://migration_operator:pernode-migration-pw-sentinel@127.0.0.1:5432/cogni_operator}" ]
[ "$#" -eq 5 ]
[ "$1" = "$DATABASE_MIGRATION_URL" ]
[ "$2" = -XAtv ]
[ "$3" = ON_ERROR_STOP=1 ]
[ "$4" = -f ]
[ "$5" = - ]
cat > "${FAKE_REMOTE_ROOT}/migration-identity.sql"
printf '%s' "$MIGRATION_IDENTITY_SQL_B64" > "${FAKE_REMOTE_ROOT}/migration-identity.b64"
printf '%s\n' "${FAKE_MIGRATION_PROBE_RESULT:-t}"
EOF
chmod +x "$FAKEBIN/psql"

cat > "$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_REMOTE_ROOT}/docker.log"
if [ "${1:-}" = ps ] && [ "${2:-}" = -q ]; then
  printf '%s\n' destination-postgres
  exit 0
fi
if [[ "$*" == *'--network container:destination-postgres'* ]]; then
  [ "$POSTGRES_ROOT_PASSWORD" = destination-only-root-sentinel ] || exit 31
  [ "$APP_DB_PASSWORD" = foreign-app-sentinel ] || exit 32
  [ "$APP_DB_SERVICE_PASSWORD" = foreign-service-sentinel ] || exit 33
  [ "$APP_DB_MIGRATION_PASSWORD" = foreign-migration-sentinel ] || exit 34
  [ "$DB_APP_CONNECTION_LIMIT" = 2 ] && [ "$DB_SERVICE_CONNECTION_LIMIT" = 8 ] || exit 35
  [ "$DB_HOST" = 172.19.0.2 ] || exit 36
  printf 'destination-only root; selected lane credentials; app2/service8\n' >> "${FAKE_REMOTE_ROOT}/provision-proof.log"
  exit "${FAKE_DESTINATION_PROVISION_RESULT:-0}"
fi
if [[ "$*" == *MIGRATION_IDENTITY_SQL_B64* ]]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -e) export "$2"; shift 2 ;;
      postgres:15) shift; break ;;
      *) shift ;;
    esac
  done
  [ "$1" = sh ] && [ "$2" = -ceu ] && [ "$#" -eq 3 ]
  exec "$@"
fi
if printf '%s\n' "$*" | grep -q ' config --format json'; then
  cat <<JSON
{"services":{"db-provision":{"volumes":[{"source":"${FAKE_REMOTE_ROOT}/opt/cogni-template-runtime/postgres-init/provision.sh","target":"/app/provision.sh","read_only":true}]},"doltgres":{"volumes":[{"source":"${FAKE_REMOTE_ROOT}/opt/cogni-template-runtime/doltgres-init/install-creds.sh","target":"/usr/local/bin/install-creds.sh","read_only":true}]},"doltgres-provision":{"volumes":[{"source":"${FAKE_REMOTE_ROOT}/opt/cogni-template-runtime/doltgres-init/provision.sh","target":"/app/provision.sh","read_only":true}]},"alloy":{"volumes":[{"source":"${FAKE_REMOTE_ROOT}/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy","target":"/etc/alloy/config.alloy","read_only":true}]},"caddy":{"volumes":[{"source":"${FAKE_REMOTE_ROOT}/opt/cogni-template-edge/configs/Caddyfile.tmpl","target":"/etc/caddy/Caddyfile","read_only":true}]}}}
JSON
  exit 0
fi
if printf '%s\n' "$*" | grep -q ' ps -q caddy'; then
  echo caddy123
  exit 0
fi
if printf '%s\n' "$*" | grep -q ' config --services'; then
  echo postgres
  echo doltgres
  exit 0
fi
# The lane's Temporal namespace ensure (task.5132) runs the REAL
# ensure-temporal-namespace.sh over this stub. It polls
# `docker inspect --format={{.State.Health.Status}}` and blocks until "healthy",
# so a stub that answers nothing burns the full TEMPORAL_TIMEOUT and then fails.
if [ "${1:-}" = inspect ] && [[ "$*" == *NetworkSettings.Networks* ]]; then
  printf '%s\n' "${FAKE_DESTINATION_PG_IP:-172.19.0.2}"
  exit 0
fi
if printf '%s\n' "$*" | grep -q '^inspect '; then
  echo healthy
  exit 0
fi
# A dedicated namespace proves that a transient registration DeadlineExceeded
# is retried. The first register fails, describe still reports absent, and the
# second register succeeds. All other namespaces retain the idempotent no-op.
if printf '%s\n' "$*" | grep -q -- '--ns retry-proof'; then
  count_file="${FAKE_REMOTE_ROOT}/temporal-register-count"
  count="$(cat "$count_file" 2>/dev/null || echo 0)"
  if printf '%s\n' "$*" | grep -q 'namespace describe'; then
    [ "$count" -ge 2 ]
    exit $?
  fi
  if printf '%s\n' "$*" | grep -q 'namespace register'; then
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if [ "$count" -eq 1 ]; then
      echo 'rpc error: code = DeadlineExceeded desc = context deadline exceeded' >&2
      exit 1
    fi
    exit 0
  fi
fi
# `tctl namespace describe` succeeding means "already registered", which is the
# idempotent no-op path — the assertion below is that the ensure was ATTEMPTED.
exit 0
EOF
chmod +x "$FAKEBIN/docker"

RETRYBIN="$TMPROOT/retry-bin"
mkdir -p "$RETRYBIN"
cat > "$RETRYBIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$RETRYBIN/sleep"

env \
  PATH="$RETRYBIN:$FAKEBIN:$PATH" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" \
  TEMPORAL_NAMESPACE=retry-proof \
  TEMPORAL_CONTAINER=cogni-runtime-temporal-1 \
  bash scripts/ci/ensure-temporal-namespace.sh > "$TMPROOT/temporal-retry.out" 2>&1
[ "$(cat "$REMOTE_ROOT/temporal-register-count")" = "2" ]
grep -q "registration failed transiently; retrying" "$TMPROOT/temporal-retry.out"
grep -q "created successfully" "$TMPROOT/temporal-retry.out"

cat > "$FAKEBIN/hostname" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-I" ]; then
  echo "10.0.0.1 "
  exit 0
fi
/bin/hostname "$@"
EOF
chmod +x "$FAKEBIN/hostname"

DNSBIN="$TMPROOT/dns-bin"
mkdir -p "$DNSBIN"
cat > "$DNSBIN/getent" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = ahostsv4 ] || exit 1
case "${2:-}" in
  cogni-candidate-a.vm.cognidao.org) printf '127.0.0.1 STREAM %s\n' "$2" ;;
  cogni-preview.vm.cognidao.org) printf '203.0.113.2 STREAM %s\n' "$2" ;;
  cogni.vm.cognidao.org) printf '203.0.113.1 STREAM %s\n' "$2" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$DNSBIN/getent"
export PATH="$DNSBIN:$PATH"

# The reliability manifests are stacked in task.5247, so make their exact
# two-ExternalSecret contract explicit here instead of silently skipping the
# task.5246 reconciliation branch when this prerequisite PR runs standalone.
APP_FIXTURE="$TMPROOT/app-src"
mkdir -p \
  "$APP_FIXTURE/infra/k8s/overlays/candidate-a/operator" \
  "$APP_FIXTURE/nodes/operator/k8s/external-secrets/candidate-a"
ln -s "$REPO_ROOT/nodes/operator/.cogni" "$APP_FIXTURE/nodes/operator/.cogni"
ln -s "$REPO_ROOT/infra/catalog" "$APP_FIXTURE/infra/catalog"
ln -s "$REPO_ROOT/infra/database-budget-profiles.yaml" "$APP_FIXTURE/infra/database-budget-profiles.yaml"
ln -s "$REPO_ROOT/infra/k8s/overlays/candidate-a/operator/external-secret.yaml" \
  "$APP_FIXTURE/infra/k8s/overlays/candidate-a/operator/external-secret.yaml"
ln -s "$REPO_ROOT/nodes/operator/k8s/external-secrets/candidate-a/external-secret.yaml" \
  "$APP_FIXTURE/nodes/operator/k8s/external-secrets/candidate-a/external-secret.yaml"
cat > "$APP_FIXTURE/infra/k8s/overlays/candidate-a/operator/database-reliability-actuator-external-secret.yaml" <<'EOF'
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: database-reliability-actuator-env-secrets }
spec: { target: { name: database-reliability-actuator-env-secrets } }
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: database-reliability-readmitter-env-secrets }
spec: { target: { name: database-reliability-readmitter-env-secrets } }
EOF

# Read-only reconcile: the superuser (POSTGRES_ROOT) stays in the VM runtime .env
# that the db-provision compose service reads; per-node app/service passwords come
# from OpenBao (the put_secret operator ... above), read via the db-reader token —
# NEVER from CI env. No APP_DB_* threaded: provision.sh computes app_<node>.
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
  RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LEGACY_EXTERNAL_SECRET_TARGET="operator-env-secrets" \
  APP_SOURCE_DIR="$APP_FIXTURE" \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/summary.json" \
  bash scripts/ci/reconcile-node-substrate.sh candidate-a operator > "$TMPROOT/out.txt"

grep -q "substrate ready inputs reconciled for operator" "$TMPROOT/out.txt"
remote_provisioner="$REMOTE_ROOT/opt/cogni-template-runtime/postgres-init/provision.sh"
cmp infra/compose/runtime/postgres-init/provision.sh "$remote_provisioner"
# GNU stat accepts -f as "filesystem" mode and can emit output before rejecting
# the BSD format operand. Prefer GNU's file-format form, then fall back to BSD.
provisioner_mode="$(stat -c '%a' "$remote_provisioner" 2>/dev/null || stat -f '%Lp' "$remote_provisioner")"
[ "$provisioner_mode" = 444 ]
grep -q 'cogni-reconcile.postgres-provisioner\.' "$REMOTE_ROOT/scp.log"
install_line="$(grep -n 'exact runtime compose and provisioners installed ok' "$TMPROOT/out.txt" | cut -d: -f1)"
provision_line="$(grep -n '\[remote\] db-provision ok' "$TMPROOT/out.txt" | cut -d: -f1)"
[ "$install_line" -lt "$provision_line" ]
grep -Fq -- "--profile * config --format json" "$REMOTE_ROOT/docker.log"
cat > "$TMPROOT/expected-migration-identity.sql" <<'SQL'
SELECT session_user = 'migration_operator'
   AND current_user = 'app_operator'
   AND current_database() = 'cogni_operator'
   AND NOT role_state.rolsuper
   AND NOT role_state.rolcreaterole
   AND NOT role_state.rolcreatedb
   AND NOT role_state.rolreplication
   AND NOT role_state.rolbypassrls
   AND role_state.rolconnlimit = 1
   AND current_setting('statement_timeout') IN ('15min', '900s')
   AND current_setting('temp_file_limit') = '128MB'
   AND (SELECT count(*) FROM pg_auth_members membership
          JOIN pg_roles parent ON parent.oid = membership.roleid
         WHERE membership.member = role_state.oid
           AND parent.rolname ~ '^(app|service|migration)_') = 1
   AND pg_has_role(session_user, 'app_operator', 'MEMBER')
  FROM pg_roles role_state
 WHERE role_state.rolname = session_user;
SQL
base64 --decode < "$REMOTE_ROOT/migration-identity.b64" > "$TMPROOT/decoded-migration-identity.sql"
cmp "$TMPROOT/expected-migration-identity.sql" "$TMPROOT/decoded-migration-identity.sql"
cmp "$TMPROOT/expected-migration-identity.sql" "$REMOTE_ROOT/migration-identity.sql"
! grep -Fq '\047' "$REMOTE_ROOT/migration-identity.sql"
grep -q 'migration role identity/budget readback failed' "$remote_provisioner"
cmp infra/compose/runtime/docker-compose.yml "$REMOTE_ROOT/opt/cogni-template-runtime/docker-compose.yml"
cmp infra/compose/runtime/doltgres-init/install-creds.sh "$REMOTE_ROOT/opt/cogni-template-runtime/doltgres-init/install-creds.sh"
cmp infra/compose/runtime/doltgres-init/provision.sh "$REMOTE_ROOT/opt/cogni-template-runtime/doltgres-init/provision.sh"
cmp infra/compose/edge/docker-compose.yml "$REMOTE_ROOT/opt/cogni-template-edge/docker-compose.yml"
grep -q '\[remote\] exact runtime compose mounts verified ok' "$TMPROOT/out.txt"
grep -q "deleted legacy ExternalSecret env-secrets targeting operator-env-secrets" "$TMPROOT/out.txt"
grep -q -- "-n cogni-candidate-a delete externalsecret env-secrets" "$REMOTE_ROOT/kubectl.log"
grep -q -- "-n cogni-candidate-a annotate externalsecret operator-env-secrets force-sync=" "$REMOTE_ROOT/kubectl.log"
grep -q -- "-n cogni-candidate-a wait --for=condition=Ready externalsecret/operator-env-secrets --timeout=120s" "$REMOTE_ROOT/kubectl.log"
grep -q -- "-n cogni-candidate-a get secret operator-env-secrets" "$REMOTE_ROOT/kubectl.log"
grep -q -- "annotate externalsecret operator-database-reliability-actuator-env-secrets force-sync=" "$REMOTE_ROOT/kubectl.log"
grep -q -- "annotate externalsecret operator-database-reliability-readmitter-env-secrets force-sync=" "$REMOTE_ROOT/kubectl.log"
grep -q -- "get secret database-reliability-actuator-env-secrets -o jsonpath={.data.DATABASE_RELIABILITY_ADMIN_URL}" "$REMOTE_ROOT/kubectl.log"
grep -q -- "get secret database-reliability-readmitter-env-secrets -o jsonpath={.data.DATABASE_RELIABILITY_READMIT_URL}" "$REMOTE_ROOT/kubectl.log"
grep -q 'metadata.name == "env-secrets"' scripts/ci/reconcile-node-substrate.sh
operator_node_id="$(yq -r '.node_id' nodes/operator/.cogni/repo-spec.yaml)"
grep -q -- "--ns cogni-candidate-a" "$REMOTE_ROOT/docker.log"
grep -q -- "--ns cogni-candidate-a-${operator_node_id}" "$REMOTE_ROOT/docker.log"
# READ-ONLY on OpenBao: secret-materialize is the sole writer. After reconcile the
# node bank must hold ONLY the per-node creds we pre-seeded — reconcile writes
# nothing (no source:agent app keys, no DSNs). This locks the zero-write posture.
# operator's bank carries the env-wide DOLTGRES superuser SSOT in addition to its
# per-node DB creds; reconcile must leave all three untouched.
after_keys="$(cd "$BAO_ROOT/cogni/candidate-a/operator" && printf '%s\n' * | sort | paste -sd, -)"
if [ "$after_keys" != "APP_DB_PASSWORD,APP_DB_SERVICE_PASSWORD,DATABASE_SERVICE_URL,DATABASE_URL,DOLTGRES_PASSWORD,DOLT_CREDS_JWK,DOLT_CREDS_KEYID" ]; then
  echo "reconcile must perform ZERO OpenBao writes; operator bank changed to: $after_keys" >&2
  exit 1
fi
# operator is the primary (apex) host → the edge route key is OPERATOR_UPSTREAM
# (host.docker.internal:<node_port>), not <SLUG>_DOMAIN.
grep -q '^DOMAIN=test.cognidao.org$' "$REMOTE_ROOT/opt/cogni-template-edge/.env"
if grep -q 'stale.example.invalid' "$REMOTE_ROOT/opt/cogni-template-edge/.env"; then
  echo "k3s edge reconcile left the old environment domain in place" >&2
  exit 1
fi
grep -q '^OPERATOR_UPSTREAM=host.docker.internal:30000$' "$REMOTE_ROOT/opt/cogni-template-edge/.env"
grep -q 'COGNI_NODE_DBS=cogni_operator$' "$REMOTE_ROOT/opt/cogni-template-runtime/.env"
# Per-node single-node db-provision: COGNI_NODE_DBS overridden to THIS node + the
# per-node OpenBao passwords injected via -e (provision.sh computes app_<node>).
grep -q -- '-e COGNI_NODE_DBS=cogni_operator' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DATABASE_RELIABILITY_PASSWORD=reliability-pw-sentinel' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DATABASE_RELIABILITY_READMIT_PASSWORD=readmit-pw-sentinel' "$REMOTE_ROOT/docker.log"
grep -q -- '-e APP_DB_MIGRATION_PASSWORD=pernode-migration-pw-sentinel' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_BUDGET_PROFILE=operator-control-v1' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_APP_CONNECTION_LIMIT=7' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_APP_STATEMENT_TIMEOUT_MS=5000' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_SERVICE_CONNECTION_LIMIT=15' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_SERVICE_STATEMENT_TIMEOUT_MS=2000' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_LOCK_TIMEOUT_MS=2000' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=30000' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_TEMP_FILE_LIMIT_MIB=128' "$REMOTE_ROOT/docker.log"
grep -q -- '-e DB_WORK_MEM_MIB=16' "$REMOTE_ROOT/docker.log"
grep -qE -- '--profile bootstrap run --rm .* db-provision' "$REMOTE_ROOT/docker.log"

# PostgreSQL 15 security boundary: never grant broad CREATEROLE/role membership.
# The generated control identity receives only the scoped SECURITY DEFINER
# function plus status/session capabilities, and the function's guards exclude
# postgres, app_readonly, and a made-up unprovisioned role.
provisioner=infra/compose/runtime/postgres-init/provision.sh
# The shared readonly role must be reconciled atomically, not through the
# generic helper's independent existence/password sessions (bug.5471).
awk '
  /^# Shared read-only role \(env-level; superuser-derived/ { shared=1 }
  shared { print }
  shared && /^fi$/ { exit }
' "$provisioner" > "$TMPROOT/shared-readonly.sh"
grep -q 'APP_DB_READONLY_USER contains invalid characters' "$provisioner"
test "$(grep -c 'PGPASSWORD=.*psql ' "$TMPROOT/shared-readonly.sh")" -eq 1
if grep -q 'provision_app_role\|run_sql_as_root' "$TMPROOT/shared-readonly.sh"; then
  echo "shared readonly reconciliation must not split PostgreSQL sessions" >&2; exit 1
fi
awk '
  /^BEGIN ISOLATION LEVEL READ COMMITTED;$/ { if (step != 0) exit 1; step=1 }
  /^SET LOCAL statement_timeout = '\''30s'\'';$/ { if (step != 1) exit 1; step=2 }
  /^SELECT pg_advisory_xact_lock\(hashtextextended\(/ { if (step != 2) exit 1; step=3 }
  /^SELECT EXISTS .*readonly_exists \\gset$/ { if (step != 3) exit 1; step=4 }
  /^\\if :readonly_exists$/ { if (step != 4) exit 1; step=5 }
  /^ALTER ROLE .* WITH PASSWORD :'\''pw'\'';$/ { if (step != 5) exit 1; step=6 }
  /^\\else$/ { if (step != 6) exit 1; step=7 }
  /^CREATE ROLE .* WITH LOGIN PASSWORD :'\''pw'\'' BYPASSRLS;$/ { if (step != 7) exit 1; step=8 }
  /^\\endif$/ { if (step != 8) exit 1; step=9 }
  /^ALTER ROLE .* SET default_transaction_read_only = on;$/ { if (step != 9) exit 1; step=10 }
  /^ALTER ROLE .* SET statement_timeout = '\''30s'\'';$/ { if (step != 10) exit 1; step=11 }
  /^GRANT pg_monitor TO / { if (step != 11) exit 1; step=12 }
  /^COMMIT;$/ { if (step != 12) exit 1; step=13 }
  END { if (step != 13) exit 1 }
' "$TMPROOT/shared-readonly.sh"
grep -Fq "'cogni:shared-readonly:' || :'readonly_role'" "$TMPROOT/shared-readonly.sh"
grep -Fq -- '-v readonly_role="$APP_READONLY_USER" -v pw="$APP_READONLY_PASS"' "$TMPROOT/shared-readonly.sh"
grep -q 'ALTER ROLE.*CONNECTION LIMIT.*DB_APP_CONNECTION_LIMIT' "$provisioner"
grep -q 'ALTER ROLE.*CONNECTION LIMIT.*DB_SERVICE_CONNECTION_LIMIT' "$provisioner"
grep -q 'ALTER ROLE.*SET statement_timeout' "$provisioner"
grep -q 'ALTER ROLE.*SET lock_timeout' "$provisioner"
grep -q 'ALTER ROLE.*SET idle_in_transaction_session_timeout' "$provisioner"
grep -q 'ALTER ROLE.*SET temp_file_limit' "$provisioner"
grep -q 'ALTER ROLE.*SET work_mem' "$provisioner"
grep -q 'database budget profile.*failed readback' "$provisioner"
grep -q 'rolconnlimit =.*DB_APP_CONNECTION_LIMIT' "$provisioner"
grep -q 'rolconnlimit =.*DB_SERVICE_CONNECTION_LIMIT' "$provisioner"
grep -q "statement_timeout=\${DB_SERVICE_STATEMENT_TIMEOUT_MS}ms" "$provisioner"
grep -q 'key: DATABASE_MIGRATION_URL' infra/k8s/base/node-app/deployment.yaml
grep -q 'operator-migration-secrets' "$REMOTE_ROOT/kubectl.log"
grep -q 'creationPolicy: Owner' scripts/ci/reconcile-node-substrate.sh
if grep -q 'DATABASE_MIGRATION_URL' packages/repo-spec/src/node-app-deployment.ts; then
  echo "migration DSN must not enter the node runtime profile" >&2
  exit 1
fi
rendered_node="$(kubectl kustomize infra/k8s/overlays/candidate-a/operator)"
app_container="$(printf '%s' "$rendered_node" | yq 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "app")')"
if grep -q 'DATABASE_MIGRATION_URL\|migration-secrets' <<<"$app_container"; then
  echo "k3s app container must not receive the migration identity" >&2
  exit 1
fi
printf '%s' "$rendered_node" | yq -e 'select(.kind == "Deployment") | .spec.template.spec.initContainers[] | select(.name == "migrate") | .env[] | select(.name == "DATABASE_URL") | .valueFrom.secretKeyRef.name == "operator-migration-secrets"' >/dev/null
grep -q 'runtime role.*fresh-session budget mismatch' "$provisioner"
grep -q 'runtime role.*can override enforced temp_file_limit' "$provisioner"
grep -q 'work_mem values below are intentionally fresh-session defaults, not ceilings' "$provisioner"
grep -q 'migration role identity/budget readback failed' "$provisioner"
if grep -q 'app_readonly.*DB_.*TIMEOUT\|ALTER ROLE.*APP_READONLY.*CONNECTION LIMIT' "$provisioner"; then
  echo "shared app_readonly must stay outside per-node budget profiles" >&2
  exit 1
fi
grep -q 'ALTER ROLE.*NOCREATEROLE' "$provisioner"
grep -q 'ALTER ROLE.*app_role.*INHERIT NOCREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS' "$provisioner"
grep -q 'ALTER ROLE.*svc_role.*INHERIT NOCREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION BYPASSRLS' "$provisioner"
grep -q 'runtime_memberships <> 0' "$provisioner"
grep -q 'REVOKE ALL ON FUNCTION public.contain_database_role' "$provisioner"
grep -q 'GRANT EXECUTE ON FUNCTION public.contain_database_role.*RELIABILITY_ROLE' "$provisioner"
grep -q 'REVOKE ALL ON FUNCTION public.readmit_database_role' "$provisioner"
grep -q 'GRANT EXECUTE ON FUNCTION public.readmit_database_role.*READMITTER_ROLE' "$provisioner"
awk -v guard="  IF to_regnamespace('cogni_control') IS NOT NULL THEN" '
  /^CREATE OR REPLACE FUNCTION public\.(contain|readmit)_database_role\(/ { in_legacy=1 }
  in_legacy && /^BEGIN$/ {
    if (getline <= 0 || $0 != guard) exit 1
    seen++; in_legacy=0
  }
  END { if (seen != 2) exit 1 }
' "$provisioner"
if grep -Eq '^GRANT EXECUTE ON FUNCTION public\.(contain|readmit)_database_role' "$provisioner"; then
  echo "legacy control EXECUTE grants must not be unconditional" >&2; exit 1
fi
grep -q "IF to_regnamespace('cogni_control') IS NULL THEN" "$provisioner"
grep -q 'FROM "\$RELIABILITY_ROLE", "\$READMITTER_ROLE"' "$provisioner"
grep -q "session_user <> '\$RELIABILITY_ROLE'" "$provisioner"
grep -q "session_user <> '\$READMITTER_ROLE'" "$provisioner"
grep -q 'REVOKE SET ON PARAMETER temp_file_limit FROM PUBLIC' "$provisioner"
if grep -q 'REVOKE SET ON PARAMETER statement_timeout FROM PUBLIC' "$provisioner"; then
  echo "PG15 USERSET parameter ACL must not be claimed as a hard ceiling" >&2
  exit 1
fi
grep -q "target_role !~ '\^(app|service)_" "$provisioner"
grep -q "database_role_boundary.datname = 'cogni_'" "$provisioner"
grep -q "app_owner.rolname = 'app_'" "$provisioner"
grep -q 'WHERE usename = target_role' "$provisioner"
if grep -q 'GRANT .*pg_signal_backend.*RELIABILITY_ROLE' "$provisioner"; then
  echo "reliability identity must not be able to terminate an unscoped neighbor session" >&2
  exit 1
fi
if grep -q 'GRANT .* TO .*RELIABILITY_ROLE.*WITH ADMIN OPTION' "$provisioner"; then
  echo "PG15 reliability identity must not receive unsafe ADMIN membership" >&2
  exit 1
fi
if grep -Eq 'GRANT[[:space:]]+"?(app|service)_' "$provisioner"; then
  echo "reliability identity must not receive membership in node data roles" >&2
  exit 1
fi
# doltgres-provision gets the operator-canonical superuser injected via -e (fail-loud
# if absent; never the poisoned VM .env value) AND is node-scoped via -e COGNI_NODE_DBS
# (bug.5033 — symmetric with db-provision so knowledge_<node> is created deterministically,
# not silently skipped → no node-app Init:CrashLoopBackOff).
grep -qE -- '--profile bootstrap run --rm -e COGNI_NODE_DBS=cogni_operator -e DOLTGRES_PASSWORD=.* doltgres-provision' "$REMOTE_ROOT/docker.log"

# DoltHub mirror PROD-ONLY purge (bug.5003): candidate-a is NON-PROD, so the lane must
# NEVER deliver the prod-capable DoltHub push cred — even one left in the VM .env by a
# pre-guard flight (seeded above). It actively STRIPS the four keys and force-recreates
# doltgres so install-creds.sh re-runs and no-ops (mirror dark). It also does NOT read
# the operator bank creds at all in non-prod (the zero-write bank assertion above still
# holds: the seeded bank DOLT_CREDS_* remain untouched).
for k in DOLT_CREDS_JWK DOLT_CREDS_KEYID DOLTHUB_OWNER DOLTHUB_API_TOKEN; do
  grep -qE "^${k}=" "$REMOTE_ROOT/opt/cogni-template-runtime/.env" \
    && { echo "non-prod: ${k} was NOT stripped from VM runtime .env (prod-capable cred left on a test VM)" >&2; exit 1; }
done
grep -q 'up -d --force-recreate doltgres' "$REMOTE_ROOT/docker.log" \
  || { echo "doltgres not force-recreated after mirror-cred purge (install-creds.sh would not re-run → mirror not dark)" >&2; exit 1; }
grep -q 'dolt_mirror_creds' <(python3 -c 'import json,sys; print("\n".join(r["row"] for r in json.load(open(sys.argv[1]))["rows"]))' "$TMPROOT/summary.json") \
  || { echo "dolt_mirror_creds row missing from reconcile summary" >&2; exit 1; }

# Idempotency: a second reconcile with UNCHANGED creds must NOT recreate doltgres again
# (hash-gate). Count force-recreates before/after a re-run and assert no new one — never
# clear docker.log, so the first-run evidence later assertions read (e.g. 'restart alloy')
# stays intact regardless of ordering.
recreate_before="$(grep -c 'up -d --force-recreate doltgres' "$REMOTE_ROOT/docker.log" || true)"
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
  RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LEGACY_EXTERNAL_SECRET_TARGET="operator-env-secrets" \
  bash scripts/ci/reconcile-node-substrate.sh candidate-a operator > "$TMPROOT/rerun.txt"
recreate_after="$(grep -c 'up -d --force-recreate doltgres' "$REMOTE_ROOT/docker.log" || true)"
if [ "$recreate_before" != "$recreate_after" ]; then
  echo "hash-gate broken: doltgres force-recreated on a no-change re-reconcile (would churn the mirror every flight)" >&2
  exit 1
fi
grep -q 'substrate ready inputs reconciled for operator' "$TMPROOT/rerun.txt"

# PLACEMENT_DOES_NOT_GATE_PROVISIONING: an Akash-placed node still reconciles
# its ExternalSecret, Postgres role/database, shared DB inventory, Doltgres DB,
# and env-global Alloy/Dolt state. Only the k3s Caddy/NodePort edge path is
# excluded. Slice operation logs at their current line counts so every assertion
# below belongs to this pass without erasing evidence used by earlier/later gates.
docker_log_start="$(wc -l < "$REMOTE_ROOT/docker.log" | tr -d ' ')"
kubectl_log_start="$(wc -l < "$REMOTE_ROOT/kubectl.log" | tr -d ' ')"
scp_log_start="$(wc -l < "$REMOTE_ROOT/scp.log" | tr -d ' ')"
cp "$REMOTE_ROOT/opt/cogni-template-edge/.env" "$TMPROOT/edge-env.before-akash"
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  DEPLOYMENT_PROVIDER=akash \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
  RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/akash-summary.json" \
  bash scripts/ci/reconcile-node-substrate.sh candidate-a operator > "$TMPROOT/akash.out"
tail -n "+$((docker_log_start + 1))" "$REMOTE_ROOT/docker.log" > "$TMPROOT/akash-docker.log"
tail -n "+$((kubectl_log_start + 1))" "$REMOTE_ROOT/kubectl.log" > "$TMPROOT/akash-kubectl.log"
tail -n "+$((scp_log_start + 1))" "$REMOTE_ROOT/scp.log" > "$TMPROOT/akash-scp.log"
cmp -s "$TMPROOT/edge-env.before-akash" "$REMOTE_ROOT/opt/cogni-template-edge/.env" \
  || { echo "Akash reconcile mutated the k3s edge env" >&2; exit 1; }
grep -q -- "-n cogni-candidate-a annotate externalsecret operator-env-secrets force-sync=" "$TMPROOT/akash-kubectl.log"
grep -q -- "-e COGNI_NODE_DBS=cogni_operator" "$TMPROOT/akash-docker.log"
grep -qE -- "--profile bootstrap run --rm .* db-provision" "$TMPROOT/akash-docker.log"
grep -qE -- "--profile bootstrap run --rm -e COGNI_NODE_DBS=cogni_operator -e DOLTGRES_PASSWORD=.* doltgres-provision" "$TMPROOT/akash-docker.log"
grep -q "cogni-reconcile.alloy-config\." "$TMPROOT/akash-scp.log"
if grep -qE "Caddyfile|reconcile-edge-caddy" "$TMPROOT/akash-scp.log"; then
  echo "Akash reconcile staged k3s Caddy/NodePort edge inputs" >&2
  exit 1
fi
if grep -q "cogni-edge" "$TMPROOT/akash-docker.log"; then
  echo "Akash reconcile invoked the k3s edge compose project" >&2
  exit 1
fi
python3 - "$TMPROOT/akash-summary.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
rows = {r["row"]: r["state"] for r in s["rows"]}
assert s["status"] == "success", s
assert rows["externalsecret"] == "updated", rows
assert rows["externalsecret_refresh"] == "refreshed", rows
assert rows["caddyfile"] == "skipped", rows
assert rows["remote_reconcile"] == "updated", rows
PY

# Born-observable (bug.5041): the Alloy node-label config is staged to the VM and
# the shared hash-gated restart helper runs — on EVERY substrate-readiness pass,
# so an app-only promote (skip_infra) re-pushes it. First run = changed = restart.
test -f "$REMOTE_ROOT/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy" \
  || { echo "alloy node-label config not staged to the VM runtime configs dir" >&2; exit 1; }
grep -q 'restart alloy' "$REMOTE_ROOT/docker.log" \
  || { echo "alloy not restarted after config change (born-observable Gap 1)" >&2; exit 1; }

# Per-node DB passwords + the doltgres superuser transit the VM-local SSH/docker env
# (by design), but must NEVER reach CI stdout. The db-reader token must not leak either.
if grep -q 'sk-or-existing\|pernode-app-pw-sentinel\|pernode-svc-pw-sentinel\|doltgres-super-sentinel\|dolt-token\|writer-token\|jwk-secret-sentinel' "$TMPROOT/out.txt"; then
  echo "secret value leaked to output" >&2
  exit 1
fi

# Structured reconcile summary is emitted, complete, and redacted.
test -f "$TMPROOT/summary.json"
python3 - "$TMPROOT/summary.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
assert s["type"] == "target_substrate_reconcile_summary", s["type"]
assert s["status"] == "success", s["status"]
assert s["target"] == "operator", s["target"]
assert s["target_type"] == "node", s["target_type"]
assert s["failed_row_count"] == 0, s["failed_rows"]
rows = {r["row"] for r in s["rows"]}
expected = {"reader_token", "db_creds", "externalsecret", "externalsecret_refresh", "caddyfile", "remote_reconcile"}
assert expected <= rows, (expected - rows, rows)
PY
if grep -qE 'pernode-app-pw-sentinel|pernode-svc-pw-sentinel|writer-token' "$TMPROOT/summary.json"; then
  echo "secret value leaked into reconcile summary" >&2
  exit 1
fi

ln -s "$REPO_ROOT" "$TMPROOT/app-src"
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  APP_SOURCE_DIR="$TMPROOT/app-src" \
  COGNI_CATALOG_ROOT=infra/catalog \
  RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
  RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  bash scripts/ci/reconcile-node-substrate.sh candidate-a operator > "$TMPROOT/relative-catalog-root.out"
grep -q "substrate ready inputs reconciled for operator" "$TMPROOT/relative-catalog-root.out"

# task.5017 — deploy ⊆ provisioned: reconciling a node into an env outside its
# `envs:` node-set must fail loud BEFORE any substrate mutation. Every real catalog node
# is now all-envs (node-template opted into production in story.5009), so this guard is
# exercised against a FIXTURE catalog where node-template is restricted to [candidate-a] —
# testing the enforcement logic with controlled input, decoupled from the live node-set.
RESTRICTED_CATALOG="$TMPROOT/restricted-catalog"
cp -r infra/catalog "$RESTRICTED_CATALOG"
yq -i '.envs = ["candidate-a"]' "$RESTRICTED_CATALOG/node-template.yaml"
set +e
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  APP_SOURCE_DIR="$TMPROOT/app-src" \
  COGNI_CATALOG_ROOT="$RESTRICTED_CATALOG" \
  RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
  RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  bash scripts/ci/reconcile-node-substrate.sh production node-template > "$TMPROOT/offset-env.out" 2>&1
offset_rc=$?
set -e
[ "$offset_rc" -ne 0 ] || { echo "expected reconcile to fail for node-template in production (restricted fixture)" >&2; exit 1; }
grep -q "is not in the 'production' node-set" "$TMPROOT/offset-env.out" \
  || { echo "missing node-set rejection message; got:" >&2; cat "$TMPROOT/offset-env.out" >&2; exit 1; }

# A reset lane and a future catalog birth both provision their own instance from
# the custodian's job. Separate fake hosts expose accidental control-side writes.
FOREIGN_SOURCE="$TMPROOT/foreign-source"
FOREIGN_CATALOG="$FOREIGN_SOURCE/infra/catalog"
mkdir -p "$FOREIGN_CATALOG" "$BAO_ROOT/cogni/production/operator"
cp infra/catalog/*.yaml "$FOREIGN_CATALOG/"
cp infra/database-budget-profiles.yaml "$FOREIGN_SOURCE/infra/"
printf '%s' doltgres-super-sentinel > "$BAO_ROOT/cogni/production/operator/DOLTGRES_PASSWORD"
FOREIGN_NODE=poly-guard-fixture
cp "$FOREIGN_CATALOG/poly.yaml" "$FOREIGN_CATALOG/$FOREIGN_NODE.yaml"
yq -i ".name = \"$FOREIGN_NODE\"" "$FOREIGN_CATALOG/$FOREIGN_NODE.yaml"

for foreign_node in poly "$FOREIGN_NODE"; do
  control_db="cogni_${foreign_node//-/_}_candidate_a"
  migration_db="cogni_${foreign_node//-/_}"
  foreign_migration_dsn="postgresql://migration_${migration_db#cogni_}:foreign-migration-sentinel@127.0.0.1:5432/$migration_db"
  put_secret "$foreign_node" APP_DB_PASSWORD foreign-app-sentinel
  put_secret "$foreign_node" APP_DB_SERVICE_PASSWORD foreign-service-sentinel
  put_secret "$foreign_node" DATABASE_URL "postgresql://app_${migration_db#cogni_}:foreign-app-sentinel@127.0.0.1:5432/$migration_db"
  put_secret "$foreign_node" DATABASE_SERVICE_URL "postgresql://service_${migration_db#cogni_}:foreign-service-sentinel@127.0.0.1:5432/$migration_db"
  put_secret "$foreign_node-database-migration" APP_DB_MIGRATION_PASSWORD foreign-migration-sentinel
  put_secret "$foreign_node-database-migration" DATABASE_MIGRATION_URL "$foreign_migration_dsn"
  mkdir -p "$FOREIGN_SOURCE/nodes/$foreign_node/k8s/external-secrets/candidate-a"
  cp nodes/operator/k8s/external-secrets/candidate-a/external-secret.yaml \
    "$FOREIGN_SOURCE/nodes/$foreign_node/k8s/external-secrets/candidate-a/external-secret.yaml"
  docker_log_start="$(wc -l < "$REMOTE_ROOT/docker.log" | tr -d ' ')"
  env \
    VM_HOST=fake DOMAIN=test.cognidao.org DEPLOYMENT_PROVIDER=akash \
    SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
    APP_SOURCE_DIR="$FOREIGN_SOURCE" COGNI_CATALOG_ROOT="$FOREIGN_CATALOG" \
    RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
    RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
    FAKE_REMOTE_ROOT="$REMOTE_ROOT" FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" \
    FAKE_MIGRATION_DSN="$foreign_migration_dsn" \
    SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/$foreign_node-summary.json" \
    bash scripts/ci/reconcile-node-substrate.sh candidate-a "$foreign_node" \
    > "$TMPROOT/$foreign_node.out"
  tail -n "+$((docker_log_start + 1))" "$REMOTE_ROOT/docker.log" > "$TMPROOT/$foreign_node-docker.log"
  grep -qE -- "--profile bootstrap run --rm -e COGNI_NODE_DBS=$control_db .* doltgres-provision" \
    "$TMPROOT/$foreign_node-docker.log"
  grep -q "$control_db" "$REMOTE_ROOT/opt/cogni-template-runtime/.env"
  grep -q 'projected migration DSN digest and live identity verified ok' "$TMPROOT/$foreign_node.out"
  jq -e '.rows[] | select(.row == "migration_dsn_proven") | .state == "ready"' \
    "$TMPROOT/$foreign_node-summary.json" >/dev/null
  # Preserve the exact SQL-byte assertion for each lane's separate PG identity.
  sed "s/operator/${migration_db#cogni_}/g" "$TMPROOT/expected-migration-identity.sql" \
    > "$TMPROOT/$foreign_node-expected-migration.sql"
  cmp "$TMPROOT/$foreign_node-expected-migration.sql" "$DESTINATION_ROOT/migration-identity.sql"
  if grep -qE ' up -d postgres| db-provision$' "$TMPROOT/$foreign_node-docker.log"; then
    echo 'foreign-resident Postgres mutation reached the control VM' >&2; exit 1
  fi
  jq -e '.rows[] | select(.row == "postgres_destination_provision") | .state == "updated"' \
    "$TMPROOT/$foreign_node-summary.json" >/dev/null
  jq -e '.rows[] | select(.row == "postgres_provision") | .state == "updated"' \
    "$TMPROOT/$foreign_node-summary.json" >/dev/null
  grep -q -- '--network container:destination-postgres' "$DESTINATION_ROOT/docker.log"
  grep -q -- '--pull=never --cpus=.5 --memory=256m --pids-limit=64' "$DESTINATION_ROOT/docker.log"
  grep -q 'destination-only root; selected lane credentials; app2/service8' "$DESTINATION_ROOT/provision-proof.log"
  if grep -qE 'foreign-app-sentinel|foreign-service-sentinel|foreign-migration-sentinel|destination-only-root-sentinel' \
    "$TMPROOT/$foreign_node.out" "$TMPROOT/$foreign_node-summary.json" "$REMOTE_ROOT/destination-ssh-argv.log"; then
    echo 'destination bridge evidence or SSH argv leaked a credential' >&2; exit 1
  fi
done

# Fail-closed bank, destination identity and provisioning gates all run before
# reporting readiness. These remain orchestration tests, not real SQL proof.
run_foreign_reconcile() {
  env \
    VM_HOST=fake DOMAIN=test.cognidao.org DEPLOYMENT_PROVIDER=akash \
    SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
    APP_SOURCE_DIR="$FOREIGN_SOURCE" COGNI_CATALOG_ROOT="$FOREIGN_CATALOG" \
    RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
    RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
    FAKE_REMOTE_ROOT="$REMOTE_ROOT" FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" \
    FAKE_MIGRATION_DSN="$foreign_migration_dsn" \
    FAKE_DESTINATION_PROVISION_RESULT="${FAKE_DESTINATION_PROVISION_RESULT:-0}" \
    FAKE_DESTINATION_PG_IP="${FAKE_DESTINATION_PG_IP:-172.19.0.2}" \
    SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/$1-summary.json" \
    bash scripts/ci/reconcile-node-substrate.sh candidate-a "$FOREIGN_NODE"
}
control_docker_before="$(wc -l < "$REMOTE_ROOT/docker.log")"
destination_docker_before="$(wc -l < "$DESTINATION_ROOT/docker.log")"
scp_before="$(wc -l < "$REMOTE_ROOT/scp.log")"
put_secret "$FOREIGN_NODE" DATABASE_SERVICE_URL ''
if run_foreign_reconcile foreign-bank-missing > "$TMPROOT/foreign-bank-missing.out" 2>&1; then
  echo 'missing service DSN was silently substituted with the app DSN' >&2; exit 1
fi
[ "$control_docker_before" = "$(wc -l < "$REMOTE_ROOT/docker.log")" ]
[ "$destination_docker_before" = "$(wc -l < "$DESTINATION_ROOT/docker.log")" ]
[ "$scp_before" = "$(wc -l < "$REMOTE_ROOT/scp.log")" ]
put_secret "$FOREIGN_NODE" DATABASE_SERVICE_URL \
  "postgresql://service_${migration_db#cogni_}:foreign-service-sentinel@203.0.113.1:5432/$migration_db"
if run_foreign_reconcile foreign-bank-drift > "$TMPROOT/foreign-bank-drift.out" 2>&1; then
  echo 'a runtime DSN on the wrong instance passed bank agreement' >&2; exit 1
fi
[ "$control_docker_before" = "$(wc -l < "$REMOTE_ROOT/docker.log")" ]
[ "$destination_docker_before" = "$(wc -l < "$DESTINATION_ROOT/docker.log")" ]
[ "$scp_before" = "$(wc -l < "$REMOTE_ROOT/scp.log")" ]
put_secret "$FOREIGN_NODE" DATABASE_SERVICE_URL \
  "postgresql://service_${migration_db#cogni_}:foreign-service-sentinel@127.0.0.1:5432/$migration_db"

cp "$DESTINATION_ROOT/opt/cogni-template-runtime/.env" "$TMPROOT/destination-env.before"
sed 's/^DEPLOY_ENVIRONMENT=.*/DEPLOY_ENVIRONMENT=preview/' "$TMPROOT/destination-env.before" \
  > "$DESTINATION_ROOT/opt/cogni-template-runtime/.env"
if run_foreign_reconcile foreign-destination-mismatch > "$TMPROOT/foreign-destination-mismatch.out" 2>&1; then
  echo 'wrong destination runtime environment accepted' >&2; exit 1
fi
cp "$TMPROOT/destination-env.before" "$DESTINATION_ROOT/opt/cogni-template-runtime/.env"
[ "$control_docker_before" = "$(wc -l < "$REMOTE_ROOT/docker.log")" ]
[ "$destination_docker_before" = "$(wc -l < "$DESTINATION_ROOT/docker.log")" ]

destination_runs_before="$(grep -c -- '--network container:destination-postgres' "$DESTINATION_ROOT/docker.log" || true)"
if FAKE_DESTINATION_PG_IP=127.0.0.1 run_foreign_reconcile foreign-loopback \
  > "$TMPROOT/foreign-loopback.out" 2>&1; then
  echo 'loopback trust path accepted for authenticated provisioning' >&2; exit 1
fi
[ "$destination_runs_before" = "$(grep -c -- '--network container:destination-postgres' "$DESTINATION_ROOT/docker.log" || true)" ]

if FAKE_DESTINATION_PROVISION_RESULT=42 run_foreign_reconcile foreign-provision-failed \
  > "$TMPROOT/foreign-provision-failed.out" 2>&1; then
  echo 'destination provisioner failure reported success' >&2; exit 1
fi
[ "$control_docker_before" = "$(wc -l < "$REMOTE_ROOT/docker.log")" ]
jq -e '.status == "failure" and ([.rows[] | select(.row == "migration_dsn_proven" and .state == "ready")] | length == 0)' \
  "$TMPROOT/foreign-provision-failed-summary.json" >/dev/null
if grep -q 'substrate ready' "$TMPROOT/foreign-provision-failed.out"; then
  echo 'failed destination provisioning falsely reported readiness' >&2; exit 1
fi

# Delegating provisioning must never bypass mandatory destination authentication.
docker_log_start="$(wc -l < "$REMOTE_ROOT/docker.log" | tr -d ' ')"
if env \
  VM_HOST=fake DOMAIN=test.cognidao.org DEPLOYMENT_PROVIDER=akash \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  APP_SOURCE_DIR="$FOREIGN_SOURCE" COGNI_CATALOG_ROOT="$FOREIGN_CATALOG" \
  RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
  RECONCILE_NODE_SUBSTRATE_SCP_BIN="$FAKEBIN/scp" \
  FAKE_REMOTE_ROOT="$REMOTE_ROOT" FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_MIGRATION_DSN="$foreign_migration_dsn" FAKE_MIGRATION_PROBE_RESULT=f \
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/foreign-probe-failed-summary.json" \
  bash scripts/ci/reconcile-node-substrate.sh candidate-a "$FOREIGN_NODE" \
  > "$TMPROOT/foreign-probe-failed.out" 2>&1; then
  echo "foreign destination probe failure unexpectedly reconciled" >&2; exit 1
fi
tail -n "+$((docker_log_start + 1))" "$REMOTE_ROOT/docker.log" > "$TMPROOT/foreign-probe-failed-docker.log"
if grep -qE ' up -d postgres| db-provision$' "$TMPROOT/foreign-probe-failed-docker.log"; then
  echo "failed foreign probe reached control-host Postgres mutation" >&2; exit 1
fi
jq -e '.status == "failure" and ([.rows[] | select(.row == "migration_dsn_proven" and .state == "ready")] | length == 0)' \
  "$TMPROOT/foreign-probe-failed-summary.json" >/dev/null

# A missing catalog must stop before SSH, including the control-env fast path.
for lane in candidate-a production; do
  docker_log_start="$(wc -l < "$REMOTE_ROOT/docker.log" | tr -d ' ')"
  ssh_log_start="$(wc -l < "$REMOTE_ROOT/ssh-calls.log" | tr -d ' ')"
  scp_log_start="$(wc -l < "$REMOTE_ROOT/scp.log" | tr -d ' ')"
  if env \
    VM_HOST=fake DOMAIN=test.cognidao.org \
    SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
    APP_SOURCE_DIR="$FOREIGN_SOURCE" COGNI_CATALOG_ROOT="$FOREIGN_CATALOG" \
    RECONCILE_NODE_SUBSTRATE_SSH_BIN="$FAKEBIN/ssh" \
    FAKE_REMOTE_ROOT="$REMOTE_ROOT" FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" \
    bash scripts/ci/reconcile-node-substrate.sh "$lane" missing-node \
    > "$TMPROOT/missing-$lane.out" 2>&1; then
    echo "missing catalog unexpectedly reconciled" >&2; exit 1
  fi
  [ "$docker_log_start" = "$(wc -l < "$REMOTE_ROOT/docker.log" | tr -d ' ')" ] \
    || { echo "missing catalog reached remote mutation" >&2; exit 1; }
  [ "$ssh_log_start" = "$(wc -l < "$REMOTE_ROOT/ssh-calls.log" | tr -d ' ')" ] \
    || { echo "missing catalog reached SSH" >&2; exit 1; }
  [ "$scp_log_start" = "$(wc -l < "$REMOTE_ROOT/scp.log" | tr -d ' ')" ] \
    || { echo "missing catalog reached SCP" >&2; exit 1; }
done

# Reliability reconciliation follows an explicit catalog capability, never a
# privileged slug. Renaming the fixture and moving the bit yields the new owner
# without changing the production script.
CAPABILITY_CATALOG="$TMPROOT/reliability-capability-catalog"
mkdir -p "$CAPABILITY_CATALOG"
cat > "$CAPABILITY_CATALOG/alpha.yaml" <<'YAML'
name: alpha
reliability: { controller: true }
YAML
cat > "$CAPABILITY_CATALOG/bravo.yaml" <<'YAML'
name: bravo
reliability: { controller: false }
YAML
controller_for() {
  yq ea -N 'select(.reliability.controller == true) | .name' "$CAPABILITY_CATALOG"/*.yaml
}
[ "$(controller_for)" = alpha ]
yq -i '.reliability.controller = false' "$CAPABILITY_CATALOG/alpha.yaml"
yq -i '.reliability.controller = true' "$CAPABILITY_CATALOG/bravo.yaml"
[ "$(controller_for)" = bravo ]
grep -q "reliability_controller=.*reliability.controller" scripts/ci/reconcile-node-substrate.sh
grep -q 'overlays/${DEPLOY_ENVIRONMENT}/${TARGET_NODE}/database-reliability-actuator-external-secret.yaml' scripts/ci/reconcile-node-substrate.sh
if grep -q 'TARGET_NODE.*==.*operator' scripts/ci/reconcile-node-substrate.sh; then
  echo "reliability reconciliation must not branch on a node slug" >&2
  exit 1
fi

# Exercise the production runtime-loop orchestration separately from the real
# PG15 admission/ACL fixture. No subprocess failure may be swallowed.
awk '/^  for runtime_credential in / { capture=1 }
  /^  migration_identity=/ { exit }
  capture { print }' "$provisioner" > "$TMPROOT/runtime-probe-loop.sh"
test -s "$TMPROOT/runtime-probe-loop.sh"
cat > "$TMPROOT/runtime-probe-harness.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
probe_case="$1"
probe_log="$3"
PG_HOST=fixture PG_PORT=5432 PG_USER=postgres PG_PASS=root
db_name=cogni_fixture app_role=app_fixture svc_role=service_fixture
APP_PASS=app APP_SERVICE_PASS=service
DB_APP_STATEMENT_TIMEOUT_MS=5000 DB_SERVICE_STATEMENT_TIMEOUT_MS=2000
DB_LOCK_TIMEOUT_MS=1000 DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=30000
DB_TEMP_FILE_LIMIT_MIB=128 DB_WORK_MEM_MIB=16
psql() {
  local actor="" database="" sql=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -U) actor="$2"; shift 2 ;;
      -d) database="$2"; shift 2 ;;
      -c) sql="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  case "$sql" in
    "SELECT rolcanlogin"*)
      if [ "$probe_case" = contained ]; then echo f; else echo t; fi ;;
    "SELECT role_budget.rolconnlimit"*)
      case "$probe_case" in
        saturated|unsafe_acl|database_override) echo t ;;
        metadata_failure) return 2 ;;
        metadata_invalid) echo unknown ;;
        *) echo f ;;
      esac ;;
    "DO "*)
      [ "$actor:$database" = postgres:cogni_fixture ]
      printf 'safety:%s\n' "$database" >> "$probe_log"
      case "$probe_case" in unsafe_acl|database_override) return 1 ;; esac ;;
    "SELECT string_agg"*)
      printf 'authenticated:%s\n' "$actor" >> "$probe_log"
      [ "$probe_case" != wrong_password ] || return 2
      if [ "$actor" = app_fixture ]; then
        echo 5000:1000:30000:131072:16384
      else
        echo 2000:1000:30000:131072:16384
      fi ;;
    "SET temp_file_limit"*)
      printf 'negative_set:%s\n' "$actor" >> "$probe_log"
      return 1 ;;
    *) echo "unexpected probe query" >&2; exit 1 ;;
  esac
}
run_sql_as_root() {
  PGPASSWORD="$PG_PASS" psql -U "$PG_USER" -d "$1" -c "$2"
}
source "$2"
SH
for probe_case in saturated spare contained; do
  : > "$TMPROOT/runtime-$probe_case.log"
  bash "$TMPROOT/runtime-probe-harness.sh" "$probe_case" "$TMPROOT/runtime-probe-loop.sh" \
    "$TMPROOT/runtime-$probe_case.log" > "$TMPROOT/runtime-$probe_case.out"
done
[ "$(grep -c 'runtime_role_probe_deferred.*authentication=unverified' "$TMPROOT/runtime-saturated.out")" = 2 ]
[ "$(grep -c 'safety:cogni_fixture' "$TMPROOT/runtime-saturated.log")" = 2 ]
if grep -q 'authenticated:\|negative_set:' "$TMPROOT/runtime-saturated.log"; then
  echo "saturated runtime probe opened a runtime session" >&2; exit 1
fi
[ "$(grep -c 'authenticated:' "$TMPROOT/runtime-spare.log")" = 2 ]
[ "$(grep -c 'negative_set:' "$TMPROOT/runtime-spare.log")" = 2 ]
if grep -q 'runtime_role_probe_deferred' "$TMPROOT/runtime-spare.out"; then
  echo "spare runtime probe unexpectedly deferred" >&2; exit 1
fi
[ "$(grep -c 'remains contained' "$TMPROOT/runtime-contained.out")" = 2 ]
[ ! -s "$TMPROOT/runtime-contained.log" ]
for probe_case in wrong_password unsafe_acl database_override metadata_failure metadata_invalid; do
  : > "$TMPROOT/runtime-$probe_case.log"
  if bash "$TMPROOT/runtime-probe-harness.sh" "$probe_case" "$TMPROOT/runtime-probe-loop.sh" \
    "$TMPROOT/runtime-$probe_case.log" > "$TMPROOT/runtime-$probe_case.out" 2>&1; then
    echo "runtime probe failure '$probe_case' unexpectedly passed" >&2; exit 1
  fi
  if grep -q 'runtime_role_probe_deferred' "$TMPROOT/runtime-$probe_case.out"; then
    echo "failed runtime probe '$probe_case' reported deferral" >&2; exit 1
  fi
done

echo "PASS: reconcile-node-substrate.test.sh"
