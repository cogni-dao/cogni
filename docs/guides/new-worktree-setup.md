---
id: new-worktree-setup
type: guide
title: Git Worktree Testing Setup
status: active
trust: draft
summary: How to set up a git worktree for isolated branch work with full test support.
read_when: Starting work on a new branch, setting up a clean development environment.
owner: derekg1729
created: 2026-02-12
verified: 2026-02-12
tags: [dev, git, testing]
---

# Git Worktree Testing Setup

When working on isolated branches (e.g., bug fixes, experiments) without disturbing your main checkout, use a git worktree.

## Setup

### Conductor

The repo ships a shared Conductor setup entrypoint:

- `conductor.json`
- `scripts/conductor-worktree-setup.sh`
- `.claude/skills/conductor-worktree-setup/SKILL.md`

Before creating a Conductor workspace, update the primary checkout that Conductor will branch from:

```bash
export COGNI_TEMPLATE_ROOT="${COGNI_TEMPLATE_ROOT:-$HOME/dev/cogni-template}"
git -C "$COGNI_TEMPLATE_ROOT" checkout main
git -C "$COGNI_TEMPLATE_ROOT" pull --ff-only origin main
```

Then create the workspace in Conductor and let setup run. The setup script fetches `origin/main`, symlinks `.env.cogni` and `.local-auth` from the primary checkout, installs dependencies, emits package declarations, and runs `pnpm worktree:check`.

Secrets and captured auth are symlinked, not copied, so rotations and refreshed storage states propagate to active worktrees. Session-start cognition reads `.env.cogni` directly and derives the node URL from `.cogni/repo-spec.yaml`, so no per-worktree environment export is needed after the one-time agent registration bootstrap saves a key there.

### Manual Git Worktree

```bash
# 1. Create worktree with new branch off current HEAD
git worktree add ../cogni-template-worktrees/<branch-name> -b <branch-name> HEAD

# 2. Change to the worktree
cd ../cogni-template-worktrees/<branch-name>

# 3. Install dependencies (worktrees share .git but not node_modules)
pnpm install --offline --frozen-lockfile

# 4. Check whether the worktree is ready for agent development
pnpm worktree:check

# 5. Emit only package declarations needed in this worktree
node scripts/run-scoped-package-build.mjs

# 6. Verify docs metadata
pnpm check:docs
```

## Why Package Declarations Are Required

Workspace packages (`packages/ai-core`, `packages/scheduler-core`, etc.) publish TypeScript declarations from `dist/`. Without declaration output, Vite/vitest cannot resolve their entry points and tests fail with:

```
Error: Failed to resolve entry for package "@cogni/scheduler-core"
```

The main checkout usually has these declarations already. A fresh worktree does not.

`scripts/run-scoped-package-build.mjs` scopes against `origin/main` by default and emits declarations for any package with missing declaration output, which is the common fresh-worktree failure. It does not run package JavaScript builds; explicit `pnpm packages:build` and CI own artifact validation. If a rebase or merge leaves declarations out of sync, run `pnpm packages:build:clean` to wipe all `dist/` and `.tsbuildinfo` state and rebuild from scratch.

## Turbo Scope

Do not set a feature branch upstream to `origin/main` just to make Turbo happy; that makes `git push` behavior ambiguous. Local check wrappers set `TURBO_SCM_BASE=origin/main` when `origin/main` exists, so a brand-new worktree branch with no upstream still gets an affected scope.

For PR verification, push and monitor CI. When debugging Turbo scope locally with a different comparison base, pass it explicitly:

```bash
TURBO_SCM_BASE=<base-ref> TURBO_SCM_HEAD=HEAD pnpm check:fast
```

## Cleanup

```bash
# Remove worktree when done (from main checkout)
git worktree remove ../cogni-template-worktrees/<branch-name>
```
