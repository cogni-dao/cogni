#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/candidate-flight.yml"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Execute the real workflow steps against affected-set fixtures. No copied
# selection implementation and no GitHub, provider, or cluster calls.
yq -r '.jobs.decide.steps[] | select(.id == "flight-targets") | .run' "$WORKFLOW" > "$work/combine.sh"
check_scope() {
  local name="$1" node="$2" pr="$3" affected="$4" has_parent="$5" expected="$6" images="$7"
  local output="$work/$name.out"
  NODE_SLUG="$node" RESOLVED_PR_NUMBER="$pr" \
    NORMAL_FLIGHT_TARGETS_JSON="$affected" HAS_PARENT_TARGETS="$has_parent" \
    REMOTE_SOURCE_ARTIFACT_TARGETS_JSON='[]' HAS_REMOTE_SOURCE_ARTIFACT_TARGETS=false \
    BASE_SHA='' GITHUB_OUTPUT="$output" bash "$work/combine.sh"
  local actual
  actual=$(sed -n 's/^flight_targets_json=//p' "$output" | jq -c .)
  [[ "$actual" == "$expected" ]] || { echo "[FAIL] $name targets: $actual"; exit 1; }
  grep -qx "has_image_inputs=$images" "$output"
  if [[ "$expected" == '[]' ]]; then
    grep -qx 'has_flight_targets=false' "$output"
  else
    grep -qx 'has_flight_targets=true' "$output"
  fi
  echo "[PASS] $name"
}

check_scope ci-only operator 2780 '[]' false '[]' false
check_scope infra-only operator 2780 '[]' true '[]' true
check_scope app-change operator 2780 '["operator"]' true '["operator"]' true
check_scope other-app operator 2780 '["poly"]' true '["poly"]' true
check_scope standalone-node poly '' '[]' false '["poly"]' true

# Real app targets still fail closed when their requested image is absent.
yq -r '.jobs.decide.steps[] | select(.name == "Require requested node image") | .run' "$WORKFLOW" > "$work/require-image.sh"
printf '{"targets":[{"target":"litellm"}]}\n' > "$work/images.json"
if NODE=operator PAYLOAD_FILE="$work/images.json" bash "$work/require-image.sh" > "$work/missing.log" 2>&1; then
  echo '[FAIL] missing requested app image was accepted'
  exit 1
fi
grep -q 'Requested node image is not available yet: operator' "$work/missing.log"
printf '{"targets":[{"target":"operator"}]}\n' > "$work/images.json"
NODE=operator PAYLOAD_FILE="$work/images.json" bash "$work/require-image.sh"
echo '[PASS] requested app image remains mandatory for an affected app'

# Production's exact explicit source must reach the pin writer, while an
# incidental catalog selection must keep its existing rollback fence.
promote="$REPO_ROOT/.github/workflows/promote-and-deploy.yml"
yq -r '.jobs.promote-k8s.steps[] | select(.name == "Record external workload source-sha") | .run' "$promote" > "$work/pin.sh"
mkdir -p "$work/ci-src/scripts/ci" "$work/app-src/infra/catalog" "$work/deploy-branch/.promote-state"
ln -s "$REPO_ROOT/scripts/ci/update-source-sha-map.sh" "$work/ci-src/scripts/ci/update-source-sha-map.sh"
birth=1111111111111111111111111111111111111111
prior=2222222222222222222222222222222222222222
printf 'source_sha: %s\n' "$birth" > "$work/app-src/infra/catalog/poly.yaml"
for explicit in '' 3333333333333333333333333333333333333333 "$birth"; do
  printf '{"poly":"%s","operator":"retained"}\n' "$prior" > "$work/deploy-branch/.promote-state/source-sha-by-app.json"
  result=0
  (cd "$work/deploy-branch"; APP=poly NODE=poly SOURCE_SHA="$birth" NODE_SOURCE_SHA="$explicit" bash "$work/pin.sh") > "$work/pin.log" 2>&1 || result=$?
  if [[ "$explicit" == "$birth" ]]; then
    [[ "$result" == 0 ]] || { cat "$work/pin.log"; exit 1; }
    jq -e --arg sha "$birth" '.poly == $sha and .operator == "retained"' "$work/deploy-branch/.promote-state/source-sha-by-app.json" >/dev/null
  else
    [[ "$result" != 0 ]] || { echo '[FAIL] implicit birth regression accepted'; exit 1; }
    grep -q PIN_REGRESSION_REFUSED "$work/pin.log"
    jq -e --arg sha "$prior" '.poly == $sha' "$work/deploy-branch/.promote-state/source-sha-by-app.json" >/dev/null
  fi
done
echo '[PASS] only exact source-addressed promotions may deliberately select birth metadata'

# Preview must recognize a CI-only affected set before probing globally cached
# infra images, and report the no-op without asserting that a deploy happened.
preview="$REPO_ROOT/.github/workflows/flight-preview.yml"
yq -r '.jobs.flight.steps[] | select(.name == "Detect affected artifact inputs") | .run' "$preview" > "$work/preview-scope.sh"
printf 'scripts/ci/aggregate-rollup.sh\n.github/workflows/candidate-flight.yml\n' > "$work/paths.txt"
CHANGED_PATHS_FILE="$work/paths.txt" GITHUB_OUTPUT="$work/preview-scope.out" bash "$work/preview-scope.sh" > "$work/preview-scope.log"
grep -qx 'has_targets=false' "$work/preview-scope.out"
yq -r '.jobs.flight.steps[] | select(.id == "noop") | .run' "$preview" > "$work/noop.sh"
GITHUB_OUTPUT="$work/noop.out" GITHUB_STEP_SUMMARY="$work/noop-summary.md" bash "$work/noop.sh"
grep -qx 'status=noop' "$work/noop.out"
grep -q 'nothing deployed' "$work/noop-summary.md"
echo '[PASS] CI-only preview scope is an explicit no-op'

# The selected preview or target branch must be present before the shared writer reads it.
prepare_line=$(grep -n 'name: Prepare per-node deploy branch' "$promote" | cut -d: -f1)
materialize_line=$(grep -n 'name: Materialize provider-neutral external workload' "$promote" | cut -d: -f1)
sync_line=$(grep -n 'name: Sync infra/k8s + per-node catalog' "$promote" | cut -d: -f1)
[[ "$prepare_line" -lt "$materialize_line" && "$materialize_line" -lt "$sync_line" ]]
overlay=$(yq -r '.jobs.promote-k8s.steps[] | select(.name == "Materialize provider-neutral external workload") | .with.accepted_overlay_dir' "$promote")
[[ "$overlay" == *'preview-src/infra/k8s/overlays/preview/'* && "$overlay" == *'deploy-branch/infra/k8s/overlays/'* ]]
# Candidate's existing shared action invocation must stay valid without the optional input.
yq -e '.jobs | .. | select(tag == "!!map" and has("uses")) | select(.uses | contains("materialize-compute-workload")) | .with | has("accepted_overlay_dir") | not' "$WORKFLOW" >/dev/null
echo '[PASS] replay reads the selected deploy overlay before syncing; candidate needs no new input'

# Run the actual digest step with a missing app tag. Akash must not inspect it;
# the explicitly requested k3s target must still fail its image lookup.
yq -r '.jobs.promote-k8s.steps[] | select(.id == "digest") | .run' "$promote" > "$work/digest.sh"
mkdir -p "$work/app-src/scripts/ci/lib" "$work/bin"
ln -s "$REPO_ROOT/scripts/ci/lib/image-tags.sh" "$work/app-src/scripts/ci/lib/image-tags.sh"
cat > "$work/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
exit 1
DOCKER
chmod +x "$work/bin/docker"
for provider in akash k3s; do
  result=0
  (cd "$work"; PATH="$work/bin:$PATH" DOCKER_CALLS="$work/docker.calls" \
    COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" NODE=operator \
    DEPLOYMENT_PROVIDER="$provider" PREVIEW_FORWARD=false BUILD_SHA="$birth" \
    NODE_SOURCE_SHA='' OPERATOR_SOURCE_SHA="$birth" CATALOG_SOURCE_SHA='' \
    PREVIEW_SOURCE_SHA_MAP='' EXPLICIT_TARGETS=operator GITHUB_OUTPUT="$work/$provider.out" \
    bash "$work/digest.sh") > "$work/$provider.log" 2>&1 || result=$?
  if [[ "$provider" == akash ]]; then
    [[ "$result" == 0 && ! -e "$work/docker.calls" ]] || { cat "$work/$provider.log"; exit 1; }
    grep -qx 'promoted=true' "$work/$provider.out"
  else
    [[ "$result" != 0 && -s "$work/docker.calls" ]] || { cat "$work/$provider.log"; exit 1; }
    grep -q 'Image not found' "$work/$provider.log"
  fi
done
echo '[PASS] Akash skips unused app tag; k3s requires its image'
