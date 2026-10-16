#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Static contract proof for the deployed OpenFGA trust boundary. Live infra
# reconcile additionally runs bootstrap-openfga.sh's 401 probes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEPLOY="$REPO_ROOT/scripts/ci/deploy-infra.sh"
BOOTSTRAP="$REPO_ROOT/scripts/ci/bootstrap-openfga.sh"
CATALOG="$REPO_ROOT/infra/secrets-catalog.yaml"

grep -q '^OPENFGA_AUTHN_METHOD=preshared$' "$DEPLOY" \
  || { echo "deploy must force OpenFGA preshared authn" >&2; exit 1; }
grep -q 'openbao_get_field openfga OPENFGA_API_TOKEN' "$DEPLOY" \
  || { echo "deploy must source the OpenFGA credential from infrastructure custody" >&2; exit 1; }
grep -q 'OPENFGA_API_TOKEN=-' "$DEPLOY" \
  || { echo "deploy must project the OpenFGA credential to the operator bucket" >&2; exit 1; }
grep -q 'anonymous=401, non-operator=401' "$BOOTSTRAP" \
  || { echo "bootstrap must prove the raw API rejects untrusted callers" >&2; exit 1; }
if grep -q 'name: OPENFGA_API_TOKEN' "$CATALOG"; then
  echo "OPENFGA_API_TOKEN must not enter the node secrets catalog" >&2
  exit 1
fi

echo "PASS: openfga-preshared-authn.test.sh"
