#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=../lib/ssh-retry.sh
. scripts/ci/lib/ssh-retry.sh

TMPROOT="$(mktemp -d -t openbao-login-retry.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

# Keep the production backoff fixed; replace sleep only inside this hermetic test.
sleep() { :; }

fake_login() {
  local mode="$1" attempts_file="$2" attempt payload
  payload="$(cat)"
  if [ "$mode" = stdin_deadline ] && [ "$payload" != 'remote-script-sentinel' ]; then
    echo 'retry did not replay buffered stdin' >&2
    return 9
  fi
  attempt=0
  [ ! -f "$attempts_file" ] || attempt="$(cat "$attempts_file")"
  attempt=$((attempt + 1))
  printf '%s' "$attempt" >"$attempts_file"

  case "$mode:$attempt" in
    deadline:1|stdin_deadline:1)
      echo 'Error writing data to auth/kubernetes/login: context deadline exceeded' >&2
      return 2
      ;;
    permission_then_success:1|permission_stable:1|permission_stable:2)
      echo 'Error writing data to auth/kubernetes/login: Code: 403. permission denied' >&2
      return 2
      ;;
    permanent:1)
      echo 'Error writing data to auth/kubernetes/login: malformed role' >&2
      return 7
      ;;
    *)
      printf '%s' 'token-sentinel'
      ;;
  esac
}

# A k3s/OpenBao deadline is retried and the successful token remains stdout-only.
attempts="$TMPROOT/deadline-attempts"
token="$(cogni_openbao_kubernetes_login_retry fake_login deadline "$attempts" \
  2>"$TMPROOT/deadline.log")"
[ "$token" = 'token-sentinel' ]
[ "$(cat "$attempts")" = 2 ]
grep -q 'server_transient (attempt 1/3)' "$TMPROOT/deadline.log"
if grep -q 'token-sentinel' "$TMPROOT/deadline.log"; then
  echo 'successful OpenBao token leaked to retry logs' >&2
  exit 1
fi

# Remote assertion scripts arrive on stdin; the same bytes must replay on retry.
attempts="$TMPROOT/stdin-attempts"
token="$(printf '%s' 'remote-script-sentinel' | \
  cogni_openbao_kubernetes_login_retry fake_login stdin_deadline "$attempts" \
  2>"$TMPROOT/stdin.log")"
[ "$token" = 'token-sentinel' ]
[ "$(cat "$attempts")" = 2 ]

# The outage's transient 403 shape gets one fresh-JWT recheck and can recover.
attempts="$TMPROOT/permission-recovery-attempts"
token="$(cogni_openbao_kubernetes_login_retry fake_login permission_then_success "$attempts" \
  2>"$TMPROOT/permission-recovery.log")"
[ "$token" = 'token-sentinel' ]
[ "$(cat "$attempts")" = 2 ]
grep -q 'permission_denied_recheck (attempt 1/2)' "$TMPROOT/permission-recovery.log"

# A stable permission denial is NOT promoted to the longer transient retry class.
attempts="$TMPROOT/permission-stable-attempts"
set +e
cogni_openbao_kubernetes_login_retry fake_login permission_stable "$attempts" \
  >"$TMPROOT/permission-stable.out" 2>"$TMPROOT/permission-stable.log"
rc=$?
set -e
[ "$rc" -eq 2 ]
[ "$(cat "$attempts")" = 2 ]
grep -q 'permission denied' "$TMPROOT/permission-stable.log"
[ ! -s "$TMPROOT/permission-stable.out" ]

# Unknown/permanent auth failures retain their exit code and are never retried.
attempts="$TMPROOT/permanent-attempts"
set +e
cogni_openbao_kubernetes_login_retry fake_login permanent "$attempts" \
  >"$TMPROOT/permanent.out" 2>"$TMPROOT/permanent.log"
rc=$?
set -e
[ "$rc" -eq 7 ]
[ "$(cat "$attempts")" = 1 ]
grep -q 'malformed role' "$TMPROOT/permanent.log"

echo 'PASS: openbao-login-retry.test.sh'
