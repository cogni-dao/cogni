#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the k8s NodePort allocator + uniqueness gate (next-free-node-port.sh).
#   1. --check passes on the committed catalog (node_port is unique today).
#   2. next-free returns max(node_port)+100, preserving the ~x00 stride.
#   3. --check FAILS (non-zero) on a deliberate duplicate node_port — the
#      cross-file uniqueness JSON-schema can't express. This is the gate that
#      stops two nodes silently sharing a per-VM NodePort.
#
# The script reads the catalog via COGNI_CATALOG_ROOT (image-tags.sh honours it),
# so the duplicate case runs against a throwaway catalog copy — the committed
# infra/catalog/*.yaml is never mutated.
#
# Run: bash scripts/ci/tests/next-free-node-port.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

ALLOCATOR="$REPO_ROOT/scripts/ci/next-free-node-port.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

echo "[1/3] --check passes on the committed catalog"
bash "$ALLOCATOR" --check >/dev/null \
  || fail "--check flagged the committed catalog as having duplicate node_port"
pass "committed catalog node_port values are unique"

echo "[2/3] next-free returns max(node_port)+100"
# Derive the expectation from the catalog itself so the test never goes stale
# when a node is added/removed.
max="$(yq -N '.node_port // ""' infra/catalog/*.yaml | grep -E '^[0-9]+$' | sort -n | tail -1)"
[ -n "$max" ] || fail "could not derive max node_port from catalog"
expected=$((max + 100))
actual="$(bash "$ALLOCATOR")"
[ "$actual" = "$expected" ] \
  || fail "allocator returned $actual; expected max($max)+100=$expected"
pass "allocator → $actual (= max $max + 100)"

echo "[3/3] --check FAILS on a deliberate duplicate node_port"
TMP_CATALOG="$(mktemp -d)"
trap 'rm -rf "$TMP_CATALOG"' EXIT
cp infra/catalog/*.yaml "$TMP_CATALOG/"
# Mint a colliding type:node entry sharing operator's node_port (30000).
clash="$(yq -N '.node_port' infra/catalog/operator.yaml)"
yq '.name = "dupe-collision" | .node_port = '"$clash" \
  infra/catalog/node-template.yaml > "$TMP_CATALOG/dupe-collision.yaml"
if COGNI_CATALOG_ROOT="$TMP_CATALOG" bash "$ALLOCATOR" --check >/dev/null 2>&1; then
  fail "--check passed despite a duplicate node_port=$clash (uniqueness gate broken)"
fi
pass "--check rejected the duplicate node_port=$clash"

echo "PASS: next-free-node-port.test.sh"
