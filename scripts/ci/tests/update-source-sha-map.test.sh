#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# PIN_IS_NEVER_REPINNED_TO_BIRTH (bug.5306). The guard must refuse exactly one
# thing — replacing an existing lane pin with the catalog BIRTH sha — and must
# leave every legitimate promote alone. The "inert" case is load-bearing: this
# script runs on every promote for every node, so a caller that does not pass
# CATALOG_BIRTH_SHA must behave exactly as before.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
S="$ROOT/scripts/ci/update-source-sha-map.sh"
BIRTH=73482da19fe4bef19933536507293b66b00e879a
NEWER=b776aa3866ec5db15648ac93affab80148c5c7fd
OTHER=0a1677b1cb00000000000000000000000000aaaa
pass=0; fail=0
run_case() {
  local name="$1" prior="$2" incoming="$3" birth="$4" want_rc="$5" want_pin="$6"
  local d; d="$(mktemp -d)"
  mkdir -p "$d/.promote-state"
  [ -n "$prior" ] && printf '{"toks4":"%s"}\n' "$prior" >"$d/.promote-state/source-sha-by-app.json"
  local rc=0
  ( cd "$d" && APP=toks4 SOURCE_SHA="$incoming" CATALOG_BIRTH_SHA="$birth" bash "$S" >/dev/null 2>&1 ) || rc=$?
  local got; got="$(jq -r '.toks4 // "none"' "$d/.promote-state/source-sha-by-app.json" 2>/dev/null || echo none)"
  if [ "$rc" = "$want_rc" ] && [ "${got:0:8}" = "${want_pin:0:8}" ]; then
    echo "  PASS  $name"; pass=$((pass+1))
  else
    echo "  FAIL  $name (rc=$rc want=$want_rc pin=${got:0:8} want=${want_pin:0:8})"; fail=$((fail+1))
  fi
  rm -rf "$d"
}
echo "update-source-sha-map.sh — PIN_IS_NEVER_REPINNED_TO_BIRTH (bug.5306)"
run_case "refuses re-pin to birth over a newer pin"  "$NEWER" "$BIRTH" "$BIRTH" 1 "$NEWER"
run_case "allows a forward promote"                  "$BIRTH" "$NEWER" "$BIRTH" 0 "$NEWER"
run_case "allows the first pin even if it is birth"  ""       "$BIRTH" "$BIRTH" 0 "$BIRTH"
run_case "allows re-pin to a non-birth sha"          "$NEWER" "$OTHER" "$BIRTH" 0 "$OTHER"
run_case "is inert when CATALOG_BIRTH_SHA is absent" "$NEWER" "$BIRTH" ""       0 "$BIRTH"
run_case "is idempotent re-writing the same pin"     "$BIRTH" "$BIRTH" "$BIRTH" 0 "$BIRTH"
echo "  ---- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
