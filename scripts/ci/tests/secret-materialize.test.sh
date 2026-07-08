#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves the materialize side of the secret-materialize / reconcile split:
#   - source:agent app keys ARE materialized per-node (AUTH_SECRET);
#   - genuinely-shared values inherited from the env bank ARE materialized
#     (POSTHOG_API_KEY from node-template via the blind ancestor scan);
#   - canonical-custody (inheritFrom: operator) keys are materialized from the
#     operator path, NOT the blind ancestor scan (OPENROUTER_API_KEY — kills the
#     per-node split-brain that 429'd freshly-formed prod nodes);
#   - per-node DB creds + ALL THREE DSNs ARE composed sole-source here
#     (APP_DB_PASSWORD/SERVICE generated; DATABASE_URL/SERVICE_URL embed the
#     per-node app_<node> role; DOLTGRES_PASSWORD derived per-node + DOLTGRES_URL
#     composed from it as the postgres superuser — the bug.5002 cutover, both planes);
#   - no secret VALUE is echoed to stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT=$(mktemp -d -t secret-materialize.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

FAKEBIN="$TMPROOT/bin"
REMOTE_ROOT="$TMPROOT/remote"
BAO_ROOT="$REMOTE_ROOT/openbao"
mkdir -p "$FAKEBIN" "$REMOTE_ROOT/tmp" "$BAO_ROOT/cogni/candidate-a/node-template"

put_secret() {
  local svc="$1" key="$2" value="$3"
  mkdir -p "$BAO_ROOT/cogni/candidate-a/${svc}"
  printf '%s' "$value" > "$BAO_ROOT/cogni/candidate-a/${svc}/${key}"
}

# Blind-ancestor-scan shared values a node legitimately inherits (transitional).
# POSTHOG_* are source:human shared substrate inherited from an ancestor.
put_secret node-template POSTHOG_API_KEY phc_existing
put_secret node-template POSTHOG_HOST https://us.i.posthog.com
# Canonical-custody (inheritFrom: operator) values: seeded at the OPERATOR path
# only, with a divergent copy at the TARGET node (node-template). That divergent
# per-node copy must be IGNORED — the node inherits the operator value
# (overwrite-on-drift), killing the split-brain bug.5021/429 class.
# EVM_RPC_URL joined this class (was blind-scan shared): the operator holds the one
# billed Base RPC and every node inherits it.
put_secret operator OPENROUTER_API_KEY sk-or-operator-canonical
put_secret node-template OPENROUTER_API_KEY sk-or-stale-divergent
put_secret operator EVM_RPC_URL https://base-mainnet.example/v2/operator-key
put_secret node-template EVM_RPC_URL https://base-mainnet.example/v2/stale-divergent

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
PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$cmd"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "create" ] && [ "${2:-}" = "token" ]; then
  echo jwt-token
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
    key_arg="${args[$last_index]}"
    path="${args[$((last_index - 1))]}"
    mkdir -p "${FAKE_BAO_ROOT}/${path}"
    if [ "$key_arg" = "-" ]; then
      # batched form: a JSON object of key/value pairs arrives on stdin
      while IFS=$'\t' read -r k v; do
        [ -z "$k" ] && continue
        printf '%s' "$v" > "${FAKE_BAO_ROOT}/${path}/${k}"
      done < <(jq -r 'to_entries[] | [.key, .value] | @tsv')
      exit 0
    fi
    key="${key_arg%%=*}"
    value="$(cat)"
    printf '%s' "$value" > "${FAKE_BAO_ROOT}/${path}/${key}"
    exit 0
  fi
fi
echo "fake kubectl: unexpected $*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/kubectl"

cat > "$FAKEBIN/hostname" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-I" ]; then
  echo "10.0.0.1 "
  exit 0
fi
/bin/hostname "$@"
EOF
chmod +x "$FAKEBIN/hostname"

env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out.txt"

# source:agent app key generated per-node
test -f "$BAO_ROOT/cogni/candidate-a/node-template/AUTH_SECRET" \
  || { echo "materialize did not seed AUTH_SECRET" >&2; exit 1; }
# source:human shared substrate inherited via blind ancestor scan (POSTHOG_*).
# required:true — a node MUST receive them or the fail-fast guard trips (bug.5087).
for k in POSTHOG_API_KEY POSTHOG_HOST; do
  test -f "$BAO_ROOT/cogni/candidate-a/node-template/$k" \
    || { echo "materialize did not inherit required shared substrate $k" >&2; exit 1; }
done
# canonical-custody keys (inheritFrom: operator): must be the OPERATOR value, NOT a
# stale per-node copy — proves inheritFrom overwrites the per-node split-brain.
# OPENROUTER_API_KEY (bug.5021/429) and EVM_RPC_URL (bug.5087 chain substrate) share
# this shape: the operator holds the one billed value and every node inherits it.
test "$(cat "$BAO_ROOT/cogni/candidate-a/node-template/OPENROUTER_API_KEY")" = sk-or-operator-canonical \
  || { echo "OPENROUTER_API_KEY must inherit the operator-canonical value, not the stale per-node copy" >&2; exit 1; }
test "$(cat "$BAO_ROOT/cogni/candidate-a/node-template/EVM_RPC_URL")" = https://base-mainnet.example/v2/operator-key \
  || { echo "EVM_RPC_URL must inherit the operator value (inheritFrom: operator), not the stale per-node copy" >&2; exit 1; }
# per-node DB creds generated (source:agent), not inherited from any shared bank
for k in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD; do
  test -f "$BAO_ROOT/cogni/candidate-a/node-template/$k" \
    || { echo "materialize did not generate per-node $k" >&2; exit 1; }
done
# Postgres DSNs composed sole-source here, embedding the per-node app_<node> role
# (regression guard: a shared app_user DSN is the bug.5002 split-brain we killed)
test -f "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_URL" \
  || { echo "materialize did not compose DATABASE_URL" >&2; exit 1; }
test -f "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_SERVICE_URL" \
  || { echo "materialize did not compose DATABASE_SERVICE_URL" >&2; exit 1; }
grep -q '://app_node_template:' "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_URL" \
  || { echo "DATABASE_URL must embed per-node role app_node_template, not shared app_user" >&2; exit 1; }
grep -q '://service_node_template:' "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_SERVICE_URL" \
  || { echo "DATABASE_SERVICE_URL must embed per-node role service_node_template" >&2; exit 1; }
# Doltgres half of the cutover: the env superuser is the operator-canonical SSOT
# (cogni/<env>/operator/DOLTGRES_PASSWORD); with operator unseeded in this isolated
# materialize the composer falls back to the deterministic genesis derive, and
# DOLTGRES_URL is composed sole-source from it (non-empty superuser pw). The pod
# reaches its own knowledge_<node> DB as the `postgres` superuser — Doltgres 0.56.3
# RBAC is table-DML-only (databases.md §5.2), so a per-node role is not yet possible.
test -f "$BAO_ROOT/cogni/candidate-a/node-template/DOLTGRES_PASSWORD" \
  || { echo "materialize did not materialize per-node DOLTGRES_PASSWORD" >&2; exit 1; }
test -f "$BAO_ROOT/cogni/candidate-a/node-template/DOLTGRES_URL" \
  || { echo "materialize did not compose DOLTGRES_URL" >&2; exit 1; }
grep -qE '://postgres:[^@]+@[^/]+/knowledge_node_template\?' "$BAO_ROOT/cogni/candidate-a/node-template/DOLTGRES_URL" \
  || { echo "DOLTGRES_URL must reach knowledge_node_template as the postgres superuser (non-empty pw)" >&2; exit 1; }
# no secret value leaked to output
if grep -q 'sk-or-operator-canonical\|sk-or-stale-divergent\|writer-token' "$TMPROOT/out.txt"; then
  echo "secret value leaked to output" >&2
  exit 1
fi

# Drift repair: a stale per-node DOLTGRES_URL must recompose from the operator
# canonical superuser, matching DATABASE_URL/_SERVICE_URL behavior. This is the
# prod oss 28P01 class: node-substrate provisions Doltgres with the operator SSOT
# while the pod migrator reads this node-local URL.
printf '%s' 'postgresql://postgres:stale@10.0.0.1:5435/knowledge_node_template?sslmode=disable' \
  > "$BAO_ROOT/cogni/candidate-a/node-template/DOLTGRES_URL"
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-drift.txt"

grep -q 'recomposed DOLTGRES_URL (drift corrected)' "$TMPROOT/out-drift.txt" \
  || { echo "stale DOLTGRES_URL was not reported as recomposed" >&2; cat "$TMPROOT/out-drift.txt" >&2; exit 1; }
grep -qE '://postgres:[^@]+@[^/]+/knowledge_node_template\?' "$BAO_ROOT/cogni/candidate-a/node-template/DOLTGRES_URL" \
  || { echo "DOLTGRES_URL must still reach knowledge_node_template as postgres after drift correction" >&2; exit 1; }
if grep -q ':stale@' "$BAO_ROOT/cogni/candidate-a/node-template/DOLTGRES_URL"; then
  echo "DOLTGRES_URL still contains stale password after materialize" >&2
  exit 1
fi

# Idempotence: a re-run of an already-materialized and converged node must create
# NOTHING. This is the regression guard against re-materializing already-correct
# secrets.
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out2.txt"

grep -q 'created=0 ' "$TMPROOT/out2.txt" \
  || { echo "re-run must create 0 keys (idempotent); got:" >&2; grep 'materialize complete' "$TMPROOT/out2.txt" >&2; exit 1; }
if grep -qE '^\[secret-materialize\]   created ' "$TMPROOT/out2.txt"; then
  echo "re-run created keys — not idempotent" >&2
  exit 1
fi

echo "PASS: secret-materialize.test.sh"
