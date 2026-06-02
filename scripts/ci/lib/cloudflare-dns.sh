#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/lib/cloudflare-dns.sh — single declaration site for the idempotent
# Cloudflare A-record upsert. Sourced by BOTH provision-env-vm.sh (full env
# provision, Phase 4b) and reconcile-node-dns.sh (per-flight node DNS). The two
# call sites used to drift: provision had an inline delete-then-create loop, and
# per-flight DNS did not exist at all. Factor the upsert here so "what a record
# looks like" is declared once (DNS_IS_RECONCILED_NOT_HANDCRAFTED).
#
# Idempotent by contract: an upsert is a no-op when exactly one A record already
# matches (content + proxied); otherwise it deletes every stale A record of that
# name and creates the canonical one. Cloudflare returns the origin content for
# proxied records, so a proxied apex still yields its VM IP on read.
#
# Sourced — caller owns `set -euo pipefail`. Curl is injectable via $CF_CURL
# (test shim) mirroring verify-buildsha.sh's $CURL_CMD and set-secret's bao shim.
# Requires python3 (already a provision/CI dependency) for JSON parsing.

_cf_api="https://api.cloudflare.com/client/v4"
# shellcheck disable=SC2086  # CF_CURL is an intentional word-split command string
CF_CURL="${CF_CURL:-curl -s}"

# Echo the content (IP) of the first A record named $fqdn, or empty string.
#   cf_a_record_content TOKEN ZONE_ID FQDN
cf_a_record_content() {
  local token="$1" zone="$2" fqdn="$3"
  # shellcheck disable=SC2086
  $CF_CURL -H "Authorization: Bearer ${token}" \
    "${_cf_api}/zones/${zone}/dns_records?name=${fqdn}&type=A" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",[]); print(r[0]["content"] if r else "")' 2>/dev/null
}

# Echo the proxied flag ("true"/"false") of the first A record named $fqdn, or
# empty string when absent. Lets node records MIRROR the apex's proxy state
# instead of hardcoding one — so reconcile never flips a working env's records.
#   cf_a_record_proxied TOKEN ZONE_ID FQDN
cf_a_record_proxied() {
  local token="$1" zone="$2" fqdn="$3"
  # shellcheck disable=SC2086
  $CF_CURL -H "Authorization: Bearer ${token}" \
    "${_cf_api}/zones/${zone}/dns_records?name=${fqdn}&type=A" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",[]); print(("true" if r[0]["proxied"] else "false") if r else "")' 2>/dev/null
}

# Idempotent upsert of a single A record. Echoes "unchanged" or "created".
# Returns non-zero on a Cloudflare API failure.
#   cf_upsert_a_record TOKEN ZONE_ID FQDN IP PROXIED(true|false)
cf_upsert_a_record() {
  local token="$1" zone="$2" fqdn="$3" ip="$4" proxied="$5" existing decision id
  # shellcheck disable=SC2086
  existing=$($CF_CURL -H "Authorization: Bearer ${token}" \
    "${_cf_api}/zones/${zone}/dns_records?name=${fqdn}&type=A")
  # "noop" when exactly one record already matches; else "<id> <id> ..." to delete.
  decision=$(printf '%s' "$existing" | CF_IP="$ip" CF_PROXIED="$proxied" python3 -c '
import json, os, sys
r = json.load(sys.stdin).get("result", [])
ip = os.environ["CF_IP"]
proxied = os.environ["CF_PROXIED"] == "true"
if len(r) == 1 and r[0]["content"] == ip and bool(r[0]["proxied"]) == proxied:
    print("noop")
else:
    print(" ".join(x["id"] for x in r))
' 2>/dev/null)
  if [ "$decision" = "noop" ]; then
    printf 'unchanged'
    return 0
  fi
  for id in $decision; do
    # shellcheck disable=SC2086
    $CF_CURL -X DELETE -H "Authorization: Bearer ${token}" \
      "${_cf_api}/zones/${zone}/dns_records/${id}" >/dev/null
  done
  # shellcheck disable=SC2086
  $CF_CURL -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
    "${_cf_api}/zones/${zone}/dns_records" \
    -d "{\"type\":\"A\",\"name\":\"${fqdn}\",\"content\":\"${ip}\",\"ttl\":300,\"proxied\":${proxied}}" \
    | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' 2>/dev/null \
    || return 1
  printf 'created'
}
