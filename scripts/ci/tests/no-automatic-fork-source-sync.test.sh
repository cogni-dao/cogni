#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Module: scripts/ci/tests/no-automatic-fork-source-sync.test.sh
# Purpose: Fail closed if the retired node-template → fork source-writing lane is reintroduced.
# Scope: Read-only structural guard over operator runtime, workflows, and CI commands.
# Invariants: AUTOMATIC_FORK_SOURCE_SYNC_DOES_NOT_EXIST (bug.5304).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

forbidden='dispatchCanonicalForkSync|syncCanonicalFilesToFork|syncTemplateUpstreamToFork|listCatalogForkTargets|resolveNodeLocalPaths|cogni-operator/node-template-(sync|upstream)'

if git grep -n -E "$forbidden" -- \
  nodes/operator/app/src \
  .github/workflows \
  scripts/ci \
  ':(exclude)scripts/ci/tests/no-automatic-fork-source-sync.test.sh'; then
  echo "::error::automatic node-template fork source-writing seam detected (bug.5304)"
  exit 1
fi

test ! -e nodes/operator/app/src/app/_facades/deploy/canonical-fork-sync.server.ts
test ! -e scripts/ci/sync-node-template-fork-pr.sh

echo "no-automatic-fork-source-sync: PASS"
