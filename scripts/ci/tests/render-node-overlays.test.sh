#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Tests for the node-overlay renderer (the deploy-footprint sibling of the
# Caddyfile renderer). The renderer is the keystone that turns "add a node" from
# ~193 hand-authored lines × 3 envs into one catalog-driven emit, and makes the
# candidate-a-only trap structurally impossible:
#   1. Committed managed overlays are in sync with the catalog (drift gate).
#   2. Every managed node has all three env overlays (no partial enablement —
#      the exact gap that breaks the preview promote seed).
#   3. The renderer is byte-exact against the canonical reference (canary),
#      modulo the flight-owned digest line.
#
# Run: bash scripts/ci/tests/render-node-overlays.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RENDER="scripts/ci/render-node-overlays.sh"
ENVS=(candidate-a preview production)

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

mapfile -t MANAGED < <(bash "$RENDER" --help >/dev/null 2>&1; source scripts/ci/lib/image-tags.sh; \
  for n in "${NODE_TARGETS[@]}"; do is_primary_host "$n" && continue; [ "$n" = resy ] && continue; echo "$n"; done)

echo "[1/3] managed-overlay ↔ catalog drift gate"
bash "$RENDER" --check >/dev/null \
  || fail "$RENDER --check: a committed overlay is stale (run: pnpm gen:overlays)"
pass "committed managed overlays match the catalog"

echo "[2/3] every managed node has all three env overlays (no partial enablement)"
for node in "${MANAGED[@]}"; do
  for env in "${ENVS[@]}"; do
    f="infra/k8s/overlays/$env/$node/kustomization.yaml"
    [ -f "$f" ] || fail "managed node '$node' missing $env overlay ($f) — partial enablement breaks the promote seed"
  done
  pass "$node → candidate-a + preview + production overlays present"
done

echo "[3/3] renderer is byte-exact against canary (canonical reference), modulo digest"
norm() { sed -E 's/digest: "sha256:[0-9a-f]{64}"/digest: "sha256:NORMALIZED"/'; }
for env in "${ENVS[@]}"; do
  diff <(norm <"infra/k8s/overlays/$env/canary/kustomization.yaml") \
       <(bash "$RENDER" canary "$env" | norm) >/dev/null \
    || fail "renderer output diverges from committed canary/$env overlay"
  pass "canary/$env byte-exact"
done

echo "PASS: render-node-overlays.test.sh"
