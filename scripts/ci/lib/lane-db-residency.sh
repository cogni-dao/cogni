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
# WHY A LEDGER AND NOT A STRAIGHT FAIL. Making the question correct makes it RED on
# today's `main`: four lanes are misresident right now. A gate that fails main cannot be
# merged, and weakening the gate to a warning everywhere would let the NEXT misresident lane
# in silently — every wizard-born node renders `deployment_provider.candidate-a: akash`, so
# the population grows by construction. The ledger is the standard escape: the four known
# violations are named, in git, one line each, and everything else fails closed. Since the
# resolver landed, that same ledger is also the PIN that answers "whose instance" — see
# LANE_DB_RESIDENCY_PINNED below.
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
#   lane_db_vm_env           <node> <lane>   # -> the env whose Postgres holds this lane's DB
#   lane_db_host             <node> <lane>   # -> that env's VM alias
#   lane_db_assert_agreement <node> <lane> [dsn]   # stored DSN == both derivations

# THE LEDGER *IS* THE PIN (bug.5299, 2026-10-14 ruling). These are the known-misresident
# (node, lane) pairs, `<node>/<lane>`, one per line so a deletion is a one-line diff. They are
# ALSO the input to `lane_db_vm_env`: a PINNED pair resolves to its control env — today's exact
# behaviour, byte-for-byte — and an UNPINNED pair resolves to the lane itself. That is what
# makes the list able to reach empty, and it is why the old `LANE_DB_RESIDENCY_ALLOWLIST` name
# (PR #2731) was wrong: the list does not grant an exception, it STATES WHERE THE DATABASE IS.
#
# UNPINNING IS NOT A FREE EDIT, AND THE INTERLOCK IS DELIBERATE. Deleting a line changes the
# NAME `node_database_for_target` derives (the suffix collapses) while the DSN still carries
# the control env's `${VM_IP}` until the composer call site lands — i.e. it would point the
# lane at production's LIVE `cogni_<node>`/`app_<node>`, which is bug.5207's destructive shape
# on the destination host. Group 5 of scripts/ci/tests/lane-db-residency.test.sh asserts this
# list EQUALS the committed catalog's misresident set, so a bare unpin turns CI RED and the
# only way to green is for the lane's placement to actually have moved. Do not weaken it.
#
# Measured peak backends on the PRODUCTION instance, 7d to 2026-10-13.
LANE_DB_RESIDENCY_PINNED=(
  "poly/candidate-a" # cogni_poly_candidate_a — 15 peak backends on production
  "poly/preview"     # cogni_poly_preview     — 12 peak backends on production
  "red/candidate-a"  # cogni_red_candidate_a  —  2 peak backends on production
  "toks5/preview"    # cogni_toks5_preview    —  2 peak backends on production
)

# EXACT PAIR MATCH, one definition. A pin states nothing about any other lane of the same
# node and nothing about the same lane of any other node: `red/candidate-a` being pinned must
# not pin `red/preview`. Both the residency verdict and the resolver read the list through
# here so the matching rule cannot drift between them.
_lane_db_is_pinned() {
  local node="${1:-}" lane="${2:-}" entry
  for entry in ${LANE_DB_RESIDENCY_PINNED[@]+"${LANE_DB_RESIDENCY_PINNED[@]}"}; do
    [ "$entry" = "${node}/${lane}" ] && return 0
  done
  return 1
}

# PURE: (catalog, node, lane) -> string. No database, no network, no SSH. This is what makes
# the invariant testable as a static CI gate rather than something only a live flight can
# discover.
lane_db_residency_status() {
  local node="${1:-}" lane="${2:-}" control
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
  if _lane_db_is_pinned "$node" "$lane"; then
    printf 'misresident_allowlisted\n'
    return 0
  fi
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

# ─────────────────────────────────────────────────────────────────────────────────────────
# THE RESIDENCY RESOLVER — ONE CELL, INERT TODAY (bug.5299 Pareto step 3)
#
# WHY A RESOLVER AND NOT A SECOND PREDICATE. `lane_db_residency_status` above answers
# "is this wrong", and it answers it through `control_env_for`, i.e. through COMPUTE
# PLACEMENT. That is a proxy, and the 2026-10-14 ruling on this item is that the proxy —
# not node birth — was the defect: every wizard birth renders
# `deployment_provider.candidate-a: akash`, so a placement-keyed predicate calls every
# newborn node misresident forever and the ledger can never empty no matter how much data
# moves. `lane_db_vm_env` replaces the proxy with a direct statement about WHERE THE
# DATABASE IS, keyed on the pin ledger, which an UNPINNED newborn is not in.
#
# INERT BY CONSTRUCTION, AND THAT IS THE POINT OF THIS CHANGE. Every pair that is
# misresident today is pinned (the test asserts ledger == catalog's misresident set in both
# directions), so `lane_db_vm_env` returns exactly what `control_env_for` returns for those
# pairs and returns the lane — which IS its own control env — for every other pair. No lane
# changes host, no DSN is rewritten and no data moves here. The host move is a separate,
# per-lane cutover gated on each lane's own census and on migration-Job reachability.
#
# ROLLBACK IS ONE LINE, NOT A REVERT. Re-adding a pin re-expands that lane's name and host
# to today's exact values, and composed DSNs are overwrite-on-drift
# (scripts/ci/secret-materialize.sh), so a re-pinned lane self-corrects on the next
# materialize. That is why `lane_db_suffix` / `_lane_db_suffix` are RE-KEYED onto this cell
# and never deleted.

# THE ONE CELL: which environment's Postgres instance holds (node, lane)'s database?
# Arg order is (NODE, LANE) — the mirror image of `control_env_for <lane> <node>`, because
# the question is about a NODE's lane. Pure: the pin ledger, plus `control_env_for` on the
# pinned path only.
#
# An UNPINNED pair resolves to the lane itself WITHOUT reading the catalog, deliberately:
# the answer is knowable without it, so a node with no catalog row (a newborn, a fixture) is
# lane-resident by construction rather than unresolvable. The fail-closed refusal that
# matters — `control_env_for`'s bug.5206 missing-catalog error — still governs the PINNED
# path, which is the only path that can send a database to a foreign instance.
lane_db_vm_env() {
  local node="${1:-}" lane="${2:-}"
  if [ -z "$node" ] || [ -z "$lane" ]; then
    echo "::error::lane_db_vm_env: both <node> and <lane> are required" >&2
    return 2
  fi
  if _lane_db_is_pinned "$node" "$lane"; then
    control_env_for "$lane" "$node" || return 2
    return 0
  fi
  printf '%s\n' "$lane"
}

# The VM alias whose Postgres holds (node, lane)'s database. Resolved through the SAME
# primitive every other substrate consumer uses — `cogni_vm_host_for_env`, the unproxied
# A-record alias provision-env-vm creates, which is already what an Akash lease dials for
# Temporal/Redis/LiteLLM (.github/actions/materialize-compute-workload/action.yml). Never a
# third spelling of `<slug>-<env>.vm.<root>`: that duplication is the bug.5207 shape.
#
# SUBSTRATE_HOST_IS_CONTROL_ENV_SCOPED is not violated here: the first argument is a
# RESOLVED env (`lane_db_vm_env`), never a raw workload-env variable
# (tests/ci-invariants/substrate-host-consumers.spec.ts).
#
# Returns the ALIAS, not an address. Resolving it to an A-record IP belongs at the composer
# call site, where today's DSNs carry `${VM_IP}` and a DNS name in a `sslmode=disable` DSN
# would be a new failure mode; keeping this function pure is what lets the whole invariant
# be a static test with no network.
lane_db_host() {
  local node="${1:-}" lane="${2:-}" env root slug ident
  env="$(lane_db_vm_env "$node" "$lane")" || return 2
  if ! command -v cogni_vm_host_for_env >/dev/null 2>&1; then
    ident="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../setup/lib" 2>/dev/null && pwd || true)/cogni-deployment-identity.sh"
    if [ -f "$ident" ]; then
      # shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
      . "$ident"
    fi
  fi
  if ! command -v cogni_vm_host_for_env >/dev/null 2>&1; then
    echo "::error::lane_db_host: cogni_vm_host_for_env is not defined and scripts/setup/lib/cogni-deployment-identity.sh was not found. Refusing to re-spell the VM alias here — one derivation per question (bug.5207)." >&2
    return 2
  fi
  # Same two arguments, in the same order, as every other caller of this primitive.
  root="${FORK_DOMAIN_ROOT:-$(cogni_domain_root)}"
  slug="$(cogni_deployment_slug)"
  cogni_vm_host_for_env "$env" "$root" "$slug"
}

# THE EQUALITY GATE `lane-db-two-derivations` demands, for the HOST as well as the NAME.
#
# The hub entry's rule is ONE lane-aware derivation that both the composer and the
# provisioner call. The only way to prove they actually agree is to compare the WRITE side
# (these resolvers) against the READ side (the DSN the workload is really handed) — so this
# parses the host AND the dbname back OUT of the stored DSN. Two pure functions of the same
# input cannot disagree and therefore cannot be a gate; that was review finding 10.
#
# `<dsn>` may be passed explicitly (tests, and any caller that already holds it); otherwise
# it is read from cogni/<lane>/<node>/DATABASE_URL through `bao_get_field`, the existing read
# primitive (scripts/setup/lib/reconcile-secrets.sh, overridden by a token-bound variant on
# the materialize path). This is the one impure function in the lib, by necessity.
#
# TODAY'S DSNs CARRY AN IP (`${VM_IP}`, `hostname -I` on the control env's VM), not an alias,
# so an address that resolves from the expected alias is accepted as agreement and reported
# as such. An address that does not, or an alias that does not resolve, FAILS LOUD — never
# "cannot check, assume fine".
lane_db_assert_agreement() {
  local node="${1:-}" lane="${2:-}" dsn="${3:-}" after hostport host dbpath db want_host want_db addrs
  if [ -z "$node" ] || [ -z "$lane" ]; then
    echo "::error::lane_db_assert_agreement: both <node> and <lane> are required" >&2
    return 2
  fi
  if ! command -v node_database_for_target >/dev/null 2>&1; then
    echo "::error::lane_db_assert_agreement: node_database_for_target is not defined — source scripts/ci/lib/image-tags.sh. The expected NAME must come from the one derivation the provisioner uses, never be re-spelled here." >&2
    return 2
  fi
  if [ -z "$dsn" ]; then
    command -v bao_get_field >/dev/null 2>&1 || {
      echo "::error::lane_db_assert_agreement: no DSN passed and bao_get_field is not defined — cannot read cogni/${lane}/${node}/DATABASE_URL" >&2
      return 2
    }
    dsn="$(bao_get_field "$node" DATABASE_URL)"
  fi
  [ -n "$dsn" ] || {
    echo "::error::lane_db_assert_agreement: no stored DATABASE_URL for ${node}/${lane} — the read side does not exist, so agreement is unprovable (bug.5299)" >&2
    return 1
  }

  # postgresql://<role>:<pw>@<host>:<port>/<db>?<params> — split on the LAST `@` so a
  # password containing `@` cannot move the host boundary.
  after="${dsn##*@}"
  hostport="${after%%/*}"
  host="${hostport%%:*}"
  dbpath="${after#*/}"
  db="${dbpath%%\?*}"
  if [ -z "$host" ] || [ -z "$db" ] || [ "$after" = "$dsn" ]; then
    echo "::error::lane_db_assert_agreement: could not parse host+dbname out of ${node}/${lane}'s stored DATABASE_URL (parsed host='${host}' db='${db}')" >&2
    return 1
  fi

  want_db="$(node_database_for_target "$node" "$lane")" || return 2
  want_host="$(lane_db_host "$node" "$lane")" || return 2

  if [ "$db" != "$want_db" ]; then
    echo "::error::lane database disagreement: ${node}/${lane}'s stored DSN names database '${db}' but the provisioner derivation says '${want_db}' (lane-db-two-derivations, bug.5207). The DSN would dial a database nothing creates." >&2
    return 1
  fi

  if [ "$host" = "$want_host" ]; then
    printf '[OK] lane database agreement: %s/%s dsn host=%s db=%s == resolver (env=%s)\n' \
      "$node" "$lane" "$host" "$db" "$(lane_db_vm_env "$node" "$lane")"
    return 0
  fi
  # The DSN holds an address. Accept it only if it is one the expected alias resolves to.
  if printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    addrs="$(_lane_db_resolve_a "$want_host")" || {
      echo "::error::lane database disagreement: ${node}/${lane}'s stored DSN dials ${host} and the expected host ${want_host} does not resolve, so agreement is UNPROVABLE. Fix DNS or the pin; do not assume agreement (bug.5299)." >&2
      return 1
    }
    if printf '%s\n' "$addrs" | grep -qxF "$host"; then
      printf '[OK] lane database agreement: %s/%s dsn host=%s db=%s == resolver %s (env=%s)\n' \
        "$node" "$lane" "$host" "$db" "$want_host" "$(lane_db_vm_env "$node" "$lane")"
      return 0
    fi
  fi
  echo "::error::lane database residency disagreement: ${node}/${lane}'s stored DSN dials host '${host}' but the resolver says '${want_host}' (env $(lane_db_vm_env "$node" "$lane")). Read side and write side disagree about WHOSE INSTANCE holds ${want_db} — one of them is wrong and the lane is either on the wrong failure domain or about to be (bug.5299)." >&2
  return 1
}

# A-record lookup, no new dependency: whichever of getent/dig/python3 the runner has.
# Empty output or no tool => nonzero, so the caller fails loud instead of guessing.
_lane_db_resolve_a() {
  local name="$1" out=""
  if command -v getent >/dev/null 2>&1; then
    out="$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u)"
  fi
  if [ -z "$out" ] && command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=3 +tries=1 A "$name" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u)"
  fi
  if [ -z "$out" ] && command -v python3 >/dev/null 2>&1; then
    out="$(python3 -c 'import socket,sys
try:
    print("\n".join(sorted({a[4][0] for a in socket.getaddrinfo(sys.argv[1], None, socket.AF_INET)})))
except OSError:
    sys.exit(1)' "$name" 2>/dev/null)"
  fi
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}
