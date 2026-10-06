#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Rebuild the zero-install operator-change replay verifier from its canonical
# TypeScript sources and require byte-for-byte identity with the checked-in
# artifact consumed by reusable child-repository CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXPECTED="$REPO_ROOT/scripts/ci/dist/operator-change-replay.cjs"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

cd "$REPO_ROOT"
OPERATOR_CHANGE_BUNDLE_OUT_DIR="$OUT_DIR" \
  pnpm exec tsup --config scripts/ci/tsup.operator-change-replay.config.ts

cmp "$EXPECTED" "$OUT_DIR/operator-change-replay.cjs" || {
  echo "operator-change-replay bundle is stale; regenerate it in trusted CI" >&2
  exit 1
}

echo "operator-change-replay bundle matches canonical TypeScript sources"
