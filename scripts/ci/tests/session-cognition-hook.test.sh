#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Hermetic regressions for bug.5284, bug.5359, and story.5070: Codex receives the
# COMPLETE bundle through hook stdout with spill disabled; Claude Code's hook is
# write-only because AGENTS.md owns presentation through the file channel. Tracked
# snapshots must never be presented as live cognition, and the stable user hook
# must stay reconciled.

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

grep -Fq 'additionalContextLimit = 0' "$REPO_ROOT/.codex/config.toml" ||
  fail "project hook still uses Codex's truncating default"
grep -Fq 'Every human-facing reply, including answers and follow-ups, is exactly this skeleton' \
  "$REPO_ROOT/AGENTS.md" || fail "root AGENTS.md omitted the universal response floor"
grep -Fq 'reproduce `Goal` and `Done when` byte-for-byte' "$REPO_ROOT/AGENTS.md" ||
  fail "root AGENTS.md omitted immutable session state"
[[ "$(jq -r '.instructions[0]' "$REPO_ROOT/opencode.json")" == ".cogni/.cognition-cache.md" ]] ||
  fail "OpenCode project config omitted automatic cognition instructions"
[[ "$(jq -r '.outputStyle' "$REPO_ROOT/.claude/settings.json")" == "Cogni Contract" ]] ||
  fail "Claude Code project settings omitted the Cogni Contract output style"
OUTPUT_STYLE="$REPO_ROOT/.claude/output-styles/Cogni Contract.md"
[[ -f "$OUTPUT_STYLE" ]] || fail "Claude Code Cogni Contract output style is missing"
grep -Fq 'This response protocol has no task-type exceptions' "$OUTPUT_STYLE" ||
  fail "Claude Code output style permits task-type formatting exceptions"
grep -Fq 'preserve Goal and Done when byte-for-byte' "$OUTPUT_STYLE" ||
  fail "Claude Code output style omitted immutable session state"
STOP_VALIDATOR="$REPO_ROOT/scripts/agent/validate-status-contract.sh"
[[ -x "$STOP_VALIDATOR" ]] || fail "Claude Code status-contract Stop hook is not executable"
jq -e '.hooks.Stop[0].hooks[0].command | contains("validate-status-contract.sh")' \
  "$REPO_ROOT/.claude/settings.json" >/dev/null ||
  fail "Claude Code settings omitted the status-contract Stop hook"

VALID_MESSAGE='| 🎯 **Goal** | Keep contract state |
|---|---|
| **Done when** | Two turns preserve exact fields. |
| **Status** | 🔵 testing |
| **ETA · Conf** | 1 minute · 90% + reviewed 3/3 sources |
| **Followed** | https://cognidao.org/knowledge/cognition-substrate-bootstrap · https://github.com/cogni-dao/cogni/blob/main/docs/spec/node-baas-architecture.md · https://cognidao.org/work/items/story.5070 |

---

| item | owner | deliverable links | status | next |
|---|---|---|---|---|
| proposed story — contract | dev-manager, me | - | 🔵 in progress | Test next turn |

> 🔵 **Bottom line —** Contract-shaped response.'
VALIDATOR_SCRATCH="$FIXTURE_ROOT/validator-scratch"
mkdir -p "$VALIDATOR_SCRATCH"
valid_output="$(jq -cn --arg message "$VALID_MESSAGE" --arg scratch "$VALIDATOR_SCRATCH" \
  '{last_assistant_message:$message,scratchpad_dir:$scratch}' | bash "$STOP_VALIDATOR")"
[[ -z "$valid_output" ]] || fail "status-contract Stop hook rejected a valid response"

invalid_output="$(jq -cn --arg message 'This is a design question, so the contract does not apply.' \
  --arg scratch "$VALIDATOR_SCRATCH" '{last_assistant_message:$message,scratchpad_dir:$scratch}' | \
  bash "$STOP_VALIDATOR")"
[[ "$(printf '%s' "$invalid_output" | jq -r '.decision')" == "block" ]] ||
  fail "status-contract Stop hook accepted prose outside the contract block"

MUTATED_MESSAGE="${VALID_MESSAGE/Keep contract state/Change contract state}"
mutated_output="$(jq -cn --arg message "$MUTATED_MESSAGE" --arg scratch "$VALIDATOR_SCRATCH" \
  '{last_assistant_message:$message,scratchpad_dir:$scratch}' | bash "$STOP_VALIDATOR")"
[[ "$(printf '%s' "$mutated_output" | jq -r '.decision')" == "block" ]] ||
  fail "status-contract Stop hook accepted mutated Goal state"

ZERO_RESEARCH_MESSAGE='| 🎯 **Goal** | Design a strategy agent |
|---|---|
| **Done when** | Design is approved. |
| **Status** | 🟡 proposed |
| **ETA · Conf** | 2 hours · 40% + reviewed 0/5 sources |
| **Followed** | — |

---

| item | owner | deliverable links | status | next |
|---|---|---|---|---|
| proposed story — strategy | dev-manager, me | - | 👉 needs you | 👉 needs you: approve scope |

> 👉 **Bottom line —** Approve the proposal.'
zero_research_output="$(jq -cn --arg message "$ZERO_RESEARCH_MESSAGE" \
  '{last_assistant_message:$message}' | bash "$STOP_VALIDATOR")"
[[ "$(printf '%s' "$zero_research_output" | jq -r '.decision')" == "block" ]] ||
  fail "status-contract Stop hook accepted a substantive zero-research proposal"

PRELIMINARY_STOP_MESSAGE='| 🎯 **Goal** | — |
|---|---|
| **Done when** | — |
| **Status** | — |
| **ETA · Conf** | — · 0% + reviewed 0/5 sources |
| **Followed** | — |

---

| item | owner | deliverable links | status | next |
|---|---|---|---|---|
| proposed story — strategy | dev-manager, me | - | 🔵 in progress | Research relevant sources |

> 🔵 **Bottom line —** Researching the existing substrate.'
preliminary_stop_output="$(jq -cn --arg message "$PRELIMINARY_STOP_MESSAGE" \
  '{last_assistant_message:$message}' | bash "$STOP_VALIDATOR")"
[[ "$(printf '%s' "$preliminary_stop_output" | jq -r '.decision')" == "block" ]] ||
  fail "status-contract Stop hook allowed an agent-owned preliminary state to become a final reply"

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
# CODEX_THREAD_ID="" ⇒ Claude Code path ⇒ refresh cache without hook output.
[[ -z "$tracked_output" ]] ||
  fail "Claude Code hook emitted duplicate cognition instead of staying write-only"
[[ "$(cat "$TRACKED_CACHE")" == "live cognition" ]] ||
  fail "project loader did not replace the tracked snapshot with live cognition"

mkdir -p "$FIXTURE_ROOT/small/.cogni" "$FIXTURE_ROOT/no-user-hooks"
printf '%s\n' 'complete cognition' >"$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
small_output="$({
  cd "$FIXTURE_ROOT/small"
  CODEX_THREAD_ID="" CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ -z "$small_output" ]] ||
  fail "Claude Code cached path emitted duplicate cognition"

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

# story.5070 regression: a large cached bundle remains intact while Claude Code's
# hook stays write-only. AGENTS.md owns presentation through its file import.
mkdir -p "$FIXTURE_ROOT/large/.cogni"
head -c 17000 /dev/zero | tr '\0' x >"$FIXTURE_ROOT/large/.cogni/.cognition-cache.md"
large_output="$({
  cd "$FIXTURE_ROOT/large"
  CODEX_THREAD_ID="" CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" bash "$LOADER"
})"
[[ -z "$large_output" ]] ||
  fail "large Claude Code bundle leaked through duplicate hook output"
[[ "$(wc -c <"$FIXTURE_ROOT/large/.cogni/.cognition-cache.md" | tr -d ' ')" -eq 17000 ]] ||
  fail "large cached bundle was mutated"

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
grep -Fq 'cache_is_repo_tracked()' "$LEGACY_HOOK" ||
  fail "installed user hook omitted the tracked-cache guard"
grep -Fq "if [[ -s \"\$CACHE_FILE\" ]] && ! cache_is_repo_tracked; then" "$LEGACY_HOOK" ||
  fail "installed user hook does not reject a tracked cache"
bash -n "$LEGACY_HOOK"

printf '%s\n' 'stale committed cognition' >"$TRACKED_CACHE"
installed_output="$({
  cd "$TRACKED_ROOT"
  mkdir -p "$FIXTURE_ROOT/installed-codex-tmp"
  PATH="$FAKE_BIN:$PATH" CODEX_THREAD_ID="installed-codex" \
    TMPDIR="$FIXTURE_ROOT/installed-codex-tmp" COGNI_NODE_API_KEY="test-key" \
    CODEX_HOME="$LEGACY_HOME" bash "$LEGACY_HOOK"
})"
[[ "$installed_output" == "live cognition" ]] ||
  fail "installed Codex hook did not present refreshed cognition"
[[ "$(cat "$TRACKED_CACHE")" == "live cognition" ]] ||
  fail "installed user hook did not replace the tracked snapshot with live cognition"

echo "session-cognition-hook.test: PASS"
