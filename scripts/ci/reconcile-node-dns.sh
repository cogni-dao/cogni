#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-node-dns.sh — upsert one Cloudflare A record per catalog type:node
# to the env VM IP, so a node flighted to <env> resolves at its public host with
# ZERO manual DNS step. Closes the node-formation DNS gap: catalog → overlays →
# flight → secrets/DB all auto-fan, but `<node>-test.<root>` never resolved —
# there is no `*-test` wildcard, and each live node had a hand-made A record.
#
# Catalog-driven sibling of render-caddyfile.sh: both loop NODE_TARGETS so adding
# a node is a one-PR catalog change. host_for_node() is the same host SSOT the
# edge Caddyfile and smoke/buildSha checks use, so DNS matches what they expect.
#
# The VM IP is read from the env apex (operator) A record — node records always
# point exactly where the operator host points. Override with VM_IP=... .
#
# Idempotent: re-running upserts to the same final state (no-op when records
# already match). --check is the drift gate: assert every type:node already
# resolves to the VM IP; non-zero exit lists what is missing.
#
# Usage:
#   reconcile-node-dns.sh <env>            # upsert all node A records
#   reconcile-node-dns.sh <env> --check    # drift gate, no writes
#
# Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID (GH env secrets), FORK_DOMAIN_ROOT
#      (repo var). DOMAIN + VM_IP derive from <env> but can be overridden.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"
# shellcheck source=scripts/setup/lib/fork-identity.sh
source "${SCRIPT_DIR}/../setup/lib/fork-identity.sh"
# shellcheck source=scripts/ci/lib/cloudflare-dns.sh
source "${SCRIPT_DIR}/lib/cloudflare-dns.sh"

DEPLOY_ENV=""
CHECK=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=true ;;
    -*) echo "[ERROR] reconcile-node-dns: unknown flag: $arg" >&2; exit 1 ;;
    *) DEPLOY_ENV="$arg" ;;
  esac
done

if [ -z "$DEPLOY_ENV" ]; then
  echo "Usage: reconcile-node-dns.sh <env> [--check]" >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required (GH env secret)}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID required (GH env secret)}"
FORK_ROOT="${FORK_DOMAIN_ROOT:?FORK_DOMAIN_ROOT required (Cloudflare zone name)}"

if [ -z "${DOMAIN:-}" ]; then
  DOMAIN=$(domain_for_env "$DEPLOY_ENV" "$FORK_ROOT") \
    || { echo "[ERROR] cannot derive DOMAIN for env '$DEPLOY_ENV'" >&2; exit 1; }
fi

# VM IP = the apex (operator) A record's origin content. Cloudflare returns the
# origin IP even for proxied records, so this works regardless of proxy state.
if [ -z "${VM_IP:-}" ]; then
  VM_IP=$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$DOMAIN")
fi
if [ -z "$VM_IP" ]; then
  echo "[ERROR] no VM IP: apex A record '$DOMAIN' not found and VM_IP unset." >&2
  echo "[ERROR] Provision the env first (scripts/setup/provision-env-vm.sh) or pass VM_IP=..." >&2
  exit 1
fi

# Mirror the apex's proxy state so node hosts match how the operator host is
# actually reached — reconcile never flips a working env's records (candidate-a
# runs unproxied today; a proxied fork stays proxied). Override with PROXIED=.
if [ -z "${PROXIED:-}" ]; then
  PROXIED=$(cf_a_record_proxied "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$DOMAIN")
  [ -n "$PROXIED" ] || PROXIED="true"
fi

echo "Reconciling node DNS for env '${DEPLOY_ENV}' (domain ${DOMAIN} → ${VM_IP}, proxied=${PROXIED})"
missing=()
for node in "${NODE_TARGETS[@]}"; do
  # Apex (is_primary_host) is an env-level record provisioned with the VM, not
  # a per-node concern — skip it here.
  is_primary_host "$node" && continue
  host="$(host_for_node "$node" "$DOMAIN")"
  if $CHECK; then
    content=$(cf_a_record_content "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$host")
    if [ "$content" = "$VM_IP" ]; then
      echo "  ok       ${host} → ${VM_IP}"
    else
      echo "  MISSING  ${host} (resolves to '${content:-none}', want ${VM_IP})"
      missing+=("$host")
    fi
  else
    state=$(cf_upsert_a_record "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$host" "$VM_IP" "$PROXIED") \
      || { echo "[ERROR] upsert failed for ${host}" >&2; exit 1; }
    echo "  ${host} → ${VM_IP} (proxied=${PROXIED}): ${state}"
  fi
done

if $CHECK && [ "${#missing[@]}" -gt 0 ]; then
  echo "[ERROR] ${#missing[@]} node host(s) missing DNS: ${missing[*]}" >&2
  echo "        Run: bash scripts/ci/reconcile-node-dns.sh ${DEPLOY_ENV}" >&2
  exit 1
fi

echo "Node DNS reconciled."
