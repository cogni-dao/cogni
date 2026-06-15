#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Per-cell substrate gate for candidate-flight.yml (Axiom 18, LANE_ISOLATION).
#
# A matrix cell must gate on THIS node's upstream result — never the aggregate
# `needs.<job>.result`, which is the matrix rollup: any single dead-node cell
# flips the rollup to failure and blocks every healthy node's cell. The
# substrate lane already runs per-cell with `fail-fast: false`; this script
# reads the per-node marker that the upstream matrix job emits
# (<KIND>-ok-<node> artifact → <KIND>-ok-<node>.txt = "ok") and fails ONLY when
# this node was in the upstream job's matrix set and its own marker is absent
# or not "ok". A sibling node's failure can never reach this cell.
#
# Required env:
#   NODE             matrix node name for this cell
#   KIND             marker family: substrate-ok | assert-ok | appset-ok | prepare-ok
#   EXPECTED_JSON    JSON array of the upstream job's matrix nodes (the set that
#                    SHOULD have produced a marker). A node absent here had no
#                    upstream cell → pass with no marker.
#   MARKER_DIR       dir the <KIND>-ok-<node> artifact unpacked into
#
# Optional env:
#   GITHUB_OUTPUT    when set, ok=true is written here

set -euo pipefail

: "${NODE:?NODE required}"
: "${KIND:?KIND required}"
: "${EXPECTED_JSON:?EXPECTED_JSON required}"
MARKER_DIR="${MARKER_DIR:?MARKER_DIR required}"

expected=$(python3 -c 'import json, os; print("true" if os.environ["NODE"] in json.loads(os.environ["EXPECTED_JSON"] or "[]") else "false")')

if [ "$expected" != "true" ]; then
  echo "ℹ️  ${NODE} was not in the ${KIND} matrix set — no gate, passing."
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "ok=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

MARKER_FILE="${MARKER_DIR}/${KIND}-${NODE}.txt"
if [ ! -f "$MARKER_FILE" ]; then
  echo "::error::candidate-flight: ${NODE} expected a ${KIND} marker but it is absent — its upstream ${KIND} cell did not succeed."
  exit 1
fi

state=$(cat "$MARKER_FILE" 2>/dev/null || true)
if [ "$state" != "ok" ]; then
  echo "::error::candidate-flight: ${NODE} ${KIND} marker present but state='${state}' (expected 'ok')."
  exit 1
fi

echo "✅ ${NODE}: own ${KIND} marker is ok — cell may proceed."
[ -n "${GITHUB_OUTPUT:-}" ] && echo "ok=true" >> "$GITHUB_OUTPUT"
exit 0
