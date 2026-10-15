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
receipt=nodes/operator/app/src/app/api/internal/authorization-facade-workload-receipt/route.ts

# Raw credentials have no workflow inputs, outputs, artifacts, or environment
# values. The only GitHub secrets are the pre-existing SSH transport pair.
! grep -Eq '(^|[[:space:]])(token|credential|active|previous):[[:space:]]' "$workflow"
! grep -q 'actions/upload-artifact' "$workflow"
! grep -Eq 'GITHUB_(OUTPUT|ENV).*AUTHORIZATION_FACADE_TOKEN' "$workflow" "$authority" "$projector"

# A raw value may cross a process boundary only through stdin: OpenBao payloads,
# the fetcher→projector pipe, and curl --config -. Never put it in a command URL,
# command-line --arg, trace mode, or a diagnostic.
! grep -Eq '(set -x|curl.*\$(ACTIVE|PREVIOUS|WORKLOAD)|jq.*--arg.*\$(ACTIVE|PREVIOUS|WORKLOAD)|echo.*\$(ACTIVE|PREVIOUS|WORKLOAD))' "$authority" "$projector"
grep -q 'node scripts/ci/fetch-authorization-facade-ring.mjs |' "$workflow"
grep -q "curl .*--config -" "$projector"
grep -q 'curl .*--config -' "$authority"

# The verifier contract is digest-only, exact, and cannot accidentally regress
# to embedding raw active/previous values in the operator view.
grep -q 'AUTHORIZATION_FACADE_VERIFIER_RINGS_JSON' "$projector"
grep -q 'sha256sum' "$projector"
! grep -Eq 'MAP_FIELD=AUTHORIZATION_FACADE_(TOKEN|CREDENTIAL)' "$projector"

# A rejected finish/cancel cannot partially revoke the credential that remains
# loaded by the workload: state preflight must precede verifier-map mutation.
preflight_line="$(grep -n 'Refuse an invalid finish/cancel BEFORE' "$projector" | cut -d: -f1)"
map_line="$(grep -n '^OPERATOR_PATH=' "$projector" | cut -d: -f1)"
test "$preflight_line" -lt "$map_line"
grep -q 'cancel refused after activation' "$projector"
grep -q 'credential overlap pending; use explicit activate/finish/cancel' "$authority"
grep -q 'no third credential minted' "$authority"

# Rotation finishes only after a workload-originated semantic receipt. The
# target process proves the bearer equals its loaded env value, then executes a
# real semantic check and returns only a new boot identity + build revision.
grep -q 'timingSafeEqual' "$receipt"
grep -q 'process.env.AUTHORIZATION_FACADE_TOKEN' "$receipt"
grep -q '/api/v1/authorization/check' "$receipt"
grep -q 'bootId' "$receipt"
grep -q 'APP_BUILD_SHA' "$receipt"
grep -q 'Cache-Control.*no-store' "$receipt"
grep -q 'workload_receipt "$ACTIVE"' "$authority"
grep -q 'workload_receipt "$PREVIOUS"' "$authority"
grep -q 'workload has not restarted since rotation prepare' "$authority"
grep -q "inputs.operation == 'activate'" "$workflow"

# k3s activation proves the ESO Secret digest, forces a restart, and requires a
# strictly newer Deployment generation/resourceVersion before receipt confirm.
digest_line="$(grep -n 'projected workload credential did not converge' "$projector" | cut -d: -f1)"
restart_line="$(grep -n 'rollout restart' "$projector" | cut -d: -f1)"
advanced_line="$(grep -n 'deployment revision did not advance' "$projector" | cut -d: -f1)"
test "$digest_line" -lt "$restart_line"
test "$restart_line" -lt "$advanced_line"
grep -q 'deployment_generation_before' "$projector"
grep -q 'deployment_resource_version_before' "$projector"

# Projection fetches reject redirects and plaintext origins at both hops.
test "$(grep -c 'redirect: "error"' "$fetcher")" -eq 2
grep -q 'base.protocol !== "https:"' "$fetcher"

# OpenBao authority access is exact lane-scoped policy + exact workflow claim.
grep -q 'cogni/data/${_lane}/authorization-facade' scripts/setup/provision-env-vm.sh
grep -q 'authorization-facade-credential-project.yml@refs/heads/main' scripts/setup/provision-env-vm.sh
grep -q 'bound_audiences=cogni-authorization-facade-projection' scripts/setup/provision-env-vm.sh

echo "authorization-facade-credentials: PASS"
