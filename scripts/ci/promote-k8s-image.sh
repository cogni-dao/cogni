#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/promote-k8s-image.sh
# Purpose: Update k8s overlay with new image digest for any app/node.
# Note: sed uses GNU extensions (0, address). Runs in CI (ubuntu). Local use: review diff only.
# Invariants:
#   - IMAGE_IMMUTABILITY: Uses @sha256: digest, never mutable tags
#   - MANIFEST_DRIVEN_DEPLOY: Promotion = overlay change → Argo CD syncs
# Usage:
#   scripts/ci/promote-k8s-image.sh --env candidate-a --app operator --digest ghcr.io/cogni-dao/cogni-template@sha256:abc...
#   scripts/ci/promote-k8s-image.sh --env candidate-a --app operator --digest ...
#   scripts/ci/promote-k8s-image.sh --env candidate-a --app poly-paper-trader --overlay-app poly --kustomize-image ghcr.io/cogni-dao/poly-paper-trader --digest ...
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
OVERLAY_APP=""
KUSTOMIZE_IMAGE=""
NO_COMMIT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --app) APP="$2"; shift 2 ;;
    --digest) DIGEST="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --deploy-branch) DEPLOY_BRANCH="$2"; shift 2 ;;
    --overlay-app) OVERLAY_APP="$2"; shift 2 ;;
    --kustomize-image) KUSTOMIZE_IMAGE="$2"; shift 2 ;;
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
OVERLAY_APP="${OVERLAY_APP:-$APP}"

OVERLAY_FILE="infra/k8s/overlays/${ENV}/${OVERLAY_APP}/kustomization.yaml"

if [[ ! -f "$OVERLAY_FILE" ]]; then
  log_error "Overlay file not found: $OVERLAY_FILE"
  exit 1
fi

log_info "Promoting $APP image in $ENV overlay ($OVERLAY_APP)"
log_info "  Image: $IMAGE_NAME"
log_info "  Digest: $IMAGE_DIGEST"

# Update the kustomization.yaml images section
# Default keeps the historical primary-image behavior: update the first
# images[] entry. Sidecars pass --kustomize-image so the promoter updates the
# named image inside the same overlay without touching the app container.
if [[ -z "$KUSTOMIZE_IMAGE" ]]; then
  # Replace newName with image name
  sed -i.bak "0,/newName: .*/s|newName: .*|newName: ${IMAGE_NAME}|" "$OVERLAY_FILE"

  # Replace newTag with digest (first run) or update existing digest
  if grep -q 'newTag:' "$OVERLAY_FILE"; then
    sed -i.bak "0,/newTag: .*/s|.*newTag:.*|    digest: \"${IMAGE_DIGEST}\"|" "$OVERLAY_FILE"
  elif grep -q 'digest:' "$OVERLAY_FILE"; then
    sed -i.bak "0,/digest: .*/s|digest: .*|digest: \"${IMAGE_DIGEST}\"|" "$OVERLAY_FILE"
  fi
else
  if ! command -v yq >/dev/null 2>&1; then
    log_error "yq is required for --kustomize-image promotion"
    exit 1
  fi
  match_count=$(
    KUSTOMIZE_IMAGE="$KUSTOMIZE_IMAGE" yq -N \
      '[.images[] | select(.name == env(KUSTOMIZE_IMAGE) or .newName == env(KUSTOMIZE_IMAGE))] | length' \
      "$OVERLAY_FILE"
  )
  if [[ "$match_count" != "1" ]]; then
    log_error "Expected exactly one images[] entry matching ${KUSTOMIZE_IMAGE} in ${OVERLAY_FILE}; found ${match_count}"
    exit 1
  fi
  KUSTOMIZE_IMAGE="$KUSTOMIZE_IMAGE" IMAGE_NAME="$IMAGE_NAME" IMAGE_DIGEST="$IMAGE_DIGEST" yq -i \
    'with(.images[] | select(.name == env(KUSTOMIZE_IMAGE) or .newName == env(KUSTOMIZE_IMAGE));
      .newName = env(IMAGE_NAME) |
      .digest = env(IMAGE_DIGEST) |
      del(.newTag)
    )' \
    "$OVERLAY_FILE"
fi

rm -f "${OVERLAY_FILE}.bak"

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
