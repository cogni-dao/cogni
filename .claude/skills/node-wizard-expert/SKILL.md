---
name: node-wizard-expert
description: Use when designing, debugging, or operating the Cogni node formation wizard, node formation PRs, submodule-pinned node repos, child image builds, parent candidate-flight, or AI-assistant launch handoffs. Route launch execution and E2E proof to node-wizard-scorecard.
---

# Node Wizard Expert

## Primary Pointer

For any live throwaway-node launch, start with
[`node-wizard-scorecard`](../node-wizard-scorecard/SKILL.md). This skill is the
orientation layer; the scorecard is the execution and proof layer.

## First Recall

Before changing node-wizard launch behavior, recall the operator knowledge block:

- `node-launch-handoff` — `https://cognidao.org/knowledge/node-launch-handoff`

That block is the evolving handoff contract for personal AI assistants launching a newly birthed node. Treat it as the operator-owned playbook; refine it when the launch process changes instead of duplicating long runbooks in the wizard UI.

## Ground Truth

- `.claude/skills/node-wizard-scorecard/SKILL.md`
- `docs/design/node-wizard-secret-setting.md`
- `docs/guides/node-formation-guide.md`
- `docs/spec/node-ci-cd-contract.md`
- `nodes/operator/app/src/features/nodes/launch-pack.ts`
- `nodes/operator/app/src/app/api/v1/nodes/[id]/launch-pack/route.ts`
- `.claude/skills/conductor-worktree-setup/SKILL.md`
- `scripts/conductor-worktree-setup.sh`
- `scripts/ci/sync-node-template-fork-pr.sh`

## Operating Rule

The wizard should mint and publish birth facts, then hand the launch to an AI assistant through the launch pack. Do not add saved wizard states for CI, GHCR, candidate-flight, Argo sync, or `/version` when those can be derived from GitHub, GHCR, the operator flight API, and the deployed candidate URL.

Recent launch-path finding: generated parent birth PRs for throwaway nodes are
not progress by themselves. Progress is a scorecard row moving from blocked to
pass without privileged manual bridge work. A child commit without a child
`sha-<child-sha>` GHCR image is a blocker, not a deployable pin.

**DNS + edge are automatic — never hand-provision them.** A wizard-born node's public host (`<node>-<env>`) is reconciled per-env on flight by `reconcile-node-dns.sh` (catalog-driven A-record upsert), and its edge Caddy route by the flight's `node-substrate` job (`reconcile-edge-caddy.remote.sh`) — both idempotent, no manual step. The wizard declares the catalog row; the flight resolves the host. Canon: [`docs/spec/ci-cd.md` Axiom 21 `DNS_IS_RECONCILED_PER_ENV`](../../../docs/spec/ci-cd.md); operational detail in the `dns-ops` skill. A fresh-flight `NXDOMAIN` is almost always negative-cache — re-check `dig <host> +short @1.1.1.1`.

## Repo Ancestry Rule

Wizard-minted nodes must be named forks of `node-template`, not GitHub template-generated repos. Template generation copies a snapshot without shared git history, so agents cannot fetch `node-template` and merge future template updates. The publish path should call `GitHubRepoWriter.forkFromTemplate`, wait for the forked `main`, commit only the regenerated `.cogni/repo-spec.yaml` identity on top, and pin that identity commit as the operator submodule gitlink.

If a same-named repo already exists, reuse it only when it is a fork of the configured `NODE_TEMPLATE_OWNER/node-template`; otherwise fail closed and repair the repo lineage explicitly.

## Fast Repair

When a minted test-node fork lags behind `cogni-test-org/node-template`, refresh
its existing PR branch with:

```bash
PR_TITLE='ci: sync <slug> node CI' \
  scripts/ci/sync-node-template-fork-pr.sh cogni-test-org/<slug> <branch>
```

This is the repeatable version of the manual `test-cog` repair: fetch the fork
PR branch, merge the current test-org template, auto-resolve the known stale
`ci.yaml` image-name conflict in favor of the template, run the node workflow
invariant, push, and print the PR/check links.
