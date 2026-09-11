#!/usr/bin/env bash
# Session-start cognition loader — shared by the Claude Code (.claude/settings.json)
# and Codex (.codex/config.toml) SessionStart hooks. Presents THIS node's own
# cognition bundle on stdout; both runtimes inject it into context.
#
# Design: LOCAL-FIRST PRESENT + ASYNC REFRESH. The hook fires on every
# startup/resume/compact and on every process respawn — so it must NEVER put a
# live call to the apex hub on the boot path. Acquisition (fetch) and
# presentation (inject) are separate concerns:
#   - presentation reads a durable local cache (.cogni/.cognition-cache.md) and
#     is pure-offline, instant, and deterministic;
#   - acquisition is a backgrounded, TTL-gated refresh whose failure is silent,
#     because a stale-but-present bundle always beats a network stall or a scary
#     wall. Once a session has ever oriented, a hub outage is invisible here.
# Only genuine first-boot with no cache surfaces a short, honest notice, and it
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
      | jq -r '.markdown // empty' 2>/dev/null
  else
    curl -fsS --max-time "$FETCH_TIMEOUT" "$URL" 2>/dev/null \
      | jq -r '.markdown // empty' 2>/dev/null
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

# refresh_in_background — TTL-gated, fully detached, silent on failure. Its result
# lands in the cache for the NEXT session; it never blocks or writes to stdout.
refresh_in_background() {
  cache_is_stale || return 0
  (
    fresh="$(fetch_bundle)"
    [ -n "$fresh" ] && write_cache_atomic "$fresh"
  ) >/dev/null 2>&1 &
}

# PRESENTATION — local-first. If we have ever oriented, boot is offline-safe and
# a hub outage is invisible; we just refresh in the background for next time.
if [ -f "$CACHE_FILE" ] && [ -s "$CACHE_FILE" ]; then
  cat "$CACHE_FILE"
  refresh_in_background
  exit 0
fi

# FIRST BOOT (no cache): this is the only path allowed to touch the network in
# the foreground, and the only one that can surface a notice. Bounded fetch.
bundle="$(fetch_bundle)"
if [ -n "$bundle" ]; then
  write_cache_atomic "$bundle"
  printf '%s\n' "$bundle"
  exit 0
fi

# First boot AND fetch failed. Be honest, never cry wolf — separate a setup gap
# (no key) from a key-present failure, without a second network probe.
if [ -z "$AGENT_KEY" ]; then
  cat <<EOF
COGNI COGNITION — no node credentials yet (first boot)

No COGNI_NODE_API_KEY was found, so this session could not load its cognition
bundle from:
  $URL

This is a setup step, not an outage. To bootstrap:
- register a NODE agent via /api/v1/agent/register
- save COGNI_NODE_API_KEY in the clone-root .env.cogni
- for Codex, run pnpm codex:cognition:install once and trust the hook via /hooks

Then restart or resume the agent. (Once it loads once, it is cached locally and
survives hub outages.)
EOF
else
  cat <<EOF
COGNI COGNITION — could not load bundle (first boot, no cache)

A credential IS present, so this is NOT a missing-key setup problem. Either the
hub is down/slow, or the key lacks a principal on this hub (or the node has no
cognition published yet). There's no local cache to fall back on this first time.

Check hub health (cognidao.org/version) and that GET /api/v1/cognition resolves
with your key. Proceed with the repo's own AGENTS.md + skills meanwhile —
cognition caches itself once it loads, and then survives hub outages.
EOF
fi
