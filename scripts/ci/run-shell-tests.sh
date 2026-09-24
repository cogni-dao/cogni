#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/ci/run-shell-tests.sh
# Purpose: Run the hermetic scripts/ci/tests/*.test.sh suite in PARALLEL with
#          correct exit-code aggregation, replacing the ~22 serial `bash …` steps
#          that made the `unit` CI job an 8-minute monolith (task.5140). Every
#          listed test is pure-bash — mktemp + PATH-shim sandboxes, or a read-only
#          `cd REPO_ROOT` drift compare against committed files — with no network,
#          docker, or shared writable state, so they are mutually independent and
#          safe to run concurrently with each other.
# Usage:   bash scripts/ci/run-shell-tests.sh
# Exit:    0 iff EVERY test passed; 1 if any failed (a non-zero from any leg is
#          preserved — a green here means all legs were actually green).
#
# SSOT: these arrays are the authoritative wiring for the shell-test suite (it
# used to be inline in .github/workflows/ci.yaml). Gating CI on a new
# scripts/ci/tests/*.test.sh means adding it HERE, not a new workflow step
# (SCRIPTS_ARE_THE_API / CI freeze). This is an EXPLICIT list, not a glob: the
# tests/ dir also holds helpers that are `source`d by other tests
# (openbao-login-retry) and orphaned twins that must never run standalone.
#
# CONCURRENCY MODEL — two tiers, because these tests are NOT uniformly hermetic:
#   MUTATORS  — `cd $REPO_ROOT` and DESTRUCTIVELY touch tracked files (write /
#               hand-stale / `git checkout` real infra/**). Two mutators, or a
#               mutator running alongside a real-tree READER, race on the shared
#               working tree and false-fail (an in-flight staled file is observed
#               by a concurrent --check). Run these SERIALLY, first, ALONE.
#   PARALLEL  — read-only real-tree drift compares + fully mktemp-sandboxed tests.
#               Safe concurrently with EACH OTHER (reads don't mutate); only a
#               concurrent MUTATOR breaks them, which the serial-first phase
#               prevents. Verified: each passes in isolation; the only observed
#               flake was a reader racing the one mutator (render-node-overlays).
# A NEW test that writes/git-restores tracked files under $REPO_ROOT belongs in
# MUTATORS, not PARALLEL.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="$REPO_ROOT/scripts/ci/tests"

MUTATORS=(
  render-node-overlays.test.sh # hand-stales infra/k8s/overlays + `git checkout` restore
)

PARALLEL=(
  set-secret.test.sh
  openbao-clobber-proof.test.sh
  secrets-fanout.test.sh
  secret-materialize.test.sh
  reconcile-node-substrate.test.sh
  run-node-substrate.test.sh
  assert-target-substrate.test.sh
  resolve-remote-source-sha.test.sh
  compute-workload-manifest-file.test.sh
  render-caddyfile.test.sh
  db-backup-reconcile-safety.test.sh
  reconcile-edge-caddy.test.sh
  reconcile-node-dns.test.sh
  check-deploy-ref-ancestry.test.sh
  aggregate-decide-outcome.test.sh
  require-node-ref-vm.test.sh
  resolve-substrate-gate.test.sh
  detect-affected.test.sh
  classify-env-manager-fast-path.test.sh
  reconcile-scheduler-worker-routing.test.sh
  render-node-appset.test.sh
  operator-rollout-strategy.test.sh
  scheduler-runtime-routing.test.sh
)

MAX_JOBS="${SHELL_TESTS_JOBS:-$(nproc 2>/dev/null || echo 4)}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Fail loudly if a listed test is missing (drift between this SSOT and the dir),
# rather than silently skipping it — a skipped required test is a false green.
missing=0
for t in "${MUTATORS[@]}" "${PARALLEL[@]}"; do
  if [[ ! -f "$TESTS_DIR/$t" ]]; then
    echo "::error::run-shell-tests: listed test not found: scripts/ci/tests/$t"
    missing=1
  fi
done
(( missing )) && exit 1

run_one() {
  local name="$1"
  bash "$TESTS_DIR/$name" >"$tmpdir/$name.log" 2>&1
  echo $? >"$tmpdir/$name.rc"
}

# Phase 1 — mutators, serial, alone (no reader may run concurrently).
for t in "${MUTATORS[@]}"; do
  echo "run-shell-tests: [serial mutator] $t"
  run_one "$t"
done

# Phase 2 — everything else, bounded parallel.
echo "run-shell-tests: fanning out ${#PARALLEL[@]} tests, ${MAX_JOBS} at a time"
active=0
for t in "${PARALLEL[@]}"; do
  run_one "$t" &
  active=$((active + 1))
  if ((active >= MAX_JOBS)); then
    wait -n
    active=$((active - 1))
  fi
done
wait

fail=0
passed=0
total=$(( ${#MUTATORS[@]} + ${#PARALLEL[@]} ))
for t in "${MUTATORS[@]}" "${PARALLEL[@]}"; do
  rc="$(cat "$tmpdir/$t.rc" 2>/dev/null || echo 1)"
  if [[ "$rc" == "0" ]]; then
    echo "::group::✅ $t"
    cat "$tmpdir/$t.log"
    echo "::endgroup::"
    passed=$((passed + 1))
  else
    echo "::error::❌ $t failed (exit $rc)"
    echo "::group::❌ $t (exit $rc)"
    cat "$tmpdir/$t.log" 2>/dev/null || echo "(no output captured)"
    echo "::endgroup::"
    fail=1
  fi
done

echo "run-shell-tests: ${passed}/${total} passed"
(( fail )) && exit 1
exit 0
