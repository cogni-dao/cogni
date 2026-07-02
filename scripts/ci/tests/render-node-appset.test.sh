#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the per-env node-set gate (task.5017, story.5020 W4):
#   1. ATOMIC_PER_ENV: for each env, the rendered AppSet set == exactly the
#      deployable nodes whose catalog `envs:` includes that env — no cross-env
#      constraint. Every env is an independent toggle (candidate-a is no
#      different from preview/production).
#   2. SCHEDULER_WITH_OPERATOR: any env that deploys operator also deploys
#      scheduler-worker (operator /readyz hard-depends on :9000).
#   3. DETERMINISM: repeated --check is stable (guards the `yq | grep -q`
#      SIGPIPE-under-pipefail bug that silently dropped matching nodes).
#   4. FAIL-CLOSED: a deployable row missing `envs:` aborts the render rather
#      than silently fanning the node out to every env.
#
# Run: bash scripts/ci/tests/render-node-appset.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RENDER="scripts/ci/render-node-appset.sh"
# Per-(env, node) AppSets live in PER-ENV subdirs appsets/<env>/, each reconciled
# with prune by its OWN cogni-<env>-appsets app-of-apps (story.5020); candidate-b +
# substrate apps stay elsewhere, out of scope here.
APPSETS_DIR="infra/k8s/argocd/appsets"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

# Slugs rendered for $1 (env), sorted, from the committed AppSet files in appsets/<env>/.
# The full <env>- filename prefix is kept on disk even though the file is nested under <env>/.
appsets_for_env() {
  local env="$1" f base
  for f in "$APPSETS_DIR/$env/$env"-*-applicationset.yaml; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    base="${base#"$env"-}"
    printf '%s\n' "${base%-applicationset.yaml}"
  done | LC_ALL=C sort
}

# Deployable node slugs whose catalog `envs:` lists $1 (env), sorted. This is the
# expected AppSet set for that env under ATOMIC_PER_ENV — no cross-env constraint.
deployable_for_env() {
  local env="$1" f
  for f in infra/catalog/*.yaml; do
    [ "$(yq -r '.candidate_a_branch // ""' "$f")" != "" ] || continue
    if E="$env" yq -e '(.envs // []) | contains([strenv(E)])' "$f" >/dev/null 2>&1; then
      yq -r '.name' "$f"
    fi
  done | LC_ALL=C sort
}

# 0. Committed files match the catalog (the live drift gate, run here too).
bash "$RENDER" --check >/dev/null || fail "committed AppSets are out of sync with the catalog"
pass "committed AppSets in sync (--check green)"

# 1. ATOMIC_PER_ENV — each env renders EXACTLY the deployable nodes whose catalog
# `envs:` lists that env. No cross-env constraint (no ladder): candidate-a is no
# different from preview/production. Adding a node to an env's catalog `envs`
# preserves this — no test edit; the equality is derived from the catalog, not
# hardcoded per-env lists.
for env in candidate-a preview production; do
  rendered="$(appsets_for_env "$env" | sort -u)"
  expected="$(deployable_for_env "$env" | sort -u)"
  [ "$rendered" = "$expected" ] \
    || fail "$env AppSet set must equal deployable nodes listing '$env' — got '$(echo $rendered | tr ' ' ,)', expected '$(echo $expected | tr ' ' ,)'"
  pass "$env renders exactly its catalog opt-ins ($(echo $rendered | tr ' ' ,))"
done

# 2. SCHEDULER_WITH_OPERATOR for every env.
for env in candidate-a preview production; do
  slugs="$(appsets_for_env "$env")"
  if grep -qx operator <<<"$slugs" && ! grep -qx scheduler-worker <<<"$slugs"; then
    fail "$env deploys operator without scheduler-worker (/readyz dep)"
  fi
done
pass "SCHEDULER_WITH_OPERATOR holds for all envs"

# 3. DETERMINISM — --check is stable across repeats.
for _ in 1 2 3 4 5; do
  bash "$RENDER" --check >/dev/null || fail "--check is non-deterministic (SIGPIPE regression?)"
done
pass "--check deterministic across 5 runs"

# 4. FAIL-CLOSED — a deployable row missing `envs:` aborts the env-set render
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
