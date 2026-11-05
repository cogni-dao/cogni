#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Fixture-driven regression tests for scripts/secrets/set-secret.sh (task.0284).
# Uses $SET_SECRET_BAO as a test shim — a stub script that records (path,
# key, value-from-stdin) into a fixture file. No real bao, no real SSH.
#
# Run: bash scripts/ci/tests/set-secret.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/scripts/secrets/set-secret.sh"

TMPROOT=$(mktemp -d -t set-secret.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

LOG="$TMPROOT/calls.log"

# Test shim: writes "<path>|<key>|<value>" to $LOG.
cat >"$TMPROOT/bao-shim.sh" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
path="$1"; key="$2"
value=$(cat)
printf '%s|%s|%s\n' "$path" "$key" "$value" >>"${SHIM_LOG}"
SHIM
chmod +x "$TMPROOT/bao-shim.sh"

pass=0
fail=0

run_case() {
  # $1 case name; $2 stdin value (empty string for no input); $3 expected exit;
  # $4 expected SHIM_LOG content (empty means no shim invocation expected);
  # $@ from $5 onward: args to set-secret.sh.
  local name="$1" stdin="$2" expected_exit="$3" expected_log="$4"
  shift 4
  : >"$LOG"
  local got=0 out
  if [[ -n "$stdin" ]]; then
    out=$(printf '%s' "$stdin" | SHIM_LOG="$LOG" SET_SECRET_BAO="$TMPROOT/bao-shim.sh" REPO_ROOT="$REPO_ROOT" bash "$TARGET" "$@" 2>&1) || got=$?
  else
    out=$(SHIM_LOG="$LOG" SET_SECRET_BAO="$TMPROOT/bao-shim.sh" REPO_ROOT="$REPO_ROOT" bash "$TARGET" "$@" </dev/null 2>&1) || got=$?
  fi
  local logged
  logged=$(cat "$LOG" 2>/dev/null || true)
  if [[ "$got" -eq "$expected_exit" && "$logged" == "$expected_log" ]]; then
    printf 'OK  %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s — exit got=%d want=%d; log got=%q want=%q\n' \
      "$name" "$got" "$expected_exit" "$logged" "$expected_log"
    printf '  output:\n'
    # shellcheck disable=SC2001
    sed 's/^/    /' <<<"$out"
    fail=$((fail + 1))
  fi
}

# Case 1 — happy path: valid env + catalog service + key + value via stdin.
run_case "happy path writes through to bao" "hunter2" 0 \
  "cogni/candidate-a/node-template|OPENROUTER_API_KEY|hunter2" \
  candidate-a node-template OPENROUTER_API_KEY

# Case 2 — preview env accepted.
run_case "preview env accepted" "v" 0 \
  "cogni/preview/scheduler-worker|GH_WEBHOOK_SECRET|v" \
  preview scheduler-worker GH_WEBHOOK_SECRET

# Case 3 — _shared namespace accepted.
run_case "_shared namespace accepted" "shared-val" 0 \
  "cogni/candidate-a/_shared|OPENROUTER_API_KEY|shared-val" \
  candidate-a _shared OPENROUTER_API_KEY

# Case 4 — _system namespace rejected (Spec Invariant 10).
run_case "_system rejected" "x" 2 "" \
  candidate-a _system SOME_KEY

# Case 5 — other reserved _foo namespace rejected.
run_case "_unknown reserved namespace rejected" "x" 2 "" \
  candidate-a _operator FOO

# Case 6 — unknown env rejected.
run_case "unknown env rejected" "x" 2 "" \
  staging node-template FOO

# Case 7 — unknown service (no catalog file) rejected.
run_case "unknown service rejected" "x" 2 "" \
  candidate-a not-a-real-service FOO

# Case 8 — lowercase key rejected.
run_case "lowercase key rejected" "x" 2 "" \
  candidate-a node-template lowercase_key

# Case 9 — key starting with digit rejected.
run_case "digit-leading key rejected" "x" 2 "" \
  candidate-a node-template 1_BAD_KEY

# Case 10 — key with hyphen rejected.
run_case "hyphenated key rejected" "x" 2 "" \
  candidate-a node-template BAD-KEY

# Case 11 — empty stdin value rejected.
run_case "empty value rejected" "" 2 "" \
  candidate-a node-template GOOD_KEY

# Case 12 — wrong arg count rejected.
run_case "missing service arg rejected" "x" 2 "" \
  candidate-a node-template

# Dynamic manual-cell components use the real CLI path with a fake bao executable,
# so -method=patch/CAS and no-fallback behavior are observed rather than bypassed.
mkdir -p "$TMPROOT/fakebin"
cat >"$TMPROOT/fakebin/bao" <<'BAO'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_BAO_LOG"
case "$1/$2" in
  kv/get)
    if [[ "$FAKE_MODE" == absent || "$FAKE_MODE" == concurrent ]]; then
      echo 'No value found' >&2; exit 2
    fi
    echo '{"data":{"metadata":{"version":7},"data":{"sibling":"preserved"}}}' ;;
  kv/patch)
    [[ "$3" == -method=patch && "$4" == -cas=7 ]] || exit 8
    cat > "$FAKE_BAO_VALUE"
    [[ "$FAKE_MODE" != race && "$FAKE_MODE" != missing ]] || exit 2 ;;
  kv/put)
    [[ "$3" == -cas=0 ]] || exit 8
    cat > "$FAKE_BAO_VALUE"
    [[ "$FAKE_MODE" != concurrent ]] || exit 2 ;;
  *) exit 8 ;;
esac
BAO
chmod +x "$TMPROOT/fakebin/bao"
component_case() {
  local name="$1" mode="$2" version="$3" body="$4" expected="$5" env_name="$6" service="$7" key="$8" rc=0 output
  : > "$TMPROOT/component.log"; rm -f "$TMPROOT/component-value"
  output="$(printf '%s' "$body" | env -u SET_SECRET_BAO PATH="$TMPROOT/fakebin:$PATH" BAO_ADDR=http://fixture.invalid BAO_TOKEN=fixture-only FAKE_MODE="$mode" FAKE_BAO_LOG="$TMPROOT/component.log" FAKE_BAO_VALUE="$TMPROOT/component-value" SET_SECRET_EXPECTED_VERSION="$version" REPO_ROOT="$REPO_ROOT" bash "$TARGET" "$env_name" "$service" "$key" 2>&1)" || rc=$?
  if { [[ "$expected" == pass && "$rc" == 0 ]] || [[ "$expected" == fail && "$rc" != 0 ]]; } && ! grep -q 'kv put' "$TMPROOT/component.log"; then
    printf 'OK  %s\n' "$name"; pass=$((pass+1))
  elif [[ "$expected" == create && "$rc" == 0 ]] && grep -q '^kv put -cas=0 ' "$TMPROOT/component.log"; then
    printf 'OK  %s\n' "$name"; pass=$((pass+1))
  elif [[ "$expected" == concurrent && "$rc" != 0 ]] && [[ "$(wc -l < "$TMPROOT/component.log")" -eq 2 ]]; then
    printf 'OK  %s\n' "$name"; pass=$((pass+1))
  else
    printf 'FAIL %s exit=%s\n' "$name" "$rc"; printf '%s\n' "$output"; fail=$((fail+1))
  fi
}
component_case 'owned probe PASSWORD uses expected-version PATCH' normal 7 fixture-password pass production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'probe PASSWORD CAS race never falls back' race 7 fixture-password fail production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'probe PASSWORD missing bank never falls back' missing 7 fixture-password fail production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'probe PASSWORD CAS0 creates only after positive absence' absent 0 fixture-password create production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'probe PASSWORD CAS0 concurrent creator refuses' concurrent 0 fixture-password concurrent production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'probe PASSWORD CAS0 refuses existing bank' normal 0 fixture-password fail production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'probe PASSWORD requires expected version' normal '' fixture-password fail production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'dynamic component refuses nonproduction' normal 7 fixture-password fail preview poly-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'dynamic component refuses unknown node' normal 7 fixture-password fail production not-a-real-node-database-recovery-probe DATABASE_RECOVERY_PROBE_PASSWORD
component_case 'dynamic component refuses direct derived URL' normal 7 fixture-password fail production poly-database-recovery-probe DATABASE_RECOVERY_PROBE_URL
component_case 'dynamic component refuses APPLIED receipt setter' normal 7 '{}' fail production poly-database-cell DATABASE_CELL_PLACEMENT_RECEIPT_JSON
component_case 'dynamic component refuses malformed typed input' normal 7 '{}' fail production poly-database-cell DATABASE_CELL_APPLIED_CUSTODY_JSON
manual='{"nodeId":"4b06359a-a859-4399-888e-a8c7a6696f7e","nodeSlug":"poly","environment":"production"}'
manual_hash="$(printf '%s' "$manual" | openssl dgst -sha256 | awk '{print $NF}')"
manual_bytes="$(printf '%s' "$manual" | base64 | tr -d '\n')"
bundle="$(jq -nc --arg digest "$manual_hash" --arg bytes "$manual_bytes" '{version:1,nodeId:"4b06359a-a859-4399-888e-a8c7a6696f7e",environment:"production",artifacts:[{kind:"manual-cutover",mediaType:"application/json",sha256:$digest,bytesBase64:$bytes}]}')"
component_case 'owned bounded evidence bytes use canonical PATCH' normal 7 "$bundle" pass production poly-database-cell DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON
foreign="$(jq '.nodeId="11111111-1111-4111-8111-111111111111"' <<<"$bundle")"
component_case 'typed private input refuses foreign owner' normal 7 "$foreign" fail production poly-database-cell DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON

echo
echo "set-secret.test.sh — pass: $pass, fail: $fail"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
