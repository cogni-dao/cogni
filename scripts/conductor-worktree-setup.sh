#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/conductor-worktree-setup.sh
# Purpose: Prepare a Conductor-created Cogni worktree for agent development.
# Side-effects: links shared local auth/secrets when available, warms the
#   session cognition cache first, refreshes origin/main, installs deps, builds
#   workspace packages, and runs the worktree readiness check.

set -euo pipefail

DEFAULT_BRANCH="${CONDUCTOR_DEFAULT_BRANCH:-main}"
WORKSPACE_ROOT="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"

# AUTH_ROOT is THIS node's canonical (main) workspace checkout — the single place
# that holds .env.cogni and .local-auth. A Conductor worktree spawn is a git worktree
# of that main checkout, so we derive its path from git: no hardcoded or personal path,
# and never a reach into an unrelated repo. Override with COGNI_NODE_AUTH_ROOT
# (or the older COGNI_TEMPLATE_ROOT).
derive_main_workspace() {
  local common_dir
  common_dir="$(git -C "$WORKSPACE_ROOT" rev-parse --git-common-dir 2>/dev/null)" || return 1
  (cd "$WORKSPACE_ROOT" && cd "$(dirname "$common_dir")" && pwd)
}
AUTH_ROOT="${COGNI_NODE_AUTH_ROOT:-${COGNI_TEMPLATE_ROOT:-${CONDUCTOR_ROOT_PATH:-$(derive_main_workspace || true)}}}"

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

refresh_workspace_base_ref() {
  git fetch origin "$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH"
}

# Conductor frequently forms a worktree off a stale local base, so the checked-out
# branch lands behind origin. Bring it up to date with the freshly fetched base
# (the `git pull main` step). Conflict-safe: on a dirty tree, detached HEAD, or a
# merge conflict we warn and continue rather than leaving the worktree wedged.
sync_workspace_to_base() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "workspace has uncommitted changes; skipped $DEFAULT_BRANCH sync"
    return
  fi

  local branch
  branch="$(git branch --show-current 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    warn "detached HEAD; skipped $DEFAULT_BRANCH sync"
    return
  fi

  if ! git merge --no-edit "origin/$DEFAULT_BRANCH"; then
    git merge --abort 2>/dev/null || true
    warn "origin/$DEFAULT_BRANCH does not merge cleanly into $branch; left as-is to resolve manually"
  fi
}

refresh_auth_root_main() {
  if [[ -z "$AUTH_ROOT" || "$AUTH_ROOT" == "$WORKSPACE_ROOT" ]]; then
    return
  fi

  if ! git -C "$AUTH_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
    warn "auth root is not a git checkout: $AUTH_ROOT"
    return
  fi

  git -C "$AUTH_ROOT" fetch origin "$DEFAULT_BRANCH" || {
    warn "could not fetch origin/$DEFAULT_BRANCH in auth root: $AUTH_ROOT"
    return
  }

  local branch
  branch="$(git -C "$AUTH_ROOT" branch --show-current 2>/dev/null || true)"
  if [[ "$branch" != "$DEFAULT_BRANCH" ]]; then
    warn "auth root is on $branch, not $DEFAULT_BRANCH; fetched but skipped pull"
    return
  fi

  if ! git -C "$AUTH_ROOT" diff --quiet || ! git -C "$AUTH_ROOT" diff --cached --quiet; then
    warn "auth root has uncommitted changes; fetched but skipped pull"
    return
  fi

  git -C "$AUTH_ROOT" pull --ff-only origin "$DEFAULT_BRANCH" || {
    warn "could not fast-forward auth root: $AUTH_ROOT"
  }
}

auth_root_has_node_cogni_key() {
  local env_file="$AUTH_ROOT/.env.cogni"
  local key

  key="$(read_env_file_value COGNI_NODE_API_KEY "$env_file")"
  [[ -n "$key" ]]
}

# THIS node's own hub base URL, derived from .cogni/repo-spec.yaml intent.name —
# the same derivation scripts/agent/session-cognition.sh uses to fetch the bundle.
# The registered agent MUST live on the same hub that serves the session-cognition
# bundle: an agent registered at the apex (cognidao.org) is not a valid principal
# at a node subdomain and its key gets a 401 "Session required" there. The apex
# node (operator / cogni-template) is its own hub, so it stays on cognidao.org.
node_hub_base_url() {
  local spec="$WORKSPACE_ROOT/.cogni/repo-spec.yaml"
  local slug=""

  if [[ -f "$spec" ]]; then
    slug="$(awk '
      /^intent:/ { in_intent = 1; next }
      in_intent && /^[^[:space:]]/ { in_intent = 0 }
      in_intent && /^[[:space:]]+name:/ {
        sub(/^[[:space:]]+name:[[:space:]]*/, ""); gsub(/["'\''"]/, ""); print; exit
      }
    ' "$spec" 2>/dev/null)"
  fi

  case "$slug" in
    operator | cogni-template | "") printf 'https://cognidao.org' ;;
    *) printf 'https://%s.cognidao.org' "$slug" ;;
  esac
}

register_auth_root_cogni_agent() {
  local env_file="$AUTH_ROOT/.env.cogni"
  local agent_name response key base_url

  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    warn "curl and jq are required to auto-register Cogni credentials"
    return 1
  fi

  base_url="$(node_hub_base_url)"
  agent_name="${USER:-agent}-conductor-$(hostname -s 2>/dev/null || printf 'local')-$(date -u +%Y%m%dT%H%M%SZ)"
  response="$(
    curl -fsS --max-time 10 -X POST "$base_url/api/v1/agent/register" \
      -H 'content-type: application/json' \
      -d "$(jq -cn --arg name "$agent_name" '{name:$name}')"
  )" || return 1
  key="$(printf '%s\n' "$response" | jq -r '.apiKey // empty')"
  [[ -n "$key" ]] || return 1

  {
    if [[ -f "$env_file" ]]; then
      printf '\n'
    else
      printf '# Cogni node API keys (gitignored via .env*)\n'
    fi
    printf '# Agent name: %s\n' "$agent_name"
    printf 'COGNI_NODE_API_KEY=%s\n' "$key"
  } >>"$env_file"
  chmod 600 "$env_file"
}

ensure_auth_root_cogni_env() {
  local lock_dir

  if [[ -z "$AUTH_ROOT" ]]; then
    warn "no auth root resolved; cannot auto-register COGNI_NODE_API_KEY safely"
    exit 1
  fi

  if auth_root_has_node_cogni_key; then
    return
  fi

  mkdir -p "$AUTH_ROOT/.context"
  lock_dir="$AUTH_ROOT/.context/cogni-node-key.lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    for _ in {1..20}; do
      sleep 1
      auth_root_has_node_cogni_key && return
    done
    warn "$AUTH_ROOT/.env.cogni still missing COGNI_NODE_API_KEY after waiting for another setup"
    exit 1
  fi
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

  if auth_root_has_node_cogni_key; then
    return
  fi

  warn "$AUTH_ROOT/.env.cogni missing COGNI_NODE_API_KEY; attempting NODE agent registration"
  if register_auth_root_cogni_agent; then
    printf 'registered Cogni NODE agent and saved COGNI_NODE_API_KEY in %s\n' "$AUTH_ROOT/.env.cogni"
  else
    warn "could not auto-register Cogni NODE agent; POST $(node_hub_base_url)/api/v1/agent/register and save COGNI_NODE_API_KEY in $AUTH_ROOT/.env.cogni"
    exit 1
  fi
}

link_from_auth_root() {
  local name="$1"
  local src_path="$AUTH_ROOT/$name"

  if [[ -z "$AUTH_ROOT" || "$AUTH_ROOT" == "$WORKSPACE_ROOT" ]]; then
    warn "no separate main-workspace root resolved; using local $name as-is, skipped link"
    return
  fi

  if [[ ! -e "$src_path" ]]; then
    warn "$src_path missing; skipped $name symlink"
    return
  fi

  if [[ -e "$name" && ! -L "$name" ]]; then
    # A real (non-symlink) file is the source of truth — e.g. a node ships its own
    # node-scoped .env.cogni that must not be replaced by the auth-root copy.
    warn "$name is a real file, not a symlink; keeping it and skipping the auth-root link"
    return
  fi

  ln -sfn "$src_path" "$name"
}

# Warm the session cognition cache before anything slow. Every agent session
# fetches its own bundle when it starts; this cache is only the offline fallback
# for a session that starts while the hub is down.
warm_cognition_cache() {
  local attempt started
  started=$(date +%s)
  for attempt in 1 2 3; do
    if bash scripts/agent/session-cognition.sh --refresh </dev/null >/dev/null 2>&1; then
      printf 'cognition cache refreshed from the hub in %ss (attempt %s)\n' "$(($(date +%s) - started))" "$attempt"
      return 0
    fi
    [[ "$attempt" -lt 3 ]] && sleep 2
  done
  warn "cognition hub fetch failed; each agent session retries when it starts"
}

ensure_auth_root_cogni_env

# Symlink, never copy, so secret rotation and captured auth in the human's
# canonical checkout are immediately reflected in active Conductor worktrees.
link_from_auth_root ".env.cogni"
link_from_auth_root ".local-auth"
warm_cognition_cache

refresh_workspace_base_ref
sync_workspace_to_base
refresh_auth_root_main

# Codex requires hook trust per config source. Keep one stable, user-level
# presenter installed so every local Conductor worktree inherits the
# already-reviewed hook instead of depending on per-worktree project trust.
if [[ "${CONDUCTOR_IS_LOCAL:-1}" == "1" ]]; then
  bash scripts/agent/install-codex-cognition-hook.sh
fi

pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile
pnpm packages:build
pnpm worktree:check
