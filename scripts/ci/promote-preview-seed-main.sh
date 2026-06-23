#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/promote-preview-seed-main.sh
# Purpose: After Flight Preview (retag) succeeds, refresh `main` preview overlay
#   digest pins in one working-tree pass — **Option B** (task.0349): call
#   promote-k8s-image.sh --no-commit per node; do NOT reuse
#   promote-build-payload.sh (deploy-branch + .promote-state coupling).
#
# Tri-state per image (affected-only merges):
#   1) If `sha-{mergeSha}{suffix}` resolves in GHCR → use that digest.
#   2) Else retain current pin from kustomization; verify it still resolves.
#   3) Else fail (broken overlay).
#
# Does not commit or push — caller owns git (CI workflow). Exits 0 when
# there is nothing to change.
#
# Env:
#   MERGE_SHA  (required) 40-char lowercase git SHA on main (merge commit).
#
set -euo pipefail

MERGE_SHA="${MERGE_SHA:?MERGE_SHA required}"
MERGE_SHA=$(printf '%s' "$MERGE_SHA" | tr '[:upper:]' '[:lower:]')
if ! printf '%s' "$MERGE_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  echo "[ERROR] MERGE_SHA must be a 40-char hex SHA" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"
# shellcheck source=./lib/overlay-digest.sh
. "$SCRIPT_DIR/lib/overlay-digest.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker is required" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "[ERROR] docker buildx is required" >&2
  exit 1
fi

# ONE identity: pr-build publishes `<image>:sha-<mergeSha>` on push:main /
# merge_group (SOURCE_SHA_IS_DEPLOY_IDENTITY) — the legacy preview-<sha> re-tag
# is purged, so the seed reads the same sha- digest the deploy consumes.
BASE_TAG="sha-${MERGE_SHA}"

resolve_digest_ref() {
  local tag="$1"
  local digest
  digest=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)
  if [ -z "$digest" ] || [ "$digest" = "null" ]; then
    return 1
  fi
  local repo="${tag%@*}"
  repo="${repo%%:*}"
  printf '%s@%s' "$repo" "$digest"
}

desired_digest_for_target() {
  local target="$1"
  local full_tag current
  full_tag=$(image_tag_for_target "$(image_name_for_target "$target")" "$BASE_TAG" "$target") || return 1
  if digest_ref=$(resolve_digest_ref "$full_tag"); then
    printf '%s' "$digest_ref"
    return 0
  fi
  current=$(extract_overlay_image_ref preview "$target") || return 1
  if digest_ref=$(resolve_digest_ref "$current"); then
    printf '%s' "$digest_ref"
    return 0
  fi
  echo "[ERROR] retain path: could not resolve current ref ${current} for target ${target}" >&2
  return 1
}

promote_if_changed() {
  local app="$1" digest="$2"
  local file="infra/k8s/overlays/preview/${app}/kustomization.yaml"
  local before after
  before=$(sha256sum "$file" | awk '{print $1}')
  bash "$SCRIPT_DIR/promote-k8s-image.sh" --no-commit \
    --env preview --app "$app" --digest "$digest"
  after=$(sha256sum "$file" | awk '{print $1}')
  if [ "$before" != "$after" ]; then
    echo "  updated overlay: $app"
  else
    echo "  unchanged: $app"
  fi
}

echo "ℹ️  promote-preview-seed-main: MERGE_SHA=${MERGE_SHA:0:12} BASE_TAG=${BASE_TAG}"

for node in "${NODE_TARGETS[@]}"; do
  d_app=$(desired_digest_for_target "$node") || exit 1
  promote_if_changed "$node" "$d_app"
done

d_sw=$(desired_digest_for_target "scheduler-worker") || exit 1
promote_if_changed "scheduler-worker" "$d_sw" ""

if git diff --quiet infra/k8s/overlays/preview/; then
  echo "ℹ️  No overlay diff — seed already matches GHCR / retain pins."
  exit 0
fi

echo "ℹ️  Overlay diff present — caller should commit and push."
exit 0
