#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/resolve-node-ref-image.sh
# Purpose: Resolve the digest for ONE node's image addressed by node ref
#   `<slug>@<source_sha>` — the SAME nodeRef path for every node, in-repo
#   (operator) or remote-source. No `codePr`/pr_number special-case: the operator
#   is just another node flighted by sourceSha (NORTH_STAR: operator = a node).
#
# Emits the same payload shape as resolve-pr-build-images.sh:
#   { image_name, image_tag, source_sha, targets: [{target, source_repo, sourceSha, image_repository, tag, digest, source_sha, overlay_target?, kustomize_image?, role?}] }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

NODE=${NODE:-}
SOURCE_SHA=${SOURCE_SHA:-}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/resolved-node-ref-image.json}
OVERLAY_ENV=${OVERLAY_ENV:-}

if [ -z "$NODE" ]; then
  echo "[ERROR] NODE is required" >&2
  exit 1
fi
if ! [[ "$SOURCE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "[ERROR] SOURCE_SHA must be a 40-char hex SHA" >&2
  exit 1
fi

catalog="${_image_tags_catalog_root}/${NODE}.yaml"
if [ ! -f "$catalog" ]; then
  echo "[ERROR] no catalog entry for ${NODE}" >&2
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

# ONE identity for both node kinds: `<image>:sha-<sourceSha>`.
#   - remote-source node: image_repository/artifacts from its catalog row.
#   - in-repo node (operator): the parent's own app image (IMAGE_NAME_APP) + the
#     catalog tag suffix — same image pr-build publishes. No source_repo.
artifact_tsv=""
if is_remote_source_artifact_target "$NODE"; then
  source_repo="$(yq -N '.source_repo // ""' "$catalog")"
  catalog_json="$(yq -o=json '.' "$catalog")"
  artifact_tsv="$(
    CATALOG_JSON="$catalog_json" python3 - "$NODE" "$OVERLAY_ENV" <<'PY'
import json
import os
import sys

node, overlay_env = sys.argv[1:3]
catalog = json.loads(os.environ["CATALOG_JSON"])

artifacts = catalog.get("artifacts")
if not artifacts:
    image_repository = catalog.get("image_repository") or ""
    if not image_repository:
        raise SystemExit(f"[ERROR] image_repository missing for remote-source artifact {node}")
    artifacts = [{
        "target": node,
        "role": "app",
        "image_repository": image_repository,
        "overlay_target": node,
    }]

for artifact in artifacts:
    envs = artifact.get("envs") or []
    if overlay_env and envs and overlay_env not in envs:
        continue
    target = artifact["target"]
    role = artifact.get("role", "")
    image_repository = artifact["image_repository"]
    overlay_target = artifact.get("overlay_target") or node
    kustomize_image = artifact.get("kustomize_image") or ""
    print("\t".join([target, role, image_repository, overlay_target, kustomize_image]))
PY
  )"
else
  source_repo=""
  image_repository="$(image_name_for_target "$NODE")"
  artifact_tsv="${NODE}"$'\tapp\t'"${image_repository}"$'\t'"${NODE}"$'\t'
fi

if [ -z "$artifact_tsv" ]; then
  echo "[ERROR] no deployable artifacts for ${NODE}${OVERLAY_ENV:+ in ${OVERLAY_ENV}}" >&2
  exit 1
fi

json_items=()
targets=()
primary_image_repository=""

while IFS=$'\t' read -r target role image_repository overlay_target kustomize_image; do
  [ -n "$target" ] || continue
  [ -n "$primary_image_repository" ] || primary_image_repository="$image_repository"
  if is_remote_source_artifact_target "$NODE"; then
    tag="${image_repository}:sha-${SOURCE_SHA}"
  else
    tag="$(image_tag_for_target "$image_repository" "sha-${SOURCE_SHA}" "$NODE")"
  fi
  digest="$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)"
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    echo "[ERROR] artifact image not found: ${tag}" >&2
    exit 1
  fi
  digest_ref="${tag%%:*}@${digest}"
  json_items+=("    {\n      \"target\": \"${target}\",\n      \"role\": \"${role}\",\n      \"source_repo\": \"${source_repo}\",\n      \"sourceSha\": \"${SOURCE_SHA}\",\n      \"image_repository\": \"${image_repository}\",\n      \"overlay_target\": \"${overlay_target}\",\n      \"kustomize_image\": \"${kustomize_image}\",\n      \"tag\": \"${tag}\",\n      \"digest\": \"${digest_ref}\",\n      \"source_sha\": \"${SOURCE_SHA}\"\n    }")
  targets+=("$target")
done <<< "$artifact_tsv"

json_body=$(printf '%b' "$(IFS=$',\n'; echo "${json_items[*]}")")
targets_csv=$(IFS=,; echo "${targets[*]}")

mkdir -p "$(dirname "$OUTPUT_FILE")"
cat > "$OUTPUT_FILE" <<EOF
{
  "image_name": "${primary_image_repository}",
  "image_tag": "sha-${SOURCE_SHA}",
  "source_sha": "${SOURCE_SHA}",
  "targets": [
${json_body}
  ]
}
EOF

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "resolved_file=$OUTPUT_FILE"
    echo "resolved_targets=$targets_csv"
    echo "has_images=true"
  } >> "$GITHUB_OUTPUT"
fi

echo "Resolved node-ref image: ${NODE} -> ${targets_csv}"
