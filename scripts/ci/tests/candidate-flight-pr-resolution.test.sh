#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# Execute the workflow's actual resolver against commit-associated PR fixtures.
python3 - "$REPO_ROOT/.github/workflows/candidate-flight.yml" >"$TMPROOT/resolve.sh" <<'PY'
import pathlib
import sys

workflow = pathlib.Path(sys.argv[1]).read_text()
start = workflow.index("              mapfile -t MATCHING_PRS")
end = workflow.index("            else\n              # Remote node:", start)
resolver = workflow[start:end].replace("${{ github.repository }}", "fixture/repo")
print('set -euo pipefail')
print('RESOLVED_PR_NUMBER=""')
print('gh() { jq "${!#}" "$PR_FIXTURE"; }')
print(resolver)
print('printf "resolved_pr_number=%s\\n" "$RESOLVED_PR_NUMBER"')
PY

SOURCE_SHA="9f60e69c7b85db1bbb51b658f31dcacbfbc89117"
DESCENDANT_SHA="534bf600a7a19a6e9a1f4ffb99ce09287b1568af"

cat >"$TMPROOT/stack.json" <<JSON
[
  {"number":2748,"state":"open","head":{"sha":"$DESCENDANT_SHA"}},
  {"number":2745,"state":"open","head":{"sha":"$SOURCE_SHA"}}
]
JSON
cat >"$TMPROOT/ambiguous.json" <<JSON
[
  {"number":2745,"state":"open","head":{"sha":"$SOURCE_SHA"}},
  {"number":9999,"state":"open","head":{"sha":"$SOURCE_SHA"}}
]
JSON
cat >"$TMPROOT/no-head.json" <<JSON
[
  {"number":2748,"state":"open","head":{"sha":"$DESCENDANT_SHA"}},
  {"number":2745,"state":"closed","head":{"sha":"$SOURCE_SHA"}}
]
JSON
cat >"$TMPROOT/closed-peer.json" <<JSON
[
  {"number":9999,"state":"closed","head":{"sha":"$SOURCE_SHA"}},
  {"number":2745,"state":"open","head":{"sha":"$SOURCE_SHA"}}
]
JSON
printf '[]\n' >"$TMPROOT/empty.json"

resolve() {
  NODE_SOURCE_SHA="${2:-$SOURCE_SHA}" PR_FIXTURE="$TMPROOT/$1.json" \
    bash "$TMPROOT/resolve.sh"
}

resolve stack >"$TMPROOT/stack.out"
grep -qx 'resolved_pr_number=2745' "$TMPROOT/stack.out"

if resolve ambiguous >"$TMPROOT/ambiguous.out" 2>&1; then
  echo "FAIL: genuinely ambiguous exact heads must fail closed" >&2
  exit 1
fi
grep -q 'exact head of multiple open PRs: 2745 9999' "$TMPROOT/ambiguous.out"

resolve no-head >"$TMPROOT/no-head.out"
grep -qx 'resolved_pr_number=' "$TMPROOT/no-head.out"
grep -q 'preserving single-target node-ref behavior' "$TMPROOT/no-head.out"

resolve closed-peer >"$TMPROOT/closed-peer.out"
grep -qx 'resolved_pr_number=2745' "$TMPROOT/closed-peer.out"

resolve stack "$(printf '%s' "$SOURCE_SHA" | tr '[:lower:]' '[:upper:]')" >"$TMPROOT/uppercase.out"
grep -qx 'resolved_pr_number=2745' "$TMPROOT/uppercase.out"

resolve empty >"$TMPROOT/empty.out"
grep -qx 'resolved_pr_number=' "$TMPROOT/empty.out"

echo "PASS: candidate-flight-pr-resolution.test.sh"
