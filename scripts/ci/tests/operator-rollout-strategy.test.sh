#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Contract tests for the operator rollout strategy (bug.5100):
#   - base and every non-operator overlay retain zero-downtime RollingUpdate;
#   - the one-time operator Recreate cutover requires the exact native-audit initializer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

BASE="infra/k8s/base/node-app/deployment.yaml"

deployment_patch_ops() {
  yq -o=json -I=0 \
    '[.patches[]? | select(.target.kind == "Deployment" and .target.name == "node-app") | .patch | from_yaml | .[]]' \
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

echo "[2/2] only the explicit operator native-audit cutover may use Recreate"
audit_command="exec node --input-type=module -e 'import { migrateOperatorAfterNativeDrain } from \"/app/nodes/operator/app/migrate-doltgres.mjs\"; await migrateOperatorAfterNativeDrain(\"/app/nodes/operator/app/doltgres-migrations\")'"
for overlay in infra/k8s/overlays/{candidate-a,preview,production}/*/kustomization.yaml; do
  OPS="$(deployment_patch_ops "$overlay")"
  case "$overlay" in
    */operator/kustomization.yaml)
      jq -e --arg audit "$audit_command" '
        [.[] | select(.path | startswith("/spec/strategy"))] ==
          [{"op":"replace","path":"/spec/strategy","value":{"type":"Recreate"}}]
        and ([.[] | select(.op == "add" and .path == "/spec/template/spec/initContainers/-")
          | .value | select(.name == "migrate-doltgres")
          | select(.command == ["/bin/sh", "-c", $audit])
          | select(any(.envFrom[]?; .configMapRef.name == "operator-node-app-config"))
          | select(any(.env[]?; .name == "DATABASE_URL" and
              .valueFrom.secretKeyRef.name == "operator-env-secrets" and
              .valueFrom.secretKeyRef.key == "DOLTGRES_URL"))] | length == 1)
      ' <<<"$OPS" >/dev/null || fail "$overlay must couple one-time Recreate to the exact native-audit initializer"
      ;;
    *)
      jq -e 'all(.[]; (.path | startswith("/spec/strategy")) | not)' <<<"$OPS" >/dev/null \
        || fail "$overlay must inherit the base zero-downtime rollout strategy"
      ;;
  esac
done
# Actual census and producer absence remain native CI proof, not a source-order assertion.
grep -q '^export async function migrateOperatorAfterNativeDrain(' scripts/db/migrate-doltgres.mjs \
  || fail "operator cutover initializer is absent from the source tree"
pass "only operator's exact audited cutover uses Recreate; restore RollingUpdate after all operator lanes prove v2"
