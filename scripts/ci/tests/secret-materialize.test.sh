#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves the materialize side of the secret-materialize / reconcile split:
#   - source:agent app keys ARE materialized per-node (AUTH_SECRET);
#   - genuinely-shared values inherited from the env bank ARE materialized
#     (POSTHOG_API_KEY/HOST from their declared operator owner);
#   - canonical-custody (inheritFrom: operator) keys are materialized from the
#     operator path, NOT the blind ancestor scan (OPENROUTER_API_KEY — kills the
#     per-node split-brain that 429'd freshly-formed prod nodes);
#   - per-node DB creds + ALL THREE DSNs ARE composed sole-source here
#     (APP_DB_PASSWORD/SERVICE generated; DATABASE_URL/SERVICE_URL embed the
#     per-node app_<node> role; DOLTGRES_PASSWORD derived per-node + DOLTGRES_URL
#     composed from it as the postgres superuser — the bug.5002 cutover, both planes);
#   - non-node PLATFORM_SERVICES get their source:agent keys minted into their OWN
#     cogni/<env>/<service> bucket, by the OWNER leg only (story.5016 amendment 1);
#   - catalog-declared LiteLLM virtual keys are explicitly registered under the
#     canonical node/env alias, without placing the plaintext key in lookup URLs;
#   - lookup, registration, alias collision, and transport errors fail closed;
#   - no secret VALUE is echoed to stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# The materializer and read-only reconciler share this exact auth helper. Invoke
# its hermetic transient/permanent matrix from an already-required CI test rather
# than adding decision logic to the frozen workflow.
bash scripts/ci/tests/openbao-login-retry.test.sh

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

# Explicit shared integration owners differ from the ordinary target.
put_secret operator POSTHOG_API_KEY phc_existing
put_secret operator POSTHOG_HOST https://us.i.posthog.com
put_secret operator TAVILY_API_KEY tvly-owner-fixture
put_secret operator SCHEDULER_API_TOKEN scheduler-owner-fixture
put_secret operator GH_WEBHOOK_SECRET webhook-owner-fixture
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
put_secret operator LITELLM_MASTER_KEY sk-cogni-operator-master

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
rc=$?
if [[ "${FAKE_CAS_TRANSPORT_RESET:-0}" == 1 && "$cmd" == *'bao kv patch '* && "$cmd" == *'-cas='* && "$rc" == 0 ]]; then
  echo 'Connection reset by peer' >&2
  exit 255 # mutation applied; caller lost the response
fi
exit "$rc"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "create" ] && [ "${2:-}" = "token" ]; then
  [[ "$*" == 'create token openbao-operator -n default' ]] || exit 9
  echo owned.jwt.signature
  exit 0
fi
if [[ "$*" == '-n openbao get service openbao -o json' ]]; then
  echo '{"metadata":{"name":"openbao","namespace":"openbao"},"spec":{"type":"ClusterIP","clusterIP":"127.0.0.1","selector":{"app.kubernetes.io/name":"openbao","app.kubernetes.io/instance":"openbao","component":"server"},"ports":[{"port":8200,"targetPort":8200,"protocol":"TCP"}]}}'
  exit 0
fi
if [ "${1:-}" = "exec" ]; then
  args=("$@")
  last_index=$((${#args[@]} - 1))
  path="${args[$last_index]}"
  if printf '%s\n' "$*" | grep -q 'auth/kubernetes/login'; then
    echo 'login must not use kubectl exec' >&2
    exit 9
  fi
  if printf '%s\n' "$*" | grep -q 'bao kv get -format=json'; then
    dir="${FAKE_BAO_ROOT}/${path}"
    # Real bao prints this on an unborn path (exit 2); bug.5159's transport-vs-absent
    # distinction keys on the text, so the fake must speak it too.
    if [ ! -d "$dir" ]; then echo "No value found at ${path}" >&2; exit 2; fi
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
    if [[ "$*" == *'-cas='* ]]; then
      [[ -z "${FAKE_CAS_LOG:-}" ]] || printf 'attempt\n' >> "$FAKE_CAS_LOG"
      [[ "$*" == *'-cas=7 '* && "$*" == *'-method=patch '* && "$*" == *'-format=json '* ]] || exit 9
      [[ "${FAKE_CAS_FAIL:-0}" != 1 ]] || exit 2
      patch_body="$(cat)"
      jq -e 'keys == ["DATABASE_RECOVERY_PROBE_URLS_JSON"]' <<<"$patch_body" >/dev/null || exit 9
      printf '%s' "$(jq -r .DATABASE_RECOVERY_PROBE_URLS_JSON <<<"$patch_body")" > "${FAKE_BAO_ROOT}/cogni/candidate-a/database-reliability-actuator/DATABASE_RECOVERY_PROBE_URLS_JSON"
      touch "$FAKE_CAS_APPLIED_MARKER"
      printf '{"data":{"version":8}}\n'
      exit 0
    fi
    [[ -z "${FAKE_PATCH_LOG:-}" ]] || printf '%s\n' "$*" >> "$FAKE_PATCH_LOG"
    key_arg="${args[$last_index]}"
    path="${args[$((last_index - 1))]}"
    mkdir -p "${FAKE_BAO_ROOT}/${path}"
    if [ "$key_arg" = "-" ]; then
      # batched form: a JSON object of key/value pairs arrives on stdin
      while IFS=$'\t' read -r k v; do
        [ -z "$k" ] && continue
        printf '%s' "$v" | base64 --decode > "${FAKE_BAO_ROOT}/${path}/${k}"
      done < <(jq -r 'to_entries[] | [.key, (.value | tostring | @base64)] | @tsv')
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

cat > "$FAKEBIN/timeout" <<'SH_TIMEOUT'
#!/usr/bin/env bash
shift
exec "$@"
SH_TIMEOUT
chmod +x "$FAKEBIN/timeout"

cat > "$FAKEBIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${!#}" == http://127.0.0.1:8200/v1/auth/kubernetes/login ]]; then
  out="" body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --output) out="$2"; shift 2 ;; --data-binary) body="${2#@}"; shift 2 ;; *) shift ;; esac
  done
  jq -e '.role == "candidate-a-writer" and .jwt == "owned.jwt.signature"' "$body" >/dev/null || exit 9
  printf '{"auth":{"client_token":"writer-token"}}' > "$out"
  printf '200'; exit 0
fi
# GET transport shares this binary with the existing LiteLLM fixture.
if [[ "${!#}" == http://127.0.0.1:8200/v1/cogni/data/* ]]; then
  out="" url="${!#}"
  while [[ $# -gt 0 ]]; do
    case "$1" in --output) out="$2"; shift 2 ;; *) shift ;; esac
  done
  path="${url#http://127.0.0.1:8200/v1/cogni/data/}"
  dir="${FAKE_BAO_ROOT}/cogni/${path}"
  if [[ ! -d "$dir" ]]; then printf '{"errors":[]}' > "$out"; printf '404'; exit 0; fi
  data='{}'
  for f in "$dir"/*; do
    [[ -f "$f" ]] || continue
    data="$(printf '%s' "$data" | jq --arg k "$(basename "$f")" --rawfile v "$f" '.[$k]=$v')"
  done
  if [[ "${FAKE_PROBE_DRIFT:-0}" == 1 && "$path" == 'candidate-a/node-template-database-recovery-probe' ]]; then
    if [[ -f "$FAKE_PROBE_READ_MARKER" ]]; then
      data="$(jq '.DATABASE_RECOVERY_PROBE_PASSWORD="concurrent-rotation"' <<<"$data")"
    else
      touch "$FAKE_PROBE_READ_MARKER"
    fi
  fi
  version=7
  if [[ "$path" == 'candidate-a/database-reliability-actuator' && -f "${FAKE_CAS_APPLIED_MARKER:-/nonexistent}" ]]; then
    version=8
    case "${FAKE_READBACK_FAIL:-0}" in
      1)
        printf '{"errors":["fixture readback unavailable"]}' > "$out"
        printf '503'; exit 0 ;;
      stale) version=7 ;;
      mismatch) data="$(jq '.DATABASE_RECOVERY_PROBE_URLS_JSON="[]"' <<<"$data")" ;;
    esac
  fi
  printf '{"data":{"metadata":{"version":%s},"data":%s}}' "$version" "$data" > "$out"
  printf '200'; exit 0
fi
config="" body_file="" output_file="" wanted_alias=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --data-binary) body_file="${2#@}"; shift 2 ;;
    --data-urlencode)
      case "$2" in
        key_alias@*) wanted_alias="$(cat "${2#key_alias@}")" ;;
      esac
      shift 2
      ;;
    --get) shift ;;
    --output) output_file="$2"; shift 2 ;;
    --write-out) shift 2 ;;
    *) shift ;;
  esac
done
[[ -f "$config" && -n "$output_file" ]] || exit 2
url="$(sed -n 's/^url = "\(.*\)"$/\1/p' "$config")"
auth="$(sed -n 's/^header = "Authorization: Bearer \(.*\)"$/\1/p' "$config")"

respond() {
  printf '%s' "$2" > "$output_file"
  printf '%s' "$1"
}

if [[ "${FAKE_LITELLM_FAIL:-}" == "1" ]]; then
  respond 503 '{"error":"unavailable"}'
  exit 0
fi
if [[ "$auth" != "${FAKE_LITELLM_MASTER_KEY}" ]]; then
  respond 401 '{"error":"unauthorized"}'
  exit 0
fi

touch "$FAKE_LITELLM_STORE"
case "$url" in
  */v2/key/info)
    [[ -f "$body_file" ]] || exit 2
    if [[ "${FAKE_LITELLM_INVALID_INFO:-}" == "1" ]]; then
      respond 200 '{}'
      exit 0
    fi
    wanted_hash="$(jq -r '.keys[0] // empty' "$body_file")"
    info='[]'
    while IFS=$'\t' read -r stored_hash stored_alias; do
      [[ -n "$stored_hash" ]] || continue
      # Pinned LiteLLM cc238 accepts key_aliases in the request model but its
      # /v2/key/info handler ignores them and queries only data.keys. Model that
      # exact behavior so this fixture cannot accidentally bless the newer API.
      if [[ -n "$wanted_hash" && "$stored_hash" == "$wanted_hash" ]]; then
        info="$(jq -c --arg alias "$stored_alias" '. + [{key_alias: $alias}]' <<<"$info")"
      fi
    done < "$FAKE_LITELLM_STORE"
    printf 'lookup-hash\n' >> "$FAKE_LITELLM_LOG"
    respond 200 "$(jq -cn --argjson info "$info" '{key: [], info: $info}')"
    ;;
  */key/list)
    [[ -n "$wanted_alias" ]] || exit 2
    if [[ "${FAKE_LITELLM_INVALID_ALIAS_LIST:-}" == "1" ]]; then
      respond 200 '{}'
      exit 0
    fi
    keys='[]'
    while IFS=$'\t' read -r stored_hash stored_alias; do
      [[ -n "$stored_hash" ]] || continue
      if [[ "$stored_alias" == "$wanted_alias" ]]; then
        keys="$(jq -c --arg hash "$stored_hash" --arg alias "$stored_alias" \
          '. + [{token: $hash, key_alias: $alias}]' <<<"$keys")"
      fi
    done < "$FAKE_LITELLM_STORE"
    count="$(jq 'length' <<<"$keys")"
    printf 'lookup-alias %s\n' "$wanted_alias" >> "$FAKE_LITELLM_LOG"
    respond 200 "$(jq -cn --argjson keys "$keys" --argjson count "$count" \
      '{keys: $keys, total_count: $count, current_page: 1, total_pages: (if $count == 0 then 0 else 1 end)}')"
    ;;
  */key/delete)
    [[ -f "$body_file" ]] || exit 2
    del_alias="$(jq -r '.key_aliases[0]' "$body_file")"
    awk -F '\t' -v alias="$del_alias" '$2 != alias' "$FAKE_LITELLM_STORE" > "$FAKE_LITELLM_STORE.tmp"
    mv "$FAKE_LITELLM_STORE.tmp" "$FAKE_LITELLM_STORE"
    printf 'delete %s\n' "$del_alias" >> "$FAKE_LITELLM_LOG"
    respond 200 "$(jq -cn --arg alias "$del_alias" '{deleted_keys: [$alias]}')"
    ;;
  */key/generate)
    [[ -f "$body_file" ]] || exit 2
    key="$(jq -r '.key' "$body_file")"
    alias="$(jq -r '.key_alias' "$body_file")"
    key_hash="$(printf '%s' "$key" | sha256sum | awk '{print $1}')"
    if awk -F '\t' -v hash="$key_hash" -v alias="$alias" \
      '$1 == hash || $2 == alias { found=1 } END { exit !found }' "$FAKE_LITELLM_STORE"; then
      respond 409 '{"error":"collision"}'
      exit 0
    fi
    printf '%s\t%s\n' "$key_hash" "$alias" >> "$FAKE_LITELLM_STORE"
    printf 'generate %s %s\n' "$key_hash" "$alias" >> "$FAKE_LITELLM_LOG"
    respond 200 "$(jq -cn --arg key "$key" --arg alias "$alias" '{key: $key, key_alias: $alias}')"
    ;;
  *) respond 404 '{"error":"not found"}' ;;
esac
EOF
chmod +x "$FAKEBIN/curl"

LITELLM_STORE="$REMOTE_ROOT/litellm-keys"
LITELLM_LOG="$REMOTE_ROOT/litellm-calls.log"
: > "$LITELLM_STORE"
: > "$LITELLM_LOG"

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
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out.txt"

# source:agent app key generated per-node
test -f "$BAO_ROOT/cogni/candidate-a/node-template/AUTH_SECRET" \
  || { echo "materialize did not seed AUTH_SECRET" >&2; exit 1; }
# Source:human shared integrations inherit only their declared owner.
for k in POSTHOG_API_KEY POSTHOG_HOST; do
  cmp "$BAO_ROOT/cogni/candidate-a/operator/$k" "$BAO_ROOT/cogni/candidate-a/node-template/$k" \
    || { echo "materialize did not inherit declared shared integration $k" >&2; exit 1; }
done
cmp "$BAO_ROOT/cogni/candidate-a/operator/TAVILY_API_KEY" "$BAO_ROOT/cogni/candidate-a/node-template/TAVILY_API_KEY"
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
# Real multiline public CA bytes survive Bao JSON and the materializer prefetch cache.
openssl x509 -in "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_SSL_CA_CERT" -noout >/dev/null
cmp "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_SSL_CA_CERT" "$BAO_ROOT/cogni/candidate-a/node-template-database-migration/DATABASE_SSL_CA_CERT"
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

# Per-node LiteLLM key: exact format, distinct from the fleet master, and the
# explicit value's hash is registered under the repo-spec identity alias.
VK_FILE="$BAO_ROOT/cogni/candidate-a/node-template/LITELLM_VIRTUAL_KEY"
test -f "$VK_FILE" \
  || { echo "materialize did not mint catalog-derived LITELLM_VIRTUAL_KEY" >&2; exit 1; }
VK="$(cat "$VK_FILE")"
[[ "$VK" =~ ^sk-cogni-[0-9a-f]{48}$ ]] \
  || { echo "LITELLM_VIRTUAL_KEY must match sk-cogni-<48 lowercase hex>" >&2; exit 1; }
test "$VK" != "$(cat "$BAO_ROOT/cogni/candidate-a/node-template/LITELLM_MASTER_KEY")" \
  || { echo "virtual key must differ from the fleet-shared master" >&2; exit 1; }
VK_HASH="$(printf '%s' "$VK" | sha256sum | awk '{print $1}')"
NODE_ID="$(yq -N '.node_id' infra/catalog/node-template.yaml)"
ALIAS="cogni:candidate-a:${NODE_ID}:app:v1"
grep -qxF "${VK_HASH}"$'\t'"${ALIAS}" "$LITELLM_STORE" \
  || { echo "explicit virtual key hash was not registered under ${ALIAS}" >&2; exit 1; }
test "$(grep -c '^generate ' "$LITELLM_LOG")" = 1 \
  || { echo "first materialize must generate exactly one LiteLLM key" >&2; exit 1; }

# No secret value leaked to output, including LiteLLM master/virtual values.
if grep -q 'sk-or-operator-canonical\|sk-or-stale-divergent\|writer-token\|sk-cogni-operator-master' "$TMPROOT/out.txt" \
  || grep -qF "$VK" "$TMPROOT/out.txt"; then
  echo "secret value leaked to output" >&2
  exit 1
fi

# ── Platform-service pass (story.5016 secret-boundary amendments) ────────────
# AKASH_TX_ACTUATOR_TOKEN is source:agent at `service: akash-tx-actuator`, a NON-node
# bucket that exists so the credential is unreachable from the operator app's
# `dataFrom: extract`. Two things must hold: only the OWNER leg writes it (the node
# matrix is parallel — two minters on a cold bucket would race), and it is MINTED, never
# hand-seeded (the killer rule: a generated value must never be human-typed).

# 1. A non-owner leg must not touch the platform bucket. The run above was
#    `node-template` with the default owner (operator), so the path must still be absent.
if [ -e "$BAO_ROOT/cogni/candidate-a/akash-tx-actuator" ]; then
  echo "a non-owner node leg wrote the platform-service bucket (parallel-matrix race)" >&2
  exit 1
fi

# 2. The owner leg mints it. PLATFORM_SERVICE_OWNER_NODE is overridden so this exercises
#    the pass without dragging in the whole operator-node materialization.
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  PLATFORM_SERVICE_OWNER_NODE=node-template \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-platform.txt"

PLATFORM_TOKEN_FILE="$BAO_ROOT/cogni/candidate-a/akash-tx-actuator/AKASH_TX_ACTUATOR_TOKEN"
test -f "$PLATFORM_TOKEN_FILE" \
  || { echo "owner leg did not mint AKASH_TX_ACTUATOR_TOKEN into cogni/candidate-a/akash-tx-actuator" >&2; exit 1; }
PLATFORM_TOKEN="$(cat "$PLATFORM_TOKEN_FILE")"
[[ "$PLATFORM_TOKEN" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "AKASH_TX_ACTUATOR_TOKEN must be the catalog generator's hex/32 output" >&2; exit 1; }

# Optional authenticated cell aggregates are DERIVED by their typed owner phase,
# not random credentials. A cold platform pass must not mint placeholder proofs.
for key in AKASH_DATABASE_CELL_APPLIED_CUSTODIES_JSON AKASH_DATABASE_CELL_APPLIED_EVIDENCE_BUNDLES_JSON; do
  if [ -e "$BAO_ROOT/cogni/candidate-a/akash-tx-actuator/$key" ]; then
    echo "cold platform pass invented optional authenticated cell aggregate $key" >&2
    exit 1
  fi
  # An existing private value is preserved until its real typed publisher has
  # authenticated replacement input. This fixture is deliberately not proof.
  put_secret akash-tx-actuator "$key" '{"fixture":"existing-private-unqualified-value"}'
done

# 3. source:human keys at a platform path are NEVER generated — a vendor-minted Console
#    credential must come through the sanctioned write path, not be invented here.
if [ -e "$BAO_ROOT/cogni/candidate-a/akash-tx-actuator/AKASH_ACTUATOR_CONSOLE_API_KEY" ]; then
  echo "materialize generated a source:human vendor credential" >&2
  exit 1
fi

# 4. The platform key must not also land in the node bucket (that is the leak we moved
#    it out of), and its value must never be echoed.
if [ -e "$BAO_ROOT/cogni/candidate-a/node-template/AKASH_TX_ACTUATOR_TOKEN" ]; then
  echo "platform-service key leaked into a node bucket" >&2
  exit 1
fi
if grep -qF "$PLATFORM_TOKEN" "$TMPROOT/out-platform.txt"; then
  echo "platform-service secret value leaked to output" >&2
  exit 1
fi

# 5. Idempotent: a second owner-leg run must preserve the token (rotating it under a live
#    Crossplane Composition would break the provider-http placeholder mid-flight).
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  PLATFORM_SERVICE_OWNER_NODE=node-template \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-platform2.txt"
test "$(cat "$PLATFORM_TOKEN_FILE")" = "$PLATFORM_TOKEN" \
  || { echo "re-run rotated AKASH_TX_ACTUATOR_TOKEN" >&2; exit 1; }
for key in AKASH_DATABASE_CELL_APPLIED_CUSTODIES_JSON AKASH_DATABASE_CELL_APPLIED_EVIDENCE_BUNDLES_JSON; do
  test "$(cat "$BAO_ROOT/cogni/candidate-a/akash-tx-actuator/$key")" = '{"fixture":"existing-private-unqualified-value"}' \
    || { echo "platform pass replaced existing authenticated cell aggregate $key without typed evidence" >&2; exit 1; }
  if grep -qF 'existing-private-unqualified-value' "$TMPROOT/out-platform2.txt"; then
    echo "platform pass leaked private cell aggregate" >&2
    exit 1
  fi
done

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
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
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
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out2.txt"

grep -q 'created=0 ' "$TMPROOT/out2.txt" \
  || { echo "re-run must create 0 keys (idempotent); got:" >&2; grep 'materialize complete' "$TMPROOT/out2.txt" >&2; exit 1; }
if grep -qE '^\[secret-materialize\]   created ' "$TMPROOT/out2.txt"; then
  echo "re-run created keys — not idempotent" >&2
  exit 1
fi

# Registration is idempotent: later materializations look up by hash and alias
# through request bodies and never re-POST /key/generate.
test "$(grep -c '^generate ' "$LITELLM_LOG")" = 1 \
  || { echo "re-runs must not generate another LiteLLM key" >&2; exit 1; }
grep -q 'LITELLM_VIRTUAL_KEY already registered with LiteLLM' "$TMPROOT/out2.txt" \
  || { echo "re-run did not report the registered key as unchanged" >&2; exit 1; }
test "$(cat "$VK_FILE")" = "$VK" \
  || { echo "re-run rotated LITELLM_VIRTUAL_KEY" >&2; exit 1; }

# A stale alias (owned by a different key) is RECONCILED to the OpenBao SSOT
# (secrets-management Invariant 5): delete the stale alias, re-register the current
# value. Neither key may appear in output (story.5016 levelup, 3 hand-op incidents).
COLLIDING_KEY="sk-cogni-$(printf 'b%.0s' {1..48})"
printf '%s' "$COLLIDING_KEY" > "$VK_FILE"
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-reconcile.txt" 2>&1 \
  || { echo "stale-alias reconcile must succeed"; cat "$TMPROOT/out-reconcile.txt" >&2; exit 1; }
grep -q '^delete ' "$LITELLM_LOG" \
  || { echo "stale alias was not deleted before re-registration" >&2; exit 1; }
test "$(grep -c '^generate ' "$LITELLM_LOG")" = 2 \
  || { echo "reconcile must re-register the SSOT value exactly once" >&2; exit 1; }
NEW_HASH="$(printf '%s' "$COLLIDING_KEY" | sha256sum | awk '{print $1}')"
grep -q "$NEW_HASH" "$LITELLM_STORE" \
  || { echo "alias not re-owned by the SSOT key after reconcile" >&2; exit 1; }
if grep -qF "$VK" "$TMPROOT/out-reconcile.txt" || grep -qF "$COLLIDING_KEY" "$TMPROOT/out-reconcile.txt"; then
  echo "LiteLLM key leaked in reconcile output" >&2
  exit 1
fi


# A LiteLLM lookup outage also fails closed instead of painting the substrate
# green with an unverified key registration.
set +e
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  FAKE_LITELLM_FAIL=1 \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-unavailable.txt" 2>&1
UNAVAILABLE_RC=$?
set -e
test "$UNAVAILABLE_RC" -ne 0 \
  || { echo "LiteLLM outage must fail materialization" >&2; exit 1; }
grep -q 'lookup-http-503' "$TMPROOT/out-unavailable.txt" \
  || { echo "LiteLLM outage did not return a redacted status" >&2; exit 1; }
if grep -qF "$VK" "$TMPROOT/out-unavailable.txt" || grep -qF "$COLLIDING_KEY" "$TMPROOT/out-unavailable.txt"; then
  echo "LiteLLM key leaked in unavailable failure" >&2
  exit 1
fi

# A nominal 200 with a malformed lookup body is not evidence that the key or
# alias is absent. It must fail before generation rather than creating through
# an API-contract drift or broken proxy response.
set +e
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  FAKE_LITELLM_INVALID_INFO=1 \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-invalid-info.txt" 2>&1
INVALID_INFO_RC=$?
set -e
test "$INVALID_INFO_RC" -ne 0 \
  || { echo "malformed LiteLLM lookup must fail materialization" >&2; exit 1; }
grep -q 'lookup-invalid-json' "$TMPROOT/out-invalid-info.txt" \
  || { echo "malformed LiteLLM lookup did not return a redacted error" >&2; exit 1; }
test "$(grep -c '^generate ' "$LITELLM_LOG")" = 2 \
  || { echo "malformed LiteLLM lookup must not call /key/generate" >&2; exit 1; }
if grep -qF "$VK" "$TMPROOT/out-invalid-info.txt" || grep -qF "$COLLIDING_KEY" "$TMPROOT/out-invalid-info.txt"; then
  echo "LiteLLM key leaked in malformed lookup failure" >&2
  exit 1
fi

# The pinned cc238 alias endpoint is /key/list with an exact key_alias filter.
# A malformed list response is not evidence that the alias is unused.
set +e
env \
  VM_HOST=fake \
  DOMAIN=test.cognidao.org \
  SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
  SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" \
  FAKE_BAO_ROOT="$BAO_ROOT" \
  FAKE_LITELLM_STORE="$LITELLM_STORE" \
  FAKE_LITELLM_LOG="$LITELLM_LOG" \
  FAKE_LITELLM_MASTER_KEY=sk-cogni-operator-master \
  FAKE_LITELLM_INVALID_ALIAS_LIST=1 \
  bash scripts/ci/secret-materialize.sh candidate-a node-template > "$TMPROOT/out-invalid-alias-list.txt" 2>&1
INVALID_ALIAS_LIST_RC=$?
set -e
test "$INVALID_ALIAS_LIST_RC" -ne 0 \
  || { echo "malformed LiteLLM alias list must fail materialization" >&2; exit 1; }
grep -q 'lookup-invalid-json' "$TMPROOT/out-invalid-alias-list.txt" \
  || { echo "malformed LiteLLM alias list did not return a redacted error" >&2; exit 1; }
test "$(grep -c '^generate ' "$LITELLM_LOG")" = 2 \
  || { echo "malformed LiteLLM alias list must not call /key/generate" >&2; exit 1; }
if grep -qF "$VK" "$TMPROOT/out-invalid-alias-list.txt" || grep -qF "$COLLIDING_KEY" "$TMPROOT/out-invalid-alias-list.txt"; then
  echo "LiteLLM key leaked in malformed alias-list failure" >&2
  exit 1
fi

# DB-ready second phase reuses the sole writer without reminting any component.
cat > "$FAKEBIN/cat" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == /etc/machine-id ]]; then printf '%s\n' "${FAKE_MACHINE_ID:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"; exit 0; fi
/bin/cat "$@"
EOF
cat > "$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  ps) printf '%s\n' abcdef123456; exit 0 ;;
  exec) printf 'Database system identifier: %s\n' "${FAKE_LOCAL_SYSTEM_ID:-9876543210123456789}"; exit 0 ;;
esac
[[ -f "${FAKE_PROBE_RECEIPT:-}" ]] || exit 1
/bin/cat "$FAKE_PROBE_RECEIPT"
EOF
chmod +x "$FAKEBIN/cat" "$FAKEBIN/docker"
PROBE_BANK="$BAO_ROOT/cogni/candidate-a/node-template-database-recovery-probe"
[ -s "$PROBE_BANK/DATABASE_RECOVERY_PROBE_PASSWORD" ] && [ -s "$PROBE_BANK/DATABASE_RECOVERY_PROBE_URL" ]
[ ! -e "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_RECOVERY_PROBE_PASSWORD" ]
[ ! -e "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_RECOVERY_PROBE_URL" ]
cat > "$TMPROOT/probe.json" <<'JSON'
{"database":"cogni_node_template","role":"probe_node_template","systemTenantExists":true,"serverAddress":"10.0.0.1","serverPort":5432,"systemIdentifier":"9876543210123456789","appRolesCanLogin":true,"runtimeRolesPresent":true,"runtimeRolesNoLogin":false,"activeRuntimeSessions":0,"observedAt":"2026-10-14T21:00:00.000+00:00","probeRoleIsolated":true}
JSON
DB_READY_CATALOG="$TMPROOT/db-ready-catalog"
mkdir -p "$DB_READY_CATALOG"
cp "$REPO_ROOT"/infra/catalog/*.yaml "$DB_READY_CATALOG/"
yq -i '.reliability.controller = false' "$DB_READY_CATALOG/operator.yaml"
yq -i '.reliability.controller = true | .envs = ["candidate-a", "production"]' "$DB_READY_CATALOG/node-template.yaml"
REAL_PNPM="$(command -v pnpm)"
cat > "$FAKEBIN/pnpm" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${FAKE_REBIND_PLAN_FILE:-}" && "$*" == *'/plan-database-recovery-host-rebind.ts'* ]]; then
  exec "$REAL_PNPM" exec tsx -e 'const fs = require("node:fs"); const {planRecoveryBinding} = require("./scripts/lib/plan-database-recovery-host-rebind"); try { process.stdout.write(JSON.stringify(planRecoveryBinding(JSON.parse(fs.readFileSync(0,"utf8")), JSON.parse(fs.readFileSync(process.env.FAKE_REBIND_PLAN_FILE,"utf8"))))); } catch { process.stderr.write("fixture planner refused\n"); process.exitCode=1; }'
fi
exec "$REAL_PNPM" "$@"
EOF
chmod +x "$FAKEBIN/pnpm"
run_db_ready() {
  env PATH="$FAKEBIN:$PATH" REAL_PNPM="$REAL_PNPM" \
    FAKE_REBIND_PLAN_FILE="${FAKE_REBIND_PLAN_FILE:-}" FAKE_CAS_FAIL="${FAKE_CAS_FAIL:-0}" FAKE_CAS_LOG="$TMPROOT/cas-log" \
    FAKE_PROBE_DRIFT="${FAKE_PROBE_DRIFT:-0}" FAKE_PROBE_READ_MARKER="$TMPROOT/probe-read-marker" \
    FAKE_READBACK_FAIL="${FAKE_READBACK_FAIL:-0}" FAKE_CAS_APPLIED_MARKER="$TMPROOT/cas-applied-marker" \
    FAKE_CAS_TRANSPORT_RESET="${FAKE_CAS_TRANSPORT_RESET:-0}" \
    VM_HOST=fake DOMAIN=test.cognidao.org SSH_OPTS="-i fake-key -o StrictHostKeyChecking=no" \
    SECRET_MATERIALIZE_SSH_BIN="$FAKEBIN/ssh" FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" \
    COGNI_CATALOG_ROOT="$DB_READY_CATALOG" SECRET_MATERIALIZE_PHASE=db-ready \
    FAKE_PROBE_RECEIPT="$TMPROOT/probe.json" FAKE_PATCH_LOG="$TMPROOT/db-ready-writes" \
    FAKE_MACHINE_ID="${1:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" FAKE_LOCAL_SYSTEM_ID="${2:-9876543210123456789}" \
    bash scripts/ci/secret-materialize.sh candidate-a node-template
}
# A missing cold component fails before sealing; pre-phase already minted it above.
mv "$PROBE_BANK/DATABASE_RECOVERY_PROBE_PASSWORD" "$TMPROOT/cold-probe-password"
: > "$TMPROOT/db-ready-writes"
if run_db_ready > /dev/null 2>&1; then echo 'missing cold probe component accepted' >&2; exit 1; fi
[ ! -s "$TMPROOT/db-ready-writes" ]
mv "$TMPROOT/cold-probe-password" "$PROBE_BANK/DATABASE_RECOVERY_PROBE_PASSWORD"
# Retain another previously sealed scope during the owner-only merge.
put_secret database-reliability-actuator DATABASE_RECOVERY_PROBE_URLS_JSON '[{"nodeId":"33333333-3333-4333-8333-333333333333","nodeSlug":"other","environment":"preview","databaseName":"cogni_other","probeRole":"probe_other","systemIdentifier":"1234567890123456789","substrateHost":"cccccccccccccccccccccccccccccccc","dsn":"postgresql://probe_other:fixture@10.0.0.2:5432/cogni_other?sslmode=disable"}]'
probe_password_before=$(cat "$PROBE_BANK/DATABASE_RECOVERY_PROBE_PASSWORD")
: > "$TMPROOT/db-ready-writes"
run_db_ready > "$TMPROOT/db-ready-out"
BINDING_FILE="$BAO_ROOT/cogni/candidate-a/database-reliability-actuator/DATABASE_RECOVERY_PROBE_URLS_JSON"
jq -e 'length == 2 and any(.[]; .databaseName == "cogni_node_template" and .probeRole == "probe_node_template" and .systemIdentifier == "9876543210123456789" and .substrateHost == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") and any(.[]; .nodeSlug == "other" and .environment == "preview")' "$BINDING_FILE" >/dev/null
[ "$(cat "$PROBE_BANK/DATABASE_RECOVERY_PROBE_PASSWORD")" = "$probe_password_before" ]
[ ! -e "$BAO_ROOT/cogni/candidate-a/node-template/DATABASE_RECOVERY_PROBE_URLS_JSON" ]
[ "$(wc -l < "$TMPROOT/db-ready-writes" | tr -d ' ')" = 1 ]
: > "$TMPROOT/db-ready-writes"
run_db_ready > "$TMPROOT/db-ready-out-repeat"
[ ! -s "$TMPROOT/db-ready-writes" ]
grep -q 'created=0' "$TMPROOT/db-ready-out-repeat"
if run_db_ready bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb > /dev/null 2>&1; then echo 'stale physical binding accepted' >&2; exit 1; fi
[ ! -s "$TMPROOT/db-ready-writes" ]
# A proxied TCP cluster must not be paired with local host metrics.
if run_db_ready aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1111111111111111111 > /dev/null 2>&1; then echo 'foreign TCP cluster paired with local machine-id' >&2; exit 1; fi
[ ! -s "$TMPROOT/db-ready-writes" ]
# A foreign native DB or non-owner matrix leg fails before any write.
jq '.database="cogni_other"' "$TMPROOT/probe.json" > "$TMPROOT/wrong.json"
mv "$TMPROOT/wrong.json" "$TMPROOT/probe.json"
if run_db_ready >/dev/null 2>&1; then echo 'foreign native DB accepted' >&2; exit 1; fi
[ ! -s "$TMPROOT/db-ready-writes" ]

# Source-reviewed hostname-only probe reattestation: test the real pure planner through the real
# db-ready shell, with a test-only pnpm wrapper supplying an armed fixture.
# No production CLI/env mechanism can replace its source-owned plan.
jq '.database="cogni_node_template" | .observedAt=(now | todate)' "$TMPROOT/probe.json" > "$TMPROOT/right.json"
mv "$TMPROOT/right.json" "$TMPROOT/probe.json"
cp "$BINDING_FILE" "$TMPROOT/binding-good"
jq -c 'map(if .nodeSlug=="node-template" then .dsn |= sub("10.0.0.1";"10.0.0.9") else . end)' "$BINDING_FILE" > "$TMPROOT/binding-old"
cp "$TMPROOT/binding-old" "$BINDING_FILE"
jq '[.[] | select(.nodeSlug=="node-template") | {id:"fixture-rehost",operation:"hostname-only-probe-reattestation",nodeId,nodeSlug,environment,transition:"existing-same-identity-to-canonical-host",newHost:"10.0.0.1",machineId:.substrateHost,authorization:{state:"armed",receipt:{reference:"https://example.invalid/test-only-authorization-receipt"}}}]' "$BINDING_FILE" > "$TMPROOT/armed-plan"
FAKE_REBIND_PLAN_FILE="$TMPROOT/armed-plan"
: > "$TMPROOT/cas-log"
run_db_ready > "$TMPROOT/rebind-out"
[ "$(cat "$TMPROOT/cas-log")" = attempt ]
[ "$(jq -S . "$BINDING_FILE")" = "$(jq -S . "$TMPROOT/binding-good")" ]
grep -q '"beforeVersion":7,"afterVersion":8,"readbackMatched":true' "$TMPROOT/rebind-out"
if grep -qF "$probe_password_before" "$TMPROOT/rebind-out"; then echo 'host rebind leaked probe password' >&2; exit 1; fi
: > "$TMPROOT/cas-log"
run_db_ready > /dev/null
[ ! -s "$TMPROOT/cas-log" ] # no-op, no second CAS
# Successful CAS with unavailable, stale or mismatched readback is
# applied/unknown, never replayed or reported as matched (including HTTP200).
for FAKE_READBACK_FAIL in 1 stale mismatch; do
  cp "$TMPROOT/binding-old" "$BINDING_FILE"
  rm -f "$TMPROOT/cas-applied-marker"
  : > "$TMPROOT/cas-log"
  if run_db_ready > "$TMPROOT/readback-failure-out" 2>&1; then echo 'invalid reattestation readback accepted' >&2; exit 1; fi
  [ "$(cat "$TMPROOT/cas-log")" = attempt ]
  [ "$(jq -S . "$BINDING_FILE")" = "$(jq -S . "$TMPROOT/binding-good")" ]
  grep -q 'applied; aggregate readback.*reconcile before retry' "$TMPROOT/readback-failure-out"
  if grep -q 'readbackMatched' "$TMPROOT/readback-failure-out"; then echo 'invalid readback claimed matched' >&2; exit 1; fi
done
unset FAKE_READBACK_FAIL
# A reset AFTER actual application must not enter remote()'s transport retry.
cp "$TMPROOT/binding-old" "$BINDING_FILE"
rm -f "$TMPROOT/cas-applied-marker"
: > "$TMPROOT/cas-log"
FAKE_CAS_TRANSPORT_RESET=1
if run_db_ready > "$TMPROOT/cas-unknown-out" 2>&1; then echo 'lost CAS response accepted' >&2; exit 1; fi
[ "$(cat "$TMPROOT/cas-log")" = attempt ]
[ "$(jq -S . "$BINDING_FILE")" = "$(jq -S . "$TMPROOT/binding-good")" ]
grep -q 'CAS failed or outcome unknown; no replay; reconcile before retry' "$TMPROOT/cas-unknown-out"
if grep -q 'readbackMatched' "$TMPROOT/cas-unknown-out"; then echo 'lost CAS response claimed matched' >&2; exit 1; fi
unset FAKE_CAS_TRANSPORT_RESET
cp "$TMPROOT/binding-old" "$BINDING_FILE"
rm -f "$TMPROOT/cas-applied-marker"
: > "$TMPROOT/cas-log"
FAKE_CAS_FAIL=1
if run_db_ready > /dev/null 2>&1; then echo 'host rebind CAS conflict accepted' >&2; exit 1; fi
[ "$(cat "$TMPROOT/cas-log")" = attempt ] # no retry
cmp "$BINDING_FILE" "$TMPROOT/binding-old"
FAKE_CAS_FAIL=0
FAKE_PROBE_DRIFT=1
: > "$TMPROOT/cas-log"
if run_db_ready > /dev/null 2>&1; then echo 'concurrent canonical probe rotation accepted' >&2; exit 1; fi
[ ! -s "$TMPROOT/cas-log" ]
cmp "$BINDING_FILE" "$TMPROOT/binding-old"
unset FAKE_PROBE_DRIFT
jq '.[0].authorization={state:"unarmed",receipt:null}' "$TMPROOT/armed-plan" > "$TMPROOT/unarmed-plan"
FAKE_REBIND_PLAN_FILE="$TMPROOT/unarmed-plan"
: > "$TMPROOT/cas-log"
if run_db_ready > /dev/null 2>&1; then echo 'unarmed host rebind accepted' >&2; exit 1; fi
[ ! -s "$TMPROOT/cas-log" ]
unset FAKE_REBIND_PLAN_FILE FAKE_CAS_FAIL
cp "$TMPROOT/binding-good" "$BINDING_FILE"

# Exercise the real binding CLI, including its private stdin/stdout boundary.
# Rejections expose a finite category, never a DSN, parser error, or input value.
python3 - "$REPO_ROOT/scripts/lib/materialize-database-recovery-binding.ts" <<'PY'
import copy
import json
import subprocess
import sys

script = sys.argv[1]
canary = "PRIVATE_BINDING_VALUE_DO_NOT_LOG"
dsn = f"postgresql://probe_operator:{canary}@10.0.0.1:5432/cogni_operator?sslmode=disable"
binding = {
    "nodeId": "44444444-4444-4444-8444-444444444444",
    "nodeSlug": "operator", "environment": "production",
    "databaseName": "cogni_operator", "probeRole": "probe_operator",
    "systemIdentifier": "123456789", "substrateHost": "a" * 32, "dsn": dsn,
}
other = {**binding, "nodeId": "33333333-3333-4333-8333-333333333333", "environment": "preview"}
valid = {
    "nodeId": binding["nodeId"], "nodeSlug": "operator", "environment": "production",
    "databaseName": "cogni_operator", "probeRole": "probe_operator", "dsn": dsn,
    "expectedHost": "10.0.0.1", "machineId": "a" * 32,
    "localSystemIdentifier": "123456789",
    "observation": {
        "database": "cogni_operator", "role": "probe_operator", "systemTenantExists": True,
        "serverAddress": "10.0.0.1", "serverPort": 5432, "systemIdentifier": "123456789",
        "appRolesCanLogin": True, "runtimeRolesPresent": True, "runtimeRolesNoLogin": False,
        "activeRuntimeSessions": 0, "observedAt": "2026-10-21T07:00:00.000+00:00",
        "probeRoleIsolated": True,
    },
    "existingBindings": [other, binding],
}

def invoke(raw):
    return subprocess.run(["pnpm", "exec", "tsx", script], input=raw, text=True, capture_output=True)

for existing in ([other], [other, binding]):
    value = {**valid, "existingBindings": existing}
    result = invoke(json.dumps(value))
    assert result.returncode == 0 and result.stderr == "", "valid binding rejected"
    assert json.loads(result.stdout) == [other, binding], "binding payload or unrelated scope changed"

def rejected(category, mutate=None, raw=None):
    value = copy.deepcopy(valid)
    if mutate:
        mutate(value)
    result = invoke(json.dumps(value) if raw is None else raw)
    assert result.returncode == 1, f"guard accepted: {category}"
    assert result.stdout == "", f"rejection wrote private stdout: {category}"
    assert result.stderr == f"recovery binding receipt rejected: {category}\n", f"unexpected diagnostic: {category}"
    assert canary not in result.stdout + result.stderr, f"private value leaked: {category}"

rejected("input_json", raw='{"private": "' + canary + '", invalid}')
rejected("input_schema", lambda v: v["observation"].update({canary: canary}))
rejected("input_schema", lambda v: v.update(nodeId=canary))
rejected("canonical_identity", lambda v: v.update(databaseName="cogni_other"))
rejected("canonical_dsn_invalid", lambda v: v.update(dsn=canary + "\ninvalid"))
rejected("canonical_dsn_mismatch", lambda v: v.update(dsn=v["dsn"].replace("10.0.0.1", "10.0.0.2")))
rejected("validation_error", lambda v: v.update(dsn=v["dsn"].replace("probe_operator:", canary + "%zz:")))
rejected("native_identity", lambda v: v["observation"].update(systemIdentifier="987654321"))
rejected("native_identity", lambda v: v["observation"].update(database="cogni_other"))
rejected("duplicate_binding", lambda v: v["existingBindings"].append(binding))
for field, value, category in [
    ("substrateHost", "b" * 32, "prior_machine_id"),
    ("systemIdentifier", "987654321", "prior_system_identifier"),
    ("dsn", dsn.replace("10.0.0.1", "10.0.0.2"), "prior_host"),
    ("dsn", canary + "\ninvalid", "prior_dsn_invalid"),
    ("databaseName", "cogni_other", "prior_database"),
    ("probeRole", "probe_other", "prior_role"),
    ("nodeSlug", "other", "prior_node_slug"),
]:
    rejected(category, lambda v: v["existingBindings"][1].update({field: value}))
rejected("prior_machine_id", lambda v: v["existingBindings"][1].update(substrateHost="b" * 32, dsn=canary))

# The new planner must leave the original seal rejection intact and preserve
# every field except one authorized hostname, using genuine native/local guards.
planner_js = """
const fs=require('node:fs');
const {planRecoveryBinding}=require('./scripts/lib/plan-database-recovery-host-rebind');
const {recoveryBindingErrorCategory}=require('./scripts/lib/materialize-database-recovery-binding');
const v=JSON.parse(fs.readFileSync(0,'utf8'));
try { process.stdout.write(JSON.stringify(planRecoveryBinding(v.input,v.plans,v.now))); }
catch(e) { process.stderr.write(recoveryBindingErrorCategory(e)+'\\n'); process.exitCode=1; }
"""
plan = {"id":"fixture-rehost", "operation":"hostname-only-probe-reattestation", "nodeId":valid["nodeId"], "nodeSlug":"operator", "environment":"production", "transition":"existing-same-identity-to-canonical-host", "newHost":"10.0.0.1", "machineId":"a"*32,
        "authorization":{"state":"armed","receipt":{"reference":"https://example.invalid/test-only-authorization-receipt"}}}
rehost=copy.deepcopy(valid)
rehost["existingBindings"][1]["dsn"]=dsn.replace("10.0.0.1","10.0.0.9")
def invoke_plan(value=rehost, plans=None, now=1792566000000):
    return subprocess.run(["pnpm","exec","tsx","-e",planner_js], input=json.dumps({"input":value,"plans":[plan] if plans is None else plans,"now":now}),text=True,capture_output=True)
# Timestamp follows the fixture's exact 07:00 UTC observation, not wall clock.
from datetime import datetime
fixture_now=int(datetime.fromisoformat(valid["observation"]["observedAt"]).timestamp()*1000)
r=invoke_plan(now=fixture_now)
assert r.returncode==0, r.stderr
assert json.loads(r.stdout)["bindings"]==[other,binding]
assert json.loads(r.stdout)["rebind"]["credentialsPreserved"] is True
assert canary not in json.dumps(json.loads(r.stdout)["rebind"])
# Distinct former addresses converge only to the source-pinned canonical target.
# Neither a remembered IPv4 nor a DNS alias is authority for the destination.
for prior_host in ["10.0.0.8", "former-probe.example.invalid"]:
    value=copy.deepcopy(rehost)
    value["existingBindings"][1]["dsn"]=dsn.replace("10.0.0.1",prior_host)
    r=invoke_plan(value,now=fixture_now)
    assert r.returncode==0 and json.loads(r.stdout)["bindings"]==[other,binding], prior_host
    assert canary not in json.dumps(json.loads(r.stdout)["rebind"])
# Removing the exact source plan still preserves the ordinary host rejection.
assert invoke_plan(plans=[],now=fixture_now).returncode==1
for field,value in [("machineId","b"*32),("nodeId",other["nodeId"]),("transition","arbitrary-host-override"),("newHost","10.0.0.8"),("operation","data-cutover")]:
    wrong={**plan,field:value}; r=invoke_plan(plans=[wrong],now=fixture_now)
    assert r.returncode==1 and not r.stdout and canary not in r.stderr, field
unarmed={**plan,"authorization":{"state":"unarmed","receipt":None}}
assert invoke_plan(plans=[unarmed],now=fixture_now).returncode==1
legacy_fence_claim={**plan,"authorization":{**plan["authorization"],"oldSourceFenced":True}}
assert invoke_plan(plans=[legacy_fence_claim],now=fixture_now).returncode==1
assert invoke_plan(plans=[],now=fixture_now).returncode==1
assert invoke_plan(plans=[plan,plan],now=fixture_now).returncode==1
assert invoke_plan(now=fixture_now+120001).returncode==1
assert invoke_plan(now=fixture_now-5001).returncode==1
for mutate in [
    lambda v:v["existingBindings"][1].update(systemIdentifier="987654321"),
    lambda v:v["existingBindings"][1].update(databaseName="cogni_other"),
    lambda v:v["existingBindings"][1].update(probeRole="probe_other"),
    lambda v:v["existingBindings"][1].update(nodeSlug="other"),
    lambda v:v["existingBindings"][1].update(dsn=v["existingBindings"][1]["dsn"].replace(canary,"changed")),
    lambda v:v["existingBindings"][1].update(dsn=v["existingBindings"][1]["dsn"].replace("disable","require")),
    lambda v:v["existingBindings"][1].update(dsn=v["existingBindings"][1]["dsn"].replace("postgresql:","postgres:")),
    lambda v:v["existingBindings"][1].update(dsn=v["existingBindings"][1]["dsn"].replace(":5432/",":5433/")),
    lambda v:v["existingBindings"][1].update(dsn=v["existingBindings"][1]["dsn"]+"#changed"),
    lambda v:v["existingBindings"].append(v["existingBindings"][1]),
    lambda v:v["observation"].update(systemIdentifier="987654321"),
]:
    value=copy.deepcopy(rehost);mutate(value);r=invoke_plan(value,now=fixture_now)
    assert r.returncode==1 and not r.stdout and canary not in r.stderr
# An already-applied binding takes the unmodified ordinary seal path.
r=invoke_plan(valid,now=fixture_now)
assert r.returncode==0 and json.loads(r.stdout)["rebind"] is None
print("PASS: binding CLI and host-rebind guards preserve private values and identities")
PY

echo "PASS: secret-materialize.test.sh"
