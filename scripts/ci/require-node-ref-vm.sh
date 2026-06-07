#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

environment="${DEPLOY_ENVIRONMENT:-candidate-a}"
vm_host="${VM_HOST:-}"
node_source_sha="${NODE_SOURCE_SHA:-}"

if [ -n "$vm_host" ]; then
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "has_vm=true" >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi

if [ -n "$node_source_sha" ]; then
  echo "::error::Node-ref ${environment} flight requires VM_HOST so live deploy and /version.buildSha verification cannot be skipped"
  exit 1
fi

echo "No VM_HOST secret set on ${environment} - skipping VM-backed deployment work"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "has_vm=false" >> "$GITHUB_OUTPUT"
fi
