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

case "$url" in
  https://preview.cognidao.org/readyz)
    printf '200'
    ;;
  https://preview.cognidao.org/livez)
    printf '{"status":"ok"}'
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
grep -q "oss readyz — not in PROMOTED_APPS=operator" "$TMPROOT/operator.out"
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

echo "PASS: verify-deployment.test.sh"
