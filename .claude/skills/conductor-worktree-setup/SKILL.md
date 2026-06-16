---
name: conductor-worktree-setup
description: Use when setting up, reviewing, or changing Cogni Conductor worktree bootstrap, including conductor.json, scripts/conductor-worktree-setup.sh, secret/auth symlinks, and AI launch-pack references for human or AI developers.
---

# Cogni Conductor Worktree Setup

Use this with the bundled Conductor app skill when a human asks how to run Cogni in Conductor or when changing the repo's worktree bootstrap.

## Ground Truth

- `conductor.json` wires Conductor setup to `bash scripts/conductor-worktree-setup.sh`.
- `scripts/conductor-worktree-setup.sh` is the canonical setup script.
- `docs/guides/new-worktree-setup.md` is the human-facing worktree guide.
- `.claude/skills/node-wizard-expert/SKILL.md` and `nodes/operator/app/src/features/nodes/launch-pack.ts` are the launch-handoff references.

## Human Flow

1. Set `COGNI_TEMPLATE_ROOT` to the primary checkout if it is not `$HOME/dev/cogni-template`.
2. In the primary checkout, update `main` before creating the Conductor workspace:
   ```bash
   git -C "$COGNI_TEMPLATE_ROOT" checkout main
   git -C "$COGNI_TEMPLATE_ROOT" pull --ff-only origin main
   ```
3. Create the Conductor workspace from that fresh base.
4. Let Conductor run the committed setup script.

The setup script also fetches `origin/main` and fast-forwards the primary checkout only when it is already on clean `main`. It must not rewrite the Conductor feature branch after workspace creation.

## Invariants

- Symlink `.env.cogni` and `.local-auth` from the primary checkout; never copy them into worktrees. Session-start cognition reads `.env.cogni` itself, so Conductor workspaces must not require manual key exports after the one-time agent registration bootstrap.
- Keep `pnpm install --offline --frozen-lockfile`, `pnpm packages:build`, and `pnpm worktree:check` in the setup path.
- If the setup contract changes, update the script, this skill, `docs/guides/new-worktree-setup.md`, and launch-pack wording together.
