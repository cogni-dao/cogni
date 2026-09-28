#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# image-missing-action.test.sh — a named target must never be silently skipped (bug.5248).
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
. "${LIB_DIR}/image-tags.sh"

fails=0
expect() {
  local want="$1" got="$2" label="$3"
  if [ "$want" = "$got" ]; then
    echo "  ok   ${label}"
  else
    echo "  FAIL ${label}: want=${want} got=${got}"
    fails=$((fails + 1))
  fi
}

echo "missing_image_action"
# The operator API always dispatches one named node, so this is the promote path.
expect fail "$(missing_image_action operator)" "single named target -> fail"
expect fail "$(missing_image_action 'operator,scheduler-worker')" "named CSV -> fail"
# Empty `nodes` is the fleet fan-out: unaffected nodes were never rebuilt.
expect skip "$(missing_image_action '')" "empty targets (fleet fan-out) -> skip"
expect skip "$(missing_image_action)" "absent argument -> skip"

if [ "$fails" -ne 0 ]; then
  echo "${fails} failure(s)"
  exit 1
fi
echo "all passed"
