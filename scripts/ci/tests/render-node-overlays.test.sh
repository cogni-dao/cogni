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
#   6. Declarative decommission (story.5020 W3): a renderer-owned overlay dir whose
#      catalog row has left turns --check red, and --write prunes it — while the
#      hand-authored (operator/node-template/scheduler-worker) overlays are never
#      touched. Without this, a decommissioned node leaks orphan overlay config.
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

echo "[6/6] declarative decommission: orphan overlay dir → --check red, --write prunes it"
# Pick a disposable wizard-born node and simulate its catalog row leaving by
# moving the catalog yaml aside. Its committed overlay dirs become orphans.
# Restore the catalog row AND any pruned overlay dirs from git afterward so the
# tree is left pristine regardless of assertion outcome.
DISPOSABLE="games"
DCAT="infra/catalog/$DISPOSABLE.yaml"
[ -f "$DCAT" ] || fail "test fixture: $DCAT not found (pick another disposable wizard node)"
DTMP="$(mktemp)"
decommission_restore() {
  [ -f "$DCAT" ] || { [ -f "$DTMP" ] && mv "$DTMP" "$DCAT"; }
  # Any overlay dirs --write pruned (or catalog yaml) come back from the index.
  git checkout -q -- "$DCAT" infra/k8s/overlays 2>/dev/null || true
}
trap 'decommission_restore; restore' EXIT
cp "$DCAT" "$DTMP"
mv "$DCAT" "$DCAT.decommissioned"  # row leaves the catalog
# Sub-assertion a: orphan overlay dirs make --check red (drift gate catches it).
if bash "$RENDER" --check >/dev/null 2>&1; then
  mv "$DCAT.decommissioned" "$DCAT"
  fail "--check passed with orphan overlay dirs for a decommissioned node — prune gate is a no-op"
fi
# Sub-assertion b: --write prunes the orphan dirs and leaves protected dirs intact.
bash "$RENDER" --write >/dev/null
mv "$DCAT.decommissioned" "$DCAT"  # the row never really left; this was a sim
for env in candidate-a preview production; do
  [ ! -d "infra/k8s/overlays/$env/$DISPOSABLE" ] \
    || fail "--write did not prune the orphan overlay dir infra/k8s/overlays/$env/$DISPOSABLE"
done
for prot in operator node-template scheduler-worker; do
  [ -d "infra/k8s/overlays/candidate-a/$prot" ] \
    || fail "--write WRONGLY pruned the protected hand-authored overlay $prot"
done
pass "orphan overlay dirs are flagged by --check and pruned by --write; protected overlays untouched"
# Restore the catalog yaml + pruned overlay dirs from git so the tree is pristine.
decommission_restore
bash "$RENDER" --check >/dev/null \
  || fail "tree not pristine after decommission test (restore failed)"
trap restore EXIT
pass "tree restored pristine after decommission test"

echo "[7/7] ATOMIC_PER_ENV: a node dropping ONE env prunes only that env's overlay; --check green"
# Regression for story.5020 W4: render-node-overlays used to loop wizard_nodes ×
# ENVS unconditionally (CANDIDATE_A_ALWAYS), so the env-membership verb removing a
# node from ONE env left --check demanding the (correctly-deleted) overlay. The
# fix filters by per-node `envs:` (wizard_nodes_for_env).
PERENV="games"
PCAT="infra/catalog/$PERENV.yaml"
[ -f "$PCAT" ] || fail "test fixture: $PCAT not found (pick another disposable wizard node)"
perenv_restore() { git checkout -q -- "$PCAT" infra/k8s/overlays 2>/dev/null || true; }
trap 'perenv_restore; restore' EXIT
# Drop candidate-a from games' envs (it stays in preview + production).
perl -0pi -e 's/^(envs:\s*\[)\s*candidate-a\s*,\s*/$1/m' "$PCAT"
grep -qE '^envs:\s*\[\s*preview\s*,\s*production\s*\]' "$PCAT" \
  || fail "test setup: failed to drop candidate-a from games' envs (unexpected envs shape)"
# a: games still carries a committed candidate-a overlay it no longer claims → orphan → --check red.
if bash "$RENDER" --check >/dev/null 2>&1; then
  fail "--check passed while games carried a candidate-a overlay it no longer claims (orphan not caught)"
fi
# b: --write prunes ONLY the dropped env's overlay; the retained envs keep theirs.
bash "$RENDER" --write >/dev/null
[ ! -d "infra/k8s/overlays/candidate-a/$PERENV" ] \
  || fail "--write did not prune games' dropped candidate-a overlay"
[ -d "infra/k8s/overlays/preview/$PERENV" ] \
  || fail "--write wrongly pruned games' preview overlay (still a member)"
[ -d "infra/k8s/overlays/production/$PERENV" ] \
  || fail "--write wrongly pruned games' production overlay (still a member)"
# c: with games out of candidate-a and its overlay gone, --check is GREEN — the
#    old wizard_nodes × ENVS cartesian would fail here with "missing overlay".
bash "$RENDER" --check >/dev/null \
  || fail "--check red after a clean per-env removal (the wizard_nodes × ENVS cartesian bug)"
pass "per-env removal prunes only the dropped env's overlay; retained envs kept; --check green"
perenv_restore
trap restore EXIT
bash "$RENDER" --check >/dev/null || fail "tree not pristine after per-env test"
pass "tree restored pristine after per-env test"

echo "PASS: render-node-overlays.test.sh"
