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
# FIXTURE NODE + ENV — these tests need a concrete wizard-born node as the render
# example, but must NOT hard-couple to one specific slug OR to one specific env:
# env-membership (manage-node-envs) can move ANY real node in or out of ANY env, and a
# hardcoded example (historically `poly`, then "some node in candidate-a AND production")
# turned such moves CI-red because the example's committed overlay was (correctly)
# deleted. task.5130 removed the LAST wizard-born node from candidate-a, which left the
# old "member of candidate-a and production" discovery with nothing to pick — the gates
# went red on a correct catalog edit, exactly the coupling this header already forbade.
# So BOTH halves are discovered at runtime: the example node is the first renderer-owned
# node with a catalog row and a committed overlay, and the example ENV is whichever env
# that overlay lives in. The only tree-shape assumption left is the irreducible one —
# ≥1 wizard-born node is deployed SOMEWHERE.
#
# Run: bash scripts/ci/tests/render-node-overlays.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RENDER="scripts/ci/render-node-overlays.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

# Hand-authored (non-renderer-owned) overlays — never a fixture, never pruned.
PROTECTED_NODES="operator node-template scheduler-worker"
ALL_ENVS="candidate-a preview production"

# Discover a wizard-born render example as an (env, node) PAIR: renderer-owned (not
# PROTECTED), has a catalog row, and carries a committed overlay in that env. No env is
# privileged — the loop takes whatever the catalog currently deploys, so moving the whole
# fleet out of an env (task.5130 emptied candidate-a of wizard nodes) just moves the
# fixture rather than starving it.
pick_fixture_pair() {
  local e d n
  for e in $ALL_ENVS; do
    for d in "infra/k8s/overlays/$e"/*/; do
      [ -d "$d" ] || continue
      n="$(basename "$d")"
      case " $PROTECTED_NODES " in *" $n "*) continue ;; esac
      [ -f "infra/catalog/$n.yaml" ] || continue
      echo "$e $n"
      return 0
    done
  done
  return 1
}
read -r FIXTURE_ENV FIXTURE_NODE < <(pick_fixture_pair) \
  || fail "no wizard-born node with a committed overlay found to use as the render fixture"
[ -n "${FIXTURE_ENV:-}" ] && [ -n "${FIXTURE_NODE:-}" ] \
  || fail "no wizard-born node with a committed overlay found to use as the render fixture"
echo "  (render fixture: env=$FIXTURE_ENV node=$FIXTURE_NODE)"
FE="$FIXTURE_ENV"
FN="$FIXTURE_NODE"

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

echo "[1/7] committed wizard overlays ↔ node-template + catalog drift gate"
bash "$RENDER" --check >/dev/null \
  || fail "$RENDER --check: a committed wizard overlay is stale (run: pnpm gen:node-overlays)"
pass "all wizard-born overlays match the renderer"

echo "[2/7] renderer is byte-exact to the committed mint output"
diff <(bash "$RENDER" "$FE" "$FN") "infra/k8s/overlays/$FE/$FN/kustomization.yaml" >/dev/null \
  || fail "render $FE $FN != committed overlay (renderer drifted from gens/overlay.ts)"
pass "$FE/$FN render is byte-identical to committed"

echo "[3/7] render targets node-at-root layout + ESO secret"
OUT="$(bash "$RENDER" "$FE" "$FN")"
grep -q 'exec node /app/app/migrate.mjs /app/app/migrations' <<<"$OUT" \
  || fail "$FN render missing the node-at-root Postgres migrate override"
grep -q 'exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations' <<<"$OUT" \
  || fail "$FN render missing the node-at-root Doltgres migrate path"
grep -q '/app/nodes/$(NODE_NAME)/app' <<<"$OUT" \
  && fail "$FN render still carries a monorepo /app/nodes/<slug>/app migrate path"
grep -q "$FN-env-secrets" <<<"$OUT" \
  || fail "$FN render missing the ESO secret target $FN-env-secrets"
grep -q "$FN-node-app-secrets" <<<"$OUT" \
  && fail "$FN render still references the legacy $FN-node-app-secrets target"
# The overlay also clones the node-template external-secret.yaml (the ESO PRODUCER of
# <slug>-env-secrets). Without it the pod's envFrom names a Secret nothing creates →
# CreateContainerConfigError (the fleet-wide node 502). Renderer file-arg mode emits it.
ES="$(bash "$RENDER" "$FE" "$FN" external-secret.yaml)"
grep -q "name: $FN-env-secrets" <<<"$ES" \
  || fail "$FN external-secret render missing the ESO target $FN-env-secrets"
grep -q "key: $FE/$FN" <<<"$ES" \
  || fail "$FN external-secret render missing the OpenBao key $FE/$FN"
grep -q 'node-template' <<<"$ES" \
  && fail "$FN external-secret render still carries an un-renamed node-template token"
[ -f "infra/k8s/overlays/$FE/$FN/external-secret.yaml" ] \
  || fail "$FN overlay dir is missing the committed external-secret.yaml (run: pnpm gen:node-overlays)"
pass "$FN render is node-at-root + ESO-targeted (kustomization + external-secret producer)"

echo "[4/7] FALSIFYING: a hand-staled overlay turns --check red"
STALE="infra/k8s/overlays/$FE/$FN/kustomization.yaml"
stash "$STALE"
# Revert the migrate runner to the monorepo path the stale operator shipped.
perl -0pi -e 's{/app/app/migrate-doltgres\.mjs}{/app/nodes/$(NODE_NAME)/app/migrate-doltgres.mjs}g' "$STALE"
if bash "$RENDER" --check >/dev/null 2>&1; then
  fail "--check passed on a hand-staled overlay — the drift gate is a no-op"
fi
pass "--check correctly fails on a staled migrate path"
restore; BACKUPS=()

echo "[5/7] fail-closed: a template missing the node-at-root migrate command aborts the render"
TPL="infra/k8s/overlays/$FE/node-template/kustomization.yaml"
stash "$TPL"
# Drop the node-at-root Postgres migrate override op (the guard's anchor).
perl -0pi -e 's{ {6}- op: replace\n {8}path: /spec/template/spec/initContainers/0/command/2\n {8}value: exec node /app/app/migrate\.mjs /app/app/migrations\n}{}' "$TPL"
if bash "$RENDER" "$FE" "$FN" >/dev/null 2>&1; then
  fail "render emitted an overlay despite the missing node-at-root migrate command (would crash-loop)"
fi
pass "render aborts fail-closed when the migrate command is absent"
restore; BACKUPS=()

echo "[6/7] declarative decommission: orphan overlay dir → --check red, --write prunes it"
# Simulate the fixture node's catalog row leaving by moving its catalog yaml aside;
# its committed overlay dirs become orphans. Restore the row AND any pruned overlay
# dirs from git afterward so the tree is left pristine regardless of assertion outcome.
DISPOSABLE="$FN"
DCAT="infra/catalog/$DISPOSABLE.yaml"
[ -f "$DCAT" ] || fail "test fixture: $DCAT not found"
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
for prot in $PROTECTED_NODES; do
  [ -d "infra/k8s/overlays/$FE/$prot" ] \
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
#
# The multi-env fixture is BUILT, not found. Asserting on a node that already happened
# to hold two envs made this gate a hostage of fleet shape: task.5130 took the last
# wizard node out of candidate-a, and a "find a 2-env node" discovery then had nothing
# to pick even though the renderer behaviour under test was unchanged. Joining the
# fixture to a second env and then dropping it again exercises the identical code path
# with no tree-shape precondition at all.
PERENV="$FN"
PCAT="infra/catalog/$PERENV.yaml"
[ -f "$PCAT" ] || fail "test fixture: $PCAT not found"
# The env to join-then-drop: any env with a node-template template overlay (the renderer's
# source) that the fixture does not already claim.
# ENSURE, don't DISCOVER. Picking an env the fixture "does not already claim" reintroduced
# exactly the fleet-shape hostage this block's comment says it removed: task.5132 gave poly
# all three envs and the gate went red with "already claims every renderable env" — a fixture
# precondition failing, not the renderer. Any renderable env other than $FE works, because the
# join step is only SETUP to create the orphan condition; if the fixture already claims it,
# claiming it again is a no-op.
JOIN_ENV=""
for e in $ALL_ENVS; do
  [ -d "infra/k8s/overlays/$e/node-template" ] || continue
  [ "$e" = "$FE" ] && continue
  JOIN_ENV="$e"
  break
done
[ -n "$JOIN_ENV" ] || fail "test fixture: no renderable env other than $FE to join"

perenv_restore() { git checkout -q -- "$PCAT" infra/k8s/overlays 2>/dev/null || true; }
trap 'perenv_restore; restore' EXIT
# Join the fixture to JOIN_ENV (it keeps FE), and materialize that env's overlay.
JOIN_ENV="$JOIN_ENV" yq -i '.envs = ((.envs // []) + [strenv(JOIN_ENV)] | unique)' "$PCAT"
bash "$RENDER" --write >/dev/null
[ -d "infra/k8s/overlays/$JOIN_ENV/$PERENV" ] \
  || fail "test setup: --write did not materialize $PERENV's $JOIN_ENV overlay"
bash "$RENDER" --check >/dev/null \
  || fail "test setup: --check red right after materializing $PERENV's $JOIN_ENV overlay"
# Drop JOIN_ENV again (the fixture stays in FE) — the env-membership verb's edit.
JOIN_ENV="$JOIN_ENV" yq -i '.envs -= [strenv(JOIN_ENV)]' "$PCAT"
yq -e ".envs // [] | contains([\"$JOIN_ENV\"])" "$PCAT" >/dev/null 2>&1 \
  && fail "test setup: failed to drop $JOIN_ENV from $PERENV envs"
# a: the node still carries a committed JOIN_ENV overlay it no longer claims → orphan → --check red.
if bash "$RENDER" --check >/dev/null 2>&1; then
  fail "--check passed while $PERENV carried a $JOIN_ENV overlay it no longer claims (orphan not caught)"
fi
# b: --write prunes ONLY the dropped env's overlay; the retained envs keep theirs.
bash "$RENDER" --write >/dev/null
[ ! -d "infra/k8s/overlays/$JOIN_ENV/$PERENV" ] \
  || fail "--write did not prune $PERENV's dropped $JOIN_ENV overlay"
[ -d "infra/k8s/overlays/$FE/$PERENV" ] \
  || fail "--write wrongly pruned $PERENV's $FE overlay (still a member)"
# c: with the node out of JOIN_ENV and its overlay gone, --check is GREEN — the
#    old wizard_nodes × ENVS cartesian would fail here with "missing overlay".
bash "$RENDER" --check >/dev/null \
  || fail "--check red after a clean per-env removal (the wizard_nodes × ENVS cartesian bug)"
pass "per-env removal prunes only the dropped env's overlay; retained envs kept; --check green"
perenv_restore
trap restore EXIT
bash "$RENDER" --check >/dev/null || fail "tree not pristine after per-env test"
pass "tree restored pristine after per-env test"

echo "PASS: render-node-overlays.test.sh"
