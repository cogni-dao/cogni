#!/usr/bin/env bash
# Session-start cognition loader — shared by the Claude Code (.claude/settings.json),
# Codex (.codex/config.toml) and OpenCode (.opencode/plugin) entry points, and by
# Conductor workspace setup. Delivers THIS node's own cognition bundle.
#
# Design: FRESH FIRST, BOUNDED, CACHE FALLBACK (story.0001). Every session start
# fetches the bundle from the node hub with a short timeout, so each session
# works from cognition acquired for it. When the hub is down or slow, the last
# complete cache this checkout fetched (.cogni/.cognition-cache.md) is
# presented instead, so a hub outage never costs a session its contract and the
# hub is not a fleet-wide boot dependency (bug.5122). Only a boot with no
# complete bundle surfaces a short, honest recovery notice that
# separates "no credentials yet" from a key-present failure.
#
# .env.cogni holds two accounts (see .env.cogni.example): the NODE account
# (this node's own hub — the bearer used here) and the OPERATOR account
# (cognidao.org — CI/CD only: flight, deploy, secrets; never used by this loader).
set -u

CACHE_FILE=".cogni/.cognition-cache.md"
FETCH_TIMEOUT=6           # bound workspace setup's --refresh fetch
SESSION_FETCH_TIMEOUT=4   # bound the fetch on every session start
# Claude Code keeps a SessionStart context entry inline only up to ~10,000
# characters and persists a larger one to a file behind a 2 KB preview. Each
# --claude-part hook therefore carries one slice of at most this many bytes;
# .claude/settings.json declares CLAUDE_PARTS of them.
CLAUDE_PART_BYTES=9200
CLAUDE_PARTS=8

# Hooks may start from a subdirectory. Resolve every repo-relative path from the
# git root so credentials, repo-spec, and the durable cache never depend on cwd.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0


# emit_agent_context <text> — Codex reads raw hook stdout as developer context,
# and .codex/config.toml `additionalContextLimit = 0` disables its head/tail
# spill, so the full payload lands untruncated. Claude gets its bundle through
# the --claude-part hooks; OpenCode through its instruction file.
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

# fetch_bundle [timeout] → prints the .markdown bundle on stdout, or nothing on
# any failure.
fetch_bundle() {
  timeout="${1:-$FETCH_TIMEOUT}"
  if [ -n "$AGENT_KEY" ]; then
    curl -fsS --max-time "$timeout" -H "Authorization: Bearer ${AGENT_KEY}" "$URL" 2>/dev/null \
      | jq -r '.markdown // empty' 2>/dev/null
  else
    curl -fsS --max-time "$timeout" "$URL" 2>/dev/null \
      | jq -r '.markdown // empty' 2>/dev/null
  fi
}

# write_cache_atomic <content> — replace the cache in one rename, never a torn
# file, and only with a complete bundle: an incomplete hub response never
# replaces the last complete one (bug.0024).
write_cache_atomic() {
  bundle_is_complete "$1" || return 1
  write_file_atomic "$CACHE_FILE" "$1"
}

write_file_atomic() {
  mkdir -p "$(dirname "$1")" 2>/dev/null || return 0
  tmp="${1}.tmp.$$"
  printf '%s\n' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$1" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
}

# bundle_is_complete <text> — carries the agent-contract and its status-contract.
bundle_is_complete() {
  case "$1" in *"<agent-contract"*"<status-contract"*) return 0 ;; esac
  return 1
}

# A cognition snapshot committed to git is not a cache: every new workspace
# would inherit whatever contract happened to be current at that commit. Treat
# tracked snapshots as absent.
cache_is_repo_tracked() {
  git ls-files --error-unmatch -- "$CACHE_FILE" >/dev/null 2>&1
}

# session_bundle — the bundle this session presents: fetched from the hub now,
# else this checkout's last complete cache. Prints nothing when neither exists.
session_bundle() {
  fresh="$(fetch_bundle "$SESSION_FETCH_TIMEOUT")"
  if write_cache_atomic "$fresh"; then
    printf '%s\n' "$fresh"
    return 0
  fi
  if [ -s "$CACHE_FILE" ] && ! cache_is_repo_tracked; then
    cached="$(cat "$CACHE_FILE")"
    if bundle_is_complete "$cached"; then
      printf '%s\n' "$cached"
      return 0
    fi
  fi
  return 1
}

# recovery_notice — no complete bundle anywhere. Be honest, never cry wolf:
# separate a setup gap (no key) from a key-present failure.
recovery_notice() {
  if [ -z "$AGENT_KEY" ]; then
    cat <<EOF
COGNI COGNITION — no node credentials yet (first boot)

No COGNI_NODE_API_KEY was found, so this session could not load its cognition
bundle from:
  $URL

This is a setup step, not an outage. To bootstrap:
- register a NODE agent via /api/v1/agent/register
- save COGNI_NODE_API_KEY in the clone-root .env.cogni
- for Codex, review and trust the repo's SessionStart hook via /hooks

Then restart or resume the agent.
EOF
  else
    cat <<EOF
COGNI COGNITION — could not load bundle (no complete cache)

A credential IS present, so this is NOT a missing-key setup problem. Either the
hub is down/slow, or the key lacks a principal on this hub (or the node has no
cognition published yet), and this checkout has no complete cached bundle.

Check hub health and that GET $URL resolves with your key. Stay in bootstrap
recovery (AGENTS.md) until it loads, then restart or resume the agent.
EOF
  fi
}

# claude_part_of <text> <part> — prints the slice count on its first line, then
# slice <part>. Slices end at "## " section boundaries; a section larger than
# one slice is split at line boundaries. awk length() may count bytes, which
# only makes slices smaller.
claude_part_of() {
  printf '%s\n' "$1" | awk -v want="$2" -v limit="$CLAUDE_PART_BYTES" '
    function flush_section() {
      if (sec == "") return
      if (cur != "" && length(cur) + length(sec) > limit) { parts[++n] = cur; cur = "" }
      if (length(sec) <= limit) { cur = cur sec; sec = ""; return }
      # Oversized section: pack its lines.
      m = split(sec, lines, "\n")
      for (i = 1; i < m; i++) {
        l = lines[i] "\n"
        if (cur != "" && length(cur) + length(l) > limit) { parts[++n] = cur; cur = "" }
        cur = cur l
      }
      sec = ""
    }
    /^## / { flush_section() }
    { sec = sec $0 "\n" }
    END {
      flush_section()
      if (cur != "") parts[++n] = cur
      print n
      if (want <= n) printf "%s", parts[want]
    }
  '
}

# --cached-contract — the Stop-hook validator (validate-status-contract.sh):
# print only the status-contract block of the last complete local cache. Strictly
# read-only: never fetches, refreshes, or takes a hook lock. Prints nothing when
# there is no admitted cache, which makes the validator a no-op.
if [ "${1:-}" = "--cached-contract" ]; then
  cache_is_repo_tracked && exit 0
  [ -s "$CACHE_FILE" ] || exit 0
  cached="$(cat "$CACHE_FILE")"
  bundle_is_complete "$cached" || exit 0
  printf '%s\n' "$cached" | awk '/<status-contract/ { p = 1 } p { print } /<\/status-contract>/ { p = 0 }'
  exit 0
fi

# --refresh — workspace setup and the OpenCode plugin: a bounded foreground
# fetch. Exits 0 only when a complete bundle was written, and never replaces a
# complete cache with an incomplete response.
if [ "${1:-}" = "--refresh" ]; then
  cache_is_repo_tracked && exit 1
  write_cache_atomic "$(fetch_bundle)" || exit 1
  exit 0
fi

# --claude-part <i> — one of CLAUDE_PARTS Claude Code SessionStart hooks, which
# run concurrently on every startup/resume/clear/compact. Part 1 acquires this
# event's bundle once and leaves a per-session snapshot; every part then sends
# its own slice, labelled, so the model reads one document in order.
if [ "${1:-}" = "--claude-part" ]; then
  part="${2:-1}"
  started=$(date +%s)
  hook_input="$(cat 2>/dev/null)"
  session_id="$(printf '%s' "$hook_input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | tr -cd '[:alnum:]_-')"
  snapshot="${TMPDIR:-/tmp}/cogni-cognition-claude-${session_id:-unknown}.md"
  if [ "$part" = 1 ]; then
    text="$(session_bundle || recovery_notice)"
    write_file_atomic "$snapshot" "$text"
  fi
  # Wait for this event's snapshot (part 1's fetch is bounded).
  waited=0
  while :; do
    if [ -s "$snapshot" ] && [ "$(date -r "$snapshot" +%s 2>/dev/null || echo 0)" -ge $((started - 10)) ]; then
      break
    fi
    [ "$waited" -ge 150 ] && exit 0
    sleep 0.1
    waited=$((waited + 1))
  done
  text="$(cat "$snapshot")"
  # The trailing x keeps the slice's own trailing newlines through $(...).
  sliced="$(claude_part_of "$text" "$part"; printf x)"
  total="${sliced%%
*}"
  [ "$part" -le "$total" ] 2>/dev/null || exit 0
  body="${sliced#*
}"
  body="${body%x}"
  note=""
  if [ "$part" = "$CLAUDE_PARTS" ] && [ "$total" -gt "$CLAUDE_PARTS" ]; then
    note="
COGNI COGNITION — the bundle needs $total parts but only $CLAUDE_PARTS are declared; parts after $CLAUDE_PARTS are missing. Raise CLAUDE_PARTS and the matching hooks in .claude/settings.json."
  fi
  # Finish in part order: concurrent hooks are recorded as they complete.
  sleep "$(awk -v p="$part" 'BEGIN { print (p - 1) * 0.25 }')"
  printf 'COGNI COGNITION — part %s of %s of this session'"'"'s cognition bundle. Read all %s parts together, in part order, as one document.\n\n%s%s' \
    "$part" "$total" "$total" "$body" "$note" > "$snapshot.part$part"
  # Claude also adds plain SessionStart stdout to context; JSON is preferred.
  if command -v jq >/dev/null 2>&1; then
    jq -Rs '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}' < "$snapshot.part$part"
  else
    cat "$snapshot.part$part"
  fi
  rm -f "$snapshot.part$part"
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

# Codex (stdout) and any other caller: present this session's bundle.
if bundle="$(session_bundle)"; then
  emit_agent_context "$bundle"
  exit 0
fi
emit_agent_context "$(recovery_notice)"
