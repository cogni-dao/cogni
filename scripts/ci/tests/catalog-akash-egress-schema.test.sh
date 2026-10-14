#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni

# bug.5382 — every off-cluster node must declare the provider egress admitted
# to shared substrate ports. Prove the schema rejects the exact birth defect
# that previously required manual Red/toks5 catalog repairs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

yq 'del(.compute_egress_cidrs)' "$REPO_ROOT/infra/catalog/red.yaml" >"$tmpdir/akash-without-egress.yaml"

if check-jsonschema \
  --schemafile "$REPO_ROOT/infra/catalog/_schema.json" \
  "$tmpdir/akash-without-egress.yaml" >"$tmpdir/validation.log" 2>&1; then
  echo "not ok 1 - Akash catalog without compute egress was accepted"
  exit 1
fi

if ! grep -Fq "'compute_egress_cidrs' is a required property" "$tmpdir/validation.log"; then
  cat "$tmpdir/validation.log"
  echo "not ok 1 - schema failed for the wrong reason"
  exit 1
fi

echo "ok 1 - Akash catalog without compute egress is rejected"

yq '.deployment_provider = {"candidate-a": "k3s", "preview": "k3s", "production": "k3s"} | del(.compute_egress_cidrs)' \
  "$REPO_ROOT/infra/catalog/red.yaml" >"$tmpdir/k3s-without-egress.yaml"

check-jsonschema \
  --schemafile "$REPO_ROOT/infra/catalog/_schema.json" \
  "$tmpdir/k3s-without-egress.yaml" >/dev/null

echo "ok 2 - explicit k3s-only catalog needs no compute egress declaration"
