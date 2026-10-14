#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/lib/overlay-digest.sh — sourceable helper for reading a
# kustomize overlay's *-app image reference (digest pin if present, else
# tag pin).
#
# Function: extract_overlay_image_ref ENV APP
#   - ENV  e.g. "preview", "candidate-a"
#   - APP  e.g. "operator", "poly", "resy", "scheduler-worker"
#   - cwd must be the repo root (or any tree where
#     `infra/k8s/overlays/<ENV>/<APP>/kustomization.yaml` resolves).
#   - prints one of:
#       - "ghcr.io/cogni-dao/cogni-template@sha256:<hex>"  (digest pin)
#       - "ghcr.io/cogni-dao/cogni-template:<tag>"         (tag pin only)
#   - returns 0 on success; non-zero with stderr message if the file is
#     missing or no app image block / digest / tag is found.
#
# Sourced by candidate-flight.yml's per-node substrate-shape preservation.

extract_overlay_image_ref() {
  local env="$1" app="$2"
  local file="infra/k8s/overlays/${env}/${app}/kustomization.yaml"
  if [ ! -f "$file" ]; then
    echo "[ERROR] missing $file" >&2
    return 1
  fi
  python3 - "$file" <<'PY'
import re
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
blocks = re.split(r"\n[ \t]*-\s+name:\s*", "\n" + text)
for block in blocks[1:]:
    line = block.split("\n", 1)[0].strip()
    if line != "ghcr.io/cogni-dao/cogni-template":
        continue
    rest = block.split("\n", 1)[1] if "\n" in block else ""
    m = re.search(r'^\s*digest:\s*"(sha256:[0-9a-f]+)"', rest, re.MULTILINE)
    if m:
        print(f"{line}@{m.group(1)}", end="")
        sys.exit(0)
    m = re.search(r"^\s*newTag:\s*(\S+)", rest, re.MULTILINE)
    if m:
        print(f"{line}:{m.group(1).strip()}", end="")
        sys.exit(0)
    print(f"[ERROR] no digest/newTag under {line} in {path}", file=sys.stderr)
    sys.exit(1)
print(f"[ERROR] no app image block in {path}", file=sys.stderr)
sys.exit(1)
PY
}
