#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CI_DIR}/../.." && pwd)"
SCRIPT="${CI_DIR}/detect-submodule-births.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"
git init -q
git config user.name test
git config user.email test@example.com

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
image_repository: ghcr.io/cogni-test-org/cogni-node-template
candidate_a_branch: deploy/candidate-a-ay
preview_branch: deploy/preview-ay
production_branch: deploy/production-ay
path_prefix: nodes/ay/
YAML
cat > .gitmodules <<'GITMODULES'
[submodule "nodes/ay"]
	path = nodes/ay
	url = https://github.com/cogni-test-org/ay.git
GITMODULES
mkdir -p nodes
git update-index --add --cacheinfo 160000,0123456789012345678901234567890123456789,nodes/ay
git add infra/catalog/ay.yaml .gitmodules
git commit -q -m fixture

printf 'infra/catalog/ay.yaml\n' > added.txt
out="$WORKDIR/births.json"
github_out="$WORKDIR/github-output.txt"

COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  ADDED_PATHS_FILE="$WORKDIR/added.txt" \
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
assert item["tag"] == "ghcr.io/cogni-test-org/cogni-node-template:sha-0123456789012345678901234567890123456789", item
PY

grep -q '^has_submodule_births=true$' "$github_out"
grep -q '^submodule_birth_targets=ay$' "$github_out"

cd "$REPO_ROOT"
echo "all cases passed"
