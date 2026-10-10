#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Hermetic control-vault lifecycle proof for task.5223.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT="$(mktemp -d -t flight-probe-credentials.XXXXXX)"
FAILED_LINE=unknown
trap 'FAILED_LINE=$LINENO' ERR
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'FAIL: flight-probe-credentials.test.sh at line %s\n' "$FAILED_LINE" >&2
  fi
  rm -rf "$TMPROOT"
  exit "$rc"
}
trap on_exit EXIT
FAKEBIN="$TMPROOT/bin"
BAO_ROOT="$TMPROOT/openbao"
SSH_ARGV_LOG="$TMPROOT/ssh-argv.log"
JQ_ARGV_LOG="$TMPROOT/jq-argv.log"
REAL_JQ="$(command -v jq)"
mkdir -p "$FAKEBIN" "$BAO_ROOT"

cat > "$FAKEBIN/jq" <<'EOF'
#!/usr/bin/env bash
[ -z "${FAKE_JQ_ARGV_LOG:-}" ] || printf '%s\n' "$@" >> "$FAKE_JQ_ARGV_LOG"
exec "$REAL_JQ" "$@"
EOF
chmod +x "$FAKEBIN/jq"

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
  case "$1" in -i|-o) shift 2 ;; *) shift ;; esac
done
[ "$#" -gt 0 ] && shift
[ -z "${FAKE_SSH_ARGV_LOG:-}" ] || printf '%s\n' "$*" >> "$FAKE_SSH_ARGV_LOG"
PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$*"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = create ] && [ "${2:-}" = token ]; then echo jwt-token; exit 0; fi
if [ "${1:-}" != exec ]; then exit 2; fi
cmd="$*"
if [[ "$cmd" == *"auth/kubernetes/login"* ]]; then echo writer-token; exit 0; fi

# Credential operations stream BAO_TOKEN as the first stdin line to a shell in
# the OpenBao container. It must not appear in the pod-exec command argv.
if [[ "$cmd" == *"sh -c"* && "$cmd" == *"exec bao"* ]]; then
  IFS= read -r token
  [ "$token" = writer-token ] || exit 3
fi
path="$(printf '%s' "$cmd" | grep -oE 'cogni/[A-Za-z0-9_./-]+' | tail -n 1)"
if [[ "$cmd" == *"bao kv get -format=json"* ]]; then
  dir="${FAKE_BAO_ROOT}/${path}"
  if [ ! -d "$dir" ]; then echo "No value found at ${path}" >&2; exit 2; fi
  version="$(cat "$dir/.version")"
  data='{}'
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    data="$("$REAL_JQ" -c --arg key "$(basename "$f")" --rawfile value "$f" '.[$key]=$value' <<<"$data")"
  done
  "$REAL_JQ" -cn --argjson data "$data" --argjson version "$version" \
    '{data:{data:$data,metadata:{version:$version}}}'
  exit 0
fi

if [[ "$cmd" == *"bao kv patch"* || "$cmd" == *"bao kv put"* ]]; then
  dir="${FAKE_BAO_ROOT}/${path}"
  current=0
  [ -f "$dir/.version" ] && current="$(cat "$dir/.version")"
  cas="$(printf '%s' "$cmd" | sed -n 's/.*-cas=\([0-9][0-9]*\).*/\1/p')"
  if [ "$cas" != "$current" ]; then echo "check-and-set parameter did not match" >&2; exit 2; fi
  if [[ "$cmd" == *"bao kv patch"* ]] && [ ! -d "$dir" ]; then echo "No value found" >&2; exit 2; fi
  mkdir -p "$dir"
  while IFS=$'\t' read -r key value; do
    [ -n "$key" ] && printf '%s' "$value" > "$dir/$key"
  done < <("$REAL_JQ" -r 'to_entries[] | [.key,.value] | @tsv')
  printf '%s' "$((current + 1))" > "$dir/.version"
  echo success
  exit 0
fi
exit 2
EOF
chmod +x "$FAKEBIN/kubectl"

run_lifecycle() {
  local op="$1" out="$2"
  if ! env \
    PATH="$FAKEBIN:$PATH" \
    VM_HOST=fake \
    FLEET_CONTROL_ENV=production \
    SECRETS_CONTROL_ENV=production \
    COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" \
    FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
    FAKE_REMOTE_PATH="$FAKEBIN" \
    FAKE_BAO_ROOT="$BAO_ROOT" \
    FAKE_SSH_ARGV_LOG="$SSH_ARGV_LOG" \
    FAKE_JQ_ARGV_LOG="$JQ_ARGV_LOG" \
    REAL_JQ="$REAL_JQ" \
    SSH_OPTS='-i fake' \
    bash scripts/ci/flight-probe-credentials.sh "$op" candidate-a node-template >"$out" 2>&1; then
    grep -Ei 'error|failed|invalid|check-and-set|no value|refus' "$out" >&2 || true
    return 1
  fi
}

NODE_ID="$(yq -N '.node_id' infra/catalog/node-template.yaml)"
RING_FILE="$BAO_ROOT/cogni/candidate-a/flight-prober/$NODE_ID"
TARGET_RING_FILE="$BAO_ROOT/cogni/candidate-a/node-template/FLIGHT_PROBE_API_KEY"
MAP_FILE="$BAO_ROOT/cogni/production/operator/FLIGHT_PROBE_CREDENTIALS_JSON"

run_lifecycle materialize "$TMPROOT/materialize.out"
test -f "$RING_FILE" && test -f "$TARGET_RING_FILE" && test -f "$MAP_FILE"
jq -e '(keys | sort) == ["active","previous"] and (.active|length)>=32 and .previous==null' "$RING_FILE" >/dev/null
test "$(cat "$TARGET_RING_FILE")" = "$(cat "$RING_FILE")"
OLD="$(jq -r '.active' "$RING_FILE")"
test "$(jq -r --arg key "candidate-a/$NODE_ID" '.[$key]' "$MAP_FILE")" = "$OLD"
! grep -qF "$OLD" "$TMPROOT/materialize.out"

# Idempotent materialize preserves the durable service credential.
run_lifecycle materialize "$TMPROOT/materialize-2.out"
test "$(jq -r '.active' "$RING_FILE")" = "$OLD"

# prepare persists exactly two keys while the operator keeps sending old.
run_lifecycle prepare "$TMPROOT/prepare.out"
NEW="$(jq -r '.active' "$RING_FILE")"
test "$NEW" != "$OLD"
test "$(jq -r '.previous' "$RING_FILE")" = "$OLD"
test "$(cat "$TARGET_RING_FILE")" = "$(cat "$RING_FILE")"
test "$(jq -r --arg key "candidate-a/$NODE_ID" '.[$key]' "$MAP_FILE")" = "$OLD"
run_lifecycle prepare "$TMPROOT/prepare-retry.out"
test "$(jq -r '.active' "$RING_FILE")" = "$NEW"
grep -q 'no third key minted' "$TMPROOT/prepare-retry.out"

# activate switches only the exact map entry; finish revokes predecessor.
run_lifecycle activate "$TMPROOT/activate.out"
test "$(jq -r --arg key "candidate-a/$NODE_ID" '.[$key]' "$MAP_FILE")" = "$NEW"
test "$(jq -r '.previous' "$RING_FILE")" = "$OLD"
run_lifecycle finish "$TMPROOT/finish.out"
test "$(jq -r '.active' "$RING_FILE")" = "$NEW"
test "$(jq -r '.previous' "$RING_FILE")" = null
test "$(cat "$TARGET_RING_FILE")" = "$(cat "$RING_FILE")"
grep -q 'remains pending.*old-key 401' "$TMPROOT/finish.out"

# revoke re-keys the target before removing operator authority; retry is stable.
run_lifecycle revoke "$TMPROOT/revoke.out"
REVOKED_ACTIVE="$(jq -r '.active' "$RING_FILE")"
test "$REVOKED_ACTIVE" != "$NEW"
test "$(cat "$TARGET_RING_FILE")" = "$(cat "$RING_FILE")"
test "$(jq -r --arg key "candidate-a/$NODE_ID" '.[$key] // empty' "$MAP_FILE")" = ""
grep -q 'prepared revocation.*pending.*401' "$TMPROOT/revoke.out"
run_lifecycle revoke "$TMPROOT/revoke-retry.out"
test "$(jq -r '.active' "$RING_FILE")" = "$REVOKED_ACTIVE"

for secret in "$OLD" "$NEW" "$REVOKED_ACTIVE"; do
  ! grep -R -qF "$secret" "$TMPROOT"/*.out
  ! grep -qF "$secret" "$SSH_ARGV_LOG"
  ! grep -qF "$secret" "$JQ_ARGV_LOG"
done
! grep -qF writer-token "$SSH_ARGV_LOG"

# Strict bounded ring: an unknown third field fails closed and is not healed or
# leaked by ordinary materialization.
THIRD_SECRET="$(openssl rand -base64 32)"
jq -cn --arg active "$REVOKED_ACTIVE" --arg third "$THIRD_SECRET" \
  '{active:$active,previous:null,third:$third}' > "$RING_FILE"
set +e
run_lifecycle materialize "$TMPROOT/invalid-ring.out"
invalid_rc=$?
set -e
test "$invalid_rc" -ne 0
grep -q 'invalid bounded ring' "$TMPROOT/invalid-ring.out"
! grep -qF "$THIRD_SECRET" "$TMPROOT/invalid-ring.out"

# A non-control writer can never create another authority.
set +e
env VM_HOST=fake FLEET_CONTROL_ENV=production SECRETS_CONTROL_ENV=candidate-a \
  COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" SSH_OPTS='-i fake' \
  bash scripts/ci/flight-probe-credentials.sh materialize candidate-a node-template \
  >"$TMPROOT/wrong-control.out" 2>&1
rc=$?
set -e
test "$rc" -ne 0
grep -q 'control-vault-only' "$TMPROOT/wrong-control.out"

# Inputs interpolated into transport/path commands are canonical before the
# first ssh call. Quote/metacharacter payloads cannot become remote commands.
INJECTION_MARKER="$TMPROOT/injected"
set +e
env VM_HOST=fake FLEET_CONTROL_ENV=production SECRETS_CONTROL_ENV=production \
  COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" SSH_OPTS='-i fake' \
  bash scripts/ci/flight-probe-credentials.sh materialize candidate-a \
  "node-template'; touch $INJECTION_MARKER; #" >"$TMPROOT/invalid-node.out" 2>&1
invalid_node_rc=$?
env VM_HOST="fake; touch $INJECTION_MARKER" FLEET_CONTROL_ENV=production SECRETS_CONTROL_ENV=production \
  COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" SSH_OPTS='-i fake' \
  bash scripts/ci/flight-probe-credentials.sh materialize candidate-a node-template \
  >"$TMPROOT/invalid-host.out" 2>&1
invalid_host_rc=$?
set -e
test "$invalid_node_rc" -ne 0
test "$invalid_host_rc" -ne 0
grep -q 'invalid node slug' "$TMPROOT/invalid-node.out"
grep -q 'invalid VM_HOST' "$TMPROOT/invalid-host.out"
test ! -e "$INJECTION_MARKER"

set +e
env VM_HOST=fake FLEET_CONTROL_ENV=production SECRETS_CONTROL_ENV=production \
  COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
  FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" SSH_OPTS='-i fake' \
  bash scripts/ci/flight-probe-credentials.sh materialize candidate-a node-template- \
  >"$TMPROOT/noncanonical-node.out" 2>&1
noncanonical_node_rc=$?
set -e
test "$noncanonical_node_rc" -ne 0
grep -q 'invalid node slug' "$TMPROOT/noncanonical-node.out"

for invalid_host in '-oProxyCommand=touch injected' 'fake host' '.fake' 'fake.' 'fake..host'; do
  set +e
  env VM_HOST="$invalid_host" FLEET_CONTROL_ENV=production SECRETS_CONTROL_ENV=production \
    COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
    FAKE_REMOTE_PATH="$FAKEBIN" FAKE_BAO_ROOT="$BAO_ROOT" SSH_OPTS='-i fake' \
    bash scripts/ci/flight-probe-credentials.sh materialize candidate-a node-template \
    >"$TMPROOT/invalid-host-shape.out" 2>&1
  invalid_host_shape_rc=$?
  set -e
  test "$invalid_host_shape_rc" -ne 0
  grep -q 'invalid VM_HOST' "$TMPROOT/invalid-host-shape.out"
done

# REPO_SPEC_IS_IDENTITY_SSOT: an in-repo node resolves through its readable
# repo-spec even though the catalog correctly omits node_id.
operator_id="$(
  COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" bash -c \
    '. scripts/ci/lib/image-tags.sh; node_id_for_target operator'
)"
test "$operator_id" = "$(yq -N '.node_id' nodes/operator/.cogni/repo-spec.yaml)"

# Every selected type:node must have a canonical UUID. A catalog row without a
# readable identity may never be silently excluded from credential projection.
IDENTITY_ROOT="$TMPROOT/identity-tree"
mkdir -p "$IDENTITY_ROOT/infra/catalog" "$IDENTITY_ROOT/nodes/missing-id/.cogni"
cat > "$IDENTITY_ROOT/infra/catalog/missing-id.yaml" <<'EOF'
name: missing-id
type: node
path_prefix: nodes/missing-id/
deployment_provider:
  candidate-a: k3s
EOF
cat > "$IDENTITY_ROOT/nodes/missing-id/.cogni/repo-spec.yaml" <<'EOF'
schema_version: "1.0"
intent:
  name: missing-id
EOF

set +e
env VM_HOST=fake FLEET_CONTROL_ENV=production SECRETS_CONTROL_ENV=production \
  COGNI_CATALOG_ROOT="$IDENTITY_ROOT/infra/catalog" \
  bash scripts/ci/flight-probe-credentials.sh materialize candidate-a missing-id \
  >"$TMPROOT/missing-node-id.out" 2>&1
missing_node_id_rc=$?
printf '{"active":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","previous":null}' | \
  env VM_HOST=fake COGNI_CATALOG_ROOT="$IDENTITY_ROOT/infra/catalog" \
  bash scripts/ci/project-flight-probe-ring.sh candidate-a missing-id materialize \
  >"$TMPROOT/missing-project-node-id.out" 2>&1
missing_project_node_id_rc=$?
set -e
test "$missing_node_id_rc" -ne 0
test "$missing_project_node_id_rc" -ne 0
grep -q "node_id missing for 'missing-id'" "$TMPROOT/missing-node-id.out"
grep -q "node_id missing for 'missing-id'" "$TMPROOT/missing-project-node-id.out"

echo "PASS: flight-probe-credentials.test.sh"
