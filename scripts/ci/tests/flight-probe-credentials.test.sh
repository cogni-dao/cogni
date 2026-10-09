#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Hermetic control-vault lifecycle proof for task.5223.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT="$(mktemp -d -t flight-probe-credentials.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT
FAKEBIN="$TMPROOT/bin"
BAO_ROOT="$TMPROOT/openbao"
mkdir -p "$FAKEBIN" "$BAO_ROOT"

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
  case "$1" in -i|-o) shift 2 ;; *) shift ;; esac
done
[ "$#" -gt 0 ] && shift
PATH="${FAKE_REMOTE_PATH}:${PATH}" bash -c "$*"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = create ] && [ "${2:-}" = token ]; then echo jwt-token; exit 0; fi
if [ "${1:-}" != exec ]; then exit 2; fi
args=("$@")
cmd="$*"
if [[ "$cmd" == *"auth/kubernetes/login"* ]]; then echo writer-token; exit 0; fi

path="${args[$((${#args[@]} - 2))]}"
last="${args[$((${#args[@]} - 1))]}"
if [[ "$cmd" == *"bao kv get -format=json"* ]]; then
  path="$last"
  dir="${FAKE_BAO_ROOT}/${path}"
  if [ ! -d "$dir" ]; then echo "No value found at ${path}" >&2; exit 2; fi
  version="$(cat "$dir/.version")"
  data='{}'
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    data="$(jq -c --arg key "$(basename "$f")" --rawfile value "$f" '.[$key]=$value' <<<"$data")"
  done
  jq -cn --argjson data "$data" --argjson version "$version" \
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
  done < <(jq -r 'to_entries[] | [.key,.value] | @tsv')
  printf '%s' "$((current + 1))" > "$dir/.version"
  echo success
  exit 0
fi
exit 2
EOF
chmod +x "$FAKEBIN/kubectl"

run_lifecycle() {
  local op="$1" out="$2"
  env \
    VM_HOST=fake \
    FLEET_CONTROL_ENV=production \
    SECRETS_CONTROL_ENV=production \
    COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" \
    FLIGHT_PROBE_SSH_BIN="$FAKEBIN/ssh" \
    FAKE_REMOTE_PATH="$FAKEBIN" \
    FAKE_BAO_ROOT="$BAO_ROOT" \
    SSH_OPTS='-i fake' \
    bash scripts/ci/flight-probe-credentials.sh "$op" candidate-a node-template >"$out" 2>&1
}

NODE_ID="$(yq -N '.node_id' infra/catalog/node-template.yaml)"
RING_FILE="$BAO_ROOT/cogni/candidate-a/node-template/FLIGHT_PROBE_API_KEY"
MAP_FILE="$BAO_ROOT/cogni/production/operator/FLIGHT_PROBE_CREDENTIALS_JSON"

run_lifecycle materialize "$TMPROOT/materialize.out"
test -f "$RING_FILE" && test -f "$MAP_FILE"
jq -e '(keys | sort) == ["active","previous"] and (.active|length)>=32 and .previous==null' "$RING_FILE" >/dev/null
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

# revoke re-keys the target before removing operator authority; retry is stable.
run_lifecycle revoke "$TMPROOT/revoke.out"
REVOKED_ACTIVE="$(jq -r '.active' "$RING_FILE")"
test "$REVOKED_ACTIVE" != "$NEW"
test "$(jq -r --arg key "candidate-a/$NODE_ID" '.[$key] // empty' "$MAP_FILE")" = ""
run_lifecycle revoke "$TMPROOT/revoke-retry.out"
test "$(jq -r '.active' "$RING_FILE")" = "$REVOKED_ACTIVE"

for secret in "$OLD" "$NEW" "$REVOKED_ACTIVE"; do
  ! grep -R -qF "$secret" "$TMPROOT"/*.out
done

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

echo "PASS: flight-probe-credentials.test.sh"
