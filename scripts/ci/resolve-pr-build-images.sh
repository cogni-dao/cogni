#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/resolve-pr-build-images.sh
# Purpose: Resolve pushed PR image digests from GHCR for the `pr-{N}-{sha}`
#   tag convention. Emits a JSON payload consumed by promote-build-payload.sh.
#
# Envelope shape (written to $OUTPUT_FILE):
#   { image_name, image_tag, source_sha, targets: [{target, tag, digest, source_sha}, ...] }
# Remote-source artifact target items additionally carry the forward artifact record
# fields: source_repo, sourceSha, and image_repository.
#
# `source_sha` is the PR head SHA (BUILD_SHA label baked into every image by
# pr-build.yml per bug.0313). Flows into .promote-state/source-sha-by-app.json
# for cross-env contract verification (bug.0321 Fix 4). Derived from the
# `pr-{N}-{sha}` suffix of IMAGE_TAG when the caller doesn't pass it.
#
# Outputs on $GITHUB_OUTPUT:
#   resolved_file, resolved_targets (CSV), has_images (bool)
#
# Env:
#   IMAGE_NAME           (default ghcr.io/cogni-dao/cogni-template) legacy
#                        APP-repo override; feeds IMAGE_NAME_APP.
#   IMAGE_NAME_APP       (default = IMAGE_NAME) APP-repo override.
#   IMAGE_TAG            (required) the pr-{N}-{sha} tag
#   SOURCE_SHA           (optional) the 40-char PR head SHA — overrides IMAGE_TAG parse
#   REMOTE_SOURCE_ARTIFACT_TARGETS_FILE (optional) detect-remote-source-artifact-targets.sh payload
#   OUTPUT_FILE          (default $RUNNER_TEMP/resolved-pr-images.json)

set -euo pipefail

# Canonical target catalog + tag-suffix mapping (bug.0328 architectural
# follow-up). Single source of truth for `target → image:tag` across the
# producer (build-and-push-images), this discoverer, the flight-preview
# retag step, and promote-and-deploy's resolve/promote steps.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

IMAGE_NAME=${IMAGE_NAME:-ghcr.io/cogni-dao/cogni-template}
export IMAGE_NAME_APP=${IMAGE_NAME_APP:-$IMAGE_NAME}
export IMAGE_NAME_MIGRATOR=${IMAGE_NAME_MIGRATOR:-${IMAGE_NAME_APP}-migrate}
IMAGE_TAG=${IMAGE_TAG:-}
SOURCE_SHA=${SOURCE_SHA:-}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/resolved-pr-images.json}
REMOTE_SOURCE_ARTIFACT_TARGETS_FILE=${REMOTE_SOURCE_ARTIFACT_TARGETS_FILE:-}

if [ -z "$IMAGE_TAG" ]; then
  echo "[ERROR] IMAGE_TAG is required" >&2
  exit 1
fi

# SOURCE_SHA is the BUILD_SHA baked into every image via pr-build.yml
# (BUILD_SHA label / /version.buildSha). Flows into the payload envelope so
# promote-build-payload.sh can write .promote-state/source-sha-by-app.json
# for cross-env contract verification (bug.0321 Fix 4). Fall back to
# parsing the IMAGE_TAG when the caller didn't pass it explicitly.
# Two tag namespaces (bug.0412):
#   pr-{N}-{X}  — pull_request build, X = BUILD_SHA = original PR head SHA
#   mq-{N}-{Y}  — merge_group build, Y = BUILD_SHA = queue/rebased commit
# Both encode BUILD_SHA as the trailing 40-char hex.
if [ -z "$SOURCE_SHA" ]; then
  SOURCE_SHA=$(printf '%s' "$IMAGE_TAG" | sed -E 's/^(pr|mq)-[0-9]+-//')
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required" >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "[ERROR] docker buildx is required" >&2
  exit 1
fi

resolve_tag() {
  # Mirror build-and-push-images.sh: type:infra is content-hash tagged.
  if is_infra_target "$1"; then
    infra_image_tag "$1"
  else
    image_tag_for_target "$(image_name_for_target "$1")" "$IMAGE_TAG" "$1"
  fi
}

resolve_digest_ref() {
  local tag="$1"
  local digest

  digest=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    return 1
  fi

  printf '%s@%s' "${tag%%:*}" "$digest"
}

mkdir -p "$(dirname "$OUTPUT_FILE")"

json_items=()
resolved_targets=()

for target in "${ALL_TARGETS[@]}"; do
  if ! is_built_by_this_repo "$target"; then
    continue
  fi
  full_tag=$(resolve_tag "$target")
  if digest_ref=$(resolve_digest_ref "$full_tag"); then
    json_items+=("    {\n      \"target\": \"${target}\",\n      \"tag\": \"${full_tag}\",\n      \"digest\": \"${digest_ref}\",\n      \"source_sha\": \"${SOURCE_SHA}\"\n    }")
    resolved_targets+=("$target")
  fi
done

if [ -n "$REMOTE_SOURCE_ARTIFACT_TARGETS_FILE" ] && [ -f "$REMOTE_SOURCE_ARTIFACT_TARGETS_FILE" ]; then
  while IFS=$'\t' read -r target source_repo item_source_sha image_repository full_tag; do
    [ -n "$target" ] || continue
    if digest_ref=$(resolve_digest_ref "$full_tag"); then
      json_items+=("    {\n      \"target\": \"${target}\",\n      \"source_repo\": \"${source_repo}\",\n      \"sourceSha\": \"${item_source_sha}\",\n      \"image_repository\": \"${image_repository}\",\n      \"tag\": \"${full_tag}\",\n      \"digest\": \"${digest_ref}\",\n      \"source_sha\": \"${item_source_sha}\"\n    }")
      resolved_targets+=("$target")
    fi
  done < <(python3 - "$REMOTE_SOURCE_ARTIFACT_TARGETS_FILE" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
for item in payload.get("targets", []):
    source_sha = item.get("sourceSha") or item["source_sha"]
    print(f"{item['target']}\t{item.get('source_repo', '')}\t{source_sha}\t{item.get('image_repository', '')}\t{item['tag']}")
PY
  )
fi

json_body=""
if [ ${#json_items[@]} -gt 0 ]; then
  json_body=$(printf '%b' "$(IFS=$',\n'; echo "${json_items[*]}")")
fi

cat > "$OUTPUT_FILE" <<EOF
{
  "image_name": "${IMAGE_NAME_APP}",
  "image_tag": "${IMAGE_TAG}",
  "source_sha": "${SOURCE_SHA}",
  "targets": [
${json_body}
  ]
}
EOF

resolved_targets_csv=""
if [ ${#resolved_targets[@]} -gt 0 ]; then
  resolved_targets_csv=$(IFS=,; echo "${resolved_targets[*]}")
fi

has_images=false
if [ ${#resolved_targets[@]} -gt 0 ]; then
  has_images=true
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "resolved_file=$OUTPUT_FILE"
    echo "resolved_targets=$resolved_targets_csv"
    echo "has_images=$has_images"
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved PR images: ${resolved_targets_csv:-none}"
