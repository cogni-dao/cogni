#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# externalsecret-refresh.test.sh — bug.5566 regression guard.
#
# Production promotes failed in `node-substrate (operator)` with
# "ExternalSecret refresh did not advance: operator-env-secrets" when ESO's resync for a
# spec flip and the force-sync landed in the same whole second (refreshTime has 1s
# resolution, refreshInterval is 1h). The proof is now monotonic:
# refreshTime >= marker (second resolution) AND Ready.
#
# Run: bash scripts/ci/tests/externalsecret-refresh.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMPROOT="$(mktemp -d -t externalsecret-refresh.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

FAKEBIN="$TMPROOT/bin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
# args: -n <ns> get externalsecret <es> -o jsonpath=...   |   -n <ns> wait ...
if [ "${3:-}" = "get" ]; then
  printf '%s' "${FAKE_REFRESH_TIME:-}"
  exit 0
fi
if [ "${3:-}" = "wait" ]; then
  printf '%s\n' "$*" >> "${FAKE_KUBECTL_LOG:?}"
  exit "${FAKE_WAIT_RC:-0}"
fi
exit 1
EOF
chmod +x "$FAKEBIN/kubectl"
export PATH="$FAKEBIN:$PATH"
export FAKE_KUBECTL_LOG="$TMPROOT/kubectl.log"

# shellcheck source=../lib/externalsecret-refresh.sh
. "$REPO_ROOT/scripts/ci/lib/externalsecret-refresh.sh"

epoch_to_rfc3339() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

marker=1793695078
fail=0
expect() { # name expected-rc refreshTime [wait-rc]
  local name="$1" want="$2" rt="$3" wrc="${4:-0}" rc=0
  : > "$FAKE_KUBECTL_LOG"
  FAKE_REFRESH_TIME="$rt" FAKE_WAIT_RC="$wrc" \
    cogni_wait_externalsecret_refreshed cogni-production operator-env-secrets "$marker" 2 0 2>"$TMPROOT/err" || rc=$?
  if [ "$rc" != "$want" ]; then
    echo "FAIL $name: rc=$rc want=$want" >&2
    fail=1
  else
    echo "ok   $name (rc=$rc)"
  fi
}

# The production incident: refresh landed in the SAME second as the force-sync marker.
expect "equal-second refreshTime passes" 0 "$(epoch_to_rfc3339 "$marker")"
expect "later refreshTime passes" 0 "$(epoch_to_rfc3339 $((marker + 7)))"
expect "older refreshTime fails" 1 "$(epoch_to_rfc3339 $((marker - 1)))"
expect "long-stale refreshTime fails" 1 "1970-01-01T00:00:00Z"
expect "unset refreshTime fails" 1 ""
expect "unparseable refreshTime fails" 1 "refresh-3"
expect "advanced but not Ready fails" 1 "$(epoch_to_rfc3339 "$marker")" 1

# Ready is asserted only after the refresh advanced, against the same ExternalSecret.
: > "$FAKE_KUBECTL_LOG"
FAKE_REFRESH_TIME="$(epoch_to_rfc3339 "$marker")" \
  cogni_wait_externalsecret_refreshed cogni-production operator-env-secrets "$marker" 2 0
grep -q -- '-n cogni-production wait --for=condition=Ready externalsecret/operator-env-secrets' "$FAKE_KUBECTL_LOG" \
  || { echo "FAIL: Ready wait not issued after refresh" >&2; fail=1; }
FAKE_REFRESH_TIME="$(epoch_to_rfc3339 $((marker - 1)))" FAKE_WAIT_RC=0 \
  cogni_wait_externalsecret_refreshed cogni-production operator-env-secrets "$marker" 2 0 2>"$TMPROOT/err" || true
grep -q 'ExternalSecret refresh did not advance: operator-env-secrets' "$TMPROOT/err" \
  || { echo "FAIL: failure message lost" >&2; fail=1; }

[ "$fail" = 0 ] || exit 1
echo "externalsecret-refresh: all checks passed"
