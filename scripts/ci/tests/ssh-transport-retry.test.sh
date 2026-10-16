#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Exercise the real helper under a caller's errexit, including buffered stdin replay.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cat > "$fixture/child.sh" <<'CHILD'
set -euo pipefail
source "$1/scripts/ci/lib/ssh-retry.sh"
fixture=$2
mode=$3
sleep() { :; }
fake_remote() {
  local attempt=0
  [[ ! -f "$fixture/attempts" ]] || attempt=$(cat "$fixture/attempts")
  attempt=$((attempt + 1))
  printf '%s' "$attempt" > "$fixture/attempts"
  cat > "$fixture/stdin.$attempt"
  case "$mode" in
    permanent) echo 'safe remote command failure' >&2; return 42 ;;
    transient)
      if [[ "$attempt" == 1 ]]; then
        echo 'Connection reset by peer' >&2
        return 255
      fi
      echo 'safe success'
      ;;
    exhausted) echo 'Connection reset by peer' >&2; return 255 ;;
  esac
}
# Keep this call unconditional: testing in an if/! list would suppress errexit.
cogni_ssh_transport_retry fake_remote
printf 'UNREACHABLE_AFTER_FAILURE\n'
CHILD
for mode in permanent transient exhausted; do
  mkdir -p "$fixture/$mode/tmp"
  if printf 'safe fixture payload\n' | TMPDIR="$fixture/$mode/tmp" \
    bash "$fixture/child.sh" "$repo_root" "$fixture/$mode" "$mode" \
      >"$fixture/$mode/stdout" 2>"$fixture/$mode/stderr"; then
    result=0
  else
    result=$?
  fi
  case "$mode" in
    permanent)
      [[ "$result" == 42 && "$(cat "$fixture/$mode/attempts")" == 1 ]]
      grep -qx 'safe remote command failure' "$fixture/$mode/stderr"
      [[ ! -s "$fixture/$mode/stdout" ]]
      ;;
    transient)
      [[ "$result" == 0 && "$(cat "$fixture/$mode/attempts")" == 2 ]]
      cmp "$fixture/$mode/stdin.1" "$fixture/$mode/stdin.2"
      grep -qx 'safe success' "$fixture/$mode/stdout"
      ;;
    exhausted)
      [[ "$result" == 255 && "$(cat "$fixture/$mode/attempts")" == 3 ]]
      grep -q 'Connection reset by peer' "$fixture/$mode/stderr"
      [[ ! -s "$fixture/$mode/stdout" ]]
      ;;
  esac
  [[ -z "$(ls -A "$fixture/$mode/tmp")" ]]
  echo "PASS $mode"
done
