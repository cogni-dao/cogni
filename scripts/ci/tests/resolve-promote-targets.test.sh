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
GITHUB_OUTPUT="$out" OVERLAY_ENV=preview NODES_INPUT="please,scheduler-worker,litellm" \
  bash scripts/ci/resolve-promote-targets.sh > "$TMPROOT/stdout"

targets_json="$(awk -F= '$1 == "targets_json" {print substr($0, length($1) + 2)}' "$out")"
node_targets_json="$(awk -F= '$1 == "node_targets_json" {print substr($0, length($1) + 2)}' "$out")"
has_targets="$(awk -F= '$1 == "has_targets" {print $2}' "$out")"
has_node_targets="$(awk -F= '$1 == "has_node_targets" {print $2}' "$out")"

[[ "$targets_json" == '["please", "scheduler-worker"]' ]]
[[ "$node_targets_json" == '["please"]' ]]
[[ "$has_targets" == "true" ]]
[[ "$has_node_targets" == "true" ]]
grep -q "Skipping targets without preview overlay: litellm" "$TMPROOT/stdout"

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
