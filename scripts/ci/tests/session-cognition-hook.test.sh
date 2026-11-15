#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Hermetic regressions for the fetch-per-session cognition loader (story.0001,
# story.0051; ported from node-template app/tests/meta/cognition-bootstrap.test.ts).
# Every session fetches its own bundle from the hub, falling back to the last COMPLETE
# cache only when the hub is down or incomplete. Claude Code receives the bundle as
# labelled SessionStart parts (--claude-part N); Codex receives raw hook stdout with
# spill disabled; supported OpenCode 1.x refreshes the cache in a plugin and loads it
# through opencode.json instructions. A tracked snapshot is never live cognition, a
# refresh never replaces a complete cache with an incomplete answer, and the repo root
# resolves this repo's hub origin (cognidao.org) from .cogni/repo-spec.yaml.

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

# A complete bundle as the hub serves it: the contract and its status-contract.
LIVE=$'live cognition\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>'
CACHED=$'cached\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>'
CACHE_PATH=".cogni/.cognition-cache.md"
FAKE_BIN="$FIXTURE_ROOT/bin"
mkdir -p "$FAKE_BIN" "$FIXTURE_ROOT/no-user-hooks"

# fake_curl <json-body-or-"fail"> — stub curl: record the URL, answer or exit 7.
fake_curl() {
  if [[ "$1" == "fail" ]]; then
    printf '%s\n' '#!/bin/sh' 'exit 7' >"$FAKE_BIN/curl"
  else
    printf '%s\n' "$1" >"$FIXTURE_ROOT/curl-body.json"
    printf '%s\n' '#!/bin/sh' \
      "for a in \"\$@\"; do case \"\$a\" in http*) printf '%s\\n' \"\$a\" >>\"$FIXTURE_ROOT/curl-urls\";; esac; done" \
      "cat '$FIXTURE_ROOT/curl-body.json'" >"$FAKE_BIN/curl"
  fi
  chmod +x "$FAKE_BIN/curl"
}
live_json() { jq -cn --arg m "$1" '{markdown:$m}'; }

# run_loader <repo> <codex-thread-id> [loader args...]
run_loader() {
  local repo="$1" thread="$2"
  shift 2
  (
    cd "$repo"
    PATH="$FAKE_BIN:$PATH" CODEX_THREAD_ID="$thread" COGNI_NODE_API_KEY="${KEY-test-key}" \
      CODEX_HOME="$FIXTURE_ROOT/no-user-hooks" TMPDIR="$FIXTURE_ROOT" bash "$LOADER" "$@"
  )
}

new_repo() {
  local repo="$FIXTURE_ROOT/$1"
  mkdir -p "$repo/.cogni"
  git -C "$repo" init -q
  printf '%s\n' 'intent:' "  name: ${2:-operator}" >"$repo/.cogni/repo-spec.yaml"
  printf '%s' "$repo"
}

# ── Repo config ────────────────────────────────────────────────────────────
grep -Fq 'additionalContextLimit = 0' "$REPO_ROOT/.codex/config.toml" ||
  fail "project hook still uses Codex's truncating default"
grep -Fq 'git rev-parse --show-toplevel' "$REPO_ROOT/.codex/config.toml" ||
  fail "Codex project hook must resolve the loader from the git root"
# The floor is thin: the complete response contract lives in the hub bundle, not here.
grep -Fq 'cognition bundle' "$REPO_ROOT/AGENTS.md" ||
  fail "root AGENTS.md must stay the thin floor and point to the bundle contract"
! grep -Fq 'is exactly this skeleton' "$REPO_ROOT/AGENTS.md" ||
  fail "root AGENTS.md re-introduced the response skeleton (the Roles-dropping regression)"
grep -Fq 'model-visible before normal work' "$REPO_ROOT/AGENTS.md" ||
  fail "AGENTS.md must keep the agent bootstrap automatic"
[[ ! -L "$REPO_ROOT/CLAUDE.md" ]] ||
  fail "CLAUDE.md must own its harness-specific imports, not symlink AGENTS.md"
grep -Fxq '@AGENTS.md' "$REPO_ROOT/CLAUDE.md" ||
  fail "CLAUDE.md omitted the universal root floor import"
# Claude's bundle arrives fresh through its hooks; importing the cache too would
# duplicate it with an older copy (story.0001).
! grep -Fq '.cognition-cache.md' "$REPO_ROOT/CLAUDE.md" ||
  fail "CLAUDE.md imports the cognition cache, duplicating the fresh SessionStart parts"
[[ "$(jq -r '.instructions[0]' "$REPO_ROOT/opencode.json")" == "$CACHE_PATH" ]] ||
  fail "OpenCode 1.x config omitted automatic cognition instructions"
grep -Fq 'scripts/agent/session-cognition.sh --refresh' "$REPO_ROOT/.opencode/plugin/cogni-cognition.js" ||
  fail "OpenCode plugin does not refresh the instruction file before it is resolved"
grep -Fxq "$CACHE_PATH" "$REPO_ROOT/.gitignore" ||
  fail "the cognition cache must be gitignored"
[[ -z "$(git -C "$REPO_ROOT" ls-files -- "$CACHE_PATH")" ]] ||
  fail "a cognition snapshot is tracked in git"

[[ "$(jq -r '.outputStyle' "$REPO_ROOT/.claude/settings.json")" == "Cogni Contract" ]] ||
  fail "Claude Code project settings omitted the Cogni Contract output style"
OUTPUT_STYLE="$REPO_ROOT/.claude/output-styles/Cogni Contract.md"
[[ -f "$OUTPUT_STYLE" ]] || fail "Claude Code Cogni Contract output style is missing"
grep -Fq 'loaded contract' "$OUTPUT_STYLE" || grep -Fq 'delivered in the session cognition bundle' "$OUTPUT_STYLE" ||
  fail "Claude Code output style must reinforce the loaded bundle contract, not restate it"
STOP_VALIDATOR="$REPO_ROOT/scripts/agent/validate-status-contract.sh"
[[ -x "$STOP_VALIDATOR" ]] || fail "Claude Code status-contract Stop hook is not executable"
jq -e '.hooks.Stop[0].hooks[0].command | contains("validate-status-contract.sh")' \
  "$REPO_ROOT/.claude/settings.json" >/dev/null ||
  fail "Claude Code settings omitted the status-contract Stop hook"

# One Claude hook per declared part, each delivering one slice.
parts="$(sed -n 's/^CLAUDE_PARTS=\([0-9][0-9]*\)$/\1/p' "$LOADER")"
[[ -n "$parts" ]] || fail "loader does not declare CLAUDE_PARTS"
expected_commands="$(for i in $(seq 1 "$parts"); do
  printf '%s\n' "bash \"\$(git rev-parse --show-toplevel)/scripts/agent/session-cognition.sh\" --claude-part $i"
done)"
actual_commands="$(jq -r '[.hooks.SessionStart[].hooks[].command | select(contains("session-cognition.sh"))] | .[]' "$REPO_ROOT/.claude/settings.json")"
[[ "$actual_commands" == "$expected_commands" ]] ||
  fail ".claude/settings.json must carry exactly one --claude-part hook per declared part"
# The operator's remote-env, gh and pnpm SessionStart hooks must survive the port.
[[ "$(jq '[.hooks.SessionStart[].hooks[].command | select(contains("CLAUDE_CODE_REMOTE") or contains("pnpm install"))] | length' "$REPO_ROOT/.claude/settings.json")" -ge 3 ]] ||
  fail "operator remote-env / gh / pnpm SessionStart hooks were dropped"
for banned in SESSION_COGNITION_MAX_BYTES bundle_fits_budget oversized_bundle_notice CLAUDE_CONTEXT_MAX_CHARS git-common-dir settings.local.toml; do
  ! grep -Fq "$banned" "$LOADER" || fail "loader re-introduced $banned"
done

# ── Conductor ──────────────────────────────────────────────────────────────
grep -Fq "if [[ \"\${CONDUCTOR_IS_LOCAL:-1}\" == \"1\" ]]; then" "$CONDUCTOR_SETUP" ||
  fail "Conductor setup does not guard user-hook installation to local workspaces"
installer_line="$(grep -nF 'bash scripts/agent/install-codex-cognition-hook.sh' "$CONDUCTOR_SETUP" | cut -d: -f1)"
dependency_line="$(grep -nF 'pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile' "$CONDUCTOR_SETUP" | cut -d: -f1)"
[[ -n "$installer_line" && -n "$dependency_line" && "$installer_line" -lt "$dependency_line" ]] ||
  fail "Conductor setup does not reconcile the user hook before dependency install"
# Setup warms the cache after linking the key and before anything slow (bug.0018).
link_line="$(grep -nF 'link_from_auth_root ".env.cogni"' "$CONDUCTOR_SETUP" | tail -1 | cut -d: -f1)"
warm_line="$(grep -nxF 'warm_cognition_cache' "$CONDUCTOR_SETUP" | cut -d: -f1)"
fetch_line="$(grep -nxF 'refresh_workspace_base_ref' "$CONDUCTOR_SETUP" | cut -d: -f1)"
[[ -n "$link_line" && -n "$warm_line" && -n "$fetch_line" &&
  "$link_line" -lt "$warm_line" && "$warm_line" -lt "$fetch_line" && "$warm_line" -lt "$dependency_line" ]] ||
  fail "Conductor setup must warm the cognition cache after linking the key and before anything slow"
grep -Fq 'bash scripts/agent/session-cognition.sh --refresh' "$CONDUCTOR_SETUP" ||
  fail "Conductor setup does not warm the cache through the loader"
grep -Fq 'pnpm packages:build' "$CONDUCTOR_SETUP" && grep -Fq 'pnpm worktree:check' "$CONDUCTOR_SETUP" ||
  fail "Conductor setup dropped the operator's package build / worktree check"
# Each session fetches its own bundle: nothing copies cognition between checkouts.
grep -Fq 'setup = "bash scripts/conductor-worktree-setup.sh"' "$REPO_ROOT/.conductor/settings.toml" ||
  fail ".conductor/settings.toml does not wire the setup script"
! grep -Fq 'file_include_globs' "$REPO_ROOT/.conductor/settings.toml" ||
  fail ".conductor/settings.toml copies files between checkouts"
for legacy in .worktreeinclude conductor.json; do
  [[ ! -e "$REPO_ROOT/$legacy" ]] || fail "$legacy must not exist; .conductor/settings.toml replaces it"
done

# ── Hub origin: the repo root resolves this repo's own hub ─────────────────
spec_slug="$(awk '/^intent:/{i=1;next} i&&/^[^[:space:]]/{i=0} i&&/^[[:space:]]+name:/{sub(/^[[:space:]]+name:[[:space:]]*/,"");gsub(/["'"'"']/,"");print;exit}' "$REPO_ROOT/.cogni/repo-spec.yaml")"
case "$spec_slug" in
  operator | cogni-template) ;;
  *) fail "root .cogni/repo-spec.yaml intent.name '$spec_slug' no longer maps to https://cognidao.org" ;;
esac
fake_curl "$(live_json "$LIVE")"
for slug_url in "operator|https://cognidao.org/api/v1/cognition" \
  "cogni-template|https://cognidao.org/api/v1/cognition" \
  "poly|https://poly.cognidao.org/api/v1/cognition"; do
  slug="${slug_url%%|*}"
  want="${slug_url#*|}"
  repo="$(new_repo "origin-$slug" "$slug")"
  rm -f "$FIXTURE_ROOT/curl-urls"
  run_loader "$repo" "" --refresh
  [[ "$(cat "$FIXTURE_ROOT/curl-urls")" == "$want" ]] ||
    fail "intent.name '$slug' fetched $(cat "$FIXTURE_ROOT/curl-urls"), expected $want"
done

# ── Loader: a tracked snapshot is never trusted (story.5070) ───────────────
repo="$(new_repo tracked)"
printf '%s\n' 'stale committed cognition' >"$repo/$CACHE_PATH"
git -C "$repo" add "$CACHE_PATH"
fake_curl "$(live_json "$LIVE")"
[[ "$(run_loader "$repo" "tracked-snapshot")" == "$LIVE" ]] ||
  fail "session did not present the hub's bundle over the tracked snapshot"
[[ "$(cat "$repo/$CACHE_PATH")" == "$LIVE" ]] ||
  fail "loader did not replace the tracked snapshot with live cognition"
# Hub down + tracked snapshot ⇒ the snapshot is treated as absent: notice, not stale text.
printf '%s\n' 'stale committed cognition' >"$repo/$CACHE_PATH"
fake_curl fail
down_tracked="$(run_loader "$repo" "tracked-down")"
[[ "$down_tracked" == *"could not load bundle"* && "$down_tracked" != *"stale committed cognition"* ]] ||
  fail "a tracked snapshot was presented as live cognition while the hub was down"
# --refresh refuses a tracked cache outright.
fake_curl "$(live_json "$LIVE")"
! run_loader "$repo" "" --refresh || fail "--refresh wrote over a tracked snapshot"

# ── Loader: refresh replaces the cache only with a complete bundle (bug.0024) ─
repo="$(new_repo refresh)"
printf '%s\n' "$CACHED" >"$repo/$CACHE_PATH"
fake_curl "$(live_json 'map only')"
! run_loader "$repo" "" --refresh || fail "--refresh succeeded on an incomplete hub bundle"
[[ "$(cat "$repo/$CACHE_PATH")" == "$CACHED" ]] ||
  fail "an incomplete hub response replaced the complete cache"
fake_curl "$(live_json "$LIVE")"
run_loader "$repo" "" --refresh
[[ "$(cat "$repo/$CACHE_PATH")" == "$LIVE" ]] || fail "--refresh did not write the complete bundle"

# ── Loader: fresh first, else the last complete cache (story.0001) ─────────
repo="$(new_repo fresh)"
printf '%s\n' "$CACHED" >"$repo/$CACHE_PATH"
[[ "$(run_loader "$repo" "fresh-first")" == "$LIVE" ]] ||
  fail "Codex did not present the freshly fetched bundle"
[[ "$(cat "$repo/$CACHE_PATH")" == "$LIVE" ]] || fail "the cache did not follow the fresh bundle"
fake_curl fail
[[ "$(run_loader "$repo" "fresh-first")" == "$LIVE" ]] ||
  fail "a down hub did not fall back to the last complete cache"
fake_curl "$(live_json 'map only')"
[[ "$(run_loader "$repo" "fresh-first")" == "$LIVE" ]] ||
  fail "an incomplete hub bundle displaced the last complete cache"
# Only Codex reads stdout; a plain (Claude) call stays silent.
[[ -z "$(run_loader "$repo" "")" ]] || fail "plain call leaked cognition into hook stdout"
# A second concurrent Codex presenter honors the per-thread lock.
mkdir "$FIXTURE_ROOT/cogni-cognition-lock-test.lock"
[[ -z "$(run_loader "$repo" "lock-test")" ]] ||
  fail "second concurrent presenter did not honor the per-thread lock"
# No complete bundle anywhere: an honest notice that names the setup step.
repo="$(new_repo keyless)"
fake_curl fail
[[ "$(KEY="" run_loader "$repo" "keyless")" == *"no node credentials yet"* ]] ||
  fail "keyless boot did not surface the setup notice"
[[ "$(run_loader "$repo" "keyed")" == *"could not load bundle"* ]] ||
  fail "key-present failure did not surface the could-not-load notice"

# ── Loader: Claude receives labelled parts that fit its context entries ────
repo="$(new_repo parts)"
section() {
  printf '## %s\n' "$1"
  for i in $(seq 0 $(($2 - 1))); do printf '%s line %s %s\n' "$1" "$i" "$(head -c 60 /dev/zero | tr '\0' x)"; done
}
BUNDLE="$(
  printf '# node — Cogni Session Cognition\n\n'
  section Orientation 30; printf '\n'
  printf '## The agent-contract\n<agent-contract>\n<status-contract>\n</status-contract>\n</agent-contract>\n\n'
  section 'Knowledge domains' 200; printf '\n'
  section Domains 40
)"
fake_curl "$(live_json "$BUNDLE")"
hook_input='{"hook_event_name":"SessionStart","session_id":"claude-1","source":"startup"}'
contexts=()
for i in $(seq 1 "$parts"); do
  out="$(printf '%s' "$hook_input" | run_loader "$repo" "" --claude-part "$i")"
  [[ -z "$out" ]] || contexts+=("$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')")
done
total="${#contexts[@]}"
[[ "$total" -gt 2 ]] || fail "expected a multi-part bundle, got $total part(s)"
joined=""
for idx in "${!contexts[@]}"; do
  ctx="${contexts[$idx]}"
  # Claude Code keeps a SessionStart entry inline only up to about 10,000 characters.
  [[ "${#ctx}" -lt 9500 ]] || fail "part $((idx + 1)) is too large for an inline Claude entry (${#ctx})"
  [[ "$ctx" == "COGNI COGNITION — part $((idx + 1)) of $total "* ]] ||
    fail "part $((idx + 1)) is not labelled 'part $((idx + 1)) of $total'"
  joined+="$(printf '%s\n' "$ctx" | tail -n +3)"$'\n'
done
# Lossless: the parts, in order, are the whole bundle (command substitution drops
# each part's trailing blank lines, so compare without blank lines).
[[ "$(printf '%s' "$joined" | grep -v '^$')" == "$(printf '%s' "$BUNDLE" | grep -v '^$')" ]] ||
  fail "the Claude parts, in order, are not the whole bundle"
[[ "$(cat "$repo/$CACHE_PATH")" == "$BUNDLE" ]] || fail "part 1 did not warm the cache"
# Hub down and nothing cached: part 1 carries the notice alone.
rm -f "$repo/$CACHE_PATH"
fake_curl fail
down_input='{"hook_event_name":"SessionStart","session_id":"claude-2","source":"startup"}'
down_1="$(printf '%s' "$down_input" | run_loader "$repo" "" --claude-part 1)"
[[ "$(printf '%s' "$down_1" | jq -r '.hookSpecificOutput.additionalContext')" == *"could not load bundle"* ]] ||
  fail "part 1 did not carry the recovery notice"
[[ -z "$(printf '%s' "$down_input" | run_loader "$repo" "" --claude-part 2)" ]] ||
  fail "part 2 emitted output beside the recovery notice"

# ── Loader: --cached-contract feeds the Stop validator, read-only ──────────
repo="$(new_repo cached-contract)"
fake_curl "$(live_json "$LIVE")"
rm -f "$FIXTURE_ROOT/curl-urls"
[[ -z "$(run_loader "$repo" "" --cached-contract)" ]] || fail "--cached-contract printed without a cache"
printf '%s\n' "$LIVE" >"$repo/$CACHE_PATH"
[[ "$(run_loader "$repo" "" --cached-contract)" == $'<status-contract>\n</status-contract>' ]] ||
  fail "--cached-contract did not print the cached status-contract"
[[ ! -e "$FIXTURE_ROOT/curl-urls" ]] || fail "--cached-contract touched the network"

# ── Codex user hook installer reconciles idempotently ──────────────────────
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
# Fresh first: the hub's bundle before any cached one (story.0001).
fetch_pos="$(grep -nF 'bundle="$(fetch_bundle)"' "$LEGACY_HOOK" | head -1 | cut -d: -f1)"
cache_pos="$(grep -nF 'cat "$CACHE_FILE"' "$LEGACY_HOOK" | head -1 | cut -d: -f1)"
[[ -n "$fetch_pos" && -n "$cache_pos" && "$fetch_pos" -lt "$cache_pos" ]] ||
  fail "installed user hook does not fetch before presenting the cache"
bash -n "$LEGACY_HOOK"

repo="$(new_repo installed operator)"
printf '%s\n' 'stale committed cognition' >"$repo/$CACHE_PATH"
git -C "$repo" add "$CACHE_PATH"
fake_curl "$(live_json "$LIVE")"
installed_output="$(
  cd "$repo"
  PATH="$FAKE_BIN:$PATH" CODEX_THREAD_ID="" COGNI_NODE_API_KEY="test-key" \
    CODEX_HOME="$LEGACY_HOME" bash "$LEGACY_HOOK"
)"
[[ "$installed_output" == "$LIVE" ]] ||
  fail "installed Codex hook did not present refreshed cognition"
[[ "$(cat "$repo/$CACHE_PATH")" == "$LIVE" ]] ||
  fail "installed user hook did not replace the tracked snapshot with live cognition"

echo "session-cognition-hook.test: PASS"
