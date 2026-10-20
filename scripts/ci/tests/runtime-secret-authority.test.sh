#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Hermetic checks of the exact normal deploy authority functions; no Docker/network.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/ci/deploy-infra.sh"
TMPROOT="$(mktemp -d -t runtime-authority.XXXXXX)"
trap 'rm -rf "$TMPROOT" "${ENTRY_TMP:-}"' EXIT
mkdir -p "$TMPROOT/bin"
function_source() {
  awk -v start="$1() {" '$0 == start {capture=1} capture {print} capture && /^}$/ {exit}' "$SOURCE"
}
{
  printf 'set -euo pipefail\n'
  printf 'log_fatal() { echo "$1" >&2; exit 1; }\nlog_info() { :; }\nlog_warn() { :; }\n'
  for name in previous_runtime_env_value postgres_bootstrap_identity preserve_postgres_bootstrap_identity source_openbao_runtime_key source_operator_database_service_url; do
    function_source "$name"
  done
} > "$TMPROOT/functions.sh"
cat > "$TMPROOT/bin/timeout" <<'SH'
#!/usr/bin/env bash
shift
exec "$@"
SH
cat > "$TMPROOT/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ps) [[ "${PROOF_CASE:-}" != multiple ]] && echo abc123 || printf 'abc123\ndef456\n' ;;
  inspect)
    if [[ "$*" == *NetworkSettings* ]]; then echo 10.100.0.2
    elif [[ "${PROOF_CASE:-}" == foreign ]]; then echo 'true|foreign|postgres|postgres_data'
    else echo 'true|cogni-runtime|postgres|postgres_data'; fi ;;
  exec)
    if [[ "$*" == *pg_controldata* ]]; then echo 'Database system identifier: 7654321'; exit; fi
    IFS= read -r supplied
    [[ "${PROOF_CASE:-}" != timeout ]] || exit 124
    if [[ "$supplied" != existing-root && "${PROOF_CASE:-}" != trust ]]; then
      echo 'password authentication failed' >&2; exit 2
    fi
    if [[ "${PROOF_CASE:-}" == stale && "$supplied" == existing-root ]]; then
      echo 'password authentication failed' >&2; exit 2
    fi
    [[ "${PROOF_CASE:-}" != wrong_identity ]] && echo '7654321|postgres|true' || echo '123|postgres|true' ;;
  compose)
    if [[ "${CONFIG_CASE:-}" == invalid ]]; then echo 'interpolation leaked-secret-marker' >&2; exit 1; fi ;;
  *) exit 9 ;;
esac
SH
chmod +x "$TMPROOT/bin/"*
export PATH="$TMPROOT/bin:$PATH"
printf 'POSTGRES_ROOT_USER=postgres\nPOSTGRES_ROOT_PASSWORD=existing-root\nAUTH_SECRET=must-never-be-preserved\n' > "$TMPROOT/installed.env"
export INSTALLED_RUNTIME_ENV="$TMPROOT/installed.env"
initial="$(cat "$INSTALLED_RUNTIME_ENV")"
for proof_case in success multiple foreign trust timeout stale wrong_identity explicit_mismatch; do
  if output="$( (
    source "$TMPROOT/functions.sh"
    export PROOF_CASE="$proof_case"
    unset POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD
    [[ "$proof_case" != explicit_mismatch ]] || POSTGRES_ROOT_PASSWORD=unrelated-incoming-root
    preserve_postgres_bootstrap_identity
    [[ "$POSTGRES_ROOT_USER" == postgres && "$POSTGRES_ROOT_PASSWORD" == existing-root ]]
    echo authenticated
  ) 2>&1)"; then
    [[ "$proof_case" == success && "$output" == authenticated ]] || { echo "Unexpected root proof success: $proof_case" >&2; exit 1; }
  else
    [[ "$proof_case" != success ]] || { echo "$output" >&2; exit 1; }
    [[ "$output" == *bootstrap_root_* ]] || { echo "Unclassified root proof failure: $proof_case" >&2; exit 1; }
  fi
  [[ "$output" != *existing-root* && "$output" != *must-never-be-preserved* ]]
  [[ "$(cat "$INSTALLED_RUNTIME_ENV")" == "$initial" ]]
done
# Runtime values come only from the requested owner. Absence clears GH shadows;
# a required absence cannot recover from an installed value or a foreign bank.
(
  source "$TMPROOT/functions.sh"
  OPENBAO_RUNTIME_SSOT=true
  openbao_get_field() { [[ "$1" != operator ]] || return 0; echo foreign-node-value; }
  METRICS_TOKEN=github-shadow
  source_openbao_runtime_key optional METRICS_TOKEN operator
  [[ -z "${METRICS_TOKEN:-}" ]]
)
if (
  source "$TMPROOT/functions.sh"
  OPENBAO_RUNTIME_SSOT=true
  DATABASE_URL=github-shadow
  openbao_get_field() { [[ "$1" != operator ]] || return 0; echo foreign-node-value; }
  source_openbao_runtime_key required DATABASE_URL operator
) > "$TMPROOT/failure" 2>&1; then echo 'Missing owner silently fell back' >&2; exit 1; fi
# Even the fresh lane uses the canonical operator ledger service URL.
(
  source "$TMPROOT/functions.sh"
  OPENBAO_RUNTIME_SSOT=false
  openbao_get_field() { [[ "$1/$2" == operator/DATABASE_SERVICE_URL ]] && echo canonical-service-url; }
  source_operator_database_service_url
  [[ "$OPERATOR_DATABASE_SERVICE_URL" == canonical-service-url ]]
)
# A failed ESO lookup must not enter fresh bootstrap. Positive absence can.
lookup="$(awk '/^ESO_TARGET=/ {capture=1} capture && /^source_openbao_runtime_key/ {exit} capture {print}' "$SOURCE")"
for lookup_case in absent existing unavailable; do
  if output="$( (
    source "$TMPROOT/functions.sh"
    DEPLOY_ENVIRONMENT=candidate-a
    kubectl() { case "$lookup_case" in existing) echo secret/operator-env-secrets ;; unavailable) return 124 ;; esac; }
    timeout() { shift; "$@"; }
    export -f kubectl timeout
    OPENBAO_RUNTIME_SSOT=false
    eval "$lookup"
    echo "$OPENBAO_RUNTIME_SSOT"
  ) 2>&1)"; then
    [[ "$lookup_case" != unavailable ]]
    [[ "$lookup_case" != existing || "$output" == true ]]
    [[ "$lookup_case" != absent || "$output" == false ]]
  else [[ "$lookup_case" == unavailable ]]; fi
done
# Fresh bootstrap still requires the original values; this is not a new fallback.
fresh="$(awk '/^if "\$OPENBAO_RUNTIME_SSOT"; then$/ {capture=1} capture {print} capture && /^fi$/ {exit}' "$SOURCE")"
for fresh_case in complete missing; do
  if (
    source "$TMPROOT/functions.sh"
    OPENBAO_RUNTIME_SSOT=false
    for key in DATABASE_URL DATABASE_SERVICE_URL LITELLM_MASTER_KEY OPENROUTER_API_KEY AUTH_SECRET POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD APP_DB_NAME EVM_RPC_URL POLYGON_RPC_URL TEMPORAL_DB_USER INTERNAL_OPS_TOKEN POSTHOG_API_KEY POSTHOG_HOST; do export "$key=fixture-value"; done
    [[ "$fresh_case" != missing ]] || unset POSTGRES_ROOT_PASSWORD
    eval "$fresh"
  ) > "$TMPROOT/fresh" 2>&1; then [[ "$fresh_case" == complete ]]; else [[ "$fresh_case" == missing ]]; fi
done
# The later per-node provision phase must reuse the reader minted for early
# runtime reads. Execute both actual source blocks, including any redefinition.
for name in mint_db_reader_token openbao_get_field; do
  function_source "$name" >> "$TMPROOT/functions.sh"
done
late_reader="$(awk '/^DB_READER_TOKEN=""$/ {capture=1} capture && /^# The runner forwards/ {exit} capture {print}' "$SOURCE")"
[[ -n "$late_reader" ]]
for reader_case in reuse token_transient login_transient permanent forbidden empty; do
  (
    source "$TMPROOT/functions.sh"
    BAO_CACHE_DIR="$TMPROOT/reader-$reader_case"
    mkdir -p "$BAO_CACHE_DIR"
    BAO_TOKEN_FILE="$BAO_CACHE_DIR/token"
    DEPLOY_ENVIRONMENT=production
    sleep() { :; }
    timeout() { shift; "$@"; }
    kubectl() {
      local native_phase attempts
      case "$*" in
        'create token db-provisioner -n default') native_phase=jwt ;;
        *'auth/kubernetes/login'*) native_phase=login ;;
        *'bao kv get -format=json'*) printf '%s' '{"data":{"data":{"APP_DB_PASSWORD":"owned-password"}}}'; return ;;
        *'bao kv get -field='*) printf '%s' owned-password; return ;;
        *) echo 'unexpected owned kubectl call' >&2; return 99 ;;
      esac
      printf 'call\n' >> "$BAO_CACHE_DIR/$native_phase.calls"
      attempts="$(wc -l < "$BAO_CACHE_DIR/$native_phase.calls" | tr -d ' ')"
      if [[ "$reader_case:$native_phase:$attempts" == token_transient:jwt:1 || "$reader_case:$native_phase:$attempts" == login_transient:login:1 ]]; then
        echo 'context deadline exceeded owned-jwt-secret owned-reader-secret' >&2
        return 124
      fi
      if [[ "$native_phase" == login ]]; then
        case "$reader_case" in
          permanent) echo 'malformed role owned-jwt-secret owned-reader-secret' >&2; return 7 ;;
          forbidden) echo 'Code: 403 permission denied owned-reader-secret' >&2; return 2 ;;
          empty) return 0 ;;
        esac
        printf '%s' owned-reader-secret
      else printf '%s' owned-jwt-secret; fi
    }
    if reader="$(mint_db_reader_token 2>"$BAO_CACHE_DIR/diagnostics")"; then
      [[ "$reader_case" == reuse || "$reader_case" == token_transient || "$reader_case" == login_transient ]]
      [[ "$reader" == owned-reader-secret ]]
      # Early path read uses the same cached reader as the real late block.
      [[ "$(openbao_get_field operator APP_DB_PASSWORD 2>>"$BAO_CACHE_DIR/diagnostics")" == owned-password ]]
      eval "$late_reader" 2>>"$BAO_CACHE_DIR/diagnostics"
      [[ "$DB_READER_TOKEN" == "$reader" ]]
      for field in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD APP_DB_MIGRATION_PASSWORD; do
        [[ "$(read_node_db_secret operator "$field")" == owned-password ]]
      done
      expected_jwt=1 expected_login=1
      [[ "$reader_case" != token_transient ]] || expected_jwt=2
      [[ "$reader_case" != login_transient ]] || { expected_jwt=2; expected_login=2; }
      [[ "$(wc -l < "$BAO_CACHE_DIR/jwt.calls" | tr -d ' ')" == "$expected_jwt" ]]
      [[ "$(wc -l < "$BAO_CACHE_DIR/login.calls" | tr -d ' ')" == "$expected_login" ]]
      grep -q 'phase=cache native_rc=0 reason=reused' "$BAO_CACHE_DIR/diagnostics"
      [[ "$reader_case" == reuse ]] || grep -q 'reason=server_transient attempt=1/3' "$BAO_CACHE_DIR/diagnostics"
    else
      [[ "$reader_case" == permanent || "$reader_case" == forbidden || "$reader_case" == empty ]]
      [[ -z "$reader" && ! -s "$BAO_TOKEN_FILE" ]]
      [[ "$(wc -l < "$BAO_CACHE_DIR/jwt.calls" | tr -d ' ')" == 1 ]]
      [[ "$(wc -l < "$BAO_CACHE_DIR/login.calls" | tr -d ' ')" == 1 ]]
      case "$reader_case" in
        permanent) grep -q 'phase=reader_login native_rc=7 reason=permanent' "$BAO_CACHE_DIR/diagnostics" ;;
        forbidden) grep -q 'native_rc=2 reason=permission_denied' "$BAO_CACHE_DIR/diagnostics" ;;
        empty) grep -q 'native_rc=0 reason=empty_output' "$BAO_CACHE_DIR/diagnostics" ;;
      esac
    fi
    ! grep -qE 'owned-jwt-secret|owned-reader-secret|owned-password' "$BAO_CACHE_DIR/diagnostics"
  )
done
# Execute the actual staged validation/publish block. Invalid final consumer
# interpolation must retain the installed generation, despite a complete stage.
publish="$(awk '/^docker compose --project-name cogni-runtime --env-file/ {capture=1} capture {print} capture && /^RUNTIME_ENV="\$INSTALLED_RUNTIME_ENV"$/ {exit}' "$SOURCE")"
[[ -n "$publish" ]]
for config_case in invalid valid; do
  printf '%s' "$initial" > "$INSTALLED_RUNTIME_ENV"
  printf 'complete-staged-generation\n' > "$TMPROOT/next.env"
  if (
    source "$TMPROOT/functions.sh"
    export CONFIG_CASE="$config_case"
    RUNTIME_ENV="$TMPROOT/next.env" RUNTIME_COMPOSE_FILE="$TMPROOT/compose.yml"
    eval "$publish"
  ) > "$TMPROOT/publish" 2>&1; then
    [[ "$config_case" == valid ]]
    [[ "$(cat "$INSTALLED_RUNTIME_ENV")" == complete-staged-generation ]]
  else
    [[ "$config_case" == invalid ]]
    [[ "$(cat "$INSTALLED_RUNTIME_ENV")" == "$initial" ]]
  fi
  [[ "$(cat "$TMPROOT/publish")" != *leaked-secret-marker* ]]
done
# Prove the original failure at the real entry point, not only extracted helpers.
# No runtime GitHub keys or live credentials enter this child. Fake git stops
# before creating a worktree; all transport commands are owned no-network shims.
ENTRY_TMP="$(mktemp -d /tmp/cogni-auth.XXXXXX)"
mkdir -p "$ENTRY_TMP/bin"
cat > "$ENTRY_TMP/bin/git" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *' fetch '*) echo 'owned-source-resolution-sentinel' >&2; exit 41 ;;
  *) exit 42 ;;
esac
SH
cat > "$ENTRY_TMP/bin/ssh" <<'SH'
#!/usr/bin/env bash
[[ "$*" == *' -O exit '* ]] || { echo 'forbidden-transport' >&2; exit 99; }
SH
cat > "$ENTRY_TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
echo 'forbidden-network' >&2
exit 99
SH
chmod +x "$ENTRY_TMP/bin/"*
if entry_output="$(env -i HOME="$ENTRY_TMP" TMPDIR="$ENTRY_TMP" RUNNER_TEMP="$ENTRY_TMP" \
  PATH="$ENTRY_TMP/bin:$PATH" DEPLOY_ENVIRONMENT=preview DOMAIN=owned.invalid VM_HOST=owned.invalid \
  APP_ENV=production COGNI_REPO_URL=https://owned.invalid/repo.git COGNI_REPO_REF=main \
  bash "$SOURCE" --dry-run 2>&1)"; then
  echo 'Entrypoint unexpectedly passed the owned source stop' >&2; exit 1
fi
[[ "$entry_output" == *owned-source-resolution-sentinel* ]] \
  || { echo 'Runtime keys incorrectly blocked the runner before custody/source resolution' >&2; exit 1; }
[[ "$entry_output" != *forbidden-transport* && "$entry_output" != *forbidden-network* ]]
printf 'runtime-secret-authority: root, ownership, outage, strict bootstrap and publish checks passed\n'
