#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni

# task.5428 — compute_egress_cidrs is retired. Every lane reaches the shared
# substrate over its env mesh, so an Akash row owes no provider egress
# declaration, and a row that still declares one is rejected.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

check-jsonschema \
  --schemafile "$REPO_ROOT/infra/catalog/_schema.json" \
  "$REPO_ROOT/infra/catalog/red.yaml" >/dev/null

echo "ok 1 - Akash catalog row without compute egress is accepted"

yq '.compute_egress_cidrs = [{"cidr":"65.108.194.156/32","comment":"retired fixture"}]' \
  "$REPO_ROOT/infra/catalog/red.yaml" >"$tmpdir/akash-with-egress.yaml"

if check-jsonschema \
  --schemafile "$REPO_ROOT/infra/catalog/_schema.json" \
  "$tmpdir/akash-with-egress.yaml" >"$tmpdir/validation.log" 2>&1; then
  echo "not ok 2 - retired compute_egress_cidrs was accepted"
  exit 1
fi

if ! grep -Fq "should not be valid under {'required': ['compute_egress_cidrs']}" "$tmpdir/validation.log"; then
  cat "$tmpdir/validation.log"
  echo "not ok 2 - schema failed for the wrong reason"
  exit 1
fi

echo "ok 2 - a row that still declares compute_egress_cidrs is rejected"

yq '.required_placement_countries = {"production": ["FI", "UA"]}' \
  "$REPO_ROOT/infra/catalog/red.yaml" >"$tmpdir/placement.yaml"
check-jsonschema \
  --schemafile "$REPO_ROOT/infra/catalog/_schema.json" \
  "$tmpdir/placement.yaml" >/dev/null

echo "ok 3 - a placement country set needs no provider egress declaration"
