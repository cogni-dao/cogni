#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/build-and-push-images.sh
# Purpose: Build and push the selected deployable images to GHCR and emit a
#          machine-readable JSON payload for downstream workflows.

set -euo pipefail

# Canonical target catalog + tag-suffix mapping (bug.0328 architectural
# follow-up). Keep build + discovery + promotion consistent from a single
# source file. See scripts/ci/lib/image-tags.sh for the contract.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"
. "$SCRIPT_DIR/lib/publication-proof.sh"

TARGETS=${TARGETS:-}
# Legacy single-repo input. bug.0344 split migrator images into a distinct
# GHCR package; the producer now picks the push repo per-target via
# image_name_for_target. IMAGE_NAME is preserved as the APP-repo override
# knob (back-compat with existing workflow env; it feeds IMAGE_NAME_APP).
IMAGE_NAME=${IMAGE_NAME:-ghcr.io/cogni-dao/cogni-template}
export IMAGE_NAME_APP=${IMAGE_NAME_APP:-$IMAGE_NAME}
export IMAGE_NAME_MIGRATOR=${IMAGE_NAME_MIGRATOR:-${IMAGE_NAME_APP}-migrate}
IMAGE_TAG=${IMAGE_TAG:-}
PLATFORM=${PLATFORM:-linux/amd64}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/build-images.json}
# FORK_FREEDOM: a fork PR builds for signal but must not push to a namespace its
# token can't write. SHOULD_PUSH=false → build-only (no push, no digest). Defaults
# to true so same-repo / merge_group / push:main behavior is unchanged.
SHOULD_PUSH=${SHOULD_PUSH:-true}

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ -z "$IMAGE_TAG" ]; then
  log_error "IMAGE_TAG is required"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

trimmed_targets=$(printf "%s" "$TARGETS" | tr -d '[:space:]')
if [ -z "$trimmed_targets" ]; then
  printf '{\n  "image_name": "%s",\n  "image_tag": "%s",\n  "platform": "%s",\n  "targets": []\n}\n' \
    "$IMAGE_NAME_APP" "$IMAGE_TAG" "$PLATFORM" > "$OUTPUT_FILE"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "build_output_file=$OUTPUT_FILE"
      echo "built_targets="
      echo "has_images=false"
    } >> "$GITHUB_OUTPUT"
  fi

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "## PR Image Publications"
      echo ""
      echo "- App package: \`$IMAGE_NAME_APP\`"
      echo "- Migrator package: \`$IMAGE_NAME_MIGRATOR\`"
      echo "- Image tag: \`$IMAGE_TAG\`"
      echo "- Targets: none"
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  log_info "No image targets selected; wrote empty payload to $OUTPUT_FILE"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  log_error "docker is required"
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  log_error "docker buildx is required"
  exit 1
fi

if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USERNAME:-}" ]; then
  log_info "Logging into GHCR as ${GHCR_USERNAME}"
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
fi

IMAGE_NAME_APP=$(printf "%s" "$IMAGE_NAME_APP" | tr '[:upper:]' '[:lower:]')
IMAGE_NAME_MIGRATOR=$(printf "%s" "$IMAGE_NAME_MIGRATOR" | tr '[:upper:]' '[:lower:]')
# BUILD_SHA wins so pull_request-triggered workflows can pass the real PR head
# instead of the ephemeral refs/pull/{N}/merge SHA that GitHub puts in GITHUB_SHA.
# See bug.0313.
git_sha="${BUILD_SHA:-${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}}"
# The checkout, workflow definition and tooling revisions are different objects.
source_repository="${SOURCE_REPOSITORY:-${GITHUB_REPOSITORY:-cogni-dao/cogni}}"
actual_head=$(git rev-parse HEAD)
git diff-index --quiet HEAD -- || { echo 'publication_checkout_dirty' >&2; exit 1; }
[[ "$git_sha" =~ ^[a-f0-9]{40}$ && "$actual_head" = "$git_sha" ]] || {
  echo 'publication_checkout_mismatch' >&2; exit 1;
}
[[ "$PLATFORM" = linux/amd64 ]] || { echo 'publication_platform_invalid' >&2; exit 1; }
origin_url=$(git remote get-url origin)
[[ "$origin_url" = "https://github.com/${source_repository}.git" || "$origin_url" = "https://github.com/${source_repository}" ]] || {
  echo 'publication_checkout_repository_mismatch' >&2; exit 1;
}
build_timestamp=$(git show -s --format=%cI "$git_sha")

# bug.0344: image_name_for_target picks APP vs MIGRATOR package per-target.
# image-tags.sh's image_tag_for_target joins them with the tag suffix.
resolve_tag() {
  # type:infra images are content-hash tagged (litellm-<hash>) so the affected
  # build rebuilds them only on change and deploy-infra resolves the same tag;
  # everything else is <IMAGE_TAG><suffix>.
  if is_infra_target "$1"; then
    infra_image_tag "$1"
  else
    image_tag_for_target "$(image_name_for_target "$1")" "$IMAGE_TAG" "$1"
  fi
}

build_target() {
  local target="$1"
  local tag="$2"

  # CATALOG_IS_SSOT (task.5079): derive the build from infra/catalog/<target>.yaml
  # instead of a hardcoded per-node case. The same function now builds any catalog
  # target, so this script is byte-identical across hub + artifacts (kills the
  # bug.5001 CI fork). Node apps build the multi-stage `runner` target and bake
  # BUILD_SHA; services build their default stage.
  local catalog="${COGNI_CATALOG_ROOT:-infra/catalog}/${target}.yaml"
  if [ ! -f "$catalog" ]; then
    log_error "build_target: no catalog entry for '${target}' (${catalog})"
    exit 1
  fi
  local dockerfile type context
  dockerfile=$(yq '.dockerfile' "$catalog")
  type=$(yq '.type' "$catalog")
  if [ -z "$dockerfile" ] || [ "$dockerfile" = "null" ]; then
    log_error "build_target: ${catalog} has no .dockerfile"
    exit 1
  fi
  # Build context defaults to repo root; type:infra images (e.g. litellm) set
  # their own self-contained dir so the Dockerfile stays context-relative.
  context=$(yq -N '.build_context // "."' "$catalog")

  local args=(--platform "$PLATFORM" --file "$dockerfile"
    --build-arg "SOURCE_DATE_EPOCH=$(git show -s --format=%ct "$git_sha")")
  if [ "$type" = "node" ]; then
    args+=(--target runner --build-arg "BUILD_SHA=${git_sha}")
  fi
  args+=(
    --label "org.opencontainers.image.source=https://github.com/${source_repository}"
    --label "org.opencontainers.image.revision=${git_sha}"
    --label "org.opencontainers.image.created=${build_timestamp}"
    --cache-from "type=gha,scope=build-${target}"
    --cache-to "type=gha,mode=max,scope=build-${target}"
    --tag "$tag"
  )
  if publication_is_operator_coordinate "$tag" && ! is_infra_target "$target" && [[ "$SHOULD_PUSH" = true ]]; then
    args+=(--provenance=mode=max --metadata-file "$metadata_file"
      --label "io.cogni.publication.version=2"
      --label "io.cogni.publication.source=$source_repository"
      --label "io.cogni.publication.target=$target"
      --label "io.cogni.publication.platform=$PLATFORM"
      --label "io.cogni.publication.recipe=$recipe"
      --label "io.cogni.publication.workflow-sha=${GITHUB_WORKFLOW_SHA:?}"
      --label "io.cogni.publication.run=${GITHUB_RUN_ID:?}"
      --label "io.cogni.publication.attempt=${GITHUB_RUN_ATTEMPT:?}")
  fi
  if [ "$SHOULD_PUSH" = "false" ]; then
    # FORK_FREEDOM build-only: validate the image compiles; do not push.
    args+=("$context")
  else
    args+=(--push "$context")
  fi
  docker buildx build "${args[@]}"
}

resolve_digest_ref() {
  local tag="$1"
  local digest

  digest=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    log_error "Failed to resolve pushed digest for ${tag}"
    exit 1
  fi

  printf '%s@%s' "${tag%%:*}" "$digest"
}

# A matrix leg owns one coordinate through native attestation and fragment
# upload. The pending file is runner-local build metadata, never deployable proof.
pending="${OUTPUT_FILE}.pending"
if [[ "${PUBLICATION_PHASE:-build}" = finalize ]]; then
  [[ -s "$pending" ]] || { echo 'publication_pending_missing' >&2; exit 1; }
  target=$(jq -er '.targets[0].target' "$pending")
  digest_ref=$(jq -er '.targets[0].digest' "$pending")
  proof=$(mktemp)
  publication_verify "$digest_ref" "$source_repository" "$git_sha" "$target" "$proof" "${PUBLICATION_BUNDLE:-}"
  jq --slurpfile proof "$proof" '.targets[0].publication = $proof[0]' "$pending" > "$OUTPUT_FILE"
  rm -f "$proof" "$pending"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'build_output_file=%s\nbuilt_targets=%s\nhas_images=true\n' "$OUTPUT_FILE" "$target" >> "$GITHUB_OUTPUT"
  fi
  log_info "Verified original publication: $target -> $digest_ref"
  exit 0
fi
rm -f "$OUTPUT_FILE" "$pending"
printf '{"image_name":"%s","image_name_migrator":"%s","image_tag":"%s","platform":"%s","targets":[]}\n' \
  "$IMAGE_NAME_APP" "$IMAGE_NAME_MIGRATOR" "$IMAGE_TAG" "$PLATFORM" > "$pending"
built_targets=()
IFS=',' read -r -a requested_targets <<< "$trimmed_targets"
for target in "${requested_targets[@]}"; do
  [ -z "$target" ] && continue
  full_tag=$(resolve_tag "$target")
  outcome=built
  proof=$(mktemp)
  protected=false
  if publication_is_operator_coordinate "$full_tag" && ! is_infra_target "$target" && [[ "$SHOULD_PUSH" = true ]]; then
    protected=true
    [[ "${#requested_targets[@]}" = 1 ]] || { echo 'publication_requires_matrix_lock' >&2; exit 1; }
    [[ "${PUBLICATION_COORDINATE:-}" = "$full_tag-linux/amd64" ]] || {
      echo 'publication_coordinate_mismatch' >&2; exit 1;
    }
    publication_require_verifier
    recipe=$(publication_recipe "$source_repository" "$git_sha" "$target" "$PWD")
    lookup_rc=0
    digest_ref=$(publication_lookup "$full_tag") || lookup_rc=$?
    if [[ "$lookup_rc" = 0 ]]; then
      publication_verify "$digest_ref" "$source_repository" "$git_sha" "$target" "$proof"
      outcome=reused
      log_info "Reused $target -> $digest_ref (original producer retained)"
    elif [[ "$lookup_rc" != 3 ]]; then
      exit 1
    fi
  fi
  if [[ "$outcome" != reused ]]; then
    metadata_file="${OUTPUT_FILE}.buildkit.json"
    rm -f "$metadata_file"
    rc=0
    build_target "$target" "$full_tag" || rc=$?
    if [[ "$SHOULD_PUSH" = false ]]; then
      [[ "$rc" = 0 ]] || exit "$rc"
      digest_ref=""
    elif [[ "$protected" = true ]]; then
      # A lost push response can be reconciled only from original BuildKit
      # metadata and immutable registry readback. Never rebuild on ambiguity.
      pushed=$(jq -er '."containerimage.digest" | select(test("^sha256:[0-9a-f]{64}$"))' "$metadata_file")
      digest_ref=$(publication_lookup "$full_tag")
      [[ "$digest_ref" = "${full_tag%%:*}@${pushed}" ]] || { echo 'publication_readback_mismatch' >&2; exit 1; }
      [[ "$rc" = 0 ]] || log_info 'Recovered completed push from retained BuildKit metadata'
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        echo "attest=true" >> "$GITHUB_OUTPUT"
        echo "subject_name=${full_tag%%:*}" >> "$GITHUB_OUTPUT"
        echo "subject_digest=$pushed" >> "$GITHUB_OUTPUT"
      fi
    else
      [[ "$rc" = 0 ]] || exit "$rc"
      digest_ref=$(resolve_digest_ref "$full_tag")
    fi
  fi
  entry=$(jq -n --arg target "$target" --arg tag "$full_tag" --arg digest "$digest_ref" \
    --arg source "$git_sha" --arg repo "$source_repository" --arg outcome "$outcome" \
    '{target:$target,tag:$tag,digest:$digest,source_sha:$source,source_repository:$repo,outcome:$outcome}')
  if [[ -s "$proof" ]]; then
    entry=$(jq --slurpfile proof "$proof" '.publication=$proof[0]' <<< "$entry")
  fi
  jq --argjson entry "$entry" '.targets += [$entry]' "$pending" > "${pending}.tmp"
  mv "${pending}.tmp" "$pending"
  rm -f "$proof"
  built_targets+=("$target")
  # A new protected image is not published evidence until the native action
  # and the shared verifier finish. Consumers never receive the pending file.
  if [[ "$protected" != true || "$outcome" = reused ]]; then
    cp "$pending" "$OUTPUT_FILE"
  fi
done

# New publications await the native action before a verified fragment exists.
if [[ ! -f "$OUTPUT_FILE" ]]; then
  log_info "Image read back; native publication proof is pending"
  exit 0
fi

built_targets_csv=$(IFS=,; echo "${built_targets[*]}")

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "build_output_file=$OUTPUT_FILE"
    echo "built_targets=$built_targets_csv"
    echo "has_images=true"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## PR Image Publications"
    echo ""
    echo "- App package: \`${IMAGE_NAME_APP}\`"
    echo "- Migrator package: \`${IMAGE_NAME_MIGRATOR}\`"
    echo "- Image tag: \`${IMAGE_TAG}\`"
    echo "- Targets: \`${built_targets_csv}\`"
    echo ""
    echo "| Target | Digest |"
    echo "| --- | --- |"
    for target in "${built_targets[@]}"; do
      digest_ref=$(python3 - "$OUTPUT_FILE" "$target" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
for item in payload["targets"]:
    if item["target"] == sys.argv[2]:
        print(item["digest"])
        break
PY
)
      echo "| \`${target}\` | \`${digest_ref}\` |"
    done
  } >> "$GITHUB_STEP_SUMMARY"
fi

log_info "Wrote build payload to $OUTPUT_FILE"
