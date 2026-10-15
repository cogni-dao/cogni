#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Postgres residency is independent of compute/secret custody. Every lane uses
# its own environment's instance. No foreign-residency exception is accepted.
# The empty historical pin cell remains only to exercise fail-closed regressions.

LANE_DB_RESIDENCY_PINNED=()

_lane_db_is_pinned() {
  local node="${1:-}" lane="${2:-}" entry
  for entry in ${LANE_DB_RESIDENCY_PINNED[@]+"${LANE_DB_RESIDENCY_PINNED[@]}"}; do
    [ "$entry" = "${node}/${lane}" ] && return 0
  done
  return 1
}

lane_db_residency_status() {
  local node="${1:-}" lane="${2:-}" residency
  if [ -z "$node" ] || [ -z "$lane" ]; then
    echo "::error::lane_db_residency_status: both <node> and <lane> are required" >&2
    return 2
  fi
  # Unknown catalog identity must not be mistaken for proven residency.
  [ -f "${CATALOG_DIR:-infra/catalog}/$node.yaml" ] || {
    echo "::error::lane_db_residency_status: missing catalog identity for ${node}/${lane}" >&2
    return 2
  }
  control_env_for "$lane" "$node" >/dev/null || return 2
  residency="$(lane_db_vm_env "$node" "$lane")" || return 2
  if [ "$residency" = "$lane" ]; then
    printf 'resident\n'
  else
    printf 'misresident\n'
  fi
}

lane_db_residency_check() {
  local node="${1:-}" lane="${2:-}" status
  status="$(lane_db_residency_status "$node" "$lane")" || return 2
  if [ "$status" != resident ]; then
    echo "::error::lane database residency: ${node}/${lane} must use its own environment's Postgres; foreign residency is forbidden (bug.5299)" >&2
    return 1
  fi
  printf '[OK] lane database residency: %s/%s uses its own environment\n' "$node" "$lane"
}

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

lane_db_dsn_host() {
  local node="${1:-}" lane="${2:-}" local_env="${3:-}" local_addr="${4:-}" env vm_alias addrs count
  if [ -z "$node" ] || [ -z "$lane" ] || [ -z "$local_env" ] || [ -z "$local_addr" ]; then
    echo "::error::lane_db_dsn_host: all of <node> <lane> <local-env> <local-addr> are required — the local address is the caller's single existing derivation (hostname -I on the VM it is SSHed into) and must be passed, never re-derived here" >&2
    return 2
  fi
  env="$(lane_db_vm_env "$node" "$lane")" || return 2
  if [ "$env" = "$local_env" ]; then
    printf '%s\n' "$local_addr"
    return 0
  fi
  # REQUIRED, NEVER DEFAULTED — and refused with an explicit return rather than `${x:?}`,
  # which would kill a caller that did not wrap the call in a subshell.
  if [ -z "${FORK_DOMAIN_ROOT:-}" ]; then
    echo "::error::lane_db_dsn_host: FORK_DOMAIN_ROOT is unset, and ${node}/${lane}'s database resides on ${env} rather than ${local_env} — refusing to build a FOREIGN host from a defaulted domain root. cogni_domain_root hard-defaults to cognidao.org, so on a fork fleet that default would point this lane's DSN at the cogni-dao PRODUCTION Postgres (bug.5299)." >&2
    return 2
  fi
  vm_alias="$(lane_db_host "$node" "$lane")" || return 2
  addrs="$(_lane_db_resolve_a "$vm_alias")" || {
    echo "::error::lane_db_dsn_host: ${node}/${lane}'s database resides on ${env}, but its VM alias ${vm_alias} does not resolve — refusing to compose a DSN with no host (bug.5299). Fix DNS or re-pin the lane." >&2
    return 2
  }
  count="$(printf '%s\n' "$addrs" | grep -c .)"
  if [ "$count" != 1 ]; then
    echo "::error::lane_db_dsn_host: ${vm_alias} resolves to ${count} A records ($(printf '%s' "$addrs" | tr '\n' ' ')) — a DSN carries exactly one host, so choosing one would be a guess about which machine holds ${node}/${lane}'s database (bug.5299)." >&2
    return 2
  fi
  printf '%s\n' "$addrs"
}

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
