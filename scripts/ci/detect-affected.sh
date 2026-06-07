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
deferred_global_input=""
turbo_affected_packages_loaded=false
turbo_affected_packages=()

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

turbo_version_spec() {
  python3 - <<'PY'
import json

with open("package.json", "r", encoding="utf-8") as handle:
    package = json.load(handle)

version = (
    package.get("devDependencies", {}).get("turbo")
    or package.get("dependencies", {}).get("turbo")
    or "latest"
)
print(version)
PY
}

run_turbo_affected_json() {
  if [ -n "${TURBO_BIN:-}" ]; then
    "$TURBO_BIN" run build --affected --dry=json
    return
  fi

  if [ -x "node_modules/.bin/turbo" ]; then
    node_modules/.bin/turbo run build --affected --dry=json
    return
  fi

  npx --yes "turbo@$(turbo_version_spec)" run build --affected --dry=json
}

load_turbo_affected_packages() {
  local output packages_output

  if [ "$turbo_affected_packages_loaded" = true ]; then
    return 0
  fi

  turbo_affected_packages_loaded=true

  if ! output=$(TURBO_SCM_BASE="$UPSTREAM_REF" TURBO_SCM_HEAD="$HEAD_REF" run_turbo_affected_json); then
    echo "::warning::detect-affected: turbo affected failed; falling back to all image targets for shared package change" >&2
    return 1
  fi

  if ! packages_output=$(printf '%s' "$output" | python3 -c 'import json,sys;
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
print("\n".join(data.get("packages", [])))'); then
    echo "::warning::detect-affected: turbo affected returned invalid JSON; falling back to all image targets for shared package change" >&2
    return 1
  fi

  turbo_affected_packages=()
  if [ -n "$packages_output" ]; then
    mapfile -t turbo_affected_packages <<< "$packages_output"
  fi
}

package_name_from_manifest() {
  local manifest="$1"

  python3 - "$manifest" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    print(json.load(handle).get("name", ""))
PY
}

catalog_target_from_path() {
  local path="$1"
  local file target existing

  case "$path" in
    infra/catalog/*.yaml | infra/catalog/*.yml)
      file="${path##*/}"
      target="${file%.*}"
      ;;
    *)
      return 1
      ;;
  esac

  for existing in "${ALL_TARGETS[@]}"; do
    if [ "$existing" = "$target" ]; then
      printf '%s\n' "$target"
      return 0
    fi
  done

  return 1
}

is_global_build_input() {
  local path="$1"

  case "$path" in
    .dockerignore | \
    package.json | \
    pnpm-workspace.yaml | \
    turbo.json | \
    tsconfig.json | \
    tsconfig.base.json | \
    tsconfig.app.json | \
    tsconfig.scripts.json | \
    config/* | \
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
  declare -A target_package_name=()
  for target in "${ALL_TARGETS[@]}"; do
    target_prefix["$target"]=$(yq '.path_prefix' "${_image_tags_catalog_root}/${target}.yaml")
    prefix="${target_prefix[$target]%/}"
    target_package_name["$target"]=""
    for manifest in "${_image_tags_spec_root}/${prefix}/package.json" "${_image_tags_spec_root}/${prefix}/app/package.json"; do
      if [ -f "$manifest" ]; then
        target_package_name["$target"]=$(package_name_from_manifest "$manifest")
        break
      fi
    done
  done

  while IFS= read -r path; do
    [ -z "$path" ] && continue

    # New node workspaces legitimately update the monorepo lockfile. Defer
    # deciding whether that is global until node-owned paths have had a chance
    # to select their target. Lockfile-only/dependency-update PRs still build
    # all targets below.
    if [ "$path" = "pnpm-lock.yaml" ]; then
      deferred_global_input="$path"
      continue
    fi

    if catalog_target=$(catalog_target_from_path "$path"); then
      add_target "$catalog_target"
      selection_reason="catalog-target:${path}"
      continue
    fi

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
        if ! load_turbo_affected_packages; then
          add_all_targets
          selection_reason="shared-package-change:${path}:turbo-fallback"
          break
        fi

        declare -A affected_package=()
        for package in "${turbo_affected_packages[@]}"; do
          affected_package["$package"]=1
        done

        before_count=${#selected_targets[@]}
        for target in "${ALL_TARGETS[@]}"; do
          package="${target_package_name[$target]:-}"
          if [ -n "$package" ] && [ -n "${affected_package[$package]:-}" ]; then
            add_target "$target"
          fi
        done

        if [ ${#selected_targets[@]} -gt "$before_count" ]; then
          selection_reason="turbo-affected-package-change:${path}"
        else
          selection_reason="turbo-no-image-targets:${path}"
        fi
        continue
        ;;
      *)
        for target in "${ALL_TARGETS[@]}"; do
          prefix="${target_prefix[$target]}"
          case "$path" in
            "${prefix}"*) add_target "$target" ;;
            "infra/k8s/base/${target}/"*) add_target "$target" ;;
            "infra/k8s/overlays/"*"/${target}/"*) add_target "$target" ;;
          esac
        done
        ;;
    esac
  done <<< "$changed_paths"

  if [ -n "$deferred_global_input" ] && [ ${#selected_targets[@]} -eq 0 ]; then
    add_all_targets
    selection_reason="global-build-input:${deferred_global_input}"
  fi
fi

ordered_targets=()
for target in "${ALL_TARGETS[@]}"; do
  if has_target "$target"; then
    # BUILD_PLANE_OWNS_ARTIFACT: this selector returns targets this repo must
    # build. Remote-source artifact rows are deploy inputs, not parent build
    # legs. Legacy rows with no source_repo remain parent-built until migrated.
    if ! is_built_by_this_repo "$target"; then
      continue
    fi
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

# Flight targets: the subset of affected targets that deploy through the k8s
# app-lever (candidate-flight / preview per-node overlays). type:infra targets
# (e.g. litellm) build in CI but deploy via Compose-on-VM (deploy-infra.sh) and
# have NO per-node overlay, so a flight matrix that fans out over them rsyncs a
# nonexistent overlays/<env>/<infra> dir and fails the aggregate. Excluding them
# here mirrors flight-preview.yml + promote-build-payload.sh's is_infra_target
# guard; the full targets_json above still feeds the build/resolve legs.
flight_targets=()
for target in "${ordered_targets[@]}"; do
  if is_infra_target "$target"; then
    continue
  fi
  flight_targets+=("$target")
done

flight_targets_csv=""
flight_targets_json="[]"
if [ ${#flight_targets[@]} -gt 0 ]; then
  flight_targets_csv=$(IFS=,; echo "${flight_targets[*]}")
  flight_targets_json=$(printf '%s\n' "${flight_targets[@]}" \
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

has_flight_targets=false
if [ ${#flight_targets[@]} -gt 0 ]; then
  has_flight_targets=true
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
    echo "has_flight_targets=$has_flight_targets"
    echo "flight_targets=$flight_targets_csv"
    echo "flight_targets_json=$flight_targets_json"
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
    if [ "$has_flight_targets" = true ]; then
      echo "- Flight targets (k8s app-lever): \`$flight_targets_csv\`"
    else
      echo "- Flight targets (k8s app-lever): none (infra-only or no targets)"
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
if [ "$has_flight_targets" = true ]; then
  echo "Flight targets: ${flight_targets_csv}"
else
  echo "Flight targets: none"
fi
