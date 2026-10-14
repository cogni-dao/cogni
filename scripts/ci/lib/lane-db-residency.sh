#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# lane-db-residency.sh — IS THIS LANE'S DATABASE ON ITS OWN ENVIRONMENT'S POSTGRES?
#
# ENV_IS_A_FAILURE_DOMAIN_NOT_A_NAME (bug.5299). `lane_db_suffix` made a foreign-custodied
# lane's database name UNIQUE, which stopped a lane reconcile from rotating production's live
# role (bug.5207). It did not move the database. `cogni_poly_candidate_a` is a distinct NAME
# on the SAME production Postgres instance, so candidate-a's load, connection count and
# crash blast radius still land in production's failure domain. Measured 2026-10-13:
# 31 of ~78 peak backends on the production instance belonged to non-production lanes.
#
# THE QUESTION THIS LIB ANSWERS is therefore not "what is the name" (image-tags.sh
# `node_database_for_target` owns that, lane-aware, per `lane-db-two-derivations`) but
# "whose instance is it on". That is catalog-derived and needs NO live database and NO
# network: a lane is MISRESIDENT exactly when the env whose cluster reconciles it is not the
# lane's own env — `control_env_for <lane> <node> != <lane>`, which is identically the
# condition under which `lane_db_suffix` emits a suffix.
#
# WHY AN ALLOWLIST AND NOT A STRAIGHT FAIL. Making the question correct makes it RED on
# today's `main`: four lanes are misresident right now. A gate that fails main cannot be
# merged, and weakening the gate to a warning everywhere would let the NEXT misresident lane
# in silently — every wizard-born node renders `deployment_provider.candidate-a: akash`, so
# the population grows by construction. The allowlist is the standard escape: the four known
# violations are named, in git, one line each, and everything else fails closed.
#
# THIS LIST IS A DEBT LEDGER AND MUST ONLY EVER SHRINK.
#   * Deleting the last entry is bug.5299's acceptance proof.
#   * Adding an entry is NOT a fix — it is a new instance of the bug and needs a human
#     decision on the work item, not a line here.
#   * `scripts/ci/tests/lane-db-residency.test.sh` asserts this list equals the committed
#     catalog's misresident set exactly, so a lane that MOVES fails the test until its entry
#     is deleted, and a lane that newly misresides fails the test until it is fixed. The
#     ledger cannot rot in either direction.
#
# Requires `control_env_for` + `lane_db_suffix` from scripts/ci/lib/appset-paths.sh and a
# CATALOG_DIR pointing at the catalog being asserted.
#
# Usage:
#   CATALOG_DIR=infra/catalog . scripts/ci/lib/appset-paths.sh
#   . scripts/ci/lib/lane-db-residency.sh
#   lane_db_residency_status <node> <lane>   # -> resident | misresident_allowlisted | misresident
#   lane_db_residency_check  <node> <lane>   # -> 0 (ok/warn) | 1 (misresident) | 2 (unresolvable)

# Known-misresident (node, lane) pairs, `<node>/<lane>`, one per line so a deletion is a
# one-line diff. Measured peak backends on the PRODUCTION instance, 7d to 2026-10-13.
LANE_DB_RESIDENCY_ALLOWLIST=(
  "poly/candidate-a" # cogni_poly_candidate_a — 15 peak backends on production
  "poly/preview"     # cogni_poly_preview     — 12 peak backends on production
  "red/candidate-a"  # cogni_red_candidate_a  —  2 peak backends on production
  "toks5/preview"    # cogni_toks5_preview    —  2 peak backends on production
)

# PURE: (catalog, node, lane) -> string. No database, no network, no SSH. This is what makes
# the invariant testable as a static CI gate rather than something only a live flight can
# discover.
lane_db_residency_status() {
  local node="${1:-}" lane="${2:-}" control entry
  if [ -z "$node" ] || [ -z "$lane" ]; then
    echo "::error::lane_db_residency_status: both <node> and <lane> are required" >&2
    return 2
  fi
  # FAIL CLOSED on an unresolvable row. control_env_for already refuses a missing catalog
  # file loudly (bug.5206) rather than defaulting to "reconciled here"; never paper over it
  # with a `|| printf resident`, which would report the safest possible answer for the one
  # case where nothing is known.
  control="$(control_env_for "$lane" "$node")" || return 2
  if [ -z "$(lane_db_suffix "$lane" "$control")" ]; then
    printf 'resident\n'
    return 0
  fi
  for entry in ${LANE_DB_RESIDENCY_ALLOWLIST[@]+"${LANE_DB_RESIDENCY_ALLOWLIST[@]}"}; do
    # EXACT PAIR MATCH. An entry grants nothing to any other lane of the same node and
    # nothing to the same lane of any other node: `red/candidate-a` being listed must not
    # silence `red/preview`.
    if [ "$entry" = "${node}/${lane}" ]; then
      printf 'misresident_allowlisted\n'
      return 0
    fi
  done
  printf 'misresident\n'
}

# Policy wrapper: warn loudly for a ledgered violation, fail closed for a new one.
lane_db_residency_check() {
  local node="${1:-}" lane="${2:-}" status control
  status="$(lane_db_residency_status "$node" "$lane")" || return 2
  control="$(control_env_for "$lane" "$node")" || return 2
  case "$status" in
    resident)
      printf '[OK] lane database residency: %s/%s is reconciled by its own env (%s)\n' \
        "$node" "$lane" "$control"
      ;;
    misresident_allowlisted)
      echo "::warning::lane database residency: ${node}/${lane} is MISRESIDENT — its database lives on ${control}'s Postgres, not ${lane}'s (bug.5299). Known violation, on the shrinking allowlist in scripts/ci/lib/lane-db-residency.sh. Non-production load is sharing ${control}'s failure domain; move the lane and delete the allowlist entry." >&2
      ;;
    misresident)
      echo "::error::lane database residency: ${node}/${lane} is MISRESIDENT and NOT allowlisted — its database would live on ${control}'s Postgres, not ${lane}'s (bug.5299). ENV_IS_A_FAILURE_DOMAIN_NOT_A_NAME: a non-production lane must not put load, connections or crash blast radius on another environment's instance. Do not add an entry to scripts/ci/lib/lane-db-residency.sh to pass this gate — that list only shrinks. Give ${lane} its own Postgres for ${node}." >&2
      return 1
      ;;
    *)
      echo "::error::lane_db_residency_check: unknown residency status '${status}' for ${node}/${lane}" >&2
      return 2
      ;;
  esac
}
