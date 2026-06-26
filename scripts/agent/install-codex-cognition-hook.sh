#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/agent/install-codex-cognition-hook.sh
# Purpose: Install a stable user-level Codex SessionStart hook for Cogni cognition.
# Scope: User machine bootstrap only; does not change repo-local Codex project config.
# Side-effects: writes ~/.codex/hooks/cogni-session-cognition.sh and adds one marked
#   block to ~/.codex/config.toml when missing.

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
HOOK_DIR="$CODEX_HOME/hooks"
HOOK_PATH="$HOOK_DIR/cogni-session-cognition.sh"
CONFIG_PATH="$CODEX_HOME/config.toml"

mkdir -p "$HOOK_DIR"

cat >"$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Cogni user-level Codex SessionStart hook.
#
# Keep this script user-owned and generic: it may run in many repos, so it reads
# only stable Cogni node metadata and never executes repo-local hook code.
set -u

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  exit 0
fi
cd "$repo_root" || exit 0

if [[ ! -f .cogni/repo-spec.yaml ]]; then
  exit 0
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

if [[ -n "$agent_key" ]]; then
  bundle="$(curl -fsS --max-time 6 -H "Authorization: Bearer ${agent_key}" "$url" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null)"
else
  bundle="$(curl -fsS --max-time 6 "$url" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null)"
fi

if [[ -n "$bundle" ]]; then
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
- for Codex, run pnpm codex:cognition:install once and trust the user-level hook with /hooks

If the agent received no bootstrap message at all, the hook probably did not run
(for Codex, missing hook trust is the usual cause).
EOF
fi
HOOK

chmod +x "$HOOK_PATH"
touch "$CONFIG_PATH"

if ! grep -Fq 'BEGIN COGNI CODEX COGNITION HOOK' "$CONFIG_PATH"; then
  escaped_hook_path="${HOOK_PATH//\\/\\\\}"
  escaped_hook_path="${escaped_hook_path//\"/\\\"}"
  cat >>"$CONFIG_PATH" <<EOF

# BEGIN COGNI CODEX COGNITION HOOK
[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "bash \"$escaped_hook_path\""
statusMessage = "Loading Cogni cognition substrate"
# END COGNI CODEX COGNITION HOOK
EOF
fi

cat <<EOF
Installed Cogni Codex cognition hook:
  $HOOK_PATH

Configured Codex user config:
  $CONFIG_PATH

Next step: open /hooks in Codex once and trust the user-level SessionStart hook.
EOF
