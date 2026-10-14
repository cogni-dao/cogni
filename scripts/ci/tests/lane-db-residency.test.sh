#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# lane-db-residency.test.sh — a non-production lane's database must not live on another
# environment's Postgres instance (bug.5299).
#
# THE DIFFERENCE FROM lane-db-name.test.sh. That test guards the NAME: the database a lane's
# DSN names must equal the one its provisioner creates (bug.5207). This test guards the HOST:
# `cogni_poly_candidate_a` is a distinct name on the SAME production instance, so the name
# fix removed the credential-collision hazard and left the failure domain shared. Measured
# 2026-10-13: 31 of ~78 peak backends on the production Postgres belonged to non-production
# lanes, 27 of them poly's.
#
# PURE BY DESIGN: (catalog, node, lane) -> string. No live database, no network, no SSH. The
# residency invariant is fully answerable from infra/catalog, which is why it can be a static
# CI gate instead of something only a flight discovers.
#
# THE LEDGER CANNOT ROT. The committed allowlist in scripts/ci/lib/lane-db-residency.sh is
# asserted EQUAL to the committed catalog's misresident set. So:
#   * a lane that MOVES to its own instance fails this test until its entry is deleted;
#   * a lane that newly misresides fails this test until it is fixed.
# An EMPTY allowlist with this test green is bug.5299's acceptance proof.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CATALOG_DIR="$REPO_ROOT/infra/catalog"
export COGNI_CATALOG_ROOT="$CATALOG_DIR"

# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
# shellcheck source=scripts/ci/lib/lane-db-residency.sh
. "$REPO_ROOT/scripts/ci/lib/lane-db-residency.sh"

TMPROOT="$(mktemp -d -t lane-db-residency.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

fail() { echo "❌ $*" >&2; exit 1; }

want_status() {
  local node="$1" lane="$2" want="$3" got
  got="$(CATALOG_DIR="${CASE_CATALOG_DIR:-$CATALOG_DIR}" lane_db_residency_status "$node" "$lane")" \
    || fail "lane_db_residency_status ${node}/${lane} returned rc=$? (wanted '${want}')"
  [ "$got" = "$want" ] \
    || fail "residency for ${node}/${lane}: got '${got}', want '${want}'"
  echo "  ok  ${node}/${lane} -> ${got}"
}

# ── 1. THE FOUR MISRESIDENT PAIRS ARE DETECTED, from the committed catalog alone ──
echo "[1] the four known-misresident pairs are detected"
for pair in poly/candidate-a poly/preview red/candidate-a toks5/preview; do
  want_status "${pair%%/*}" "${pair##*/}" misresident_allowlisted
done

# ── 2. A CORRECTLY-RESIDENT LANE PASSES ──────────────────────────────────────────
# Both shapes that exist today: a k3s row reconciled by its own cluster, and an akash row
# whose lane IS the control env. Neither may be flagged — a gate that reds a healthy lane
# gets disabled, which is how the invariant would be lost.
echo "[2] correctly-resident lanes pass"
want_status operator candidate-a resident
want_status operator preview resident
want_status operator production resident
want_status poly production resident
want_status red production resident
want_status toks5 production resident
want_status beacon production resident
CATALOG_DIR="$CATALOG_DIR" lane_db_residency_check operator candidate-a >/dev/null \
  || fail "lane_db_residency_check must exit 0 for a resident lane"

# ── 3. AN OFF-ALLOWLIST MISRESIDENT PAIR FAILS ───────────────────────────────────
# Fixture, not a catalog edit: give `red` a preview lane on akash. Its control env is then
# production, so its database would be born on production's instance — a NEW instance of
# bug.5299 that no entry covers.
echo "[3] an off-allowlist misresident pair fails"
mkdir -p "$TMPROOT/catalog"
cat > "$TMPROOT/catalog/red.yaml" <<'YAML'
name: red
type: node
envs: [candidate-a, preview, production]
deployment_provider:
  candidate-a: akash
  preview: akash
  production: akash
YAML
CASE_CATALOG_DIR="$TMPROOT/catalog" want_status red preview misresident
if CATALOG_DIR="$TMPROOT/catalog" lane_db_residency_check red preview 2>"$TMPROOT/red-preview.err"; then
  fail "lane_db_residency_check must exit nonzero for an off-allowlist misresident lane"
fi
grep -q '::error::lane database residency: red/preview is MISRESIDENT and NOT allowlisted' "$TMPROOT/red-preview.err" \
  || fail "the off-allowlist failure must name the pair and say it is not allowlisted; got: $(cat "$TMPROOT/red-preview.err")"
grep -q 'only shrinks' "$TMPROOT/red-preview.err" \
  || fail "the failure must refuse 'just add it to the allowlist' as the remedy"
echo "  ok  red/preview fails closed with the remedy spelled out"

# ── 4. THE ALLOWLIST CANNOT SILENCE A PAIR THAT IS NOT IN IT ─────────────────────
# Same node, same fixture, same run: `red/candidate-a` IS ledgered and `red/preview` is not.
# If the entry were matched per-NODE (or per-lane, or by prefix) the new lane would be
# silenced by a grant that was never made for it.
echo "[4] an allowlist entry grants nothing beyond its exact (node, lane) pair"
CASE_CATALOG_DIR="$TMPROOT/catalog" want_status red candidate-a misresident_allowlisted
CASE_CATALOG_DIR="$TMPROOT/catalog" want_status red preview misresident
# and the converse direction: `toks5/preview` is ledgered, so a DIFFERENT node's preview lane
# must not inherit it.
cat > "$TMPROOT/catalog/beacon.yaml" <<'YAML'
name: beacon
type: node
envs: [preview, production]
deployment_provider:
  preview: akash
  production: akash
YAML
CASE_CATALOG_DIR="$TMPROOT/catalog" want_status beacon preview misresident

# ── 5. THE LEDGER EQUALS REALITY — the forcing function that empties it ──────────
# Recompute the misresident set from the committed catalog and require it to equal the
# committed allowlist, both directions. A stale entry (lane moved) and a missing entry (new
# violation) both fail here, so the list can only ever be accurate — and therefore can only
# ever shrink as lanes are moved.
echo "[5] the committed allowlist equals the committed catalog's misresident set"
actual=()
for catalog_file in "$CATALOG_DIR"/*.yaml; do
  node="$(basename "$catalog_file" .yaml)"
  [ "$(yq -N '.type // ""' "$catalog_file")" = "node" ] || continue
  while read -r env; do
    [ -n "$env" ] || continue
    [ "$(lane_db_residency_status "$node" "$env")" = "resident" ] && continue
    actual+=("${node}/${env}")
  done < <(yq -r '.envs[]?' "$catalog_file")
done
actual_sorted="$(printf '%s\n' ${actual[@]+"${actual[@]}"} | LC_ALL=C sort | paste -sd, -)"
ledger_sorted="$(printf '%s\n' ${LANE_DB_RESIDENCY_PINNED[@]+"${LANE_DB_RESIDENCY_PINNED[@]}"} \
  | LC_ALL=C sort | paste -sd, -)"
[ "$actual_sorted" = "$ledger_sorted" ] || fail "allowlist drift: catalog says misresident='${actual_sorted}', scripts/ci/lib/lane-db-residency.sh says '${ledger_sorted}'. A lane that MOVED needs its entry DELETED; a lane that newly misresides needs FIXING, not a new entry (bug.5299)."
echo "  ok  ledger == catalog: ${ledger_sorted:-<EMPTY — bug.5299 is DONE>}"

# ── 6. FAIL CLOSED on a row that cannot be resolved ──────────────────────────────
# control_env_for refuses a missing catalog file rather than answering "reconciled here"
# (bug.5206). Residency must inherit that refusal, never report the safest answer for the
# one case where nothing is known.
echo "[6] an unresolvable row fails closed, never 'resident'"
if out="$(CATALOG_DIR="$TMPROOT/empty" lane_db_residency_status ghost candidate-a 2>/dev/null)"; then
  fail "an unknown catalog row must not resolve; got '${out}'"
fi

echo "PASS: lane-db-residency.test.sh"
