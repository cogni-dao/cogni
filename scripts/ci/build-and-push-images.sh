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
      echo "## Built PR Images"
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
build_timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# bug.0344: image_name_for_target picks APP vs MIGRATOR package per-target.
# image-tags.sh's image_tag_for_target joins them with the tag suffix.
resolve_tag() {
  image_tag_for_target "$(image_name_for_target "$1")" "$IMAGE_TAG" "$1"
}

build_target() {
  local target="$1"
  local tag="$2"

  case "$target" in
    operator)
      docker buildx build \
        --platform "$PLATFORM" \
        --file nodes/operator/app/Dockerfile \
        --target runner \
        --build-arg "BUILD_SHA=${git_sha}" \
        --label "org.opencontainers.image.source=https://github.com/cogni-dao/cogni" \
        --label "org.opencontainers.image.revision=${git_sha}" \
        --label "org.opencontainers.image.created=${build_timestamp}" \
        --cache-from "type=gha,scope=build-operator" \
        --cache-to "type=gha,mode=max,scope=build-operator" \
        --tag "$tag" \
        --push \
        .
      ;;
    resy)
      docker buildx build \
        --platform "$PLATFORM" \
        --file nodes/resy/app/Dockerfile \
        --target runner \
        --build-arg "BUILD_SHA=${git_sha}" \
        --label "org.opencontainers.image.source=https://github.com/cogni-dao/cogni" \
        --label "org.opencontainers.image.revision=${git_sha}" \
        --label "org.opencontainers.image.created=${build_timestamp}" \
        --cache-from "type=gha,scope=build-resy" \
        --cache-to "type=gha,mode=max,scope=build-resy" \
        --tag "$tag" \
        --push \
        .
      ;;
    node-template)
      docker buildx build \
        --platform "$PLATFORM" \
        --file nodes/node-template/app/Dockerfile \
        --target runner \
        --build-arg "BUILD_SHA=${git_sha}" \
        --label "org.opencontainers.image.source=https://github.com/cogni-dao/cogni" \
        --label "org.opencontainers.image.revision=${git_sha}" \
        --label "org.opencontainers.image.created=${build_timestamp}" \
        --cache-from "type=gha,scope=build-node-template" \
        --cache-to "type=gha,mode=max,scope=build-node-template" \
        --tag "$tag" \
        --push \
        .
      ;;
    scheduler-worker)
      docker buildx build \
        --platform "$PLATFORM" \
        --file services/scheduler-worker/Dockerfile \
        --label "org.opencontainers.image.source=https://github.com/cogni-dao/cogni" \
        --label "org.opencontainers.image.revision=${git_sha}" \
        --label "org.opencontainers.image.created=${build_timestamp}" \
        --cache-from "type=gha,scope=build-scheduler-worker" \
        --cache-to "type=gha,mode=max,scope=build-scheduler-worker" \
        --tag "$tag" \
        --push \
        .
      ;;
  esac
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

json_items=()
built_targets=()
IFS=',' read -r -a requested_targets <<< "$trimmed_targets"

for target in "${requested_targets[@]}"; do
  [ -z "$target" ] && continue

  full_tag=$(resolve_tag "$target")
  log_info "Building and pushing ${target} -> ${full_tag}"
  build_target "$target" "$full_tag"
  digest_ref=$(resolve_digest_ref "$full_tag")
  log_info "Resolved ${target} digest: ${digest_ref}"

  json_items+=("    {\n      \"target\": \"${target}\",\n      \"tag\": \"${full_tag}\",\n      \"digest\": \"${digest_ref}\"\n    }")
  built_targets+=("$target")
done

json_body=""
if [ ${#json_items[@]} -gt 0 ]; then
  json_body=$(printf '%b' "$(IFS=$',\n'; echo "${json_items[*]}")")
fi

cat > "$OUTPUT_FILE" <<EOF
{
  "image_name": "${IMAGE_NAME_APP}",
  "image_name_migrator": "${IMAGE_NAME_MIGRATOR}",
  "image_tag": "${IMAGE_TAG}",
  "platform": "${PLATFORM}",
  "targets": [
${json_body}
  ]
}
EOF

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
    echo "## Built PR Images"
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
