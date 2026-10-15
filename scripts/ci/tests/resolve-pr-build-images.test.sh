#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPT="${CI_DIR}/resolve-pr-build-images.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/bin"
cat > "$WORKDIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_CALL_LOG:-/dev/null}"
if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "version" ]; then
  echo "buildx stub"
  exit 0
fi
if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "imagetools" ] && [ "${3:-}" = "inspect" ]; then
  tag="$4"
  case "$tag" in
    ghcr.io/cogni-test-org/ay:sha-0123456789012345678901234567890123456789)
      printf '"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n'
      exit 0
      ;;
    *)
      exit 1
      ;;
  esac
fi
exit 1
STUB
chmod +x "$WORKDIR/bin/docker"

cat > "$WORKDIR/remote-source-artifact-targets.json" <<'JSON'
{
  "targets": [
    {
      "target": "ay",
      "source_repo": "https://github.com/cogni-test-org/ay.git",
      "image_repository": "ghcr.io/cogni-test-org/ay",
      "sourceSha": "0123456789012345678901234567890123456789",
      "source_sha": "0123456789012345678901234567890123456789",
      "tag": "ghcr.io/cogni-test-org/ay:sha-0123456789012345678901234567890123456789"
    }
  ]
}
JSON

out="$WORKDIR/resolved.json"
github_out="$WORKDIR/github-output.txt"
PATH="$WORKDIR/bin:$PATH" \
  IMAGE_TAG=pr-7-ffffffffffffffffffffffffffffffffffffffff \
  SOURCE_SHA=ffffffffffffffffffffffffffffffffffffffff \
  REMOTE_SOURCE_ARTIFACT_TARGETS_FILE="$WORKDIR/remote-source-artifact-targets.json" \
  OUTPUT_FILE="$out" \
  GITHUB_OUTPUT="$github_out" \
  bash "$SCRIPT" >/dev/null

python3 - "$out" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
items = payload["targets"]
assert len(items) == 1, items
item = items[0]
assert item["target"] == "ay", item
assert item["source_repo"] == "https://github.com/cogni-test-org/ay.git", item
assert item["image_repository"] == "ghcr.io/cogni-test-org/ay", item
assert item["sourceSha"] == "0123456789012345678901234567890123456789", item
assert item["source_sha"] == "0123456789012345678901234567890123456789", item
assert item["digest"] == "ghcr.io/cogni-test-org/ay@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", item
PY

grep -q '^resolved_targets=ay$' "$github_out"
grep -q '^has_images=true$' "$github_out"

cat > "$WORKDIR/pinned.json" <<'JSON'
{"targets":[{"target":"operator","tag":"ghcr.io/cogni-test-org/app:sha-ffffffffffffffffffffffffffffffffffffffff","digest":"ghcr.io/cogni-test-org/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","source_sha":"ffffffffffffffffffffffffffffffffffffffff"},{"target":"scheduler-worker","tag":"ghcr.io/cogni-test-org/app:sha-ffffffffffffffffffffffffffffffffffffffff-scheduler-worker","digest":"ghcr.io/cogni-test-org/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","source_sha":"ffffffffffffffffffffffffffffffffffffffff"}]}
JSON
PATH="$WORKDIR/bin:$PATH" \
  IMAGE_TAG=sha-ffffffffffffffffffffffffffffffffffffffff \
  SOURCE_SHA=ffffffffffffffffffffffffffffffffffffffff \
  PINNED_BUILD_IMAGES_FILE="$WORKDIR/pinned.json" \
  REMOTE_SOURCE_ARTIFACT_TARGETS_FILE="$WORKDIR/remote-source-artifact-targets.json" \
  DOCKER_CALL_LOG="$WORKDIR/pinned-docker.log" \
  OUTPUT_FILE="$WORKDIR/pinned-result.json" \
  bash "$SCRIPT" >/dev/null

python3 - "$WORKDIR" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
original = json.loads((root / "pinned.json").read_text())["targets"]
actual = json.loads((root / "pinned-result.json").read_text())["targets"]
assert actual[:2] == original, actual
assert actual[2]["target"] == "ay", actual
calls = (root / "pinned-docker.log").read_text()
assert calls.count("imagetools inspect") == 1, calls
assert "cogni-test-org/ay:" in calls, calls
assert "cogni-test-org/app:" not in calls, calls
PY

echo "all cases passed"
