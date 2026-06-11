#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the node-overlay renderer + drift gate (bug.5008):
#   1. Committed wizard-born overlays are in sync with the node-template overlay +
#      catalog (the drift gate that makes a stale migrate path fail CI before flight).
#   2. The renderer is byte-exact to the operator mint path (gens/overlay.ts): a
#      node minted from current main reproduces verbatim.
#   3. The node-template template overlay carries the node-at-root image layout
#      (/app/app) and the ESO secret target (<slug>-env-secrets) directly; the
#      renderer only slug/port-renames it (no path/secret rewrite).
#   4. FALSIFYING GATE: a hand-staled overlay (monorepo migrate path) makes --check
#      red. Without this, the gate could be a no-op.
#   5. Fail-closed: a node-template overlay missing the node-at-root migrate command
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
diff <(bash "$RENDER" candidate-a oss) infra/k8s/overlays/candidate-a/oss/kustomization.yaml >/dev/null \
  || fail "render candidate-a oss != committed overlay (renderer drifted from gens/overlay.ts)"
pass "candidate-a/oss render is byte-identical to committed"

echo "[3/5] render targets node-at-root layout + ESO secret"
OUT="$(bash "$RENDER" candidate-a oss)"
grep -q 'exec node /app/app/migrate.mjs /app/app/migrations' <<<"$OUT" \
  || fail "oss render missing the node-at-root Postgres migrate override"
grep -q 'exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations' <<<"$OUT" \
  || fail "oss render missing the node-at-root Doltgres migrate path"
grep -q '/app/nodes/$(NODE_NAME)/app' <<<"$OUT" \
  && fail "oss render still carries a monorepo /app/nodes/<slug>/app migrate path"
grep -q 'oss-env-secrets' <<<"$OUT" \
  || fail "oss render missing the ESO secret target oss-env-secrets"
grep -q 'oss-node-app-secrets' <<<"$OUT" \
  && fail "oss render still references the legacy oss-node-app-secrets target"
pass "oss render is node-at-root + ESO-targeted"

echo "[4/5] FALSIFYING: a hand-staled overlay turns --check red"
STALE="infra/k8s/overlays/candidate-a/oss/kustomization.yaml"
stash "$STALE"
# Revert the migrate runner to the monorepo path the stale operator shipped.
perl -0pi -e 's{/app/app/migrate-doltgres\.mjs}{/app/nodes/$(NODE_NAME)/app/migrate-doltgres.mjs}g' "$STALE"
if bash "$RENDER" --check >/dev/null 2>&1; then
  fail "--check passed on a hand-staled overlay — the drift gate is a no-op"
fi
pass "--check correctly fails on a staled migrate path"
restore; BACKUPS=()

echo "[5/5] fail-closed: a template missing the node-at-root migrate command aborts the render"
TPL="infra/k8s/overlays/candidate-a/node-template/kustomization.yaml"
stash "$TPL"
# Drop the node-at-root Postgres migrate override op (the guard's anchor).
perl -0pi -e 's{ {6}- op: replace\n {8}path: /spec/template/spec/initContainers/0/command/2\n {8}value: exec node /app/app/migrate\.mjs /app/app/migrations\n}{}' "$TPL"
if bash "$RENDER" candidate-a oss >/dev/null 2>&1; then
  fail "render emitted an overlay despite the missing node-at-root migrate command (would crash-loop)"
fi
pass "render aborts fail-closed when the migrate command is absent"
restore; BACKUPS=()

echo "PASS: render-node-overlays.test.sh"
