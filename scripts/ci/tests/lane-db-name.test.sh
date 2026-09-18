#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# lane-db-name.test.sh — the database a lane's DSN NAMES must equal the one its provisioner
# CREATES (bug.5207).
#
# Two independent derivations produce that name:
#   READ  — `_compose_node_value` (scripts/setup/lib/reconcile-secrets.sh) builds the DSN the
#           workload receives.
#   WRITE — `node_database_for_target` (scripts/ci/lib/image-tags.sh) names the database the
#           provisioner creates, and `provision.sh` derives app_/service_ roles FROM it.
#
# #2313 made only the READ side lane-aware. Left there the two disagree, and the WRITE side is
# the dangerous one: a lane reconcile on the paying cluster would provision PRODUCTION's
# `cogni_<node>` and reconcile the LIVE `app_<node>` password to the lane's value.
#
# This test is the reason they cannot drift again.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CATALOG_DIR="$REPO_ROOT/infra/catalog"
export COGNI_CATALOG_ROOT="$CATALOG_DIR"

# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
# shellcheck source=scripts/ci/lib/image-tags.sh
. "$REPO_ROOT/scripts/ci/lib/image-tags.sh"

fail() { echo "❌ $*" >&2; exit 1; }

# READ side, reproduced exactly as reconcile-secrets.sh composes it.
read_side_db() {
  local node="$1" lane="$2" control="$3"
  printf 'cogni_%s%s' "${node//-/_}" "$(lane_db_suffix "$lane" "$control")"
}

# ── The two derivations agree for every (lane, node) the catalog can produce ──
for node in poly operator beacon toks4 scheduler-worker; do
  for lane in candidate-a preview production; do
    control="$(control_env_for "$lane" "$node")"
    want="$(read_side_db "$node" "$lane" "$control")"
    got="$(node_database_for_target "$node" "$lane")"
    [ "$got" = "$want" ] || fail "READ/WRITE disagree for ${lane}/${node}: provisioner='${got}' dsn='${want}'"
  done
done

# ── A foreign-custodied lane MUST NOT reuse production's objects ──
poly_ca="$(node_database_for_target poly candidate-a)"
poly_prod="$(node_database_for_target poly production)"
[ "$poly_ca" != "$poly_prod" ] \
  || fail "poly's candidate-a lane resolves to production's database '${poly_prod}' — a lane reconcile would rotate the LIVE app_poly password (bug.5207)"

# ── ZERO MIGRATION: every row that exists today keeps its exact historic name ──
[ "$poly_prod" = "cogni_poly" ] || fail "production poly database changed: ${poly_prod}"
[ "$(node_database_for_target poly)" = "cogni_poly" ] || fail "the no-lane call must be byte-identical to before"
[ "$(node_database_for_target operator candidate-a)" = "cogni_operator" ] \
  || fail "a k3s lane is reconciled by its own cluster and must be untouched by the split"

echo "PASS: lane-db-name.test.sh"
