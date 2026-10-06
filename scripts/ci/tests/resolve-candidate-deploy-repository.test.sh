#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/resolve-candidate-deploy-repository.sh"
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

cat >"$TMPROOT/manifest.yaml" <<'YAML'
artifacts:
  - repo: cogni-test-org/cogni-monorepo
    role: test-parent
    github_app:
      id: "3956976"
      slug: cogni-operator-test
YAML

resolve() {
  local provider="$1" current="$2" out="$3"
  DEPLOYMENT_PROVIDER="$provider" \
    GITHUB_REPOSITORY="$current" \
    GITHUB_SERVER_URL="https://github.example" \
    SYNC_MANIFEST_PATH="$TMPROOT/manifest.yaml" \
    GITHUB_OUTPUT="$out" \
    bash "$SCRIPT" >/dev/null
}

resolve k3s Cogni-DAO/cogni "$TMPROOT/k3s-hub.out"
grep -qx 'repository=cogni-test-org/cogni-monorepo' "$TMPROOT/k3s-hub.out"
grep -qx 'url=https://github.example/cogni-test-org/cogni-monorepo.git' "$TMPROOT/k3s-hub.out"
grep -qx 'app_slug=cogni-operator-test' "$TMPROOT/k3s-hub.out"
grep -qx 'requires_app_token=true' "$TMPROOT/k3s-hub.out"

resolve k3s cogni-test-org/cogni-monorepo "$TMPROOT/k3s-parent.out"
grep -qx 'repository=cogni-test-org/cogni-monorepo' "$TMPROOT/k3s-parent.out"
grep -qx 'requires_app_token=false' "$TMPROOT/k3s-parent.out"

resolve akash Cogni-DAO/cogni "$TMPROOT/akash.out"
grep -qx 'repository=Cogni-DAO/cogni' "$TMPROOT/akash.out"
grep -qx 'url=https://github.example/Cogni-DAO/cogni.git' "$TMPROOT/akash.out"
grep -qx 'requires_app_token=false' "$TMPROOT/akash.out"

echo "PASS: resolve-candidate-deploy-repository.test.sh"
