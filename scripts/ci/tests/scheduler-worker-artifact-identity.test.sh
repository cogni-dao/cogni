#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Regression harness for scheduler-worker artifact truth. The image build must
# bake its source SHA, and promotion must make /version's IMAGE_DIGEST claim
# match the Kubernetes image selector.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMPROOT="$(mktemp -d -t scheduler-worker-identity.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

mkdir -p "$TMPROOT/bin" "$TMPROOT/catalog" "$TMPROOT/build"
printf '%s\n' \
  'name: scheduler-worker' \
  'type: service' \
  'dockerfile: services/scheduler-worker/Dockerfile' \
  >"$TMPROOT/catalog/scheduler-worker.yaml"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "buildx" && "${2:-}" == "version" ]]; then exit 0; fi' \
  'if [[ "${1:-}" == "buildx" && "${2:-}" == "build" ]]; then printf "%s\n" "$@" >"${DOCKER_ARGS_LOG:?}"; exit 0; fi' \
  'exit 1' \
  >"$TMPROOT/bin/docker"
chmod +x "$TMPROOT/bin/docker"

DOCKER_ARGS_LOG="$TMPROOT/docker-args.log" \
PATH="$TMPROOT/bin:$PATH" \
COGNI_CATALOG_ROOT="$TMPROOT/catalog" \
TARGETS=scheduler-worker \
IMAGE_TAG=sha-test \
BUILD_SHA=0123456789abcdef0123456789abcdef01234567 \
SHOULD_PUSH=false \
OUTPUT_FILE="$TMPROOT/build/result.json" \
  bash "$REPO_ROOT/scripts/ci/build-and-push-images.sh" >/dev/null

grep -qx -- '--build-arg' "$TMPROOT/docker-args.log"
grep -qx 'GIT_SHA=0123456789abcdef0123456789abcdef01234567' "$TMPROOT/docker-args.log"
grep -Eq '^BUILD_TS=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' "$TMPROOT/docker-args.log"

mkdir -p "$TMPROOT/promote/infra/k8s/overlays/production/scheduler-worker"
printf '%s\n' \
  'images:' \
  '  - name: ghcr.io/cogni-dao/cogni-template' \
  '    newName: ghcr.io/cogni-dao/cogni-template' \
  '    newTag: "old"' \
  'patches:' \
  '  - target:' \
  '      kind: ConfigMap' \
  '      name: scheduler-worker-config' \
  '    patch: |' \
  '      - op: replace' \
  '        path: /data/IMAGE_DIGEST' \
  '        value: "placeholder"' \
  >"$TMPROOT/promote/infra/k8s/overlays/production/scheduler-worker/kustomization.yaml"

(
  cd "$TMPROOT/promote"
  bash "$REPO_ROOT/scripts/ci/promote-k8s-image.sh" \
    --no-commit \
    --env production \
    --app scheduler-worker \
    --digest ghcr.io/cogni-dao/cogni-template@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    >/dev/null
)

overlay="$TMPROOT/promote/infra/k8s/overlays/production/scheduler-worker/kustomization.yaml"
grep -q 'value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$overlay"

echo "PASS: scheduler-worker-artifact-identity.test.sh"
