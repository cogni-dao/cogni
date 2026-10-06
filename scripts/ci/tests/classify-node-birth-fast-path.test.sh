#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLASSIFIER="$REPO_ROOT/scripts/ci/classify-node-birth-fast-path.sh"
TRUSTED_PLAN_LIB="$REPO_ROOT/scripts/ci/lib/node-birth-fast-path-plan.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

head_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
base_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
source_sha='cccccccccccccccccccccccccccccccccccccccc'
node='blue'
node_id='11111111-2222-4333-8444-555555555555'
repository='Cogni-DAO/cogni'
bot_login='cogni-operator[bot]'
bot_id=265189974
fleet_org='cogni-dao'
export FLEET_CONTROL_ENV=production

paths_file="$tmpdir/paths.txt"
PLAN_LIB="$tmpdir/enabled-plan.sh"
cat > "$PLAN_LIB" <<'PLAN'
node_birth_fast_path_paths() {
  local node="$1" control_env="${FLEET_CONTROL_ENV:-production}"
  printf '%s\n' \
    "infra/catalog/${node}.yaml" \
    "infra/k8s/argocd/appsets/${control_env}/candidate-a-${node}-applicationset.yaml" \
    "infra/k8s/argocd/appsets/${control_env}/production-${node}-applicationset.yaml" \
    "infra/k8s/overlays/candidate-a/${node}/external-secret.yaml" \
    "infra/k8s/overlays/candidate-a/${node}/kustomization.yaml" \
    "infra/k8s/overlays/production/${node}/external-secret.yaml" \
    "infra/k8s/overlays/production/${node}/kustomization.yaml" | LC_ALL=C sort
}
PLAN
source "$PLAN_LIB"
node_birth_fast_path_paths "$node" > "$paths_file"

catalog="$tmpdir/catalog.yaml"
write_catalog() {
  cat > "$catalog" <<YAML
name: blue
type: node
port: 3200
node_port: 31900
dockerfile: nodes/blue/app/Dockerfile
image_tag_suffix: "-blue"
migrator_tag_suffix: "-blue-migrate"
source_repo: https://github.com/${fleet_org}/blue.git
image_repository: ghcr.io/${fleet_org}/blue
source_sha: ${source_sha}
candidate_a_branch: deploy/candidate-a-blue
preview_branch: deploy/preview-blue
production_branch: deploy/production-blue
envs: [candidate-a, production]
deployment_provider:
  candidate-a: akash
  production: akash
compute_api:
  candidate-a: crossplane
  production: crossplane
lease_generation:
  candidate-a: 0
  production: 0
activity_env: production
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
path_prefix: nodes/blue/
node_id: ${node_id}
YAML
}
write_catalog

paths_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$paths_file" | awk '{print $1}'
  else
    shasum -a 256 "$paths_file" | awk '{print $1}'
  fi
}

message() {
  cat <<MSG
feat(node): register blue

Cogni-Change-Type: cogni.node-birth.v1
Cogni-Node: blue
Cogni-Node-Id: ${node_id}
Cogni-Source-Repo: https://github.com/${fleet_org}/blue.git
Cogni-Source-SHA: ${source_sha}
Cogni-Base-SHA: ${base_sha}
Cogni-Changed-Paths-SHA256: $(paths_hash)
MSG
}

write_fixtures() {
  local commit_message="$1"
  jq -n \
    --arg sha "$head_sha" \
    --arg base_sha "$base_sha" \
    --arg repository "$repository" \
    --arg bot_login "$bot_login" \
    --argjson bot_id "$bot_id" \
    '{state:"open",base:{ref:"main",sha:$base_sha},head:{sha:$sha,ref:"cogni-operator/node-register-blue",repo:{full_name:$repository}},user:{login:$bot_login,id:$bot_id,type:"Bot"},commits:1}' \
    > "$tmpdir/pr.json"
  jq -n \
    --arg sha "$head_sha" \
    --arg base_sha "$base_sha" \
    --arg message "$commit_message" \
    --arg bot_login "$bot_login" \
    --argjson bot_id "$bot_id" \
    '{sha:$sha,author:{login:$bot_login,id:$bot_id},parents:[{sha:$base_sha}],commit:{message:$message,verification:{verified:true,reason:"valid"}}}' \
    > "$tmpdir/commit.json"
  jq -Rn '[inputs | {filename:.,previous_filename:null,status:"added"}]' \
    < "$paths_file" > "$tmpdir/files.json"
}

run_classifier() {
  local output="$1"
  GITHUB_OUTPUT="$output" \
  EVENT_NAME=pull_request \
  REPOSITORY="$repository" \
  PR_NUMBER_PR=42 \
  PR_HEAD_SHA_PR="$head_sha" \
  FAST_PATH_PR_JSON="$tmpdir/pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
  FAST_PATH_FILES_JSON="$tmpdir/files.json" \
  FAST_PATH_HEAD_CATALOG="$catalog" \
  FAST_PATH_BASE_CATALOG_ABSENT=true \
  FAST_PATH_BIRTH_PLAN_LIB="$PLAN_LIB" \
  FAST_PATH_SKIP_TREE_DIFF=1 \
  FAST_PATH_SKIP_GENERATED_REPLAY=1 \
    bash "$CLASSIFIER" >/dev/null
}

out_value() { awk -F= -v key="$2" '$1 == key { value=$2 } END { print value }' "$1"; }

write_fixtures "$(message)"
run_classifier "$tmpdir/valid.out"
[[ "$(out_value "$tmpdir/valid.out" eligible)" == true ]]
[[ "$(out_value "$tmpdir/valid.out" claimed)" == true ]]

# Even a structurally valid future plan is not eligible until trusted overlay
# and AppSet replay succeeds. The fixture tree intentionally carries no output.
GITHUB_OUTPUT="$tmpdir/replay-required.out" \
EVENT_NAME=pull_request \
REPOSITORY="$repository" \
PR_NUMBER_PR=42 \
PR_HEAD_SHA_PR="$head_sha" \
FAST_PATH_PR_JSON="$tmpdir/pr.json" \
FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
FAST_PATH_FILES_JSON="$tmpdir/files.json" \
FAST_PATH_HEAD_CATALOG="$catalog" \
FAST_PATH_BASE_CATALOG_ABSENT=true \
FAST_PATH_BIRTH_PLAN_LIB="$PLAN_LIB" \
FAST_PATH_SKIP_TREE_DIFF=1 \
  bash "$CLASSIFIER" >/dev/null
[[ "$(out_value "$tmpdir/replay-required.out" reason)" == missing-generated-overlay ]]

# The shipped main-branch plan is deliberately empty until isolation consumers
# land, so no current birth can accidentally inherit the shortcut.
GITHUB_OUTPUT="$tmpdir/disabled.out" \
EVENT_NAME=pull_request \
REPOSITORY="$repository" \
PR_NUMBER_PR=42 \
PR_HEAD_SHA_PR="$head_sha" \
FAST_PATH_PR_JSON="$tmpdir/pr.json" \
FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
FAST_PATH_FILES_JSON="$tmpdir/files.json" \
FAST_PATH_HEAD_CATALOG="$catalog" \
FAST_PATH_BASE_CATALOG_ABSENT=true \
FAST_PATH_BIRTH_PLAN_LIB="$TRUSTED_PLAN_LIB" \
FAST_PATH_SKIP_TREE_DIFF=1 \
FAST_PATH_SKIP_GENERATED_REPLAY=1 \
  bash "$CLASSIFIER" >/dev/null
[[ "$(out_value "$tmpdir/disabled.out" reason)" == trusted-plan-empty ]]

# The isolated E2E parent trusts only its dedicated test App and org.
repository='cogni-test-org/cogni-monorepo'
bot_login='cogni-operator-test[bot]'
bot_id=290565426
fleet_org='cogni-test-org'
write_catalog
write_fixtures "$(message)"
run_classifier "$tmpdir/test-app.out"
[[ "$(out_value "$tmpdir/test-app.out" eligible)" == true ]]

repository='Cogni-DAO/cogni'
bot_login='cogni-operator[bot]'
bot_id=265189974
fleet_org='cogni-dao'
write_catalog

# A human second commit without the reserved trailer takes ordinary CI/queue.
write_fixtures 'fix(node): human repair'
jq '.commits=2' "$tmpdir/pr.json" > "$tmpdir/pr.tmp" && mv "$tmpdir/pr.tmp" "$tmpdir/pr.json"
run_classifier "$tmpdir/human.out"
[[ "$(out_value "$tmpdir/human.out" eligible)" == false ]]
[[ "$(out_value "$tmpdir/human.out" claimed)" == false ]]

# Once the reserved type is claimed, invalid signatures fail closed.
write_fixtures "$(message)"
jq '.commit.verification.verified=false' "$tmpdir/commit.json" > "$tmpdir/commit.tmp" && mv "$tmpdir/commit.tmp" "$tmpdir/commit.json"
run_classifier "$tmpdir/signature.out"
[[ "$(out_value "$tmpdir/signature.out" reason)" == invalid-commit-signature ]]

# Stale base/parent identity cannot inherit a prior green classification.
write_fixtures "$(message)"
jq '.base.sha="dddddddddddddddddddddddddddddddddddddddd"' "$tmpdir/pr.json" > "$tmpdir/pr.tmp" && mv "$tmpdir/pr.tmp" "$tmpdir/pr.json"
run_classifier "$tmpdir/stale-base.out"
[[ "$(out_value "$tmpdir/stale-base.out" reason)" == invalid-pr-identity ]]

# Current broad births and any other runtime/shared path are never eligible.
printf '%s\n' 'nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts' >> "$paths_file"
LC_ALL=C sort -u "$paths_file" > "$tmpdir/paths.tmp" && mv "$tmpdir/paths.tmp" "$paths_file"
write_fixtures "$(message)"
run_classifier "$tmpdir/runtime-path.out"
[[ "$(out_value "$tmpdir/runtime-path.out" reason)" == path-plan-mismatch ]]

# Restore the trusted plan, then prove semantic catalog drift is red.
node_birth_fast_path_paths "$node" > "$paths_file"
write_fixtures "$(message)"
yq '.lease_generation.production = 2' "$catalog" > "$tmpdir/catalog.tmp" && mv "$tmpdir/catalog.tmp" "$catalog"
run_classifier "$tmpdir/catalog-drift.out"
[[ "$(out_value "$tmpdir/catalog-drift.out" reason)" == invalid-birth-catalog ]]

echo "classify-node-birth-fast-path tests passed"
