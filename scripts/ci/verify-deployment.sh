#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# verify-deployment.sh — Post-deploy validation: health polls + smoke tests.
# Called by the verify job in promote-and-deploy.yml.
# Dependency reachability is already confirmed by deploy-infra.sh (Step 6.8).
#
# Usage: verify-deployment.sh
# Env:   DOMAIN (required), VM_HOST (optional, for diagnostics on failure),
#        K8S_NAMESPACE (optional), SSH_DEPLOY_KEY (optional),
#        PROMOTED_APPS (optional CSV of catalog node targets to verify)

set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN is required}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-30}"
SLEEP="${SLEEP:-${SLEEP_SECONDS:-15}}"
PROMOTED_APPS="${PROMOTED_APPS:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

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

# ── Health polls ─────────────────────────────────────────────────────────────

poll_health() {
  local name="$1"
  local url="$2"
  local attempt=1

  echo "Polling $name at $url/readyz ..."
  while [ $attempt -le $MAX_ATTEMPTS ]; do
    STATUS=$(curl -sk -o /dev/null -w '%{http_code}' "$url/readyz" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      echo "✅ $name healthy (attempt $attempt)"
      return 0
    fi
    echo "  $name: HTTP $STATUS (attempt $attempt/$MAX_ATTEMPTS)"
    sleep "$SLEEP"
    attempt=$((attempt + 1))
  done
  echo "❌ $name failed health check after $MAX_ATTEMPTS attempts"
  return 1
}

nodes_to_check=()
for node in "${NODE_TARGETS[@]}"; do
  if should_check "$node"; then
    nodes_to_check+=("$node")
  else
    echo "[skip] ${node} readyz — not in PROMOTED_APPS=${PROMOTED_APPS}"
  fi
done

if [ "${#nodes_to_check[@]}" -eq 0 ]; then
  echo "No node targets to verify (PROMOTED_APPS=${PROMOTED_APPS:-<all>})"
  exit 0
fi

pids=()
for node in "${nodes_to_check[@]}"; do
  poll_health "$node" "https://$(host_for_node "$node" "$DOMAIN")" &
  pids+=("$!")
done

FAILED=0
for pid in "${pids[@]}"; do
  wait "$pid" || FAILED=1
done

if [ $FAILED -ne 0 ]; then
  echo "❌ One or more nodes failed health checks"
  exit 1
fi
echo "✅ Target nodes healthy"

# ── Smoke tests ──────────────────────────────────────────────────────────────

for node in "${nodes_to_check[@]}"; do
  url="https://$(host_for_node "$node" "$DOMAIN")"
  BODY=$(curl -sk "$url/livez" 2>/dev/null)
  echo "$url/livez → $BODY"
  if ! echo "$BODY" | grep -q '"status"'; then
    echo "❌ $url/livez did not return expected JSON"
    exit 1
  fi
done
echo "✅ Smoke tests passed"
