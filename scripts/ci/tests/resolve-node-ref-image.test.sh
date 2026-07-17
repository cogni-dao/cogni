#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPT="${CI_DIR}/resolve-node-ref-image.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

SHA=56995f3f49df93a591e1943a516eb8698796b278

mkdir -p "$WORKDIR/bin" "$WORKDIR/infra/catalog"
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
    ghcr.io/cogni-dao/poly:sha-56995f3f49df93a591e1943a516eb8698796b278)
      printf '"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n'
      exit 0
      ;;
    ghcr.io/cogni-dao/poly-paper-trader:sha-56995f3f49df93a591e1943a516eb8698796b278)
      printf '"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\n'
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

cat > "$WORKDIR/infra/catalog/poly.yaml" <<'YAML'
name: poly
type: node
port: 3200
node_port: 31400
dockerfile: nodes/poly/app/Dockerfile
image_tag_suffix: "-poly"
migrator_tag_suffix: "-poly-migrate"
source_repo: https://github.com/cogni-dao/poly.git
image_repository: ghcr.io/cogni-dao/poly
source_sha: 56995f3f49df93a591e1943a516eb8698796b278
candidate_a_branch: deploy/candidate-a-poly
preview_branch: deploy/preview-poly
production_branch: deploy/production-poly
envs: [candidate-a, preview, production]
path_prefix: nodes/poly/
node_id: 4b06359a-a859-4399-888e-a8c7a6696f7e
artifacts:
  - target: poly
    role: app
    image_repository: ghcr.io/cogni-dao/poly
  - target: poly-paper-trader
    role: sidecar
    image_repository: ghcr.io/cogni-dao/poly-paper-trader
    overlay_target: poly
    kustomize_image: ghcr.io/cogni-dao/poly-paper-trader
    envs: [candidate-a, preview]
YAML

candidate_out="$WORKDIR/candidate.json"
candidate_github_out="$WORKDIR/candidate-github-output.txt"
PATH="$WORKDIR/bin:$PATH" \
  COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  NODE=poly \
  SOURCE_SHA="$SHA" \
  OVERLAY_ENV=candidate-a \
  OUTPUT_FILE="$candidate_out" \
  GITHUB_OUTPUT="$candidate_github_out" \
  bash "$SCRIPT" >/dev/null

python3 - "$candidate_out" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
items = {item["target"]: item for item in payload["targets"]}
assert set(items) == {"poly", "poly-paper-trader"}, items
assert items["poly"]["digest"].endswith("@sha256:" + "a" * 64), items["poly"]
sidecar = items["poly-paper-trader"]
assert sidecar["role"] == "sidecar", sidecar
assert sidecar["overlay_target"] == "poly", sidecar
assert sidecar["kustomize_image"] == "ghcr.io/cogni-dao/poly-paper-trader", sidecar
assert sidecar["digest"].endswith("@sha256:" + "b" * 64), sidecar
PY
grep -q '^resolved_targets=poly,poly-paper-trader$' "$candidate_github_out"

production_out="$WORKDIR/production.json"
PATH="$WORKDIR/bin:$PATH" \
  COGNI_CATALOG_ROOT="$WORKDIR/infra/catalog" \
  NODE=poly \
  SOURCE_SHA="$SHA" \
  OVERLAY_ENV=production \
  OUTPUT_FILE="$production_out" \
  bash "$SCRIPT" >/dev/null

python3 - "$production_out" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
items = payload["targets"]
assert [item["target"] for item in items] == ["poly"], items
PY

echo "all cases passed"
