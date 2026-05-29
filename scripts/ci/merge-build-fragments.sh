#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/merge-build-fragments.sh
# Purpose: Merge per-target build-images.json fragments produced by the
#          PR build matrix into a single build-images.json payload. Mirrors
#          the shape emitted by the legacy single-job build-and-push-images.sh
#          so write-build-manifest.sh consumes it without change.

set -euo pipefail

FRAGMENTS_DIR=${FRAGMENTS_DIR:-${RUNNER_TEMP:-/tmp}/build-fragments}
OUTPUT_FILE=${OUTPUT_FILE:-${RUNNER_TEMP:-/tmp}/build-images.json}
IMAGE_NAME=${IMAGE_NAME:-ghcr.io/cogni-dao/cogni-template}
IMAGE_TAG=${IMAGE_TAG:-}
PLATFORM=${PLATFORM:-linux/amd64}

if [ -z "$IMAGE_TAG" ]; then
  echo "[ERROR] IMAGE_TAG is required" >&2
  exit 1
fi

image_name_lower=$(printf "%s" "$IMAGE_NAME" | tr '[:upper:]' '[:lower:]')
mkdir -p "$(dirname "$OUTPUT_FILE")"

python3 - "$FRAGMENTS_DIR" "$OUTPUT_FILE" "$image_name_lower" "$IMAGE_TAG" "$PLATFORM" <<'PY'
import json
import os
import sys

fragments_dir, output_file, image_name, image_tag, platform = sys.argv[1:6]

targets = []
seen = set()

if os.path.isdir(fragments_dir):
    for root, _dirs, files in os.walk(fragments_dir):
        for name in sorted(files):
            if not name.endswith(".json"):
                continue
            path = os.path.join(root, name)
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            for entry in payload.get("targets", []):
                key = entry.get("target")
                if key and key not in seen:
                    seen.add(key)
                    targets.append(entry)

# Stable order: per-node apps, then scheduler-worker. (task.0370 step 1 retired the per-node migrator companions.)
canonical_order = ["operator", "poly", "resy", "node-template", "scheduler-worker"]
targets.sort(key=lambda t: (
    canonical_order.index(t["target"]) if t["target"] in canonical_order else len(canonical_order),
    t["target"],
))

out = {
    "image_name": image_name,
    "image_tag": image_tag,
    "platform": platform,
    "targets": targets,
}

with open(output_file, "w", encoding="utf-8") as handle:
    json.dump(out, handle, indent=2)
    handle.write("\n")

print(f"Merged {len(targets)} target(s) into {output_file}")
for t in targets:
    print(f"  - {t['target']}: {t.get('digest', '')}")
PY

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  built_csv=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(t["target"] for t in d["targets"]))' "$OUTPUT_FILE")
  has_images=false
  [ -n "$built_csv" ] && has_images=true
  {
    echo "build_output_file=$OUTPUT_FILE"
    echo "built_targets=$built_csv"
    echo "has_images=$has_images"
  } >> "$GITHUB_OUTPUT"
fi
