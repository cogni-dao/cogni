#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Contract tests for the operator rollout strategy (bug.5100):
#   - preview and production inherit the base zero-downtime RollingUpdate policy;
#   - candidate-a replaces its one replica before creating the next one so a
#     flight fits the fixed-capacity validation host;
#   - the singleton compute controller removes stale RollingUpdate fields when
#     switching a live Deployment to Recreate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

BASE="infra/k8s/base/node-app/deployment.yaml"
CONTROLLER="infra/k8s/base/compute-workload-controller/deployment.yaml"
CANDIDATE="infra/k8s/overlays/candidate-a/operator/kustomization.yaml"
PREVIEW="infra/k8s/overlays/preview/operator/kustomization.yaml"
PRODUCTION="infra/k8s/overlays/production/operator/kustomization.yaml"

deployment_patch_ops() {
  yq -o=json -I=0 \
    '[.patches[] | select(.target.kind == "Deployment" and .target.name == "node-app") | .patch | from_yaml | .[]]' \
    "$1"
}

echo "[1/4] base preserves the zero-downtime production policy"
yq -e '
  .spec.strategy.type == "RollingUpdate" and
  .spec.strategy.rollingUpdate.maxUnavailable == 0 and
  .spec.strategy.rollingUpdate.maxSurge == 1
' "$BASE" >/dev/null \
  || fail "base node-app must remain RollingUpdate with maxUnavailable=0 and maxSurge=1"
pass "base policy is RollingUpdate 0/1"

echo "[2/4] candidate-a operator rollout fits fixed host capacity"
CANDIDATE_OPS="$(deployment_patch_ops "$CANDIDATE")"
jq -e '
  [.[] | select(.path | startswith("/spec/strategy"))] == [
    {"op":"replace", "path":"/spec/strategy/rollingUpdate/maxUnavailable", "value":1},
    {"op":"replace", "path":"/spec/strategy/rollingUpdate/maxSurge", "value":0}
  ]
' <<<"$CANDIDATE_OPS" >/dev/null \
  || fail "candidate-a operator must override rollout strategy to maxUnavailable=1 and maxSurge=0"
pass "candidate-a policy is replace-before-create 1/0"

echo "[3/4] preview and production do not weaken zero-downtime rollouts"
for overlay in "$PREVIEW" "$PRODUCTION"; do
  OPS="$(deployment_patch_ops "$overlay")"
  jq -e 'all(.[]; (.path | startswith("/spec/strategy")) | not)' <<<"$OPS" >/dev/null \
    || fail "$overlay must inherit the base zero-downtime rollout strategy"
done
pass "preview and production inherit the base 0/1 policy"

echo "[4/4] compute controller Recreate strategy clears stale RollingUpdate state"
yq -e '
  .spec.strategy.type == "Recreate" and
  (.spec.strategy | has("rollingUpdate")) and
  .spec.strategy.rollingUpdate == null
' "$CONTROLLER" >/dev/null \
  || fail "compute controller must use Recreate with an explicit rollingUpdate null tombstone"
pass "compute controller clears RollingUpdate while switching to Recreate"
