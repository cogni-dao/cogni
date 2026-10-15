#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# Run the actual workflow's nodeRef normalization. Any PR API call is a failure.
python3 - "$REPO_ROOT/.github/workflows/candidate-flight.yml" >"$TMPROOT/meta.sh" <<'PY'
import pathlib, re, sys, textwrap
workflow = pathlib.Path(sys.argv[1]).read_text()
start = workflow.index("          set -euo pipefail", workflow.index("- name: Resolve PR metadata"))
end = workflow.index("      - name: Checkout app source", start)
block = textwrap.dedent(workflow[start:end])
values = {"inputs.pr_number": "", "inputs.node_slug": "operator", "inputs.source_sha": "9f60e69c7b85db1bbb51b658f31dcacbfbc89117", "inputs.head_sha": "", "github.sha": "a" * 40, "github.server_url": "https://github.example", "github.repository": "fixture/repo", "github.run_id": "1"}
block = re.sub(r"\$\{\{\s*(.*?)\s*\}\}", lambda match: values[match[1]], block)
print('gh() { echo "unexpected PR lookup" >&2; exit 99; }')
print('yq() { printf "%s" "${REMOTE_SOURCE_REPO:-}"; }')
print(block)
PY

mkdir -p "$TMPROOT/infra/catalog"
touch "$TMPROOT/infra/catalog/operator.yaml"
(
  cd "$TMPROOT"
  GITHUB_OUTPUT="$TMPROOT/in-repo.out" bash "$TMPROOT/meta.sh"
  REMOTE_SOURCE_REPO=fixture/child GITHUB_OUTPUT="$TMPROOT/remote.out" bash "$TMPROOT/meta.sh"
)
grep -qx 'in_repo_source=true' "$TMPROOT/in-repo.out"
grep -qx 'head_sha=9f60e69c7b85db1bbb51b658f31dcacbfbc89117' "$TMPROOT/in-repo.out"
grep -qx 'resolved_pr_number=' "$TMPROOT/in-repo.out"
grep -qx 'in_repo_source=false' "$TMPROOT/remote.out"
grep -qx 'head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$TMPROOT/remote.out"

cat >"$TMPROOT/images.json" <<'JSON'
{"image_name":"ghcr.io/fixture/app","image_tag":"sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","platform":"linux/amd64","targets":[{"target":"operator","tag":"ghcr.io/fixture/app:sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","digest":"ghcr.io/fixture/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}
JSON
cat >"$TMPROOT/scope.json" <<'JSON'
{"base_sha":"cccccccccccccccccccccccccccccccccccccccc","changed_paths":["app/new.ts"],"added_paths":["app/new.ts"],"build_targets":["operator"],"flight_targets":["operator"]}
JSON
IMAGES_FILE="$TMPROOT/images.json" SCOPE_FILE="$TMPROOT/scope.json" \
  MANIFEST_FILE="$TMPROOT/manifest.json" HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  REPOSITORY=fixture/repo PR_NUMBER=2745 bash "$REPO_ROOT/scripts/ci/write-build-manifest.sh" >/dev/null

python3 - "$TMPROOT" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
release = json.loads((root / "manifest.json").read_text())
assert release["schema_version"] == 2
assert release["scope"] == json.loads((root / "scope.json").read_text())
assert release["targets"] == json.loads((root / "images.json").read_text())["targets"]
PY

# A real CLI invocation must reach structured input validation before network IO.
# This catches runtime facade/module-format failures hidden by unit-test aliases.
if GH_TOKEN=fixture SOURCE_SHA=invalid GITHUB_REPOSITORY=fixture/repo \
  RELEASE_OUTPUT_DIR="$TMPROOT/cli" GITHUB_OUTPUT="$TMPROOT/cli.out" \
  CATALOG_ROOT="$REPO_ROOT/infra/catalog" NODE_SLUG=operator \
  pnpm --dir "$REPO_ROOT/nodes/operator/app" exec tsx scripts/resolve-build-release.ts \
  >"$TMPROOT/cli.stdout" 2>"$TMPROOT/cli.stderr"; then
  echo "FAIL: invalid CLI source must be rejected" >&2
  exit 1
fi
python3 - "$TMPROOT/cli.stderr" <<'PY'
import json, pathlib, sys
events = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.startswith('{"event":')]
assert any(event.get("event") == "build_release.rejected" and event.get("code") == "release_invalid" for event in events), events
PY

echo "PASS: candidate-build-release.test.sh"
