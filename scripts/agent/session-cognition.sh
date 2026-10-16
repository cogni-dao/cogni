#!/usr/bin/env bash
# Session-start cognition loader — shared by the Claude Code (.claude/settings.json)
# and Codex (.codex/config.toml) SessionStart hooks. Refreshes THIS node's own
# cognition cache; only Codex also consumes hook stdout as its injection channel.
#
# Design: LOCAL-FIRST PRESENT + ASYNC REFRESH. The hook fires on every
# startup/resume/compact and on every process respawn — so it must NEVER put a
# live call to the apex hub on the boot path. Acquisition (fetch) and
# presentation (inject) are separate concerns:
#   - presentation reads a durable, gitignored local cache
#     (.cogni/.cognition-cache.md) and is pure-offline, instant, and
#     deterministic;
#   - acquisition is a backgrounded, TTL-gated refresh whose failure is silent,
#     because a last-known complete bundle always beats a network stall or a scary
#     wall. Once a session has ever oriented, a hub outage is invisible here.
# Only boot without a complete cache surfaces a short, honest notice, and it
# never cries wolf: it separates "no credentials yet" (a setup step) from a
# key-present failure (hub down/slow, or a key without a principal).
#
# Why this matters: this hook runs on every agent session across the whole
# fleet. Coupling boot to a live cognidao.org fetch made the apex a fleet-wide
# SPOF and, worst of all, broke the very tooling meant to warn "prod is down"
# precisely because prod was down (bug.5122 — cognition boot self-dependency).
#
# .env.cogni holds two accounts (see .env.cogni.example): the NODE account
# (this node's own hub — the bearer used here) and the OPERATOR account
# (cognidao.org — CI/CD only: flight, deploy, secrets; never used by this loader).
set -u

CACHE_FILE=".cogni/.cognition-cache.md"
REFRESH_TTL_SECONDS=900   # only refresh in the background if cache older than this
FETCH_TIMEOUT=6           # bound the foreground first-boot fetch

# Hooks may start from a subdirectory. Resolve every repo-relative path from the
# git root so credentials, repo-spec, and the durable cache never depend on cwd.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0

# bundle_is_complete <markdown> — admit a complete operating contract, not merely
# a map or a nonempty response. Check its existing semantic envelope and generic
# Markdown template structure; field names and column counts stay hub-owned.
# Older complete templates remain valid offline fallbacks during hub upgrades.
bundle_is_complete() {
  printf '%s\n' "$1" | awk '
    function table_row(line, cells, count) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (line !~ /^\|.*\|$/) return 0
      sub(/^\|/, "", line); sub(/\|$/, "", line)
      count = split(line, cells, "|")
      if (count < 2 || line !~ /[^|[:space:]]/) return 0
      return count
    }
    function table_separator(line, cells, count, i) {
      gsub(/[[:space:]]/, "", line)
      sub(/^\|/, "", line); sub(/\|$/, "", line)
      count = split(line, cells, "|")
      if (count < 2) return 0
      for (i = 1; i <= count; i++) if (cells[i] !~ /^:?---[-]*:?$/) return 0
      return count
    }
    /^## The agent-contract([[:space:]]|$)/ { heading = 1; next }
    /^[[:space:]]*<agent-contract([[:space:]>])/ {
      if (!heading || phase != 0) bad = 1
      phase = 1; next
    }
    /^[[:space:]]*<process-contract([[:space:]>])/ {
      if (phase != 1) bad = 1
      phase = 2; next
    }
    /^[[:space:]]*<\/process-contract>[[:space:]]*$/ {
      if (phase != 2 || !process_body) bad = 1
      phase = 3; next
    }
    /^[[:space:]]*<status-contract([[:space:]>])/ {
      if (phase != 3) bad = 1
      phase = 4; next
    }
    /^[[:space:]]*<\/status-contract>[[:space:]]*$/ {
      if (phase != 4 || !status_body || templates < 2) bad = 1
      phase = 5; next
    }
    /^[[:space:]]*<\/agent-contract>[[:space:]]*$/ {
      if (phase != 5) bad = 1
      phase = 6; next
    }
    phase == 2 && /[^[:space:]]/ { process_body = 1 }
    phase == 4 {
      if ($0 ~ /[^[:space:]]/) status_body = 1
      row = table_row($0)
      if (row && table_separator($0)) {
        awaiting_data = (previous_row == row ? row : 0)
      } else {
        if (row && awaiting_data == row) templates++
        awaiting_data = 0
      }
      previous_row = row
    }
    END { exit !(phase == 6 && !bad) }
  '
}

# A cognition snapshot committed to git is not a cache: every new workspace
# would inherit whatever contract happened to be current at that commit, then
# present it before the async refresh. Treat tracked snapshots as absent so a
# fresh workspace fetches live cognition before its first agent reply.
cache_is_repo_tracked() {
  git ls-files --error-unmatch -- "$CACHE_FILE" >/dev/null 2>&1
}

# Read-only detector boundary: dispatch before credentials, presentation locks,
# network, background refresh, or writes. It observes only an admitted local
# status-contract; absence is not permission to invent a normal response shape.
if [ "${1:-}" = --cached-contract ]; then
  cached_bundle="$(cat "$CACHE_FILE" 2>/dev/null || true)"
  if ! cache_is_repo_tracked && bundle_is_complete "$cached_bundle"; then
    printf '%s\n' "$cached_bundle" | awk '
      /^[[:space:]]*<status-contract([[:space:]>])/ { inside = 1; next }
      /^[[:space:]]*<\/status-contract>/ { exit }
      inside { print }
    '
  fi
  exit 0
fi

# Older Cogni setups installed a user-level Codex hook. Codex runs matching
# user + project hooks concurrently. Both presenters take the same short-lived
# per-thread lock, so exactly one writes this event's developer context; the
# winner releases it immediately for later resume/clear/compact events.
if [ -n "${CODEX_THREAD_ID:-}" ]; then
  safe_thread_id="$(printf '%s' "$CODEX_THREAD_ID" | tr -cd '[:alnum:]_-')"
  COGNI_HOOK_LOCK="${TMPDIR:-/tmp}/cogni-cognition-${safe_thread_id}.lock"
  mkdir "$COGNI_HOOK_LOCK" 2>/dev/null || exit 0
  trap 'rmdir "$COGNI_HOOK_LOCK" 2>/dev/null || true' EXIT
fi

# emit_agent_context <text> — surface <text> only where the hook is the selected
# injection channel. The bundle is a live projection of the Dolt knowledge hub.
# Harnesses ingest it differently:
#   - Codex reads raw stdout as developer context and the .codex/config.toml
#     `additionalContextLimit = 0` disables its head/tail spill, so the full
#     payload lands untruncated.
#   - Claude Code expands CLAUDE.md @imports before/at SessionStart, so hook output
#     is too late for that session and duplicates a preview of the same bundle.
#     Its hook is therefore write-only; AGENTS.md keeps a cold session in bounded
#     recovery until a restart/resume imports the warmed complete contract.
emit_agent_context() {
  if [ -n "${CODEX_THREAD_ID:-}" ]; then
    printf '%s\n' "$1"
  fi
}

read_env_file_value() {
  var_name="$1"
  env_file="${2:-.env.cogni}"
  [ -f "$env_file" ] || return 0
  awk -F= -v key="$var_name" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$env_file" 2>/dev/null
}

# Node hub URL from repo-spec intent.name (root .cogni/repo-spec.yaml).
node_slug=""
if [ -f .cogni/repo-spec.yaml ]; then
  node_slug="$(awk '
    /^intent:/ { in_intent = 1; next }
    in_intent && /^[^[:space:]]/ { in_intent = 0 }
    in_intent && /^[[:space:]]+name:/ {
      sub(/^[[:space:]]+name:[[:space:]]*/, ""); gsub(/["'"'"']/, ""); print; exit
    }
  ' .cogni/repo-spec.yaml 2>/dev/null)"
fi

# operator is the apex (cognidao.org); its monorepo root repo-spec carries the
# slug `cogni-template`, the same apex node. Every other slug is its own hub.
case "$node_slug" in
  operator | cogni-template | "") URL="https://cognidao.org/api/v1/cognition" ;;
  *) URL="https://${node_slug}.cognidao.org/api/v1/cognition" ;;
esac

# Bearer = this node's NODE account key (environment first, then ./.env.cogni).
AGENT_KEY="${COGNI_NODE_API_KEY:-$(read_env_file_value COGNI_NODE_API_KEY)}"

# fetch_bundle → prints the .markdown bundle on stdout, or nothing on any failure.
fetch_bundle() {
  if [ -n "$AGENT_KEY" ]; then
    curl -fsS --max-time "$FETCH_TIMEOUT" -H "Authorization: Bearer ${AGENT_KEY}" "$URL" 2>/dev/null \
      | jq -er '.markdown | select(type == "string")' 2>/dev/null
  else
    curl -fsS --max-time "$FETCH_TIMEOUT" "$URL" 2>/dev/null \
      | jq -er '.markdown | select(type == "string")' 2>/dev/null
  fi
}


# write_cache_atomic <content> — replace the cache in one rename, never a torn file.
write_cache_atomic() (
  # Project and stable user hooks share one mutation guard, independently of
  # Codex presentation/thread locks. Recovery must revalidate UNDER this guard:
  # another cold session may have installed a complete bundle during our fetch.
  mkdir -p "$(dirname "$CACHE_FILE")" 2>/dev/null || return 0
  cache_guard="${CACHE_FILE}.write-lock"
  attempts=0
  until mkdir "$cache_guard" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 50 ] || return 0
    sleep 0.02
  done
  trap 'rmdir "$cache_guard" 2>/dev/null || true' EXIT
  if [ "${2:-complete}" = recovery ] && ! cache_is_repo_tracked &&
    bundle_is_complete "$(cat "$CACHE_FILE" 2>/dev/null || true)"; then
    return 0
  fi
  tmp="${CACHE_FILE}.tmp.$$"
  printf '%s\n' "$1" > "$tmp" 2>/dev/null && mv -f "$tmp" "$CACHE_FILE" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
)

# cache_is_stale — true if the cache is missing or older than the refresh TTL.
cache_is_stale() {
  [ -f "$CACHE_FILE" ] || return 0
  [ -z "$(find "$CACHE_FILE" -mmin "-$((REFRESH_TTL_SECONDS / 60))" 2>/dev/null)" ]
}


# refresh_in_background — TTL-gated, fully detached, silent on failure. Its result
# lands in the cache for the NEXT session; it never blocks or writes to stdout.
refresh_in_background() {
  cache_is_stale || return 0
  (
    fresh="$(fetch_bundle)"
    bundle_is_complete "$fresh" && write_cache_atomic "$fresh"
  ) >/dev/null 2>&1 &
}

# PRESENTATION — local-first. If we have ever oriented, boot is offline-safe and
# a hub outage is invisible; we just refresh in the background for next time.
cached_bundle="$(cat "$CACHE_FILE" 2>/dev/null || true)"
if ! cache_is_repo_tracked && bundle_is_complete "$cached_bundle"; then
  emit_agent_context "$cached_bundle"
  refresh_in_background
  exit 0
fi

# FIRST BOOT (no usable untracked cache): this is the only path allowed to touch
# the network in the foreground, and the only one that can surface a notice.
# Bounded fetch.
bundle="$(fetch_bundle)"
if bundle_is_complete "$bundle"; then
  write_cache_atomic "$bundle"
  emit_agent_context "$bundle"
  exit 0
fi

# No complete contract is available. Keep a recovery notice for native Claude/
# OpenCode imports and emit it through Codex. It deliberately fails completeness
# admission, so the next invocation retries the bounded fetch instead of treating
# this notice as normal cognition. A Claude fetch cannot repair the current import.
if [ -z "$AGENT_KEY" ]; then
  recovery_reason="No COGNI_NODE_API_KEY was found. Register a NODE agent through /api/v1/agent/register and save its key in the clone-root .env.cogni."
else
  recovery_reason="A node credential is present, but the request failed or returned no complete agent-contract. Check this node hub health, key principal, and published contract; do not assume a missing key."
fi
recovery="$(cat <<EOF
COGNI COGNITION — BOOTSTRAP RECOVERY (no complete contract)

$recovery_reason

Node cognition endpoint: $URL

This session has no admitted complete contract. Stay in bounded bootstrap recovery;
limit work to diagnosing delivery, restoring node credentials, and warming the
complete bundle. AGENTS.md and skills are not a replacement operating contract.
Do not begin normal task work or invent a response template.

After correcting setup, run scripts/agent/session-cognition.sh once from the
repository root. If recovery persists, report the missing delivery evidence and
specific setup action; do not repeatedly fetch. Once the complete cache is warm,
restart or resume so the native instruction path loads it. Claude imports may
have resolved before this SessionStart fetch; a successful write alone does not
mean the current session received the contract. For Codex, also verify trust of
the SessionStart hook through /hooks.
EOF
)"
write_cache_atomic "$recovery" recovery
# A concurrent successful bootstrap may have won while our fetch was pending.
# Native Claude imports still require restart/resume; Codex can receive this
# now-complete cached contract directly through its selected injection channel.
latest_bundle="$(cat "$CACHE_FILE" 2>/dev/null || true)"
if ! cache_is_repo_tracked && bundle_is_complete "$latest_bundle"; then
  emit_agent_context "$latest_bundle"
else
  emit_agent_context "$recovery"
fi
