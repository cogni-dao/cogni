#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# doltgres-lane-residency.test.sh — A NODE'S DOLTGRES DSN NAMES ITS OWN ENV'S DOLTGRES (story.5098).
#
# `_compose_node_value` (scripts/setup/lib/reconcile-secrets.sh) composed DOLTGRES_URL with
# `${VM_IP}` (the CONTROL VM) and the control env's superuser
# (cogni/<control>/operator/DOLTGRES_PASSWORD). For a production-custodied candidate-a or
# preview lane, that handed a nonproduction node production's Doltgres and its superuser.
# Postgres DSNs already used the lane host (bug.5299). Every env is now composed the same way:
#   [1] production lane          → production VM host + production superuser.
#   [2] candidate-a lane written  → candidate-a VM host + candidate-a superuser, read from
#       from production's vault     cogni/candidate-a/operator in the writing vault. The
#                                   control superuser never appears. DOLTGRES_PASSWORD too.
#   [3] lane superuser absent     → FAIL CLOSED: non-zero, no DSN, a clear error. Under
#       in the writing vault        `set -e` the materialize loop's assignment aborts.
#   [4] a local writer seeding its own fresh env keeps the genesis derive.
#
# The bank lookup is secret-materialize.sh's REAL `bao_get_field`, extracted and run against a
# hermetic on-disk cache. No SSH, OpenBao, DNS or real credential is touched.
# shellcheck disable=SC2030,SC2031,SC2034
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CATALOG_DIR="$REPO_ROOT/infra/catalog"
export COGNI_CATALOG_ROOT="$CATALOG_DIR"
export COGNI_DOMAIN_ROOT="cognidao.org"
export COGNI_DEPLOYMENT_SLUG="cogni"
export FORK_DOMAIN_ROOT="cognidao.org"
unset COGNI_LANE_DB_HOST SECRETS_CONTROL_ENV

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

TMPROOT="$(mktemp -d -t doltgres-lane-residency.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT
fail() { echo "❌ $*" >&2; exit 1; }

# secret-materialize.sh's own lookup (target / owner / lane-owner authorities), verbatim.
definition="$(sed -n '/^bao_get_field() {$/,/^}$/p' "$REPO_ROOT/scripts/ci/secret-materialize.sh")"
[ -n "$definition" ] || fail "could not extract bao_get_field from secret-materialize.sh"
eval "$definition"
grep -q 'lane-owner)' <<<"$definition" || fail "secret-materialize.sh bao_get_field has no lane-owner authority"

# A correctly-provisioned fleet: every env's VM alias resolves to that env's VM.
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
for t in dig python3; do printf '#!/usr/bin/env bash\nexit 1\n' > "$SHIM/$t"; chmod +x "$SHIM/$t"; done
chmod +x "$SHIM/getent"
export PATH="$SHIM:$PATH"

addr_for_env() {
  case "$1" in
    production) printf '203.0.113.1' ;;
    preview) printf '203.0.113.2' ;;
    candidate-a) printf '203.0.113.3' ;;
  esac
}

# seed <cache> <env> <value>: cogni/<env>/operator/DOLTGRES_PASSWORD in the writing vault.
seed() {
  mkdir -p "$1/__owners__/$2/operator"
  printf '%s' "$3" > "$1/__owners__/$2/operator/DOLTGRES_PASSWORD"
}

# The materialize path: lane, control writer, the writer's VM address, the lane DB host.
compose() {
  local cache="$1" node="$2" lane="$3" key="$4"
  (
    CACHE_DIR="$cache"
    DEPLOY_ENV="$lane"
    DEPLOY_ENVIRONMENT="$lane"
    SECRETS_CONTROL_ENV="$(control_env_for "$lane" "$node")"
    VM_IP="$(addr_for_env "$SECRETS_CONTROL_ENV")"
    COGNI_LANE_DB_HOST="$(lane_db_dsn_host "$node" "$lane" "$SECRETS_CONTROL_ENV" "$VM_IP")"
    _compose_node_value "$node" "$key"
  )
}

[ "$(control_env_for candidate-a poly)" = production ] \
  || fail "fixture premise: poly/candidate-a must be production-custodied (akash)"

FULL="$TMPROOT/full"
seed "$FULL" production prod-dg-superuser
seed "$FULL" candidate-a canda-dg-superuser
seed "$FULL" preview preview-dg-superuser

echo "[1] production lane → production VM + production superuser"
got="$(compose "$FULL" poly production DOLTGRES_URL)"
want='postgresql://postgres:prod-dg-superuser@203.0.113.1:5435/knowledge_poly?sslmode=disable'
[ "$got" = "$want" ] || fail "production DOLTGRES_URL: got ${got}"
echo "  ok  ${got/prod-dg-superuser/<prod-superuser>}"

echo "[2] candidate-a lane written from production's vault → candidate-a host + candidate-a superuser"
for lane in candidate-a preview; do
  got="$(compose "$FULL" poly "$lane" DOLTGRES_URL)"
  sup="canda-dg-superuser"; [ "$lane" = preview ] && sup="preview-dg-superuser"
  want="postgresql://postgres:${sup}@$(addr_for_env "$lane"):5435/knowledge_poly_${lane//-/_}?sslmode=disable"
  [ "$got" = "$want" ] || fail "${lane} DOLTGRES_URL: got ${got}, want ${want}"
  ! grep -q 'prod-dg-superuser\|203\.0\.113\.1' <<<"$got" \
    || fail "${lane} DOLTGRES_URL carries production's host or superuser: ${got}"
  pw="$(compose "$FULL" poly "$lane" DOLTGRES_PASSWORD)"
  [ "$pw" = "$sup" ] || fail "${lane} DOLTGRES_PASSWORD must be the lane superuser"
  echo "  ok  poly/${lane}: host $(addr_for_env "$lane"), lane superuser, knowledge_poly_${lane//-/_}"
done

echo "[3] lane superuser absent in the writing vault → FAIL CLOSED"
PRODONLY="$TMPROOT/prod-only"
seed "$PRODONLY" production prod-dg-superuser
for key in DOLTGRES_URL DOLTGRES_PASSWORD; do
  if out="$(compose "$PRODONLY" poly candidate-a "$key" 2>"$TMPROOT/err")"; then
    fail "${key} composed with no candidate-a superuser: ${out}"
  fi
  [ -z "$out" ] || fail "${key} emitted a value on refusal"
  grep -q 'cogni/candidate-a/operator/DOLTGRES_PASSWORD' "$TMPROOT/err" || fail "${key} refusal must name the missing path"
  grep -q 'story.5098' "$TMPROOT/err" || fail "${key} refusal must cite story.5098"
  ! grep -q 'prod-dg-superuser' "$TMPROOT/err" || fail "${key} refusal leaked the control superuser"
  echo "  ok  ${key} refuses: $(head -1 "$TMPROOT/err" | cut -c1-100)…"
done
# secret-materialize.sh assigns `v="$(_compose_node_value …)"` under `set -e`: it must abort.
# (Not inside `if`/`&&`: bash ignores errexit there, which would hide the very abort we test.)
set +e
(
  set -e
  CACHE_DIR="$PRODONLY" DEPLOY_ENV=candidate-a DEPLOY_ENVIRONMENT=candidate-a SECRETS_CONTROL_ENV=production
  VM_IP=203.0.113.1 COGNI_LANE_DB_HOST=203.0.113.3
  v="$(_compose_node_value poly DOLTGRES_URL 2>/dev/null)"
  echo "reached ${v}"
) >"$TMPROOT/loop" 2>&1
loop_rc=$?
set -e
[ "$loop_rc" != 0 ] || fail "the materialize assignment did not abort: $(cat "$TMPROOT/loop")"
! grep -q reached "$TMPROOT/loop" || fail "the materialize loop continued past a refused composition"
echo "  ok  the materialize assignment aborts under set -e"

echo "[4] a local writer seeding its own fresh env keeps the genesis derive"
EMPTY="$TMPROOT/empty"
mkdir -p "$EMPTY"
[ "$(control_env_for candidate-a operator)" = candidate-a ] \
  || fail "fixture premise: operator/candidate-a must be locally custodied"
got="$(compose "$EMPTY" operator candidate-a DOLTGRES_URL)"
want="postgresql://postgres:$(derive_secret doltgres-root)@203.0.113.3:5435/knowledge_operator?sslmode=disable"
[ "$got" = "$want" ] || fail "local genesis DOLTGRES_URL: got ${got}"
echo "  ok  operator/candidate-a (local writer, fresh) composes the genesis superuser on its own host"

echo "PASS: doltgres-lane-residency.test.sh"
