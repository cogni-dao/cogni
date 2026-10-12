#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Regression: a scheduler-worker promotion must update both the immutable image
# pin and the IMAGE_DIGEST value exposed by /version in one overlay mutation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROMOTE="$REPO_ROOT/scripts/ci/promote-k8s-image.sh"
TMPROOT="$(mktemp -d -t promote-k8s-image.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

mkdir -p "$TMPROOT/infra/k8s/overlays/candidate-a/scheduler-worker"
cp "$REPO_ROOT/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml" \
  "$TMPROOT/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml"

DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
(
  cd "$TMPROOT"
  bash "$PROMOTE" --no-commit --env candidate-a --app scheduler-worker \
    --digest "ghcr.io/cogni-dao/cogni-template@${DIGEST}"
)

OVERLAY="$TMPROOT/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml"
grep -q "digest: \"${DIGEST}\"" "$OVERLAY"
awk -v expected="$DIGEST" '
  /path: \/data\/IMAGE_DIGEST/ { awaiting = 1; next }
  awaiting && /^[[:space:]]*value:/ {
    gsub(/^[[:space:]]*value:[[:space:]]*"?|"?[[:space:]]*$/, "")
    if ($0 != expected) exit 1
    found = 1
    awaiting = 0
  }
  END { if (!found) exit 1 }
' "$OVERLAY"

echo "PASS: scheduler-worker image pin and /version digest identity move atomically"
