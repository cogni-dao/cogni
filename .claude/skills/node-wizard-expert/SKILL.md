---
name: node-wizard-expert
description: Use when designing, debugging, or operating the Cogni node formation wizard, node birth PRs, submodule-pinned node repos, child image builds, parent candidate-flight, or AI-assistant launch handoffs.
---

# Node Wizard Expert

## First Recall

Before changing node-wizard launch behavior, recall the operator knowledge block:

- `node-launch-handoff` — `https://cognidao.org/knowledge/node-launch-handoff`

That block is the evolving handoff contract for personal AI assistants launching a newly birthed node. Treat it as the operator-owned playbook; refine it when the launch process changes instead of duplicating long runbooks in the wizard UI.

## Ground Truth

- `docs/guides/node-formation-guide.md`
- `docs/spec/node-ci-cd-contract.md`
- `nodes/operator/app/src/features/nodes/launch-pack.ts`
- `nodes/operator/app/src/app/api/v1/nodes/[id]/launch-pack/route.ts`
- `.claude/skills/conductor-worktree-setup/SKILL.md`
- `scripts/conductor-worktree-setup.sh`

## Operating Rule

The wizard should mint and publish birth facts, then hand the launch to an AI assistant through the launch pack. Do not add saved wizard states for CI, GHCR, candidate-flight, Argo sync, or `/version` when those can be derived from GitHub, GHCR, the operator flight API, and the deployed candidate URL.

## Repo Ancestry Rule

Wizard-minted nodes must be named forks of `node-template`, not GitHub template-generated repos. Template generation copies a snapshot without shared git history, so agents cannot fetch `node-template` and merge future template updates. The publish path should call `GitHubRepoWriter.forkFromTemplate`, wait for the forked `main`, commit only the regenerated `.cogni/repo-spec.yaml` identity on top, and pin that identity commit as the operator submodule gitlink.

If a same-named repo already exists, reuse it only when it is a fork of the configured `NODE_TEMPLATE_OWNER/node-template`; otherwise fail closed and repair the repo lineage explicitly.
