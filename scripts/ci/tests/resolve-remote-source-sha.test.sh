#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO_ROOT"

# shellcheck source=scripts/ci/lib/image-tags.sh
. scripts/ci/lib/image-tags.sh

operator_sha=1111111111111111111111111111111111111111
catalog_sha=3333333333333333333333333333333333333333
explicit_sha=2222222222222222222222222222222222222222
fixture_node=remote-node

# The catalog-shaped input must carry a well-formed pin, but this unit test must
# not depend on any deployment's live roster. Test parents intentionally carry
# different catalog rows from production.
case "$catalog_sha" in
  *[!0-9a-f]*|'') echo "fixture catalog source_sha is not a 40-hex sha: '$catalog_sha'" >&2; exit 1 ;;
esac
[ "${#catalog_sha}" -eq 40 ]

# Automatic preview of an operator merge resolves a remote node from the reviewed
# catalog snapshot, not from the operator commit SHA.
resolved=$(resolve_remote_source_sha "$fixture_node" "" "$operator_sha" "$catalog_sha" false "")
[ "$resolved" = "$catalog_sha" ]

# An explicit node source revision is always authoritative.
resolved=$(resolve_remote_source_sha "$fixture_node" "$explicit_sha" "$operator_sha" "$catalog_sha" false "")
[ "$resolved" = "$explicit_sha" ]

preview_map=$(mktemp)
trap 'rm -f "$preview_map"' EXIT
printf '{"%s":"%s"}\n' "$fixture_node" "$explicit_sha" > "$preview_map"
resolved=$(resolve_remote_source_sha "$fixture_node" "" "" "" true "$preview_map")
[ "$resolved" = "$explicit_sha" ]

if resolve_remote_source_sha "$fixture_node" "" "" "$catalog_sha" false "" >/dev/null 2>&1; then
  echo "expected absent authority to fail closed" >&2
  exit 1
fi

if resolve_remote_source_sha "$fixture_node" invalid "$operator_sha" "$catalog_sha" false "" >/dev/null 2>&1; then
  echo "expected invalid explicit source SHA to fail closed" >&2
  exit 1
fi

printf '{"%s":"invalid"}\n' "$fixture_node" > "$preview_map"
if resolve_remote_source_sha "$fixture_node" "" "" "" true "$preview_map" >/dev/null 2>&1; then
  echo "expected invalid preview provenance to fail closed" >&2
  exit 1
fi

echo "PASS: resolve-remote-source-sha.test.sh"
