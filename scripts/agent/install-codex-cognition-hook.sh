#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/agent/install-codex-cognition-hook.sh
# Purpose: Install a stable user-level Codex SessionStart hook for Cogni cognition.
# Scope: User machine bootstrap only; does not change repo-local Codex project config.
# Side-effects: writes ~/.codex/hooks/cogni-session-cognition.sh and adds one marked
#   block to ~/.codex/config.toml when missing.

set -euo pipefail

COGNI_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
HOOK_DIR="$COGNI_CODEX_HOME/hooks"
HOOK_PATH="$HOOK_DIR/cogni-session-cognition.sh"
CONFIG_PATH="$COGNI_CODEX_HOME/config.toml"

mkdir -p "$HOOK_DIR"
# Copy the shared implementation into trusted user-owned storage. The generic
# hook must never execute a helper from the repository it is opening.
cp "$(dirname "${BASH_SOURCE[0]}")/configured-cognition.mjs" "$HOOK_DIR/.configured-cognition.mjs.tmp.$$"
mv -f "$HOOK_DIR/.configured-cognition.mjs.tmp.$$" "$HOOK_DIR/configured-cognition.mjs"

cat >"$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Cogni user-level Codex SessionStart hook.
#
# Keep this script user-owned and generic: it may run in many repos, so it reads
# only stable Cogni node metadata and never executes repo-local hook code.
set -u

CACHE_FILE=".cogni/.cognition-cache.md"
REFRESH_TTL_SECONDS=900
FETCH_TIMEOUT=6

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  exit 0
fi
cd "$repo_root" || exit 0

# Detector reads must stay free of credential-link/setup mutations.
if [[ "${1:-}" = --cached-contract && ( -e .cogni/cognition-sources.json || -L .cogni/cognition-sources.json ) ]]; then
  exec node "$(dirname "${BASH_SOURCE[0]}")/configured-cognition.mjs" --cached-contract
fi

read_env_file_value() {
  local var_name="$1"
  local env_file="${2:-.env.cogni}"
  [[ -f "$env_file" ]] || return 0
  awk -F= -v key="$var_name" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\''"]|["'\''"]$/, "", value)
      print value
      exit
    }
  ' "$env_file" 2>/dev/null
}

valid_env_cogni() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  [[ -n "$(read_env_file_value COGNI_NODE_API_KEY "$file")" ]]
}

derive_auth_root() {
  if [[ -n "${COGNI_NODE_AUTH_ROOT:-}" ]]; then
    printf '%s\n' "$COGNI_NODE_AUTH_ROOT"
    return 0
  fi
  if [[ -n "${CONDUCTOR_ROOT_PATH:-}" ]]; then
    printf '%s\n' "$CONDUCTOR_ROOT_PATH"
    return 0
  fi

  local common_dir
  common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  (cd "$(dirname "$common_dir")" && pwd)
}

ensure_env_cogni_link() {
  valid_env_cogni ".env.cogni" && return 0

  local auth_root
  auth_root="$(derive_auth_root || true)"
  [[ -n "$auth_root" && "$auth_root" != "$repo_root" ]] || return 0
  valid_env_cogni "$auth_root/.env.cogni" || return 0
  [[ ! -e ".env.cogni" || -L ".env.cogni" ]] || return 0

  ln -sfn "$auth_root/.env.cogni" ".env.cogni" 2>/dev/null || true
}

if [[ -e .cogni/cognition-sources.json || -L .cogni/cognition-sources.json ]]; then
  # Invalid/missing node metadata must produce configured recovery as it does in
  # the project hook; never silently skip an explicitly configured profile.
  [[ ! -f .cogni/repo-spec.yaml ]] || ensure_env_cogni_link
  helper="$(dirname "${BASH_SOURCE[0]}")/configured-cognition.mjs"
  if command -v node >/dev/null 2>&1 && [[ -f "$helper" ]]; then
    exec node "$helper" "${1:---codex}"
  fi
  printf '%s\n' "COGNI COGNITION — BOOTSTRAP RECOVERY (no complete contract): configured context requires Node.js and the installed shared helper. Repair setup, warm once, then restart/resume."
  exit 0
fi

if [[ ! -f .cogni/repo-spec.yaml ]]; then
  exit 0
fi

ensure_env_cogni_link

# A versioned project hook may match the same Codex event. The two presenters
# share this short-lived lock so only one emits context; it is released for the
# next resume/clear/compact event.
codex_session_id="${CODEX_THREAD_ID:-}"
if [[ -z "$codex_session_id" && ! -t 0 ]]; then
  codex_hook_input="$(cat)"
  codex_session_id="$(printf '%s' "$codex_hook_input" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi
if [[ -n "$codex_session_id" ]]; then
  safe_thread_id="$(printf '%s' "$codex_session_id" | tr -cd '[:alnum:]_-')"
  COGNI_HOOK_LOCK="${TMPDIR:-/tmp}/cogni-cognition-${safe_thread_id}.lock"
  mkdir "$COGNI_HOOK_LOCK" 2>/dev/null || exit 0
  trap 'rmdir "$COGNI_HOOK_LOCK" 2>/dev/null || true' EXIT
fi

node_slug="$(awk '
  /^intent:/ { in_intent = 1; next }
  in_intent && /^[^[:space:]]/ { in_intent = 0 }
  in_intent && /^[[:space:]]+name:/ {
    sub(/^[[:space:]]+name:[[:space:]]*/, ""); gsub(/["'\''"]/, ""); print; exit
  }
' .cogni/repo-spec.yaml 2>/dev/null)"

case "$node_slug" in
  operator | cogni-template | "") url="https://cognidao.org/api/v1/cognition" ;;
  *) url="https://${node_slug}.cognidao.org/api/v1/cognition" ;;
esac

agent_key="${COGNI_NODE_API_KEY:-$(read_env_file_value COGNI_NODE_API_KEY)}"

fetch_bundle() {
  if [[ -n "$agent_key" ]]; then
    curl -fsS --max-time "$FETCH_TIMEOUT" -H "Authorization: Bearer ${agent_key}" "$url" 2>/dev/null \
      | jq -er '.markdown | select(type == "string")' 2>/dev/null
  else
    curl -fsS --max-time "$FETCH_TIMEOUT" "$url" 2>/dev/null \
      | jq -er '.markdown | select(type == "string")' 2>/dev/null
  fi
}

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

cache_is_stale() {
  [[ -f "$CACHE_FILE" ]] || return 0
  [[ -z "$(find "$CACHE_FILE" -mmin "-$((REFRESH_TTL_SECONDS / 60))" 2>/dev/null)" ]]
}

# A repository snapshot is not a cache. Trusting one makes every fresh
# worktree inject the contract from the git commit instead of current Dolt.
cache_is_repo_tracked() {
  git ls-files --error-unmatch -- "$CACHE_FILE" >/dev/null 2>&1
}

refresh_in_background() {
  cache_is_stale || return 0
  (
    local fresh
    fresh="$(fetch_bundle)"
    bundle_is_complete "$fresh" && write_cache_atomic "$fresh"
  ) >/dev/null 2>&1 &
}

# Codex user hook: raw stdout is the developer-context channel, and the managed
# config block disables Codex's spill (additionalContextLimit = 0), so the full
# bundle surfaces at any size. No producer-side byte ceiling (story.5070).
bundle="$(cat "$CACHE_FILE" 2>/dev/null || true)"
if ! cache_is_repo_tracked && bundle_is_complete "$bundle"; then
  printf '%s\n' "$bundle"
  refresh_in_background
  exit 0
fi

bundle="$(fetch_bundle)"

if bundle_is_complete "$bundle"; then
  write_cache_atomic "$bundle"
  printf '%s\n' "$bundle"
  exit 0
fi

# No complete contract is available. Keep a recovery notice for native Claude/
# OpenCode imports and emit it through Codex. It deliberately fails completeness
# admission, so the next invocation retries the bounded fetch instead of treating
# this notice as normal cognition. A Claude fetch cannot repair the current import.
if [ -z "$agent_key" ]; then
  recovery_reason="No COGNI_NODE_API_KEY was found. Register a NODE agent through /api/v1/agent/register and save its key in the clone-root .env.cogni."
else
  recovery_reason="A node credential is present, but the request failed or returned no complete agent-contract. Check this node hub health, key principal, and published contract; do not assume a missing key."
fi
recovery="$(cat <<EOF
COGNI COGNITION — BOOTSTRAP RECOVERY (no complete contract)

$recovery_reason

Node cognition endpoint: $url

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
latest_bundle="$(cat "$CACHE_FILE" 2>/dev/null || true)"
if ! cache_is_repo_tracked && bundle_is_complete "$latest_bundle"; then
  printf '%s\n' "$latest_bundle"
else
  printf '%s\n' "$recovery"
fi

HOOK

chmod +x "$HOOK_PATH"
touch "$CONFIG_PATH"

# Reconcile instead of append: early installer versions wrote an unmarked
# startup|resume-only block. Codex loads every matching user + project hook, so
# leaving that block behind duplicates the entire cognition bundle. Remove any
# SessionStart handler that invokes our exact managed script, preserve unrelated
# handlers, then append one canonical all-sources block with no Codex spill.
node - "$CONFIG_PATH" "$HOOK_PATH" <<'NODE'
const fs = require("node:fs");
const [configPath, hookPath] = process.argv.slice(2);
let text = fs.readFileSync(configPath, "utf8");

text = text.replace(
  /\n?# BEGIN COGNI CODEX COGNITION HOOK[\s\S]*?# END COGNI CODEX COGNITION HOOK\n?/g,
  "\n"
);

const starts = [...text.matchAll(/^\[\[hooks\.SessionStart\]\]$/gm)].map(
  (match) => match.index
);
for (let i = starts.length - 1; i >= 0; i -= 1) {
  const start = starts[i];
  const tail = text.slice(start);
  const firstLineEnd = tail.indexOf("\n") + 1;
  // Only nested handlers belong to this event; every other table or array
  // starts untouched config that must survive removal of a managed handler.
  const next = tail
    .slice(firstLineEnd)
    .search(/^[ \t]*\[(?!\[hooks\.SessionStart\.hooks\]\][ \t]*(?:#.*)?$)/m);
  const end =
    next === -1 ? text.length : start + firstLineEnd + next;
  const block = text.slice(start, end);
  if (!block.includes(hookPath)) continue;

  const handlerMarker = "[[hooks.SessionStart.hooks]]";
  const pieces = block.split(handlerMarker);
  const header = pieces.shift() ?? "";
  const unrelated = pieces.filter((piece) => !piece.includes(hookPath));
  const replacement = unrelated.length
    ? `${header}${unrelated.map((piece) => handlerMarker + piece).join("")}`
    : "";
  text = text.slice(0, start) + replacement + text.slice(end);
}

const escaped = hookPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
text = `${text.trimEnd()}\n\n# BEGIN COGNI CODEX COGNITION HOOK\n[[hooks.SessionStart]]\nmatcher = "startup|resume|clear|compact"\n\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "bash \\"${escaped}\\""\nstatusMessage = "Loading Cogni cognition substrate"\nadditionalContextLimit = 0\n# END COGNI CODEX COGNITION HOOK\n`;

const tmp = `${configPath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, text);
fs.renameSync(tmp, configPath);
NODE

cat <<EOF
Installed Cogni Codex cognition hook:
  $HOOK_PATH

Configured Codex user config:
  $CONFIG_PATH

Next step: open /hooks in Codex once and trust the user-level SessionStart hook.
EOF
