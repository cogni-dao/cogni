#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Provision Grafana Cloud Postgres datasources for the current environment.
# This runs from CI, not on the VM: CI has GitHub secrets for Grafana and the
# Postgres root secret, while the VM hosts the PDC agent next to Postgres.

set -euo pipefail

log() {
  echo "[grafana-postgres] $*"
}

derive_secret() {
  local salt="$1"
  if command -v openssl >/dev/null 2>&1; then
    printf '%s:%s' "$salt" "${POSTGRES_ROOT_PASSWORD:?}" | openssl dgst -sha256 -hex | awk '{print $NF}' | cut -c1-32
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s:%s' "$salt" "${POSTGRES_ROOT_PASSWORD:?}" | sha256sum | cut -c1-32
  else
    echo "No sha256 tool available" >&2
    exit 1
  fi
}

missing_or_placeholder() {
  [[ -z "${1:-}" || "$1" == *"<"* || "$1" == *">"* || "$1" == *" "* ]]
}

base64url_decode() {
  local value="${1//-/+}"
  value="${value//_/\/}"
  while (( ${#value} % 4 != 0 )); do
    value="${value}="
  done
  if ! printf '%s' "$value" | base64 -d 2>/dev/null; then
    printf '%s' "$value" | base64 -D
  fi
}

derive_pdc_defaults_from_token() {
  [[ -n "${GRAFANA_PDC_SIGNING_TOKEN:-}" ]] || return 0
  [[ "$GRAFANA_PDC_SIGNING_TOKEN" == glc_* ]] || return 0

  local decoded
  decoded="$(base64url_decode "${GRAFANA_PDC_SIGNING_TOKEN#glc_}" 2>/dev/null || true)"
  [[ -n "$decoded" ]] || return 0

  local network_id cluster
  network_id="$(printf '%s' "$decoded" | jq -r '.n // empty')"
  cluster="$(printf '%s' "$decoded" | jq -r '.m.r // empty')"

  if missing_or_placeholder "${GRAFANA_PDC_NETWORK_ID:-}" && [[ -n "$network_id" ]]; then
    GRAFANA_PDC_NETWORK_ID="$network_id"
  fi
  if missing_or_placeholder "${GRAFANA_PDC_CLUSTER:-}" && [[ -n "$cluster" ]]; then
    GRAFANA_PDC_CLUSTER="$cluster"
  fi
}

if [[ -z "${GRAFANA_URL:-}" && -z "${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  log "Grafana not configured; skipping Postgres datasource provisioning"
  exit 0
fi

: "${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT not set}"
: "${POSTGRES_ROOT_PASSWORD:?POSTGRES_ROOT_PASSWORD not set}"
: "${GRAFANA_URL:?GRAFANA_URL not set}"
: "${GRAFANA_SERVICE_ACCOUNT_TOKEN:?GRAFANA_SERVICE_ACCOUNT_TOKEN not set}"

case "$GRAFANA_SERVICE_ACCOUNT_TOKEN" in
  glc_*)
    echo "GRAFANA_SERVICE_ACCOUNT_TOKEN is a Grafana Cloud token (glc_), not a Grafana stack service-account token (glsa_)" >&2
    exit 1
    ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

derive_pdc_defaults_from_token
# GRAFANA_PDC_NETWORK_UUID is the *internal* Grafana network identifier that
# binds a datasource to a PDC network. The legacy GRAFANA_PDC_NETWORK_ID
# (derived from the signing-token payload) is the human network NAME and is
# *not* what Grafana Cloud routes by — see docs/runbooks/grafana-postgres-readonly.md.
#
# The UUID is stable per Grafana org. Discover it once via:
#   curl -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
#     "$GRAFANA_URL/api/datasources/uid/<any-bound-datasource>" \
#     | jq -r '.jsonData.secureSocksProxyUsername'
# Store it as the env-level GitHub secret GRAFANA_PDC_NETWORK_UUID.
: "${GRAFANA_PDC_NETWORK_UUID:?GRAFANA_PDC_NETWORK_UUID not set; copy from the secureSocksProxyUsername field of an existing UI-bound Postgres datasource and store as the GRAFANA_PDC_NETWORK_UUID env secret. See runbook.}"

# COGNI_NODE_DBS is a derived G-tier value and may lag in GitHub Environment
# secrets. Grafana datasources should follow the same catalog inventory that
# deploy-infra uses to provision Postgres.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

grafana_base="${GRAFANA_URL%/}"
datasource_host="${GRAFANA_POSTGRES_HOST:-postgres:5432}"
readonly_user="${APP_DB_READONLY_USER:-app_readonly}"
readonly_password="${APP_DB_READONLY_PASSWORD:-$(derive_secret postgres-readonly)}"
dbs="$(node_database_csv)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

if [[ "$datasource_host" != "postgres:5432" && "${GRAFANA_POSTGRES_ALLOW_NON_INTERNAL_HOST:-0}" != "1" ]]; then
  echo "Refusing non-internal Grafana Postgres host: ${datasource_host}" >&2
  echo "Use GRAFANA_POSTGRES_HOST=postgres:5432 through PDC, or set GRAFANA_POSTGRES_ALLOW_NON_INTERNAL_HOST=1 deliberately." >&2
  exit 1
fi

IFS=',' read -ra grafana_dbs <<< "$dbs"
for db_name in "${grafana_dbs[@]}"; do
  db_name="$(echo "$db_name" | xargs)"
  [[ -n "$db_name" ]] || continue

  node="${db_name#cogni_}"
  uid="cogni-${DEPLOY_ENVIRONMENT}-${node}-postgres"
  name="Postgres - ${DEPLOY_ENVIRONMENT} ${node}"
  payload_file="${tmpdir}/${uid}.json"
  response_file="${tmpdir}/${uid}.response.json"
  query_file="${tmpdir}/${uid}.query.json"

  jq -n \
    --arg name "$name" \
    --arg uid "$uid" \
    --arg url "$datasource_host" \
    --arg user "$readonly_user" \
    --arg database "$db_name" \
    --arg password "$readonly_password" \
    --arg pdc_network_uuid "$GRAFANA_PDC_NETWORK_UUID" \
    '{
      name: $name,
      uid: $uid,
      type: "grafana-postgresql-datasource",
      access: "proxy",
      url: $url,
      user: $user,
      jsonData: {
        database: $database,
        sslmode: "disable",
        postgresVersion: 1500,
        timescaledb: false,
        enableSecureSocksProxy: true,
        secureSocksProxyUsername: $pdc_network_uuid,
        pdcInjected: true
      },
      secureJsonData: {
        password: $password
      }
    }' > "$payload_file"

  status=$(curl -sS -o "$response_file" -w "%{http_code}" \
    -H "Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN}" \
    "${grafana_base}/api/datasources/uid/${uid}")

  # Always finish with a PUT against the UID. Grafana's per-datasource query
  # path latches onto whatever decrypted password it derives on first read after
  # POST; if that read happens before the password is fully persisted, the bad
  # value persists indefinitely (observed SQLSTATE 28P01 lasting >1min after a
  # fresh POST, with no recovery until the next deploy's PUT). PUT forces
  # re-decrypt and refreshes the cached connector. We POST when the UID is
  # absent, then unconditionally PUT — both fresh-create and steady-state
  # redeploy take the cache-bust path.
  if [[ "$status" == "404" ]]; then
    log "creating ${uid}"
    curl -fsS -X POST "${grafana_base}/api/datasources" \
      -H "Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN}" \
      -H "content-type: application/json" \
      --data @"$payload_file" >/dev/null
  elif [[ "$status" != "200" ]]; then
    echo "Grafana datasource lookup failed for ${uid}: HTTP ${status}" >&2
    cat "$response_file" >&2 || true
    exit 1
  fi

  log "putting ${uid} (cache-bust)"
  curl -fsS -X PUT "${grafana_base}/api/datasources/uid/${uid}" \
    -H "Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN}" \
    -H "content-type: application/json" \
    --data @"$payload_file" >/dev/null

  log "provisioned ${uid}"
done

log "all datasources provisioned; runtime connectivity is verified separately by verify-grafana-postgres-datasources.sh"
