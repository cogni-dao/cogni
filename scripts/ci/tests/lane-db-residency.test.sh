#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Database residency follows its lane, independently of compute/vault custody.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export CATALOG_DIR="$REPO_ROOT/infra/catalog"
export COGNI_CATALOG_ROOT="$CATALOG_DIR"
. "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
. "$REPO_ROOT/scripts/ci/lib/lane-db-residency.sh"
TMPROOT="$(mktemp -d -t lane-db-residency.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT
fail() { echo "❌ $*" >&2; exit 1; }
want_status() {
  local node="$1" lane="$2" want="$3" got
  got="$(CATALOG_DIR="${CASE_CATALOG_DIR:-$CATALOG_DIR}" lane_db_residency_status "$node" "$lane")" \
    || fail "cannot resolve $node/$lane"
  [ "$got" = "$want" ] || fail "$node/$lane: got '$got', want '$want'"
}
[ -z "${LANE_DB_RESIDENCY_PINNED[*]:-}" ] || fail 'committed residency ledger must remain empty'
pairs=0
for catalog_file in "$CATALOG_DIR"/*.yaml; do
  node="$(basename "$catalog_file" .yaml)"
  [ "$(yq -N '.type // ""' "$catalog_file")" = node ] || continue
  while read -r lane; do
    [ -n "$lane" ] || continue
    want_status "$node" "$lane" resident
    [ "$(lane_db_vm_env "$node" "$lane")" = "$lane" ] || fail "foreign Postgres: $node/$lane"
    lane_db_residency_check "$node" "$lane" >/dev/null || fail "resident check failed: $node/$lane"
    pairs=$((pairs + 1))
  done < <(yq -r '.envs[]?' "$catalog_file")
done
[ "$pairs" -ge 10 ] || fail 'catalog enumeration unexpectedly empty'
echo "[1] all $pairs committed lanes are resident; ledger empty"

# New Akash birth: foreign compute custody MUST NOT imply foreign Postgres.
mkdir -p "$TMPROOT/catalog"
printf '%s\n' 'name: newborn' 'type: node' 'envs: [candidate-a, preview, production]' \
  'deployment_provider:' '  candidate-a: akash' '  preview: akash' '  production: akash' \
  > "$TMPROOT/catalog/newborn.yaml"
for lane in candidate-a preview production; do
  CASE_CATALOG_DIR="$TMPROOT/catalog" want_status newborn "$lane" resident
  CATALOG_DIR="$TMPROOT/catalog" lane_db_residency_check newborn "$lane" >/dev/null \
    || fail "new Akash birth must be resident: $lane"
done
echo '[2] future Akash births remain lane-resident without a ledger edit'

# Legacy pins may model rollback, but no foreign residency gets a warning-only pass.
(
  LANE_DB_RESIDENCY_PINNED=("poly/candidate-a")
  [ "$(lane_db_vm_env poly candidate-a)" != candidate-a ] || fail 'historical pin fixture did nothing'
  [ "$(lane_db_vm_env poly preview)" = preview ] || fail 'pin matched another lane'
  [ "$(lane_db_vm_env red candidate-a)" = candidate-a ] || fail 'pin matched another node'
  if lane_db_residency_check poly candidate-a >"$TMPROOT/pinned.out" 2>&1; then
    fail 'a reintroduced foreign pin must fail even when CI is bypassed'
  fi
)
# Inject a foreign answer WITHOUT a pin: the predicate must inspect actual PG residency.
(
  lane_db_vm_env() { printf '%s\n' production; }
  if lane_db_residency_check operator candidate-a >/dev/null 2>&1; then
    fail 'an unpinned foreign resolver result must fail closed'
  fi
)
echo '[3] both pinned and unpinned foreign resolver results fail closed'

for lane in candidate-a preview production; do
  if CATALOG_DIR="$TMPROOT/missing" lane_db_residency_status ghost "$lane" >/dev/null 2>&1; then
    fail "unknown catalog row must fail closed even on control-env fast path: $lane"
  fi
done
if lane_db_residency_status operator >/dev/null 2>&1; then
  fail 'missing lane must fail closed'
fi
echo 'PASS: lane-db-residency.test.sh'
