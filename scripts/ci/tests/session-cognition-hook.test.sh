#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Hermetic regressions for bug.5284, bug.5359, and story.5070: both runtimes must
# receive the COMPLETE SessionStart bundle at any size — Codex via raw stdout
# (spill disabled), Claude Code via structured hookSpecificOutput.additionalContext
# (raw stdout there is preview-capped to ~2KB) — with no byte ceiling to reject or
# truncate against. Tracked snapshots must never be presented as live cognition,
# and the stable user hook must stay reconciled.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOADER="$REPO_ROOT/scripts/agent/session-cognition.sh"
INSTALLER="$REPO_ROOT/scripts/agent/install-codex-cognition-hook.sh"
CONDUCTOR_SETUP="$REPO_ROOT/scripts/conductor-worktree-setup.sh"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

fail() {
  echo "session-cognition-hook.test: $*" >&2
  exit 1
}

# surfaced <hook-stdout> — the text the agent actually receives, regardless of
# which channel the loader used: Claude Code structured JSON additionalContext,
# or Codex raw stdout. Lets a content assertion stay channel-agnostic.
surfaced() {
  if printf '%s' "$1" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1; then
    printf '%s' "$1" | jq -j '.hookSpecificOutput.additionalContext'
  else
    printf '%s' "$1"
  fi
}

grep -Fq 'additionalContextLimit = 0' "$REPO_ROOT/.codex/config.toml" ||
  fail "project hook still uses Codex's truncating default"

grep -Fq "if [[ \"\${CONDUCTOR_IS_LOCAL:-1}\" == \"1\" ]]; then" "$CONDUCTOR_SETUP" ||
  fail "Conductor setup does not guard user-hook installation to local workspaces"
installer_line="$(grep -nF 'bash scripts/agent/install-codex-cognition-hook.sh' "$CONDUCTOR_SETUP" | cut -d: -f1)"
dependency_line="$(grep -nF 'pnpm install --offline --frozen-lockfile' "$CONDUCTOR_SETUP" | cut -d: -f1)"
[[ -n "$installer_line" && -n "$dependency_line" && "$installer_line" -lt "$dependency_line" ]] ||
  fail "Conductor setup does not reconcile the user hook before dependency install"

TRACKED_ROOT="$FIXTURE_ROOT/tracked"
TRACKED_CACHE="$TRACKED_ROOT/.cogni/.cognition-cache.md"
FAKE_BIN="$FIXTURE_ROOT/bin"
mkdir -p "$TRACKED_ROOT/.cogni" "$FAKE_BIN"
printf '%s\n' 'intent:' '  name: operator' >"$TRACKED_ROOT/.cogni/repo-spec.yaml"
printf '%s\n' 'stale committed cognition' >"$TRACKED_CACHE"
git -C "$TRACKED_ROOT" init -q
git -C "$TRACKED_ROOT" add .cogni/.cognition-cache.md
printf '%s\n' \
  '#!/bin/sh' \
  "printf '%s\\n' '{\"markdown\":\"live cognition\"}'" >"$FAKE_BIN/curl"
chmod +x "$FAKE_BIN/curl"

tracked_output="$({
  cd "$TRACKED_ROOT"
  PATH="$FAKE_BIN:$PATH" CODEX_THREAD_ID="" COGNI_NODE_API_KEY="test-key" \
    CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
# CODEX_THREAD_ID="" ⇒ Claude Code path ⇒ structured JSON channel.
printf '%s' "$tracked_output" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1 ||
  fail "Claude Code path did not surface via the additionalContext channel"
[[ "$(surfaced "$tracked_output")" == "live cognition" ]] ||
  fail "project loader presented a git-tracked cognition snapshot"
[[ "$(cat "$TRACKED_CACHE")" == "live cognition" ]] ||
  fail "project loader did not replace the tracked snapshot with live cognition"

mkdir -p "$FIXTURE_ROOT/small/.cogni" "$FIXTURE_ROOT/no-user-hooks"
printf '%s\n' 'complete cognition' >"$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
small_output="$({
  cd "$FIXTURE_ROOT/small"
  CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ "$(surfaced "$small_output")" == "complete cognition" ]] ||
  fail "cached bundle was not surfaced verbatim (Claude Code path)"

# Codex path: raw stdout verbatim (Codex disables its spill via additionalContextLimit=0).
mkdir -p "$FIXTURE_ROOT/codex-tmp"
codex_output="$({
  cd "$FIXTURE_ROOT/small"
  CODEX_THREAD_ID="codex-raw" TMPDIR="$FIXTURE_ROOT/codex-tmp" \
    CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ "$codex_output" == "complete cognition" ]] ||
  fail "Codex path did not present raw stdout verbatim"

mkdir "$FIXTURE_ROOT/cogni-cognition-lock-test.lock"
locked_output="$({
  cd "$FIXTURE_ROOT/small"
  TMPDIR="$FIXTURE_ROOT" CODEX_THREAD_ID="lock-test" \
    CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ -z "$locked_output" ]] ||
  fail "second concurrent presenter did not honor the per-thread lock"

# story.5070 regression: a large bundle must surface WHOLE through the Claude Code
# structured channel — never truncated or rejected by a byte ceiling. This is the
# assertion the original bug.5284 ceiling got backwards.
mkdir -p "$FIXTURE_ROOT/large/.cogni"
head -c 17000 /dev/zero | tr '\0' x >"$FIXTURE_ROOT/large/.cogni/.cognition-cache.md"
large_output="$({
  cd "$FIXTURE_ROOT/large"
  CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
printf '%s' "$large_output" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1 ||
  fail "large bundle was not surfaced via the Claude Code additionalContext channel"
large_surfaced="$(surfaced "$large_output")"
[[ "${#large_surfaced}" -eq 17000 ]] ||
  fail "large bundle truncated or rejected (surfaced ${#large_surfaced} of 17000 bytes)"

LEGACY_HOME="$FIXTURE_ROOT/legacy-codex"
LEGACY_HOOK="$LEGACY_HOME/hooks/cogni-session-cognition.sh"
LEGACY_REFRESH="$LEGACY_HOME/hooks/cogni-refresh-agent-credential.sh"
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
grep -Fq 'cache_is_repo_tracked()' "$LEGACY_HOOK" ||
  fail "installed user hook omitted the tracked-cache guard"
[[ -x "$LEGACY_REFRESH" ]] ||
  fail "installer omitted the user-owned credential refresh helper"
grep -Fq '"$CREDENTIAL_REFRESH" "$repo_root/.env.cogni" "$api_base"' "$LEGACY_HOOK" ||
  fail "installed user hook does not refresh credentials before fetching"
grep -Fq "if [[ -s \"\$CACHE_FILE\" ]] && ! cache_is_repo_tracked; then" "$LEGACY_HOOK" ||
  fail "installed user hook does not reject a tracked cache"
bash -n "$LEGACY_HOOK"

printf '%s\n' 'stale committed cognition' >"$TRACKED_CACHE"
installed_output="$({
  cd "$TRACKED_ROOT"
  PATH="$FAKE_BIN:$PATH" CODEX_THREAD_ID="" COGNI_NODE_API_KEY="test-key" \
    CODEX_HOME="$LEGACY_HOME" bash "$LEGACY_HOOK"
})"
[[ "$installed_output" == "live cognition" ]] ||
  fail "installed user hook presented a git-tracked cognition snapshot"
[[ "$(cat "$TRACKED_CACHE")" == "live cognition" ]] ||
  fail "installed user hook did not replace the tracked snapshot with live cognition"

echo "session-cognition-hook.test: PASS"
