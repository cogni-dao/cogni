#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Hermetic checks of the exact normal deploy authority functions; no Docker/network.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/ci/deploy-infra.sh"
TMPROOT="$(mktemp -d -t runtime-authority.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT
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
printf 'runtime-secret-authority: root, ownership, outage, strict bootstrap and publish checks passed\n'
