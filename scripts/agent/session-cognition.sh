#!/usr/bin/env bash
# Session-start cognition loader — shared by the Claude Code (.claude/settings.json)
# and Codex (.codex/config.toml) SessionStart hooks. Pulls THIS node's own
# cognition bundle and prints it to stdout; both runtimes inject it into context.
# Non-fatal by design: any failure degrades to a loud self-serve prompt.
#
# .env.cogni holds two accounts (see .env.cogni.example): the NODE account
# (this node's own hub — the bearer used here) and the OPERATOR account
# (cognidao.org — CI/CD only: flight, deploy, secrets; never used by this loader).
set -u

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

if [ -n "$AGENT_KEY" ]; then
  bundle="$(curl -fsS --max-time 6 -H "Authorization: Bearer ${AGENT_KEY}" "$URL" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null)"
else
  bundle="$(curl -fsS --max-time 6 "$URL" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null)"
fi

if [ -n "$bundle" ]; then
  printf '%s\n' "$bundle"
else
  cat <<EOF
COGNI COGNITION BOOTSTRAP BLOCKED

The SessionStart hook ran, but it could not fetch the cognition bundle from:
  $URL

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
