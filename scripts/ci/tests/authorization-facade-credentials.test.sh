#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Structural negative-leakage and authority-boundary proof for task.5228.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

workflow=.github/workflows/authorization-facade-credential-project.yml
authority=scripts/ci/authorization-facade-credentials.sh
projector=scripts/ci/project-authorization-facade-views.sh
fetcher=scripts/ci/fetch-authorization-facade-ring.mjs

# Raw credentials have no workflow inputs, outputs, artifacts, or environment
# values. The only GitHub secrets are the pre-existing SSH transport pair.
! grep -Eq '(^|[[:space:]])(token|credential|active|previous):[[:space:]]' "$workflow"
! grep -q 'actions/upload-artifact' "$workflow"
! grep -Eq 'GITHUB_(OUTPUT|ENV).*AUTHORIZATION_FACADE_TOKEN' "$workflow" "$authority" "$projector"

# A raw value may cross a process boundary only through stdin: OpenBao payloads,
# the fetcher→projector pipe, and curl --config -. Never put it in a command URL,
# command-line --arg, trace mode, or a diagnostic.
! grep -Eq '(set -x|curl[^\n]*(ACTIVE|PREVIOUS|WORKLOAD)|jq[^\n]+--arg[^\n]+\$(ACTIVE|PREVIOUS|WORKLOAD)|echo[^\n]+\$(ACTIVE|PREVIOUS|WORKLOAD))' "$authority" "$projector"
grep -q 'node scripts/ci/fetch-authorization-facade-ring.mjs |' "$workflow"
grep -q "curl .*--config -" "$projector"

# The verifier contract is digest-only, exact, and cannot accidentally regress
# to embedding raw active/previous values in the operator view.
grep -q 'AUTHORIZATION_FACADE_VERIFIER_RINGS_JSON' "$projector"
grep -q 'sha256sum' "$projector"
! grep -Eq 'MAP_FIELD=AUTHORIZATION_FACADE_(TOKEN|CREDENTIAL)' "$projector"

# Projection fetches reject redirects and plaintext origins at both hops.
test "$(grep -c 'redirect: "error"' "$fetcher")" -eq 2
grep -q 'base.protocol !== "https:"' "$fetcher"

# OpenBao authority access is exact lane-scoped policy + exact workflow claim.
grep -q 'cogni/data/${_lane}/authorization-facade' scripts/setup/provision-env-vm.sh
grep -q 'authorization-facade-credential-project.yml@refs/heads/main' scripts/setup/provision-env-vm.sh
grep -q 'bound_audiences=cogni-authorization-facade-projection' scripts/setup/provision-env-vm.sh

echo "authorization-facade-credentials: PASS"
