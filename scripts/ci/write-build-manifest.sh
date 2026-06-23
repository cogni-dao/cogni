#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/write-build-manifest.sh
# Purpose: Write one canonical PR build manifest artifact from the selected
#          image outputs so downstream candidate-flight jobs can consume it
#          without re-deriving tag or digest state.

set -euo pipefail

IMAGES_FILE=${IMAGES_FILE:-${RUNNER_TEMP:-/tmp}/build-images.json}
MANIFEST_FILE=${MANIFEST_FILE:-${RUNNER_TEMP:-/tmp}/build-manifest.json}
PR_NUMBER=${PR_NUMBER:-}
HEAD_SHA=${HEAD_SHA:-${GITHUB_SHA:-}}
REPOSITORY=${REPOSITORY:-${GITHUB_REPOSITORY:-}}
RUN_ID=${RUN_ID:-${GITHUB_RUN_ID:-}}
RUN_ATTEMPT=${RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-}}
WORKFLOW_NAME=${WORKFLOW_NAME:-${GITHUB_WORKFLOW:-}}
REF_NAME=${REF_NAME:-${GITHUB_REF_NAME:-}}

if [ ! -f "$IMAGES_FILE" ]; then
  echo "[ERROR] IMAGES_FILE not found: $IMAGES_FILE" >&2
  exit 1
fi

# PR_NUMBER is informational provenance only (the manifest is not load-bearing —
# deploy identity is sha-<HEAD_SHA>). It is empty on a direct push to main with no
# `(#NNN)` subject; record null rather than hard-failing.

if [ -z "$HEAD_SHA" ]; then
  echo "[ERROR] HEAD_SHA is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$MANIFEST_FILE")"

python3 - "$IMAGES_FILE" "$MANIFEST_FILE" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

images_path = sys.argv[1]
manifest_path = sys.argv[2]

with open(images_path, "r", encoding="utf-8") as handle:
    images = json.load(handle)

manifest = {
    "schema_version": 1,
    "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "repository": os.environ["REPOSITORY"],
    "pr_number": int(os.environ["PR_NUMBER"]) if os.environ.get("PR_NUMBER") else None,
    "head_sha": os.environ["HEAD_SHA"],
    "ref_name": os.environ.get("REF_NAME", ""),
    "workflow": {
        "name": os.environ.get("WORKFLOW_NAME", ""),
        "run_id": os.environ.get("RUN_ID", ""),
        "run_attempt": os.environ.get("RUN_ATTEMPT", ""),
    },
    "image_name": images["image_name"],
    "image_tag": images["image_tag"],
    "platform": images["platform"],
    "targets": images["targets"],
}

with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PY

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "manifest_file=$MANIFEST_FILE"
    echo "manifest_tag=$(python3 - "$MANIFEST_FILE" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(payload["image_tag"])
PY
)"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Build Manifest"
    echo ""
    echo "- PR: \`#${PR_NUMBER}\`"
    echo "- Head SHA: \`${HEAD_SHA}\`"
    echo "- Manifest: \`${MANIFEST_FILE}\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Wrote build manifest to $MANIFEST_FILE"
