#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Run the dependency-free context client's HTTP/cache seam tests in CI.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
node --test "$REPO_ROOT/scripts/ci/tests/work-item-context.test.mjs"
