---
name: node-template-sync
description: Use to CLOSE OUT a node-template release — sweep the auto-generated fork-sync PRs, triage per-node edge cases, drive each to merge, AND hand-port the same node-template app changes into the operator (cogni) app and drive that PR to merge + promotion. Also covers how the automated two-tier sync works and why operator is excluded. Triggers: "close out the node-template sync", "merge the fork sync PRs", "node-template merged, propagate it", "sync node-template to nodes and operator", "why didn't fork X get the update", "port node-template feature into operator", "cherry-pick node-template to cogni".
---

# node-template release close-out

When `node-template` merges to main, the operator GitHub App **auto-opens** fork-sync PRs on every child fork. They do **not** merge themselves, and the operator (cogni) app gets **nothing** automatically. This skill is the agent that finishes the job. It has exactly **two responsibilities** — everything else is noise:

1. **Sweep every auto-generated fork-sync PR → triage per-node edge cases → drive to merge.**
2. **Hand-port the same node-template app changes into the operator app → drive that PR to merge + promotion.**

> Expect this to run on every node-template release. Fork ports are high-volume; operator ports are recurring and manual (there will be thousands over the project's life). Treat it as routine close-out, not a one-off.

---

## Responsibility 1 — sweep + merge the fork-sync PRs

### Find them

```bash
gh search prs --state open "head:cogni-operator/node-template-sync"      # Tier 1: CI/contract overwrite
gh search prs --state open "head:cogni-operator/node-template-upstream"  # Tier 2: app/graphs upstream merge
```

### Triage each (the per-node edge-case pass)

Pull state + checks and classify — do NOT blind-merge:

```bash
gh pr view <n> --repo <owner>/<fork> \
  --json mergeable,mergeStateStatus,changedFiles,additions,statusCheckRollup \
  --jq '{mergeable,mergeStateStatus,changedFiles, bad:[.statusCheckRollup[]|select((.conclusion//.state) as $c|$c!="SUCCESS" and $c!="NEUTRAL" and $c!="SKIPPED")|{name,s:(.conclusion//.state)}]}'
```

| State                               | Meaning                                             | Action                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERGEABLE` / `CLEAN`, checks green | fresh fork, upstream applies clean                  | **Merge** (`gh pr merge <n> --repo … --merge`).                                                                                                                                                                              |
| `CONFLICTING` / `DIRTY`             | fork diverged from node-template (customized files) | **Resolve per-fork** — check out the branch, merge fork main, resolve conflicts preserving fork customizations (`FORK_FREEDOM`), push. Then merge. This is real per-node work, not a button.                                 |
| Checks failing                      | CI broke on the merged delta                        | Read the failing job. A `Cogni Git PR Review` FAILURE is usually a goal-alignment advisory, not a hard gate — confirm it's not a required check before merging past it. A `static`/`unit`/`resolve` failure is a real block. |

**Per-node edge cases that block** (the diff between a clean fork and a stale one): diverged `package.json`/lockfile, fork-local graph/runtime customizations, node-specific config the merge would clobber. Tier 1 (CI/contract) is byte-safe and almost always clean; Tier 2 (upstream app merge) is where divergence bites — the more a fork has customized, the bigger the conflict.

### Verify the sweep

- **Loki:** event `node_template_fork_sync_complete` at the deployed buildSha — `forks`, `ciOpened`, `templateOpened`, `entries[]`.
- After merge, each fork runs its own candidate-flight/promotion pipeline (the fork's CD, not this skill).

---

## Responsibility 2 — port the change into the operator app

Operator is **excluded** from auto-sync (`FORK_SYNC_EXCLUDED_SLUGS = {node-template, operator}`) and **cannot** be added (see below). So the same node-template app change is applied to operator **by hand**, as a normal operator PR.

1. **Diff what landed.** Identify the merged node-template PR(s) and the files they touched (repo-root paths). Cross-check whether operator already has the feature (many originated in the monorepo before the split):
   ```bash
   gh pr view <n> --repo cogni-dao/node-template --json title,files
   ```
2. **Map paths into the monorepo:** node-template `app/**` → `nodes/operator/app/**`; shared substrate → the matching `packages/**`. Operator's app is a **divergent superset** (control plane) — reconcile against what exists; never blind-overwrite.
3. **Apply as a standard operator code PR** through the full lifecycle: one work item, branch → CI green → candidate-a validate.
4. **Drive to merge + promotion** — this is the part forks get for free but operator doesn't: after merge, promote per `/promote` (candidate-a → preview → prod as appropriate).

**Worked example — node-template#43 (3D knowledge graph):** merged to node-template; operator lacked `/api/v1/knowledge/graph` + `GraphView`. Port = new route + `GraphView.tsx` + `react-force-graph-3d` under `nodes/operator/app/**`, reconciled against operator's existing knowledge UI, then merge + promote.

---

## Reference — how the auto-sync works (as-built, PR #1750)

```
node-template merge → main
  → operator GitHub App webhook (push, HMAC-verified at /api/internal/webhooks/github)
    → dispatchCanonicalForkSync  (src/app/_facades/deploy/canonical-fork-sync.server.ts)
      → targets = infra/catalog/*.yaml source_repo rows in the parent monorepo
        (NODE_SUBMODULE_PARENT_{OWNER,REPO}); node-template + operator EXCLUDED
      → per fork, two decoupled tiers (per-tier, per-fork error isolation):
          Tier 1  syncCanonicalFilesToFork    → byte-overwrite CI/contract files
          Tier 2  syncTemplateUpstreamToFork  → MERGE node-template upstream (preserves fork edits)
```

- **One living PR per tier per fork.** SHA-free branches force-updated each release (Dependabot pattern): Tier 1 `cogni-operator/node-template-sync`, Tier 2 `cogni-operator/node-template-upstream`.
- **Tier 1 paths** (`CI_CONTRACT_PATHS`): `.github/workflows/{ci.yaml,pr-build.yml,pr-lint.yaml}`, `scripts/check-node-ci-workflow.mjs`. Add a path only if identical across all forks.
- **Targets from `infra/catalog`**, not the nodes table or the node registry (the registry resolves to the parent monorepo / hub).

### Why operator can't be auto-synced

- **Tier 1 is the wrong direction.** Per [`repo-sync-contract`](../../../docs/spec/repo-sync-contract.md) `HUB_IS_COGNI_MONOREPO`, cogni is the canonical _source_ of operator-scope CI; node-template pulls from it. Hub↔template CI drift is watched (correct direction) by `sync-drift-detector.yml`.
- **Tier 2 can't mechanically run.** It needs node-template + target in one git object store (materialize upstream SHA as a branch → same-repo PR). cogni isn't a fork of node-template → the SHA is unreachable. And paths don't correspond (root vs `nodes/operator/**`), and operator's app is a divergent superset. This is the bidirectional history-preserving case `repo-sync-contract` defers to v2 (josh-proxy). Hence: hand-port (Responsibility 2).

### Wiring traps

1. **Trigger = the App's existing webhook. Never a held secret.** No token route, no `scripts/ci/*.sh` (the old `sync-node-template-fork-pr.sh` is retired). On-demand alternative is an OpenFGA-gated `node.*` action.
2. **`forks: 0` is valid** — trigger fired, no catalog forks for that env.

## References

- Code: `src/app/_facades/deploy/canonical-fork-sync.server.ts`, `src/adapters/server/vcs/github-repo-write.ts`, `src/app/api/internal/webhooks/[source]/route.ts`.
- Contracts: [`docs/spec/repo-sync-contract.md`](../../../docs/spec/repo-sync-contract.md), [`docs/spec/node-ci-cd-contract.md`](../../../docs/spec/node-ci-cd-contract.md).
- Hub knowledge: `node-template-fork-sync` (operator / infrastructure). Promotion: `/promote` skill.
