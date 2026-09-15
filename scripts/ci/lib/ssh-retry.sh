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
