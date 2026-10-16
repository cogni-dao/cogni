#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
. "$ROOT/scripts/ci/lib/shared-platform-manifests.sh"
TEST_ROOT="$(mktemp -d -t shared-platform-manifests.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/infra/k8s"
cp -R "$ROOT/infra/k8s/base" "$TEST_ROOT/infra/k8s/"
mkdir -p "$TEST_ROOT/infra/k8s/overlays" "$TEST_ROOT/nodes/operator"
cp -R "$ROOT/nodes/operator/k8s" "$TEST_ROOT/nodes/operator/"
for lane in candidate-a preview production; do
  mkdir -p "$TEST_ROOT/infra/k8s/overlays/$lane"
  cp -R "$ROOT/infra/k8s/overlays/$lane/operator" "$TEST_ROOT/infra/k8s/overlays/$lane/"
  cp -R "$ROOT/infra/k8s/overlays/$lane/scheduler-worker" "$TEST_ROOT/infra/k8s/overlays/$lane/"
  overlay="$TEST_ROOT/infra/k8s/overlays/$lane/operator/kustomization.yaml"
  yq -i '.patches += [{"target": {"kind": "Deployment", "name": "database-reliability-readmitter"}, "patch": "spec:\n  replicas: 1\n"}, {"target": {"kind": "Deployment", "name": "node-app"}, "patch": "- op: add\n  path: /metadata/annotations/flight-reviewed\n  value: retained\n"}]' "$overlay"
  before_images="$(yq -o=json -I=0 '.images' "$overlay")"
  cat >> "$(dirname "$overlay")/database-reliability-actuator-external-secret.yaml" <<'STALE_SECRET'
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: database-reliability-readmitter-env-secrets
spec:
  target:
    name: database-reliability-readmitter-env-secrets
STALE_SECRET
  # A stale app copy reintroduces the writer file and its base reference.
  printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: database-reliability-watchdog\nspec:\n  replicas: 2\n' > "$TEST_ROOT/infra/k8s/base/database-reliability-actuator/watchdog.yaml"
  yq -i '.resources += ["watchdog.yaml"]' "$TEST_ROOT/infra/k8s/base/database-reliability-actuator/kustomization.yaml"
  reconcile_shared_platform_manifests "$ROOT" "$TEST_ROOT" "$lane" operator
  [ ! -f "$TEST_ROOT/infra/k8s/base/database-reliability-actuator/watchdog.yaml" ]
  [ "$(yq -o=json -I=0 '.images' "$overlay")" = "$before_images" ]
  yq -e '.patches[].patch | select(test("flight-reviewed"))' "$overlay" >/dev/null
  if yq -e '.patches[].target.name | select(. == "database-reliability-readmitter")' "$overlay" >/dev/null 2>&1; then
    echo 'FAIL: stale readmitter patch retained' >&2; exit 1
  fi
  yq -e '.resources[] | select(. == "../../../base/database-reliability-actuator")' "$overlay" >/dev/null
  rendered="$(kubectl kustomize "$(dirname "$overlay")")"
  [ "$(yq -N 'select(.kind == "Deployment" and .metadata.name == "operator-database-reliability-actuator") | .spec.replicas' <<< "$rendered")" = 1 ]
  [ "$(yq -N 'select(.kind == "Deployment" and .metadata.name == "operator-node-app") | .metadata.annotations.flight-reviewed' <<< "$rendered")" = retained ]
  if yq -e 'select(.metadata.name | test("database-reliability-(readmitter|watchdog)"))' <<< "$rendered" >/dev/null 2>&1; then
    echo 'FAIL: retired writer resource rendered' >&2; exit 1
  fi
  cp "$overlay" "$TEST_ROOT/before.yaml"
  reconcile_shared_platform_manifests "$ROOT" "$TEST_ROOT" "$lane" operator
  cmp "$overlay" "$TEST_ROOT/before.yaml"

  overlay="$TEST_ROOT/infra/k8s/overlays/$lane/scheduler-worker/kustomization.yaml"
  yq -i '.replicas = [{"name": "scheduler-worker", "count": 9}] | .patches += [{"target": {"kind": "Deployment", "name": "scheduler-worker"}, "patch": "- op: replace\n  path: /spec/replicas\n  value: 9\n"}]' "$overlay"
  before_images="$(yq -o=json -I=0 '.images' "$overlay")"
  before_routes="$(shasum -a 256 "$(dirname "$overlay")/node-endpoints.patch.yaml" | cut -d ' ' -f 1)"
  reconcile_shared_platform_manifests "$ROOT" "$TEST_ROOT" "$lane" scheduler-worker
  count="$(kubectl kustomize "$(dirname "$overlay")" | yq -N 'select(.kind == "Deployment") | .spec.replicas')"
  expected=1; [ "$lane" = preview ] && expected=2
  [ "$count" = "$expected" ]
  [ "$(yq -o=json -I=0 '.images' "$overlay")" = "$before_images" ]
  [ "$(shasum -a 256 "$(dirname "$overlay")/node-endpoints.patch.yaml" | cut -d ' ' -f 1)" = "$before_routes" ]
  cp "$overlay" "$TEST_ROOT/before.yaml"
  reconcile_shared_platform_manifests "$ROOT" "$TEST_ROOT" "$lane" scheduler-worker
  cmp "$overlay" "$TEST_ROOT/before.yaml"
  echo "PASS: $lane stale writers removed; scheduler=$expected; app images/routes retained; idempotent"
done

# Losing a referenced platform policy must never silently restore base replicas.
mkdir -p "$TEST_ROOT/platform/infra/k8s/overlays/candidate-a"
cp -R "$ROOT/infra/k8s/overlays/candidate-a/scheduler-worker" "$TEST_ROOT/platform/infra/k8s/overlays/candidate-a/"
rm "$TEST_ROOT/platform/infra/k8s/overlays/candidate-a/scheduler-worker/replicas.patch.yaml"
if reconcile_shared_platform_manifests "$TEST_ROOT/platform" "$TEST_ROOT" candidate-a scheduler-worker; then
  echo 'FAIL: missing referenced platform replica policy accepted' >&2; exit 1
fi
rm -rf "$TEST_ROOT/platform/infra/k8s/overlays/candidate-a/scheduler-worker"
if reconcile_shared_platform_manifests "$TEST_ROOT/platform" "$TEST_ROOT" candidate-a scheduler-worker; then
  echo 'FAIL: missing platform scheduler overlay accepted' >&2; exit 1
fi
echo 'PASS: missing platform policy fails closed'
