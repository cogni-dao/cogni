#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/promote-build-payload.test.sh
#
# Regression harness for bug.0328. Three cases:
#   1. Happy path           → promoted_apps=<all4>, map written.
#   2. MAP_SCRIPT failing   → promoted_apps=<all4>, map absent (defense:
#                             source-sha-map failure must NOT shadow
#                             promoted_apps — that is the silent-green
#                             leak PR #921 left open).
#   3. Empty payload        → promoted_apps='' (genuine no-op skip).
#
# Run: bash scripts/ci/tests/promote-build-payload.test.sh
# Exit 0 on all pass, non-zero with diff on first failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CI_DIR}/../.." && pwd)"
PROMOTE_BUILD_PAYLOAD="${CI_DIR}/promote-build-payload.sh"
UPDATE_MAP="${CI_DIR}/update-source-sha-map.sh"

if [ ! -f "$PROMOTE_BUILD_PAYLOAD" ]; then
  echo "[FAIL] promote-build-payload.sh not found at $PROMOTE_BUILD_PAYLOAD" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

FAILED=0

stub_promote_script() {
  # Mimics promote-k8s-image.sh's observable surface: log the target, touch
  # the overlay file so downstream diffs are non-empty.
  local out="$1"
  cat >"$out" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2;;
    --digest|--migrator-digest|--env) shift 2;;
    --no-commit) shift;;
    *) shift;;
  esac
done
echo "[INFO] Promoting $APP image"
echo "[INFO] Skipping commit (--no-commit)."
STUB
  chmod +x "$out"
}

make_payload() {
  local out="$1" source_sha="$2" targets_json="$3"
  cat >"$out" <<JSON
{"source_sha":"${source_sha}","targets":${targets_json}}
JSON
}

FULL_TARGETS='[
  {"target":"operator","digest":"sha256:aa01"},
  {"target":"operator-migrator","digest":"sha256:aa02"},
  {"target":"poly","digest":"sha256:bb01"},
  {"target":"poly-migrator","digest":"sha256:bb02"},
  {"target":"resy","digest":"sha256:cc01"},
  {"target":"resy-migrator","digest":"sha256:cc02"},
  {"target":"node-template","digest":"sha256:ee01"},
  {"target":"node-template-migrator","digest":"sha256:ee02"},
  {"target":"scheduler-worker","digest":"sha256:dd01"}
]'
EMPTY_TARGETS='[]'

run_case() {
  local name="$1"
  local map_script="$2"
  local payload_targets="$3"
  local expect_promoted="$4"
  local expect_map_exists="$5"
  local expect_rc="${6:-0}"

  local case_dir="$WORKDIR/$name"
  mkdir -p "$case_dir"
  cd "$case_dir"

  stub_promote_script "$case_dir/stub-promote.sh"
  make_payload "$case_dir/payload.json" "abcdef1234567890abcdef1234567890abcdef12" "$payload_targets"
  local out_file="$case_dir/github_output.txt"
  : >"$out_file"

  local rc=0
  PAYLOAD_FILE="$case_dir/payload.json" \
    OVERLAY_ENV=candidate-a \
    PROMOTE_SCRIPT="$case_dir/stub-promote.sh" \
    MAP_SCRIPT="$map_script" \
    MAP_FILE="$case_dir/.promote-state/source-sha-by-app.json" \
    GITHUB_OUTPUT="$out_file" \
    bash "$PROMOTE_BUILD_PAYLOAD" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log" \
    || rc=$?

  # Read the last promoted_apps=... line from $GITHUB_OUTPUT (last-write-wins).
  local got
  got="$(grep '^promoted_apps=' "$out_file" | tail -1 | sed 's/^promoted_apps=//' || true)"

  local ok=1
  if [ "$got" != "$expect_promoted" ]; then
    echo "[FAIL] case=$name expected promoted_apps='$expect_promoted' got='$got' (script rc=$rc)"
    echo "  stdout: $case_dir/stdout.log"
    echo "  stderr: $case_dir/stderr.log"
    ok=0
  fi

  local map_exists=no
  [ -f "$case_dir/.promote-state/source-sha-by-app.json" ] && map_exists=yes
  if [ "$map_exists" != "$expect_map_exists" ]; then
    echo "[FAIL] case=$name expected map_exists=$expect_map_exists got=$map_exists"
    ok=0
  fi

  if [ "$rc" != "$expect_rc" ]; then
    echo "[FAIL] case=$name expected rc=$expect_rc got=$rc"
    ok=0
  fi

  if [ "$ok" = "1" ]; then
    echo "[PASS] case=$name promoted_apps='$got' map_exists=$map_exists rc=$rc"
  else
    FAILED=$((FAILED + 1))
  fi
}

# Case 1 — happy path. Real update-source-sha-map.sh, full payload.
run_case "happy" "$UPDATE_MAP" "$FULL_TARGETS" "operator,poly,resy,node-template,scheduler-worker" "yes" 0

# Case 2 — MAP_SCRIPT fails for EVERY app (provenance side-car dead).
# promoted_apps must still reflect every overlay write (verify-candidate
# must still run), but the script exits non-zero so the flight job turns
# red — total provenance loss is a hard break, not silent decay.
run_case "map-script-failing" "/bin/false" "$FULL_TARGETS" "operator,poly,resy,node-template,scheduler-worker" "no" 1

# Case 3 — genuine no-op (empty payload). promoted_apps must be empty so
# verify-candidate's job-level gate skips legitimately and release-slot
# treats it as a green no-op.
run_case "empty-payload" "$UPDATE_MAP" "$EMPTY_TARGETS" "" "no" 0

cd "$REPO_ROOT"
if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED case(s) failed"
  exit 1
fi
echo ""
echo "all cases passed"
