#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/verify-buildsha.test.sh
#
# Regression harness for task.0341 + task.0345 + task.0349. Covers the polling
# loop that replaces the single-shot curl-per-node (task.0341, false-failed
# during rollout cutover) AND the pivot from `/readyz.version` →
# `/version.buildSha` as the authoritative build-identity probe (task.0345 /
# PR #978) AND map-mode NODES restriction (task.0349 / affected-only verify).
#
# Cases:
#   1. Converges after N failed attempts  → exits 0 (polling succeeds).
#   2. Never converges within timeout     → exits 1 (fails loudly, no masking).
#   3. Expected SHA matches on first try  → exits 0 fast (no regression on happy path).
#   4. Response carries `.version` (pkg ver) but no `.buildSha` → fails (we do
#      NOT silently accept the pkg-version field; only `.buildSha` is the SHA).
#   5. Map lists multiple apps but NODES restricts verify to one → only that
#      app is probed (poly-only path; operator map entry must not force a curl).
#   6. NODES lists an app missing from the map → exits 1 with a clear error.
#
# The verify-buildsha.sh under test is shelled via a CURL_CMD injection
# pointing to a fixture script under /tmp, so no real HTTPS endpoint is needed.
#
# Run: bash scripts/ci/tests/verify-buildsha.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERIFY_SCRIPT="${CI_DIR}/verify-buildsha.sh"

if [ ! -f "$VERIFY_SCRIPT" ]; then
  echo "[FAIL] verify-buildsha.sh not found at $VERIFY_SCRIPT" >&2
  exit 1
fi

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

EXPECTED="abcdef0123456789abcdef0123456789abcdef01"
STALE="0000000000000000000000000000000000000000"

# Build a fake curl that returns body based on an attempt counter file.
# Usage: fake_curl <fixture-dir> — on each invocation reads/advances counter,
# returns $fixture/<n>.json (or last available file).
make_fake_curl() {
  local dir="$1"
  local script="${TMPROOT}/curl-${RANDOM}.sh"
  cat >"$script" <<EOF
#!/usr/bin/env bash
counter_file="${dir}/.counter"
if [ ! -f "\$counter_file" ]; then echo 0 > "\$counter_file"; fi
n=\$(cat "\$counter_file")
n=\$((n + 1))
echo "\$n" > "\$counter_file"
fixture="${dir}/\${n}.json"
if [ ! -f "\$fixture" ]; then
  # Fall back to the last available fixture
  fixture=\$(ls "${dir}"/*.json 2>/dev/null | sort -V | tail -n 1)
fi
if [ -n "\$fixture" ] && [ -f "\$fixture" ]; then
  cat "\$fixture"
fi
EOF
  chmod +x "$script"
  echo "$script"
}

run_case() {
  local label="$1" fixture_dir="$2" expected_exit="$3" timeout="${4:-10}" sleep_sec="${5:-1}"
  local fake_curl
  fake_curl=$(make_fake_curl "$fixture_dir")

  local map_file="${TMPROOT}/map-${RANDOM}.json"
  cat >"$map_file" <<EOF
{ "operator": "${EXPECTED}" }
EOF

  set +e
  CURL_CMD="$fake_curl" \
    CUTOVER_TIMEOUT="$timeout" CUTOVER_SLEEP="$sleep_sec" \
    DOMAIN="example.test" SOURCE_SHA_MAP="$map_file" \
    bash "$VERIFY_SCRIPT" >"${TMPROOT}/out-${label}.log" 2>&1
  local actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "[FAIL] ${label}: expected exit ${expected_exit}, got ${actual_exit}"
    echo "--- output ---"
    cat "${TMPROOT}/out-${label}.log"
    return 1
  fi
  echo "[PASS] ${label}"
}

# --- Case 1: converges on 3rd attempt ---
DIR1=$(mktemp -d --tmpdir="$TMPROOT" case1.XXXX)
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$STALE"    >"${DIR1}/1.json"
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$STALE"    >"${DIR1}/2.json"
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$EXPECTED" >"${DIR1}/3.json"
run_case "converges-on-3rd" "$DIR1" 0 10 1 || exit 1

# --- Case 2: never converges → fails loudly ---
DIR2=$(mktemp -d --tmpdir="$TMPROOT" case2.XXXX)
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$STALE" >"${DIR2}/1.json"
run_case "timeout-fails-loudly" "$DIR2" 1 3 1 || exit 1

# --- Case 3: matches on first attempt (happy path, no regression) ---
DIR3=$(mktemp -d --tmpdir="$TMPROOT" case3.XXXX)
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$EXPECTED" >"${DIR3}/1.json"
run_case "matches-first-try" "$DIR3" 0 10 1 || exit 1

# --- Case 4: response has pkg-version but no buildSha → fails (do NOT
# fall back to `.version`, which carries npm package version on /version). ---
DIR4=$(mktemp -d --tmpdir="$TMPROOT" case4.XXXX)
printf '{"version":"%s","buildTime":"t"}' "$EXPECTED" >"${DIR4}/1.json"
run_case "no-buildSha-field-fails" "$DIR4" 1 3 1 || exit 1

# --- Case 5: map has operator + node-template; NODES=node-template → operator must not be probed ---
# If verify ignored NODES, it would expect operator=STALE while fake curl always
# returns EXPECTED → timeout failure.
DIR5=$(mktemp -d --tmpdir="$TMPROOT" case5.XXXX)
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$EXPECTED" >"${DIR5}/1.json"
fake5=$(make_fake_curl "$DIR5")
map5="${TMPROOT}/map5.json"
cat >"$map5" <<EOF
{ "operator": "${STALE}", "node-template": "${EXPECTED}" }
EOF
set +e
CURL_CMD="$fake5" CUTOVER_TIMEOUT=10 CUTOVER_SLEEP=1 \
  DOMAIN="example.test" SOURCE_SHA_MAP="$map5" NODES="node-template" \
  bash "$VERIFY_SCRIPT" >"${TMPROOT}/out-case5.log" 2>&1
ex5=$?
set -e
if [ "$ex5" -ne 0 ]; then
  echo "[FAIL] map+NODES=node-template: expected exit 0, got ${ex5}"
  cat "${TMPROOT}/out-case5.log"
  exit 1
fi
echo "[PASS] map-restricted-to-NODES-node-template-only"

# --- Case 6: NODES lists app absent from map → fail fast ---
DIR6=$(mktemp -d --tmpdir="$TMPROOT" case6.XXXX)
printf '{"version":"0.1.0","buildSha":"%s","buildTime":"t"}' "$EXPECTED" >"${DIR6}/1.json"
fake6=$(make_fake_curl "$DIR6")
map6="${TMPROOT}/map6.json"
cat >"$map6" <<EOF
{ "operator": "${EXPECTED}" }
EOF
set +e
CURL_CMD="$fake6" CUTOVER_TIMEOUT=3 CUTOVER_SLEEP=1 \
  DOMAIN="example.test" SOURCE_SHA_MAP="$map6" NODES="ghostapp" \
  bash "$VERIFY_SCRIPT" >"${TMPROOT}/out-case6.log" 2>&1
ex6=$?
set -e
if [ "$ex6" -eq 0 ]; then
  echo "[FAIL] NODES-not-in-map: expected non-zero exit"
  cat "${TMPROOT}/out-case6.log"
  exit 1
fi
if ! grep -q 'SOURCE_SHA_MAP has no entry' "${TMPROOT}/out-case6.log"; then
  echo "[FAIL] NODES-not-in-map: expected error text about map entry"
  cat "${TMPROOT}/out-case6.log"
  exit 1
fi
echo "[PASS] NODES-missing-from-map-fails"

echo ""
echo "✅ verify-buildsha.test.sh — all cases passed"
