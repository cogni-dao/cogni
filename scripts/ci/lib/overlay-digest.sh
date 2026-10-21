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

# Keep image-owned init entrypoints paired with the old digest during the
# preliminary substrate-shape commit. The final overlay rsync removes this
# compatibility patch before promoting the new image and its own entrypoints.
snapshot_overlay_init_contract() {
  local env="$1" app="$2" image="$3" snapshot="$4"
  local overlay="infra/k8s/overlays/${env}/${app}" rendered
  rendered="$(mktemp)"
  if ! kubectl kustomize "$overlay" | yq eval-all -o=json -I=0 '[.]' - > "$rendered"; then
    rm -f "$rendered"
    return 1
  fi
  python3 - "$rendered" "$snapshot" "$app" "$image" "$(git rev-parse HEAD)" <<'PYTHON'
import json
import sys

rendered, output, app, image, head = sys.argv[1:]
docs = json.load(open(rendered, encoding="utf-8"))
targets = [d for d in docs if d and d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") in (f"{app}-node-app", app)]
if len(targets) != 1:
    raise SystemExit("init compatibility: expected one named node Deployment")
spec = targets[0]["spec"]["template"]["spec"]
containers = spec.get("initContainers", [])
if not isinstance(containers, list):
    raise SystemExit("init compatibility: invalid init containers")
contract = []
seen = set()
for container in containers:
    name = container.get("name")
    if not isinstance(name, str) or not name or name in seen or container.get("image") != image:
        raise SystemExit("init compatibility: ambiguous name or unmatched init image")
    seen.add(name)
    entry = {"name": name}
    for field in ("command", "args"):
        if field in container:
            value = container[field]
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise SystemExit("init compatibility: invalid entrypoint")
            entry[field] = value
    contract.append(entry)
with open(output, "w", encoding="utf-8") as handle:
    json.dump({"head": head, "image": image, "deployment": targets[0]["metadata"]["name"], "initContainers": contract}, handle)
PYTHON
  local result=$?
  rm -f "$rendered"
  return "$result"
}

restore_overlay_init_contract() {
  local env="$1" app="$2" image="$3" snapshot="$4"
  local overlay="infra/k8s/overlays/${env}/${app}" rendered patch
  rendered="$(mktemp)"
  patch="$overlay/.prepare-init-compatibility.json"
  if ! kubectl kustomize "$overlay" | yq eval-all -o=json -I=0 '[.]' - > "$rendered"; then
    rm -f "$rendered"
    return 1
  fi
  if ! python3 - "$rendered" "$snapshot" "$patch" "$app" "$image" "$(git rev-parse HEAD)" <<'PYTHON'
import json
import sys

rendered, snapshot, output, app, image, head = sys.argv[1:]
contract = json.load(open(snapshot, encoding="utf-8"))
if contract["head"] != head or contract["image"] != image or contract["deployment"] not in (f"{app}-node-app", app):
    raise SystemExit("init compatibility: changed deploy HEAD or image binding")
docs = json.load(open(rendered, encoding="utf-8"))
targets = [d for d in docs if d and d.get("kind") == "Deployment" and d.get("metadata", {}).get("name") == contract["deployment"]]
if len(targets) != 1:
    raise SystemExit("init compatibility: expected one named node Deployment")
containers = targets[0]["spec"]["template"]["spec"].get("initContainers", [])
old = {c["name"]: c for c in contract["initContainers"]}
names = [c.get("name") for c in containers]
if len(names) != len(set(names)) or set(names) != set(old):
    raise SystemExit("init compatibility: changed or ambiguous init names")
operations = []
for index, container in enumerate(containers):
    if container.get("image") != image:
        raise SystemExit("init compatibility: unmatched preserved init image")
    prior = old[container["name"]]
    for field in ("command", "args"):
        path = f"/spec/template/spec/initContainers/{index}/{field}"
        if field in prior:
            operations.append({"op": "add", "path": path, "value": prior[field]})
        elif field in container:
            operations.append({"op": "remove", "path": path})
with open(output, "w", encoding="utf-8") as handle:
    json.dump(operations, handle)
PYTHON
  then
    rm -f "$rendered"
    return 1
  fi
  rm -f "$rendered"
  # Services with no init containers have no image-owned entrypoints to patch.
  if [ "$(cat "$patch")" = "[]" ]; then
    rm -f "$patch"
    return 0
  fi
  # Append last: source overlay patches must not override the old-image contract.
  yq -i \
    '.patches += [{"target": {"kind": "Deployment", "name": "node-app"}, "path": ".prepare-init-compatibility.json"}]' \
    "$overlay/kustomization.yaml"
  # Kustomize target matching must not silently accept an unapplied patch.
  local applied result
  applied="$(mktemp)"
  if ! snapshot_overlay_init_contract "$env" "$app" "$image" "$applied"; then
    rm -f "$applied"
    return 1
  fi
  python3 - "$snapshot" "$applied" <<'PYTHON'
import json
import sys

before, after = [json.load(open(p, encoding="utf-8")) for p in sys.argv[1:]]
for value in (before, after):
    value["initContainers"].sort(key=lambda c: c["name"])
if before != after:
    raise SystemExit("init compatibility: rendered entrypoint contract differs")
PYTHON
  result=$?
  rm -f "$applied"
  return "$result"
}
