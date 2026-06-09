#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the node-overlay renderer + drift gate (bug.5008):
#   1. Committed wizard-born overlays are in sync with the node-template overlay +
#      catalog (the drift gate that makes a stale migrate path fail CI before flight).
#   2. The renderer is byte-exact to the operator mint path (gens/overlay.ts): a
#      node minted from current main reproduces verbatim.
#   3. The render targets the node-at-root image layout (/app/app) and the ESO
#      secret target (<slug>-env-secrets) — the two rewrites a stale operator froze
#      to the wrong values.
#   4. FALSIFYING GATE: a hand-staled overlay (monorepo migrate path) makes --check
#      red. Without this, the gate could be a no-op.
#   5. Fail-closed: a node-template overlay missing the migrate secret-ref anchor
#      aborts the render instead of emitting a silently-crash-looping overlay.
#
# Run: bash scripts/ci/tests/render-node-overlays.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RENDER="scripts/ci/render-node-overlays.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

# Restore any file we mutate in-place, even on a failed assertion.
BACKUPS=()
restore() {
  local entry path bak
  for entry in "${BACKUPS[@]:-}"; do
    [ -n "$entry" ] || continue
    path="${entry%%::*}"
    bak="${entry##*::}"
    mv "$bak" "$path"
  done
}
trap restore EXIT
stash() {
  local path="$1" bak
  bak="$(mktemp)"
  cp "$path" "$bak"
  BACKUPS+=("$path::$bak")
}

echo "[1/5] committed wizard overlays ↔ node-template + catalog drift gate"
bash "$RENDER" --check >/dev/null \
  || fail "$RENDER --check: a committed wizard overlay is stale (run: pnpm gen:node-overlays)"
pass "all wizard-born overlays match the renderer"

echo "[2/5] renderer is byte-exact to the committed mint output"
diff <(bash "$RENDER" candidate-a please) infra/k8s/overlays/candidate-a/please/kustomization.yaml >/dev/null \
  || fail "render candidate-a please != committed overlay (renderer drifted from gens/overlay.ts)"
pass "candidate-a/please render is byte-identical to committed"

echo "[3/5] render targets node-at-root layout + ESO secret"
OUT="$(bash "$RENDER" candidate-a ayo)"
grep -q 'exec node /app/app/migrate.mjs /app/app/migrations' <<<"$OUT" \
  || fail "ayo render missing the node-at-root Postgres migrate override"
grep -q 'exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations' <<<"$OUT" \
  || fail "ayo render missing the node-at-root Doltgres migrate path"
grep -q '/app/nodes/$(NODE_NAME)/app' <<<"$OUT" \
  && fail "ayo render still carries a monorepo /app/nodes/<slug>/app migrate path"
grep -q 'ayo-env-secrets' <<<"$OUT" \
  || fail "ayo render missing the ESO secret target ayo-env-secrets"
grep -q 'ayo-node-app-secrets' <<<"$OUT" \
  && fail "ayo render still references the legacy ayo-node-app-secrets target"
pass "ayo render is node-at-root + ESO-targeted"

echo "[4/5] FALSIFYING: a hand-staled overlay turns --check red"
STALE="infra/k8s/overlays/candidate-a/ayo/kustomization.yaml"
stash "$STALE"
# Revert the migrate runner to the monorepo path the stale operator shipped.
perl -0pi -e 's{/app/app/migrate-doltgres\.mjs}{/app/nodes/$(NODE_NAME)/app/migrate-doltgres.mjs}g' "$STALE"
if bash "$RENDER" --check >/dev/null 2>&1; then
  fail "--check passed on a hand-staled overlay — the drift gate is a no-op"
fi
pass "--check correctly fails on a staled migrate path"
restore; BACKUPS=()

echo "[5/5] fail-closed: a template missing the migrate anchor aborts the render"
TPL="infra/k8s/overlays/candidate-a/node-template/kustomization.yaml"
stash "$TPL"
# Drop the migrate initContainer secret-ref patch (the injection anchor).
perl -0pi -e 's{ {6}- op: replace\n {8}path: /spec/template/spec/initContainers/0/envFrom/1/secretRef/name\n {8}value: [^\n]*\n}{}' "$TPL"
if bash "$RENDER" candidate-a ayo >/dev/null 2>&1; then
  fail "render emitted an overlay despite the missing migrate anchor (would crash-loop)"
fi
pass "render aborts fail-closed when the anchor is absent"
restore; BACKUPS=()

echo "PASS: render-node-overlays.test.sh"
