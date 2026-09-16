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

# Deployable node slugs whose catalog `envs:` lists $1 (env) AND whose cell is reconciled
# by that env's OWN cluster, sorted. This is the expected AppSet set for appsets/<env>/
# under ATOMIC_PER_ENV — no cross-env constraint.
#
# The second condition is seam 3 (story.5016): an akash+crossplane pre-prod cell is
# reconciled by the PRODUCTION cluster, so its AppSet lives in
# appsets/production-hosted-lanes/ and must NOT appear in its own env dir — exactly one
# cluster reconciles a cell. Every other row (k3s, legacy-authority akash, production)
# is unaffected, which is why this predicate leaves today's fleet equality unchanged.
deployable_for_env() {
  local env="$1" f
  for f in infra/catalog/*.yaml; do
    [ "$(yq -r '.candidate_a_branch // ""' "$f")" != "" ] || continue
    E="$env" yq -e '(.envs // []) | contains([strenv(E)])' "$f" >/dev/null 2>&1 || continue
    if [ "$env" != production ] \
      && [ "$(E="$env" yq -r '(.deployment_provider // {})[strenv(E)] // "k3s"' "$f")" = akash ] \
      && [ "$(E="$env" yq -r '(.compute_api // {})[strenv(E)] // "legacy"' "$f")" = crossplane ]; then
      continue
    fi
    yq -r '.name' "$f"
  done | LC_ALL=C sort
}

# Deployable "<env>/<node>" cells the PRODUCTION cluster hosts on another env's behalf.
hosted_lane_cells() {
  local env f
  for env in candidate-a preview; do
    for f in infra/catalog/*.yaml; do
      [ "$(yq -r '.candidate_a_branch // ""' "$f")" != "" ] || continue
      E="$env" yq -e '(.envs // []) | contains([strenv(E)])' "$f" >/dev/null 2>&1 || continue
      [ "$(E="$env" yq -r '(.deployment_provider // {})[strenv(E)] // "k3s"' "$f")" = akash ] || continue
      [ "$(E="$env" yq -r '(.compute_api // {})[strenv(E)] // "legacy"' "$f")" = crossplane ] || continue
      printf '%s-%s-applicationset.yaml\n' "$env" "$(yq -r '.name' "$f")"
    done
  done | LC_ALL=C sort
}

# 0. Committed files match the catalog (the live drift gate, run here too).
bash "$RENDER" --check >/dev/null || fail "committed AppSets are out of sync with the catalog"
pass "committed AppSets in sync (--check green)"

# The child Application opts into server-side diff so Argo compares structural
# custom resources through the API server rather than its static type schema.
# Fixture: the operator appset — the ONE deployment guaranteed present in every env
# (OPERATOR_SELF_HOSTS_THE_VERB). node-template is NOT a safe fixture: its env
# membership is an ordinary toggle (TEMPLATE_OVERLAY_IS_RENDER_SOURCE), so its
# appset may legitimately leave an env.
yq -e '.spec.template.metadata.annotations."argocd.argoproj.io/compare-options" == "ServerSideDiff=true,IncludeMutationWebhook=true"' \
  "$APPSETS_DIR/candidate-a/candidate-a-operator-applicationset.yaml" >/dev/null \
  || fail "rendered child Application is missing server-side diff with mutation-webhook inclusion"
pass "child Application enables server-side diff with mutation-webhook inclusion"

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
# poly row has had `envs:` stripped.
tmp_catalog="$(mktemp -d)"
cp infra/catalog/*.yaml "$tmp_catalog/"
yq -i 'del(.envs)' "$tmp_catalog/poly.yaml"
set +e
out="$(CATALOG_DIR="$tmp_catalog" bash "$RENDER" --check 2>&1)"
rc=$?
set -e
rm -rf "$tmp_catalog"
[ "$rc" -ne 0 ] || fail "render did not fail closed on a deployable row missing 'envs'"
grep -q "has no 'envs'" <<<"$out" || fail "missing fail-closed message for absent envs; got: $out"
pass "fail-closed when a deployable row omits envs"

# 5. RECONCILIATION_FOLLOWS_PAYMENT (story.5016 seam 3) — a pre-prod cell that is BOTH
# akash-placed AND crossplane-owned is reconciled by the PRODUCTION cluster, so its AppSet
# renders into appsets/production-hosted-lanes/, never into its own env dir. The catalog has
# no such cell today (every akash row is production-only), so the routing is exercised
# against a fixture catalog: --check must name the HOSTED path as missing.
#
# The contrast case is the load-bearing half. The SAME row placed on akash but left on the
# LEGACY compute authority must still render into appsets/candidate-a/ — the legacy
# controller is not cluster-bound the way the Crossplane Composition is. Asserting both
# directions is what proves the predicate is the PAIR and not just "akash".
hosted_committed="$(
  for f in "$APPSETS_DIR/production-hosted-lanes"/*-applicationset.yaml; do
    [ -e "$f" ] || continue
    basename "$f"
  done | LC_ALL=C sort
)"
[ "$hosted_committed" = "$(hosted_lane_cells)" ] \
  || fail "production-hosted-lanes/ must hold exactly the akash+crossplane pre-prod cells — got '$hosted_committed', expected '$(hosted_lane_cells)'"
pass "production-hosted-lanes/ holds exactly the akash+crossplane pre-prod cells"

assert_routes_to() {
  local authority="$1" want_path="$2" reject_path="$3" catalog out rc
  catalog="$(mktemp -d)"
  cp infra/catalog/*.yaml "$catalog/"
  A="$authority" yq -i '
    .envs = ["candidate-a"] + .envs |
    .deployment_provider."candidate-a" = "akash" |
    .compute_api."candidate-a" = strenv(A)
  ' "$catalog/poly.yaml"
  set +e
  out="$(CATALOG_DIR="$catalog" bash "$RENDER" --check 2>&1)"
  rc=$?
  set -e
  rm -rf "$catalog"
  [ "$rc" -ne 0 ] || fail "compute_api=$authority: --check passed for a cell with no committed AppSet"
  grep -q "$want_path" <<<"$out" \
    || fail "compute_api=$authority: expected --check to name '$want_path'; got: $out"
  grep -q "$reject_path" <<<"$out" \
    && fail "compute_api=$authority: --check must NOT name '$reject_path'; got: $out"
  return 0
}

assert_routes_to crossplane \
  "appsets/production-hosted-lanes/candidate-a-poly-applicationset.yaml" \
  "appsets/candidate-a/candidate-a-poly-applicationset.yaml"
pass "akash+crossplane candidate-a cell routes to production-hosted-lanes/"

assert_routes_to legacy \
  "appsets/candidate-a/candidate-a-poly-applicationset.yaml" \
  "appsets/production-hosted-lanes/candidate-a-poly-applicationset.yaml"
pass "akash+legacy candidate-a cell still routes to its own env dir"

echo "PASS: render-node-appset.test.sh"
