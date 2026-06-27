#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/conductor-worktree-setup.sh
# Purpose: Prepare a Conductor-created Cogni worktree for agent development.
# Side-effects: refreshes origin/main, symlinks local secret/auth files, installs deps, builds packages.

set -euo pipefail

DEFAULT_BRANCH="${CONDUCTOR_DEFAULT_BRANCH:-main}"
SRC="${COGNI_TEMPLATE_ROOT:-${CONDUCTOR_ROOT_PATH:-$HOME/dev/cogni-template}}"

warn() {
  printf 'warn: %s\n' "$1" >&2
}

read_env_file_value() {
  local var_name="$1"
  local env_file="$2"

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

require_primary_checkout() {
  if [[ ! -d "$SRC" ]]; then
    printf 'set COGNI_TEMPLATE_ROOT to your main checkout\n' >&2
    exit 1
  fi

  if ! git -C "$SRC" rev-parse --show-toplevel >/dev/null 2>&1; then
    printf 'COGNI_TEMPLATE_ROOT is not a git checkout: %s\n' "$SRC" >&2
    exit 1
  fi
}

refresh_primary_main() {
  git -C "$SRC" fetch origin "$DEFAULT_BRANCH"

  local branch
  branch="$(git -C "$SRC" branch --show-current 2>/dev/null || true)"
  if [[ "$branch" != "$DEFAULT_BRANCH" ]]; then
    warn "primary checkout is on $branch, not $DEFAULT_BRANCH; fetched origin/$DEFAULT_BRANCH but skipped pull"
    return
  fi

  if ! git -C "$SRC" diff --quiet || ! git -C "$SRC" diff --cached --quiet; then
    warn "primary checkout has uncommitted changes; fetched origin/$DEFAULT_BRANCH but skipped pull"
    return
  fi

  git -C "$SRC" pull --ff-only origin "$DEFAULT_BRANCH"
}

refresh_workspace_base_ref() {
  git fetch origin "$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH"
}

primary_has_node_cogni_key() {
  local env_file="$SRC/.env.cogni"
  local key

  key="$(read_env_file_value COGNI_NODE_API_KEY "$env_file")"
  [[ -n "$key" ]]
}

register_primary_cogni_agent() {
  local env_file="$SRC/.env.cogni"
  local agent_name response key

  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    warn "curl and jq are required to auto-register Cogni credentials"
    return 1
  fi

  agent_name="${USER:-agent}-conductor-$(hostname -s 2>/dev/null || printf 'local')-$(date -u +%Y%m%dT%H%M%SZ)"
  response="$(
    curl -fsS --max-time 10 -X POST https://cognidao.org/api/v1/agent/register \
      -H 'content-type: application/json' \
      -d "$(jq -cn --arg name "$agent_name" '{name:$name}')"
  )" || return 1
  key="$(printf '%s\n' "$response" | jq -r '.apiKey // empty')"
  [[ -n "$key" ]] || return 1

  {
    if [[ -f "$env_file" ]]; then
      printf '\n'
    else
      printf '# Cogni operator API keys (gitignored via .env*)\n'
    fi
    printf '# Agent name: %s\n' "$agent_name"
    printf 'COGNI_NODE_API_KEY=%s\n' "$key"
  } >>"$env_file"
  chmod 600 "$env_file"
}

ensure_primary_cogni_env() {
  local lock_dir

  if primary_has_node_cogni_key; then
    return
  fi

  mkdir -p "$SRC/.context"
  lock_dir="$SRC/.context/cogni-node-key.lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    for _ in {1..20}; do
      sleep 1
      primary_has_node_cogni_key && return
    done
    warn "$SRC/.env.cogni still missing COGNI_NODE_API_KEY after waiting for another setup"
    exit 1
  fi
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

  if primary_has_node_cogni_key; then
    return
  fi

  warn "$SRC/.env.cogni missing COGNI_NODE_API_KEY; attempting NODE agent registration"
  if register_primary_cogni_agent; then
    printf 'registered Cogni NODE agent and saved COGNI_NODE_API_KEY in %s\n' "$SRC/.env.cogni"
  else
    warn "could not auto-register Cogni NODE agent; run /api/v1/agent/register and save COGNI_NODE_API_KEY in $SRC/.env.cogni"
    exit 1
  fi
}

link_from_primary() {
  local name="$1"
  local src_path="$SRC/$name"

  if [[ ! -e "$src_path" ]]; then
    warn "$src_path missing; skipped $name symlink"
    return
  fi

  if [[ -e "$name" && ! -L "$name" ]]; then
    printf '%s exists and is not a symlink; move it aside before running setup\n' "$name" >&2
    exit 1
  fi

  ln -sfn "$src_path" "$name"
}

require_primary_checkout
refresh_primary_main
refresh_workspace_base_ref
ensure_primary_cogni_env

# Symlink, never copy, so secret rotation and captured auth in the primary
# checkout are immediately reflected in every active Conductor worktree.
link_from_primary ".env.cogni"
link_from_primary ".local-auth"

pnpm install --offline --frozen-lockfile
pnpm packages:build
pnpm worktree:check
