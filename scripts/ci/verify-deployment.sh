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
#        PROMOTED_APPS (required CSV of catalog targets; empty means no nodes)

set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN is required}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-30}"
SLEEP="${SLEEP:-${SLEEP_SECONDS:-15}}"
PROMOTED_APPS="${PROMOTED_APPS?PROMOTED_APPS must explicitly identify the promotion scope}"

if [ -z "$PROMOTED_APPS" ]; then
  echo "No node targets to verify (PROMOTED_APPS is explicitly empty)"
  exit 0
fi

if [[ ! "$PROMOTED_APPS" =~ ^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$ ]]; then
  echo "Invalid promotion target list: $PROMOTED_APPS" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

IFS=',' read -r -a requested_targets <<< "$PROMOTED_APPS"
for target in "${requested_targets[@]}"; do
  if [[ " ${ALL_TARGETS[*]} " != *" $target "* ]]; then
    echo "Invalid promotion target: $target" >&2
    exit 1
  fi
done

should_check() {
  local app="$1"
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
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    STATUS=$(curl -sk --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' "$url/readyz" 2>/dev/null || echo "000")
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
  echo "No node targets to verify (PROMOTED_APPS=${PROMOTED_APPS})"
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
  if ! BODY=$(curl -sk --fail --connect-timeout 5 --max-time 10 "$url/livez" 2>/dev/null); then
    echo "❌ $url/livez request failed"
    exit 1
  fi
  echo "$url/livez → $BODY"
  if ! jq -e 'type == "object" and .status == "alive"' >/dev/null 2>&1 <<< "$BODY"; then
    echo "❌ $url/livez did not return alive JSON"
    exit 1
  fi
done
echo "✅ Smoke tests passed"
