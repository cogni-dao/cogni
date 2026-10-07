#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Static workflow contract: the external candidate preflight executes with the
# fleet custodian's credentials, runs substrate-only there, then read-only asserts
# the candidate target before prepare-substrate-deploy-branch can mutate git.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WF="$ROOT/.github/workflows/candidate-flight.yml"

job="$(sed -n '/^  external-node-preflight:/,/^  prepare-substrate-deploy-branch:/p' "$WF")"
printf '%s\n' "$job" | grep -Fq 'environment: ${{ vars.FLEET_CONTROL_ENV || '\''production'\'' }}'
printf '%s\n' "$job" | grep -Fq 'RUN_NODE_SUBSTRATE_SKIP_PROVIDER_ASSERT: "true"'
printf '%s\n' "$job" | grep -Fq 'RUN_NODE_SUBSTRATE_REQUIRED_LANE: candidate-a'
printf '%s\n' "$job" | grep -Fq 'run: bash ci-src/scripts/ci/run-node-substrate.sh "$DEPLOY_ENVIRONMENT"'
printf '%s\n' "$job" | grep -Fq "(vars.FLEET_CONTROL_ENV || 'production') == 'candidate-a' && vars.DOMAIN"
printf '%s\n' "$job" | grep -Fq 'DEPLOY_ENVIRONMENT: candidate-a'
printf '%s\n' "$job" | grep -Fq 'run: bash ci-src/scripts/ci/assert-target-substrate.sh'

# Ordering is structural: the deploy-branch job explicitly needs the completed
# external preflight, so no ComputeWorkload/deploy ref can be written first.
prepare="$(sed -n '/^  prepare-substrate-deploy-branch:/,/^  reconcile-appset:/p' "$WF")"
printf '%s\n' "$prepare" | grep -Fq 'external-node-preflight,'

echo "PASS: candidate-flight-custodian-preflight.test.sh"
