#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

# Gate-ordering invariant (bug.0321 Fix 4, structural — not a comment):
# wait-for-argocd.sh MUST run first in the same job. Without Argo proven
# at EXPECTED_SHA + Healthy, a /readyz 200 may come from old pods still
# serving the prior digest — the silent-green class this script used to
# embody. wait-for-argocd.sh writes ARGOCD_SYNC_VERIFIED=true to
# $GITHUB_ENV on success; we refuse to run if it's unset. Local CLI /
# test callers can opt out with ARGOCD_SYNC_VERIFIED=skip.
if [ "${ARGOCD_SYNC_VERIFIED:-}" != "true" ] && [ "${ARGOCD_SYNC_VERIFIED:-}" != "skip" ]; then
  echo "[ERROR] wait-for-candidate-ready.sh must run after wait-for-argocd.sh" >&2
  echo "        Set ARGOCD_SYNC_VERIFIED=true (automatic when wait-for-argocd.sh precedes" >&2
  echo "        this step in the same job) or ARGOCD_SYNC_VERIFIED=skip for local/test" >&2
  echo "        callers that do not have Argo in the loop." >&2
  exit 1
fi

DOMAIN=${DOMAIN:-}
PROMOTED_APPS=${PROMOTED_APPS:-}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-30}
SLEEP_SECONDS=${SLEEP_SECONDS:-15}

if [ -z "$DOMAIN" ]; then
  echo "[ERROR] DOMAIN is required" >&2
  exit 1
fi

poll_ready() {
  local name="$1"
  local url="$2"
  local attempt=1

  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    status=$(curl -sk -o /dev/null -w '%{http_code}' "${url}/readyz" 2>/dev/null || echo "000")
    if [ "$status" = "200" ]; then
      echo "Ready: ${name} (${url})"
      return 0
    fi

    echo "Waiting for ${name}: HTTP ${status} (${attempt}/${MAX_ATTEMPTS})"
    sleep "$SLEEP_SECONDS"
    attempt=$((attempt + 1))
  done

  echo "[ERROR] ${name} did not become ready: ${url}" >&2
  return 1
}

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

# Catalog-driven: iterate NODE_TARGETS from infra/catalog/ and resolve each
# host via host_for_node() (which honours the `is_primary_host` catalog
# field). Adding a new node = one catalog edit, no script edit.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

for node in "${NODE_TARGETS[@]}"; do
  if should_check "$node"; then
    poll_ready "$node" "https://$(host_for_node "$node" "$DOMAIN")"
  else
    echo "[skip] ${node} readyz — not in PROMOTED_APPS=${PROMOTED_APPS}"
  fi
done
