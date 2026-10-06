#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERIFIER="$REPO_ROOT/scripts/ci/verifiers/verify-operator-change.sh"
REPLAY_BUNDLE="$REPO_ROOT/scripts/ci/dist/operator-change-replay.mjs"
FIXTURE="$REPO_ROOT/packages/repo-spec/src/node-app-deployment-v1.json"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

git -C "$tmpdir" init -q
git -C "$tmpdir" config user.name test
git -C "$tmpdir" config user.email test@example.com
git -C "$tmpdir" config commit.gpgsign false
mkdir -p "$tmpdir/.cogni"
cp "$REPO_ROOT/.cogni/repo-spec.yaml" "$tmpdir/.cogni/repo-spec.yaml"
git -C "$tmpdir" add .cogni/repo-spec.yaml
git -C "$tmpdir" commit -qm base
base_sha="$(git -C "$tmpdir" rev-parse HEAD)"
node=cogni-template
path=.cogni/repo-spec.yaml
printf '%s\n' "$path" > "$tmpdir/paths.txt"
paths_hash="$(shasum -a 256 "$tmpdir/paths.txt" | awk '{print $1}')"
cat > "$tmpdir/message.txt" <<EOF
feat(deploy): declare $node node deployment

Cogni-Change-Type: cogni.operator-change.v1
Cogni-Operation: deployment.declare
Cogni-Node: $node
Cogni-Base-SHA: $base_sha
Cogni-Changed-Paths-SHA256: $paths_hash
EOF

printf '\n' >> "$tmpdir/.cogni/repo-spec.yaml"
jq -jr '.yaml' "$FIXTURE" >> "$tmpdir/.cogni/repo-spec.yaml"
git -C "$tmpdir" add .cogni/repo-spec.yaml
git -C "$tmpdir" commit -qF "$tmpdir/message.txt"
head_sha="$(git -C "$tmpdir" rev-parse HEAD)"

(
  cd "$tmpdir"
  OPERATOR_CHANGE_OPERATION=deployment.declare OPERATOR_CHANGE_NODE="$node" \
    OPERATOR_CHANGE_BASE_SHA="$base_sha" OPERATOR_CHANGE_HEAD_SHA="$head_sha" \
    OPERATOR_CHANGE_PATHS_FILE="$tmpdir/paths.txt" \
    OPERATOR_CHANGE_REPLAY_BUNDLE="$REPLAY_BUNDLE" \
    REPOSITORY=cogni-dao/cogni "$VERIFIER"
)

# An App-authored-looking commit with any extra byte is not the stock splice.
printf '# forged\n' >> "$tmpdir/.cogni/repo-spec.yaml"
git -C "$tmpdir" add .cogni/repo-spec.yaml
git -C "$tmpdir" commit -qF "$tmpdir/message.txt"
forged_sha="$(git -C "$tmpdir" rev-parse HEAD)"
if (
  cd "$tmpdir"
  OPERATOR_CHANGE_OPERATION=deployment.declare OPERATOR_CHANGE_NODE="$node" \
    OPERATOR_CHANGE_BASE_SHA="$base_sha" OPERATOR_CHANGE_HEAD_SHA="$forged_sha" \
    OPERATOR_CHANGE_PATHS_FILE="$tmpdir/paths.txt" \
    OPERATOR_CHANGE_REPLAY_BUNDLE="$REPLAY_BUNDLE" \
    REPOSITORY=cogni-dao/cogni "$VERIFIER"
); then
  echo "forged deployment declaration unexpectedly passed" >&2
  exit 1
fi

echo "verify-deployment-declare tests passed"
