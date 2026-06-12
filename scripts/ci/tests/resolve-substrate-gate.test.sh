#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Per-cell substrate gate (Axiom 18, LANE_ISOLATION): a healthy node's cell
# proceeds on its OWN marker; a sibling node's failure (its marker absent) is
# irrelevant; a node that owes a marker but lacks one fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPT="${CI_DIR}/resolve-substrate-gate.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 1. Node not in the upstream matrix set → pass with no marker (e.g. a flight
#    target that needed no substrate).
NODE=svc KIND=assert-ok EXPECTED_JSON='["poly"]' MARKER_DIR="$WORKDIR/none" \
  bash "$SCRIPT" >/dev/null || fail "non-substrate node should pass"

# 2. Empty substrate set → pass.
NODE=operator KIND=assert-ok EXPECTED_JSON='[]' MARKER_DIR="$WORKDIR/none" \
  bash "$SCRIPT" >/dev/null || fail "empty substrate set should pass"

# 3. Substrate node with own ok marker → pass, even when a sibling's marker is
#    absent (the isolation case: sibling resy failed, poly proceeds).
mkdir -p "$WORKDIR/iso"
printf 'ok' > "$WORKDIR/iso/assert-ok-poly.txt"
NODE=poly KIND=assert-ok EXPECTED_JSON='["poly","resy"]' MARKER_DIR="$WORKDIR/iso" \
  bash "$SCRIPT" >/dev/null || fail "node with own ok marker should pass despite absent sibling marker"

# 4. Substrate node whose own marker is absent → fail-closed.
if NODE=resy KIND=assert-ok EXPECTED_JSON='["poly","resy"]' MARKER_DIR="$WORKDIR/iso" \
  bash "$SCRIPT" >/dev/null 2>&1; then
  fail "node missing its own marker must fail"
fi

# 5. Marker present but not "ok" → fail-closed.
mkdir -p "$WORKDIR/bad"
printf 'failure' > "$WORKDIR/bad/substrate-ok-poly.txt"
if NODE=poly KIND=substrate-ok EXPECTED_JSON='["poly"]' MARKER_DIR="$WORKDIR/bad" \
  bash "$SCRIPT" >/dev/null 2>&1; then
  fail "non-ok marker must fail"
fi

# 6. GITHUB_OUTPUT receives ok=true on pass.
NODE=poly KIND=assert-ok EXPECTED_JSON='["poly","resy"]' MARKER_DIR="$WORKDIR/iso" \
  GITHUB_OUTPUT="$WORKDIR/gh.out" bash "$SCRIPT" >/dev/null
grep -qx 'ok=true' "$WORKDIR/gh.out" || fail "GITHUB_OUTPUT should carry ok=true"

echo "resolve-substrate-gate.test.sh OK"
