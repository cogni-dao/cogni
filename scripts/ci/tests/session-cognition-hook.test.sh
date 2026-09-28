#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Hermetic regression for bug.5284: Codex must receive the complete bounded
# SessionStart bundle, and rerunning the legacy user-hook installer must
# reconcile (not duplicate) its config block.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOADER="$REPO_ROOT/scripts/agent/session-cognition.sh"
INSTALLER="$REPO_ROOT/scripts/agent/install-codex-cognition-hook.sh"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

fail() {
  echo "session-cognition-hook.test: $*" >&2
  exit 1
}

grep -Fq 'additionalContextLimit = 0' "$REPO_ROOT/.codex/config.toml" ||
  fail "project hook still uses Codex's truncating default"

mkdir -p "$FIXTURE_ROOT/small/.cogni" "$FIXTURE_ROOT/no-user-hooks"
printf '%s\n' 'complete cognition' >"$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
small_output="$({
  cd "$FIXTURE_ROOT/small"
  CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ "$small_output" == "complete cognition" ]] ||
  fail "bounded cached bundle was not presented verbatim"

mkdir "$FIXTURE_ROOT/cogni-cognition-lock-test.lock"
locked_output="$({
  cd "$FIXTURE_ROOT/small"
  TMPDIR="$FIXTURE_ROOT" CODEX_THREAD_ID="lock-test" \
    CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ -z "$locked_output" ]] ||
  fail "second concurrent presenter did not honor the per-thread lock"

mkdir -p "$FIXTURE_ROOT/large/.cogni"
head -c 17000 /dev/zero | tr '\0' x >"$FIXTURE_ROOT/large/.cogni/.cognition-cache.md"
large_output="$({
  cd "$FIXTURE_ROOT/large"
  CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ "$large_output" == *"bundle rejected before injection"* ]] ||
  fail "oversized cache did not fail closed"
[[ "$(printf '%s\n' "$large_output" | LC_ALL=C wc -c | tr -d '[:space:]')" -lt 1024 ]] ||
  fail "oversized cache leaked into hook stdout"

LEGACY_HOME="$FIXTURE_ROOT/legacy-codex"
LEGACY_HOOK="$LEGACY_HOME/hooks/cogni-session-cognition.sh"
mkdir -p "$LEGACY_HOME"
printf '%s\n' \
  'model = "gpt-5.5"' \
  '' \
  '[[hooks.SessionStart]]' \
  'matcher = "startup|resume"' \
  '' \
  '[[hooks.SessionStart.hooks]]' \
  'type = "command"' \
  'command = "echo keep-me"' \
  '' \
  '[[hooks.SessionStart.hooks]]' \
  'type = "command"' \
  "command = \"bash $LEGACY_HOOK\"" \
  'statusMessage = "Loading Cogni cognition substrate"' \
  '' \
  '[hooks.state]' >"$LEGACY_HOME/config.toml"

CODEX_HOME="$LEGACY_HOME" bash "$INSTALLER" >/dev/null
CODEX_HOME="$LEGACY_HOME" bash "$INSTALLER" >/dev/null

[[ "$(grep -Fc 'cogni-session-cognition.sh' "$LEGACY_HOME/config.toml")" -eq 1 ]] ||
  fail "installer duplicated the user-level hook"
grep -Fq 'command = "echo keep-me"' "$LEGACY_HOME/config.toml" ||
  fail "installer removed an unrelated SessionStart handler"
grep -Fq 'matcher = "startup|resume|clear|compact"' "$LEGACY_HOME/config.toml" ||
  fail "installer did not restore all SessionStart sources"
grep -Fq 'additionalContextLimit = 0' "$LEGACY_HOME/config.toml" ||
  fail "installer did not disable Codex spilling"
bash -n "$LEGACY_HOOK"

echo "session-cognition-hook.test: PASS"
