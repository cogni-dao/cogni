#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLASSIFIER="$REPO_ROOT/scripts/ci/classify-operator-change-fast-path.sh"
REGISTRY="$REPO_ROOT/scripts/ci/operator-change-v1.allowlist.json"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
base_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
path='infra/catalog/blue.yaml'
printf '%s\n' "$path" > "$tmpdir/paths.txt"
paths_hash="$(shasum -a 256 "$tmpdir/paths.txt" | awk '{print $1}')"

message="feat(node): add blue to preview

Cogni-Change-Type: cogni.operator-change.v1
Cogni-Operation: env.membership
Cogni-Node: blue
Cogni-Environment: preview
Cogni-Action: add
Cogni-Lease-Generation: 0
Cogni-Base-SHA: $base_sha
Cogni-Changed-Paths-SHA256: $paths_hash"

write_fixtures() {
  local author_login="${1:-cogni-operator[bot]}" verified="${2:-true}"
  jq -n --arg head "$head_sha" --arg base "$base_sha" --arg login "$author_login" \
    '{state:"open",draft:false,base:{ref:"main",sha:$base},head:{sha:$head,ref:"cogni-operator/node-env-blue-preview",repo:{full_name:"Cogni-DAO/cogni"}},user:{login:$login,id:265189974,type:"Bot"},commits:1}' > "$tmpdir/pr.json"
  jq -n --arg head "$head_sha" --arg base "$base_sha" --arg message "$message" --arg login "$author_login" --argjson verified "$verified" \
    '{sha:$head,author:{login:$login,id:265189974},parents:[{sha:$base}],commit:{message:$message,verification:{verified:$verified,reason:"valid"}}}' > "$tmpdir/commit.json"
  jq -n --arg path "$path" '[{filename:$path,previous_filename:null,status:"modified"}]' > "$tmpdir/files.json"
}

run_classifier() {
  local output="$1" registry="${2-$REGISTRY}" policy_root="${3:-$REPO_ROOT}"
  GITHUB_OUTPUT="$output" EVENT_NAME=pull_request REPOSITORY=Cogni-DAO/cogni PR_NUMBER_PR=42 \
    PR_HEAD_SHA_PR="$head_sha" FAST_PATH_PR_JSON="$tmpdir/pr.json" \
    FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" FAST_PATH_FILES_JSON="$tmpdir/files.json" \
    FAST_PATH_REGISTRY_JSON="$registry" FAST_PATH_POLICY_ROOT="$policy_root" bash "$CLASSIFIER" >/dev/null
}
value() { awk -F= -v key="$2" '$1==key{v=$2} END{print v}' "$1"; }

# A valid envelope is still ordinary CI while its registry entry is disabled.
write_fixtures
run_classifier "$tmpdir/disabled.out"
[[ "$(value "$tmpdir/disabled.out" claimed)" == true ]]
[[ "$(value "$tmpdir/disabled.out" invalid)" == false ]]
[[ "$(value "$tmpdir/disabled.out" eligible)" == false ]]
[[ "$(value "$tmpdir/disabled.out" reason)" == operation-disabled ]]

# A claimed envelope with the wrong identity is red, never ordinary fallback.
write_fixtures human true
run_classifier "$tmpdir/human.out"
[[ "$(value "$tmpdir/human.out" invalid)" == true ]]
[[ "$(value "$tmpdir/human.out" reason)" == invalid-pr-identity ]]

# A human draft hold changes PR metadata without changing the signed head.
write_fixtures
jq '.draft = true' "$tmpdir/pr.json" > "$tmpdir/draft-pr.json"
mv "$tmpdir/draft-pr.json" "$tmpdir/pr.json"
run_classifier "$tmpdir/draft.out"
[[ "$(value "$tmpdir/draft.out" invalid)" == true ]]
[[ "$(value "$tmpdir/draft.out" reason)" == invalid-pr-identity ]]

# A bad App signature is red.
write_fixtures 'cogni-operator[bot]' false
run_classifier "$tmpdir/unsigned.out"
[[ "$(value "$tmpdir/unsigned.out" invalid)" == true ]]
[[ "$(value "$tmpdir/unsigned.out" reason)" == invalid-commit-signature ]]

# A reusable workflow loads both policy and executable classifier only from its
# pinned, workflow-owned checkout. This structurally valid but non-replayable
# fixture must be rejected by the real shared replay, not accepted by a shell stub.
mkdir -p "$tmpdir/policy/scripts/ci/verifiers" "$tmpdir/policy/scripts/ci/dist"
jq '.operations["env.membership"].enabledRepositories = ["cogni-dao/cogni"]' \
  "$REGISTRY" > "$tmpdir/policy/scripts/ci/operator-change-v1.allowlist.json"
cp "$REPO_ROOT/scripts/ci/dist/operator-change-replay.cjs" \
  "$tmpdir/policy/scripts/ci/dist/operator-change-replay.cjs"
write_fixtures
run_classifier "$tmpdir/pinned-policy.out" "" "$tmpdir/policy"
[[ "$(value "$tmpdir/pinned-policy.out" eligible)" == false ]]
[[ "$(value "$tmpdir/pinned-policy.out" invalid)" == true ]]
[[ "$(value "$tmpdir/pinned-policy.out" reason)" == operation-replay-failed ]]

# An unknown child repo can authenticate only deployment.declare, and only
# when protected base repo-spec binds intent.name to both repo and trailer.
child_base_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
child_node=cogni-template
child_repo=Cogni-DAO/cogni-template
child_path=.cogni/repo-spec.yaml
printf '%s\n' "$child_path" > "$tmpdir/child-paths.txt"
child_paths_hash="$(shasum -a 256 "$tmpdir/child-paths.txt" | awk '{print $1}')"
child_message="feat(deploy): declare $child_node node deployment

Cogni-Change-Type: cogni.operator-change.v1
Cogni-Operation: deployment.declare
Cogni-Node: $child_node
Cogni-Base-SHA: $child_base_sha
Cogni-Changed-Paths-SHA256: $child_paths_hash"
jq -n --arg head "$head_sha" --arg base "$child_base_sha" --arg repo "$child_repo" --arg node "$child_node" \
  '{state:"open",draft:false,base:{ref:"main",sha:$base},head:{sha:$head,ref:("cogni-operator/declare-deployment-" + $node),repo:{full_name:$repo}},user:{login:"cogni-operator[bot]",id:265189974,type:"Bot"},commits:1}' > "$tmpdir/child-pr.json"
jq -n --arg head "$head_sha" --arg base "$child_base_sha" --arg message "$child_message" \
  '{sha:$head,author:{login:"cogni-operator[bot]",id:265189974},parents:[{sha:$base}],commit:{message:$message,verification:{verified:true,reason:"valid"}}}' > "$tmpdir/child-commit.json"
jq -n --arg path "$child_path" '[{filename:$path,previous_filename:null,status:"modified"}]' > "$tmpdir/child-files.json"
GITHUB_OUTPUT="$tmpdir/child.out" EVENT_NAME=pull_request REPOSITORY="$child_repo" PR_NUMBER_PR=43 \
  PR_HEAD_SHA_PR="$head_sha" FAST_PATH_PR_JSON="$tmpdir/child-pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/child-commit.json" FAST_PATH_FILES_JSON="$tmpdir/child-files.json" \
  FAST_PATH_REGISTRY_JSON="$REGISTRY" FAST_PATH_POLICY_ROOT="$REPO_ROOT" \
  bash "$CLASSIFIER" >/dev/null
[[ "$(value "$tmpdir/child.out" invalid)" == false ]]
[[ "$(value "$tmpdir/child.out" reason)" == operation-disabled ]]

# Explicit owner enablement reaches the real shared replay only after the exact
# child binding above. The nonexistent fixture head fails closed.
jq '.operations["deployment.declare"].enabledChildOwners = ["cogni-dao"]' \
  "$REGISTRY" > "$tmpdir/policy/scripts/ci/operator-change-v1.allowlist.json"
GITHUB_OUTPUT="$tmpdir/enabled-child.out" EVENT_NAME=pull_request REPOSITORY="$child_repo" PR_NUMBER_PR=45 \
  PR_HEAD_SHA_PR="$head_sha" FAST_PATH_PR_JSON="$tmpdir/child-pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/child-commit.json" FAST_PATH_FILES_JSON="$tmpdir/child-files.json" \
  FAST_PATH_POLICY_ROOT="$tmpdir/policy" bash "$CLASSIFIER" >/dev/null
[[ "$(value "$tmpdir/enabled-child.out" eligible)" == false ]]
[[ "$(value "$tmpdir/enabled-child.out" invalid)" == true ]]
[[ "$(value "$tmpdir/enabled-child.out" reason)" == operation-replay-failed ]]

GITHUB_OUTPUT="$tmpdir/wrong-child.out" EVENT_NAME=pull_request REPOSITORY=Cogni-DAO/not-cogni-template PR_NUMBER_PR=44 \
  PR_HEAD_SHA_PR="$head_sha" FAST_PATH_PR_JSON="$tmpdir/child-pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/child-commit.json" FAST_PATH_FILES_JSON="$tmpdir/child-files.json" \
  FAST_PATH_REGISTRY_JSON="$REGISTRY" FAST_PATH_POLICY_ROOT="$REPO_ROOT" \
  bash "$CLASSIFIER" >/dev/null
[[ "$(value "$tmpdir/wrong-child.out" invalid)" == true ]]
[[ "$(value "$tmpdir/wrong-child.out" reason)" == untrusted-repository ]]

# Every operation is explicitly registered and disabled pending test-org proof.
jq -e '
  .version == "cogni.operator-change.v1"
  and ([.operations | keys[]] | sort) == (["deployment.declare","env.membership","env.placement","env.region","node.register"] | sort)
  and all(.operations[]; .enabledRepositories == [])
  and .operations["deployment.declare"].enabledChildOwners == []
  and all(.operations | to_entries[]; .key == "deployment.declare" or (.value | has("enabledChildOwners") | not))
' "$REGISTRY" >/dev/null

echo "classify-operator-change-fast-path tests passed"
