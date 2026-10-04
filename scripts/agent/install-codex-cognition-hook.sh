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

cat >"$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Cogni user-level Codex SessionStart hook.
#
# Keep this script user-owned and generic: it may run in many repos, so it reads
# only stable Cogni node metadata and never executes repo-local hook code.
set -u

SESSION_COGNITION_MAX_BYTES=16384
CACHE_FILE=".cogni/.cognition-cache.md"
REFRESH_TTL_SECONDS=900
FETCH_TIMEOUT=6

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  exit 0
fi
cd "$repo_root" || exit 0

if [[ ! -f .cogni/repo-spec.yaml ]]; then
  exit 0
fi

# A versioned project hook may match the same Codex event. The two presenters
# share this short-lived lock so only one emits context; it is released for the
# next resume/clear/compact event.
if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
  safe_thread_id="$(printf '%s' "$CODEX_THREAD_ID" | tr -cd '[:alnum:]_-')"
  COGNI_HOOK_LOCK="${TMPDIR:-/tmp}/cogni-cognition-${safe_thread_id}.lock"
  mkdir "$COGNI_HOOK_LOCK" 2>/dev/null || exit 0
  trap 'rmdir "$COGNI_HOOK_LOCK" 2>/dev/null || true' EXIT
fi

bundle_bytes() {
  printf '%s\n' "$1" | LC_ALL=C wc -c | tr -d '[:space:]'
}

bundle_fits_budget() {
  [[ "$(bundle_bytes "$1")" -le "$SESSION_COGNITION_MAX_BYTES" ]]
}

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

ensure_env_cogni_link

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
      | jq -r '.markdown // empty' 2>/dev/null
  else
    curl -fsS --max-time "$FETCH_TIMEOUT" "$url" 2>/dev/null \
      | jq -r '.markdown // empty' 2>/dev/null
  fi
}

write_cache_atomic() {
  mkdir -p "$(dirname "$CACHE_FILE")" 2>/dev/null || return 0
  local tmp="${CACHE_FILE}.tmp.$$"
  printf '%s\n' "$1" >"$tmp" 2>/dev/null && mv -f "$tmp" "$CACHE_FILE" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
}

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
    [[ -n "$fresh" ]] && bundle_fits_budget "$fresh" && write_cache_atomic "$fresh"
  ) >/dev/null 2>&1 &
}

oversized_bundle_notice() {
  local actual_bytes="$1"
  local source_name="$2"
  cat <<EOF
COGNI COGNITION — bundle rejected before injection

The $source_name bundle is $actual_bytes bytes, above the strict
$SESSION_COGNITION_MAX_BYTES-byte SessionStart ceiling. Nothing was truncated
or partially injected. Reduce the node orientation/index at $url, then restart
or resume the agent.
EOF
}

if [[ -s "$CACHE_FILE" ]] && ! cache_is_repo_tracked; then
  bundle="$(cat "$CACHE_FILE")"
  if bundle_fits_budget "$bundle"; then
    printf '%s\n' "$bundle"
    refresh_in_background
    exit 0
  fi
  oversized_bundle_notice "$(bundle_bytes "$bundle")" "cached"
  refresh_in_background
  exit 0
fi

bundle="$(fetch_bundle)"

if [[ -n "$bundle" ]]; then
  if ! bundle_fits_budget "$bundle"; then
    oversized_bundle_notice "$(bundle_bytes "$bundle")" "fetched"
    exit 0
  fi
  write_cache_atomic "$bundle"
  printf '%s\n' "$bundle"
else
  cat <<EOF
COGNI COGNITION BOOTSTRAP BLOCKED

The SessionStart hook ran, but it could not fetch the cognition bundle from:
  $url

Do not continue silently. Tell the user that session cognition did not load and
ask them to bootstrap the node credentials, then restart or resume the agent.

Most common fixes:
- register a NODE agent via /api/v1/agent/register
- save COGNI_NODE_API_KEY in the clone-root .env.cogni
- review and trust this user-level SessionStart hook via /hooks

If the agent received no bootstrap message at all, the hook probably did not run
(for Codex, missing hook trust is the usual cause).
EOF
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
  const next = tail
    .slice(firstLineEnd)
    .search(/^\[\[hooks\.SessionStart\]\]$|^\[(?!\[)/m);
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
