#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Hermetic regressions for bug.5284, bug.5359, and story.5070: Codex receives the
# COMPLETE bundle through hook stdout with spill disabled; Claude Code's hook is
# write-only because CLAUDE.md owns presentation through the file channel. Supported
# OpenCode 1.x uses its native automatic instruction adapter and never asks the agent
# to read the cache. Tracked snapshots must never be presented as live cognition, and the stable
# user hook must stay reconciled.

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

FAKE_BIN="$FIXTURE_ROOT/bin"
FAKE_RESPONSE="$FIXTURE_ROOT/response.json"
FAKE_CALLS="$FIXTURE_ROOT/curl-calls"
mkdir -p "$FAKE_BIN" "$FIXTURE_ROOT/no-user-hooks"
cat >"$FAKE_BIN/curl" <<'CURL'
#!/bin/sh
printf '%s\n' call >> "$FAKE_CALLS"
if [ -n "${FAKE_FETCH_WAIT:-}" ]; then
  touch "${FAKE_FETCH_WAIT}.ready"
  attempts=0
  until [ -f "${FAKE_FETCH_WAIT}.release" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 500 ] || exit 28
    sleep 0.01
  done
fi
[ "${FAKE_CURL_FAIL:-0}" = 0 ] || exit 22
cat "$FAKE_RESPONSE"
CURL
chmod +x "$FAKE_BIN/curl"
export FAKE_RESPONSE FAKE_CALLS
# Keep the generic user hook from linking real workspace credentials into fixtures.
export COGNI_NODE_AUTH_ROOT="$FIXTURE_ROOT/no-auth"
# All fixtures are offline: every loader fetch reaches this deterministic stub.
export PATH="$FAKE_BIN:$PATH"

respond_with() {
  jq -cn --arg markdown "$1" '{markdown:$markdown}' >"$FAKE_RESPONSE"
}
respond_with ''
: >"$FAKE_CALLS"

grep -Fq 'additionalContextLimit = 0' "$REPO_ROOT/.codex/config.toml" ||
  fail "project hook still uses Codex's truncating default"
grep -Fq 'session-cognition.sh" --codex' "$REPO_ROOT/.codex/config.toml" ||
  fail "project hook does not explicitly select the Codex adapter"
# Normal communication has one owner: the complete cognition bundle. Bootstrap
# and harness adapters must not grow another response template or state protocol.
OUTPUT_STYLE="$REPO_ROOT/.claude/output-styles/Cogni Contract.md"
for pointer in "$REPO_ROOT/AGENTS.md" "$OUTPUT_STYLE"; do
  ! grep -Eq '^ *\|.*\|' "$pointer" || fail "$pointer duplicates a response table"
  ! grep -Eq 'AGENTS.md owns the shape|exactly this skeleton|byte-for-byte|three legal.stop states|5m.?4h' \
    "$pointer" || fail "$pointer defines competing normal communication rules"
  grep -Fq 'bounded bootstrap recovery' "$pointer" ||
    fail "$pointer omitted missing-contract recovery"
done
grep -Fq 'including the exact response format' "$REPO_ROOT/AGENTS.md" ||
  fail "AGENTS.md does not defer normal response format to cognition"
! grep -Fq '@.cogni/.cognition-cache.md' "$REPO_ROOT/AGENTS.md" ||
  fail "universal AGENTS.md exposes a Claude-only import directive"
[[ ! -L "$REPO_ROOT/CLAUDE.md" ]] ||
  fail "CLAUDE.md must own its harness-specific imports, not symlink AGENTS.md"
grep -Fxq '@AGENTS.md' "$REPO_ROOT/CLAUDE.md" ||
  fail "CLAUDE.md omitted the universal root floor import"
grep -Fxq '@.cogni/.cognition-cache.md' "$REPO_ROOT/CLAUDE.md" ||
  fail "CLAUDE.md omitted the automatic rich-cognition import"
[[ "$(jq -r '.instructions[0]' "$REPO_ROOT/opencode.json")" == ".cogni/.cognition-cache.md" ]] ||
  fail "OpenCode 1.x config omitted automatic cognition instructions"
[[ "$(jq -r '.outputStyle' "$REPO_ROOT/.claude/settings.json")" == "Cogni Contract" ]] ||
  fail "Claude Code project settings omitted the Cogni Contract output style"
OUTPUT_STYLE="$REPO_ROOT/.claude/output-styles/Cogni Contract.md"
[[ -f "$OUTPUT_STYLE" ]] || fail "Claude Code Cogni Contract output style is missing"
grep -Fq 'Follow the complete agent-contract delivered in the session cognition bundle' "$OUTPUT_STYLE" ||
  fail "Claude output style does not defer to the loaded bundle"
STOP_VALIDATOR="$REPO_ROOT/scripts/agent/validate-status-contract.sh"
[[ -x "$STOP_VALIDATOR" ]] || fail "Claude Code status-contract Stop hook is not executable"
jq -e '.hooks.Stop[0].hooks[0].command | contains("validate-status-contract.sh")' \
  "$REPO_ROOT/.claude/settings.json" >/dev/null ||
  fail "Claude Code settings omitted the status-contract Stop hook"

VALID_MESSAGE='| 🎯 **Goal** | Keep contract state |
|---|---|
| **Done when** | Two turns preserve exact fields. |
| **Status** | 🔵 in progress |
| **ETA · Conf** | 10m · earned 90% + reviewed 3/3 sources |
| **Followed** | https://cognidao.org/knowledge/cognition-substrate-bootstrap · https://github.com/cogni-dao/cogni/blob/main/AGENTS.md · https://cognidao.org/knowledge/node-baas-substrate-model · https://cognidao.org/work/items/story.5070 |

---

| item | owner | deliverable links | status | ETA · Conf | next |
|---|---|---|---|---|---|
| proposed story — contract | dev-manager, me | - | 🔵 in progress | 10m · earned 90% | Test next turn |

> 🔵 **Bottom line —** Contract-shaped response.'
VALIDATOR_ROOT="$FIXTURE_ROOT/validator"
mkdir -p "$VALIDATOR_ROOT/.cogni"
git -C "$VALIDATOR_ROOT" init -q
write_validator_contract() {
  {
    printf '%s\n' '## The agent-contract' '<agent-contract>' '<process-contract>' \
      'Research the assigned task and prove behavior.' '</process-contract>' '<status-contract>'
    printf '%s\n' "$1"
    printf '%s\n' '</status-contract>' '</agent-contract>'
  } >"$VALIDATOR_ROOT/.cogni/.cognition-cache.md"
}
run_validator() {
  (cd "$VALIDATOR_ROOT" && bash "$STOP_VALIDATOR")
}
write_validator_contract "$VALID_MESSAGE"
VALIDATOR_SCRATCH="$FIXTURE_ROOT/validator-scratch"
mkdir -p "$VALIDATOR_SCRATCH"
valid_output="$(jq -cn --arg message "$VALID_MESSAGE" --arg scratch "$VALIDATOR_SCRATCH" \
  '{last_assistant_message:$message,scratchpad_dir:$scratch}' | run_validator)"
[[ -z "$valid_output" ]] || fail "status-contract Stop hook rejected a valid response"

invalid_output="$(jq -cn --arg message 'This is a design question, so the contract does not apply.' \
  --arg scratch "$VALIDATOR_SCRATCH" '{last_assistant_message:$message,scratchpad_dir:$scratch}' | \
  run_validator)"
# Warn-only contract: a breach surfaces as a non-blocking advisory (systemMessage), never decision:block.
[[ -n "$(printf '%s' "$invalid_output" | jq -r '.systemMessage // empty')" &&
   -z "$(printf '%s' "$invalid_output" | jq -r '.decision // empty')" ]] ||
  fail "status-contract Stop hook did not warn (non-blocking) on prose outside the contract block"

MUTATED_MESSAGE="${VALID_MESSAGE/Keep contract state/Change contract state}"
mutated_output="$(jq -cn --arg message "$MUTATED_MESSAGE" --arg scratch "$VALIDATOR_SCRATCH" \
  '{last_assistant_message:$message,scratchpad_dir:$scratch}' | run_validator)"
[[ -n "$(printf '%s' "$mutated_output" | jq -r '.systemMessage // empty')" &&
   -z "$(printf '%s' "$mutated_output" | jq -r '.decision // empty')" ]] ||
  fail "status-contract Stop hook did not warn (non-blocking) on mutated Goal state"

ZERO_RESEARCH_MESSAGE='| 🎯 **Goal** | Design a strategy agent |
|---|---|
| **Done when** | Design is approved. |
| **Status** | 👉 needs you |
| **ETA · Conf** | 2h · earned 40% + reviewed 0/5 sources |
| **Followed** | — |

---

| item | owner | deliverable links | status | ETA · Conf | next |
|---|---|---|---|---|---|
| proposed story — strategy | dev-manager, me | - | 👉 needs you | 15m · earned 40% | 👉 needs you: [approve scope](https://cognidao.org/work/items/story.5070) |

> 👉 **Bottom line —** Approve the proposal.'
zero_research_output="$(jq -cn --arg message "$ZERO_RESEARCH_MESSAGE" \
  '{last_assistant_message:$message}' | run_validator)"
[[ -n "$(printf '%s' "$zero_research_output" | jq -r '.systemMessage // empty')" &&
   -z "$(printf '%s' "$zero_research_output" | jq -r '.decision // empty')" ]] ||
  fail "status-contract Stop hook did not warn (non-blocking) on a substantive zero-research proposal"

PRELIMINARY_STOP_MESSAGE='| 🎯 **Goal** | — |
|---|---|
| **Done when** | — |
| **Status** | — |
| **ETA · Conf** | — · 0% + reviewed 0/5 sources |
| **Followed** | — |

---

| item | owner | deliverable links | status | ETA · Conf | next |
|---|---|---|---|---|---|
| proposed story — strategy | dev-manager, me | - | 🔵 in progress | 15m · earned 20% | Research relevant sources |

> 🔵 **Bottom line —** Researching the existing substrate.'
preliminary_stop_output="$(jq -cn --arg message "$PRELIMINARY_STOP_MESSAGE" \
  '{last_assistant_message:$message}' | run_validator)"
[[ -n "$(printf '%s' "$preliminary_stop_output" | jq -r '.systemMessage // empty')" &&
   -z "$(printf '%s' "$preliminary_stop_output" | jq -r '.decision // empty')" ]] ||
  fail "status-contract Stop hook did not warn (non-blocking) on an agent-owned preliminary state as a final reply"

# The detector follows the admitted template rather than owning a six-column
# header. A complete older five-column contract remains valid offline.
FIVE_MESSAGE="${VALID_MESSAGE/| status | ETA · Conf | next |/| status | next |}"
FIVE_MESSAGE="${FIVE_MESSAGE/|---|---|---|---|---|---|/|---|---|---|---|---|}"
FIVE_MESSAGE="${FIVE_MESSAGE/| 🔵 in progress | 10m · earned 90% | Test next turn |/| 🔵 in progress | Test next turn |}"
write_validator_contract "$FIVE_MESSAGE"
five_output="$(jq -cn --arg message "$FIVE_MESSAGE" '{last_assistant_message:$message}' | run_validator)"
[[ -z "$five_output" ]] || fail "detector rejected its admitted five-column template"
wrong_six="$(jq -cn --arg message "$VALID_MESSAGE" '{last_assistant_message:$message}' | run_validator)"
[[ -n "$(printf '%s' "$wrong_six" | jq -r '.systemMessage // empty')" &&
   -z "$(printf '%s' "$wrong_six" | jq -r '.decision // empty')" ]] ||
  fail "detector ignored a column mismatch against the admitted five-column template"
FIVE_GATE="${PRELIMINARY_STOP_MESSAGE/| status | ETA · Conf | next |/| status | next |}"
FIVE_GATE="${FIVE_GATE/|---|---|---|---|---|---|/|---|---|---|---|---|}"
FIVE_GATE="${FIVE_GATE/| 🔵 in progress | 15m · earned 20% | Research relevant sources |/| 👀 watching | 👀 [watch gate](https://cognidao.org/work/items/story.5070) |}"
five_gate_output="$(jq -cn --arg message "$FIVE_GATE" '{last_assistant_message:$message}' | run_validator)"
[[ -z "$five_gate_output" ]] || fail "detector used a fixed next-column index for a five-column contract"
# No complete contract means no normal-template rewrite advice. A clearly marked
# recovery notice is also exempt when the cache warmed after Claude's import.
rm -f "$VALIDATOR_ROOT/.cogni/.cognition-cache.md"
no_contract_output="$(jq -cn --arg message 'Cognition is unavailable; recovering delivery.' '{last_assistant_message:$message}' | run_validator)"
[[ -z "$no_contract_output" ]] || fail "detector invented normal-template advice without a contract"
write_validator_contract "$VALID_MESSAGE"
recovery_output="$(jq -cn --arg message 'COGNI COGNITION — BOOTSTRAP RECOVERY: restart after warming the cache.' '{last_assistant_message:$message}' | run_validator)"
[[ -z "$recovery_output" ]] || fail "detector graded a marked bootstrap recovery notice as normal work"

grep -Fq "if [[ \"\${CONDUCTOR_IS_LOCAL:-1}\" == \"1\" ]]; then" "$CONDUCTOR_SETUP" ||
  fail "Conductor setup does not guard user-hook installation to local workspaces"
installer_line="$(grep -nF 'bash scripts/agent/install-codex-cognition-hook.sh' "$CONDUCTOR_SETUP" | cut -d: -f1)"
dependency_line="$(grep -nF 'pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile' "$CONDUCTOR_SETUP" | cut -d: -f1)"
[[ -n "$installer_line" && -n "$dependency_line" && "$installer_line" -lt "$dependency_line" ]] ||
  fail "Conductor setup does not reconcile the user hook before dependency install"

# Synthetic complete bundle: generic tables deliberately avoid production field
# labels/column counts so the loader cannot become another response-template owner.
COMPLETE_BUNDLE='# Test node cognition

## The agent-contract

<agent-contract rule="operate from one complete contract">
<process-contract rule="research and prove">
Research the assigned work and prove its observable result.
</process-contract>
<status-contract rule="response template and semantics">
| summary | value |
| --- | --- |
| objective | measurable behavior |

| work | responsibility | gate |
| --- | --- | --- |
| linked item | assigned agent | next proof |

> State the result concisely.
</status-contract>
</agent-contract>

## Skills index
Recall relevant skills.'
SEMANTICS_ONLY='# Map with an incomplete contract
## The agent-contract
<agent-contract>
<process-contract>
Research and prove.
</process-contract>
<status-contract>
Use the skeleton in AGENTS.md. Preserve goals and evidence.
</status-contract>
</agent-contract>'
MAP_ONLY='# Node cognition
## Skills index
Read the relevant skill.'
TRUNCATED_BUNDLE="${COMPLETE_BUNDLE%</status-contract>*}"
EMPTY_PROCESS="${COMPLETE_BUNDLE/Research the assigned work and prove its observable result./}"
MALFORMED_TABLE="${COMPLETE_BUNDLE/| work | responsibility | gate |/| missing | columns |}"

respond_with "$COMPLETE_BUNDLE"

TRACKED_ROOT="$FIXTURE_ROOT/tracked"
TRACKED_CACHE="$TRACKED_ROOT/.cogni/.cognition-cache.md"
mkdir -p "$TRACKED_ROOT/.cogni"
printf '%s\n' 'intent:' '  name: operator' >"$TRACKED_ROOT/.cogni/repo-spec.yaml"
printf '%s\n' "$COMPLETE_BUNDLE" '# committed snapshot' >"$TRACKED_CACHE"
git -C "$TRACKED_ROOT" init -q
git -C "$TRACKED_ROOT" add .cogni/.cognition-cache.md
tracked_output="$({
  cd "$TRACKED_ROOT"
  CODEX_THREAD_ID="" COGNI_NODE_API_KEY="test-key" bash "$LOADER"
})"
[[ -z "$tracked_output" ]] || fail "Claude hook emitted duplicate cognition"
[[ "$(cat "$TRACKED_CACHE")" == "$COMPLETE_BUNDLE" ]] ||
  fail "project loader did not replace a tracked snapshot with complete live cognition"

mkdir -p "$FIXTURE_ROOT/small/.cogni"
git -C "$FIXTURE_ROOT/small" init -q
printf '%s\n' 'intent:' '  name: operator' >"$FIXTURE_ROOT/small/.cogni/repo-spec.yaml"
printf '%s\n' "$COMPLETE_BUNDLE" >"$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
calls_before="$(wc -l < "$FAKE_CALLS")"
small_output="$({ cd "$FIXTURE_ROOT/small"; CODEX_THREAD_ID="" bash "$LOADER"; })"
[[ -z "$small_output" ]] || fail "Claude cached path emitted duplicate cognition"
[[ "$(wc -l < "$FAKE_CALLS")" == "$calls_before" ]] || fail "warm TTL cache fetched on boot"

mkdir -p "$FIXTURE_ROOT/codex-tmp"
codex_output="$({
  cd "$FIXTURE_ROOT/small"
  CODEX_THREAD_ID="codex-raw" TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LOADER"
})"
[[ "$codex_output" == "$COMPLETE_BUNDLE" ]] || fail "Codex did not inject the complete bundle verbatim"

# Native Codex supplies session_id on stdin even when CODEX_THREAD_ID is absent.
# The same SessionStart payload must not make Claude emit duplicate context.
native_hook_input='{"hook_event_name":"SessionStart","source":"startup","session_id":"native-codex"}'
native_codex_output="$(printf '%s\n' "$native_hook_input" | (
  cd "$FIXTURE_ROOT/small"
  unset CODEX_THREAD_ID
  TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LOADER" --codex
))"
[[ "$native_codex_output" == "$COMPLETE_BUNDLE" ]] ||
  fail "explicit Codex adapter requires an absent native environment variable"
native_claude_output="$(printf '%s\n' "$native_hook_input" | (
  cd "$FIXTURE_ROOT/small"
  unset CODEX_THREAD_ID
  bash "$LOADER"
))"
[[ -z "$native_claude_output" ]] || fail "generic SessionStart payload selected Codex for Claude"
mkdir "$FIXTURE_ROOT/codex-tmp/cogni-cognition-native-codex.lock"
native_locked_output="$(printf '%s\n' "$native_hook_input" | (
  cd "$FIXTURE_ROOT/small"
  unset CODEX_THREAD_ID
  TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LOADER" --codex
))"
[[ -z "$native_locked_output" ]] || fail "Codex stdin session_id did not share the presentation lock"
rmdir "$FIXTURE_ROOT/codex-tmp/cogni-cognition-native-codex.lock"

mkdir "$FIXTURE_ROOT/cogni-cognition-lock-test.lock"
locked_output="$({
  cd "$FIXTURE_ROOT/small"
  TMPDIR="$FIXTURE_ROOT" CODEX_THREAD_ID="lock-test" bash "$LOADER"
})"
[[ -z "$locked_output" ]] || fail "second concurrent presenter ignored the lock"

# A full older five-column contract is a valid last-known offline fallback; schema
# upgrades are the hub's job, not cache admission. Check the real template fixture.
OLDER_BUNDLE="${COMPLETE_BUNDLE/| work | responsibility | gate |/| item | owner | deliverable links | status | next |}"
OLDER_BUNDLE="${OLDER_BUNDLE/| --- | --- | --- |/| --- | --- | --- | --- | --- |}"
OLDER_BUNDLE="${OLDER_BUNDLE/| linked item | assigned agent | next proof |/| item | agent | - | watching | proof |}"

# Bad background refreshes must preserve last-known complete bytes AND mtime.
# Waiting for the sourced hook's child on EXIT makes this assertion deterministic.
for bad_response in "$MAP_ONLY" "$SEMANTICS_ONLY" "$TRUNCATED_BUNDLE" '' ; do
  respond_with "$bad_response"
  printf '%s\n' "$OLDER_BUNDLE" >"$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
  touch -t 202001010000 "$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
  cp -p "$FIXTURE_ROOT/small/.cogni/.cognition-cache.md" "$FIXTURE_ROOT/expected-cache"
  ({ cd "$FIXTURE_ROOT/small"; CODEX_THREAD_ID="" bash -c 'trap wait EXIT; source "$1"' _ "$LOADER"; })
  cmp -s "$FIXTURE_ROOT/expected-cache" "$FIXTURE_ROOT/small/.cogni/.cognition-cache.md" ||
    fail "incomplete refresh replaced a complete cache"
  [[ ! "$FIXTURE_ROOT/small/.cogni/.cognition-cache.md" -nt "$FIXTURE_ROOT/expected-cache" ]] ||
    fail "rejected refresh renewed cache TTL"
done

# Cold, map-only, and truncated local caches all recover instead of injecting a
# contract substitute. Claude remains write-only; the recovery file is available
# to its next @import and to OpenCode's configured instruction-file path.
for local_cache in absent "$MAP_ONLY" "$TRUNCATED_BUNDLE"; do
  for thread_id in '' cold-codex; do
    mkdir -p "$FIXTURE_ROOT/cold/.cogni"
    rm -f "$FIXTURE_ROOT/cold/.cogni/.cognition-cache.md"
    if [[ "$local_cache" != absent ]]; then
      printf '%s\n' "$local_cache" >"$FIXTURE_ROOT/cold/.cogni/.cognition-cache.md"
    fi
    respond_with "$SEMANTICS_ONLY"
    cold_output="$({
      cd "$FIXTURE_ROOT/cold"
      CODEX_THREAD_ID="$thread_id" COGNI_NODE_API_KEY="test-key" TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LOADER"
    })"
    recovery_cache="$(cat "$FIXTURE_ROOT/cold/.cogni/.cognition-cache.md")"
    [[ "$recovery_cache" == *'BOOTSTRAP RECOVERY (no complete contract)'* ]] ||
      fail "absent/invalid cache did not enter bounded recovery"
    [[ "$recovery_cache" == *'Do not begin normal task work'* ]] || fail "recovery authorized normal work"
    [[ "$recovery_cache" != *'Proceed with the repo'* ]] || fail "recovery substituted AGENTS/skills for cognition"
    if [[ -z "$thread_id" ]]; then
      [[ -z "$cold_output" ]] || fail "Claude recovery leaked hook stdout"
    else
      [[ "$cold_output" == "$recovery_cache" ]] || fail "Codex did not receive recovery context"
    fi
  done
done
# A recovery notice is never admitted as a complete cache: retry once, then the
# actual complete response replaces it and resumes native delivery next session.
respond_with "$COMPLETE_BUNDLE"
recovered_output="$({
  cd "$FIXTURE_ROOT/cold"
  CODEX_THREAD_ID="recovered-codex" TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LOADER"
})"
[[ "$recovered_output" == "$COMPLETE_BUNDLE" ]] || fail "recovery notice was admitted as a complete contract"

# Large complete bundles must remain intact for both native delivery channels.
mkdir -p "$FIXTURE_ROOT/large/.cogni"
{ printf '%s\n' "$COMPLETE_BUNDLE"; head -c 17000 /dev/zero | tr '\0' x; } >"$FIXTURE_ROOT/large/.cogni/.cognition-cache.md"
cp "$FIXTURE_ROOT/large/.cogni/.cognition-cache.md" "$FIXTURE_ROOT/expected-large"
large_output="$({ cd "$FIXTURE_ROOT/large"; CODEX_THREAD_ID="" bash "$LOADER"; })"
[[ -z "$large_output" ]] || fail "large Claude bundle leaked hook stdout"
large_codex="$({
  cd "$FIXTURE_ROOT/large"
  CODEX_THREAD_ID="large-codex" TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LOADER"
})"
[[ "$large_codex" == "$(cat "$FIXTURE_ROOT/expected-large")" ]] || fail "Codex truncated a complete large bundle"
cmp -s "$FIXTURE_ROOT/expected-large" "$FIXTURE_ROOT/large/.cogni/.cognition-cache.md" || fail "large bundle mutated"

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
grep -Fq 'if ! cache_is_repo_tracked && bundle_is_complete "$bundle"; then' "$LEGACY_HOOK" ||
  fail "installed user hook does not validate cache completeness and provenance"
bash -n "$LEGACY_HOOK"
printf '%s\n' "$COMPLETE_BUNDLE" >"$FIXTURE_ROOT/small/.cogni/.cognition-cache.md"
native_installed_output="$(printf '%s\n' "$native_hook_input" | (
  cd "$FIXTURE_ROOT/small"
  unset CODEX_THREAD_ID
  TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LEGACY_HOOK"
))"
[[ "$native_installed_output" == "$COMPLETE_BUNDLE" ]] ||
  fail "installed Codex hook lost native delivery without CODEX_THREAD_ID"
mkdir "$FIXTURE_ROOT/codex-tmp/cogni-cognition-native-codex.lock"
native_installed_locked="$(printf '%s\n' "$native_hook_input" | (
  cd "$FIXTURE_ROOT/small"
  unset CODEX_THREAD_ID
  TMPDIR="$FIXTURE_ROOT/codex-tmp" bash "$LEGACY_HOOK"
))"
[[ -z "$native_installed_locked" ]] || fail "installed hook did not share the native stdin session lock"
rmdir "$FIXTURE_ROOT/codex-tmp/cogni-cognition-native-codex.lock"

printf '%s\n' "$COMPLETE_BUNDLE" '# committed snapshot' >"$TRACKED_CACHE"
installed_output="$({
  cd "$TRACKED_ROOT"
  mkdir -p "$FIXTURE_ROOT/installed-codex-tmp"
  PATH="$FAKE_BIN:$PATH" CODEX_THREAD_ID="installed-codex" \
    TMPDIR="$FIXTURE_ROOT/installed-codex-tmp" COGNI_NODE_API_KEY="test-key" \
    CODEX_HOME="$LEGACY_HOME" bash "$LEGACY_HOOK"
})"
[[ "$installed_output" == "$COMPLETE_BUNDLE" ]] ||
  fail "installed Codex hook did not present refreshed cognition"
[[ "$(cat "$TRACKED_CACHE")" == "$COMPLETE_BUNDLE" ]] ||
  fail "installed user hook did not replace the tracked snapshot with live cognition"

# The installed stable user hook can win the presentation lock; it must have
# exactly the same safety behavior as the project hook without executing repo code.
INSTALLED_ROOT="$FIXTURE_ROOT/installed"
mkdir -p "$INSTALLED_ROOT/.cogni"
printf '%s\n' 'intent:' '  name: operator' >"$INSTALLED_ROOT/.cogni/repo-spec.yaml"
git -C "$INSTALLED_ROOT" init -q
for hook in "$LOADER" "$LEGACY_HOOK"; do
  for rejected in map semantics truncated empty_process malformed_table nonstring malformed outage; do
    case "$rejected" in
      map) respond_with "$MAP_ONLY" ;;
      semantics) respond_with "$SEMANTICS_ONLY" ;;
      truncated) respond_with "$TRUNCATED_BUNDLE" ;;
      empty_process) respond_with "$EMPTY_PROCESS" ;;
      malformed_table) respond_with "$MALFORMED_TABLE" ;;
      nonstring) printf '%s\n' '{"markdown":{"not":"a string"}}' >"$FAKE_RESPONSE" ;;
      malformed) printf '%s\n' '{"markdown":' >"$FAKE_RESPONSE" ;;
      outage) export FAKE_CURL_FAIL=1 ;;
    esac
    printf '%s\n' "$OLDER_BUNDLE" >"$INSTALLED_ROOT/.cogni/.cognition-cache.md"
    touch -t 202001010000 "$INSTALLED_ROOT/.cogni/.cognition-cache.md"
    cp -p "$INSTALLED_ROOT/.cogni/.cognition-cache.md" "$FIXTURE_ROOT/expected-installed"
    ({
      cd "$INSTALLED_ROOT"
      CODEX_THREAD_ID="" COGNI_NODE_API_KEY="test-key" \
        bash -c 'trap wait EXIT; source "$1"' _ "$hook" >/dev/null
    })
    cmp -s "$FIXTURE_ROOT/expected-installed" "$INSTALLED_ROOT/.cogni/.cognition-cache.md" ||
      fail "$hook lost its complete offline cache on $rejected refresh"
    [[ ! "$INSTALLED_ROOT/.cogni/.cognition-cache.md" -nt "$FIXTURE_ROOT/expected-installed" ]] ||
      fail "$hook renewed its cache TTL after rejected refresh"
    unset FAKE_CURL_FAIL
  done
  for key in '' test-key; do
    rm -f "$INSTALLED_ROOT/.cogni/.cognition-cache.md"
    respond_with "$SEMANTICS_ONLY"
    installed_recovery="$({
      cd "$INSTALLED_ROOT"
      CODEX_THREAD_ID="stable-recovery" TMPDIR="$FIXTURE_ROOT/codex-tmp" \
        COGNI_NODE_API_KEY="$key" bash "$hook"
    })"
    [[ "$installed_recovery" == *'BOOTSTRAP RECOVERY (no complete contract)'* ]] ||
      fail "$hook admitted semantics-only content on cold boot"
    if [[ -n "$key" ]]; then
      [[ "$installed_recovery" == *'A node credential is present'* ]] ||
        fail "$hook confused an incomplete published contract with missing credentials"
    else
      [[ "$installed_recovery" == *'No COGNI_NODE_API_KEY was found'* ]] ||
        fail "$hook omitted first-setup recovery guidance"
    fi
  done
done

# Read-only detector cache access must bypass credentials, hooks, presentation
# locks, refresh, and mutation—even for invalid caches or a stale complete cache.
readonly_cache="$INSTALLED_ROOT/.cogni/.cognition-cache.md"
for content in "$COMPLETE_BUNDLE" "$SEMANTICS_ONLY"; do
  printf '%s\n' "$content" >"$readonly_cache"
  touch -t 202001010000 "$readonly_cache"
  cp -p "$readonly_cache" "$FIXTURE_ROOT/expected-readonly"
  calls_before="$(wc -l < "$FAKE_CALLS")"
  mkdir -p "$FIXTURE_ROOT/cogni-cognition-readonly.lock" "${readonly_cache}.write-lock"
  readonly_output="$({
    cd "$INSTALLED_ROOT"
    CODEX_THREAD_ID="readonly" TMPDIR="$FIXTURE_ROOT" bash "$LOADER" --cached-contract
  })"
  if [[ "$content" == "$COMPLETE_BUNDLE" ]]; then
    [[ "$readonly_output" == *'| work | responsibility | gate |'* ]] ||
      fail "read-only detector access was suppressed by a presentation/mutation lock"
  else
    [[ -z "$readonly_output" ]] || fail "read-only detector admitted an incomplete contract"
  fi
  cmp -s "$readonly_cache" "$FIXTURE_ROOT/expected-readonly" || fail "read-only detector mutated cache bytes"
  [[ ! "$readonly_cache" -nt "$FIXTURE_ROOT/expected-readonly" ]] || fail "read-only detector renewed cache TTL"
  [[ "$(wc -l < "$FAKE_CALLS")" == "$calls_before" ]] || fail "read-only detector fetched cognition"
  rmdir "$FIXTURE_ROOT/cogni-cognition-readonly.lock" "${readonly_cache}.write-lock"
done

# A busy cache guard cannot cause a torn write, cache loss, or an unbounded
# boot wait. A stale complete cache remains usable if its refresh cannot acquire
# the mutation guard; the held guard belongs to this test and must remain intact.
for hook in "$LOADER" "$LEGACY_HOOK"; do
  printf '%s\n' "$OLDER_BUNDLE" >"$readonly_cache"
  touch -t 202001010000 "$readonly_cache"
  cp -p "$readonly_cache" "$FIXTURE_ROOT/expected-contention"
  mkdir "${readonly_cache}.write-lock"
  respond_with "$COMPLETE_BUNDLE"
  ({
    cd "$INSTALLED_ROOT"
    CODEX_THREAD_ID="" COGNI_NODE_API_KEY="test-key" \
      bash -c 'trap wait EXIT; source "$1"' _ "$hook" >/dev/null
  })
  cmp -s "$readonly_cache" "$FIXTURE_ROOT/expected-contention" || fail "busy guard allowed a cache mutation"
  [[ ! "$readonly_cache" -nt "$FIXTURE_ROOT/expected-contention" ]] || fail "busy guard renewed cache TTL"
  rmdir "${readonly_cache}.write-lock"
done

# Deterministic A-fails/B-succeeds race: A's cold fetch pauses, B installs a
# complete contract, then A fails. Every project/stable hook pairing must preserve
# B's cache and present the now-available contract instead of stale recovery.
for failing_hook in "$LOADER" "$LEGACY_HOOK"; do
  for succeeding_hook in "$LOADER" "$LEGACY_HOOK"; do
    rm -f "$readonly_cache"
    rm -f "$FIXTURE_ROOT/race.ready" "$FIXTURE_ROOT/race.release"
    respond_with "$COMPLETE_BUNDLE"
    ({
      cd "$INSTALLED_ROOT"
      CODEX_THREAD_ID="race-a" TMPDIR="$FIXTURE_ROOT/codex-tmp" COGNI_NODE_API_KEY="test-key" \
        FAKE_FETCH_WAIT="$FIXTURE_ROOT/race" FAKE_CURL_FAIL=1 bash "$failing_hook"
    }) >"$FIXTURE_ROOT/race-a-output" &
    failing_pid=$!
    attempts=0
    until [[ -f "$FIXTURE_ROOT/race.ready" ]]; do
      attempts=$((attempts + 1))
      [[ "$attempts" -lt 200 ]] || fail "race fixture did not reach the paused fetch"
      sleep 0.01
    done
    ({
      cd "$INSTALLED_ROOT"
      CODEX_THREAD_ID="race-b" TMPDIR="$FIXTURE_ROOT/codex-tmp" COGNI_NODE_API_KEY="test-key" bash "$succeeding_hook"
    }) >"$FIXTURE_ROOT/race-b-output"
    [[ "$(cat "$readonly_cache")" == "$COMPLETE_BUNDLE" ]] || fail "race fixture B did not install its complete contract"
    cp -p "$readonly_cache" "$FIXTURE_ROOT/race-expected"
    touch "$FIXTURE_ROOT/race.release"
    wait "$failing_pid"
    cmp -s "$readonly_cache" "$FIXTURE_ROOT/race-expected" || fail "failing bootstrap overwrote another session complete cache"
    [[ ! "$readonly_cache" -nt "$FIXTURE_ROOT/race-expected" ]] || fail "failing bootstrap rewrote another session complete cache"
    [[ "$(cat "$FIXTURE_ROOT/race-a-output")" == "$COMPLETE_BUNDLE" ]] || fail "race loser emitted stale recovery despite an available complete contract"
    [[ ! -d "${readonly_cache}.write-lock" ]] || fail "cache mutation guard leaked after the race"
  done
done

echo "session-cognition-hook.test: PASS"
