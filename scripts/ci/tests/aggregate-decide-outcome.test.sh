#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/aggregate-decide-outcome.test.sh
#
# Regression harness for the preview aggregate decision contract. Preview can
# have e2e skipped while its per-node deploy cells still verified; production
# must remain strict.
#
# Run: bash scripts/ci/tests/aggregate-decide-outcome.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DECIDE_SCRIPT="${CI_DIR}/aggregate-decide-outcome.sh"

if [ ! -f "$DECIDE_SCRIPT" ]; then
  echo "[FAIL] aggregate-decide-outcome.sh not found at $DECIDE_SCRIPT" >&2
  exit 1
fi

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

make_cells() {
  local dir="$1" promoted="${2:-true}" verified="${3:-true}"
  mkdir -p "$dir"
  printf '%s' "$promoted" >"${dir}/promoted-operator.txt"
  if [ "$verified" != "missing" ]; then
    printf '%s' "$verified" >"${dir}/verified-operator.txt"
  fi
}

run_case() {
  local name="$1" env_name="$2" e2e_result="$3" expected_outcome="$4" expected_rc="$5"
  local promoted="${6:-true}" verified="${7:-true}" strict_fail="${8:-}"
  local case_dir="${TMPROOT}/${name}"
  local output_file="${case_dir}/github-output.txt"
  mkdir -p "$case_dir"
  make_cells "${case_dir}/cells" "$promoted" "$verified"
  : >"$output_file"

  local rc=0
  ENV="$env_name" \
    CELLS_DIR="${case_dir}/cells" \
    PROMOTE_RESULT=success \
    VERIFY_RESULT=success \
    VERIFY_DEPLOY_RESULT=success \
    E2E_RESULT="$e2e_result" \
    DEPLOY_INFRA_RESULT=skipped \
    STRICT_FAIL="$strict_fail" \
    GITHUB_OUTPUT="$output_file" \
    bash "$DECIDE_SCRIPT" >"${case_dir}/stdout.log" 2>"${case_dir}/stderr.log" \
    || rc=$?

  local actual_outcome
  actual_outcome="$(grep '^outcome=' "$output_file" | tail -1 | sed 's/^outcome=//' || true)"

  if [ "$actual_outcome" != "$expected_outcome" ] || [ "$rc" != "$expected_rc" ]; then
    echo "[FAIL] ${name}: expected outcome=${expected_outcome} rc=${expected_rc}; got outcome=${actual_outcome} rc=${rc}"
    echo "--- stdout ---"
    cat "${case_dir}/stdout.log"
    echo "--- stderr ---"
    cat "${case_dir}/stderr.log"
    return 1
  fi

  echo "[PASS] ${name}"
}

run_case "preview-allows-skipped-e2e" preview skipped dispatched 0
run_case "preview-allows-success-e2e" preview success dispatched 0
run_case "production-requires-e2e-success" production skipped failed 1 true true 1
run_case "no-promotion-fails-closed" preview skipped failed 1 false true
run_case "unverified-promotion-fails" preview skipped failed 0 true missing

echo "PASS: aggregate-decide-outcome.test.sh"
