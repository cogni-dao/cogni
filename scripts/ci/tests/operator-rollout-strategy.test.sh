#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Contract tests for the operator rollout strategy (bug.5100):
#   - every environment inherits the base zero-downtime RollingUpdate policy;
#   - no overlay may reintroduce kill-old-before-new rollout semantics.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

BASE="infra/k8s/base/node-app/deployment.yaml"
CANDIDATE="infra/k8s/overlays/candidate-a/operator/kustomization.yaml"
PREVIEW="infra/k8s/overlays/preview/operator/kustomization.yaml"
PRODUCTION="infra/k8s/overlays/production/operator/kustomization.yaml"

deployment_patch_ops() {
  yq -o=json -I=0 \
    '[.patches[] | select(.target.kind == "Deployment" and .target.name == "node-app") | .patch | from_yaml | .[]]' \
    "$1"
}

echo "[1/2] base preserves the zero-downtime production policy"
yq -e '
  .spec.strategy.type == "RollingUpdate" and
  .spec.strategy.rollingUpdate.maxUnavailable == 0 and
  .spec.strategy.rollingUpdate.maxSurge == 1
' "$BASE" >/dev/null \
  || fail "base node-app must remain RollingUpdate with maxUnavailable=0 and maxSurge=1"
pass "base policy is RollingUpdate 0/1"

echo "[2/2] environment overlays do not weaken zero-downtime rollouts"
for overlay in "$CANDIDATE" "$PREVIEW" "$PRODUCTION"; do
  OPS="$(deployment_patch_ops "$overlay")"
  jq -e 'all(.[]; (.path | startswith("/spec/strategy")) | not)' <<<"$OPS" >/dev/null \
    || fail "$overlay must inherit the base zero-downtime rollout strategy"
done
pass "candidate-a, preview, and production inherit the base 0/1 policy"
