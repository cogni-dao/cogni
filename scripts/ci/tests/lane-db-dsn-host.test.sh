#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# lane-db-dsn-host.test.sh — THE COMPOSED DSN STILL NAMES THE HOST IT NAMES TODAY, for every
# (node, lane) the catalog can produce (bug.5299 B1, call site 1).
#
# `_compose_node_value` (scripts/setup/lib/reconcile-secrets.sh) substituted `${VM_IP}` —
# `hostname -I` on the VM the provisioning run SSHed into — as the host of BOTH Postgres
# DSNs. That value answers "whose VM am I talking to", not "whose Postgres holds this lane's
# database"; conflating them IS the residency bug. The host now comes from
# `lane_db_dsn_host`, keyed on the one cell `lane_db_vm_env`.
#
# THE DELIVERABLE IS INERTNESS, SO THE TEST IS AN ENUMERATION, NOT A SPOT-CHECK.
#   [1] For every catalog (node, lane), DATABASE_URL and DATABASE_SERVICE_URL are
#       BYTE-IDENTICAL to the pre-change composition, proven against THREE independent
#       baselines: the hand-spelled pre-change format, the current file with the resolver
#       absent (the provision-env-vm.sh Phase 5c path, which must keep working untouched),
#       and `origin/main`'s actual blob of the composer.
#   [2] DOLTGRES_URL is byte-identical too, and keeps `${VM_IP}` + a CONTROL-env-keyed name.
#       Doltgres residency is explicitly OUT of scope (immutable superuser, databases.md
#       §5.2), so it must not move — not now, and not when a Postgres pin is deleted.
#   [3] Deleting one pin moves ONLY that lane's two Postgres DSNs. Every other pair, and
#       that lane's DOLTGRES_URL, stay byte-identical. That is the per-lane cutover
#       mechanism, and the blast radius of a cutover is exactly one lane.
#   [4] FAIL LOUD, NEVER COMPOSE A GUESSED HOST: an unset FORK_DOMAIN_ROOT on the foreign
#       path (the cross-fleet widening class that a defaulted `cogni_domain_root` would
#       cause), an unresolvable alias, an ambiguous multi-A alias, a missing catalog row on
#       a pinned pair, and missing arguments all REFUSE.
#   [5] `lane_db_assert_agreement` — the read-side-vs-write-side gate — passes for every
#       pair against the DSN this composer actually produces.
#   [6] SCOPE GUARDS: `${VM_IP}` is still the vault/SSH target, DOLTGRES_URL still dials it,
#       and nothing here emits a password rotation (the B2 carrier question is still open,
#       and a moved host without its password on the target is 28P01).
#
# PURE + HERMETIC: catalog + ledger + a PATH-shimmed resolver. No network, no ssh, no vault.
# Fake per-env VM addresses stand in for `hostname -I`, and the DNS shim maps each env's VM
# alias to the same fake address, which is what a correctly-provisioned fleet looks like.

# Subshell scoping is the TOOL here, not an accident: every composition runs in `( ... )` so a
# PATH shim, a FORK_DOMAIN_ROOT, or an edited pin ledger cannot leak into the next assertion.
# shellcheck disable=SC2030,SC2031
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CATALOG_DIR="$REPO_ROOT/infra/catalog"
export COGNI_CATALOG_ROOT="$CATALOG_DIR"
export COGNI_DOMAIN_ROOT="cognidao.org"
export COGNI_DEPLOYMENT_SLUG="cogni"
unset FORK_DOMAIN_ROOT
unset COGNI_LANE_DB_HOST

# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
# shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
. "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
# shellcheck source=scripts/ci/lib/image-tags.sh
. "$REPO_ROOT/scripts/ci/lib/image-tags.sh"
# shellcheck source=scripts/ci/lib/lane-db-residency.sh
. "$REPO_ROOT/scripts/ci/lib/lane-db-residency.sh"
# shellcheck source=scripts/setup/lib/reconcile-secrets.sh
. "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh"

TMPROOT="$(mktemp -d -t lane-db-dsn-host.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

fail() { echo "❌ $*" >&2; exit 1; }

# ── The one impure input the composer has, stubbed deterministically. The real one is an
# ssh→`bao kv get` to ${VM_IP}; this test never leaves the process.
bao_get_field() {
  case "${1}/${2}" in
    operator/DOLTGRES_PASSWORD) printf 'dg-superuser-pw' ;;
    */APP_DB_PASSWORD) printf 'app-pw-%s' "${1//-/_}" ;;
    */APP_DB_SERVICE_PASSWORD) printf 'svc-pw-%s' "${1//-/_}" ;;
    */APP_DB_MIGRATION_PASSWORD) printf 'migration-pw-%s' "${1//-/_}" ;;
    *) printf '' ;;
  esac
}

# Each env's VM address — the stand-in for `hostname -I` on that VM, i.e. for ${VM_IP}.
addr_for_env() {
  case "$1" in
    production) printf '203.0.113.1' ;;
    preview) printf '203.0.113.2' ;;
    candidate-a) printf '203.0.113.3' ;;
    *) return 1 ;;
  esac
}

# A correctly-provisioned fleet: every env's unproxied VM alias resolves to that env's VM.
SHIM="$TMPROOT/shim"
mkdir -p "$SHIM"
cat > "$SHIM/getent" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "ahostsv4" ] || exit 1
case "${2:-}" in
  cogni.vm.cognidao.org)             echo "203.0.113.1 STREAM $2" ;;
  cogni-preview.vm.cognidao.org)     echo "203.0.113.2 STREAM $2" ;;
  cogni-candidate-a.vm.cognidao.org) echo "203.0.113.3 STREAM $2" ;;
  *) exit 1 ;;
esac
SH
# dig/python3 are the fallbacks inside _lane_db_resolve_a; neutralize them so an unknown
# name cannot silently reach REAL DNS and make this test non-hermetic.
for t in dig python3; do printf '#!/usr/bin/env bash\nexit 1\n' > "$SHIM/$t"; chmod +x "$SHIM/$t"; done
chmod +x "$SHIM/getent"

# Nothing resolves (the NXDOMAIN / no-tool case).
DEADSHIM="$TMPROOT/deadshim"
mkdir -p "$DEADSHIM"
for t in getent dig python3; do printf '#!/usr/bin/env bash\nexit 1\n' > "$DEADSHIM/$t"; chmod +x "$DEADSHIM/$t"; done

# An ambiguous alias: two A records for candidate-a's VM.
MULTISHIM="$TMPROOT/multishim"
mkdir -p "$MULTISHIM"
cat > "$MULTISHIM/getent" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = "ahostsv4" ] || exit 1
case "${2:-}" in
  cogni-candidate-a.vm.cognidao.org) echo "203.0.113.3 STREAM $2"; echo "203.0.113.4 STREAM $2" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$MULTISHIM/getent"
for t in dig python3; do printf '#!/usr/bin/env bash\nexit 1\n' > "$MULTISHIM/$t"; chmod +x "$MULTISHIM/$t"; done

# Every (node, lane) the committed catalog can produce. Derived, never listed.
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

DSN_KEYS=(DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_URL)

# THE MATERIALIZE PATH, REPRODUCED EXACTLY (scripts/ci/secret-materialize.sh):
#   DEPLOY_ENV          = the lane
#   SECRETS_CONTROL_ENV = control_env_for(lane, node)  (run-node-substrate.sh:142/:165)
#   VM_IP               = `hostname -I` on THAT env's VM
#   COGNI_LANE_DB_HOST  = lane_db_dsn_host(node, lane, SECRETS_CONTROL_ENV, VM_IP)
compose_now() {
  local node="$1" lane="$2" key="$3"
  (
    DEPLOY_ENV="$lane"
    SECRETS_CONTROL_ENV="$(control_env_for "$lane" "$node")"
    VM_IP="$(addr_for_env "$SECRETS_CONTROL_ENV")"
    COGNI_LANE_DB_HOST="$(lane_db_dsn_host "$node" "$lane" "$SECRETS_CONTROL_ENV" "$VM_IP")"
    _compose_node_value "$node" "$key"
  )
}

# BASELINE A — the pre-change format, spelled out by hand ONCE so the expectation does not
# come from the code under test. `${VM_IP}` for all three DSNs; suffix from the control env.
compose_literal() {
  local node="$1" lane="$2" key="$3" control sfx db host
  control="$(control_env_for "$lane" "$node")"
  sfx=""
  [ "$control" != "$lane" ] && sfx="_${lane//-/_}"
  db="cogni_${node//-/_}${sfx}"
  host="$(addr_for_env "$control")"
  case "$key" in
    DATABASE_URL)
      printf 'postgresql://app_%s%s:%s@%s:5432/%s?sslmode=disable' \
        "${node//-/_}" "$sfx" "$(bao_get_field "$node" APP_DB_PASSWORD)" "$host" "$db" ;;
    DATABASE_SERVICE_URL)
      printf 'postgresql://service_%s%s:%s@%s:5432/%s?sslmode=disable' \
        "${node//-/_}" "$sfx" "$(bao_get_field "$node" APP_DB_SERVICE_PASSWORD)" "$host" "$db" ;;
    DOLTGRES_URL)
      printf 'postgresql://postgres:%s@%s:5435/knowledge_%s%s?sslmode=disable' \
        "$(bao_get_field operator DOLTGRES_PASSWORD)" "$host" "${node//-/_}" "$sfx" ;;
    *) return 1 ;;
  esac
}

# BASELINE B — the CURRENT composer with no resolver on the path and no COGNI_LANE_DB_HOST:
# literally the provision-env-vm.sh Phase 5c / local-caller path. It must keep composing
# today's value, or this change broke a caller it never meant to touch.
compose_degraded() {
  local node="$1" lane="$2" key="$3"
  (
    unset -f lane_db_vm_env lane_db_suffix lane_db_host lane_db_dsn_host
    unset COGNI_LANE_DB_HOST
    DEPLOY_ENV="$lane"
    SECRETS_CONTROL_ENV="$(control_env_for "$lane" "$node")"
    VM_IP="$(addr_for_env "$SECRETS_CONTROL_ENV")"
    _compose_node_value "$node" "$key"
  )
}

# BASELINE C — origin/main's ACTUAL composer blob, sourced in a subshell with the resolver
# removed (its state on that path before this change). This is the "capture the pre-change
# values and compare" leg; the two baselines above keep the test honest if the ref is absent.
BASE_REF=""
for ref in origin/main main; do
  if git -C "$REPO_ROOT" cat-file -e "${ref}:scripts/setup/lib/reconcile-secrets.sh" 2>/dev/null; then
    BASE_REF="$ref"
    break
  fi
done
OLD_LIB="$TMPROOT/reconcile-secrets.base.sh"
if [ -n "$BASE_REF" ]; then
  git -C "$REPO_ROOT" show "${BASE_REF}:scripts/setup/lib/reconcile-secrets.sh" > "$OLD_LIB"
fi
compose_base_ref() {
  local node="$1" lane="$2" key="$3"
  (
    unset -f lane_db_vm_env lane_db_suffix lane_db_host lane_db_dsn_host
    unset COGNI_LANE_DB_HOST
    DEPLOY_ENV="$lane"
    SECRETS_CONTROL_ENV="$(control_env_for "$lane" "$node")"
    VM_IP="$(addr_for_env "$SECRETS_CONTROL_ENV")"
    # shellcheck source=/dev/null
    . "$OLD_LIB"
    # Re-stubbed AFTER the source, because the old lib defines its own ssh-backed
    # bao_get_field; invoked indirectly by that lib's _compose_node_value.
    # shellcheck disable=SC2329
    bao_get_field() {
      case "${1}/${2}" in
        operator/DOLTGRES_PASSWORD) printf 'dg-superuser-pw' ;;
        */APP_DB_PASSWORD) printf 'app-pw-%s' "${1//-/_}" ;;
        */APP_DB_SERVICE_PASSWORD) printf 'svc-pw-%s' "${1//-/_}" ;;
        *) printf '' ;;
      esac
    }
    _compose_node_value "$node" "$key"
  )
}

# Current contract, before any historical fixture: all three Postgres DSNs use
# their own lane's instance, including future catalog-born Akash nodes.
[ -z "${LANE_DB_RESIDENCY_PINNED[*]:-}" ] || fail "committed residency ledger must be empty"
(
  export FORK_DOMAIN_ROOT=cognidao.org PATH="$SHIM:$PATH"
  for pair in "${PAIRS[@]}"; do
    node="${pair%%/*}"; lane="${pair##*/}"
    for key in DATABASE_URL DATABASE_SERVICE_URL DATABASE_MIGRATION_URL; do
      dsn="$(compose_now "$node" "$lane" "$key")"
      after="${dsn##*@}"
      [ "${after%%:*}" = "$(addr_for_env "$lane")" ] || fail "$pair/$key dials a foreign instance"
      db_path="${after#*/}"
      [ "${db_path%%\?*}" = "cogni_${node//-/_}" ] || fail "$pair/$key names a non-local DB"
      lane_db_assert_agreement "$node" "$lane" "$dsn" >/dev/null || fail "$pair/$key disagrees"
    done
    [ "$(compose_now "$node" "$lane" DOLTGRES_URL)" = "$(compose_literal "$node" "$lane" DOLTGRES_URL)" ] \
      || fail "$pair Doltgres residency changed"
  done
)
echo '[current] all catalog lanes compose lane-local app/service/migration DSNs; Doltgres unchanged'

# Historical pins are an EXPLICIT rollback fixture, not the committed contract.
. "$SCRIPT_DIR/fixtures/catalog.sh"
write_historical_catalog_fixture "$CATALOG_DIR" "$TMPROOT/historical-catalog"
export CATALOG_DIR="$TMPROOT/historical-catalog" COGNI_CATALOG_ROOT="$TMPROOT/historical-catalog"
export FLEET_CONTROL_ENV=production
# The real reader caches its roster at source time; rebuild it from the selected fixture.
. "$REPO_ROOT/scripts/ci/lib/image-tags.sh"
# Include each authored rollback pair even when the current fleet has no such node.
for fixture_pair in poly/candidate-a poly/preview red/candidate-a toks5/preview; do
  found=false
  for pair in "${PAIRS[@]}"; do [ "$pair" != "$fixture_pair" ] || found=true; done
  if [ "$found" = false ]; then PAIRS+=("$fixture_pair"); fi
done
# Old inertness baselines apply only to the historical four or local-custody rows;
# a future foreign-compute birth is covered above and never inherits these pins.
HISTORICAL_PAIRS=()
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  case "$pair" in
    poly/candidate-a|poly/preview|red/candidate-a|toks5/preview) HISTORICAL_PAIRS+=("$pair") ;;
    *) [ "$(control_env_for "$lane" "$node")" != "$lane" ] || HISTORICAL_PAIRS+=("$pair") ;;
  esac
done
PAIRS=("${HISTORICAL_PAIRS[@]}")
LANE_DB_RESIDENCY_PINNED=("poly/candidate-a" "poly/preview" "red/candidate-a" "toks5/preview")

# ── 1 + 2. HISTORICAL ROLLBACK: every fixture pair, every DSN, four ways ──────────
echo "[1+2] every composed DSN is byte-identical to the pre-change value (${#PAIRS[@]} pairs x ${#DSN_KEYS[@]} keys)"
if [ -n "$BASE_REF" ]; then
  echo "      baselines: hand-spelled + resolver-absent + ${BASE_REF}:scripts/setup/lib/reconcile-secrets.sh"
else
  echo "::warning::lane-db-dsn-host: no origin/main ref in this clone — comparing against the hand-spelled and resolver-absent baselines only"
fi
checked=0
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  for key in "${DSN_KEYS[@]}"; do
    got="$(PATH="$SHIM:$PATH" compose_now "$node" "$lane" "$key")" \
      || fail "composing ${key} for ${pair} failed"
    want="$(compose_literal "$node" "$lane" "$key")"
    [ "$got" = "$want" ] \
      || fail "${key} CHANGED for ${pair}:
  now:        ${got}
  pre-change: ${want}
This PR must move no DSN host and no database name (bug.5299 B1 is inert by construction)."
    degraded="$(compose_degraded "$node" "$lane" "$key")"
    [ "$got" = "$degraded" ] \
      || fail "${key} for ${pair} differs with the resolver ABSENT (provision-env-vm.sh Phase 5c path):
  with resolver: ${got}
  without:       ${degraded}"
    if [ -n "$BASE_REF" ]; then
      base="$(compose_base_ref "$node" "$lane" "$key")"
      [ "$got" = "$base" ] \
        || fail "${key} for ${pair} differs from ${BASE_REF}'s composer:
  this branch: ${got}
  ${BASE_REF}: ${base}"
    fi
    checked=$((checked + 1))
  done
  printf '  ok  %-26s host=%s db=%s\n' "$pair" \
    "$(PATH="$SHIM:$PATH" compose_now "$node" "$lane" DATABASE_URL | sed -e 's#.*@##' -e 's#:5432.*##')" \
    "$(PATH="$SHIM:$PATH" compose_now "$node" "$lane" DATABASE_URL | sed -e 's#.*/##' -e 's#?.*##')"
done
echo "  ok  ${checked} composed DSN values byte-identical"

# DOLTGRES, EXPLICITLY: still ${VM_IP} (the control VM), still the control-env-keyed name.
echo "[2] DOLTGRES_URL still dials the control VM for every pair"
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  control="$(control_env_for "$lane" "$node")"
  dgu="$(PATH="$SHIM:$PATH" compose_now "$node" "$lane" DOLTGRES_URL)"
  [ "$(printf '%s' "$dgu" | sed -e 's#.*@##' -e 's#:5435.*##')" = "$(addr_for_env "$control")" ] \
    || fail "DOLTGRES_URL for ${pair} left the control VM: ${dgu}"
done
echo "  ok  all ${#PAIRS[@]} DOLTGRES_URLs still name the control env's VM on :5435"

# ── 3. DELETING ONE PIN MOVES EXACTLY ONE LANE'S TWO POSTGRES DSNs ───────────────
echo "[3] unpinning poly/candidate-a moves ONLY its two Postgres DSN hosts"
declare -A PINNED_SNAPSHOT=()
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  for key in "${DSN_KEYS[@]}"; do
    PINNED_SNAPSHOT["${pair}/${key}"]="$(PATH="$SHIM:$PATH" compose_now "$node" "$lane" "$key")"
  done
done
(
  export FORK_DOMAIN_ROOT="cognidao.org" # REQUIRED on the foreign path; see group 4
  export PATH="$SHIM:$PATH"
  LANE_DB_RESIDENCY_PINNED=("poly/preview" "red/candidate-a" "toks5/preview")
  moved=0
  for pair in "${PAIRS[@]}"; do
    node="${pair%%/*}"; lane="${pair##*/}"
    for key in "${DSN_KEYS[@]}"; do
      got="$(compose_now "$node" "$lane" "$key")"
      before="${PINNED_SNAPSHOT["${pair}/${key}"]}"
      if [ "$pair" = "poly/candidate-a" ] && [ "$key" != "DOLTGRES_URL" ]; then
        [ "$got" != "$before" ] || fail "unpinning poly/candidate-a did not move its ${key} — the ledger could never empty"
        moved=$((moved + 1))
        continue
      fi
      [ "$got" = "$before" ] \
        || fail "unpinning poly/candidate-a also changed ${key} for ${pair} — a cutover's blast radius must be ONE lane:
  before: ${before}
  after:  ${got}"
    done
  done
  [ "$moved" = 2 ] || fail "expected exactly 2 moved DSNs, got ${moved}"
  dsn="$(compose_now poly candidate-a DATABASE_URL)"
  [ "$(printf '%s' "$dsn" | sed -e 's#.*@##' -e 's#:5432.*##')" = "203.0.113.3" ] \
    || fail "unpinned poly/candidate-a must dial candidate-a's own VM; got ${dsn}"
  grep -q '://app_poly:' <<<"$dsn" || fail "the role must collapse with the host: ${dsn}"
  grep -q '/cogni_poly?' <<<"$dsn" || fail "the database name must collapse with the host: ${dsn}"
  # the host and the name moved TOGETHER, so the read side and the write side still agree
  out="$(lane_db_assert_agreement poly candidate-a "$dsn")" \
    || fail "the moved DSN must still satisfy the agreement gate; got: ${out}"
  echo "  ok  ${out}"
  # ...and Doltgres did NOT follow: still production's VM, still the suffixed knowledge DB.
  dgu="$(compose_now poly candidate-a DOLTGRES_URL)"
  grep -q '@203.0.113.1:5435/knowledge_poly_candidate_a?' <<<"$dgu" \
    || fail "Doltgres must NOT move with a Postgres pin deletion (out of scope, immutable superuser): ${dgu}"
  echo "  ok  poly/candidate-a moved to 203.0.113.3/cogni_poly; DOLTGRES_URL untouched on 203.0.113.1"
)
# the committed ledger is untouched by the experiment
[ "$(PATH="$SHIM:$PATH" compose_now poly candidate-a DATABASE_URL)" = "${PINNED_SNAPSHOT[poly/candidate-a/DATABASE_URL]}" ] \
  || fail "the pin experiment leaked — this branch must change no host"
echo "  ok  the committed ledger still composes today's host for poly/candidate-a"

# ── 4. NEVER COMPOSE A GUESSED HOST ──────────────────────────────────────────────
echo "[4] a missing domain root, an unresolvable or ambiguous alias, and bad arguments all REFUSE"
# (a) THE CROSS-FLEET WIDENING CLASS. `lane_db_host` soft-defaults the domain root to
#     `cognidao.org`, so on a fork fleet with FORK_DOMAIN_ROOT unset a defaulted root would
#     compose a TEST lane's DSN against the cogni-dao PRODUCTION VM. Refuse instead.
out="$(
  PATH="$SHIM:$PATH" bash -c '
    set -uo pipefail
    . "'"$REPO_ROOT"'/scripts/ci/lib/appset-paths.sh"
    . "'"$REPO_ROOT"'/scripts/setup/lib/cogni-deployment-identity.sh"
    . "'"$REPO_ROOT"'/scripts/ci/lib/lane-db-residency.sh"
    LANE_DB_RESIDENCY_PINNED=("poly/preview")
    unset FORK_DOMAIN_ROOT
    lane_db_dsn_host poly candidate-a production 203.0.113.1
  ' 2>&1
)" && fail "an unset FORK_DOMAIN_ROOT on the foreign path must REFUSE, not default to cognidao.org (got: ${out})"
grep -q 'FORK_DOMAIN_ROOT' <<<"$out" || fail "the refusal must name FORK_DOMAIN_ROOT; got: ${out}"
grep -qv '203.0.113' <<<"$out" || fail "the refusal must not emit a host"
echo "  ok  unset FORK_DOMAIN_ROOT on the foreign path refuses: $(head -1 <<<"$out" | cut -c1-90)…"
# ...and it is NOT required on the inert path, where no alias is ever built.
[ "$(lane_db_dsn_host poly candidate-a production 203.0.113.1)" = "203.0.113.1" ] \
  || fail "the resident path must return the caller's own address with no domain root and no DNS"
echo "  ok  the inert path needs neither FORK_DOMAIN_ROOT nor DNS"
# (b) unresolvable alias
(
  export FORK_DOMAIN_ROOT="cognidao.org"
  export PATH="$DEADSHIM:$PATH"
  LANE_DB_RESIDENCY_PINNED=("poly/preview")
  if out="$(lane_db_dsn_host poly candidate-a production 203.0.113.1 2>&1)"; then
    fail "an unresolvable VM alias must refuse, not compose a DSN with no host (got: ${out})"
  fi
  grep -q 'does not resolve' <<<"$out" || fail "the unresolvable failure must say so; got: ${out}"
  echo "  ok  an unresolvable alias refuses"
  # (c) ambiguous alias — a DSN carries one host, so two answers is a guess
  export PATH="$MULTISHIM:$PATH"
  if out="$(lane_db_dsn_host poly candidate-a production 203.0.113.1 2>&1)"; then
    fail "an alias with two A records must refuse, not pick one (got: ${out})"
  fi
  grep -q '2 A records' <<<"$out" || fail "the ambiguous failure must report the count; got: ${out}"
  echo "  ok  an ambiguous alias refuses"
)
# (d) a PINNED pair with no catalog row cannot be resolved — fail closed (bug.5206)
if out="$(CATALOG_DIR="$TMPROOT/nonexistent" lane_db_dsn_host poly candidate-a production 203.0.113.1 2>&1)"; then
  fail "a pinned pair with no catalog row must fail closed; got: ${out}"
fi
echo "  ok  a pinned pair with no catalog row fails closed"
# (e) arguments are mandatory — the local address is never re-derived here
for args in "poly candidate-a production" "poly candidate-a" "poly"; do
  # shellcheck disable=SC2086  # intentional word splitting of the argument fixture
  if lane_db_dsn_host $args 2>/dev/null; then fail "lane_db_dsn_host must refuse incomplete arguments: '${args}'"; fi
done
echo "  ok  incomplete arguments refuse"

# ── 5. THE AGREEMENT GATE PASSES FOR EVERY PAIR, ON THE COMPOSER'S OWN OUTPUT ────
echo "[5] lane_db_assert_agreement passes for every pair against the composed DATABASE_URL"
for pair in "${PAIRS[@]}"; do
  node="${pair%%/*}"; lane="${pair##*/}"
  dsn="$(PATH="$SHIM:$PATH" compose_now "$node" "$lane" DATABASE_URL)"
  out="$(PATH="$SHIM:$PATH" lane_db_assert_agreement "$node" "$lane" "$dsn")" \
    || fail "the composed DSN for ${pair} disagrees with the resolver: ${out}"
  printf '  ok  %s\n' "$out"
done

# ── 6. SCOPE GUARDS — what this change must NOT have touched ─────────────────────
echo "[6] scope guards: VM_IP is still the vault/SSH target, Doltgres still dials it, no rotations"
# shellcheck disable=SC2016  # the literal source text is the assertion
grep -q 'ssh \$SSH_OPTS root@"\$VM_IP"' "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh" \
  || fail "bao_get_field must still SSH to \${VM_IP} — VM_IP is the vault/SSH target and only the two Postgres DSN hosts moved"
# shellcheck disable=SC2016  # ditto
grep -q '"\$_dgu" "\${VM_IP}"' "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh" \
  || fail "DOLTGRES_URL must still compose \${VM_IP} as its host (Doltgres residency is out of scope)"
for f in scripts/setup/lib/reconcile-secrets.sh scripts/ci/lib/lane-db-residency.sh scripts/ci/secret-materialize.sh; do
  # comments DISCUSS bug.5207's `ALTER USER app_poly PASSWORD`; no line may EXECUTE one.
  if grep -vE '^[[:space:]]*#' "$REPO_ROOT/$f" | grep -qiE 'ALTER +(USER|ROLE)'; then
    fail "${f} emits an ALTER USER/ROLE — the password carrier (B2) is still open, and a lane whose DSN host moved without its password on the target gets 28P01"
  fi
done
grep -q 'COGNI_NODE_DBS' "$REPO_ROOT/scripts/ci/deploy-infra.sh" \
  || fail "deploy-infra.sh's COGNI_NODE_DBS roster must remain — narrowing it would shrink the Doltgres roster and prune live Grafana datasources"
echo "  ok  scope guards hold"

# [7] Exercise deploy-infra's actual shared-Postgres caller, including the runner
# rendering and SSH environment carrier. No Docker/OpenBao/network is invoked.
(
  real_repo="$REPO_ROOT"
  fixture="$TMPROOT/db-provision"
  mkdir -p "$fixture/infra/catalog"
  cp "$REPO_ROOT/infra/database-budget-profiles.yaml" "$fixture/infra/"
  # This caller scenario owns its full roster, including preview membership and tiers.
  write_akash_catalog_fixture "$fixture/infra/catalog" operator shared operator-control-v1
  write_akash_catalog_fixture "$fixture/infra/catalog" red
  write_akash_catalog_fixture "$fixture/infra/catalog" poly dedicated dedicated-high-throughput-v1
  yq -i '.envs = ["candidate-a", "production"]' "$fixture/infra/catalog/red.yaml"
  cp "$fixture/infra/catalog/operator.yaml" "$fixture/operator-baseline.yaml"
  for function_name in render_shared_db_provision_config read_node_db_secret provision_shared_node_databases; do
    function_source="$(awk -v name="$function_name" '
      $0 == name "() {" { capture=1 }
      capture { print }
      capture && /^}$/ { exit }
    ' "$real_repo/scripts/ci/deploy-infra.sh")"
    [[ -n "$function_source" ]] || fail "missing actual caller function $function_name"
    eval "$function_source"
  done
  log_error() { echo "$*" >&2; }
  log_fatal() { echo "$*" >&2; exit 1; }
  log_info() { :; }
  log_warn() { printf '%s\n' "$*" >> "$fixture/skips"; }
  REPO_ROOT="$fixture"
  export CATALOG_DIR="$fixture/infra/catalog" COGNI_CATALOG_ROOT="$fixture/infra/catalog"
  . "$real_repo/scripts/ci/lib/image-tags.sh"
  NODE_TARGETS=(operator red poly)
  DEPLOY_ENVIRONMENT=candidate-a
  NODE_DB_PROVISION_CONFIG="$(render_shared_db_provision_config)"
  [[ "$(jq -r 'keys | join(",")' <<<"$NODE_DB_PROVISION_CONFIG")" == operator,red ]] \
    || fail "dedicated or inactive node entered shared provisioning"
  [[ "$(jq -r '.operator.DB_BUDGET_PROFILE' <<<"$NODE_DB_PROVISION_CONFIG")" == operator-control-v1 ]]
  [[ "$(jq -r '.operator.DB_SERVICE_CONNECTION_LIMIT' <<<"$NODE_DB_PROVISION_CONFIG")" == 15 ]]
  [[ "$(jq -r '.red.DB_APP_CONNECTION_LIMIT' <<<"$NODE_DB_PROVISION_CONFIG")" == 2 ]]
  DEPLOY_ENVIRONMENT=preview
  [[ "$(render_shared_db_provision_config | jq -r 'keys | join(",")')" == operator ]] \
    || fail "environment-absent red entered preview provisioning"
  DEPLOY_ENVIRONMENT=candidate-a

  # An absent profile, bad limit or unknown tier fails before the caller runs.
  yq -i '.database."candidate-a".budget_profile = "absent"' "$fixture/infra/catalog/operator.yaml"
  if render_shared_db_provision_config >/dev/null 2>&1; then fail "missing profile accepted"; fi
  cp "$fixture/operator-baseline.yaml" "$fixture/infra/catalog/operator.yaml"
  yq -i '."operator-control-v1".roles.app.connection_limit = 0' "$fixture/infra/database-budget-profiles.yaml"
  if render_shared_db_provision_config >/dev/null 2>&1; then fail "zero budget accepted"; fi
  cp "$real_repo/infra/database-budget-profiles.yaml" "$fixture/infra/"
  yq -i '.database."candidate-a".tier = "foreign"' "$fixture/infra/catalog/operator.yaml"
  if render_shared_db_provision_config >/dev/null 2>&1; then fail "unknown database boundary accepted"; fi
  cp "$fixture/operator-baseline.yaml" "$fixture/infra/catalog/operator.yaml"

  # Use the ACTUAL remote read helper with a hermetic kubectl substitute. A
  # migration password in the public bank is deliberately wrong: the isolated
  # bank is the sole permissible source. Fake values contain shell metacharacters
  # to catch accidental word splitting or evaluation in Docker argument assembly.
  read_log="$fixture/reads"
  compose_log="$fixture/compose"
  : > "$read_log"
  : > "$compose_log"
  timeout() { shift; "$@"; }
  kubectl() {
    printf '%s\n' "${*: -2}" >> "$read_log"
    case "${*: -2}" in
      '-field=APP_DB_PASSWORD cogni/candidate-a/operator') printf '%s' "app fixture ' \$(literal)" ;;
      '-field=APP_DB_SERVICE_PASSWORD cogni/candidate-a/operator') printf '%s' 'service fixture' ;;
      '-field=APP_DB_MIGRATION_PASSWORD cogni/candidate-a/operator-database-migration')
        [[ "${missing_migration:-false}" == false ]] && printf '%s' 'isolated fixture' ;;
      '-field=APP_DB_MIGRATION_PASSWORD cogni/candidate-a/operator') printf '%s' 'WRONG PUBLIC VALUE' ;;
      *) return 1 ;;
    esac
  }
  fake_compose() {
    printf '%s\n' "$@" >> "$compose_log"
    local arg
    declare -A passed=()
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == -e ]]; then arg="$2"; passed["${arg%%=*}"]="${arg#*=}"; shift; fi
      shift
    done
    [[ "${passed[COGNI_NODE_DBS]}" == cogni_operator ]]
    [[ "${passed[APP_DB_PASSWORD]}" == "app fixture ' \$(literal)" ]]
    [[ "${passed[APP_DB_SERVICE_PASSWORD]}" == 'service fixture' ]]
    [[ "${passed[APP_DB_MIGRATION_PASSWORD]}" == 'isolated fixture' ]]
    [[ "${passed[DB_BUDGET_PROFILE]}" == operator-control-v1 ]]
    [[ "${passed[DB_APP_CONNECTION_LIMIT]}" == 7 ]]
    [[ "${passed[DB_APP_STATEMENT_TIMEOUT_MS]}" == 5000 ]]
    [[ "${passed[DB_SERVICE_CONNECTION_LIMIT]}" == 15 ]]
    [[ "${passed[DB_SERVICE_STATEMENT_TIMEOUT_MS]}" == 2000 ]]
    [[ "${passed[DB_LOCK_TIMEOUT_MS]}" == 2000 ]]
    [[ "${passed[DB_IDLE_IN_TRANSACTION_TIMEOUT_MS]}" == 30000 ]]
    [[ "${passed[DB_TEMP_FILE_LIMIT_MIB]}" == 128 ]]
    [[ "${passed[DB_WORK_MEM_MIB]}" == 16 ]]
  }
  DB_READER_TOKEN=test-only
  RUNTIME_COMPOSE=fake_compose
  provision_shared_node_databases
  grep -q '^APP_DB_MIGRATION_PASSWORD=isolated fixture$' "$compose_log" || fail "migration credential not forwarded"
  ! grep -q 'cogni/candidate-a/poly' "$read_log" || fail "dedicated cell credential read"
  ! grep -q 'cogni/production/' "$read_log" || fail "foreign environment credential read"
  # Unknown app/service credentials keep the existing unborn-node skip; red
  # must never reach Docker. An incomplete migration bank is also skipped,
  # preserving the existing per-node fail-soft policy without weakening provision.sh.
  [[ "$(grep -c '^db-provision$' "$compose_log")" == 1 ]]
  : > "$compose_log"
  (missing_migration=true; provision_shared_node_databases)
  grep -q 'Skipped cogni_operator: incomplete runtime/isolated migration credentials' "$fixture/skips" \
    || fail "incomplete credential bank was not surfaced"
  [[ ! -s "$compose_log" ]] || fail "missing migration credential reached Docker"
  if (unset NODE_DB_PROVISION_CONFIG; provision_shared_node_databases) >/dev/null 2>&1; then
    fail "missing SSH budget carrier silently skipped all nodes"
  fi
  [[ ! -s "$compose_log" ]] || fail "missing budget map reached Docker"
  # Pin the %q SSH carrier: the JSON must not vanish between runner and VM.
  sed -n '/^REMOTE_ENV_VARS=(/,/^)/p' "$real_repo/scripts/ci/deploy-infra.sh" \
    | grep -q 'NODE_DB_PROVISION_CONFIG' || fail "budget map not forwarded over SSH"
  echo "  ok  actual shared DB caller preserves isolated migration custody and catalog budgets"
)

echo "PASS: lane-db-dsn-host.test.sh (${#PAIRS[@]} catalog pairs, ${checked} DSN values, all inert)"
