#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

PROMOTED_APPS=${PROMOTED_APPS:-}
CURL_TIMEOUT=${CURL_TIMEOUT:-30}
CHAT_TIMEOUT=${CHAT_TIMEOUT:-90}
DEPLOY_ENV=${DEPLOY_ENV:-${OVERLAY_ENV:-${DEPLOY_ENVIRONMENT:-candidate-a}}}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/image-tags.sh
. "${SCRIPT_DIR}/lib/image-tags.sh"

# When PROMOTED_APPS is set (CI), scope per-node probes to apps that actually
# received a new digest in this flight. A static-page-only PR shouldn't be
# gated on poly's chat/completions runtime. Empty/unset = check everything
# (laptop flights, full-stack promotions).
should_check() {
  local app="$1"
  if [ -z "$PROMOTED_APPS" ]; then
    return 0
  fi
  case ",${PROMOTED_APPS}," in
    *",${app},"*) return 0 ;;
    *) return 1 ;;
  esac
}

check_livez() {
  local name="$1"
  local url="$2"
  local body

  body=$(curl -sk --max-time "$CURL_TIMEOUT" "${url}/livez" 2>/dev/null || true)
  echo "${name} livez: ${body}"
  if ! printf '%s' "$body" | grep -q '"status"'; then
    echo "[ERROR] ${name} livez did not return expected JSON" >&2
    exit 1
  fi
}

# bug.5002 — read per-node URL from catalog (per env) instead of
# computing `${node}-${DOMAIN}` with hardcoded operator-is-special.
# The iteration set is NODE_TARGETS from catalog.
for app in "${NODE_TARGETS[@]}"; do
  if ! should_check "$app"; then
    echo "[skip] ${app} livez — not in PROMOTED_APPS=${PROMOTED_APPS}"
    continue
  fi
  url=$(public_url_for_target "$DEPLOY_ENV" "$app")
  if [ -z "$url" ]; then
    echo "[skip] ${app} livez — no public_url.${DEPLOY_ENV} in catalog (no public Ingress)"
    continue
  fi
  check_livez "$app" "$url"
done

# ─────────────────────────────────────────────────────────────────────────────
# bug.0322 cross-node run-isolation regression check.
# Registers a machine agent on poly, runs a chat completion on poly, asserts
# the run is visible on poly's /agent/runs AND absent from operator's. Locks
# task.0280 (worker HTTP delegation) closed from the outside.
# Skips when jq is unavailable — CI images have jq; laptop flights may not.
# Also skips when neither poly nor operator was promoted — the check
# exercises both nodes; a PR that touches neither has nothing to regress.
# ─────────────────────────────────────────────────────────────────────────────
POLY_BASE=$(public_url_for_target "$DEPLOY_ENV" poly 2>/dev/null || echo "")
OP_BASE=$(public_url_for_target "$DEPLOY_ENV" operator 2>/dev/null || echo "")
if ! command -v jq >/dev/null 2>&1; then
  echo "[skip] bug.0322 regression check — jq not installed"
elif [ -z "$POLY_BASE" ] || [ -z "$OP_BASE" ]; then
  echo "[skip] bug.0322 regression check — catalog lacks poly+operator public_url.${DEPLOY_ENV} (single-node fork or missing catalog entries)"
elif ! should_check poly || ! should_check operator; then
  echo "[skip] bug.0322 regression check — needs poly+operator promoted (PROMOTED_APPS=${PROMOTED_APPS})"
else
  echo "[bug.0322] cross-node isolation check"

  creds=$(curl -sk --max-time "$CURL_TIMEOUT" -X POST "${POLY_BASE}/api/v1/agent/register" \
    -H 'Content-Type: application/json' \
    -d '{"name":"smoke-bug0322"}')
  api_key=$(printf '%s' "$creds" | jq -r '.apiKey // empty')
  if [ -z "$api_key" ]; then
    echo "[ERROR] poly /agent/register did not return apiKey: $creds" >&2
    exit 1
  fi

  chat=$(curl -sk --max-time "$CHAT_TIMEOUT" -X POST "${POLY_BASE}/api/v1/chat/completions" \
    -H "Authorization: Bearer $api_key" -H 'Content-Type: application/json' \
    -d '{"model":"gpt-4o-mini","graph_name":"poet","messages":[{"role":"user","content":"hi"}]}')
  run_id=$(printf '%s' "$chat" | jq -r '.id // empty' | sed 's/^chatcmpl-//')
  if [ -z "$run_id" ]; then
    echo "[ERROR] poly chat/completions did not return an id: $chat" >&2
    exit 1
  fi
  echo "  seeded runId=$run_id via poly"

  # Give the worker a beat to finalize the run row.
  sleep 3

  poly_runs=$(curl -sk --max-time "$CURL_TIMEOUT" -H "Authorization: Bearer $api_key" "${POLY_BASE}/api/v1/agent/runs")
  op_runs=$(curl -sk --max-time "$CURL_TIMEOUT" -H "Authorization: Bearer $api_key" "${OP_BASE}/api/v1/agent/runs")

  poly_has=$(printf '%s' "$poly_runs" | jq --arg id "$run_id" '[.runs[]? | select(.runId == $id)] | length')
  op_has=$(printf '%s' "$op_runs" | jq --arg id "$run_id" '[.runs[]? | select(.runId == $id)] | length')

  if [ "$poly_has" != "1" ]; then
    echo "[FAIL bug.0322] run $run_id not visible on poly (expected 1, got $poly_has)" >&2
    echo "  poly body: $poly_runs" >&2
    exit 1
  fi
  if [ "$op_has" != "0" ]; then
    echo "[FAIL bug.0322] run $run_id LEAKED to operator (expected 0, got $op_has)" >&2
    echo "  operator body: $op_runs" >&2
    exit 1
  fi
  echo "  poly_has=$poly_has operator_has=$op_has ✓"
fi
