#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the per-env node-set gate (task.5017):
#   1. deploy ⊆ provisioned: each env renders only the nodes whose catalog
#      `envs:` list includes it. preview is the minimal backbone
#      (operator + scheduler-worker); candidate-a + production carry every
#      deployable node.
#   2. SCHEDULER_WITH_OPERATOR: any env that deploys operator also deploys
#      scheduler-worker (operator /readyz hard-depends on :9000).
#   3. CANDIDATE_A_ALWAYS: every deployable node lists candidate-a.
#   4. DETERMINISM: repeated --check is stable (guards the `yq | grep -q`
#      SIGPIPE-under-pipefail bug that silently dropped matching nodes).
#   5. FAIL-CLOSED: a deployable row missing `envs:` aborts the render rather
#      than silently fanning the node out to every env.
#
# Run: bash scripts/ci/tests/render-node-appset.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RENDER="scripts/ci/render-node-appset.sh"
ARGOCD_DIR="infra/k8s/argocd"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

# Slugs rendered for $1 (env), sorted, from the committed AppSet files.
appsets_for_env() {
  local env="$1" f base
  for f in "$ARGOCD_DIR/$env"-*-applicationset.yaml; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    base="${base#"$env"-}"
    printf '%s\n' "${base%-applicationset.yaml}"
  done | LC_ALL=C sort
}

# All deployable node slugs (catalog rows with a candidate_a_branch), sorted.
all_deployable() {
  local f
  for f in infra/catalog/*.yaml; do
    [ "$(yq -r '.candidate_a_branch // ""' "$f")" != "" ] || continue
    yq -r '.name' "$f"
  done | LC_ALL=C sort
}

# 0. Committed files match the catalog (the live drift gate, run here too).
bash "$RENDER" --check >/dev/null || fail "committed AppSets are out of sync with the catalog"
pass "committed AppSets in sync (--check green)"

# 1. preview is the minimal backbone.
preview="$(appsets_for_env preview | paste -sd, -)"
[ "$preview" = "operator,scheduler-worker" ] \
  || fail "preview node-set should be operator,scheduler-worker — got '$preview'"
pass "preview node-set is minimal backbone ($preview)"

# 1b. candidate-a is the full test slot — every deployable node is candidate-flightable
# there (CANDIDATE_A_ALWAYS, the pre-merge validation gate). preview + production are the
# lean backbone; a node opts into production only once it is proven on candidate-a.
candidatea="$(appsets_for_env candidate-a | paste -sd, -)"
deployable="$(all_deployable | paste -sd, -)"
[ "$candidatea" = "$deployable" ] \
  || fail "candidate-a node-set should equal all deployable ($deployable) — got '$candidatea'"
pass "candidate-a is the full test slot ($candidatea)"
got="$(appsets_for_env production | paste -sd, -)"
[ "$got" = "operator,scheduler-worker" ] \
  || fail "production node-set should be operator,scheduler-worker — got '$got'"
pass "production is the lean backbone ($got)"

# 2. SCHEDULER_WITH_OPERATOR for every env.
for env in candidate-a preview production; do
  slugs="$(appsets_for_env "$env")"
  if grep -qx operator <<<"$slugs" && ! grep -qx scheduler-worker <<<"$slugs"; then
    fail "$env deploys operator without scheduler-worker (/readyz dep)"
  fi
done
pass "SCHEDULER_WITH_OPERATOR holds for all envs"

# 3. CANDIDATE_A_ALWAYS — every deployable node is candidate-flightable (in candidate-a's set),
# the pre-merge validation gate. (Schema enforces contains:candidate-a; this asserts the render.)
while read -r node; do
  [ -n "$node" ] || continue
  grep -qx "$node" <<<"$(appsets_for_env candidate-a)" \
    || fail "$node is deployable but absent from candidate-a (CANDIDATE_A_ALWAYS)"
done <<<"$(all_deployable)"
pass "every deployable node is candidate-flightable (candidate-a)"

# 4. DETERMINISM — --check is stable across repeats.
for _ in 1 2 3 4 5; do
  bash "$RENDER" --check >/dev/null || fail "--check is non-deterministic (SIGPIPE regression?)"
done
pass "--check deterministic across 5 runs"

# 5. FAIL-CLOSED — a deployable row missing `envs:` aborts the env-set render
# (no silent all-env fallback). Point the renderer at a fixture catalog whose
# oss row has had `envs:` stripped.
tmp_catalog="$(mktemp -d)"
cp infra/catalog/*.yaml "$tmp_catalog/"
yq -i 'del(.envs)' "$tmp_catalog/oss.yaml"
set +e
out="$(CATALOG_DIR="$tmp_catalog" bash "$RENDER" --check 2>&1)"
rc=$?
set -e
rm -rf "$tmp_catalog"
[ "$rc" -ne 0 ] || fail "render did not fail closed on a deployable row missing 'envs'"
grep -q "has no 'envs'" <<<"$out" || fail "missing fail-closed message for absent envs; got: $out"
pass "fail-closed when a deployable row omits envs"

echo "PASS: render-node-appset.test.sh"
