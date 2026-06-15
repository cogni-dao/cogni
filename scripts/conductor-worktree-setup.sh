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

# Symlink, never copy, so secret rotation and captured auth in the primary
# checkout are immediately reflected in every active Conductor worktree.
link_from_primary ".env.cogni"
link_from_primary ".local-auth"

pnpm install --offline --frozen-lockfile
pnpm packages:build
pnpm worktree:check
