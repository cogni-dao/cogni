#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# lane-db-resolver.test.sh — the residency resolver changes NOTHING today, and the mechanism
# by which it will change something is a one-line ledger edit (bug.5299 Pareto step 3).
#
# WHAT IT GUARDS, AND WHY EACH GROUP EXISTS.
#   [1] INERTNESS, ENUMERATED NOT SPOT-CHECKED. For every (node, lane) the committed catalog
#       can produce, `lane_db_host` must return the host the pre-resolver code would have
#       used — `cogni_vm_host_for_env(control_env_for(lane, node))`, the VM secret-materialize
#       SSHs into and whose `hostname -I` becomes `${VM_IP}` in the DSN. This is the whole
#       claim of the change: no lane moves.
#   [2] THE CELL. A pinned pair resolves to its control env; every other pair resolves to
#       itself. Pin membership is EXACT per (node, lane).
#   [3] THE EMPTYING MECHANISM. Deleting a pin flips that lane to lane-resident. If it did
#       not, the ledger could never reach empty and bug.5299's Done-when would be unreachable
#       — which was exactly the 2026-10-14 ruling against the old placement-keyed predicate.
#   [4] THE EQUALITY GATE. `lane_db_assert_agreement` parses host AND dbname back OUT of a
#       stored DSN, so it compares the READ side against the WRITE side and can actually fail
#       (comparing two pure functions of one input cannot — review finding 10).
#   [5] THE RE-KEY IS A NO-OP. Every catalog-derivable database name is byte-identical under
#       `lane_db_vm_env` and under the pre-resolver `control_env_for`.
#
# PURE + HERMETIC: catalog + ledger only. The one path that would touch DNS
# (`_lane_db_resolve_a`, for a DSN that carries an address rather than an alias) is exercised
# through PATH shims, never the network.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CATALOG_DIR="$REPO_ROOT/infra/catalog"
export COGNI_CATALOG_ROOT="$CATALOG_DIR"
# Pin the identity inputs so the expected alias is deterministic on any runner.
export COGNI_DOMAIN_ROOT="cognidao.org"
export COGNI_DEPLOYMENT_SLUG="cogni"
unset FORK_DOMAIN_ROOT

# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
# shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
. "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
# shellcheck source=scripts/ci/lib/image-tags.sh
. "$REPO_ROOT/scripts/ci/lib/image-tags.sh"
# shellcheck source=scripts/ci/lib/lane-db-residency.sh
. "$REPO_ROOT/scripts/ci/lib/lane-db-residency.sh"

TMPROOT="$(mktemp -d -t lane-db-resolver.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

fail() { echo "❌ $*" >&2; exit 1; }

# Every (node, lane) the committed catalog can produce. Derived, never listed: a catalog edit
# must widen this test automatically or it would stop covering the fleet.
PAIRS=()
for catalog_file in "$CATALOG_DIR"/*.yaml; do
  node="$(basename "$catalog_file" .yaml)"
  [ "$(yq -N '.type // ""' "$catalog_file")" = "node" ] || continue
  while read -r env; do
    [ -n "$env" ] || continue
    PAIRS+=("${node}/${env}")
  done < <(yq -r '.envs[]?' "$catalog_file")
done
[ "${#PAIRS[@]}" -ge 10 ] || fail "only ${#PAIRS[@]} (node, lane) pairs derived from $CATALOG_DIR — the enumeration is broken, not the fleet"

# Current contract: all committed lanes, including future Akash births, own their
# Postgres instance. The historical pins below are rollback fixtures only.
[ -z "${LANE_DB_RESIDENCY_PINNED[*]:-}" ] || fail "committed residency ledger must be empty"
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  [ "$(lane_db_vm_env "$node" "$lane")" = "$lane" ] || fail "foreign Postgres: $pair"
  [ "$(lane_db_host "$node" "$lane")" = "$(cogni_vm_host_for_env "$lane" "$(cogni_domain_root)" "$(cogni_deployment_slug)")" ] \
    || fail "lane host drift: $pair"
  [ "$(node_database_for_target "$node" "$lane")" = "cogni_${node//-/_}" ] \
    || fail "lane-local database name drift: $pair"
done
echo '[current] every committed lane is resident; historical rollback coverage follows'
# Historical cases explicitly own their catalog and production control identity.
. "$SCRIPT_DIR/fixtures/catalog.sh"
write_historical_catalog_fixture "$CATALOG_DIR" "$TMPROOT/historical-catalog"
export CATALOG_DIR="$TMPROOT/historical-catalog" COGNI_CATALOG_ROOT="$TMPROOT/historical-catalog"
export FLEET_CONTROL_ENV=production
# The real reader caches its roster at source time; rebuild it from the selected fixture.
. "$REPO_ROOT/scripts/ci/lib/image-tags.sh"
LANE_DB_RESIDENCY_PINNED=("poly/candidate-a" "poly/preview" "red/candidate-a" "toks5/preview")

# ── 1. INERT: every lane keeps the host it has today ─────────────────────────────
# THE PRE-RESOLVER DERIVATION, spelled out once here as the baseline: the DSN's host is the
# VM the composer SSHs into, i.e. the CONTROL env's VM alias. If `lane_db_host` ever differs
# from this for a pair, that pair's database just moved — which is a cutover, not this change.
echo "[1] lane_db_host is byte-identical to the pre-resolver host for all ${#PAIRS[@]} catalog pairs"
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  baseline_env="$lane"
  if _lane_db_is_pinned "$node" "$lane"; then baseline_env="$(control_env_for "$lane" "$node")"; fi
  baseline="$(cogni_vm_host_for_env "$baseline_env" "$(cogni_domain_root)" "$(cogni_deployment_slug)")"
  got="$(lane_db_host "$node" "$lane")" || fail "lane_db_host ${node}/${lane} failed"
  [ "$got" = "$baseline" ] \
    || fail "RESIDENCY IS NOT INERT for ${node}/${lane}: resolver says '${got}', today's code uses '${baseline}'. A lane changed host in a PR that must not move any data (bug.5299)."
  printf '  ok  %-26s host=%s\n' "$pair" "$got"
done

# ── 2. THE CELL: pinned -> control env, unpinned -> the lane itself ──────────────
echo "[2] lane_db_vm_env returns the control env for a pinned pair and the lane otherwise"
for pair in poly/candidate-a poly/preview red/candidate-a toks5/preview; do
  node="${pair%%/*}"; lane="${pair##*/}"
  want="$(control_env_for "$lane" "$node")"
  got="$(lane_db_vm_env "$node" "$lane")"
  [ "$got" = "$want" ] || fail "pinned ${pair}: lane_db_vm_env said '${got}', control env is '${want}'"
  [ "$got" != "$lane" ] || fail "pinned ${pair} resolved to its own lane — the pin did nothing, so today's host would change"
  printf '  ok  pinned   %-18s -> %s (control env)\n' "$pair" "$got"
done
pinned_blob=" ${LANE_DB_RESIDENCY_PINNED[*]} "
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  [ "${pinned_blob#* "$pair" }" = "$pinned_blob" ] || continue
  got="$(lane_db_vm_env "$node" "$lane")"
  [ "$got" = "$lane" ] || fail "unpinned ${pair}: lane_db_vm_env said '${got}', an unpinned lane must resolve to itself"
done
echo "  ok  unpinned pairs all resolve to their own lane"
# A node with no catalog row at all (a newborn, a fixture) is lane-resident BY CONSTRUCTION —
# the 2026-10-14 ruling's requirement that node birth needs no change. The fail-closed
# refusal still governs the pinned path, which is the only one that can send a DB elsewhere.
[ "$(CATALOG_DIR="$TMPROOT/nonexistent" lane_db_vm_env ghost candidate-a)" = "candidate-a" ] \
  || fail "an unpinned pair must resolve to its lane without consulting the catalog (newborn nodes are resident by construction)"
# Missing arguments are a caller bug, never a silent default.
if lane_db_vm_env poly 2>/dev/null; then fail "lane_db_vm_env must refuse a missing lane"; fi

# ── 3. REMOVING A PIN FLIPS THE LANE TO LANE-RESIDENT ────────────────────────────
# The ledger's own emptying mechanism, proven on a COPY of the array so the committed ledger
# is untouched. Without this, deleting a line would be cosmetic and the ledger immortal.
echo "[3] deleting a pin flips that lane to lane-resident (how the ledger empties)"
( # subshell: the pin edit must not leak into later groups
  LANE_DB_RESIDENCY_PINNED=("poly/preview" "red/candidate-a" "toks5/preview")
  got_env="$(lane_db_vm_env poly candidate-a)"
  [ "$got_env" = "candidate-a" ] \
    || fail "unpinning poly/candidate-a must make it lane-resident; got '${got_env}'"
  got_host="$(lane_db_host poly candidate-a)"
  [ "$got_host" = "cogni-candidate-a.vm.cognidao.org" ] \
    || fail "unpinned poly/candidate-a must resolve to candidate-a's own VM; got '${got_host}'"
  # and the suffix collapses with it — the name follows the host, which is what makes the
  # cutover a cutover rather than a rename on the wrong instance.
  [ "$(node_database_for_target poly candidate-a)" = "cogni_poly" ] \
    || fail "unpinning must collapse the suffix: got '$(node_database_for_target poly candidate-a)'"
  # the OTHER pins are untouched by one deletion
  [ "$(lane_db_vm_env poly preview)" = "production" ] \
    || fail "deleting one pin must not unpin another lane of the same node"
  echo "  ok  poly/candidate-a unpinned -> env=candidate-a host=${got_host} db=cogni_poly"
)
# ...and the committed ledger is unchanged by the experiment above.
[ "$(lane_db_vm_env poly candidate-a)" = "production" ] \
  || fail "the committed pin for poly/candidate-a leaked away — this PR must change no host"
echo "  ok  the committed ledger still pins poly/candidate-a to production"

# ── 4. THE EQUALITY GATE FAILS ON DISAGREEMENT AND PASSES ON AGREEMENT ───────────
echo "[4] lane_db_assert_agreement compares the stored DSN against BOTH derivations"
pin_host="$(lane_db_host poly candidate-a)"
pin_db="$(node_database_for_target poly candidate-a)"
good="postgresql://app_poly_candidate_a:pw@${pin_host}:5432/${pin_db}?sslmode=disable"
out="$(lane_db_assert_agreement poly candidate-a "$good")" \
  || fail "a DSN that matches both derivations must PASS; got: ${out}"
grep -q '^\[OK\] lane database agreement: poly/candidate-a' <<<"$out" \
  || fail "the passing line must name the pair; got: ${out}"
echo "  ok  ${out}"

# WRONG HOST — the residency disagreement this gate exists for.
bad_host="postgresql://app_poly_candidate_a:pw@cogni-preview.vm.cognidao.org:5432/${pin_db}?sslmode=disable"
if lane_db_assert_agreement poly candidate-a "$bad_host" 2>"$TMPROOT/badhost.err"; then
  fail "a DSN dialing the wrong HOST must fail the agreement gate"
fi
grep -q '::error::lane database residency disagreement: poly/candidate-a' "$TMPROOT/badhost.err" \
  || fail "the wrong-host failure must name the pair; got: $(cat "$TMPROOT/badhost.err")"
echo "  ok  wrong host fails: $(sed -e 's/^::error:://' -e 's/ Read side.*//' "$TMPROOT/badhost.err")"

# WRONG DBNAME — the bug.5207 axis, on the same parse.
bad_db="postgresql://app_poly_candidate_a:pw@${pin_host}:5432/cogni_poly?sslmode=disable"
if lane_db_assert_agreement poly candidate-a "$bad_db" 2>"$TMPROOT/baddb.err"; then
  fail "a DSN naming the wrong DATABASE must fail the agreement gate"
fi
grep -q '::error::lane database disagreement: poly/candidate-a' "$TMPROOT/baddb.err" \
  || fail "the wrong-dbname failure must name the pair; got: $(cat "$TMPROOT/baddb.err")"
echo "  ok  wrong dbname fails: $(sed -e 's/^::error:://' -e 's/ The DSN.*//' "$TMPROOT/baddb.err")"

# UNPARSEABLE / ABSENT — never silently green.
if lane_db_assert_agreement poly candidate-a "not-a-dsn" 2>/dev/null; then
  fail "an unparseable DSN must fail, not pass"
fi
if lane_db_assert_agreement poly candidate-a "" 2>/dev/null; then
  fail "an absent DSN must fail (no read side => unprovable), and bao_get_field is not defined here"
fi
echo "  ok  an unparseable or absent DSN fails closed"

# A DSN CARRYING AN ADDRESS is how every lane's DSN looks TODAY (`${VM_IP}` is `hostname -I`).
# Accepted only when the address is one the expected alias actually resolves to. Shimmed, so
# this stays hermetic — the point is the branch, not DNS.
mkdir -p "$TMPROOT/shim"
cat > "$TMPROOT/shim/getent" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "ahostsv4" ] || exit 1
case "${2:-}" in
  cogni.vm.cognidao.org) echo "5.199.162.44 STREAM cogni.vm.cognidao.org"; exit 0 ;;
esac
exit 1
SH
chmod +x "$TMPROOT/shim/getent"
ip_dsn="postgresql://app_poly_candidate_a:pw@5.199.162.44:5432/${pin_db}?sslmode=disable"
out="$(PATH="$TMPROOT/shim:$PATH" lane_db_assert_agreement poly candidate-a "$ip_dsn")" \
  || fail "an address the expected alias resolves to must be accepted as agreement"
grep -q "5.199.162.44" <<<"$out" || fail "the accepting line must report the address it matched; got: ${out}"
echo "  ok  ${out}"
wrong_ip="postgresql://app_poly_candidate_a:pw@203.0.113.7:5432/${pin_db}?sslmode=disable"
if PATH="$TMPROOT/shim:$PATH" lane_db_assert_agreement poly candidate-a "$wrong_ip" 2>/dev/null; then
  fail "an address the expected alias does NOT resolve to must fail"
fi
echo "  ok  an unrelated address fails"
# ...and when nothing can resolve, it fails LOUD rather than assuming agreement.
for t in getent dig python3; do printf '#!/usr/bin/env bash\nexit 1\n' > "$TMPROOT/shim/$t"; chmod +x "$TMPROOT/shim/$t"; done
if PATH="$TMPROOT/shim:$PATH" lane_db_assert_agreement poly candidate-a "$ip_dsn" 2>"$TMPROOT/unresolvable.err"; then
  fail "an unresolvable expected host must fail, never 'cannot check, assume fine'"
fi
grep -q 'UNPROVABLE' "$TMPROOT/unresolvable.err" \
  || fail "the unresolvable case must say so; got: $(cat "$TMPROOT/unresolvable.err")"
echo "  ok  an unresolvable expected host fails loud"

# ── 5. THE RE-KEY IS A NO-OP FOR EVERY CATALOG-DERIVABLE DATABASE NAME ───────────
# `node_database_for_target` now keys its suffix on `lane_db_vm_env` instead of
# `control_env_for`. Enumerate every name the catalog can produce — lane-aware AND the
# laneless roster `node_database_csv` feeds — and require each to be byte-identical to the
# pre-resolver derivation. The laneless names matter because `COGNI_NODE_DBS`, the Doltgres
# roster and the Grafana datasource list are all derived from them; narrowing that list is
# explicitly out of scope for bug.5299.
echo "[5] the re-key leaves every catalog-derivable database name byte-identical"
names=0
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  baseline_env="$lane"
  if _lane_db_is_pinned "$node" "$lane"; then baseline_env="$(control_env_for "$lane" "$node")"; fi
  pre="cogni_${node//-/_}$(lane_db_suffix "$lane" "$baseline_env")"
  post="$(node_database_for_target "$node" "$lane")"
  [ "$post" = "$pre" ] \
    || fail "the re-key CHANGED a database name for ${pair}: pre-resolver '${pre}', resolver '${post}'. That is a rename on a live instance (bug.5207's shape), not an inert change."
  printf '  ok  %-26s db=%s\n' "$pair" "$post"
  names=$((names + 1))
done
for node in "${NODE_TARGETS[@]}"; do
  [ "$(node_database_for_target "$node")" = "cogni_${node//-/_}" ] \
    || fail "the laneless call for ${node} must stay byte-identical: got '$(node_database_for_target "$node")'"
  names=$((names + 1))
done
echo "  ok  ${names} names verified identical (${#PAIRS[@]} lane-aware + ${#NODE_TARGETS[@]} laneless)"
echo "  ok  node_database_csv unchanged: $(node_database_csv)"

echo "PASS: lane-db-resolver.test.sh (${#PAIRS[@]} catalog pairs, all inert)"
