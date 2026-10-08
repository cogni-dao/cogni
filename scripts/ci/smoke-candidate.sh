#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

DOMAIN=${DOMAIN:-}
PROMOTED_APPS=${PROMOTED_APPS:-}
CURL_TIMEOUT=${CURL_TIMEOUT:-30}
CHAT_TIMEOUT=${CHAT_TIMEOUT:-90}
# Deep-readiness gate budget. Each attempt is bounded by DEEP_READY_TIMEOUT so a
# wedged substrate cannot stall the job; the retries absorb a genuine transient
# (an RPC 429, a Temporal reconnect) without making the gate toothless.
DEEP_READY_TIMEOUT=${DEEP_READY_TIMEOUT:-30}
DEEP_READY_ATTEMPTS=${DEEP_READY_ATTEMPTS:-3}
DEEP_READY_SLEEP=${DEEP_READY_SLEEP:-15}

if [ -z "$DOMAIN" ]; then
  echo "[ERROR] DOMAIN is required" >&2
  exit 1
fi

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

# ─────────────────────────────────────────────────────────────────────────────
# bug.5386 — the deploy gate must be able to see dead substrate.
#
# /livez answers "is this process alive"; the default /readyz answers "can this
# pod serve HTTP" and is deliberately NON-FATAL on substrate failures so a blip
# cannot drain the fleet (incident 2026-06-26). Neither can fail a flight for a
# node whose Doltgres knowledge plane is unresponsive — which is exactly what
# happened: candidate-flight run 37700379535 reported every job green against a
# node where every knowledge endpoint timed out.
#
# `/readyz?deep=1` is the route's own hard-fail path over EVM RPC, Temporal,
# scheduler-worker and the knowledge store. It existed but NOTHING in CI called
# it — two workflow comments already described it as the substrate gate while it
# was dead code. This is the call that makes it one.
#
# A non-200 here fails the flight. That is the point: a candidate whose
# substrate is down must not be certified for a human to test against.
# ─────────────────────────────────────────────────────────────────────────────
check_deep_ready() {
  local name="$1"
  local url="$2"
  local attempt=1
  local status body_file

  body_file=$(mktemp)
  # shellcheck disable=SC2064  # expand body_file now, not at trap time
  trap "rm -f '$body_file'" RETURN

  while [ "$attempt" -le "$DEEP_READY_ATTEMPTS" ]; do
    # `--max-time` is the load-bearing flag: the failure this gate exists to
    # catch is an endpoint that never answers, so the probe itself must be the
    # thing that gives up.
    # Assign-then-default rather than `|| echo 000`: on a transport failure
    # curl already prints `000`, so piping a second one concatenates into
    # a nonsense `000000` in the job log.
    status=$(curl -sk --max-time "$DEEP_READY_TIMEOUT" \
      -o "$body_file" -w '%{http_code}' \
      "${url}/readyz?deep=1" 2>/dev/null) || status="000"
    [ -n "$status" ] || status="000"

    if [ "$status" = "200" ]; then
      echo "${name} deep readiness: 200 (substrate proven)"
      return 0
    fi

    echo "${name} deep readiness: HTTP ${status} (${attempt}/${DEEP_READY_ATTEMPTS})"
    if [ -s "$body_file" ]; then
      cat "$body_file"
      echo
    fi
    if [ "$attempt" -lt "$DEEP_READY_ATTEMPTS" ]; then
      sleep "$DEEP_READY_SLEEP"
    fi
    attempt=$((attempt + 1))
  done

  {
    echo "[ERROR] ${name} deep readiness failed: ${url}/readyz?deep=1 returned ${status}"
    echo "        The candidate's substrate (EVM RPC / Temporal / scheduler-worker /"
    echo "        Doltgres knowledge plane) is not proven. Refusing to certify this"
    echo "        flight — see the readiness failure logged by the node (bug.5386)."
    if [ -s "$body_file" ]; then
      cat "$body_file"
      echo
    fi
  } >&2
  exit 1
}

# Catalog-driven smoke probe: iterate NODE_TARGETS and resolve each host via
# host_for_node() (honours `is_primary_host`). Adding a new node = one
# catalog edit, no script edit.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

for app in "${NODE_TARGETS[@]}"; do
  if should_check "$app"; then
    app_base="https://$(host_for_node "$app" "$DOMAIN")"
    check_livez "$app" "$app_base"
    check_deep_ready "$app" "$app_base"
  else
    echo "[skip] ${app} livez + deep readiness — not in PROMOTED_APPS=${PROMOTED_APPS}"
  fi
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
if ! command -v jq >/dev/null 2>&1; then
  echo "[skip] bug.0322 regression check — jq not installed"
elif ! should_check poly || ! should_check operator; then
  echo "[skip] bug.0322 regression check — needs poly+operator promoted (PROMOTED_APPS=${PROMOTED_APPS})"
else
  echo "[bug.0322] cross-node isolation check"
  POLY_BASE="https://poly-${DOMAIN}"
  OP_BASE="https://${DOMAIN}"

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
