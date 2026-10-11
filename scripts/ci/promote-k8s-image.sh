#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/promote-k8s-image.sh
# Purpose: Update k8s overlay with new image digest for any app/node.
# The image selector rewrite uses yq so the exact promotion primitive is portable
# between CI (Linux) and operator workstations (macOS).
# Invariants:
#   - IMAGE_IMMUTABILITY: Uses @sha256: digest, never mutable tags
#   - MANIFEST_DRIVEN_DEPLOY: Promotion = overlay change → Argo CD syncs
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

# Update the first image selector, preserving the established app-first overlay
# contract while avoiding GNU-sed-only `0,/pattern/` semantics. A local proof
# must exercise the same deterministic writer as CI; it may not hand-edit YAML.
if ! command -v yq >/dev/null 2>&1; then
  log_error "yq is required to promote an immutable image digest"
  exit 1
fi
IMAGE_NAME="$IMAGE_NAME" IMAGE_DIGEST="$IMAGE_DIGEST" yq -i '
  .images[0].newName = strenv(IMAGE_NAME) |
  .images[0].digest = strenv(IMAGE_DIGEST) |
  del(.images[0].newTag)
' "$OVERLAY_FILE"

# The scheduler-worker exposes IMAGE_DIGEST from its ConfigMap on /version.
# Keep that runtime claim byte-aligned with the promoted image selector; a
# placeholder here makes an immutable deployment impossible to identify even
# when Kubernetes is running the correct digest.
if [[ "$APP" == "scheduler-worker" ]]; then
  if ! grep -q 'path: /data/IMAGE_DIGEST' "$OVERLAY_FILE"; then
    log_error "scheduler-worker overlay must patch /data/IMAGE_DIGEST"
    exit 1
  fi
  sed -i.bak '\|path: /data/IMAGE_DIGEST|{n;s|\( *value: *\).*|\1"'"${IMAGE_DIGEST}"'"|;}' "$OVERLAY_FILE"
  if ! grep -q "value: \"${IMAGE_DIGEST}\"" "$OVERLAY_FILE"; then
    log_error "failed to synchronize scheduler-worker IMAGE_DIGEST"
    exit 1
  fi
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
