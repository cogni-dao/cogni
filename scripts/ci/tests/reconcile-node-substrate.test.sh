#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t reconcile-node-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

FAKEBIN="$TMPROOT/bin"
REMOTE_ROOT="$TMPROOT/remote"
BAO_ROOT="$REMOTE_ROOT/openbao"
mkdir -p \
  "$FAKEBIN" \
  "$REMOTE_ROOT/opt/cogni-template-edge/configs" \
  "$REMOTE_ROOT/opt/cogni-template-runtime" \
  "$REMOTE_ROOT/tmp" \
  "$BAO_ROOT/cogni/candidate-a/node-template"

cat > "$REMOTE_ROOT/opt/cogni-template-edge/.env" <<'EOF'
DOMAIN=test.cognidao.org
OPERATOR_UPSTREAM=host.docker.internal:30080
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-edge/docker-compose.yml" <<'EOF'
services: {}
EOF
cat > "$REMOTE_ROOT/opt/cogni-template-runtime/.env" <<'EOF'
COGNI_NODE_DBS=cogni_operator
POSTGRES_ROOT_PASSWORD=postgres-root
APP_DB_USER=app_user
APP_DB_PASSWORD=app-pass
APP_DB_SERVICE_USER=app_service
APP_DB_SERVICE_PASSWORD=service-pass
DOLTGRES_PASSWORD=dolt-pass
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
# Doltgres superuser SSOT is operator-canonical (cogni/<env>/operator/DOLTGRES_PASSWORD),
# shared env-wide; reconcile reads it from operator and injects it into doltgres-provision.
put_secret operator DOLTGRES_PASSWORD doltgres-super-sentinel

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
  case "$1" in
    -i|-o) shift 2 ;;
    *) shift ;;
  esac
done
[ "$#" -gt 0 ] && shift # root@host
cmd="$*"
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
path="${dest#root@fake:}"
path="${path/\/tmp\//${FAKE_REMOTE_ROOT}\/tmp\/}"
mkdir -p "$(dirname "$path")"
cp "$src" "$path"
EOF
chmod +x "$FAKEBIN/scp"

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
if [ "${1:-}" = "apply" ]; then
  cat >/dev/null
  exit 0
fi
if [ "${1:-}" = "-n" ] && [ "${3:-}" = "apply" ]; then
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
    printf '{"data":{"data":%s}}\n' "$data"
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

cat > "$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_REMOTE_ROOT}/docker.log"
if printf '%s\n' "$*" | grep -q ' ps -q caddy'; then
  echo caddy123
  exit 0
fi
if printf '%s\n' "$*" | grep -q ' config --services'; then
  echo postgres
  echo doltgres
  exit 0
fi
exit 0
EOF
chmod +x "$FAKEBIN/docker"

cat > "$FAKEBIN/hostname" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-I" ]; then
  echo "10.0.0.1 "
  exit 0
fi
/bin/hostname "$@"
EOF
chmod +x "$FAKEBIN/hostname"

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
  SUBSTRATE_RECONCILE_SUMMARY_FILE="$TMPROOT/summary.json" \
  bash scripts/ci/reconcile-node-substrate.sh candidate-a operator > "$TMPROOT/out.txt"

grep -q "substrate ready inputs reconciled for operator" "$TMPROOT/out.txt"
# READ-ONLY on OpenBao: secret-materialize is the sole writer. After reconcile the
# node bank must hold ONLY the per-node creds we pre-seeded — reconcile writes
# nothing (no source:agent app keys, no DSNs). This locks the zero-write posture.
# operator's bank carries the env-wide DOLTGRES superuser SSOT in addition to its
# per-node DB creds; reconcile must leave all three untouched.
after_keys="$(cd "$BAO_ROOT/cogni/candidate-a/operator" && printf '%s\n' * | sort | paste -sd, -)"
if [ "$after_keys" != "APP_DB_PASSWORD,APP_DB_SERVICE_PASSWORD,DOLTGRES_PASSWORD" ]; then
  echo "reconcile must perform ZERO OpenBao writes; operator bank changed to: $after_keys" >&2
  exit 1
fi
# operator is the primary (apex) host → the edge route key is OPERATOR_UPSTREAM
# (host.docker.internal:<node_port>), not <SLUG>_DOMAIN.
grep -q '^OPERATOR_UPSTREAM=host.docker.internal:30000$' "$REMOTE_ROOT/opt/cogni-template-edge/.env"
grep -q 'COGNI_NODE_DBS=cogni_operator$' "$REMOTE_ROOT/opt/cogni-template-runtime/.env"
# Per-node single-node db-provision: COGNI_NODE_DBS overridden to THIS node + the
# per-node OpenBao passwords injected via -e (provision.sh computes app_<node>).
grep -q -- '-e COGNI_NODE_DBS=cogni_operator' "$REMOTE_ROOT/docker.log"
grep -qE -- '--profile bootstrap run --rm .* db-provision' "$REMOTE_ROOT/docker.log"
# doltgres-provision gets the operator-canonical superuser injected via -e (fail-loud
# if absent; never the poisoned VM .env value).
grep -qE -- '--profile bootstrap run --rm -e DOLTGRES_PASSWORD=.* doltgres-provision' "$REMOTE_ROOT/docker.log"

# Per-node DB passwords + the doltgres superuser transit the VM-local SSH/docker env
# (by design), but must NEVER reach CI stdout. The db-reader token must not leak either.
if grep -q 'sk-or-existing\|pernode-app-pw-sentinel\|pernode-svc-pw-sentinel\|doltgres-super-sentinel\|dolt-token\|writer-token' "$TMPROOT/out.txt"; then
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
expected = {"reader_token", "db_creds", "externalsecret", "caddyfile", "remote_reconcile"}
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
# `envs:` node-set must fail loud BEFORE any substrate mutation (oss is
# [candidate-a, preview], not production).
set +e
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
  bash scripts/ci/reconcile-node-substrate.sh production oss > "$TMPROOT/offset-env.out" 2>&1
offset_rc=$?
set -e
[ "$offset_rc" -ne 0 ] || { echo "expected reconcile to fail for oss in production (not in its envs)" >&2; exit 1; }
grep -q "is not in the 'production' node-set" "$TMPROOT/offset-env.out" \
  || { echo "missing node-set rejection message; got:" >&2; cat "$TMPROOT/offset-env.out" >&2; exit 1; }

echo "PASS: reconcile-node-substrate.test.sh"
