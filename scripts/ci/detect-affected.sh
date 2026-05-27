#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/detect-affected.sh
# Purpose: Compute deployable image targets affected by the current SCM scope.
# Scope: PR image builds. Mirrors the same base/head resolution used by
#        scripts/run-turbo-checks.sh so image selection follows the recovered
#        trunk-affected model rather than a separate branch heuristic.

set -euo pipefail

# Canonical target catalog (bug.0328 architectural follow-up). One edit
# to add a node, everywhere — see scripts/ci/lib/image-tags.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
EXPLICIT_SCOPE=false
UPSTREAM_REF=${TURBO_SCM_BASE:-}
HEAD_REF=${TURBO_SCM_HEAD:-HEAD}

if [ -n "${TURBO_SCM_BASE:-}" ] || [ -n "${TURBO_SCM_HEAD:-}" ]; then
  EXPLICIT_SCOPE=true
fi

if [ -z "$UPSTREAM_REF" ]; then
  UPSTREAM_REF=$(git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || true)
fi

if [ -z "$UPSTREAM_REF" ] && git show-ref --verify --quiet refs/remotes/origin/main; then
  UPSTREAM_REF="origin/main"
fi

use_affected=false
if [ "$EXPLICIT_SCOPE" = true ]; then
  use_affected=true
elif [ -n "$UPSTREAM_REF" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  use_affected=true
fi

scope_mode="full"
scope_base=""
selection_reason="default-full-scope"
changed_paths=""

# CHANGED_PATHS_FILE: callers may pre-compute the authoritative
# changed-paths list (e.g. from the GitHub PR `files` API) and pass it
# here. Preferred over `git diff <base>...HEAD` for PR-flight workflows
# because git's merge-base diff includes orphaned commits when this
# branch was forked from a sibling branch that was later squash-merged
# into main — those commits stay reachable from HEAD and pollute the
# diff with paths the PR never actually changed.
if [ -n "${CHANGED_PATHS_FILE:-}" ] && [ -f "${CHANGED_PATHS_FILE}" ]; then
  scope_mode="affected"
  scope_base="pr-files"
  selection_reason="pr-files-api"
  changed_paths=$(tr -d '\r' < "${CHANGED_PATHS_FILE}")
elif [ "$use_affected" = true ]; then
  scope_mode="affected"
  scope_base="$UPSTREAM_REF"
  selection_reason="affected-scope"
  changed_paths=$(git diff --name-only "${scope_base}...${HEAD_REF}" | tr -d '\r')
fi

selected_targets=()

has_target() {
  local needle="$1"
  local existing

  for existing in "${selected_targets[@]}"; do
    if [ "$existing" = "$needle" ]; then
      return 0
    fi
  done

  return 1
}

add_target() {
  local target="$1"

  if ! has_target "$target"; then
    selected_targets+=("$target")
  fi
}

add_all_targets() {
  local target

  for target in "${ALL_TARGETS[@]}"; do
    add_target "$target"
  done
}

is_global_build_input() {
  local path="$1"

  case "$path" in
    .dockerignore | \
    package.json | \
    pnpm-lock.yaml | \
    pnpm-workspace.yaml | \
    turbo.json | \
    tsconfig.json | \
    tsconfig.base.json | \
    tsconfig.app.json | \
    tsconfig.scripts.json | \
    config/* | \
    infra/catalog/* | \
    scripts/ci/build-and-push-images.sh | \
    scripts/ci/detect-affected.sh | \
    scripts/ci/lib/image-tags.sh | \
    scripts/ci/write-build-manifest.sh)
      return 0
      ;;
  esac

  return 1
}

if [ "$scope_mode" = "full" ]; then
  add_all_targets
else
  declare -A target_prefix=()
  for target in "${ALL_TARGETS[@]}"; do
    target_prefix["$target"]=$(yq '.path_prefix' "${_image_tags_catalog_root}/${target}.yaml")
  done

  while IFS= read -r path; do
    [ -z "$path" ] && continue

    if is_global_build_input "$path"; then
      add_all_targets
      selection_reason="global-build-input:${path}"
      break
    fi

    case "$path" in
      .github/workflows/pr-build.yml)
        add_all_targets
        selection_reason="workflow-build-change:${path}"
        break
        ;;
      packages/*)
        add_all_targets
        selection_reason="shared-package-change:${path}"
        break
        ;;
      nodes/node-template/*)
        selection_reason="non-deployable-node-template-change:${path}"
        ;;
      *)
        for target in "${ALL_TARGETS[@]}"; do
          prefix="${target_prefix[$target]}"
          case "$path" in
            "${prefix}"*) add_target "$target" ;;
            "infra/k8s/overlays/"*"/${target}/"*) add_target "$target" ;;
            "infra/k8s/base/${target}/"*) add_target "$target" ;;
          esac
        done
        ;;
    esac
  done <<< "$changed_paths"
fi

ordered_targets=()
for target in "${ALL_TARGETS[@]}"; do
  if has_target "$target"; then
    ordered_targets+=("$target")
  fi
done

targets_csv=""
targets_json="[]"
if [ ${#ordered_targets[@]} -gt 0 ]; then
  targets_csv=$(IFS=,; echo "${ordered_targets[*]}")
  # Emit a JSON array so pr-build.yml can feed a matrix via fromJson().
  targets_json=$(printf '%s\n' "${ordered_targets[@]}" \
    | python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))')
fi

changed_paths_count=0
if [ -n "$changed_paths" ]; then
  changed_paths_count=$(printf "%s\n" "$changed_paths" | sed '/^$/d' | wc -l | tr -d ' ')
fi

has_targets=false
if [ ${#ordered_targets[@]} -gt 0 ]; then
  has_targets=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "scope_mode=$scope_mode"
    echo "scope_base=$scope_base"
    echo "scope_head=$HEAD_REF"
    echo "selection_reason=$selection_reason"
    echo "changed_paths_count=$changed_paths_count"
    echo "has_targets=$has_targets"
    echo "targets=$targets_csv"
    echo "targets_json=$targets_json"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Affected Image Targets"
    echo ""
    echo "- Scope: \`$scope_mode\`"
    if [ -n "$scope_base" ]; then
      echo "- Diff: \`${scope_base}...${HEAD_REF}\`"
    fi
    echo "- Reason: \`$selection_reason\`"
    echo "- Changed paths: \`$changed_paths_count\`"
    if [ "$has_targets" = true ]; then
      echo "- Targets: \`$targets_csv\`"
    else
      echo "- Targets: none"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Image build scope: ${scope_mode}"
if [ -n "$scope_base" ]; then
  echo "SCM range: ${scope_base}...${HEAD_REF}"
fi
echo "Selection reason: ${selection_reason}"
echo "Changed paths: ${changed_paths_count}"
if [ "$has_targets" = true ]; then
  echo "Targets: ${targets_csv}"
else
  echo "Targets: none"
fi
