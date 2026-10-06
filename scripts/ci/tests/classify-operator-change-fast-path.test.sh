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
Cogni-Base-SHA: $base_sha
Cogni-Changed-Paths-SHA256: $paths_hash"

write_fixtures() {
  local author_login="${1:-cogni-operator[bot]}" verified="${2:-true}"
  jq -n --arg head "$head_sha" --arg base "$base_sha" --arg login "$author_login" \
    '{state:"open",base:{ref:"main",sha:$base},head:{sha:$head,ref:"cogni-operator/node-env-blue-preview",repo:{full_name:"Cogni-DAO/cogni"}},user:{login:$login,id:265189974,type:"Bot"},commits:1}' > "$tmpdir/pr.json"
  jq -n --arg head "$head_sha" --arg base "$base_sha" --arg message "$message" --arg login "$author_login" --argjson verified "$verified" \
    '{sha:$head,author:{login:$login,id:265189974},parents:[{sha:$base}],commit:{message:$message,verification:{verified:$verified,reason:"valid"}}}' > "$tmpdir/commit.json"
  jq -n --arg path "$path" '[{filename:$path,previous_filename:null,status:"modified"}]' > "$tmpdir/files.json"
}

run_classifier() {
  GITHUB_OUTPUT="$1" EVENT_NAME=pull_request REPOSITORY=Cogni-DAO/cogni PR_NUMBER_PR=42 \
    PR_HEAD_SHA_PR="$head_sha" FAST_PATH_PR_JSON="$tmpdir/pr.json" \
    FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" FAST_PATH_FILES_JSON="$tmpdir/files.json" \
    FAST_PATH_REGISTRY_JSON="$REGISTRY" bash "$CLASSIFIER" >/dev/null
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

# A bad App signature is red.
write_fixtures 'cogni-operator[bot]' false
run_classifier "$tmpdir/unsigned.out"
[[ "$(value "$tmpdir/unsigned.out" invalid)" == true ]]
[[ "$(value "$tmpdir/unsigned.out" reason)" == invalid-commit-signature ]]

# Every operation is explicitly registered and disabled pending test-org proof.
jq -e '
  .version == "cogni.operator-change.v1"
  and ([.operations | keys[]] | sort) == (["deployment.declare","env.membership","env.placement","env.region","node.register"] | sort)
  and all(.operations[]; .enabledRepositories == [])
' "$REGISTRY" >/dev/null

echo "classify-operator-change-fast-path tests passed"
