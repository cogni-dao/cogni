#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# Keep the retired names split so this regression test cannot match itself.
legacy_internal="INTERNAL_OPS_""TOKEN"
legacy_recovery="POLY_WALLET_RECOVERY_OPS_""TOKEN"

for retired_name in "$legacy_internal" "$legacy_recovery"; do
  if matches=$(git grep -n -- "$retired_name" -- \
    . \
    ':(exclude)docs/archive/**' \
    ':(exclude)docs/handoffs/**' \
    ':(exclude)work/handoffs/**'); then
    echo "ERROR: retired standing-bearer credential is still referenced: $retired_name" >&2
    echo "$matches" >&2
    exit 1
  fi
done

echo "legacy operations-token purge guard passed"
