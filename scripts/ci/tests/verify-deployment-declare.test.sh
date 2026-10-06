#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERIFIER="$REPO_ROOT/scripts/ci/verifiers/verify-operator-change.sh"
REPLAY_BUNDLE="$REPO_ROOT/scripts/ci/dist/operator-change-replay.cjs"
CLASSIFIER="$REPO_ROOT/scripts/ci/classify-operator-change-fast-path.sh"
REGISTRY="$REPO_ROOT/scripts/ci/operator-change-v1.allowlist.json"
FIXTURE="$REPO_ROOT/packages/repo-spec/src/node-app-deployment-v1.json"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
parent_control="$tmpdir/parent-control"
mkdir -p "$parent_control/infra/catalog"
printf '%s\n' \
  'name: cogni-template' \
  'source_repo: https://github.com/Cogni-DAO/cogni-template.git' \
  > "$parent_control/infra/catalog/cogni-template.yaml"

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
    OPERATOR_CHANGE_PARENT_CATALOG_ROOT="$parent_control" \
    REPOSITORY=Cogni-DAO/cogni-template "$VERIFIER"
)

# The CI transport feeds current GitHub facts into the same structural policy
# and replay core used by the deployed operator. A complete enabled fixture is
# eligible only through that shared bundle; the shell owns no trust decisions.
jq -n --arg head "$head_sha" --arg base "$base_sha" --arg node "$node" \
  '{state:"open",draft:false,base:{ref:"main",sha:$base},head:{sha:$head,ref:("cogni-operator/declare-deployment-" + $node),repo:{full_name:"Cogni-DAO/cogni-template"}},user:{login:"cogni-operator[bot]",id:265189974,type:"Bot"},commits:1}' > "$tmpdir/pr.json"
jq -n --arg head "$head_sha" --arg base "$base_sha" --rawfile message "$tmpdir/message.txt" \
  '{sha:$head,author:{login:"cogni-operator[bot]",id:265189974},parents:[{sha:$base}],commit:{message:$message,verification:{verified:true,reason:"valid"}}}' > "$tmpdir/commit.json"
jq -n --arg path "$path" '[{filename:$path,previous_filename:null,status:"modified"}]' > "$tmpdir/files.json"
jq '.operations["deployment.declare"].enabledChildOwners = ["cogni-dao"]' \
  "$REGISTRY" > "$tmpdir/enabled-registry.json"
(
  cd "$tmpdir"
  GITHUB_OUTPUT="$tmpdir/classifier.out" EVENT_NAME=pull_request \
    REPOSITORY=Cogni-DAO/cogni-template PR_NUMBER_PR=42 PR_HEAD_SHA_PR="$head_sha" \
    FAST_PATH_PR_JSON="$tmpdir/pr.json" FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
    FAST_PATH_FILES_JSON="$tmpdir/files.json" \
    FAST_PATH_REGISTRY_JSON="$tmpdir/enabled-registry.json" \
    FAST_PATH_POLICY_ROOT="$REPO_ROOT" \
    OPERATOR_CHANGE_PARENT_CATALOG_ROOT="$parent_control" bash "$CLASSIFIER"
)
grep -qxF 'eligible=true' "$tmpdir/classifier.out"
grep -qxF 'invalid=false' "$tmpdir/classifier.out"
grep -qxF 'reason=eligible' "$tmpdir/classifier.out"

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
    OPERATOR_CHANGE_PARENT_CATALOG_ROOT="$parent_control" \
    REPOSITORY=Cogni-DAO/cogni-template "$VERIFIER"
); then
  echo "forged deployment declaration unexpectedly passed" >&2
  exit 1
fi

echo "verify-deployment-declare tests passed"
