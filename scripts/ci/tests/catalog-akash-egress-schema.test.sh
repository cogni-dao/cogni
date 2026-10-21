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

# Schema examples belong to the test, not a sovereign fleet roster.
. "$REPO_ROOT/scripts/ci/tests/fixtures/catalog.sh"
write_akash_catalog_fixture "$tmpdir/catalog" schema-fixture

yq 'del(.compute_egress_cidrs)' "$tmpdir/catalog/schema-fixture.yaml" >"$tmpdir/akash-without-egress.yaml"

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
  "$tmpdir/catalog/schema-fixture.yaml" >"$tmpdir/k3s-without-egress.yaml"

check-jsonschema \
  --schemafile "$REPO_ROOT/infra/catalog/_schema.json" \
  "$tmpdir/k3s-without-egress.yaml" >/dev/null

echo "ok 2 - explicit k3s-only catalog needs no compute egress declaration"

# Optional entry scopes are narrow subsets, not new substrate ports/environments.
yq '.envs = ["candidate-a", "production"] | .compute_egress_cidrs = [{"cidr":"65.108.194.156/32","comment":"production Temporal fixture","ports":[7233],"envs":["production"]}]' "$tmpdir/catalog/schema-fixture.yaml" > "$tmpdir/scoped-valid.yaml"
check-jsonschema --schemafile "$REPO_ROOT/infra/catalog/_schema.json" "$tmpdir/scoped-valid.yaml" >/dev/null
echo "ok 3 - scoped numeric Temporal port in owning production env is accepted"
for mutation in '.compute_egress_cidrs[0].ports = []' '.compute_egress_cidrs[0].ports = [8080]' '.compute_egress_cidrs[0].ports = ["7233"]' '.compute_egress_cidrs[0].ports = [7233,7233]' '.compute_egress_cidrs[0].envs = []' '.compute_egress_cidrs[0].envs = ["preview"]'; do
  yq "$mutation" "$tmpdir/scoped-valid.yaml" > "$tmpdir/scoped-invalid.yaml"
  if check-jsonschema --schemafile "$REPO_ROOT/infra/catalog/_schema.json" "$tmpdir/scoped-invalid.yaml" >/dev/null 2>&1; then
    echo "not ok 4 - invalid entry scope accepted: $mutation"; exit 1
  fi
done
echo "ok 4 - entry scopes reject empty/duplicate/unsupported ports and non-member envs"
