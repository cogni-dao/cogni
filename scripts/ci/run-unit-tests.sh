#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/ci/run-unit-tests.sh
# Purpose: Run the unit/contract vitest suites with affected-scoping on PRs and
#   FULL scope on merge_group/push (task.5140 Stage B / AFFECTED_ONLY_CI). The
#   suite is two disjoint vitest universes:
#
#     ROOT config (`vitest run`) — tests/** + packages/*/tests + services/*/tests
#       (ci-invariants, catalog SSoT specs, arch, all package/service unit tests).
#       Turbo does NOT model this glob-universe (there is no //#test task), so it
#       ALWAYS runs full. Dropping it on a PR would silently lose that coverage —
#       the exact false-green the affected-only design must never produce.
#
#     OPERATOR app config — ~60% of the suite's CI wall-time. Gated on turbo's
#       affected oracle: skipped on a PR only when we are CONFIDENT neither the
#       operator app NOR any package it depends on changed. ALWAYS run on
#       merge_group / push:main. That full off-PR run is the BACKSTOP — the
#       required `unit` check re-runs on the merge-queue candidate, so any
#       PR-time affected miss is caught before the code can land on main.
#
# Fail-safe: the operator suite is skipped ONLY on a clean "not affected" signal
# from turbo. Any turbo error / uncertainty falls through to running it.
#
# Env: CI_EVENT      — github.event_name (pull_request | merge_group | push)
#      TURBO_SCM_BASE — affected base ref (default origin/main)

set -euo pipefail

CI_EVENT="${CI_EVENT:-}"
BASE="${TURBO_SCM_BASE:-origin/main}"

run_root() {
  echo "::group::run-unit-tests: root config (always full)"
  pnpm exec vitest run
  echo "::endgroup::"
}

run_operator() {
  echo "::group::run-unit-tests: operator app config"
  pnpm exec vitest run --config nodes/operator/app/vitest.config.mts
  echo "::endgroup::"
}

run_root

# Off-PR (merge_group / push:main): full scope — this is the safety backstop.
if [ "$CI_EVENT" != "pull_request" ]; then
  echo "run-unit-tests: event='${CI_EVENT}' → operator config FULL (backstop scope)"
  run_operator
  exit 0
fi

# PR: consult turbo's affected oracle. `operator#test` appears iff the operator
# app package is affected (itself or via a changed dependency). Skip ONLY on a
# clean not-affected signal; run on any error (fail-safe).
skip_operator=false
if affected_json="$(TURBO_SCM_BASE="$BASE" pnpm turbo run test --affected --dry=json 2>/dev/null)"; then
  if ! grep -q '"operator#test"' <<<"$affected_json"; then
    skip_operator=true
  fi
fi

if $skip_operator; then
  echo "run-unit-tests: operator app NOT affected on this PR (base=${BASE}) → skipping its vitest config."
  echo "run-unit-tests: it runs FULL on the merge_group candidate before merge (backstop)."
else
  echo "run-unit-tests: operator app affected (or oracle unavailable) → running its vitest config."
  run_operator
fi
