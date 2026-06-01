#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Verify runtime connectivity for the Grafana Postgres datasources provisioned
# by provision-grafana-postgres-datasources.sh. Issues `select current_user`
# through Grafana's /api/ds/query for each datasource UID with a bounded retry
# (3 attempts, 5s linear backoff) to absorb post-provision cache propagation
# lag. Failure here surfaces a runtime signal — it must NOT be wired as a
# blocking gate on deploy promotion (see infra/grafana/AGENTS.md for the
# rationale and the three-layer model).

set -euo pipefail

log() {
  echo "[grafana-postgres-verify] $*"
}

if [[ -z "${GRAFANA_URL:-}" || -z "${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  log "Grafana not configured; skipping datasource verification"
  exit 0
fi

: "${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT not set}"

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

# COGNI_NODE_DBS is derived from infra/catalog, not a durable manual roster.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

grafana_base="${GRAFANA_URL%/}"
dbs="$(node_database_csv)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

attempts="${GRAFANA_VERIFY_ATTEMPTS:-3}"
backoff_seconds="${GRAFANA_VERIFY_BACKOFF_SECONDS:-5}"

failed_uids=()

IFS=',' read -ra grafana_dbs <<< "$dbs"
for db_name in "${grafana_dbs[@]}"; do
  db_name="$(echo "$db_name" | xargs)"
  [[ -n "$db_name" ]] || continue

  node="${db_name#cogni_}"
  uid="cogni-${DEPLOY_ENVIRONMENT}-${node}-postgres"
  query_file="${tmpdir}/${uid}.query.json"

  jq -n \
    --arg uid "$uid" \
    '{
      from: "now-5m",
      to: "now",
      queries: [
        {
          refId: "A",
          datasource: { uid: $uid, type: "grafana-postgresql-datasource" },
          rawSql: "select current_user",
          format: "table",
          maxDataPoints: 1000,
          intervalMs: 1000
        }
      ]
    }' > "$query_file"

  ok=0
  for attempt in $(seq 1 "$attempts"); do
    response_file="${tmpdir}/${uid}.attempt-${attempt}.response.json"
    status=$(curl -sS -o "$response_file" -w "%{http_code}" -X POST "${grafana_base}/api/ds/query" \
      -H "Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN}" \
      -H "content-type: application/json" \
      --data @"$query_file")
    if [[ "$status" == "200" ]]; then
      log "verified ${uid} (attempt ${attempt}/${attempts})"
      ok=1
      break
    fi
    log "attempt ${attempt}/${attempts} for ${uid} returned HTTP ${status}"
    if (( attempt < attempts )); then
      sleep "$((backoff_seconds * attempt))"
    else
      jq . "$response_file" >&2 || cat "$response_file" >&2 || true
    fi
  done

  if (( ok == 0 )); then
    failed_uids+=("$uid")
    echo "::warning::Grafana datasource ${uid} failed connectivity verification after ${attempts} attempts"
  fi
done

if (( ${#failed_uids[@]} > 0 )); then
  {
    echo "## Grafana Postgres datasource verification — FAILED"
    echo ""
    echo "Failed UIDs:"
    for uid in "${failed_uids[@]}"; do
      echo "- \`${uid}\`"
    done
    echo ""
    echo "Provisioning succeeded; runtime connectivity is not healthy."
    echo "This does NOT block deploy. See infra/grafana/AGENTS.md."
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi

log "all datasources verified"
