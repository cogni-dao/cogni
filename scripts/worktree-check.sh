#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/worktree-check.sh
# Purpose: Cheap, non-mutating readiness check for a fresh git worktree.
# Side-effects: none

set -u

FAILURES=0
WARNINGS=0

pass() {
  printf 'ok: %s\n' "$1"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  printf 'warn: %s\n' "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'fail: %s\n' "$1"
}

read_env_file_value() {
  var_name="$1"
  env_file="$2"

  [ -f "$env_file" ] || return 0
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

has_node_cogni_key() {
  env_file="$1"
  key=""

  key="$(read_env_file_value COGNI_NODE_API_KEY "$env_file")"
  [ -n "$key" ]
}

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  fail "not inside a git worktree"
else
  REPO_ROOT=$(git rev-parse --show-toplevel)
  cd "$REPO_ROOT" || exit 1
  pass "git worktree root: $REPO_ROOT"
fi

if git show-ref --verify --quiet refs/remotes/origin/main; then
  pass "origin/main is available for affected checks"
else
  fail "origin/main is missing; fetch origin before running affected checks"
fi

BRANCH=$(git branch --show-current 2>/dev/null || true)
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || true)
if [ -z "$BRANCH" ]; then
  warn "detached HEAD; affected checks will use origin/main when available"
elif [ -z "$UPSTREAM" ]; then
  pass "branch has no upstream; local check wrappers still scope against origin/main"
else
  pass "branch upstream is $UPSTREAM; local check wrappers still prefer origin/main"
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" = "22" ]; then
    pass "node $(node -v)"
  else
    fail "Node 22.x required; found $(node -v)"
  fi
else
  fail "node not found"
fi

if command -v pnpm >/dev/null 2>&1; then
  pass "pnpm $(pnpm --version)"
else
  fail "pnpm not found"
fi

if command -v rg >/dev/null 2>&1; then
  pass "ripgrep available"
else
  warn "ripgrep missing; install it for fast agent search"
fi

if [ -d node_modules ] && [ -x node_modules/.bin/turbo ]; then
  pass "node_modules present"
else
  fail "node_modules missing or incomplete; run pnpm install --frozen-lockfile"
fi

if [ -f .env.cogni ]; then
  if has_node_cogni_key .env.cogni; then
    pass ".env.cogni has COGNI_NODE_API_KEY"
  else
    fail ".env.cogni exists but has no COGNI_NODE_API_KEY for session cognition"
  fi
else
  fail ".env.cogni missing; Conductor setup should symlink it from the primary checkout"
fi

if [ -f work/items/_index.md ]; then
  fail "work/items/_index.md exists; work item index has been purged"
else
  pass "legacy work item index absent"
fi

if node scripts/run-scoped-package-build.mjs --dry-run >/tmp/cogni-worktree-package-plan.$$ 2>&1; then
  if grep -q "Package declaration scope: none" /tmp/cogni-worktree-package-plan.$$; then
    pass "package declaration outputs are present"
  else
    warn "package declarations need bootstrap: node scripts/run-scoped-package-build.mjs"
    sed 's/^/  /' /tmp/cogni-worktree-package-plan.$$
  fi
else
  fail "could not compute package build plan"
  sed 's/^/  /' /tmp/cogni-worktree-package-plan.$$ 2>/dev/null || true
fi
rm -f /tmp/cogni-worktree-package-plan.$$

for env_file in .env.local .env.test; do
  if [ -f "$env_file" ]; then
    pass "$env_file exists"
  else
    warn "$env_file missing; run scripts/bootstrap/simple-local-env-setup.sh if local stack work needs it"
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  printf 'worktree check failed: %d failure(s), %d warning(s)\n' "$FAILURES" "$WARNINGS"
  exit 1
fi

printf 'worktree check passed: %d warning(s)\n' "$WARNINGS"
