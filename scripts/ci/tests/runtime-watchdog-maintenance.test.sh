#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Exercise the normal deployment maintenance phase without Docker or credentials.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
phase="$(awk '/^stop_runtime_watchdog\(\) \{/ { capture=1 } capture { print } capture && /^fi$/ { exit }' scripts/ci/deploy-infra.sh)"
[[ -n "$phase" ]]
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
export WATCHDOG_TEST_LOG="$probe/log"
docker() {
  printf '%s\n' "$*" >> "$WATCHDOG_TEST_LOG"
  case "$1" in
    ps) printf '%s' "${WATCHDOG_TEST_IDS:-}" ;;
    inspect) printf '%s' "${WATCHDOG_TEST_METADATA:-cogni-runtime|autoheal|/opt/cogni-template-runtime}" ;;
    stop) return "${WATCHDOG_TEST_STOP_RC:-0}" ;;
    *) return 90 ;;
  esac
}
timeout() { shift; "$@"; }
export -f docker timeout
run_phase() { : > "$WATCHDOG_TEST_LOG"; bash -euc "$phase"; }
export WATCHDOG_TEST_IDS=''
run_phase
[[ "$(wc -l < "$WATCHDOG_TEST_LOG")" -eq 1 ]]
export WATCHDOG_TEST_IDS=$'abc123\ndef456'
if run_phase 2>"$probe/error"; then exit 1; fi
grep -q ambiguous "$probe/error"
! grep -q '^stop ' "$WATCHDOG_TEST_LOG"
export WATCHDOG_TEST_IDS=abc123 WATCHDOG_TEST_METADATA='wrong|autoheal|/opt/cogni-template-runtime'
if run_phase 2>"$probe/error"; then exit 1; fi
grep -q mismatch "$probe/error"
! grep -q '^stop ' "$WATCHDOG_TEST_LOG"
export WATCHDOG_TEST_METADATA='cogni-runtime|autoheal|/wrong'
if run_phase 2>"$probe/error"; then exit 1; fi
! grep -q '^stop ' "$WATCHDOG_TEST_LOG"
export WATCHDOG_TEST_METADATA='cogni-runtime|autoheal|/opt/cogni-template-runtime'
run_phase
grep -qx 'stop --time 15 abc123' "$WATCHDOG_TEST_LOG"
! grep -Eq 'postgres|compose |start|restart' "$WATCHDOG_TEST_LOG"
export WATCHDOG_TEST_STOP_RC=7
if run_phase; then exit 1; fi
export WATCHDOG_TEST_STOP_RC=0 K8S_SECRETS_ONLY=true
run_phase
[[ ! -s "$WATCHDOG_TEST_LOG" ]]
echo 'runtime-watchdog-maintenance: exact owned target only; mismatches fail closed; bridge-only untouched'
