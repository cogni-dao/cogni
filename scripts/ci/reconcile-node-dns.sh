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
#      DNS_RECONCILE_SUMMARY_FILE optionally receives one structured JSON summary
#      for CI/Grafana.
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

records_tmp=""
if [ -n "${DNS_RECONCILE_SUMMARY_FILE:-}" ]; then
  records_tmp=$(mktemp -t dns-reconcile-records.XXXXXX)
fi
SUMMARY_WRITTEN=false

append_dns_record() {
  [ -n "$records_tmp" ] || return 0
  DNS_NODE="$node" \
    DNS_HOST="$host" \
    DNS_STATE="${state:-}" \
    DNS_CONTENT="${content:-}" \
    DNS_EXPECTED="$VM_IP" \
    python3 - <<'PY' >>"$records_tmp" || true
import json
import os

record = {
    "node": os.environ["DNS_NODE"],
    "host": os.environ["DNS_HOST"],
    "state": os.environ["DNS_STATE"],
}
content = os.environ.get("DNS_CONTENT", "")
if content:
    record["content"] = content
expected = os.environ.get("DNS_EXPECTED", "")
if expected:
    record["expected"] = expected
print(json.dumps(record, separators=(",", ":")))
PY
}

write_dns_summary() {
  [ -n "${DNS_RECONCILE_SUMMARY_FILE:-}" ] || return 0
  local status="$1"
  local candidate_sha="${DNS_RECONCILE_CANDIDATE_SHA:-}"
  local candidate_sha8="${candidate_sha:0:8}"
  DNS_STATUS="$status" \
    DNS_DEPLOY_ENV="$DEPLOY_ENV" \
    DNS_DOMAIN="${DOMAIN:-}" \
    DNS_VM_IP="${VM_IP:-}" \
    DNS_PROXIED="${PROXIED:-}" \
    DNS_CHECK="$CHECK" \
    DNS_WORKFLOW="${GITHUB_WORKFLOW:-}" \
    DNS_JOB="${GITHUB_JOB:-}" \
    DNS_RUN_ID="${GITHUB_RUN_ID:-}" \
    DNS_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}" \
    DNS_REF="${GITHUB_REF_NAME:-}" \
    DNS_WORKFLOW_SHA="${GITHUB_SHA:-}" \
    DNS_CANDIDATE_SHA="$candidate_sha" \
    DNS_CANDIDATE_SHA8="$candidate_sha8" \
    DNS_HEAD_SHA="${DNS_RECONCILE_HEAD_SHA:-}" \
    DNS_NODE_SOURCE_SHA="${DNS_RECONCILE_NODE_SOURCE_SHA:-}" \
    DNS_PR_NUMBER="${DNS_RECONCILE_PR_NUMBER:-}" \
    DNS_NODE_SLUG="${DNS_RECONCILE_NODE_SLUG:-}" \
    DNS_STATUS_URL="${DNS_RECONCILE_STATUS_URL:-}" \
    python3 - "$records_tmp" <<'PY' >"${DNS_RECONCILE_SUMMARY_FILE}.tmp" || return 0
import collections
import datetime
import json
import os
import sys

records = []
path = sys.argv[1] if len(sys.argv) > 1 else ""
if path:
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))

states = collections.Counter(record.get("state", "unknown") for record in records)
payload = {
    "schema_version": 1,
    "type": "dns_reconcile_summary",
    "status": os.environ["DNS_STATUS"],
    "deploy_env": os.environ["DNS_DEPLOY_ENV"],
    "domain": os.environ["DNS_DOMAIN"],
    "origin_ip": os.environ["DNS_VM_IP"],
    "proxied": os.environ["DNS_PROXIED"] == "true",
    "check": os.environ["DNS_CHECK"] == "true",
    "workflow": os.environ["DNS_WORKFLOW"],
    "job": os.environ["DNS_JOB"],
    "run_id": os.environ["DNS_RUN_ID"],
    "attempt": os.environ["DNS_ATTEMPT"],
    "ref": os.environ["DNS_REF"],
    "workflow_sha": os.environ["DNS_WORKFLOW_SHA"],
    "candidate_sha": os.environ["DNS_CANDIDATE_SHA"],
    "candidate_sha8": os.environ["DNS_CANDIDATE_SHA8"],
    "head_sha": os.environ["DNS_HEAD_SHA"],
    "node_source_sha": os.environ["DNS_NODE_SOURCE_SHA"],
    "pr_number": os.environ["DNS_PR_NUMBER"],
    "node_slug": os.environ["DNS_NODE_SLUG"],
    "status_url": os.environ["DNS_STATUS_URL"],
    "record_count": len(records),
    "states": dict(sorted(states.items())),
    "records": records,
    "emitted_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
print(json.dumps(payload, separators=(",", ":")))
PY
  mv "${DNS_RECONCILE_SUMMARY_FILE}.tmp" "$DNS_RECONCILE_SUMMARY_FILE"
  SUMMARY_WRITTEN=true
}

if [ -n "${DNS_RECONCILE_SUMMARY_FILE:-}" ]; then
  trap 'status=$?; if [ "$status" -ne 0 ] && [ "${SUMMARY_WRITTEN:-false}" != "true" ]; then write_dns_summary "failure"; fi; rm -f "${records_tmp:-}"' EXIT
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
      state="ok"
    else
      echo "  MISSING  ${host} (resolves to '${content:-none}', want ${VM_IP})"
      state="missing"
      missing+=("$host")
    fi
    append_dns_record
  else
    state=$(cf_upsert_a_record "$CLOUDFLARE_API_TOKEN" "$CLOUDFLARE_ZONE_ID" "$host" "$VM_IP" "$PROXIED") \
      || { echo "[ERROR] upsert failed for ${host}" >&2; write_dns_summary "failure"; exit 1; }
    echo "  ${host} → ${VM_IP} (proxied=${PROXIED}): ${state}"
    content="$VM_IP"
    append_dns_record
  fi
done

if $CHECK && [ "${#missing[@]}" -gt 0 ]; then
  write_dns_summary "failure"
  echo "[ERROR] ${#missing[@]} node host(s) missing DNS: ${missing[*]}" >&2
  echo "        Run: bash scripts/ci/reconcile-node-dns.sh ${DEPLOY_ENV}" >&2
  exit 1
fi

write_dns_summary "success"
echo "Node DNS reconciled."
