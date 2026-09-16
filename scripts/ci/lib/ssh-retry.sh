#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# bug.5159 — the env VM's sshd sheds connections under load (kex_exchange_identification
# reset during banner exchange), which killed 6 consecutive production promotes at random
# ssh calls. This wrapper retries ONLY transport-layer deaths (matched by the ssh client's
# own stderr signatures) up to 3 times with backoff; a REMOTE COMMAND's own nonzero exit
# passes through untouched, because those signatures never appear when the remote command
# merely fails. Stdin is buffered to a runner-local mktemp so piped payloads (e.g. the
# batched `bao kv patch -` JSON) replay identically on retry.
#
# Usage: source this lib, then
#   cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" <cmd...>
cogni_ssh_transport_retry() {
  local _stdin _err _rc _attempt
  _stdin="$(mktemp)" || return 1
  _err="$(mktemp)" || { rm -f "$_stdin"; return 1; }
  # In CI stdin is /dev/null (immediate EOF); interactively a tty is left unread.
  if [ ! -t 0 ]; then cat >"$_stdin"; fi
  _rc=255
  for _attempt in 1 2 3; do
    "$@" <"$_stdin" 2>"$_err"
    _rc=$?
    if [ "$_rc" -ne 0 ] && grep -qiE 'kex_exchange_identification|connection (reset|closed|refused|timed out)|broken pipe|banner exchange' "$_err"; then
      cat "$_err" >&2
      echo "[ssh-retry] transport failure (attempt ${_attempt}/3) — retrying" >&2
      # Jittered backoff: lockstep retries from parallel cells would re-collide at the
      # admission limit at the same instant.
      sleep $((_attempt * 5 + RANDOM % 5))
      continue
    fi
    break
  done
  cat "$_err" >&2
  rm -f "$_stdin" "$_err"
  return "$_rc"
}

# bug.5168 — OpenBao's Kubernetes auth depends on the local k3s API. During a
# short control-plane stall it has returned both context deadlines and a
# transient 403 before recovering with the same role/service-account binding.
# Retry only that login seam, never an arbitrary remote mutation:
#   - deadline/server/connection failures: at most 3 attempts;
#   - permission denied / 403: ONE fresh-JWT recheck, then fail loud. A durable
#     denial is likely role drift and must not be normalized into a long retry.
# Intermediate stderr is reduced to a stable reason code; the final original
# error is preserved. Successful stdout (the token) is emitted only to the
# caller's command substitution and is never logged here.
cogni_openbao_kubernetes_login_retry() {
  local _stdin _out _err _rc _attempt=1 _max_attempts=0 _reason="" _sleep_seconds
  _stdin="$(mktemp)" || return 1
  _out="$(mktemp)" || { rm -f "$_stdin"; return 1; }
  _err="$(mktemp)" || { rm -f "$_stdin" "$_out"; return 1; }
  # A caller may supply a remote script on stdin. Buffer it once so every
  # bounded retry executes the same input rather than succeeding on empty EOF.
  if [ ! -t 0 ]; then cat >"$_stdin"; fi

  while :; do
    : >"$_out"
    : >"$_err"
    if "$@" <"$_stdin" >"$_out" 2>"$_err"; then
      cat "$_out"
      rm -f "$_stdin" "$_out" "$_err"
      return 0
    else
      _rc=$?
    fi

    # Classify the first failure once so a later error cannot widen a bounded
    # permission-denied recheck into the longer transient-server retry class.
    if [ "$_max_attempts" -eq 0 ]; then
      if grep -qiE 'context deadline exceeded|i/o timeout|TLS handshake timeout|connection (refused|reset)|Code: (429|500|502|503|504)' "$_err"; then
        _reason="server_transient"
        _max_attempts=3
      elif grep -qiE 'Code: 403|permission denied' "$_err"; then
        _reason="permission_denied_recheck"
        _max_attempts=2
      else
        cat "$_err" >&2
        rm -f "$_stdin" "$_out" "$_err"
        return "$_rc"
      fi
    elif ! grep -qiE 'context deadline exceeded|i/o timeout|TLS handshake timeout|connection (refused|reset)|Code: (429|500|502|503|504)|Code: 403|permission denied' "$_err"; then
      cat "$_err" >&2
      rm -f "$_stdin" "$_out" "$_err"
      return "$_rc"
    fi

    if [ "$_attempt" -ge "$_max_attempts" ]; then
      cat "$_err" >&2
      rm -f "$_stdin" "$_out" "$_err"
      return "$_rc"
    fi

    # Parallel node promotions share one k3s/OpenBao endpoint. Jitter prevents
    # every failed cell from re-hitting it in lockstep after the same pause.
    _sleep_seconds=$((_attempt * 5 + RANDOM % 5))
    echo "[openbao-login-retry] ${_reason} (attempt ${_attempt}/${_max_attempts}); retrying in ${_sleep_seconds}s" >&2
    sleep "$_sleep_seconds"
    _attempt=$((_attempt + 1))
  done
}

# Pre-existing consumer contract (egress action + candidate-flight, #2108) — my #2246
# overwrote this file and dropped it; restored verbatim. Both helpers coexist:
# ci_ssh_retry wraps a full visible command (tee'd output, 255-only), while
# cogni_ssh_transport_retry buffers stdin/stderr for the substrate remote() wrappers.
ci_ssh_retry() {
  local attempt=1
  local max_attempts="${CI_SSH_RETRY_ATTEMPTS:-4}"
  local out_file rc sleep_seconds

  out_file=$(mktemp)
  trap 'rm -f "$out_file"' RETURN

  while [ "$attempt" -le "$max_attempts" ]; do
    : > "$out_file"
    set +e
    "$@" 2>&1 | tee "$out_file"
    rc=${PIPESTATUS[0]}
    set -e

    if [ "$rc" -eq 0 ]; then
      return 0
    fi

    if [ "$rc" -ne 255 ] ||
       ! grep -Eq 'kex_exchange_identification|Connection reset by peer' "$out_file"; then
      return "$rc"
    fi

    if [ "$attempt" -eq "$max_attempts" ]; then
      return "$rc"
    fi

    sleep_seconds=$((attempt * 3 + RANDOM % 4))
    echo "ssh transport reset; retrying in ${sleep_seconds}s (attempt ${attempt}/${max_attempts})" >&2
    sleep "$sleep_seconds"
    attempt=$((attempt + 1))
  done
}
