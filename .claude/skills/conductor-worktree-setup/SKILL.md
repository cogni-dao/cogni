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
4. Let Conductor run the committed setup script. Local setup reconciles the
   stable user-level Codex cognition hook before installing dependencies.
5. In Codex, open `/hooks` once and trust that user-level SessionStart hook.
   Later local worktrees reuse the same trusted hook path.

The setup script also fetches `origin/main` and fast-forwards the primary checkout only when it is already on clean `main`. It must not rewrite the Conductor feature branch after workspace creation.

## Invariants

- Ensure the primary checkout has a durable `COGNI_NODE_API_KEY`, then symlink `.env.cogni` and `.local-auth`; never copy them. A missing key requires a human-issued one-use `COGNI_AGENT_SPAWN_TOKEN`. Rotation preserves the actor and grants; never register a replacement identity merely to populate another variable name.
- Keep the fleet-standard `pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile`, `pnpm packages:build`, and `pnpm worktree:check` in the setup path. The first attempt is cache-only; the fallback fetches newly pinned tarballs and also retries transient filesystem failures once.
- Local setup (`CONDUCTOR_IS_LOCAL=1`, including the local default) must reconcile the stable user-level Codex cognition hook. Cloud setup must not modify a user-level Codex home.
- Codex still requires one explicit `/hooks` trust for that stable user-level hook; automatic reconciliation does not bypass trust.
- If the setup contract changes, update the script, this skill, `docs/guides/new-worktree-setup.md`, and launch-pack wording together.
