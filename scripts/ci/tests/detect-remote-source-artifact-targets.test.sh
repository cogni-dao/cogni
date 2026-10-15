#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CI_DIR}/../.." && pwd)"
SCRIPT="${REMOTE_ARTIFACT_TEST_SCRIPT:-${CI_DIR}/detect-remote-source-artifact-targets.sh}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"
git init -q
git config user.name test
git config user.email test@example.com
git commit -q --allow-empty -m empty
BASE_SHA=$(git rev-parse HEAD)
export BASE_SHA HEAD_SHA

mkdir -p infra/catalog
cat > infra/catalog/ay.yaml <<'YAML'
name: ay
type: node
port: 3200
node_port: 30400
dockerfile: nodes/ay/app/Dockerfile
image_tag_suffix: "-ay"
migrator_tag_suffix: "-ay-migrate"
source_repo: https://github.com/cogni-test-org/ay.git
image_repository: ghcr.io/cogni-test-org/ay
source_sha: 0123456789012345678901234567890123456789
candidate_a_branch: deploy/candidate-a-ay
preview_branch: deploy/preview-ay
production_branch: deploy/production-ay
path_prefix: nodes/ay/
YAML
cat > infra/catalog/operator.yaml <<'YAML'
name: operator
type: node
port: 3000
node_port: 30401
dockerfile: nodes/operator/app/Dockerfile
path_prefix: nodes/operator/
YAML
git add infra/catalog/ay.yaml
git add infra/catalog/operator.yaml
git commit -q -m fixture
HEAD_SHA=$(git rev-parse HEAD)

printf 'infra/catalog/ay.yaml\n' > added.txt
out="$WORKDIR/targets.json"
github_out="$WORKDIR/github-output.txt"

COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  CHANGED_PATHS_FILE="$WORKDIR/added.txt" \
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
assert item["tag"] == "ghcr.io/cogni-test-org/ay:sha-0123456789012345678901234567890123456789", item
PY

grep -q '^has_remote_source_artifact_targets=true$' "$github_out"
grep -q '^remote_source_artifact_targets=ay$' "$github_out"

# A real placement-only edit keeps its external artifact identity unchanged.
BASE_SHA=$HEAD_SHA
cat >> infra/catalog/ay.yaml <<'YAML'
database:
  production: { tier: dedicated, placement: akash-cell }
YAML
git add infra/catalog/ay.yaml
git commit -q -m placement
HEAD_SHA=$(git rev-parse HEAD)
COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  CHANGED_PATHS_FILE="$WORKDIR/added.txt" OUTPUT_FILE="$out" \
  bash "$SCRIPT" >/dev/null
jq -e '.targets == []' "$out" >/dev/null \
  || { echo 'placement-only catalog edit selected a historical external artifact' >&2; exit 1; }

# Catalog desired state is baked into the operator; it must produce a real image.
COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  CHANGED_PATHS_FILE="$WORKDIR/added.txt" \
  bash "$CI_DIR/detect-affected.sh" > "$WORKDIR/affected.txt"
grep -q '^Targets: operator$' "$WORKDIR/affected.txt" \
  || { echo 'catalog edit did not select the operator image' >&2; exit 1; }

# Each declared source-artifact field remains an actual artifact-change trigger.
for field in source_sha source_repo image_repository; do
  BASE_SHA=$HEAD_SHA
  case "$field" in
    source_sha) next=1111111111111111111111111111111111111111 ;;
    source_repo) next=https://github.com/cogni-test-org/ay-next.git ;;
    image_repository) next=ghcr.io/cogni-test-org/ay-next ;;
  esac
  NEXT="$next" yq -i ".${field} = strenv(NEXT)" infra/catalog/ay.yaml
  git add infra/catalog/ay.yaml
  git commit -q -m "artifact-${field}"
  HEAD_SHA=$(git rev-parse HEAD)
  COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
    CHANGED_PATHS_FILE="$WORKDIR/added.txt" OUTPUT_FILE="$out" \
    bash "$SCRIPT" >/dev/null
  jq -e '.targets | length == 1' "$out" >/dev/null
  jq -e '.targets[0].target == "ay"' "$out" >/dev/null
done

# Unknown ancestry is never treated as a new catalog row or a source change.
if BASE_SHA=0000000000000000000000000000000000000000 \
  COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  CHANGED_PATHS_FILE="$WORKDIR/added.txt" OUTPUT_FILE="$out" \
  bash "$SCRIPT" >"$WORKDIR/bad-base.log" 2>&1; then
  echo 'unavailable artifact baseline was accepted' >&2; exit 1
fi

# Preserve the existing source-map rollback boundary and explicit-source resolver.
printf '{"ay":"2222222222222222222222222222222222222222"}\n' > "$WORKDIR/source-map.json"
if APP=ay SOURCE_SHA=1111111111111111111111111111111111111111 \
  CATALOG_BIRTH_SHA=1111111111111111111111111111111111111111 \
  MAP_FILE="$WORKDIR/source-map.json" bash "$CI_DIR/update-source-sha-map.sh" >"$WORKDIR/pin.log" 2>&1; then
  echo 'catalog birth rollback was accepted' >&2; exit 1
fi
jq -e '.ay == "2222222222222222222222222222222222222222"' "$WORKDIR/source-map.json" >/dev/null
COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" bash -c '
  source "$1/lib/image-tags.sh"
  actual=$(resolve_remote_source_sha ay 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 1111111111111111111111111111111111111111 false "")
  [[ "$actual" == 3333333333333333333333333333333333333333 ]]
' fixture "$CI_DIR"

BASE_SHA=$HEAD_SHA
python3 - <<'PY'
from pathlib import Path

catalog = Path("infra/catalog/ay.yaml")
catalog.write_text(
    "\n".join(
        line
        for line in catalog.read_text(encoding="utf-8").splitlines()
        if not line.startswith("image_repository:")
    )
    + "\n",
    encoding="utf-8",
)
PY
git add infra/catalog/ay.yaml
git commit -q -m missing-image
HEAD_SHA=$(git rev-parse HEAD)

if COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  CHANGED_PATHS_FILE="$WORKDIR/added.txt" \
  OUTPUT_FILE="$WORKDIR/missing-image-repository.json" \
  bash "$SCRIPT" 2>"$WORKDIR/missing-image-repository.err"; then
  echo "expected missing image_repository to fail" >&2
  exit 1
fi
grep -q "image_repository missing for remote-source artifact ay" "$WORKDIR/missing-image-repository.err"

cd "$REPO_ROOT"
echo "all cases passed"
