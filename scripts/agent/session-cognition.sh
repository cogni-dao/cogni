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
#     because a stale-but-present bundle always beats a network stall or a scary
#     wall. Once a session has ever oriented, a hub outage is invisible here.
# Only genuine first-boot with no cache surfaces a short, honest notice, and it
# never cries wolf: it separates absent local credentials, HTTP rejection,
# transport failure, and malformed responses without diagnosing an outage.
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
#     Its hook is therefore write-only; the committed AGENTS.md floor covers a
#     cold first boot and the warmed cache supplies the rich contract thereafter.
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

# fetch_bundle sets bundle on success or FETCH_FAILURE on failure.
# Capture status separately from the body; never emit response bodies or credentials
# on a failed fetch. One request preserves the six-second first-boot bound.
fetch_bundle() {
  bundle=""
  FETCH_FAILURE=""
  local response curl_status http_status body
  if [ -n "$AGENT_KEY" ]; then
    response="$(curl -fsS --max-time "$FETCH_TIMEOUT" -w '\n%{http_code}' -H "Authorization: Bearer ${AGENT_KEY}" "$URL" 2>/dev/null)"
    curl_status=$?
  else
    response="$(curl -fsS --max-time "$FETCH_TIMEOUT" -w '\n%{http_code}' "$URL" 2>/dev/null)"
    curl_status=$?
  fi
  http_status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [ "$curl_status" -ne 0 ] && [ "$curl_status" -ne 22 ]; then
    FETCH_FAILURE="Transport/client failure (curl exit $curl_status); hub availability is unconfirmed."
  elif [ "$http_status" = 401 ] || [ "$http_status" = 403 ]; then
    FETCH_FAILURE="HTTP $http_status: authentication or authorization rejected; this is not evidence of a hub outage."
  elif [[ "$http_status" != 2[0-9][0-9] ]]; then
    FETCH_FAILURE="HTTP $http_status: cognition request failed; check the node before diagnosing an outage."
  elif ! bundle="$(printf '%s' "$body" | jq -er '.markdown | select(type == "string") | select(test("[^[:space:]]"))' 2>/dev/null)"; then
    bundle=""
    FETCH_FAILURE="HTTP $http_status: malformed response or missing/non-string/empty markdown bundle."
  fi
}

# write_cache_atomic <content> — replace the cache in one rename, never a torn file.
write_cache_atomic() {
  mkdir -p "$(dirname "$CACHE_FILE")" 2>/dev/null || return 0
  tmp="${CACHE_FILE}.tmp.$$"
  printf '%s\n' "$1" > "$tmp" 2>/dev/null && mv -f "$tmp" "$CACHE_FILE" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
}

# cache_is_stale — true if the cache is missing or older than the refresh TTL.
cache_is_stale() {
  [ -f "$CACHE_FILE" ] || return 0
  [ -z "$(find "$CACHE_FILE" -mmin "-$((REFRESH_TTL_SECONDS / 60))" 2>/dev/null)" ]
}

# A cognition snapshot committed to git is not a cache: every new workspace
# would inherit whatever contract happened to be current at that commit, then
# present it before the async refresh. Treat tracked snapshots as absent so a
# fresh workspace fetches live cognition before its first agent reply.
cache_is_repo_tracked() {
  git ls-files --error-unmatch -- "$CACHE_FILE" >/dev/null 2>&1
}

# refresh_in_background — TTL-gated, fully detached, silent on failure. Its result
# lands in the cache for the NEXT session; it never blocks or writes to stdout.
refresh_in_background() {
  cache_is_stale || return 0
  (
    fetch_bundle
    fresh="$bundle"
    [ -n "$fresh" ] && write_cache_atomic "$fresh"
  ) >/dev/null 2>&1 &
}

# PRESENTATION — local-first. If we have ever oriented, boot is offline-safe and
# a hub outage is invisible; we just refresh in the background for next time.
if [ -f "$CACHE_FILE" ] && [ -s "$CACHE_FILE" ] && ! cache_is_repo_tracked; then
  emit_agent_context "$(cat "$CACHE_FILE")"
  refresh_in_background
  exit 0
fi

# FIRST BOOT (no usable untracked cache): this is the only path allowed to touch
# the network in the foreground, and the only one that can surface a notice.
# Bounded fetch.
fetch_bundle
if [ -n "$bundle" ]; then
  write_cache_atomic "$bundle"
  emit_agent_context "$bundle"
  exit 0
fi

# A failed hook cannot determine what another native instruction path already
# loaded. Recovery is agent-owned; a failed fetch is not a stop instruction.
if [ -z "$AGENT_KEY" ]; then
  recovery_reason="No COGNI_NODE_API_KEY was found in the environment or worktree .env.cogni. Inspect the existing clone-root credential and worktree link before concluding credentials are missing."
else
  recovery_reason="A node credential is present. Reuse it; do not register a replacement identity or overwrite credentials because this request failed."
fi
emit_agent_context "$(cat <<EOF
COGNI COGNITION — bounded recovery required

The SessionStart fetch did not load cognition from:
  $URL
$FETCH_FAILURE
$recovery_reason

Own recovery before asking the human to act. Inspect local node URL, credential
presence/link, and hook delivery without printing secrets. Then make at most two
additional requests, each bounded to six seconds: this node's /version and one
cognition retry using existing credentials. Preserve every usable cached bundle.
Do not create a new identity, replace keys, or loosen authentication automatically.

If a complete cognition contract is already loaded through native instructions,
continue authorized work under it while repairing this fetch. If no complete
contract is loaded, continue bounded recovery, local diagnostics, and authorized
bootstrap repairs under the committed safety floor; do not claim normal contract
readiness or invent a replacement contract. A failed request alone proves neither
an outage nor missing credentials.

After recovery, verify native contract delivery. Request human action only for a
specific remaining dependency outside your authority, supported by the observed
failure. Restart/resume is needed only when a repaired native import cannot load
in the current session (for example Claude's already-resolved imports), not as a
default response to a failed fetch. This notice proves the hook ran; hook trust
is only a diagnosis when the hook did not run. Report recovery evidence concisely.
EOF
)"
