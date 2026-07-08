#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Resolve promote-and-deploy targets from catalog + per-env overlays.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OVERLAY_ENV="${OVERLAY_ENV:?OVERLAY_ENV is required}"
NODES_INPUT="${NODES_INPUT:-}"

# shellcheck source=lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

json_array() {
  python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))'
}

emit_output() {
  local key="$1" value="$2"
  printf '%s=%s\n' "$key" "$value"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

if [[ -n "$NODES_INPUT" ]]; then
  IFS=',' read -r -a raw <<< "${NODES_INPUT// /}"
else
  raw=("${ALL_TARGETS[@]}")
fi

# task.5017 — deploy ⊆ provisioned. A target promotes to OVERLAY_ENV only if its
# catalog `envs:` node-set lists it (the same SSOT render-node-appset.sh gates on).
# This is what stops promote-to-preview from selecting a node whose preview
# AppSet was never rendered (which would hard-fail the appset-apply step).
# CATALOG_IS_SSOT: read the catalog from COGNI_CATALOG_ROOT (the same root
# image-tags.sh sourced ALL_TARGETS/NODE_TARGETS from), not a hardcoded path, so
# a pre-merge birth flow / test fixture pointing at a checkout is honored here too.
CATALOG_ROOT="${COGNI_CATALOG_ROOT:-$REPO_ROOT/infra/catalog}"
target_in_env() {
  local target="$1" catalog_file="$CATALOG_ROOT/${target}.yaml" envs
  [[ -f "$catalog_file" ]] || return 0  # non-catalog target: leave to overlay gate
  [[ "$(yq -r 'has("envs")' "$catalog_file")" == "true" ]] || return 0
  envs="$(yq -r '.envs[]' "$catalog_file")"
  grep -qxF "$OVERLAY_ENV" <<<"$envs"
}

list=()
skipped=()
for target in "${raw[@]}"; do
  [[ -n "$target" ]] || continue
  if target_in_env "$target" && [[ -d "$REPO_ROOT/infra/k8s/overlays/${OVERLAY_ENV}/${target}" ]]; then
    list+=("$target")
  else
    skipped+=("$target")
  fi
done

if [[ "${#skipped[@]}" -gt 0 ]]; then
  echo "::warning::Skipping targets not in the ${OVERLAY_ENV} node-set (catalog envs:) or without a ${OVERLAY_ENV} overlay: ${skipped[*]}"
fi

if [[ "${#list[@]}" -eq 0 ]]; then
  echo "::warning::No k8s targets to promote for ${OVERLAY_ENV} (all inputs lack an overlay under infra/k8s/overlays/${OVERLAY_ENV}/) — no-op."
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Promote no-op — no k8s targets for \`${OVERLAY_ENV}\`"
      echo "All requested targets lack a per-env overlay; nothing to deploy."
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  emit_output targets_json "[]"
  emit_output has_targets "false"
  emit_output node_targets_json "[]"
  emit_output has_node_targets "false"
  exit 0
fi

declare -A node_target_set=()
for target in "${NODE_TARGETS[@]}"; do
  node_target_set["$target"]=1
done

node_list=()
for target in "${list[@]}"; do
  if [[ -n "${node_target_set[$target]:-}" ]]; then
    node_list+=("$target")
  fi
done

targets_json="$(printf '%s\n' "${list[@]}" | json_array)"
node_targets_json="$(printf '%s\n' "${node_list[@]}" | json_array)"
has_node_targets=false
[[ "${#node_list[@]}" -gt 0 ]] && has_node_targets=true

emit_output targets_json "$targets_json"
emit_output has_targets "true"
emit_output node_targets_json "$node_targets_json"
emit_output has_node_targets "$has_node_targets"

echo "Targets: ${list[*]}"
echo "Node substrate targets: ${node_list[*]:-(none)}"
