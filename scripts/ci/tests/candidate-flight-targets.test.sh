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
