#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT="$(mktemp -d -t verify-deployment.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

cat >"$TMPROOT/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

url="${*: -1}"
printf '%s\n' "$url" >> "${VERIFY_CURL_LOG:?}"
[[ " $* " == *" --connect-timeout 5 "* ]]
[[ " $* " == *" --max-time 10 "* ]]

case "$url" in
  https://preview.cognidao.org/readyz)
    printf '%s' "${VERIFY_READY_STATUS:-200}"
    ;;
  https://preview.cognidao.org/livez)
    [[ " $* " == *" --fail "* ]]
    [[ "${VERIFY_LIVE_HTTP_FAILURE:-false}" != true ]] || exit 22
    VERIFY_LIVE_BODY=${VERIFY_LIVE_BODY-'{"status":"alive"}'}
    printf '%s' "$VERIFY_LIVE_BODY"
    ;;
  *)
    printf 'unexpected curl target: %s\n' "$url" >&2
    exit 22
    ;;
esac
SH
chmod +x "$TMPROOT/curl"

export PATH="$TMPROOT:$PATH"
export VERIFY_CURL_LOG="$TMPROOT/curl.log"

DOMAIN=preview.cognidao.org \
PROMOTED_APPS=operator \
MAX_ATTEMPTS=1 \
SLEEP=0 \
  bash scripts/ci/verify-deployment.sh >"$TMPROOT/operator.out"

grep -q "operator healthy" "$TMPROOT/operator.out"
grep -q "node-template readyz — not in PROMOTED_APPS=operator" "$TMPROOT/operator.out"
[[ "$(wc -l <"$VERIFY_CURL_LOG" | tr -d ' ')" == "2" ]]
grep -qx "https://preview.cognidao.org/readyz" "$VERIFY_CURL_LOG"
grep -qx "https://preview.cognidao.org/livez" "$VERIFY_CURL_LOG"

: >"$VERIFY_CURL_LOG"
DOMAIN=preview.cognidao.org \
PROMOTED_APPS=scheduler-worker \
MAX_ATTEMPTS=1 \
SLEEP=0 \
  bash scripts/ci/verify-deployment.sh >"$TMPROOT/service-only.out"

grep -q "No node targets to verify" "$TMPROOT/service-only.out"
[[ ! -s "$VERIFY_CURL_LOG" ]]

: >"$VERIFY_CURL_LOG"
DOMAIN=preview.cognidao.org PROMOTED_APPS='' MAX_ATTEMPTS=1 SLEEP=0 \
  bash scripts/ci/verify-deployment.sh >"$TMPROOT/empty.out"
grep -q "No node targets to verify" "$TMPROOT/empty.out"
[[ ! -s "$VERIFY_CURL_LOG" ]]

if env -u PROMOTED_APPS DOMAIN=preview.cognidao.org \
  bash scripts/ci/verify-deployment.sh >"$TMPROOT/missing.out" 2>&1; then
  echo "FAIL: missing scope succeeded" >&2; exit 1
fi
grep -q "PROMOTED_APPS" "$TMPROOT/missing.out"
[[ ! -s "$VERIFY_CURL_LOG" ]]

for scope in unknown 'operator,unknown' 'operator,'; do
  if DOMAIN=preview.cognidao.org PROMOTED_APPS="$scope" MAX_ATTEMPTS=1 SLEEP=0 \
    bash scripts/ci/verify-deployment.sh >"$TMPROOT/invalid.out" 2>&1; then
    echo "FAIL: invalid scope succeeded: $scope" >&2; exit 1
  fi
  grep -q "Invalid promotion target" "$TMPROOT/invalid.out"
  [[ ! -s "$VERIFY_CURL_LOG" ]]
done

for body in '{"status":"degraded"}' '{"status":"alive"' '[]' 'null'; do
  if DOMAIN=preview.cognidao.org PROMOTED_APPS=operator VERIFY_LIVE_BODY="$body" \
    MAX_ATTEMPTS=1 SLEEP=0 bash scripts/ci/verify-deployment.sh >"$TMPROOT/bad-live.out" 2>&1; then
    echo "FAIL: invalid liveness succeeded: $body" >&2; exit 1
  fi
done

if DOMAIN=preview.cognidao.org PROMOTED_APPS=operator VERIFY_LIVE_HTTP_FAILURE=true \
  MAX_ATTEMPTS=1 SLEEP=0 bash scripts/ci/verify-deployment.sh >"$TMPROOT/http.out" 2>&1; then
  echo "FAIL: liveness HTTP error succeeded" >&2; exit 1
fi

if DOMAIN=preview.cognidao.org PROMOTED_APPS=operator VERIFY_READY_STATUS=503 \
  MAX_ATTEMPTS=1 SLEEP=0 bash scripts/ci/verify-deployment.sh >"$TMPROOT/not-ready.out" 2>&1; then
  echo "FAIL: failed readiness succeeded" >&2; exit 1
fi
grep -q "failed health check" "$TMPROOT/not-ready.out"

echo "PASS: verify-deployment.test.sh"
