#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# A `curl` stand-in that serves Grafana's /api/datasources surface out of a JSON
# file, so the REAL provision/verify scripts can be exercised offline. Injected
# by prefixing PATH (the scripts call `curl` directly and must not grow a
# test-only indirection hook).
#
# State:  $SHIM_STATE — JSON array of datasource objects, read AND written.
# Log:    $SHIM_LOG   — one `METHOD /path` line per request, in order.
#
# Supports exactly the flags the two scripts use: -f -s -S -o -w -H -X --data.

set -uo pipefail

method="GET"
url=""
outfile=""
want_code=0
fail_on_error=0
data_file=""

while (( $# > 0 )); do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -o) outfile="$2"; shift 2 ;;
    -w) [[ "$2" == *"%{http_code}"* ]] && want_code=1; shift 2 ;;
    -H) shift 2 ;;
    --data) data_file="${2#@}"; shift 2 ;;
    --data-urlencode) shift 2 ;;
    -G) shift ;;
    -m) shift 2 ;;
    -f|-s|-S|-fsS|-sS|-fs) [[ "$1" == *f* ]] && fail_on_error=1; shift ;;
    http*|https*) url="$1"; shift ;;
    *) shift ;;
  esac
done

[[ -n "$data_file" && "$method" == "GET" ]] && method="POST"

: "${SHIM_STATE:?SHIM_STATE not set}"
: "${SHIM_LOG:?SHIM_LOG not set}"
[[ -f "$SHIM_STATE" ]] || echo '[]' > "$SHIM_STATE"

path="${url#*://*/}"
path="/${path}"
echo "${method} ${path}" >> "$SHIM_LOG"

code=404
body='{"message":"not found"}'

case "${method} ${path}" in
  "GET /api/datasources")
    code=200; body="$(cat "$SHIM_STATE")" ;;

  "GET /api/datasources/uid/"*)
    uid="${path##*/}"
    if body="$(jq -e --arg uid "$uid" '.[] | select(.uid == $uid)' "$SHIM_STATE" 2>/dev/null)"; then
      code=200
    else
      code=404; body='{"message":"Data source not found"}'
    fi ;;

  "POST /api/datasources")
    payload="$(cat "$data_file")"
    uid="$(jq -r '.uid' <<< "$payload")"
    if jq -e --arg uid "$uid" 'any(.[]; .uid == $uid)' "$SHIM_STATE" >/dev/null; then
      code=409; body='{"message":"data source with the same uid already exists"}'
    else
      jq --argjson ds "$payload" '. + [$ds]' "$SHIM_STATE" > "$SHIM_STATE.tmp" \
        && mv "$SHIM_STATE.tmp" "$SHIM_STATE"
      code=200; body="$payload"
    fi ;;

  "PUT /api/datasources/uid/"*)
    uid="${path##*/}"
    payload="$(cat "$data_file")"
    if jq -e --arg uid "$uid" 'any(.[]; .uid == $uid)' "$SHIM_STATE" >/dev/null; then
      jq --arg uid "$uid" --argjson ds "$payload" \
        'map(if .uid == $uid then $ds else . end)' "$SHIM_STATE" > "$SHIM_STATE.tmp" \
        && mv "$SHIM_STATE.tmp" "$SHIM_STATE"
      code=200; body="$payload"
    else
      code=404; body='{"message":"Data source not found"}'
    fi ;;

  "POST /api/ds/query")
    # Canned query outcome, so the verify layer can be exercised against the
    # shapes Grafana really returns — including a 200 envelope that carries the
    # datasource's own error (bug.5117).
    code="${SHIM_DS_QUERY_CODE:-200}"
    body="${SHIM_DS_QUERY_BODY:-$(jq -nc '{results:{A:{frames:[]}}}')}" ;;

  "DELETE /api/datasources/uid/"*)
    uid="${path##*/}"
    if jq -e --arg uid "$uid" 'any(.[]; .uid == $uid)' "$SHIM_STATE" >/dev/null; then
      jq --arg uid "$uid" 'map(select(.uid != $uid))' "$SHIM_STATE" > "$SHIM_STATE.tmp" \
        && mv "$SHIM_STATE.tmp" "$SHIM_STATE"
      code=200; body='{"message":"Data source deleted"}'
    else
      code=404; body='{"message":"Data source not found"}'
    fi ;;
esac

if [[ -n "$outfile" ]]; then
  printf '%s' "$body" > "$outfile"
else
  printf '%s' "$body"
fi

(( want_code == 1 )) && printf '%s' "$code"

if (( fail_on_error == 1 )) && (( code >= 400 )); then
  exit 22
fi
exit 0
