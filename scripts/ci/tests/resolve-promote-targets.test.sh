#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT="$(mktemp -d -t resolve-promote-targets.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

out="$TMPROOT/github-output"
# operator is in preview's node-set (envs); scheduler-worker is its preview
# service; litellm is type:infra (no overlay, no envs) → skipped.
GITHUB_OUTPUT="$out" OVERLAY_ENV=preview NODES_INPUT="operator,scheduler-worker,litellm" \
  bash scripts/ci/resolve-promote-targets.sh > "$TMPROOT/stdout"

targets_json="$(awk -F= '$1 == "targets_json" {print substr($0, length($1) + 2)}' "$out")"
node_targets_json="$(awk -F= '$1 == "node_targets_json" {print substr($0, length($1) + 2)}' "$out")"
has_targets="$(awk -F= '$1 == "has_targets" {print $2}' "$out")"
has_node_targets="$(awk -F= '$1 == "has_node_targets" {print $2}' "$out")"

[[ "$targets_json" == '["operator", "scheduler-worker"]' ]]
[[ "$node_targets_json" == '["operator"]' ]]
[[ "$has_targets" == "true" ]]
[[ "$has_node_targets" == "true" ]]
grep -q "Skipping targets not in the preview node-set" "$TMPROOT/stdout"

# task.5017 falsifying gate: deploy ⊆ provisioned must SKIP a node for an env
# outside its catalog `envs:` node-set, yet KEEP it for an env that is in-set.
# Every real catalog node is now all-envs (node-template opted into production in
# story.5009), so this guard is exercised against a SYNTHETIC catalog where
# node-template is restricted to [candidate-a, preview] — testing the enforcement
# logic with controlled input, decoupled from any real node's live envs.
RESTRICTED_CATALOG="$TMPROOT/restricted-catalog"
cp -r infra/catalog "$RESTRICTED_CATALOG"
yq -i '.envs = ["candidate-a", "preview"]' "$RESTRICTED_CATALOG/node-template.yaml"

# production is NOT in node-template's restricted node-set → must be skipped.
: > "$out"
GITHUB_OUTPUT="$out" OVERLAY_ENV=production NODES_INPUT="node-template" \
  COGNI_CATALOG_ROOT="$RESTRICTED_CATALOG" \
  bash scripts/ci/resolve-promote-targets.sh > "$TMPROOT/offset-stdout"
[[ "$(awk -F= '$1 == "has_targets" {print $2}' "$out")" == "false" ]]
grep -q "Skipping targets not in the production node-set" "$TMPROOT/offset-stdout"

# candidate-a IS in the restricted node-set → must be kept.
: > "$out"
GITHUB_OUTPUT="$out" OVERLAY_ENV=candidate-a NODES_INPUT="node-template" \
  COGNI_CATALOG_ROOT="$RESTRICTED_CATALOG" \
  bash scripts/ci/resolve-promote-targets.sh > "$TMPROOT/canda-stdout"
[[ "$(awk -F= '$1 == "targets_json" {print substr($0, length($1) + 2)}' "$out")" == '["node-template"]' ]]

: > "$out"
GITHUB_OUTPUT="$out" OVERLAY_ENV=preview NODES_INPUT="scheduler-worker" \
  bash scripts/ci/resolve-promote-targets.sh > "$TMPROOT/service-only-stdout"

targets_json="$(awk -F= '$1 == "targets_json" {print substr($0, length($1) + 2)}' "$out")"
node_targets_json="$(awk -F= '$1 == "node_targets_json" {print substr($0, length($1) + 2)}' "$out")"
has_targets="$(awk -F= '$1 == "has_targets" {print $2}' "$out")"
has_node_targets="$(awk -F= '$1 == "has_node_targets" {print $2}' "$out")"

[[ "$targets_json" == '["scheduler-worker"]' ]]
[[ "$node_targets_json" == '[]' ]]
[[ "$has_targets" == "true" ]]
[[ "$has_node_targets" == "false" ]]

echo "PASS: resolve-promote-targets.test.sh"
