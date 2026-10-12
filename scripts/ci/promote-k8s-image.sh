#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/promote-k8s-image.sh
# Purpose: Update k8s overlay with new image digest for any app/node.
# Image mutation uses portable awk so CI and BSD developer hosts produce the
# same overlay.
# Invariants:
#   - IMAGE_IMMUTABILITY: Uses @sha256: digest, never mutable tags
#   - MANIFEST_DRIVEN_DEPLOY: Promotion = overlay change → Argo CD syncs
#   - WORKER_IDENTITY_MATCHES_IMAGE: scheduler-worker /version reports the
#     promoted digest, not a static per-environment placeholder.
# Usage:
#   scripts/ci/promote-k8s-image.sh --env candidate-a --app operator --digest ghcr.io/cogni-dao/cogni-template@sha256:abc...
#   scripts/ci/promote-k8s-image.sh --env candidate-a --app operator --digest ...
#   scripts/ci/promote-k8s-image.sh --env production --app operator --digest ...
#   scripts/ci/promote-k8s-image.sh --env preview --no-commit --app operator --digest ...
#
# By default, auto-commits and pushes when running in CI (GITHUB_SHA set).
# Pass --no-commit to update the file only — caller manages git operations.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse args
APP=""
DIGEST=""
ENV=""
DEPLOY_BRANCH=""
NO_COMMIT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --app) APP="$2"; shift 2 ;;
    --digest) DIGEST="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --deploy-branch) DEPLOY_BRANCH="$2"; shift 2 ;;
    --no-commit) NO_COMMIT=true; shift ;;
    *) log_error "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$APP" || -z "$DIGEST" || -z "$ENV" ]]; then
  log_error "Usage: promote-k8s-image.sh --env <overlay> --app <name> --digest <image@sha256:...>"
  exit 1
fi

# Validate digest format
if [[ "$DIGEST" != *"@sha256:"* ]]; then
  log_error "DIGEST must be a digest ref (contain @sha256:), got: $DIGEST"
  exit 1
fi

IMAGE_NAME="${DIGEST%%@*}"
IMAGE_DIGEST="${DIGEST#*@}"

OVERLAY_FILE="infra/k8s/overlays/${ENV}/${APP}/kustomization.yaml"

if [[ ! -f "$OVERLAY_FILE" ]]; then
  log_error "Overlay file not found: $OVERLAY_FILE"
  exit 1
fi

log_info "Promoting $APP image in $ENV overlay"
log_info "  Image: $IMAGE_NAME"
log_info "  Digest: $IMAGE_DIGEST"

# Update the first image entry only. awk keeps this portable across GNU CI and
# BSD developer hosts while preserving the hand-authored overlay formatting.
IMAGE_TMP="${OVERLAY_FILE}.image.tmp"
awk -v image="$IMAGE_NAME" -v digest="$IMAGE_DIGEST" '
  !name_done && /newName:[[:space:]]*/ {
    match($0, /^[[:space:]]*/)
    print substr($0, RSTART, RLENGTH) "newName: " image
    name_done = 1
    next
  }
  !digest_done && /newTag:[[:space:]]*/ {
    match($0, /^[[:space:]]*/)
    print substr($0, RSTART, RLENGTH) "digest: \"" digest "\""
    digest_done = 1
    next
  }
  !digest_done && /^[[:space:]]*digest:[[:space:]]*/ {
    match($0, /^[[:space:]]*/)
    print substr($0, RSTART, RLENGTH) "digest: \"" digest "\""
    digest_done = 1
    next
  }
  { print }
  END { if (!name_done || !digest_done) exit 42 }
' "$OVERLAY_FILE" > "$IMAGE_TMP" || {
  rm -f "$IMAGE_TMP"
  log_error "overlay must contain an image newName plus newTag/digest"
  exit 1
}
mv "$IMAGE_TMP" "$OVERLAY_FILE"

# scheduler-worker exposes IMAGE_DIGEST from this ConfigMap on /version. Keep
# that observable identity in the same atomic overlay commit as the image pin;
# otherwise a rollout can be Ready while /version still reports a placeholder.
if [[ "$APP" == "scheduler-worker" ]]; then
  IDENTITY_TMP="${OVERLAY_FILE}.identity.tmp"
  awk -v digest="$IMAGE_DIGEST" '
    /path: \/data\/IMAGE_DIGEST/ {
      found_path = 1
      awaiting_value = 1
      print
      next
    }
    awaiting_value && /^[[:space:]]*value:/ {
      match($0, /^[[:space:]]*/)
      print substr($0, RSTART, RLENGTH) "value: \"" digest "\""
      awaiting_value = 0
      found_value = 1
      next
    }
    { print }
    END {
      if (!found_path || !found_value) exit 42
    }
  ' "$OVERLAY_FILE" > "$IDENTITY_TMP" || {
    rm -f "$IDENTITY_TMP"
    log_error "scheduler-worker overlay must patch ConfigMap IMAGE_DIGEST for /version identity"
    exit 1
  }
  mv "$IDENTITY_TMP" "$OVERLAY_FILE"
fi

log_info "Updated $OVERLAY_FILE"

# Commit and push if in CI and --no-commit not passed
if [[ "$NO_COMMIT" == "true" ]]; then
  log_info "Skipping commit (--no-commit). Caller manages git operations."
elif [[ -n "${GITHUB_SHA:-}" ]]; then
  if [[ -z "$DEPLOY_BRANCH" ]]; then
    log_error "--deploy-branch is required when commit/push mode is enabled"
    exit 1
  fi
  git config user.name "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
  git add "$OVERLAY_FILE"

  if git diff --cached --quiet; then
    log_info "No changes to commit (digest unchanged)"
  else
    git commit -m "chore(cd): promote ${APP} to ${IMAGE_DIGEST:0:19}... [skip ci]"
    git push origin "HEAD:${DEPLOY_BRANCH}"
    log_info "Committed and pushed digest update to $DEPLOY_BRANCH"
  fi
else
  log_info "Not in CI — skipping commit. Review changes manually:"
  git diff "$OVERLAY_FILE" || true
fi
