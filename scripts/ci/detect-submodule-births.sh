#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/detect-submodule-births.sh
# Purpose: Detect newly-added catalog rows that are submodule gitlinks, so
# candidate-flight can deploy the child repo image without adding a parent
# build target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

ADDED_PATHS_FILE=${ADDED_PATHS_FILE:-}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/submodule-births.json}

if [ -z "$ADDED_PATHS_FILE" ] || [ ! -f "$ADDED_PATHS_FILE" ]; then
  echo "[ERROR] ADDED_PATHS_FILE is required and must exist" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

has_target() {
  local needle="$1" existing
  for existing in "${ALL_TARGETS[@]}"; do
    [ "$existing" = "$needle" ] && return 0
  done
  return 1
}

gitlink_sha_for_target() {
  local target="$1" prefix path mode type sha _
  prefix="${_image_tags_pathprefix_cache[$target]:-}"
  [ -n "$prefix" ] || return 1
  path="${prefix%/}"
  read -r mode type sha _ < <(git ls-tree HEAD -- "$path")
  [ "$mode" = "160000" ] || return 1
  [ "$type" = "commit" ] || return 1
  printf '%s' "$sha"
}

source_repo_for_target() {
  local target="$1" catalog repo prefix path
  catalog="${_image_tags_catalog_root}/${target}.yaml"
  repo="$(yq -N '.source_repo // ""' "$catalog")"
  if [ -n "$repo" ]; then
    printf '%s' "$repo"
    return 0
  fi

  prefix="${_image_tags_pathprefix_cache[$target]:-}"
  path="${prefix%/}"
  awk -v path="$path" '
    $0 ~ /^\[submodule / { in_block=0 }
    $0 ~ /^\[submodule / && $0 ~ "\"" path "\"" { in_block=1 }
    in_block && /^[[:space:]]*url[[:space:]]*=/ {
      sub(/^[[:space:]]*url[[:space:]]*=[[:space:]]*/, "")
      print
      exit
    }
  ' "${_image_tags_spec_root}/.gitmodules"
}

default_image_repository_for_repo() {
  local repo="$1" owner
  owner="$(printf '%s' "$repo" | sed -E 's#^https://github\.com/([^/]+)/.*#\1#' | tr '[:upper:]' '[:lower:]')"
  [ -n "$owner" ] && [ "$owner" != "$repo" ] || owner="cogni-dao"
  printf 'ghcr.io/%s/cogni-node-template' "$owner"
}

image_repository_for_target() {
  local target="$1" source_repo="$2" catalog image
  catalog="${_image_tags_catalog_root}/${target}.yaml"
  image="$(yq -N '.image_repository // ""' "$catalog")"
  if [ -n "$image" ]; then
    printf '%s' "$image"
  else
    default_image_repository_for_repo "$source_repo"
  fi
}

json_items=()
targets=()

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    infra/catalog/*.yaml | infra/catalog/*.yml) ;;
    *) continue ;;
  esac

  file="${path##*/}"
  target="${file%.*}"
  has_target "$target" || continue
  is_submodule_node "$target" || continue

  source_sha="$(gitlink_sha_for_target "$target")" || {
    echo "[ERROR] ${target} is listed in .gitmodules but nodes/${target} is not a gitlink at HEAD" >&2
    exit 1
  }
  source_repo="$(source_repo_for_target "$target")"
  if [ -z "$source_repo" ]; then
    echo "[ERROR] source_repo missing for submodule birth ${target}" >&2
    exit 1
  fi
  image_repository="$(image_repository_for_target "$target" "$source_repo")"
  tag="sha-${source_sha}"
  json_items+=("    {\n      \"target\": \"${target}\",\n      \"source_repo\": \"${source_repo}\",\n      \"source_sha\": \"${source_sha}\",\n      \"image_repository\": \"${image_repository}\",\n      \"tag\": \"${image_repository}:${tag}\"\n    }")
  targets+=("$target")
done < "$ADDED_PATHS_FILE"

json_body=""
if [ ${#json_items[@]} -gt 0 ]; then
  json_body=$(printf '%b' "$(IFS=$',\n'; echo "${json_items[*]}")")
fi

printf '{\n  "targets": [\n%s\n  ]\n}\n' "$json_body" > "$OUTPUT_FILE"

targets_csv=""
targets_json="[]"
if [ ${#targets[@]} -gt 0 ]; then
  targets_csv=$(IFS=,; echo "${targets[*]}")
  targets_json=$(printf '%s\n' "${targets[@]}" \
    | python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))')
fi

has_submodule_births=false
if [ ${#targets[@]} -gt 0 ]; then
  has_submodule_births=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "births_file=$OUTPUT_FILE"
    echo "has_submodule_births=$has_submodule_births"
    echo "submodule_birth_targets=$targets_csv"
    echo "submodule_birth_targets_json=$targets_json"
  } >> "$GITHUB_OUTPUT"
fi

echo "Submodule birth targets: ${targets_csv:-none}"
