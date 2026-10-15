#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/detect-remote-source-artifact-targets.sh
# Purpose: Detect changed external artifact identities between reviewed revisions,
# then emit the source-SHA tag the deploy lane should consume by digest.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

CHANGED_PATHS_FILE=${CHANGED_PATHS_FILE:-}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/remote-source-artifact-targets.json}

if [ -z "$CHANGED_PATHS_FILE" ] || [ ! -f "$CHANGED_PATHS_FILE" ]; then
  echo "[ERROR] CHANGED_PATHS_FILE is required and must exist" >&2
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

# A catalog placement edit is not authority to promote its historical source SHA.
# Only an actual artifact identity change enters the existing promotion path.
artifact_identity_changed() {
  local target="$1" path="infra/catalog/${1}.yaml" base_names before after source_root
  [[ -n "${BASE_SHA:-}" && -n "${HEAD_SHA:-}" ]] || {
    echo "[ERROR] BASE_SHA and HEAD_SHA are required to compare remote artifact identity" >&2
    exit 1
  }
  source_root="$(git rev-parse --show-toplevel)"
  git -C "$source_root" cat-file -e "${BASE_SHA}^{commit}" \
    && git -C "$source_root" cat-file -e "${HEAD_SHA}^{commit}" || {
      echo "[ERROR] remote artifact comparison revisions are unavailable" >&2
      exit 1
    }
  # A successful tree listing with no path is positive new-row evidence.
  base_names="$(git -C "$source_root" ls-tree --name-only "$BASE_SHA" -- "$path")" || exit 1
  after="$(git -C "$source_root" show "${HEAD_SHA}:${path}" | yq -o=json -I=0 '{"source_repo": .source_repo, "source_sha": .source_sha, "image_repository": .image_repository}' -)" || exit 1
  [[ -n "$base_names" ]] || return 0
  before="$(git -C "$source_root" show "${BASE_SHA}:${path}" | yq -o=json -I=0 '{"source_repo": .source_repo, "source_sha": .source_sha, "image_repository": .image_repository}' -)" || exit 1
  [[ "$before" != "$after" ]]
}

catalog_source_sha_for_target() {
  local target="$1" sha
  sha="$(yq -N '.source_sha // ""' "${_image_tags_catalog_root}/${target}.yaml")"
  [ -n "$sha" ] || return 1
  printf '%s' "$sha"
}

source_repo_for_target() {
  local target="$1" catalog repo
  catalog="${_image_tags_catalog_root}/${target}.yaml"
  repo="$(yq -N '.source_repo // ""' "$catalog")"
  if [ -n "$repo" ]; then
    printf '%s' "$repo"
    return 0
  fi

  return 1
}

image_repository_for_target() {
  local target="$1" catalog image
  catalog="${_image_tags_catalog_root}/${target}.yaml"
  image="$(yq -N '.image_repository // ""' "$catalog")"
  if [ -z "$image" ]; then
    echo "[ERROR] image_repository missing for remote-source artifact ${target}" >&2
    exit 1
  fi
  printf '%s' "$image"
}

path_selects_target() {
  local path="$1" target="$2" prefix pin_path
  case "$path" in
    "infra/catalog/${target}.yaml" | "infra/catalog/${target}.yml")
      return 0
      ;;
  esac
  prefix="${_image_tags_pathprefix_cache[$target]:-}"
  [ -n "$prefix" ] || return 1
  pin_path="${prefix%/}"
  case "$path" in
    "$pin_path" | "$prefix"*)
      return 0
      ;;
  esac
  return 1
}

json_items=()
targets=()

while IFS= read -r path; do
  [ -n "$path" ] || continue

  for target in "${ALL_TARGETS[@]}"; do
    is_remote_source_artifact_target "$target" || continue
    path_selects_target "$path" "$target" || continue
    has_target "$target" || continue
    artifact_identity_changed "$target" || continue

    if printf '%s\n' "${targets[@]}" | grep -qx "$target"; then
      continue
    fi

    source_sha="$(catalog_source_sha_for_target "$target")" || {
      echo "[ERROR] source_sha missing for remote-source artifact ${target}; set source_sha in infra/catalog/${target}.yaml (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN)" >&2
      exit 1
    }
    source_repo="$(source_repo_for_target "$target")"
    if [ -z "$source_repo" ]; then
      echo "[ERROR] source_repo missing for remote-source artifact ${target}" >&2
      exit 1
    fi
    image_repository="$(image_repository_for_target "$target")"
    tag="sha-${source_sha}"
    json_items+=("    {\n      \"target\": \"${target}\",\n      \"source_repo\": \"${source_repo}\",\n      \"sourceSha\": \"${source_sha}\",\n      \"source_sha\": \"${source_sha}\",\n      \"image_repository\": \"${image_repository}\",\n      \"tag\": \"${image_repository}:${tag}\"\n    }")
    targets+=("$target")
  done
done < "$CHANGED_PATHS_FILE"

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

has_remote_source_artifact_targets=false
if [ ${#targets[@]} -gt 0 ]; then
  has_remote_source_artifact_targets=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "targets_file=$OUTPUT_FILE"
    echo "has_remote_source_artifact_targets=$has_remote_source_artifact_targets"
    echo "remote_source_artifact_targets=$targets_csv"
    echo "remote_source_artifact_targets_json=$targets_json"
  } >> "$GITHUB_OUTPUT"
fi

echo "Remote-source artifact targets: ${targets_csv:-none}"
