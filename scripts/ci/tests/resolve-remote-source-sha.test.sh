#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO_ROOT"

# shellcheck source=scripts/ci/lib/image-tags.sh
. scripts/ci/lib/image-tags.sh

operator_sha=1111111111111111111111111111111111111111
catalog_sha=$(yq -N '.source_sha // ""' infra/catalog/toks4.yaml)
explicit_sha=2222222222222222222222222222222222222222

# The row must carry a well-formed pin, but its VALUE is the catalog's to
# choose — freezing it here couples this unit test to every legitimate
# re-pin (same live-row-fixture failure as the appset fixture, #2325).
case "$catalog_sha" in
  *[!0-9a-f]*|'') echo "toks4 catalog source_sha is not a 40-hex sha: '$catalog_sha'" >&2; exit 1 ;;
esac
[ "${#catalog_sha}" -eq 40 ]

# Automatic preview of an operator merge resolves toks4 from the reviewed
# catalog snapshot, not from the operator commit SHA.
resolved=$(resolve_remote_source_sha toks4 "" "$operator_sha" "$catalog_sha" false "")
[ "$resolved" = "$catalog_sha" ]

# An explicit node source revision is always authoritative.
resolved=$(resolve_remote_source_sha toks4 "$explicit_sha" "$operator_sha" "$catalog_sha" false "")
[ "$resolved" = "$explicit_sha" ]

preview_map=$(mktemp)
trap 'rm -f "$preview_map"' EXIT
printf '{"toks4":"%s"}\n' "$explicit_sha" > "$preview_map"
resolved=$(resolve_remote_source_sha toks4 "" "" "" true "$preview_map")
[ "$resolved" = "$explicit_sha" ]

if resolve_remote_source_sha toks4 "" "" "$catalog_sha" false "" >/dev/null 2>&1; then
  echo "expected absent authority to fail closed" >&2
  exit 1
fi

if resolve_remote_source_sha toks4 invalid "$operator_sha" "$catalog_sha" false "" >/dev/null 2>&1; then
  echo "expected invalid explicit source SHA to fail closed" >&2
  exit 1
fi

printf '{"toks4":"invalid"}\n' > "$preview_map"
if resolve_remote_source_sha toks4 "" "" "" true "$preview_map" >/dev/null 2>&1; then
  echo "expected invalid preview provenance to fail closed" >&2
  exit 1
fi

echo "PASS: resolve-remote-source-sha.test.sh"
