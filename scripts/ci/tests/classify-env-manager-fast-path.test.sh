#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLASSIFIER="$REPO_ROOT/scripts/ci/classify-env-manager-fast-path.sh"
tmpdir="$(mktemp -d)"
cleanup() {
  local exit_code=$?
  rm -rf "$tmpdir"
  trap - EXIT
  exit "$exit_code"
}
trap cleanup EXIT

head_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
base_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
repository='Cogni-DAO/cogni'
bot_login='cogni-operator[bot]'
bot_id=265189974
control_env=production
export FLEET_CONTROL_ENV="$control_env"
mkdir -p "$tmpdir/catalog"
base_catalog="$tmpdir/base-catalog.yaml"
head_catalog="$tmpdir/head-catalog.yaml"
cat > "$base_catalog" <<'YAML'
name: blue
source_repo: https://github.com/cogni-dao/blue.git
image_repository: ghcr.io/cogni-dao/blue
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
compute_api:
  candidate-a: node-deploy
activity_env: candidate-a
YAML
cat > "$head_catalog" <<'YAML'
name: blue
source_repo: https://github.com/cogni-dao/blue.git
image_repository: ghcr.io/cogni-dao/blue
envs: [candidate-a, preview]
deployment_provider:
  candidate-a: akash
  preview: akash
compute_api:
  candidate-a: node-deploy
  preview: node-deploy
activity_env: preview
YAML
cp "$head_catalog" "$tmpdir/catalog/blue.yaml"
paths_file="$tmpdir/paths.txt"
# story.5137: the env verb writes the catalog row (plus scheduler routing, below);
# the node-deploy sequencer is the lane writer, so there is no AppSet or overlay.
printf '%s\n' 'infra/catalog/blue.yaml' > "$paths_file"
paths_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"

write_fixtures() {
  local message="$1"
  jq -n \
    --arg sha "$head_sha" \
    --arg base_sha "$base_sha" \
    --arg repository "$repository" \
    --arg bot_login "$bot_login" \
    --argjson bot_id "$bot_id" \
    '{state:"open",base:{ref:"main",sha:$base_sha},head:{sha:$sha,ref:"cogni-operator/node-env-blue-preview",repo:{full_name:$repository}},user:{login:$bot_login,id:$bot_id,type:"Bot"},commits:1}' \
    > "$tmpdir/pr.json"
  jq -n \
    --arg sha "$head_sha" \
    --arg message "$message" \
    --arg bot_login "$bot_login" \
    --argjson bot_id "$bot_id" \
    '{sha:$sha,author:{login:$bot_login,id:$bot_id},parents:[{sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],commit:{message:$message,verification:{verified:true,reason:"valid"}}}' \
    > "$tmpdir/commit.json"
  jq -Rn '[inputs | {filename:.,previous_filename:null,status:"modified"}]' \
    < "$paths_file" > "$tmpdir/files.json"
}

run_classifier() {
  local output="$1"
  GITHUB_OUTPUT="$output" \
  EVENT_NAME=pull_request \
  REPOSITORY="$repository" \
  PR_NUMBER_PR=42 \
  PR_HEAD_SHA_PR="$head_sha" \
  CATALOG_DIR="$tmpdir/catalog" \
  FAST_PATH_PR_JSON="$tmpdir/pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
  FAST_PATH_FILES_JSON="$tmpdir/files.json" \
  FAST_PATH_BASE_CATALOG="${FAST_PATH_TEST_BASE_CATALOG:-$base_catalog}" \
  FAST_PATH_HEAD_CATALOG="${FAST_PATH_TEST_HEAD_CATALOG:-$head_catalog}" \
  FAST_PATH_APPSET_PATHS_LIB="$REPO_ROOT/scripts/ci/lib/appset-paths.sh" \
    bash "$CLASSIFIER" >/dev/null
}

valid_message="feat(node): add blue to preview

Cogni-Change-Type: cogni.env-manager.v1
Cogni-Node: blue
Cogni-Environment: preview
Cogni-Action: add
Cogni-Changed-Paths-SHA256: $paths_hash"

write_fixtures "$valid_message"
run_classifier "$tmpdir/valid.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/valid.out")" == true ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/valid.out")" == true ]]

# Custodied routing may touch only the derived control worker, never another lane.
cp "$paths_file" "$tmpdir/original-paths.txt"
printf '%s\n' "infra/k8s/overlays/$control_env/scheduler-worker/node-endpoints.patch.yaml" >> "$paths_file"
LC_ALL=C sort -u "$paths_file" > "$tmpdir/with-custody.txt"
mv "$tmpdir/with-custody.txt" "$paths_file"
custody_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
write_fixtures "${valid_message/$paths_hash/$custody_hash}"
run_classifier "$tmpdir/custody.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/custody.out")" == true ]]
sed 's#overlays/production/scheduler-worker#overlays/candidate-a/scheduler-worker#' "$paths_file" > "$tmpdir/foreign-paths.txt"
LC_ALL=C sort -u "$tmpdir/foreign-paths.txt" > "$paths_file"
foreign_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
write_fixtures "${valid_message/$paths_hash/$foreign_hash}"
run_classifier "$tmpdir/foreign-routing.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/foreign-routing.out")" == path-outside-env-manager-boundary ]]
cp "$tmpdir/original-paths.txt" "$paths_file"

# The production-shaped E2E repository trusts only its dedicated test App.
repository='cogni-test-org/cogni-monorepo'
bot_login='cogni-operator-test[bot]'
bot_id=290565426
write_fixtures "$valid_message"
run_classifier "$tmpdir/test-app.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/test-app.out")" == true ]]

# A correctly signed production App commit does not inherit authority in test.
bot_login='cogni-operator[bot]'
bot_id=265189974
write_fixtures "$valid_message"
run_classifier "$tmpdir/wrong-app.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/wrong-app.out")" == false ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/wrong-app.out")" == false ]]

repository='Cogni-DAO/cogni'
bot_login='cogni-operator[bot]'
bot_id=265189974

# The inverse remove is eligible only when it preserves the non-target row and
# does not remove the activity authority.
remove_base_catalog="$tmpdir/remove-base-catalog.yaml"
remove_head_catalog="$tmpdir/remove-head-catalog.yaml"
sed 's/activity_env: preview/activity_env: candidate-a/' "$head_catalog" > "$remove_base_catalog"
cp "$base_catalog" "$remove_head_catalog"
remove_message="feat(node): remove blue from preview

Cogni-Change-Type: cogni.env-manager.v1
Cogni-Node: blue
Cogni-Environment: preview
Cogni-Action: remove
Cogni-Changed-Paths-SHA256: $paths_hash"
write_fixtures "$remove_message"
cp "$remove_head_catalog" "$tmpdir/catalog/blue.yaml"
FAST_PATH_TEST_BASE_CATALOG="$remove_base_catalog" \
FAST_PATH_TEST_HEAD_CATALOG="$remove_head_catalog" \
  run_classifier "$tmpdir/remove.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/remove.out")" == true ]]
cp "$head_catalog" "$tmpdir/catalog/blue.yaml"

# A foreign-custody membership plan contains the catalog row plus BOTH lane and
# control scheduler patches (three paths).
cp "$paths_file" "$tmpdir/membership-only-paths.txt"
printf '%s\n' \
  'infra/k8s/overlays/preview/scheduler-worker/node-endpoints.patch.yaml' \
  "infra/k8s/overlays/$control_env/scheduler-worker/node-endpoints.patch.yaml" >> "$paths_file"
LC_ALL=C sort -u "$paths_file" > "$tmpdir/seven-paths.txt"
cp "$tmpdir/seven-paths.txt" "$paths_file"
[[ "$(wc -l < "$paths_file" | tr -d ' ')" == 3 ]]
seven_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
write_fixtures "${valid_message/$paths_hash/$seven_hash}"
run_classifier "$tmpdir/seven-add.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/seven-add.out")" == true ]]

write_fixtures "${remove_message/$paths_hash/$seven_hash}"
cp "$remove_head_catalog" "$tmpdir/catalog/blue.yaml"
FAST_PATH_TEST_BASE_CATALOG="$remove_base_catalog" \
FAST_PATH_TEST_HEAD_CATALOG="$remove_head_catalog" \
  run_classifier "$tmpdir/seven-remove.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/seven-remove.out")" == true ]]
cp "$head_catalog" "$tmpdir/catalog/blue.yaml"

# Even a correctly signed four-path claim exceeds this bounded capability; the
# tree is authentic, so it falls back to full CI rather than failing.
printf '%s\n' 'infra/k8s/overlays/candidate-a/scheduler-worker/node-endpoints.patch.yaml' >> "$paths_file"
LC_ALL=C sort -u "$paths_file" > "$tmpdir/eight-paths.txt"
cp "$tmpdir/eight-paths.txt" "$paths_file"
eight_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
write_fixtures "${valid_message/$paths_hash/$eight_hash}"
run_classifier "$tmpdir/eight.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/eight.out")" == invalid-file-metadata ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/eight.out")" == false ]]

# Staying within three paths cannot authorize an unrelated control environment.
sed "s#overlays/$control_env/scheduler-worker/#overlays/candidate-a/scheduler-worker/#" \
  "$tmpdir/seven-paths.txt" | LC_ALL=C sort -u > "$paths_file"
foreign_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
write_fixtures "${valid_message/$paths_hash/$foreign_hash}"
run_classifier "$tmpdir/foreign-control.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/foreign-control.out")" == path-outside-env-manager-boundary ]]
cp "$tmpdir/membership-only-paths.txt" "$paths_file"

# NEGATIVE (story.5137): the retired AppSet/overlay shape is outside the boundary.
# A signed but unmatched tree falls back to full CI (claimed=false), never exit 1.
printf '%s\n' \
  'infra/catalog/blue.yaml' \
  "infra/k8s/argocd/appsets/$control_env/preview-blue-applicationset.yaml" > "$paths_file"
legacy_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
write_fixtures "${valid_message/$paths_hash/$legacy_hash}"
run_classifier "$tmpdir/legacy-appset.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/legacy-appset.out")" == path-outside-env-manager-boundary ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/legacy-appset.out")" == false ]]
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/legacy-appset.out")" == false ]]
cp "$tmpdir/membership-only-paths.txt" "$paths_file"

# NEGATIVE (story.5137): a crossplane cell or a lease_generation key is not the verb's
# output, so the delta is refused and the PR runs full CI.
crossplane_head_catalog="$tmpdir/crossplane-head-catalog.yaml"
sed 's/preview: node-deploy/preview: crossplane/' "$head_catalog" > "$crossplane_head_catalog"
write_fixtures "$valid_message"
FAST_PATH_TEST_HEAD_CATALOG="$crossplane_head_catalog" \
  run_classifier "$tmpdir/crossplane.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/crossplane.out")" == invalid-catalog-delta ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/crossplane.out")" == false ]]
lease_head_catalog="$tmpdir/lease-head-catalog.yaml"
printf 'lease_generation:\n  preview: 0\n' | cat "$head_catalog" - > "$lease_head_catalog"
FAST_PATH_TEST_HEAD_CATALOG="$lease_head_catalog" \
  run_classifier "$tmpdir/lease.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/lease.out")" == invalid-catalog-delta ]]

# NEGATIVE: an in-repo row (no source_repo) has no node-deploy lane to add.
inrepo_base_catalog="$tmpdir/inrepo-base-catalog.yaml"
inrepo_head_catalog="$tmpdir/inrepo-head-catalog.yaml"
grep -v '^source_repo:' "$base_catalog" > "$inrepo_base_catalog"
grep -v '^source_repo:' "$head_catalog" > "$inrepo_head_catalog"
FAST_PATH_TEST_BASE_CATALOG="$inrepo_base_catalog" \
FAST_PATH_TEST_HEAD_CATALOG="$inrepo_head_catalog" \
  run_classifier "$tmpdir/inrepo.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/inrepo.out")" == invalid-catalog-delta ]]

# A copied title without the reserved signed trailer stays on full CI.
write_fixtures 'feat(node): add blue to preview'
run_classifier "$tmpdir/unclaimed.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/unclaimed.out")" == false ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/unclaimed.out")" == false ]]

# A reserved claim with an invalid signature fails closed instead of falling back.
write_fixtures "$valid_message"
jq '.commit.verification.verified=false' "$tmpdir/commit.json" > "$tmpdir/commit-invalid.json"
mv "$tmpdir/commit-invalid.json" "$tmpdir/commit.json"
run_classifier "$tmpdir/unsigned.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/unsigned.out")" == false ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/unsigned.out")" == true ]]
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/unsigned.out")" == invalid-commit-signature ]]

# A valid App signature cannot smuggle an unrelated catalog edit through the
# narrow membership capability.
mutated_head_catalog="$tmpdir/mutated-head-catalog.yaml"
sed 's#cogni-dao/blue.git#attacker/blue.git#' "$head_catalog" > "$mutated_head_catalog"
write_fixtures "$valid_message"
FAST_PATH_TEST_HEAD_CATALOG="$mutated_head_catalog" \
  run_classifier "$tmpdir/catalog-mutation.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/catalog-mutation.out")" == invalid-catalog-delta ]]

# Placement PRs are a different capability and always run full CI.
write_fixtures "$valid_message"
jq '.head.ref="cogni-operator/node-placement-blue-preview"' "$tmpdir/pr.json" > "$tmpdir/pr-placement.json"
mv "$tmpdir/pr-placement.json" "$tmpdir/pr.json"
run_classifier "$tmpdir/placement.out"
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/placement.out")" == false ]]
[[ "$(awk -F= '$1=="claimed"{v=$2} END{print v}' "$tmpdir/placement.out")" == false ]]

# A valid signature cannot bless a file outside the env-manager boundary.
write_fixtures "$valid_message"
printf '%s\n' '.github/workflows/ci.yaml' >> "$paths_file"
LC_ALL=C sort -u "$paths_file" > "$tmpdir/paths-sorted.txt"
mv "$tmpdir/paths-sorted.txt" "$paths_file"
jq -Rn '[inputs | {filename:.,previous_filename:null,status:"modified"}]' \
  < "$paths_file" > "$tmpdir/files.json"
outside_hash="$(shasum -a 256 "$paths_file" | awk '{print $1}')"
sed "s/$paths_hash/$outside_hash/" "$tmpdir/commit.json" > "$tmpdir/commit-outside.json"
mv "$tmpdir/commit-outside.json" "$tmpdir/commit.json"
run_classifier "$tmpdir/outside.out"
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/outside.out")" == path-outside-env-manager-boundary ]]

# A merge-group ref carries the BASE sha, and the queue tree must contain
# exactly the signed PR path set.
grep -v '^\.github/workflows/ci\.yaml$' "$paths_file" > "$tmpdir/paths-restored.txt"
mv "$tmpdir/paths-restored.txt" "$paths_file"
write_fixtures "$valid_message"
queue_repo="$tmpdir/queue-repo"
mkdir -p "$queue_repo"
(
  cd "$queue_repo"
  git init -q
  git config user.email test@example.test
  git config user.name test
  git commit --allow-empty -qm base
  queue_base_sha="$(git rev-parse HEAD)"
  while IFS= read -r changed_file; do
    mkdir -p "$(dirname "$changed_file")"
    printf 'generated\n' > "$changed_file"
  done < "$paths_file"
  git add .
  git commit -qm generated
  queue_head_sha="$(git rev-parse HEAD)"
  GITHUB_OUTPUT="$tmpdir/queue.out" \
  EVENT_NAME=merge_group \
  REPOSITORY=Cogni-DAO/cogni \
  MQ_HEAD_REF="refs/heads/gh-readonly-queue/main/pr-42-$queue_base_sha" \
  MQ_BASE_SHA="$queue_base_sha" \
  MQ_HEAD_SHA="$queue_head_sha" \
  CATALOG_DIR="$tmpdir/catalog" \
  FAST_PATH_PR_JSON="$tmpdir/pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
  FAST_PATH_FILES_JSON="$tmpdir/files.json" \
  FAST_PATH_BASE_CATALOG="$base_catalog" \
  FAST_PATH_HEAD_CATALOG="$head_catalog" \
  FAST_PATH_APPSET_PATHS_LIB="$REPO_ROOT/scripts/ci/lib/appset-paths.sh" \
    bash "$CLASSIFIER" >/dev/null

  # A queue tree with even one extra path must fail closed; batching two env
  # PRs would otherwise reintroduce shared-file lost updates.
  printf 'unrelated\n' > unrelated.txt
  git add unrelated.txt
  git commit -qm unrelated
  queue_extra_sha="$(git rev-parse HEAD)"
  GITHUB_OUTPUT="$tmpdir/queue-extra.out" \
  EVENT_NAME=merge_group \
  REPOSITORY=Cogni-DAO/cogni \
  MQ_HEAD_REF="refs/heads/gh-readonly-queue/main/pr-42-$queue_base_sha" \
  MQ_BASE_SHA="$queue_base_sha" \
  MQ_HEAD_SHA="$queue_extra_sha" \
  CATALOG_DIR="$tmpdir/catalog" \
  FAST_PATH_PR_JSON="$tmpdir/pr.json" \
  FAST_PATH_COMMIT_JSON="$tmpdir/commit.json" \
  FAST_PATH_FILES_JSON="$tmpdir/files.json" \
  FAST_PATH_BASE_CATALOG="$base_catalog" \
  FAST_PATH_HEAD_CATALOG="$head_catalog" \
  FAST_PATH_APPSET_PATHS_LIB="$REPO_ROOT/scripts/ci/lib/appset-paths.sh" \
    bash "$CLASSIFIER" >/dev/null
)
[[ "$(awk -F= '$1=="eligible"{v=$2} END{print v}' "$tmpdir/queue.out")" == true ]]
[[ "$(awk -F= '$1=="reason"{v=$2} END{print v}' "$tmpdir/queue-extra.out")" == merge-group-path-mismatch ]]

echo "classify-env-manager-fast-path tests passed"
