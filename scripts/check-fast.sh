#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/check-fast.sh
# Purpose: Lightweight quality gate for iterative development.
#          Package prebuilds, workspace typecheck, lint, format, docs, and tests.
# Modes:
#   default (strict) — uses :check variants; fails loudly on drift; no side effects on lint/format.
#   --fix            — auto-fixes lint and format; still fails if drift remains afterward.
# Usage: pnpm check:fast            # Strict: verify-only, no mutation (pre-push gate)
#        pnpm check:fast:fix        # Auto-fix lint/format, then verify no drift remains
#        pnpm check:fast:verbose    # Strict + full banners + live streaming output
#        Direct: bash scripts/check-fast.sh [--fix] [--verbose]
# Exit: 0 if all checks pass and no drift; 1 otherwise
# Side-effects:
#   strict mode — check tasks should not mutate files; drift check catches surprise writes.
#   --fix mode — ESLint/Biome and Prettier may rewrite files.

set +e
set -o pipefail
set -u

EXIT_CODE=0
FAILED_CHECKS=()
VERBOSE=false
FIX_MODE=false

FAILED_NAMES=()
FAILED_OUTPUTS=()

for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=true ;;
    --fix) FIX_MODE=true ;;
  esac
done

# Snapshot a content-level hash of the working tree before checks run so the final
# drift comparison flags mutations caused by this script — not the developer's WIP edits.
# We hash tracked-file diff output + untracked file contents; identical hashes = no mutation.
compute_tree_hash() {
  {
    git diff HEAD 2>/dev/null
    git ls-files --others --exclude-standard -z 2>/dev/null \
      | while IFS= read -r -d '' file; do
          printf "%s\0" "$file"
          [ -f "$file" ] && cat "$file"
        done
  } | shasum 2>/dev/null | awk '{print $1}'
}

INITIAL_HASH=""
DRIFT_DETECTION=true
if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  DRIFT_DETECTION=false
elif ! command -v shasum >/dev/null 2>&1; then
  echo "warning: shasum not found; drift detection disabled" >&2
  DRIFT_DETECTION=false
else
  INITIAL_HASH=$(compute_tree_hash)
fi

run_check() {
  local name=$1
  local command=$2
  local start=$(date +%s)

  if [ "$VERBOSE" = true ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Running $name..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if eval "$command"; then
      local duration=$(($(date +%s) - start))
      echo ""
      echo "✓ $name passed (${duration}s)"
    else
      EXIT_CODE=1
      local duration=$(($(date +%s) - start))
      FAILED_CHECKS+=("$name (${duration}s)")
      echo ""
      echo "✗ $name failed (${duration}s)"
    fi
  else
    local output
    output=$(eval "$command" 2>&1)
    local status=$?
    local duration=$(($(date +%s) - start))

    if [ $status -eq 0 ]; then
      echo "✓ $name passed (${duration}s)"
    else
      EXIT_CODE=1
      FAILED_CHECKS+=("$name (${duration}s)")
      FAILED_NAMES+=("$name")
      FAILED_OUTPUTS+=("$output")
      echo "✗ $name failed (${duration}s)"
    fi
  fi
}

if [ "$VERBOSE" = true ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if [ "$FIX_MODE" = true ]; then
    echo "Starting fast checks (auto-fix enabled)..."
  else
    echo "Starting fast checks (strict, no mutation)..."
  fi
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

# Refresh only the package declarations needed for affected workspace checks.
# Runtime tests resolve workspace packages from source; CI and explicit
# `pnpm packages:build` own JavaScript artifact validation.
run_check "packages:types" "node scripts/run-scoped-package-build.mjs"

# In --fix mode, run lint and prettier auto-fix as a pre-pass so the verify-only turbo run
# below sees the auto-fixed tree (lint:fix mutates files; turbo would cache stale state otherwise).
if [ "$FIX_MODE" = true ]; then
  run_check "lint:fix" "pnpm lint:fix"
  run_check "format" "pnpm format"
fi

# One turbo invocation drives all parallel-safe checks: per-package lint + typecheck + test,
# plus root-level //#lint, //#format:check, //#db:check (defined in turbo.json).
# Vitest resolves workspace graph wrappers from source so stale ignored dist does
# not affect app tests.
# All participate in the same DAG so Turbo can schedule across the whole graph and cache per
# task hash. Re-runs on no-change hit cache in <1s per task.
#
# --concurrency=50% bounds parallelism to half the CPU count to prevent vitest fork-pool
# exhaustion (the original reason for --concurrency=1 — see commit 42b2b432b). Scales with
# hardware: 8-core dev → 4 parallel; 4-core CI → 2 parallel; 16-core → 8.
run_check "workspace" "bash scripts/run-turbo-checks.sh lint typecheck test format:check db:check --concurrency=50%"

# check:docs stays outside the turbo graph for now; it validates repository docs metadata
# and AGENTS.md coverage independently from workspace package checks.
run_check "check:docs" "pnpm -s check:docs"

# Drift check — flag any content-level mutation caused *by this script* (ignore pre-existing WIP).
# In strict mode this catches surprise writes from verify-only checks.
# In --fix mode this catches auto-fix producing changes the developer hasn't staged yet.
DRIFTED=false
if [ "$DRIFT_DETECTION" = true ]; then
  FINAL_HASH=$(compute_tree_hash)
  if [ "$INITIAL_HASH" != "$FINAL_HASH" ]; then
    EXIT_CODE=1
    FAILED_CHECKS+=("drift: files modified during checks")
    echo "✗ drift: files modified during checks"
    DRIFTED=true
  fi
fi

if [ "$VERBOSE" = true ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "SUMMARY"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

if [ ${#FAILED_CHECKS[@]} -eq 0 ]; then
  echo "✓ All fast checks passed!"
else
  echo "✗ ${#FAILED_CHECKS[@]} check(s) failed:"
  for check in "${FAILED_CHECKS[@]}"; do
    echo "  - $check"
  done
fi

if [ "$VERBOSE" = true ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

if [ "$VERBOSE" = false ] && [ ${#FAILED_NAMES[@]} -gt 0 ]; then
  TAIL_LINES=${CHECK_FAST_TAIL:-60}
  echo ""
  for i in "${!FAILED_NAMES[@]}"; do
    total=$(printf '%s\n' "${FAILED_OUTPUTS[$i]}" | wc -l | tr -d ' ')
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if [ "$total" -gt "$TAIL_LINES" ]; then
      omitted=$((total - TAIL_LINES))
      echo "Output from failed check: ${FAILED_NAMES[$i]} — last ${TAIL_LINES}/${total} lines (${omitted} earlier omitted; --verbose or CHECK_FAST_TAIL=N for more)"
    else
      echo "Output from failed check: ${FAILED_NAMES[$i]} — ${total} lines"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%s\n' "${FAILED_OUTPUTS[$i]}" | tail -n "$TAIL_LINES"
    echo ""
  done
fi

# If drift was detected, surface current `git status` so the developer can see the dirty state.
if [ "$DRIFTED" = true ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Working tree mutated by this run. Current git status:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  git status --short
  echo ""
  if [ "$FIX_MODE" = true ]; then
    echo "Auto-fix produced changes. Review, stage, commit them, then re-run."
  else
    echo "Strict mode mutated files."
    echo "Run \`pnpm check:fast:fix\` to apply fixes, then commit and re-run \`pnpm check:fast\`."
  fi
fi

exit $EXIT_CODE
