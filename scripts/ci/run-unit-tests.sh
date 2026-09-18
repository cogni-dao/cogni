#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/ci/run-unit-tests.sh
# Purpose: Run the unit/contract vitest suites with MODULE-GRAPH affected-scoping
#   on PRs and FULL scope on merge_group/push (task.5140 Stage B+C /
#   AFFECTED_ONLY_CI). Two disjoint vitest universes:
#
#     ROOT config (`vitest run`) — tests/** + packages/*/tests + services/*/tests
#       (ci-invariants, catalog SSoT specs, arch, all package/service unit tests).
#       ALWAYS runs full. Many of these are coupled to their triggers by
#       filesystem read (readFileSync/glob of catalog/manifests/docs), NOT by
#       import — invisible to any import-graph affected selector — so running the
#       full root suite on every PR is the deliberate safety floor. It's ~89s.
#
#     OPERATOR app config — the expensive half (~177s CI). On a PR it runs via
#       vitest's native `--changed <base>`: vitest walks the IMPORT graph and
#       runs ONLY the operator test files transitively reaching a file changed vs
#       <base> (test-level affected, not the coarse whole-package selection of
#       Stage B's turbo oracle). It selects nothing — a fast pass — when the
#       operator app is unaffected. On merge_group / push:main it runs FULL.
#
# Safety: `--changed` can only UNDER-select on a PR (never over-select), and the
# blind spot is fs-coupled (non-import) tests. Both are covered by the merge_group
# FULL run — the required `unit` check re-runs the complete suite on the
# merge-queue candidate, so any PR-time under-selection is caught before merge.
# PR-time `--changed` is therefore a FAST SIGNAL, never the merge gate. If <base>
# does not resolve we fall back to a FULL operator run (never a partial one).
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

# PR: module-graph affected selection via vitest --changed. Fall back to a FULL
# operator run if the base ref can't be resolved — never trust a partial signal
# built on a broken base (a red job from a genuine test failure is preserved;
# only base-resolution failure triggers the fallback).
if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "run-unit-tests: base '${BASE}' unresolvable → FULL operator run (fail-safe)"
  run_operator
  exit 0
fi

echo "::group::run-unit-tests: operator app config — vitest --changed ${BASE} (module-graph affected)"
echo "run-unit-tests: runs only operator tests importing a file changed vs ${BASE};"
echo "run-unit-tests: 0 selected = operator unaffected (fast pass). FULL suite re-runs on merge_group (backstop)."
pnpm exec vitest run --config nodes/operator/app/vitest.config.mts --changed "${BASE}" --passWithNoTests
echo "::endgroup::"
