#!/usr/bin/env bash
# Session-start cognition substrate loader — shared by the Claude Code
# (.claude/settings.json) and Codex (.codex/config.toml) SessionStart hooks.
# Pulls the node's kickstart bundle and prints it to stdout; both runtimes inject
# SessionStart stdout into agent context. Non-fatal by design: any failure
# degrades to a one-line self-serve hint so a session never blocks on the network.
#
# URL resolution is repo-spec only (no per-node env override):
#   1. this node's own hub, derived from .cogni/repo-spec.yaml `intent.name`
#      (operator -> apex cognidao.org; any other slug -> <slug>.cognidao.org)
#   2. operator fallback, so a node whose own hub isn't deployed yet still gets
#      the shared Cogni contract instead of nothing.
#
# Credentials load from the environment first, then ./.env.cogni. Conductor
# worktree setup symlinks .env.cogni from the primary checkout, so future
# sessions need only the one-time bootstrap that registers the agent and saves
# its key there.
set -u

OPERATOR_URL="https://cognidao.org/api/v1/cognition"

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

agent_key() {
  if [ -n "${COGNI_API_KEY:-}" ]; then
    printf '%s\n' "$COGNI_API_KEY"
    return
  fi

  key="$(read_env_file_value COGNI_API_KEY)"
  if [ -n "$key" ]; then
    printf '%s\n' "$key"
    return
  fi

  # Current local Cogni worktrees keep env-scoped keys in .env.cogni. The
  # session-start loader targets production URLs, so use the production key.
  key="$(read_env_file_value COGNI_API_KEY_PROD)"
  if [ -n "$key" ]; then
    printf '%s\n' "$key"
  fi
}

# node slug from repo-spec intent.name (root .cogni/repo-spec.yaml in any node repo)
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

# operator is the apex (cognidao.org); the operator monorepo's root repo-spec
# carries the repo slug `cogni-template`, which is the same apex node.
case "$node_slug" in
  operator | cogni-template | "") node_url="$OPERATOR_URL" ;;
  *) node_url="https://${node_slug}.cognidao.org/api/v1/cognition" ;;
esac

URL="$node_url"
AGENT_KEY="$(agent_key)"

# Pass the agent key as a bearer when present; without it, auth-gated cognition
# requests 401 and fall through to the self-serve hint below.
fetch() {
  if [ -n "$AGENT_KEY" ]; then
    curl -fsS --max-time 6 -H "Authorization: Bearer ${AGENT_KEY}" "$1" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null
  else
    curl -fsS --max-time 6 "$1" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null
  fi
}

bundle="$(fetch "$URL")"

# Pre-deploy node: its own hub isn't live yet — fall back to the operator's.
if [ -z "$bundle" ] && [ "$URL" != "$OPERATOR_URL" ]; then
  bundle="$(fetch "$OPERATOR_URL")"
  [ -n "$bundle" ] && URL="$OPERATOR_URL"
fi

if [ -n "$bundle" ]; then
  printf '%s\n' "$bundle"
else
  printf '(cognition substrate unreachable at %s — self-serve: register via /api/v1/agent/register, save COGNI_API_KEY in .env.cogni, then retry)\n' "$URL"
fi
