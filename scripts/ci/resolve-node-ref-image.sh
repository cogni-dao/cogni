#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/resolve-node-ref-image.sh
# Purpose: Resolve the digest for a remote-source artifact image addressed
#   by node ref `<slug>@<source_sha>`.
#
# Emits the same payload shape as resolve-pr-build-images.sh:
#   { image_name, image_tag, source_sha, targets: [{target, source_repo, sourceSha, image_repository, tag, digest, source_sha}] }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

NODE=${NODE:-}
SOURCE_SHA=${SOURCE_SHA:-}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/resolved-node-ref-image.json}

if [ -z "$NODE" ]; then
  echo "[ERROR] NODE is required" >&2
  exit 1
fi
if ! [[ "$SOURCE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "[ERROR] SOURCE_SHA must be a 40-char hex SHA" >&2
  exit 1
fi
if ! is_remote_source_artifact_target "$NODE"; then
  echo "[ERROR] ${NODE} is not a remote-source artifact in this checkout" >&2
  exit 1
fi

catalog="${_image_tags_catalog_root}/${NODE}.yaml"
source_repo="$(yq -N '.source_repo // ""' "$catalog")"
if [ -z "$source_repo" ]; then
  echo "[ERROR] source_repo missing for remote-source artifact ${NODE}" >&2
  exit 1
fi
image_repository="$(yq -N '.image_repository // ""' "$catalog")"
if [ -z "$image_repository" ]; then
  echo "[ERROR] image_repository missing for remote-source artifact ${NODE}" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "[ERROR] docker buildx is required" >&2
  exit 1
fi

tag="${image_repository}:sha-${SOURCE_SHA}"
digest="$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)"
if [ -z "$digest" ] || [ "$digest" = "null" ]; then
  echo "[ERROR] remote-source artifact image not found: ${tag}" >&2
  exit 1
fi
digest_ref="${tag%%:*}@${digest}"

mkdir -p "$(dirname "$OUTPUT_FILE")"
cat > "$OUTPUT_FILE" <<EOF
{
  "image_name": "${image_repository}",
  "image_tag": "sha-${SOURCE_SHA}",
  "source_sha": "${SOURCE_SHA}",
  "targets": [
    {
      "target": "${NODE}",
      "source_repo": "${source_repo}",
      "sourceSha": "${SOURCE_SHA}",
      "image_repository": "${image_repository}",
      "tag": "${tag}",
      "digest": "${digest_ref}",
      "source_sha": "${SOURCE_SHA}"
    }
  ]
}
EOF

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "resolved_file=$OUTPUT_FILE"
    echo "resolved_targets=$NODE"
    echo "has_images=true"
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved node-ref image: ${NODE} -> ${digest_ref}"
