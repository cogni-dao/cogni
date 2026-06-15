#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPT="${CI_DIR}/require-node-ref-vm.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

if VM_HOST="" \
  NODE_SOURCE_SHA=0123456789012345678901234567890123456789 \
  DEPLOY_ENVIRONMENT=candidate-a \
  GITHUB_OUTPUT="$WORKDIR/node-ref.out" \
  bash "$SCRIPT" >"$WORKDIR/node-ref.err" 2>&1; then
  echo "expected node-ref flight without VM_HOST to fail" >&2
  exit 1
fi
grep -q "Node-ref candidate-a flight requires VM_HOST" "$WORKDIR/node-ref.err"
test ! -s "$WORKDIR/node-ref.out"

VM_HOST="" \
  NODE_SOURCE_SHA="" \
  DEPLOY_ENVIRONMENT=candidate-a \
  GITHUB_OUTPUT="$WORKDIR/pr.out" \
  bash "$SCRIPT" >/dev/null
grep -q '^has_vm=false$' "$WORKDIR/pr.out"

VM_HOST=192.0.2.10 \
  NODE_SOURCE_SHA=0123456789012345678901234567890123456789 \
  DEPLOY_ENVIRONMENT=candidate-a \
  GITHUB_OUTPUT="$WORKDIR/ok.out" \
  bash "$SCRIPT" >/dev/null
grep -q '^has_vm=true$' "$WORKDIR/ok.out"

echo "all cases passed"
