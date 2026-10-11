#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

DOMAIN=${DOMAIN:-}
PROMOTED_APPS=${PROMOTED_APPS:-}
CURL_TIMEOUT=${CURL_TIMEOUT:-30}

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

# Catalog-driven smoke probe: iterate NODE_TARGETS and resolve each host via
# host_for_node() (honours `is_primary_host`). Adding a new node = one
# catalog edit, no script edit.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

for app in "${NODE_TARGETS[@]}"; do
  if should_check "$app"; then
    check_livez "$app" "https://$(host_for_node "$app" "$DOMAIN")"
  else
    echo "[skip] ${app} livez — not in PROMOTED_APPS=${PROMOTED_APPS}"
  fi
done

# Run-carries is intentionally absent here. Anonymous agent registration is not a test seam.
# The code/credential isolation contract is remote-CI covered in task.5218; exact-SHA live proof uses
# the governed node-local `/api/internal/flight-probe` only after task.5223 provisions its secret.
