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
  # Search EVERY control dir for the `<env>-` filename prefix, not just appsets/<env>/.
  # Since task.5132 the directory answers WHICH CLUSTER RECONCILES while the filename
  # keeps the WORKLOAD env — an akash node's candidate-a AppSet lives under
  # appsets/production/. This invariant is about which ENVS a node is rendered for, so it
  # must follow the name, not the location.
  for f in "$APPSETS_DIR"/*/"$env"-*-applicationset.yaml; do
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
# (no silent all-env fallback). Point the renderer at a hermetic fixture catalog
# containing one deployable row with no `envs:` field.
tmp_catalog="$(mktemp -d)"
cat > "$tmp_catalog/fixture-node.yaml" <<'YAML'
name: fixture-node
candidate_a_branch: deploy/candidate-a-fixture-node
YAML
set +e
out="$(CATALOG_DIR="$tmp_catalog" bash "$RENDER" --check 2>&1)"
rc=$?
set -e
rm -rf "$tmp_catalog"
[ "$rc" -ne 0 ] || fail "render did not fail closed on a deployable row missing 'envs'"
grep -q "has no 'envs'" <<<"$out" || fail "missing fail-closed message for absent envs; got: $out"
pass "fail-closed when a deployable row omits envs"

# 5. CONTROL_CLUSTER_SPLIT (task.5132) — WHICH CLUSTER RECONCILES an AppSet is a
#    different question from WHICH ENV the workload is. An akash node's non-production
#    lane is reconciled by the PRODUCTION cluster, because the node app runs on Akash and
#    its XR is pure desired state — while a k3s row genuinely runs IN its env's cluster and
#    must stay there. Without the split a real node's candidate-a XR lands in candidate-a's
#    cluster and can only dial the TEST Console account, which is the NS4 violation
#    task.5130 purged.
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
cp infra/catalog/operator.yaml "$fixture/"
# The akash row is AUTHORED here, not string-patched out of a live catalog row. Patching
# depended on `infra/catalog/toks5.yaml` containing the exact bytes "envs: [production]" and
# "deployment_provider:\n  production: akash" — so the moment a real activation edited toks5
# (#2321 added candidate-a), BOTH anchors stopped matching, the fixture silently stayed
# unpatched, and this test asserted against a fixture it had failed to build. A fixture that
# reads a mutable file is a test that fails when unrelated work is correct.
cat > "$fixture/toks5.yaml" <<'YAML'
name: toks5
type: node
port: 3300
node_port: 31700
source_repo: https://github.com/cogni-dao/toks5.git
envs: [candidate-a, preview, production]
deployment_provider:
  candidate-a: akash
  preview: akash
  production: akash
activity_env: production
YAML

# Source THE definition (bug.5204) rather than re-extracting it from the renderer — the
# whole point of the lib is that nobody keeps a second copy, tests included.
# shellcheck source=scripts/ci/lib/appset-paths.sh
CATALOG_DIR="$fixture" source scripts/ci/lib/appset-paths.sh

for env in candidate-a preview; do
  got="$(CATALOG_DIR="$fixture" control_env_for "$env" toks5)"
  [ "$got" = "production" ] || fail "akash toks5 in $env should be reconciled by production, got $got"
done
pass "akash node's non-prod lanes are reconciled by the production cluster"

for env in candidate-a preview; do
  got="$(CATALOG_DIR="$fixture" control_env_for "$env" operator)"
  [ "$got" = "$env" ] || fail "k3s operator in $env must stay in $env, got $got"
done
pass "k3s rows stay with their own env's cluster"

got="$(CATALOG_DIR="$fixture" control_env_for production toks5)"
[ "$got" = "production" ] || fail "production must be reconciled by production, got $got"
pass "production is unchanged for every row"

echo "PASS: render-node-appset.test.sh"
