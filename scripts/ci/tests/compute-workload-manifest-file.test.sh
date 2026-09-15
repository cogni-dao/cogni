#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# bug.5148 — the deploy lane must RESOLVE the rendered workload manifest's filename from the
# catalog, never hardcode it. ONE_AUTHORITY_PER_WORKLOAD: a `compute_api: crossplane` cell
# renders `xcomputeworkload.yaml` and deliberately does NOT render `compute-workload.yaml`, so a
# hardcoded `compute-workload.yaml` check can never pass for the Crossplane authority. That is
# exactly what refused the first real Crossplane mint (levelup@f1fd69c2) at
# candidate-flight.yml's "Prepared external ComputeWorkload missing" gate.
#
# Proves the shell twin of resolveNodeComputeApi() + computeWorkloadManifestFile()
# (nodes/operator/app/src/features/compute/{node-compute-api,compute-workload-manifest}.ts):
#   1. absent `compute_api` cell        → legacy     → compute-workload.yaml   (LEGACY_IS_DEFAULT)
#   2. explicit `legacy`                → legacy     → compute-workload.yaml
#   3. explicit `crossplane`            → crossplane → xcomputeworkload.yaml
#   4. unknown value                    → loud, non-zero failure (never a silent downgrade to
#                                         legacy — the two authorities mint Akash leases under
#                                         disjoint idempotence keys, so a quiet fallback buys a
#                                         SECOND PAID LEASE)
#   5. per-env independence: one row's crossplane cell does not leak into its other envs
#   6. the COMMITTED catalog resolves as the deploy lane expects today
#
# Fixture cases run against a throwaway catalog copy via COGNI_CATALOG_ROOT; the committed
# infra/catalog/*.yaml is never mutated.
#
# Run: bash scripts/ci/tests/compute-workload-manifest-file.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

LIB="$REPO_ROOT/scripts/ci/lib/image-tags.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "  ok — $*"; }

TMP_CATALOG="$(mktemp -d)"
trap 'rm -rf "$TMP_CATALOG"' EXIT
cp "$REPO_ROOT"/infra/catalog/*.yaml "$TMP_CATALOG/"
cp "$REPO_ROOT"/infra/catalog/_schema.json "$TMP_CATALOG/" 2>/dev/null || true

# The fixture row. `node-template` is a real type:node with no compute_api cell on main, so
# case 1 reads the committed shape and the later cases mutate only the copy.
FIXTURE_NODE="node-template"
FIXTURE_FILE="$TMP_CATALOG/${FIXTURE_NODE}.yaml"

# Resolve (api, file) for a cell against the throwaway catalog. Each invocation re-sources the
# lib in a fresh shell so the source-time catalog cache is rebuilt from the mutated fixture.
resolve() {
  local node="$1" env="$2" what="$3"
  COGNI_CATALOG_ROOT="$TMP_CATALOG" bash -c '
    set -euo pipefail
    . "$1"
    case "$4" in
      api) compute_api_for_target "$2" "$3" ;;
      file) compute_workload_manifest_file "$2" "$3" ;;
    esac
  ' _ "$LIB" "$node" "$env" "$what"
}

echo "[1/6] absent compute_api cell → legacy → compute-workload.yaml (LEGACY_IS_DEFAULT)"
if yq -N -e '.compute_api' "$FIXTURE_FILE" >/dev/null 2>&1; then
  fail "fixture precondition: ${FIXTURE_NODE}.yaml already declares compute_api"
fi
[ "$(resolve "$FIXTURE_NODE" candidate-a api)" = "legacy" ] ||
  fail "absent cell must resolve to legacy"
[ "$(resolve "$FIXTURE_NODE" candidate-a file)" = "compute-workload.yaml" ] ||
  fail "absent cell must render compute-workload.yaml"
pass "absent → legacy → compute-workload.yaml"

echo "[2/6] explicit legacy → compute-workload.yaml"
yq -i '.compute_api."candidate-a" = "legacy"' "$FIXTURE_FILE"
[ "$(resolve "$FIXTURE_NODE" candidate-a api)" = "legacy" ] ||
  fail "explicit legacy must resolve to legacy"
[ "$(resolve "$FIXTURE_NODE" candidate-a file)" = "compute-workload.yaml" ] ||
  fail "explicit legacy must render compute-workload.yaml"
pass "legacy → compute-workload.yaml"

echo "[3/6] explicit crossplane → xcomputeworkload.yaml"
yq -i '.compute_api."candidate-a" = "crossplane"' "$FIXTURE_FILE"
[ "$(resolve "$FIXTURE_NODE" candidate-a api)" = "crossplane" ] ||
  fail "explicit crossplane must resolve to crossplane"
[ "$(resolve "$FIXTURE_NODE" candidate-a file)" = "xcomputeworkload.yaml" ] ||
  fail "explicit crossplane must render xcomputeworkload.yaml"
pass "crossplane → xcomputeworkload.yaml"

echo "[4/6] per-env independence: crossplane on candidate-a does not leak to preview"
[ "$(resolve "$FIXTURE_NODE" preview file)" = "compute-workload.yaml" ] ||
  fail "a crossplane candidate-a cell must not change the preview cell"
pass "preview still resolves to compute-workload.yaml"

echo "[5/6] unknown compute_api value → loud failure, never a silent legacy downgrade"
yq -i '.compute_api."candidate-a" = "terraform"' "$FIXTURE_FILE"
if out="$(resolve "$FIXTURE_NODE" candidate-a api 2>&1)"; then
  fail "unknown compute_api must exit non-zero (got '$out')"
fi
case "$out" in
  *"unsupported compute_api 'terraform'"*) : ;;
  *) fail "unknown compute_api error must name the offending value (got '$out')" ;;
esac
if out="$(resolve "$FIXTURE_NODE" candidate-a file 2>&1)"; then
  fail "unknown compute_api must fail the filename resolver too (got '$out')"
fi
pass "unknown value fails closed and names itself"

echo "[6/6] committed catalog resolves as the deploy lane expects"
# Derived from the catalog, not hardcoded, so this never goes stale when a row opts in.
while IFS= read -r catalog; do
  node="$(basename "$catalog" .yaml)"
  for env in candidate-a preview production; do
    declared="$(yq -N ".compute_api.\"${env}\" // \"legacy\"" "$catalog")"
    [ -n "$declared" ] && [ "$declared" != "null" ] || declared="legacy"
    expected="compute-workload.yaml"
    [ "$declared" = "crossplane" ] && expected="xcomputeworkload.yaml"
    actual="$(COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" bash -c '
      set -euo pipefail
      . "$1"
      compute_workload_manifest_file "$2" "$3"
    ' _ "$LIB" "$node" "$env")"
    [ "$actual" = "$expected" ] ||
      fail "${node}/${env}: declared ${declared} → expected ${expected}, got ${actual}"
  done
done < <(yq -N 'select(.type == "node") | .name' "$REPO_ROOT"/infra/catalog/*.yaml |
  while IFS= read -r n; do echo "$REPO_ROOT/infra/catalog/${n}.yaml"; done)
pass "every committed type:node row resolves to the file its compute_api declares"

echo "compute-workload-manifest-file.test.sh OK"
