#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RENDER="$ROOT/scripts/ci/render-akash-tx-actuator-lane-access.sh"
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

bash "$RENDER" production >"$TMPROOT/production.yaml"
[ "$(grep -c 'kind: Role$' "$TMPROOT/production.yaml")" -eq 2 ]
[ "$(grep -c 'kind: RoleBinding$' "$TMPROOT/production.yaml")" -eq 2 ]
[ "$(grep -c 'namespace: cogni-production' "$TMPROOT/production.yaml")" -eq 2 ]

# An isolated fleet is controlled by candidate-a: it needs narrow migration
# reach into preview + production, never a broad ClusterRole.
bash "$RENDER" candidate-a >"$TMPROOT/candidate-a.yaml"
grep -q 'namespace: cogni-preview' "$TMPROOT/candidate-a.yaml"
grep -q 'namespace: cogni-production' "$TMPROOT/candidate-a.yaml"
[ "$(grep -c 'namespace: cogni-candidate-a' "$TMPROOT/candidate-a.yaml")" -eq 2 ]
! grep -q 'kind: ClusterRole' "$TMPROOT/candidate-a.yaml"
[ "$(grep -c 'kind: Role$' "$TMPROOT/candidate-a.yaml")" -eq 2 ]
[ "$(grep -c 'kind: RoleBinding$' "$TMPROOT/candidate-a.yaml")" -eq 2 ]

if bash "$RENDER" garbage >"$TMPROOT/garbage.out" 2>"$TMPROOT/garbage.err"; then
  echo "invalid control environment unexpectedly rendered RBAC" >&2
  exit 1
fi

echo "render-akash-tx-actuator-lane-access: PASS"
