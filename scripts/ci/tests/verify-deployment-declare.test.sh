#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERIFIER="$REPO_ROOT/scripts/ci/verifiers/verify-deployment-declare.sh"
FIXTURE="$REPO_ROOT/packages/repo-spec/src/node-app-deployment-v1.json"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

git -C "$tmpdir" init -q
git -C "$tmpdir" config user.name test
git -C "$tmpdir" config user.email test@example.com
git -C "$tmpdir" config commit.gpgsign false
mkdir -p "$tmpdir/.cogni"
printf 'schema_version: "1"\nnode_id: 00000000-0000-4000-8000-000000000001\n' > "$tmpdir/.cogni/repo-spec.yaml"
git -C "$tmpdir" add .cogni/repo-spec.yaml
git -C "$tmpdir" commit -qm base
base_sha="$(git -C "$tmpdir" rev-parse HEAD)"

printf '\n' >> "$tmpdir/.cogni/repo-spec.yaml"
jq -jr '.yaml' "$FIXTURE" >> "$tmpdir/.cogni/repo-spec.yaml"
git -C "$tmpdir" add .cogni/repo-spec.yaml
git -C "$tmpdir" commit -qm declaration
head_sha="$(git -C "$tmpdir" rev-parse HEAD)"
printf '.cogni/repo-spec.yaml\n' > "$tmpdir/paths.txt"

(
  cd "$tmpdir"
  OPERATOR_CHANGE_OPERATION=deployment.declare OPERATOR_CHANGE_NODE=blue \
    OPERATOR_CHANGE_BASE_SHA="$base_sha" OPERATOR_CHANGE_HEAD_SHA="$head_sha" \
    OPERATOR_CHANGE_PATHS_FILE="$tmpdir/paths.txt" \
    OPERATOR_CHANGE_DEPLOYMENT_FIXTURE="$FIXTURE" "$VERIFIER"
)

# An App-authored-looking commit with any extra byte is not the stock splice.
printf '# forged\n' >> "$tmpdir/.cogni/repo-spec.yaml"
git -C "$tmpdir" add .cogni/repo-spec.yaml
git -C "$tmpdir" commit -qm forged
forged_sha="$(git -C "$tmpdir" rev-parse HEAD)"
if (
  cd "$tmpdir"
  OPERATOR_CHANGE_OPERATION=deployment.declare OPERATOR_CHANGE_NODE=blue \
    OPERATOR_CHANGE_BASE_SHA="$base_sha" OPERATOR_CHANGE_HEAD_SHA="$forged_sha" \
    OPERATOR_CHANGE_PATHS_FILE="$tmpdir/paths.txt" \
    OPERATOR_CHANGE_DEPLOYMENT_FIXTURE="$FIXTURE" "$VERIFIER"
); then
  echo "forged deployment declaration unexpectedly passed" >&2
  exit 1
fi

echo "verify-deployment-declare tests passed"
