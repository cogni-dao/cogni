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

promote="$REPO_ROOT/.github/workflows/promote-and-deploy.yml"

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

# Run the actual digest step with a missing app tag. The explicitly requested
# k3s target (the operator lane) must fail its image lookup, never skip it.
yq -r '.jobs.promote-k8s.steps[] | select(.id == "digest") | .run' "$promote" > "$work/digest.sh"
mkdir -p "$work/app-src/scripts/ci/lib" "$work/bin"
ln -s "$REPO_ROOT/scripts/ci/lib/image-tags.sh" "$work/app-src/scripts/ci/lib/image-tags.sh"
cat > "$work/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
exit 1
DOCKER
chmod +x "$work/bin/docker"
sha=1111111111111111111111111111111111111111
result=0
(cd "$work"; PATH="$work/bin:$PATH" DOCKER_CALLS="$work/docker.calls" \
  COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" NODE=operator PREVIEW_FORWARD=false BUILD_SHA="$sha" \
  EXPLICIT_TARGETS=operator GITHUB_OUTPUT="$work/k3s.out" \
  bash "$work/digest.sh") > "$work/k3s.log" 2>&1 || result=$?
[[ "$result" != 0 && -s "$work/docker.calls" ]] || { cat "$work/k3s.log"; exit 1; }
grep -q 'Image not found' "$work/k3s.log"
echo '[PASS] an explicitly requested k3s target requires its image'
