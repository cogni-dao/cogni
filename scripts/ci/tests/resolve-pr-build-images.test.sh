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
if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "version" ]; then
  echo "buildx stub"
  exit 0
fi
if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "imagetools" ] && [ "${3:-}" = "inspect" ]; then
  tag="$4"
  case "$tag" in
    ghcr.io/cogni-test-org/cogni-node-template:sha-0123456789012345678901234567890123456789)
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

cat > "$WORKDIR/births.json" <<'JSON'
{
  "targets": [
    {
      "target": "ay",
      "source_sha": "0123456789012345678901234567890123456789",
      "tag": "ghcr.io/cogni-test-org/cogni-node-template:sha-0123456789012345678901234567890123456789"
    }
  ]
}
JSON

out="$WORKDIR/resolved.json"
github_out="$WORKDIR/github-output.txt"
PATH="$WORKDIR/bin:$PATH" \
  IMAGE_TAG=pr-7-ffffffffffffffffffffffffffffffffffffffff \
  SOURCE_SHA=ffffffffffffffffffffffffffffffffffffffff \
  SUBMODULE_BIRTHS_FILE="$WORKDIR/births.json" \
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
assert item["source_sha"] == "0123456789012345678901234567890123456789", item
assert item["digest"] == "ghcr.io/cogni-test-org/cogni-node-template@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", item
PY

grep -q '^resolved_targets=ay$' "$github_out"
grep -q '^has_images=true$' "$github_out"

echo "all cases passed"
