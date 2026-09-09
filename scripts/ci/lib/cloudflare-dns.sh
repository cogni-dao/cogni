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
# Idempotent by contract: a no-op when exactly one A record already matches
# (content + proxied). On drift the canonical record is UPDATED IN PLACE (PUT) —
# never deleted-then-recreated — so a failed write can never leave a healthy host
# with no A record. Only true duplicates (>1 record of the same name) are pruned.
# Cloudflare returns the origin content for proxied records, so a proxied apex
# still yields its VM IP on read.
#
# DNS_NEVER_TOUCHES_APEX: the zone apex (@) and `www` are never node hosts;
# mutating them programmatically is the one mistake that takes down the whole
# domain. cf_upsert_a_record REFUSES them (mirrors the PROTECTED guard in
# @cogni/dns-ops) unless the caller sets CF_ALLOW_PROTECTED=1 — used solely by
# env provisioning, which deliberately manages the apex/operator host. Every
# other caller (reconcile, future) is fail-safe by default.
#
# Sourced — caller owns `set -euo pipefail`. Curl is injectable via $CF_CURL
# (test shim) mirroring verify-buildsha.sh's $CURL_CMD and set-secret's bao shim.
# Requires python3 (already a provision/CI dependency) for JSON parsing.

_cf_api="https://api.cloudflare.com/client/v4"
# shellcheck disable=SC2086  # CF_CURL is an intentional word-split command string
CF_CURL="${CF_CURL:-curl -s}"

# True when $fqdn is the zone apex or its `www` — the records that must never be
# touched programmatically. The zone root is FORK_DOMAIN_ROOT (the Cloudflare
# zone name, set by both call sites); CF_PROTECTED_ROOT overrides it, and as a
# last resort the registrable domain (last two labels) is derived from the fqdn
# so the guard still bites when neither is set.
#   _cf_is_protected FQDN
_cf_is_protected() {
  local fqdn root
  fqdn="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  root="${CF_PROTECTED_ROOT:-${FORK_DOMAIN_ROOT:-}}"
  if [ -z "$root" ]; then
    root="$(printf '%s' "$fqdn" | awk -F. '{ if (NF>=2) print $(NF-1)"."$NF; else print $0 }')"
  fi
  root="$(printf '%s' "$root" | tr '[:upper:]' '[:lower:]')"
  [ "$fqdn" = "$root" ] || [ "$fqdn" = "www.${root}" ]
}

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

# Echo the record TYPE (A / CNAME / …) of the first record named $fqdn across ALL
# types, or empty when the name is unclaimed. DNS_ONE_WRITER_PER_HOST: a host whose
# live record is not an A belongs to a different reconciler (an externally-placed
# node's host is a CNAME written by the operator's ComputeWorkload DNS adapter), so
# callers need to tell "absent" from "owned by someone else" — a `?type=A` read
# cannot.
#   cf_record_type TOKEN ZONE_ID FQDN
cf_record_type() {
  local token="$1" zone="$2" fqdn="$3"
  # shellcheck disable=SC2086
  $CF_CURL -H "Authorization: Bearer ${token}" \
    "${_cf_api}/zones/${zone}/dns_records?name=${fqdn}" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",[]); print(r[0]["type"] if r else "")' 2>/dev/null
}

# Idempotent upsert of a single A record. Echoes "unchanged", "created", or
# "updated". Returns 2 on a refused PROTECTED record, 3 when a foreign record type
# already owns the name, non-zero on API failure.
#   cf_upsert_a_record TOKEN ZONE_ID FQDN IP PROXIED(true|false)
cf_upsert_a_record() {
  local token="$1" zone="$2" fqdn="$3" ip="$4" proxied="$5" existing decision keep_id id
  if [ "${CF_ALLOW_PROTECTED:-0}" != "1" ] && _cf_is_protected "$fqdn"; then
    echo "[ERROR] cloudflare-dns: refusing to modify PROTECTED record '${fqdn}' (zone apex/www)." >&2
    echo "[ERROR] Node hosts only. Set CF_ALLOW_PROTECTED=1 only to deliberately provision the apex." >&2
    return 2
  fi
  # PLACEMENT-CORRECT PROBE: read the name across ALL record types, never `?type=A`.
  # A live CNAME (what the ComputeWorkload controller writes for an externally
  # placed node) is invisible to a type-A read, so the old probe decided "create"
  # and POSTed an A that Cloudflare rejects (81053 — a CNAME is exclusive on its
  # name), surfacing only as a bare "upsert failed".
  # shellcheck disable=SC2086
  existing=$($CF_CURL -H "Authorization: Bearer ${token}" \
    "${_cf_api}/zones/${zone}/dns_records?name=${fqdn}")
  # Decision:
  #   "noop"                       — exactly one record already matches
  #   "create"                     — no record of this name
  #   "update <keep> [<extra>...]" — update <keep> in place; prune any duplicates
  #   "conflict <type>"            — a non-A record owns the name (foreign writer)
  decision=$(printf '%s' "$existing" | CF_IP="$ip" CF_PROXIED="$proxied" python3 -c '
import json, os, sys
r = json.load(sys.stdin).get("result", [])
ip = os.environ["CF_IP"]
proxied = os.environ["CF_PROXIED"] == "true"
foreign = [x for x in r if x.get("type") != "A"]
if foreign:
    print("conflict " + str(foreign[0].get("type", "?")))
elif not r:
    print("create")
elif len(r) == 1 and r[0]["content"] == ip and bool(r[0]["proxied"]) == proxied:
    print("noop")
else:
    print("update " + " ".join(x["id"] for x in r))
' 2>/dev/null)

  case "$decision" in
    conflict\ *)
      echo "[ERROR] cloudflare-dns: '${fqdn}' already holds a ${decision#conflict } record — another writer owns this host." >&2
      echo "[ERROR] An externally-placed node's host is a CNAME owned by the ComputeWorkload controller; refusing to overwrite it with an A record." >&2
      return 3
      ;;
    noop)
      printf 'unchanged'
      return 0
      ;;
    create)
      # shellcheck disable=SC2086
      $CF_CURL -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
        "${_cf_api}/zones/${zone}/dns_records" \
        -d "{\"type\":\"A\",\"name\":\"${fqdn}\",\"content\":\"${ip}\",\"ttl\":300,\"proxied\":${proxied}}" \
        | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' 2>/dev/null \
        || return 1
      printf 'created'
      ;;
    update\ *)
      # Update the canonical record IN PLACE — never delete the record we keep,
      # so a failed write cannot leave the host with no A record.
      keep_id="${decision#update }"
      keep_id="${keep_id%% *}"
      # shellcheck disable=SC2086
      $CF_CURL -X PUT -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
        "${_cf_api}/zones/${zone}/dns_records/${keep_id}" \
        -d "{\"type\":\"A\",\"name\":\"${fqdn}\",\"content\":\"${ip}\",\"ttl\":300,\"proxied\":${proxied}}" \
        | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' 2>/dev/null \
        || return 1
      # Prune only true duplicates (the records after the one we kept).
      for id in ${decision#update "$keep_id"}; do
        # shellcheck disable=SC2086
        $CF_CURL -X DELETE -H "Authorization: Bearer ${token}" \
          "${_cf_api}/zones/${zone}/dns_records/${id}" >/dev/null
      done
      printf 'updated'
      ;;
  esac
}
